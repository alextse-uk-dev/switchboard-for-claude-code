import { strict as assert } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { MacHelper } from '../src/alert';
import { helperArgs, helperFailure, linkedKey, OPEN_PATH, openQuery, plistVersion, readLink, replacesHelper, TEST_PATH } from '../src/core/alert';

const root = path.join(__dirname, '..', '..');
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-test-'));
  dirs.push(dir);
  return dir;
}

after(() => Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

/** A stand-in for the built app: the files the installer looks at. */
const plistOf = (v: string) => `<plist><dict><key>CFBundleVersion</key>\n  <string>${v}</string></dict></plist>`;
const opts = { register: '/usr/bin/true' };

async function fakeApp(dir: string, exe: string, plist = plistOf('1.0.0')): Promise<void> {
  await fs.mkdir(path.join(dir, 'Switchboard.app', 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(dir, 'Switchboard.app', 'Contents', 'MacOS', 'Switchboard'), exe, { mode: 0o644 });
  await fs.writeFile(path.join(dir, 'Switchboard.app', 'Contents', 'Info.plist'), plist);
}

test("a banner's link names its session, and reads back with the parts VS Code adds", () => {
  const key = '4242:3f2c-aa&b=c';
  const q = openQuery(key);
  assert.deepEqual(readLink(OPEN_PATH, q), { open: key });
  assert.deepEqual(readLink(OPEN_PATH, `${q}&windowId=3`), { open: key });
  assert.deepEqual(readLink(OPEN_PATH, `windowId=3&${q}`), { open: key });
  assert.deepEqual(readLink(TEST_PATH, 'windowId=3'), { test: true });
});

test('a link with another path, or no key, asks for nothing', () => {
  assert.equal(readLink('/other', openQuery('1:a')), undefined);
  assert.equal(readLink(OPEN_PATH, 'windowId=3'), undefined);
  assert.equal(readLink(OPEN_PATH, 'key='), undefined);
  assert.equal(readLink('', ''), undefined);
});

test('a link finds its session, or the same session resumed under a new process, and nothing else', () => {
  const keys = ['10:aaa', '11:bbb'];
  assert.equal(linkedKey('10:aaa', keys), '10:aaa');
  assert.equal(linkedKey('99:bbb', keys), '11:bbb');
  assert.equal(linkedKey('99:ccc', keys), undefined);
  // Not a key at all: never matched on a piece of one.
  assert.equal(linkedKey('b', keys), undefined);
  assert.equal(linkedKey('10:', keys), undefined);
  assert.equal(linkedKey(':aaa', keys), undefined);
});

test("the helper's arguments carry the words as they are, after the command", () => {
  const evil = '-e do shell script "echo pwned"';
  assert.deepEqual(helperArgs(evil, '$(rm -rf ~)', 'vscode://x/open?key=1'), ['post', evil, '$(rm -rf ~)', 'vscode://x/open?key=1']);
});

test("every exit code the helper gives is one the extension explains, and the helper's are the ones it knows", () => {
  assert.equal(helperFailure(0), undefined);
  const swift = readFileSync(path.join(root, 'mac', 'Switchboard.swift'), 'utf8');
  const codes = [...swift.matchAll(/fail\((\d+),/g)].map((m) => Number(m[1]));
  assert.deepEqual([...new Set(codes)].sort(), [2, 3, 4, 5]);
  for (const c of [3, 4, 5]) assert.doesNotMatch(helperFailure(c) ?? '', /exit/, `code ${c}`);
  assert.match(helperFailure(2) ?? '', /exit 2/);
  assert.match(helperFailure(null) ?? '', /failed/);
});

test('the helper is copied into storage once, made runnable, and replaced when the bundled one changes', async () => {
  const bundled = await tempDir();
  const storage = path.join(await tempDir(), 'globalStorage');
  await fakeApp(bundled, 'v1');
  const h = new MacHelper(bundled, storage, opts);
  const exe = await h.install();
  assert.equal(exe, path.join(storage, 'Switchboard.app', 'Contents', 'MacOS', 'Switchboard'));
  assert.equal(await fs.readFile(exe!, 'utf8'), 'v1');
  assert.equal((await fs.stat(exe!)).mode & 0o777, 0o755);
  const before = (await fs.stat(exe!)).ino;
  assert.equal(await h.install(), exe);
  assert.equal((await fs.stat(exe!)).ino, before, 'an up-to-date copy is left alone');
  await fakeApp(bundled, 'v2');
  assert.equal(await h.install(), exe);
  assert.equal(await fs.readFile(exe!, 'utf8'), 'v2');
  // A new version is a new copy, even with the same program.
  await fakeApp(bundled, 'v2', plistOf('1.1.0'));
  await h.install();
  assert.equal(await fs.readFile(path.join(storage, 'Switchboard.app', 'Contents', 'Info.plist'), 'utf8'), plistOf('1.1.0'));
  // A window still on an older version uses the newer copy rather than swapping its own back in.
  const older = await tempDir();
  await fakeApp(older, 'v0', plistOf('1.0.9'));
  assert.equal(await new MacHelper(older, storage, opts).install(), exe);
  assert.equal(await fs.readFile(exe!, 'utf8'), 'v2');
  // No copies left beside it.
  assert.deepEqual(await fs.readdir(storage), ['Switchboard.app']);
});

test('the bundled helper replaces the installed one only if it is newer, or the same version built again', () => {
  assert.equal(plistVersion(plistOf('0.8.0')), '0.8.0');
  assert.equal(plistVersion('<plist/>'), undefined);
  const b = { plist: plistOf('0.8.0') };
  assert.equal(replacesHelper(b, undefined), true);
  assert.equal(replacesHelper(b, { plist: plistOf('0.8.0'), same: true }), false);
  assert.equal(replacesHelper(b, { plist: plistOf('0.8.0'), same: false }), true);
  assert.equal(replacesHelper(b, { plist: plistOf('0.7.10'), same: false }), true);
  assert.equal(replacesHelper(b, { plist: plistOf('0.10.0'), same: false }), false);
  assert.equal(replacesHelper(b, { plist: '<plist/>', same: false }), true);
  assert.equal(replacesHelper(b, { plist: '<plist/>', same: true }), false);
});

test('a helper that fails says why, so the caller can fall back: its exit code, or no answer in time', async () => {
  const say = async (script: string, timeoutMs?: number) => {
    const bundled = await tempDir();
    await fakeApp(bundled, `#!/bin/sh\n${script}\n`);
    return new MacHelper(bundled, await tempDir(), { ...opts, timeoutMs }).post('t', 'm', 'vscode://x/test');
  };
  await say('exit 0');
  await assert.rejects(say('exit 3'), /notifications are off for Switchboard/);
  await assert.rejects(say('exit 5'), /no answer yet/);
  await assert.rejects(say('exit 9'), /exit 9/);
  await assert.rejects(say('sleep 5', 200), /no answer in time/);
  // The words reach the helper as they are.
  await say('[ "$1" = post ] && [ "$2" = t ] && [ "$3" = m ] && [ "$4" = vscode://x/test ] || exit 9');
});

test('two windows installing at once both get a whole copy', async () => {
  const bundled = await tempDir();
  const storage = await tempDir();
  await fakeApp(bundled, 'same');
  const [a, b] = await Promise.all([new MacHelper(bundled, storage, opts).install(), new MacHelper(bundled, storage, opts).install()]);
  assert.equal(a, b);
  assert.equal(await fs.readFile(a!, 'utf8'), 'same');
  assert.deepEqual(await fs.readdir(storage), ['Switchboard.app']);
});

test('a build without the helper installs nothing, and a banner through it fails so the caller can fall back', async () => {
  const storage = await tempDir();
  const h = new MacHelper(await tempDir(), storage, opts);
  assert.equal(await h.install(), undefined);
  await assert.rejects(h.post('t', 'm', 'vscode://x/test'), /no helper/);
  assert.deepEqual(await fs.readdir(storage), []);
});

test('the package ships the built helper and not its source, and the build stamps its version', () => {
  const files = execFileSync(path.join(root, 'node_modules', '.bin', 'vsce'), ['ls'], { cwd: root, encoding: 'utf8' }).split('\n').map((l) => l.trim());
  assert.ok(files.includes('out/mac/Switchboard.app/Contents/MacOS/Switchboard'), 'the helper is packaged');
  assert.ok(files.includes('out/mac/Switchboard.app/Contents/Info.plist'));
  assert.ok(!files.some((f) => f.startsWith('mac/') || f.startsWith('scripts/')), 'the Swift source stays out of the package');
  const plist = readFileSync(path.join(root, 'mac', 'Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>__VERSION__<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string>; activationEvents: string[] };
  assert.match(pkg.scripts.package, /build:mac.*vsce package/);
  assert.ok(pkg.activationEvents.includes('onUri'));
});

const built = path.join(root, 'out', 'mac', 'Switchboard.app', 'Contents', 'MacOS', 'Switchboard');

test('the built helper refuses wrong arguments, and is built for this version', { skip: process.platform !== 'darwin' || !existsSync(built) }, async () => {
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) =>
      execFile(built, args, { timeout: 20_000 }, (e, out, err) => resolve({ code: e ? Number(e.code) : 0, out, err })),
    );
  const bad = await run(['post', 'only a title']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /usage/);
  const plist = readFileSync(path.join(built, '..', '..', 'Info.plist'), 'utf8');
  const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
  assert.ok(plist.includes(`<string>${version}</string>`), 'built for this version');
});
