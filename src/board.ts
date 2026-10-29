import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Card } from './core/card';
import { asMessage, type FromBoard, type TodoView } from './core/messages';
import { GROUP_LABEL, GROUP_ORDER } from './core/types';

export type { FromBoard, TodoView };

/**
 * The sidebar board: a webview that draws the cards. It holds no state of
 * its own beyond the last cards, which it sends again whenever the page
 * (re)loads; the page keeps only which sections are folded.
 */
export class BoardView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private cards: readonly Card[] = [];
  private todos: readonly TodoView[] = [];
  private badge?: vscode.ViewBadge;
  private readonly shown = new vscode.EventEmitter<void>();
  /** Fires when the board comes into view. */
  readonly onDidShow = this.shown.event;
  private readonly resized = new vscode.EventEmitter<number>();
  /** Fires with the board's width in pixels when it is drawn and whenever it changes. */
  readonly onDidResize = this.resized.event;
  /** The board's width as the page last reported it, while it is visible. */
  width?: number;

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
      else if (m?.type === 'width') {
        this.width = m.px;
        this.resized.fire(m.px);
      } else if (m) this.onMessage(m);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.shown.fire();
      else this.width = undefined;
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.shown.fire();
  }

  set(cards: readonly Card[], todos: readonly TodoView[], badge: vscode.ViewBadge | undefined): void {
    this.cards = cards;
    this.todos = todos;
    this.badge = badge;
    if (!this.view) return;
    this.view.badge = badge;
    this.post();
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: 'state', cards: this.cards, todos: this.todos, order: GROUP_ORDER, labels: GROUP_LABEL });
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
    this.resized.dispose();
  }
}
