---
description: Refresh this machine's Claude subscription/plan for Beezi analytics
allowed-tools: Bash(node:*), AskUserQuestion
---

Two steps. Step 1 always runs. Step 2 runs only when this machine signs in with
a Claude setup token whose subscription Beezi does not know.

Do not read or inspect any files yourself, and never echo a token.

## Step 1 — capture what the machine can prove

Run EXACTLY this one command — do not modify it and do not substitute your own:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --from-claude --via refresh`

The script asks Claude Code itself for the non-secret subscription info
(`claude auth status`) and reads the non-secret account metadata from
`~/.claude.json` (never any token, never the credentials file), then stores the
plan. Report its one-line output verbatim.

If it says nothing was captured, tell the user their Claude subscription info was
not found. If the output says the self-reported plan was kept, report that
verbatim. If the output contains `gateway=custom`, tell the user this machine goes
through a custom API endpoint, so only they can say what it bills — point them at
`/beezi:login`, which asks.

## Step 2 — resolve the setup token, if there is one to resolve

A machine signing in with `CLAUDE_CODE_OAUTH_TOKEN` cannot prove its plan
locally: Claude Code writes no account metadata under that auth mode, so whatever
Step 1 found is a previous login's leftovers. Only the portal knows whether that
key has been given a subscription.

Run:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs status`

It prints exactly one JSON object. Read `status` from it and do exactly this:

| `status`                          | What to do                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `"resolved"`                      | Say the key's subscription is already known, naming `subscriptionPlan`. **Stop.**            |
| `"unknown_key"`                   | Say Beezi has not seen this key yet and it will register on the next session. **Stop.**      |
| `"no_key"` / `"not_linked"` / `"unavailable"` | Report the object's `message` verbatim. **Stop.**                                |
| `"unlinked"`                      | Continue below — this is the case worth asking about.                                        |

### 2a — how do they want to resolve it

Ask with the AskUserQuestion tool: "Beezi does not know which subscription this
machine's Claude setup token bills. How do you want to resolve it?"

Build the options from the JSON you just read — do not invent them:

- "Use one of my subscriptions" — include this option **only if**
  `subscriptions` is a non-empty array.
- "Name the plan" — always include.
- "Enter an email or account id" — always include.

### 2b — the follow-up, by what they picked

**Picked "Use one of my subscriptions".** Ask a second question, "Which
subscription does this machine bill?", with one option per entry in
`subscriptions`, using that entry's `label` as the option label. Then run, with
the chosen entry's `target` substituted verbatim:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --target <target>`

**Picked "Name the plan".** Ask a second question, "Which plan is this
subscription on?", with one option per entry in `selectablePlans`, using that
entry's `label` as the option label. Then run, with the chosen entry's `plan`
value (not its label) substituted verbatim:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --plan <plan>`

**Picked "Enter an email or account id".** Do not ask a multiple-choice question
— wait for the user to type the value in their next message, then run:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --target <value>`

### 2c — report the result

Run the resolve command EXACTLY ONCE, then print its one line verbatim. The two
link outcomes are different events and the wording already distinguishes them —
joining an existing subscription is not the same as the key standing on its own,
so do not paraphrase them into one sentence.

If the user dismisses a question, or answers something that is not one of the
options you offered, skip the resolve command entirely and say the plan was left
as it is. Step 1 already succeeded either way — never re-run Step 1 to compensate.
