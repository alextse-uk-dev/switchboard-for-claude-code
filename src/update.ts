import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterReload, compareVersions, decide, folderVersion, newestInstalled, noticeText, obsoleteFolders, parseReloadRecord, QUIET_MS, reloadingText, updatedText, type Installed, type ReloadRecord } from './core/update';
import { message } from './source';

const NAME = 'Switchboard';
const SETTING = 'switchboard.update.reloadWindow';
/** Written just before an update's reload, read and cleared on the next start. */
const RECORD_KEY = 'switchboard.updateReload';
/** The version this window reloaded for without getting it, so it never reloads for it again. */
const TRIED_KEY = 'switchboard.updateTried';
const NOT_NOW = 'Not now';
const RELOAD_NOW = 'Reload now';
const SETTINGS = 'Settings';
/** A change in the extensions folder comes in bursts while VS Code unpacks an install. */
const DEBOUNCE_MS = 2_000;
const POLL_MS = 60_000;
/** While waiting for the window to go quiet, it looks at least this often. */
const WAIT_MS = 15_000;
const COUNTDOWN_MS = 5_000;

/** What the board knows about this window's sessions. */
export interface WindowSessions {
  /** A session in this window's terminal tabs is mid-turn, or none has been read yet. */
  midTurn(): boolean;
  /** Fires after each new look at the session list. */
  onDidChange: vscode.Event<void>;
  /** Reads the session list again. */
  refresh(): Promise<void>;
  log: vscode.LogOutputChannel;
}

/**
 * Reloads this window by itself once a newer version of the extension is
 * installed and no Claude session in its tabs is mid-turn. A reload keeps
 * the terminal tabs and the sessions in them running.
 */
