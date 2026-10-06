import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_VERSION } from '../lib/update-check.mjs';
import { aboutPlugin, findInstall, formatAbout, marketplaceAutoUpdate } from '../lib/about.mjs';

// Every test gets its own BEEZI_HOME (the update cache), its own Claude config dir (the install
// records) and its own plugin root, so nothing here reads ~/.claude, ~/.beezi or the network.
async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-about-'));
  const home = path.join(dir, 'home');
  const claude = path.join(dir, 'claude');
  const root = path.join(dir, 'cache', 'beezi', 'beezi', '0.34.0');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  const prevHome = process.env.BEEZI_HOME;
  const prevUrl = process.env.BEEZI_UPDATE_MANIFEST_URL;
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.BEEZI_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claude;
  delete process.env.BEEZI_UPDATE_MANIFEST_URL;
  try {
    return await fn({ home, claude, root });
  } finally {
    if (prevHome === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prevHome;
    if (prevUrl === undefined) delete process.env.BEEZI_UPDATE_MANIFEST_URL;
    else process.env.BEEZI_UPDATE_MANIFEST_URL = prevUrl;
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writePlugin(root, manifest) {
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
}

function writeInstalled(claude, plugins, version = 2) {
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version, plugins }));
}

function writeMarketplaces(claude, body) {
  fs.writeFileSync(path.join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify(body));
}

function stubFetch(body, status = 200) {
  const impl = async (url, opts) => {
    impl.calls.push({ url, opts });
    return { status, json: async () => body };
  };
  impl.calls = [];
  return impl;
}

function failingFetch() {
  const impl = async () => { impl.calls.push(1); throw new Error('offline'); };
  impl.calls = [];
  return impl;
}

const NOW = new Date('2026-10-06T12:00:00.000Z');
const URL_OK = 'https://raw.example.invalid/.claude-plugin/marketplace.json';
const manifestWith = (version) => ({ name: 'beezi', plugins: [{ name: 'beezi', version }] });

function installEntry(root, over) {
  return {
    scope: 'user',
    installPath: root,
    version: '0.34.0',
    installedAt: '2026-09-10T17:43:17.093Z',
    lastUpdated: '2026-10-06T09:20:11.544Z',
    ...over,
  };
}

function deps(ctx, over) {
  return { pluginRoot: ctx.root, manifestUrl: URL_OK, now: NOW, ...over };
}

// ---------------------------------------------------------------- install record

test('findInstall matches the entry whose installPath is this plugin root', async () => {
  await withHome(async (ctx) => {
    writeInstalled(ctx.claude, {
      'other@beezi': [installEntry('/somewhere/else')],
      'beezi@beezi': [installEntry(ctx.root)],
    });
    const found = findInstall({ name: 'beezi', version: '0.34.0' }, { pluginRoot: ctx.root });
    assert.equal(found.marketplace, 'beezi');
    assert.equal(found.lastUpdated, '2026-10-06T09:20:11.544Z');
    assert.equal(found.installedAt, '2026-09-10T17:43:17.093Z');
  });
});

test('findInstall picks the right scope out of several entries under one key', async () => {
  await withHome(async (ctx) => {
    writeInstalled(ctx.claude, {
      'beezi@beezi': [
        installEntry('/project/copy', { scope: 'project', lastUpdated: '2026-01-01T00:00:00.000Z' }),
        installEntry(ctx.root),
      ],
    });
    const found = findInstall({ name: 'beezi', version: '0.34.0' }, { pluginRoot: ctx.root });
    assert.equal(found.scope, 'user');
    assert.equal(found.lastUpdated, '2026-10-06T09:20:11.544Z');
  });
});

test('findInstall ignores case and separators in a Windows installPath', async () => {
  await withHome(async (ctx) => {
    writeInstalled(ctx.claude, {
      'beezi@beezi': [installEntry('C:\\Users\\Me\\.claude\\plugins\\cache\\beezi\\beezi\\0.34.0')],
    });
    const found = findInstall({ name: 'beezi', version: '0.34.0' }, {
      pluginRoot: 'c:/users/me/.claude/plugins/cache/beezi/beezi/0.34.0',
      platform: 'win32',
    });
    assert.ok(found != null);
    assert.equal(found.marketplace, 'beezi');
  });
});

