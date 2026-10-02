---
description: Upload past Claude Code sessions to Beezi analytics, skipping ones already uploaded
allowed-tools: Bash(node:*), AskUserQuestion
---

Do not read or inspect any files yourself.

The user cannot see tool output (Claude Code collapses it), so any output you are told to show
or write verbatim is copied exactly into your reply text — never summarized or paraphrased.

AskUserQuestion, everywhere below: at most 4 questions in one call and at most 4 options in one
question; `multiSelect: true` only with 2 or more options. Make one AskUserQuestion call per
message and wait for its answers before the next (two calls in one message show the user only
the last). A dismissed question runs nothing.

## Step 1 — repos and folders with no rule

Run EXACTLY (add `--account <key>` when the user named an account):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs routes`

Its output is for you only, except the one line named below. It lists, per account in several
workspaces set to "Ask me" for new folders, the repos and folders whose past sessions have no rule
yet. Its lines:

- `<email>: <N> repos or folders have past sessions with no rule (<M> sessions) account=<key>` —
  starts one account's block;
- `W. <workspace> account=<key> tenant=<id> role=<role>` — one per workspace of that account;
- `P<i>. <short> (<full label>), <k> sessions account=<key> kind=<repo|folder> match=<match>` —
  one repo or folder (a `P` line). `P<i>. outside a project, <k> sessions account=<key> kind=outside match=outside`
  is one too: every past session in the home folder, `/` or a temp folder;
- `P<i>-command=<command>` — right after its `P` line: the rule command for it, ending in a
  literal `<tenants>`. It is not a `P` line;
- `all-command=<command>` — one per account: the command that gives all of that account's `P`
  lines the same workspaces, ending in a literal `<tenants>`;
- `<n> other past sessions have no recorded folder and are not sent.` (or `1 other past session
  has no recorded folder and is not sent.`) — write this line verbatim, once; there is nothing to
  ask about it;
- `routes=<total>` — the number of `P` lines, always last.

Not linked, or `routes=0` → nothing to ask; go to Step 2.

For each account with `P` lines (with several accounts, end every question text with
" (<email>)"):

More than 4 `P` lines → first ask (single-select) "Where should analytics for these <N> repos and
folders go?" (`<N>` = that account's number of `P` lines) with the options "Send all <N> to the
same workspaces…" (description "Pick the workspaces once for all of them"), "Choose per repo"
("One question per repo or folder") and "Skip" ("Nothing from them is sent this time; you're
asked again next time").

- "Send all <N> to the same workspaces…" → ask (`multiSelect: true`) "Which workspaces should get
  analytics for these <N> repos and folders?", one option per `W.` line of that account (label and
  description as below; more than 4 → split evenly into questions of at most 4, each ending in
  " (j of k)"). Nothing chosen → run nothing. Otherwise run that account's `all-command=` text
  EXACTLY ONCE, changing nothing except the final `<tenants>`, which becomes the chosen `tenant=`
  values joined by commas.
- "Choose per repo" → the per-repo questions below.
- "Skip" or a dismissal → nothing more for that account.

4 or fewer `P` lines → the per-repo questions.

Per-repo questions — one `multiSelect: true` question per `P` line, numbered across that
account's `P` lines (`i` from 1, `N` = their number). `<short>` is the `P` line's text after
`P<i>. ` up to ` (` or `,`, and `<label>` the text in the parentheses after it. The question and
its last option follow the line's `kind=`:

| `kind=`   | Question                                                                        | Last option               |
| --------- | ------------------------------------------------------------------------------- | ------------------------- |
| `repo`    | "(i of N) Where should analytics for <short> go?"                               | "Don't track this repo"   |
| `folder`  | "(i of N) Where should analytics for <label> (and everything inside it) go?"    | "Don't track this folder" |
| `outside` | "(i of N) Where should analytics for sessions outside a project folder go?"     | "Don't track these"       |

Options: one per `W.` line of that account — label = the workspace name (the text after `W. ` up
to ` account=`), description = the line's `role=` value, or "Beezi workspace" when it is empty —
then the last option, description "Nothing from <short> is uploaded" ("Nothing
from sessions outside a project folder is uploaded" for `outside`). More than 4 options → split
them evenly into questions of at most 4 (5 → 3 + 2), the last option in the last one, each ending
in " (part j of k)"; the `P` line's answer is all of its parts together.

Then, for each `P` line with an answer, run its `P<i>-command=` text EXACTLY ONCE, changing
nothing except the final `<tenants>`: the chosen `tenant=` values joined by commas (e.g.
`t1,t2`), or `none` when the last option was chosen (it wins over the others). Never rebuild the
command or re-quote its path yourself. A `P` line with nothing chosen, or a dismissed question,
runs nothing: its sessions are not sent this time, and the next /beezi:sync asks again.

Write each command's first line verbatim.

## Step 2 — sync

Run EXACTLY this one command (add `--account <key>` when the user named an account):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs`

For an account in several workspaces, each past session goes where its own repo or folder
routes: its rule, else the New folders setting ("Send to" workspaces get it; under "Ask me" or
"Don't send" it is not sent this time). Add `--account <key> --tenant <id>[,<id>…]` only when the
user asks to sync specific workspaces instead: that is an override that sends every past session
to those workspaces, ignoring rules.

Write its output verbatim as your reply text. Never echo any token.

The script uploads every past session still on this machine that Beezi does not
already have. It asks the server how far each session already reaches and resumes
from exactly there, so it is safe to run as often as the user likes — a repeat run
uploads nothing and reports that everything is up to date.

Notes for interpreting the output:

- "everything is already uploaded" is a success, not a failure — it means Beezi is
  in sync. Do not re-run the command or suggest flags to force it.
- If it says this machine is not linked, point the user at `/beezi:login`.
- If it says the portal does not support `/beezi:sync` yet, the workspace's Beezi
  server needs updating — the user's history is not lost, and the command will work
  after the update.
- A `Beezi (<account>): …` line says where that account's past sessions go. "… not sent this
  time" is expected after a skipped question: the next /beezi:sync asks again, and
  /beezi:settings rules adds a rule from inside that repo or folder. When it is an account's only
  line, the run succeeded with nothing to send.

Account selection: With no flag, sync processes every linked account in turn. Add `--account <key>` to sync one account.

Every command output you show is written verbatim.
