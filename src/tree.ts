import * as path from 'node:path';
import * as vscode from 'vscode';
import { compareInGroup, formatAge, waitingLabel } from './core/model';
import { GROUP_LABEL, GROUP_ORDER, keyOf, type Group, type Session } from './core/types';

/** Where a session's terminal is, seen from this window. */
export type Where = 'here' | 'elsewhere' | 'outside';

export interface Row {
  s: Session;
  title: string;
  group: Group;
  changedAt?: number;
  where: Where;
  terminal?: vscode.Terminal;
}

export type Node = { kind: 'group'; group: Group; rows: Row[] } | { kind: 'row'; row: Row };

const ICON: Record<Group, vscode.ThemeIcon> = {
  needs: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground')),
  finished: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')),
  working: new vscode.ThemeIcon('loading~spin'),
  idle: new vscode.ThemeIcon('circle-outline'),
  background: new vscode.ThemeIcon('server-process'),
};

function stateWord(r: Row): string {
  switch (r.group) {
    case 'needs':
      return waitingLabel(r.s.waitingFor);
    case 'finished':
      return 'finished';
    case 'working':
      return 'working';
    default:
      if (r.s.status === 'unknown') return 'status unknown';
      return r.s.status === 'busy' ? 'working' : 'idle';
  }
}

function whereWord(r: Row): string | undefined {
  if (r.s.kind === 'background') return r.group === 'background' ? undefined : 'background';
  if (r.where === 'elsewhere') return 'other window';
  if (r.where === 'outside') return 'outside VS Code';
  return undefined;
}

export function describe(r: Row, now: number): string {
  const parts = [path.basename(r.s.cwd), stateWord(r)];
  if (r.changedAt !== undefined) parts.push(formatAge(now - r.changedAt));
  const where = whereWord(r);
  if (where) parts.push(where);
  return parts.join(' · ');
}

function tooltip(r: Row, now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${escapeMd(r.title)}**\n\n`);
  md.appendMarkdown(`${escapeMd(describe(r, now))}\n\n`);
  md.appendMarkdown(`Folder: \`${r.s.cwd}\`  \nName: \`${r.s.name}\`  \nSession: \`${r.s.sessionId}\`  \npid ${r.s.pid}`);
  if (r.where === 'here' && r.terminal) md.appendMarkdown(`  \nTab: ${escapeMd(r.terminal.name)}`);
  return md;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export class SessionTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private groups: Node[] = [];

  set(rows: readonly Row[]): void {
    this.groups = GROUP_ORDER.flatMap((group): Node[] => {
      const mine = rows
        .filter((r) => r.group === group)
        .sort((a, b) => compareInGroup(group, a.changedAt ?? a.s.startedAt, b.changedAt ?? b.s.startedAt));
      return mine.length ? [{ kind: 'group', group, rows: mine }] : [];
    });
    this.changed.fire(undefined);
  }

  getChildren(n?: Node): Node[] {
    if (!n) return this.groups;
    return n.kind === 'group' ? n.rows.map((row): Node => ({ kind: 'row', row })) : [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'group') {
      const item = new vscode.TreeItem(GROUP_LABEL[n.group], vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${n.group}`;
      item.description = String(n.rows.length);
      item.contextValue = `group.${n.group}`;
      return item;
    }
    const r = n.row;
    const now = Date.now();
    const item = new vscode.TreeItem(r.title, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${keyOf(r.s)}`;
    item.description = describe(r, now);
    item.tooltip = tooltip(r, now);
    item.iconPath = ICON[r.group];
    item.contextValue = `session.${r.group}.${r.s.kind}`;
    item.command = { command: 'switchboard.open', title: 'Open Session', arguments: [keyOf(r.s)] };
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
