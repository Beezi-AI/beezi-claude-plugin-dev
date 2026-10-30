import fs from 'fs';

export const MAX_LINE_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const CLOSE_BRACE = 0x7d;
const JSON_SPACE = new Set([0x20, 0x09, 0x0d]);
const BLOB_TYPE = 'api-request-blob';
const BLOB_PREFIX = Buffer.from(`{"type":"${BLOB_TYPE}"`);
const DROPPED_FIELDS = new Set(['attachment', 'snapshot']);
const TOOL_INPUT_KEYS = ['file_path', 'notebook_path', 'command', 'skill', 'description'];
const RESULT_PREFIX_CHARS = 128;

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// A string's line count, tolerating one trailing newline. Empty or non-string → 0.
function lineCount(s) {
  if (typeof s !== 'string' || !s) return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

export function editLineCounts(name, input) {
  let added = 0;
  let removed = 0;
  if (name === 'Edit') {
    removed += lineCount(input.old_string);
    added += lineCount(input.new_string);
  } else if (name === 'MultiEdit') {
    for (const e of Array.isArray(input.edits) ? input.edits : []) {
      if (e == null) continue;
      removed += lineCount(e.old_string);
      added += lineCount(e.new_string);
    }
  } else if (name === 'Write') {
    added += lineCount(input.content);
  } else if (name === 'NotebookEdit') {
    // NotebookEdit input has no old_source; count new cell source as added only.
    added += lineCount(input.new_source);
  }
  return { added, removed };
}

// Byte length of a tool_result's content, tolerating both the string and text-block-array forms.
export function toolResultBytes(content) {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf-8');
  if (Array.isArray(content)) {
    let bytes = 0;
    for (const block of content) {
      const text = block != null && typeof block.text === 'string' ? block.text : null;
      bytes += Buffer.byteLength(text == null ? JSON.stringify(block == null ? '' : block) : text, 'utf-8');
    }
    return bytes;
  }
  return 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function projectInput(input) {
  const slim = {};
  for (const key of TOOL_INPUT_KEYS) {
    if (input[key] !== undefined) slim[key] = input[key];
  }
  return slim;
}

function projectToolUse(block) {
  const { name, input } = block;
  const slim = { type: block.type, id: block.id, name, input: input == null ? input : projectInput(input) };
  if (EDIT_TOOLS.has(name)) slim.editLines = editLineCounts(name, input || {});
  return slim;
}

function projectBlock(block) {
  if (!isObject(block)) return block;
  if (block.type === 'text') return { type: block.type, text: block.text };
  if (block.type === 'tool_use') return projectToolUse(block);
  if (block.type === 'tool_result') {
    const { content } = block;
    return {
      type: block.type,
      tool_use_id: block.tool_use_id,
      is_error: block.is_error,
      content: typeof content === 'string' ? content.slice(0, RESULT_PREFIX_CHARS) : undefined,
      contentBytes: toolResultBytes(content),
    };
  }
  return { type: block.type };
}

// The record minus what no consumer reads; edit line counts and result sizes ride along precomputed.
export function projectRecord(record) {
  if (!isObject(record)) return record;
  const slim = {};
  for (const key of Object.keys(record)) {
    if (!DROPPED_FIELDS.has(key)) slim[key] = record[key];
  }
  if (record.toolUseResult !== undefined) slim.toolUseResult = true;
  if (isObject(record.message)) {
    slim.message = { ...record.message };
    if (Array.isArray(record.message.content)) slim.message.content = record.message.content.map(projectBlock);
  }
  return slim;
}

function lastNonSpace(buf, start, end) {
  for (let i = end - 1; i >= start; i--) {
    if (!JSON_SPACE.has(buf[i])) return buf[i];
  }
  return -1;
}

function startsWithBlob(buf, start, end) {
  return end - start >= BLOB_PREFIX.length
    && buf.compare(BLOB_PREFIX, 0, BLOB_PREFIX.length, start, start + BLOB_PREFIX.length) === 0;
}

// An over-limit line is never held whole: only its head and its last non-space byte are kept.
function newSkip() {
  return { head: Buffer.alloc(0), last: -1 };
}

function skipForward(skip, buf, start, end) {
  if (skip.head.length < BLOB_PREFIX.length) {
    skip.head = Buffer.concat([skip.head, buf.subarray(start, Math.min(end, start + BLOB_PREFIX.length))]);
  }
  const last = lastNonSpace(buf, start, end);
  if (last !== -1) skip.last = last;
}

function skipBackward(skip, buf, start, end) {
  const front = buf.subarray(start, Math.min(end, start + BLOB_PREFIX.length));
  skip.head = Buffer.concat([front, skip.head]).subarray(0, BLOB_PREFIX.length);
  if (skip.last === -1) skip.last = lastNonSpace(buf, start, end);
}

// The line's record, or undefined when it gives none (blank, malformed or over the limit).
function recordOf(buf, start, end, skip) {
  const blob = skip == null
    ? startsWithBlob(buf, start, end) && lastNonSpace(buf, start, end) === CLOSE_BRACE
    : startsWithBlob(skip.head, 0, skip.head.length) && skip.last === CLOSE_BRACE;
  if (blob) return { type: BLOB_TYPE };
  if (skip != null) return undefined;
  const text = buf.toString('utf8', start, end);
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function withFile(transcriptPath, read) {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    return read(fd, fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
}

// Calls onLine(buf, start, end, skip) per `\n`-split line in file order, the unterminated last one included when non-empty.
function forEachLine(transcriptPath, { chunkBytes = CHUNK_BYTES, maxLineBytes = MAX_LINE_BYTES } = {}, onLine) {
  withFile(transcriptPath, (fd, size) => {
    let buf = Buffer.alloc(chunkBytes);
    let start = 0;
    let end = 0;
    let pos = 0;
    let skip = null;
    for (;;) {
      const nl = buf.subarray(0, end).indexOf(NEWLINE, start);
      if (nl !== -1) {
        if (skip == null && nl - start > maxLineBytes) skip = newSkip();
        if (skip != null) skipForward(skip, buf, start, nl);
        if (onLine(buf, start, nl, skip)) return;
        skip = null;
        start = nl + 1;
        continue;
      }
      if (skip == null && end - start > maxLineBytes) skip = newSkip();
      if (skip != null) {
        skipForward(skip, buf, start, end);
        start = 0;
        end = 0;
      } else {
        buf.copy(buf, 0, start, end);
        end -= start;
        start = 0;
        if (end === buf.length) {
          const grown = Buffer.alloc(buf.length * 2);
          buf.copy(grown, 0, 0, end);
          buf = grown;
        }
      }
      if (pos >= size) break;
      const read = fs.readSync(fd, buf, end, Math.min(buf.length - end, size - pos), pos);
      if (read === 0) break;
      pos += read;
      end += read;
    }
    if (skip != null || end > start) onLine(buf, start, end, skip);
  });
}

// Same as forEachLine, from the last line to the first; empty lines are passed too.
function forEachLineBackward(transcriptPath, { chunkBytes = CHUNK_BYTES, maxLineBytes = MAX_LINE_BYTES } = {}, onLine) {
  withFile(transcriptPath, (fd, size) => {
    let buf = Buffer.alloc(chunkBytes);
    let start = buf.length;
    let end = buf.length;
    let pos = size;
    let skip = null;
    for (;;) {
      const nl = buf.subarray(start, end).lastIndexOf(NEWLINE);
      if (nl !== -1) {
        const lineStart = start + nl + 1;
        if (skip == null && end - lineStart > maxLineBytes) skip = newSkip();
        if (skip != null) skipBackward(skip, buf, lineStart, end);
        if (onLine(buf, lineStart, end, skip)) return;
        skip = null;
        end = lineStart - 1;
        continue;
      }
      if (pos === 0) break;
      if (skip == null && end - start > maxLineBytes) skip = newSkip();
      if (skip != null) {
        skipBackward(skip, buf, start, end);
        start = buf.length;
        end = buf.length;
      } else {
        const len = end - start;
        const target = len === buf.length ? Buffer.alloc(buf.length * 2) : buf;
        buf.copy(target, target.length - len, start, end);
        buf = target;
        start = buf.length - len;
        end = buf.length;
      }
      const want = Math.min(start, pos);
      pos -= want;
      if (fs.readSync(fd, buf, start - want, want, pos) !== want) throw new Error('transcript changed while reading');
      start -= want;
    }
    if (skip == null && end - start > maxLineBytes) skip = newSkip();
    if (skip != null) skipBackward(skip, buf, start, end);
    onLine(buf, start, end, skip);
  });
}

export function scanTranscript(transcriptPath, fromLine, onRecord, options) {
  let count = 0;
  // Empty lines count only once a later non-empty line arrives: that is the trailing-`\n` trim.
  let pendingEmpty = 0;
  forEachLine(transcriptPath, options, (buf, start, end, skip) => {
    if (skip == null && start === end) {
      pendingEmpty += 1;
      return false;
    }
    count += pendingEmpty + 1;
    pendingEmpty = 0;
    if (count <= fromLine) return false;
    const line = recordOf(buf, start, end, skip);
    return line !== undefined && onRecord({ lineNo: count, line: projectRecord(line) }) === true;
  });
  return count;
}

export function readTranscript(transcriptPath, fromLine = 0, options) {
  const records = [];
  const lineCount = scanTranscript(transcriptPath, fromLine, (record) => { records.push(record); }, options);
  return { lineCount, records };
}

export function scanTranscriptTail(transcriptPath, visit, options) {
  forEachLineBackward(transcriptPath, options, (buf, start, end, skip) => {
    const line = recordOf(buf, start, end, skip);
    return line !== undefined && visit(line) === true;
  });
}
