---
description: Turn Beezi plugin crash reporting on or off for this machine
allowed-tools: Bash(node:*)
argument-hint: "on | off"
---

Do NOT read, open, or inspect any files. Run only this command, passing through whatever the
user typed as the argument (no argument reports the current setting):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs $1`

Report its one-line output verbatim. If the user asks what is collected: plugin and Claude Code
versions, OS, and which plugin file failed — never their code, prompts, file paths, or repository
names.
