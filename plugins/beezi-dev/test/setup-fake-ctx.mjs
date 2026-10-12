// Scripted ctx for the setup wizard tests: outputs keyed by "<script> <argv…>", queued answers, captured prints.
export const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
export const fail = (stderr) => ({ code: 1, stdout: '', stderr });

// An array value answers successive runs of one command in order; an unscripted command succeeds silently.
export function fakeCtx(outputs, answers) {
  const runs = [];
  const asked = [];
  const printed = [];
  const queue = answers.slice();
  const answer = (entry) => {
    asked.push(entry);
    return Promise.resolve(queue.length ? queue.shift() : null);
  };
  return {
    runs,
    asked,
    printed,
    print: (line) => { printed.push(line); },
    run: (script, argv, opts) => {
      const command = [script].concat(argv).join(' ');
      runs.push({ command, opts: opts || {} });
      const scripted = outputs[command];
      const result = Array.isArray(scripted) ? scripted.shift() : scripted;
      return Promise.resolve(result === undefined ? ok('') : result);
    },
    ask: {
      choose: (question, options, opts) => answer({ kind: 'choose', question, options, defaultIndex: opts ? opts.defaultIndex : undefined }),
      chooseMany: (question, options) => answer({ kind: 'chooseMany', question, options }),
      confirm: (question, defaultYes) => answer({ kind: 'confirm', question, defaultYes }),
      text: (question) => answer({ kind: 'text', question }),
    },
  };
}

export const commands = (ctx) => ctx.runs.map((r) => r.command);
export const labels = (entry) => entry.options.map((o) => o.label);