export class Updates implements vscode.Disposable {
  private readonly running: string;
  private readonly id: string;
  private readonly dir: string;
  private target?: string;
  private quietSince?: number;
  /** Since when only a task or a debug session has held the reload back. */
  private blockedSince?: number;
  private tried?: string;
  private declined?: string;
  private readonly noticed = new Set<string>();
  /** A countdown or a reload is under way. */
  private reloading = false;
  private looking = false;
  private again = false;
  private disposed = false;
  private watcher?: FSWatcher;
  private debounce?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private waitTimer?: NodeJS.Timeout;
  private countdown?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly sessions: WindowSessions) {
    this.running = String(ctx.extension.packageJSON.version ?? '');
    this.id = ctx.extension.id;
    this.dir = path.dirname(ctx.extensionPath);
  }

  async start(): Promise<void> {
    // A copy run from source (F5) is never replaced by an install.
    if (this.ctx.extensionMode !== vscode.ExtensionMode.Production) return;
    await this.sayIfReloaded();
    this.tried = this.ctx.workspaceState.get<string>(TRIED_KEY);
    if (this.tried && compareVersions(this.running, this.tried) >= 0) {
      this.tried = undefined;
      await this.ctx.workspaceState.update(TRIED_KEY, undefined);
    }
    try {
      this.watcher = watch(this.dir, () => this.soon());
      this.watcher.on('error', () => undefined);
    } catch {
      // The minute poll still looks.
    }
    this.poll = setInterval(() => void this.look(false), POLL_MS);
    this.disposables.push(
      // While a newer version waits, any change to what blocks it is a reason to look again.
      this.sessions.onDidChange(() => this.lookIfWaiting()),
      vscode.debug.onDidTerminateDebugSession(() => this.lookIfWaiting()),
      vscode.tasks.onDidEndTask(() => this.lookIfWaiting()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SETTING) || e.affectsConfiguration('terminal.integrated.enablePersistentSessions')) void this.look(false);
      }),
    );
    void this.look(false);
  }

  /** After a reload this extension asked for: say that it worked, or that it didn't. */
  private async sayIfReloaded(): Promise<void> {
    const raw = this.ctx.workspaceState.get<unknown>(RECORD_KEY);
    if (raw === undefined) return;
    await this.ctx.workspaceState.update(RECORD_KEY, undefined);
    const record = parseReloadRecord(raw);
    if (!record) return;
    const r = afterReload(record, this.running);
    if (r.say === 'updated') {
      const text = updatedText(NAME, record.from, this.running);
      this.sessions.log.info(text);
      void vscode.window.showInformationMessage(text, SETTINGS).then((pick) => {
        if (pick === SETTINGS) void vscode.commands.executeCommand('workbench.action.openSettings', SETTING);
      });
      return;
    }
    // Still on the old version: never reload for this one again, only say so.
    this.sessions.log.warn(`The reload for ${NAME} ${record.to} still runs ${this.running}. It won't reload for ${record.to} again.`);
    await this.ctx.workspaceState.update(TRIED_KEY, r.tried);
    this.notice(r.tried);
  }

  private lookIfWaiting(): void {
    if (this.target) void this.look(false);
  }

  private soon(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.look(false), DEBOUNCE_MS);
  }

  /** One look at what is installed and whether the window can reload now. `fresh` reads the sessions again first. */
  private async look(fresh: boolean): Promise<void> {
    if (this.disposed || this.reloading) return;
    if (this.looking) {
      this.again = true;
      return;
    }
    this.looking = true;
    try {
      do {
        this.again = false;
        await this.lookOnce(fresh);
        fresh = false;
      } while (this.again && !this.disposed && !this.reloading);
    } catch (e) {
      this.sessions.log.warn(`Update check: ${message(e)}`);
    } finally {
      this.looking = false;
    }
  }

  private async lookOnce(fresh: boolean): Promise<void> {
    const newest = await this.newest();
    if (newest !== this.target) {
      this.target = newest;
      this.quietSince = undefined;
      this.blockedSince = undefined;
      if (newest) this.sessions.log.info(`${NAME} ${newest} is installed. This window runs ${this.running}.`);
    }
    clearTimeout(this.waitTimer);
    const target = this.target;
    if (!target || this.noticed.has(target)) return;
    if (fresh) await this.sessions.refresh();
    const now = Date.now();
    const d = decide({
      target,
      enabled: vscode.workspace.getConfiguration().get<boolean>(SETTING, true),
      persistentTerminals: vscode.workspace.getConfiguration('terminal.integrated').get<boolean>('enablePersistentSessions', true),
      tried: this.tried,
      declined: this.declined,
      midTurn: this.sessions.midTurn(),
      running: this.taskOrDebug(),
      quietSince: this.quietSince,
      blockedSince: this.blockedSince,
      now,
    });
    if (d.do === 'notice') {
      if (this.blockedSince !== undefined) this.sessions.log.info(`A task or a debug session held the reload for ${NAME} ${target} back for 10 minutes.`);
      this.notice(target);
    } else if (d.do === 'wait') {
      this.quietSince = d.quietSince;
      this.blockedSince = d.blockedSince;
      // A first quiet look is checked again as soon as it can count.
      const ms = d.quietSince === undefined ? WAIT_MS : Math.min(WAIT_MS, Math.max(0, d.quietSince + QUIET_MS - now) + 100);
      this.waitTimer = setTimeout(() => void this.look(true), ms);
    } else this.countDown(target);
  }

  /** A Claude session in this window is mid-turn, a debug session runs or a task runs. */
  private busy(): boolean {
    return this.sessions.midTurn() || this.taskOrDebug();
  }

  /** A debug session or a task runs in this window. */
  private taskOrDebug(): boolean {
    return vscode.debug.activeDebugSession !== undefined || vscode.tasks.taskExecutions.length > 0;
  }

  /** The newest installed version above the running one, if any. */
  private async newest(): Promise<string | undefined> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const mine = names.filter((n) => folderVersion(n, this.id) !== undefined);
    if (!mine.length) return undefined;
    const folders: Installed[] = await Promise.all(
      mine.map(async (name) => ({ name, hasPackage: await fs.stat(path.join(this.dir, name, 'package.json')).then((s) => s.isFile(), () => false) })),
    );
    const obsolete = obsoleteFolders(await fs.readFile(path.join(this.dir, '.obsolete'), 'utf8').catch(() => undefined));
    return newestInstalled({ id: this.id, running: this.running, folders, obsolete })?.version;
  }

  /** A 5-second notice that needs no click, then the reload. "Not now" stops it. */
  private countDown(target: string): void {
    this.reloading = true;
    void vscode.window.showInformationMessage(reloadingText(NAME, target), NOT_NOW).then((pick) => {
      if (pick !== NOT_NOW || !this.countdown) return;
      clearTimeout(this.countdown);
      this.countdown = undefined;
      this.reloading = false;
      this.declined = target;
      this.sessions.log.info(`Not reloading for ${NAME} ${target}: you chose Not now.`);
      this.notice(target);
    });
    this.countdown = setTimeout(() => {
      this.countdown = undefined;
      void this.reload(target);
    }, COUNTDOWN_MS);
  }

  private async reload(target: string): Promise<void> {
    if (this.disposed) return;
    // Something started during the countdown: wait again.
    if (this.busy()) {
      this.sessions.log.info(`Not reloading for ${NAME} ${target} yet: something started during the countdown.`);
      this.reloading = false;
      this.quietSince = undefined;
      void this.look(false);
      return;
    }
    const record: ReloadRecord = { from: this.running, to: target, at: Date.now() };
    try {
      await this.ctx.workspaceState.update(RECORD_KEY, record);
      this.sessions.log.info(`Reloading this window for ${NAME} ${target}.`);
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (e) {
      this.sessions.log.warn(`Could not reload this window: ${message(e)}`);
      await this.ctx.workspaceState.update(RECORD_KEY, undefined).then(undefined, () => undefined);
      this.reloading = false;
      this.notice(target);
    }
  }

  /** "Reload this window to use it", once per version per window. */
  private notice(target: string): void {
    if (this.noticed.has(target)) return;
    this.noticed.add(target);
    clearTimeout(this.waitTimer);
    this.sessions.log.info(`${NAME} ${target} is installed. Reload this window to use it.`);
    void vscode.window.showInformationMessage(noticeText(NAME, target), RELOAD_NOW).then((pick) => {
      if (pick === RELOAD_NOW) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    clearTimeout(this.waitTimer);
    clearTimeout(this.countdown);
    this.watcher?.close();
    for (const d of this.disposables) d.dispose();
  }
}
