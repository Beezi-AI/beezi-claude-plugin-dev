import { recordIssue as _recordIssue, setCurrentSource } from './telemetry.mjs';
import { exitClean as _exitClean } from './shutdown.mjs';
import { DIAGNOSTIC_CODES } from './telemetry-codes.mjs';

// Wraps a hook body. Today every script ends `.catch(() => {}).finally(() => exitClean(0))`,
// which is exactly where a crash disappears. Same exit behaviour, one extra step: the failure
// is recorded first. Never rethrows — a hook that fails must still exit 0.
export async function runHook(source, fn, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const exitClean = deps.exitClean == null ? _exitClean : deps.exitClean;
  const onResult = deps.onResult == null ? () => {} : deps.onResult;

  const onRejection = (reason) => {
    try {
      recordIssue({
        code: DIAGNOSTIC_CODES.HOOK_UNHANDLED_REJECTION,
        source,
        error: reason instanceof Error ? reason : new Error('unhandled'),
      });
    } catch { /* never */ }
  };
  process.on('unhandledRejection', onRejection);
  // Published for call sites (fs-store, token) that don't know their own source — they fall
  // back to whatever hook is currently in flight instead of guessing.
  setCurrentSource(source);

  try {
    onResult(await fn());
  } catch (error) {
    try {
      recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source, error });
    } catch { /* never */ }
  } finally {
    // Not cleared here: a write failure's report is fired-and-forgotten via a lazy import that
    // can resolve after this hook has already finished, and it still needs to see this hook's
    // source. Each hook is its own short-lived process, so nothing after this ever reads it.
    process.removeListener('unhandledRejection', onRejection);
    await exitClean(0);
  }
}
