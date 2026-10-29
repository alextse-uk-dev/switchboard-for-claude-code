import { execFile } from 'node:child_process';
import { bannerArgs } from './core/alert';

const RUN_TIMEOUT_MS = 10_000;

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve();
    });
  });
}

/** Shows a macOS notification banner. Throws with what went wrong. */
export function showBanner(title: string, message: string): Promise<void> {
  return run('/usr/bin/osascript', bannerArgs(title, message));
}

/** Plays a sound file, e.g. one of /System/Library/Sounds. Throws with what went wrong. */
export function playSound(file: string): Promise<void> {
  return run('/usr/bin/afplay', [file]);
}
