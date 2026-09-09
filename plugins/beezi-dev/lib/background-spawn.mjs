import { spawn } from 'child_process';

// Fire and forget: start a Node script in its own process, cut every tie to this one, and return.
// The caller never awaits it, never reads from it and never sees its exit code.
//
// stdio 'ignore' and unref() are both load-bearing, for the SAME reason and not for tidiness. An
// inherited pipe or a ref'd child handle keeps a libuv handle alive in the parent, and a hook
// process that exits while a handle is mid-close aborts on Windows with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
// which Claude Code surfaces as "Stop hook error". lib/shutdown.mjs exists entirely to avoid that;
// do not undo it here by capturing the child's output for debugging.
//
// Never throws: a machine that refuses to spawn (EPERM, EMFILE, a locked-down policy) must cost
// the hook nothing at all.
export function spawnDetached(scriptPath, deps = {}) {
  const spawnImpl = deps.spawnImpl == null ? spawn : deps.spawnImpl;
  try {
    const child = spawnImpl(process.execPath, [scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child == null) return false;
    child.unref();
    return true;
  } catch {
    return false;
  }
}
