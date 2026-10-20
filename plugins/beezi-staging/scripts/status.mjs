import { getDefaultKey, listAccounts } from '../lib/accounts.mjs';
import { accountHealth } from '../lib/me.mjs';
import { currentSessionWorkspace, roleLabel, tenantsOf } from '../lib/workspace.mjs';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { placeOfDir, routeOfDir, routeText } from '../lib/route-describe.mjs';
import { claudePlan, crashMode } from '../lib/machine-settings.mjs';
import { statuslineInstalled } from '../lib/statusline-install.mjs';
import { badgeEnabled } from '../lib/statusline-badge.mjs';
import { liveOffNote } from '../lib/session-banner.mjs';
import { readTrackingState } from '../lib/tracking.mjs';
import { aboutPlugin } from '../lib/about.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';

// /beezi:status — one read-only screen: sign-in, workspaces, where this folder goes, plan, machine, plugin version.

const LABEL_WIDTH = 14;
const PLACE_LABELS = { repo: 'This repo', folder: 'This folder', outside: 'Here' };

function field(label, value) {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}

function currentDir() {
  try {
    const state = currentSessionWorkspace();
    if (state != null && state.cwd != null) return state.cwd;
  } catch { /* no session state: this process's folder */ }
  return process.cwd();
}

// Everything the screen shows, loaded once: health checks and the update check run side by side.
export async function loadStatus(deps = {}) {
  const health = deps.accountHealth == null ? accountHealth : deps.accountHealth;
  const about = deps.aboutPlugin == null ? aboutPlugin : deps.aboutPlugin;
  const accounts = await listAccounts();
  const checks = {};
  const [plugin] = await Promise.all([
    about().catch(() => null),
    ...accounts.map(async (a) => {
      try {
        checks[a.key] = await health(a);
      } catch (error) {
        checks[a.key] = { ok: false, lines: [friendlyMessage(error)] };
      }
    }),
  ]);
  // Health checks refresh each account's workspaces, so the index is read again after.
  const rows = accounts.length > 0 ? await listAccounts() : accounts;
  const tracking = {};
  rows.forEach((row) => { tracking[row.key] = readTrackingState(row.key); });
  return {
    rows,
    health: checks,
    tracking,
    def: await getDefaultKey(),
    dir: deps.dir == null ? currentDir() : deps.dir,
    ctx: createRouteContext(),
    plugin,
    machine: { statusline: statuslineInstalled(), badge: badgeEnabled(), crash: crashMode(), plan: claudePlan() },
  };
}

function accountLine(row, check, tag) {
  const who = `${row.email || row.name || 'linked account'}${tag}`;
  if (check == null || check.ok) return `✓ ${who}, signed in`;
  const text = (check.lines || []).map((l) => l.trim()).filter((l) => l).join(' ').replace(/^Beezi: /, '');
  return `⚠ ${who}: ${text || 'could not check the sign-in'}`;
}

function workspaceField(row) {
  const tenants = tenantsOf(row) || [];
  if (tenants.length === 0) return field('Workspace', 'not known yet — start a new session');
  const names = tenants.map((t) => {
    const role = roleLabel(t);
    return `${t.name || t.id}${role ? ` (${role})` : ''}`;
  });
  return field(tenants.length > 1 ? 'Workspaces' : 'Workspace', names.join(', '));
}

// "labacus-suite → Acme (default)" under its place's label, with the banner's note when nothing goes live; null when the place or the workspaces are unknown.
function placeField(row, dir, ctx, tracking) {
  let place = null;
  let route = null;
  try {
    place = placeOfDir(dir, ctx);
    if (place != null) route = routeOfDir(row, dir, ctx);
  } catch {
    return null;
  }
  if (place == null || route == null || route.reason.kind === 'unknown') return null;
  const where = place.kind === 'outside' ? 'sessions outside a project' : place.short;
  const off = liveOffNote(row, tracking, route);
  return field(PLACE_LABELS[place.kind] || 'Here', `${where} ${routeText(row, route)}${off == null ? '' : `, but ${off}`}`);
}

export function pluginText(info) {
  if (info == null || info.local == null) return 'unknown (could not read its version)';
  const version = info.local.version;
  if (info.status === 'update' && info.latest != null) {
    return `${version}. ${info.latest.version} is out: run /plugin to update, then restart.`;
  }
  const checked = info.latest != null && !info.latest.stale;
  if (checked && (info.status === 'current' || info.status === 'ahead')) return `${version}, the newest`;
  return `${version} (could not check for updates)`;
}

function machineLines(view) {
  const m = view.machine;
  const statusline = !m.statusline ? 'off' : (m.badge ? 'on with the Beezi badge' : 'on');
  return [
    field('Claude plan', m.plan),
    field('This machine', `status line ${statusline}, crash reports ${m.crash === 'off' ? 'off' : 'on'}`),
    field('Plugin', pluginText(view.plugin)),
  ];
}

export function formatStatus(view) {
  const out = ['Beezi'];
  const several = view.rows.length > 1;
  if (view.rows.length === 0) out.push(field('Account', 'not linked — run /beezi:login'));
  view.rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(field('Account', accountLine(row, view.health[row.key], several && row.key === view.def ? ' (default)' : '')));
    out.push(workspaceField(row));
    const here = placeField(row, view.dir, view.ctx, view.tracking == null ? null : view.tracking[row.key]);
    if (here != null) out.push(here);
  });
  if (several) out.push('');
  out.push(...machineLines(view), '', 'Change settings with /beezi:settings');
  return `${out.join('\n')}\n`;
}

async function main() {
  process.stdout.write(formatStatus(await loadStatus()));
}

// Tests import the formatters, so main runs only when this file is the entry script.
if (isEntryScript(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
}
