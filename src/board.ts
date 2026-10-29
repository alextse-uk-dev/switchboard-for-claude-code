import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Card } from './core/card';
import { GROUP_LABEL, GROUP_ORDER } from './core/types';

/** What the board's page can ask for. Each action names a card by its key. */
export type FromBoard =
  | { type: 'open' | 'seen' | 'next' | 'copy'; key: string }
  | { type: 'new' };

const ACTIONS: ReadonlySet<string> = new Set(['open', 'seen', 'next', 'copy']);

/** Accepts only the messages the page is meant to send. */
function asMessage(m: unknown): FromBoard | 'ready' | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const r = m as Record<string, unknown>;
  if (r.type === 'ready') return 'ready';
  if (r.type === 'new') return { type: 'new' };
  if (typeof r.type === 'string' && ACTIONS.has(r.type) && typeof r.key === 'string') {
    return { type: r.type as 'open', key: r.key };
  }
  return undefined;
}

/**
 * The sidebar board: a webview that draws the cards. It holds no state of
 * its own beyond the last cards, which it sends again whenever the page
 * (re)loads; the page keeps only which sections are folded.
 */
export class BoardView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private cards: readonly Card[] = [];
  private badge?: vscode.ViewBadge;
  private readonly shown = new vscode.EventEmitter<void>();
  /** Fires when the board comes into view. */
  readonly onDidShow = this.shown.event;

  constructor(
    private readonly media: vscode.Uri,
    private readonly onMessage: (m: FromBoard) => void,
  ) {}

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    view.webview.html = this.html(view.webview);
    view.badge = this.badge;
    view.webview.onDidReceiveMessage((raw) => {
      const m = asMessage(raw);
      if (m === 'ready') this.post();
      else if (m) this.onMessage(m);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.shown.fire();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.shown.fire();
  }

  set(cards: readonly Card[], badge: vscode.ViewBadge | undefined): void {
    this.cards = cards;
    this.badge = badge;
    if (!this.view) return;
    this.view.badge = badge;
    this.post();
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: 'state', cards: this.cards, order: GROUP_ORDER, labels: GROUP_LABEL });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.media, file)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('board.css')}">
<title>Switchboard</title>
</head>
<body>
<main id="board"></main>
<script nonce="${nonce}" src="${uri('board.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.shown.dispose();
  }
}
