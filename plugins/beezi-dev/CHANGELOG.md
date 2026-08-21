# Changelog

## 0.10.0 — 2026-08-21

### Fixed: subscription plan stuck on "unknown" after a Claude account switch

**The bug.** The plugin's only plan source was the `oauthAccount` object in
`~/.claude.json`. That object is written only by the interactive CLI `/login` flow:
the VS Code extension GUI login never writes it, a `/login` account switch can leave
the previous account's copy behind stale, and long-lived setup-token auth leaves it
partial or absent. After switching accounts (typically through the VS Code
extension), the plugin had no readable plan source — the plan reported as
`unknown` forever, and both `/beezi:refresh` and `/beezi:login`'s capture step
exited without writing anything, so nothing could ever repair it. `billing.json`
also stored no account identity, so a plan captured (or self-reported) for
account A was silently reported for account B.

### What actually changed

- **New plan source — Claude Code's own CLI.** `lib/claude-auth-status.mjs` runs
  `claude auth status --json` (non-secret output: `loggedIn`, `authMethod`,
  `subscriptionType`, `email`) and merges it with the non-secret `oauthAccount`
  metadata. The CLI reads its own credential store internally (macOS Keychain
  included); **plugin code never opens `.credentials.json` or the keychain, and no
  token ever reaches plugin code.** `subscriptionType` comes from the CLI (fresh by
  construction); the Max multiplier (`rateLimitTier`) is taken from `oauthAccount`
  only when its subscription type agrees — a stale profile from a previous account
  can no longer donate its multiplier.
- **Account-switch detection.** `billing.json` (schema v2) now stores an
  `accountAnchor` — the CLI's account email when available, else
  `oauthAccount.accountUuid`, else the `userID` hash from `~/.claude.json` — plus a
  `detectedVia` provenance field and an `anchorCheckedAt` heartbeat. A positive
  anchor mismatch (same source, different value) means the account changed: the old
  record is dropped — self-reported plans included, because account A's answer does
  not describe account B — and the plan is re-captured for the new account.
- **Self-healing at session start.** The SessionStart hook now runs
  `reconcileBillingConfig`: it re-captures automatically when the record is
  missing, stuck on `unknown`, stale (7 days), the anchor mismatches, or the weekly
  heartbeat is due. Machines already stuck on `unknown` heal on their first session
  after this update, with no user action.
- **Manual commands share the same logic.** `/beezi:refresh` and `/beezi:login`'s
  capture step run the same reconcile in forced mode: always re-read, detect
  switches (the output then notes `account=changed`), protect a still-valid
  self-reported plan, and stamp the anchor + heartbeat.
- **Billing source for extension logins.** Machines where no config source is
  readable can still resolve `billing_source: subscription` from two cheap local
  signals: a fresh (≤7 days) CLI-observed capture, and a recent status-line
  `rate_limits` observation (that payload only exists for Pro/Max subscribers).
  Custom-gateway machines are exempt — what a gateway bills stays the user's
  question. Status-line rate-limit rows now also carry the plan fields from a fresh
  CLI capture when `oauthAccount` is unreadable.

### How it works now

At session start the plugin checks `billing.json`. If it is fresh, matches the
current account, and its weekly heartbeat is current, nothing runs (no spawn, no
write). Otherwise it asks Claude Code itself for the current subscription
(`claude auth status --json`, ~600ms, session start and manual commands only —
never on the per-checkpoint hot path), merges the non-secret `oauthAccount`
metadata, and rewrites `billing.json` with the plan, its provenance, and the
account anchor. Every report then reads the plan from that file, as before.

Known limits: without a trustworthy `oauthAccount`, Max reports as `plan=max`
(multiplier unknown — the CLI does not expose the tier); machines with no readable
signal at all (e.g. desktop-app DPAPI logins the bundled CLI cannot see) keep the
existing `/beezi:login` self-report fallback.