test('findInstall falls back to a same-name, same-version key when no path matches', async () => {
  await withHome(async (ctx) => {
    writeInstalled(ctx.claude, {
      'beezi-dev@beezi-internal': [installEntry('/moved/elsewhere', { version: '0.34.0' })],
    });
    const found = findInstall({ name: 'beezi-dev', version: '0.34.0' }, { pluginRoot: ctx.root });
    assert.equal(found.marketplace, 'beezi-internal');
  });
});

test('findInstall returns null for a copy loaded from a local folder', async () => {
  await withHome(async (ctx) => {
    writeInstalled(ctx.claude, { 'beezi@beezi': [installEntry('/elsewhere', { version: '0.32.4' })] });
    assert.equal(findInstall({ name: 'beezi', version: '0.34.0' }, { pluginRoot: ctx.root }), null);
  });
});

test('findInstall survives a missing, broken or unknown-format installed_plugins.json', async () => {
  await withHome(async (ctx) => {
    const local = { name: 'beezi', version: '0.34.0' };
    assert.equal(findInstall(local, { pluginRoot: ctx.root }), null);
    fs.writeFileSync(path.join(ctx.claude, 'plugins', 'installed_plugins.json'), '{ not json');
    assert.equal(findInstall(local, { pluginRoot: ctx.root }), null);
    writeInstalled(ctx.claude, { 'beezi@beezi': [installEntry(ctx.root)] }, 99);
    assert.equal(findInstall(local, { pluginRoot: ctx.root }), null);
    writeInstalled(ctx.claude, { 'beezi@beezi': 'not an array' });
    assert.equal(findInstall(local, { pluginRoot: ctx.root }), null);
  });
});

test('marketplaceAutoUpdate reads the flag, and is null when it cannot', async () => {
  await withHome(async (ctx) => {
    assert.equal(marketplaceAutoUpdate('beezi'), null);
    writeMarketplaces(ctx.claude, { beezi: { autoUpdate: true }, other: { autoUpdate: false } });
    assert.equal(marketplaceAutoUpdate('beezi'), true);
    assert.equal(marketplaceAutoUpdate('other'), false);
    assert.equal(marketplaceAutoUpdate('missing'), null);
  });
});

// ---------------------------------------------------------------- version status

test('a newer published version reports an update with both ways to install it', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    writeInstalled(ctx.claude, { 'beezi@beezi': [installEntry(ctx.root)] });
    writeMarketplaces(ctx.claude, { beezi: { autoUpdate: false } });
    const info = await aboutPlugin(deps(ctx, { fetchImpl: stubFetch(manifestWith('0.35.0')) }));
    assert.equal(info.status, 'update');
    const text = formatAbout(info);
    assert.match(text, /Installed version: +0\.34\.0/);
    assert.match(text, /Latest published: +0\.35\.0 \(checked 2026-10-06 12:00 UTC\)/);
    assert.match(text, /Update available: 0\.34\.0 → 0\.35\.0/);
    assert.match(text, /Last updated here: +2026-10-06 09:20 UTC \(first installed 2026-09-10 17:43 UTC\)/);
    assert.match(text, /\/plugin/);
    assert.match(text, /claude plugin marketplace update beezi\n/);
    assert.match(text, /claude plugin update beezi@beezi\n/);
    assert.match(text, /restart Claude Code/);
  });
});

test('/about always fetches fresh, even with a cached reading under an hour old', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    fs.writeFileSync(path.join(ctx.home, 'update-check.json'), JSON.stringify({
      version: STATE_VERSION,
      checkedAt: '2026-10-06T11:59:00.000Z',
      pluginName: 'beezi',
      latestVersion: '0.34.0',
      marketplaceName: 'beezi',
    }));
    const fetchImpl = stubFetch(manifestWith('0.35.0'));
    const info = await aboutPlugin(deps(ctx, { fetchImpl }));
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(info.status, 'update');
    assert.equal(info.latest.stale, false);
  });
});

