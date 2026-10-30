import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { bannerArgs, helperArgs, helperFailure, replacesHelper } from './core/alert';

const RUN_TIMEOUT_MS = 10_000;
/** The helper waits 8 s for an answer to the notification prompt; this leaves it room. */
const HELPER_TIMEOUT_MS = 12_000;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const APP = 'Switchboard.app';
const EXE = path.join('Contents', 'MacOS', 'Switchboard');
const PLIST = path.join('Contents', 'Info.plist');

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve();
    });
  });
}

/** Shows a macOS notification banner through osascript (a click opens Script Editor). Throws with what went wrong. */
export function showBanner(title: string, message: string): Promise<void> {
  return run('/usr/bin/osascript', bannerArgs(title, message));
}

/** Plays a sound file, e.g. one of /System/Library/Sounds. Throws with what went wrong. */
export function playSound(file: string): Promise<void> {
  return run('/usr/bin/afplay', [file]);
}

/** Opens System Settings at Notifications. */
export function openNotificationSettings(): Promise<void> {
  return run('/usr/bin/open', ['x-apple.systempreferences:com.apple.Notifications-Settings.extension']);
}

async function readOrUndefined(file: string): Promise<Buffer | undefined> {
  return fs.readFile(file).catch(() => undefined);
}

export interface MacHelperOptions {
  /** The program that tells macOS about the app (lsregister). */
  register?: string;
  /** How long a banner may take to post. */
  timeoutMs?: number;
}

/**
 * The helper app that posts banners a click can open (mac/Switchboard.swift).
 * It ships inside the extension and runs from a copy in the extension's
 * storage folder: a path that stays the same across updates, so macOS keeps
 * one app, and one permission, for it.
 */
export class MacHelper {
  private installing?: Promise<string | undefined>;
  private readonly register: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly bundled: string,
    private readonly storageDir: string,
    options: MacHelperOptions = {},
  ) {
    this.register = options.register ?? LSREGISTER;
    this.timeoutMs = options.timeoutMs ?? HELPER_TIMEOUT_MS;
  }

  /** The installed helper's program, copied in first if it is missing or older; undefined if this build has none. */
  install(): Promise<string | undefined> {
    this.installing ??= this.doInstall().finally(() => (this.installing = undefined));
    return this.installing;
  }

  private async doInstall(): Promise<string | undefined> {
    const src = path.join(this.bundled, APP);
    const dest = path.join(this.storageDir, APP);
    const exe = path.join(dest, EXE);
    const [srcExe, srcPlist] = await Promise.all([readOrUndefined(path.join(src, EXE)), readOrUndefined(path.join(src, PLIST))]);
    if (!srcExe || !srcPlist) return undefined;
    const installed = async () => {
      const [e, p] = await Promise.all([readOrUndefined(exe), readOrUndefined(path.join(dest, PLIST))]);
      return e && p ? { plist: p.toString('utf8'), same: e.equals(srcExe) && p.equals(srcPlist) } : undefined;
    };
    if (!replacesHelper({ plist: srcPlist.toString('utf8') }, await installed())) return exe;
    // Copy beside it, then swap it in with two renames, so the app is missing
    // only between them and another window never runs half a copy.
    const tmp = `${dest}.${randomUUID()}`;
    const old = `${dest}.old.${randomUUID()}`;
    await fs.mkdir(this.storageDir, { recursive: true });
    await fs.cp(src, tmp, { recursive: true });
    await fs.chmod(path.join(tmp, EXE), 0o755);
    await fs.rename(dest, old).catch(() => undefined);
    try {
      await fs.rename(tmp, dest);
    } catch (e) {
      // Another window swapped its copy in between the renames.
      await fs.rm(tmp, { recursive: true, force: true });
      if (!(await installed())) throw e;
    }
    await fs.rm(old, { recursive: true, force: true });
    // So macOS knows which app to start when a banner is clicked after the helper has quit.
    await run(this.register, ['-f', dest]).catch(() => undefined);
    return exe;
  }

  /** Posts a banner that opens `link` when clicked. Throws with what went wrong, so the caller can fall back to osascript. */
  async post(title: string, message: string, link: string): Promise<void> {
    const exe = await this.install();
    if (!exe) throw new Error('this build has no helper app');
    await new Promise<void>((resolve, reject) => {
      execFile(exe, helperArgs(title, message, link), { timeout: this.timeoutMs }, (err, _out, stderr) => {
        if (!err) return resolve();
        if (err.killed) return reject(new Error('the helper gave no answer in time'));
        if (typeof err.code === 'number') return reject(new Error(helperFailure(err.code)));
        reject(new Error(String(stderr).trim() || err.message));
      });
    });
  }
}