test('the same published version reports up to date and gives no update steps', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    writeInstalled(ctx.claude, { 'beezi@beezi': [installEntry(ctx.root)] });
    const info = await aboutPlugin(deps(ctx, { fetchImpl: stubFetch(manifestWith('0.34.0')) }));
    assert.equal(info.status, 'current');
    const text = formatAbout(info);
    assert.match(text, /You have the newest version\./);
    assert.doesNotMatch(text, /claude plugin update/);
  });
});

test('an installed build ahead of the published one says so', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.35.0' });
    const info = await aboutPlugin(deps(ctx, { fetchImpl: stubFetch(manifestWith('0.34.0')) }));
    assert.equal(info.status, 'ahead');
    assert.match(formatAbout(info), /newer than the published 0\.34\.0/);
  });
});

test('versions that cannot be compared are reported as such, never as an update', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: 'not-a-version' });
    const info = await aboutPlugin(deps(ctx, { fetchImpl: stubFetch(manifestWith('0.34.0')) }));
    assert.equal(info.status, 'unknown');
    assert.doesNotMatch(formatAbout(info), /claude plugin update/);
  });
});

test('offline with a cached reading reports the last known version and when it was seen', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    fs.writeFileSync(path.join(ctx.home, 'update-check.json'), JSON.stringify({
      version: STATE_VERSION,
      checkedAt: '2026-10-05T08:00:00.000Z',
      pluginName: 'beezi',
      latestVersion: '0.35.0',
      marketplaceName: 'beezi',
    }));
    const info = await aboutPlugin(deps(ctx, { fetchImpl: failingFetch() }));
    assert.equal(info.status, 'update');
    assert.equal(info.latest.stale, true);
    assert.match(formatAbout(info), /0\.35\.0 \(could not check now; last seen 2026-10-05 08:00 UTC\)/);
  });
});

test('offline with nothing cached says the latest version is unknown', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    const info = await aboutPlugin(deps(ctx, { fetchImpl: failingFetch() }));
    assert.equal(info.status, 'unchecked');
    assert.match(formatAbout(info), /Latest published: +unknown — could not reach the update server/);
  });
});

test('a cached reading about a different plugin name is never used', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    fs.writeFileSync(path.join(ctx.home, 'update-check.json'), JSON.stringify({
      version: STATE_VERSION,
      checkedAt: '2026-10-05T08:00:00.000Z',
      pluginName: 'beezi-dev',
      latestVersion: '9.9.9',
      marketplaceName: 'beezi-internal',
    }));
    const info = await aboutPlugin(deps(ctx, { fetchImpl: failingFetch() }));
    assert.equal(info.status, 'unchecked');
  });
});

// ---------------------------------------------------------------- install-record edge cases

test('a local-folder copy reports no dates and still names the update commands from the manifest', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    const info = await aboutPlugin(deps(ctx, { fetchImpl: stubFetch(manifestWith('0.35.0')) }));
    const text = formatAbout(info);
    assert.match(text, /Last updated here: +unknown — not installed from a marketplace/);
    assert.match(text, /claude plugin update beezi@beezi/);
  });
});

test('auto-update on is mentioned next to the update steps', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    writeInstalled(ctx.claude, { 'beezi@beezi': [installEntry(ctx.root)] });
    writeMarketplaces(ctx.claude, { beezi: { autoUpdate: true } });
    const info = await aboutPlugin(deps(ctx, { fetchImpl: stubFetch(manifestWith('0.35.0')) }));
    assert.match(formatAbout(info), /Marketplace: +beezi \(auto-update on\)/);
  });
});

test('a local-folder copy never claims the marketplace auto-update setting', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi', version: '0.34.0' });
    writeMarketplaces(ctx.claude, { beezi: { autoUpdate: true } });
    const info = await aboutPlugin(deps(ctx, { fetchImpl: stubFetch(manifestWith('0.35.0')) }));
    const text = formatAbout(info);
    assert.match(text, /Marketplace: +beezi\n/);
    assert.doesNotMatch(text, /auto-update/i);
  });
});

test('no readable plugin.json is reported, not thrown', async () => {
  await withHome(async (ctx) => {
    const info = await aboutPlugin(deps(ctx, { fetchImpl: stubFetch(manifestWith('0.35.0')) }));
    assert.equal(info.local, null);
    assert.match(formatAbout(info), /could not read this plugin's version/);
  });
});
