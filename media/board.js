// The Switchboard board. Draws the cards the extension sends; every action
// goes back to the extension as a message. Text is only ever set with
// textContent, never parsed as HTML: titles and replies come from transcripts.
// @ts-check
(function () {
  // @ts-ignore: provided by VS Code inside a webview.
  const vscode = acquireVsCodeApi();
  const board = /** @type {HTMLElement} */ (document.getElementById('board'));
  /** @type {{ folded: Record<string, boolean> }} */
  const ui = Object.assign({ folded: {} }, vscode.getState());
  /** @type {any} */
  let state;

  /** The summary pill's words for n sessions in a section. @type {Record<string, (n: number) => string>} */
  const SHORT = {
    needs: (n) => (n === 1 ? 'needs you' : 'need you'),
    reply: () => 'to reply',
    handoff: (n) => (n === 1 ? 'new session' : 'new sessions'),
    stopped: () => 'stopped',
    done: () => 'done',
    working: () => 'working',
    idle: () => 'idle',
  };
  const FOLDER = ['M1.8 4.3c0-.6.4-1 1-1h3.1l1.5 1.6h5.8c.6 0 1 .4 1 1v6.3c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z'];

  /** 16×16 line icons, drawn in the section's colour. */
  const ICON = {
    needs: ['M8 2a3.6 3.6 0 0 0-3.6 3.6v2.6L3 10.6h10l-1.4-2.4V5.6A3.6 3.6 0 0 0 8 2z', 'M6.6 12.6a1.5 1.5 0 0 0 2.8 0'],
    reply: ['M2.5 3.5h11v7.2H8.2L5 13.2v-2.5H2.5z', 'M6.6 5.9a1.4 1.4 0 1 1 2 1.3c-.4.2-.6.5-.6.9', 'M8 9.4v.01'],
    handoff: ['M2.5 8h7.5', 'M7 4.8 10.2 8 7 11.2', 'M13 3v10'],
    stopped: ['M5.6 2.5h4.8l3.1 3.1v4.8l-3.1 3.1H5.6l-3.1-3.1V5.6z', 'M6 6l4 4M10 6l-4 4'],
    done: ['M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2z', 'M5.3 8.2l1.9 1.9 3.6-3.8'],
    working: ['M8 2.2a5.8 5.8 0 1 0 5.8 5.8'],
    idle: ['M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2z'],
  };

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
  setInterval(() => state && updateAges(), 30_000);

  /** @param {string} tag @param {string} [cls] @param {string} [text] */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /** @param {string} group */
  function icon(group) {
    return svgOf(ICON[group] || ICON.idle, 'glyph');
  }

  /** @param {string[]} paths @param {string} cls */
  function svgOf(paths, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add(cls);
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  /** "just now", "4 min", "1 h 5 min", "2 d": the same rules as the status bar. @param {number} ms */
  function age(ms) {
    const min = Math.floor(ms / 60000);
    if (ms < 45000) return 'just now';
    if (min < 1) return '1 min';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
    return `${Math.floor(h / 24)} d`;
  }

  /** @param {number} n */
  function tokens(n) {
    if (n < 1000) return String(n);
    return n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
  }

  function updateAges() {
    const now = Date.now();
    for (const n of board.querySelectorAll('[data-at]')) {
      n.textContent = age(now - Number(/** @type {HTMLElement} */ (n).dataset.at));
    }
  }

  /** @param {object} m */
  function send(m) {
    vscode.postMessage(m);
  }

  /** @param {string} label @param {string} cls @param {() => void} run @param {string} [title] */
  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
    });
    b.addEventListener('keydown', (e) => e.stopPropagation());
    return b;
  }

  function render() {
    const focusKey = /** @type {HTMLElement | null} */ (document.activeElement)?.closest?.('[data-key]')?.getAttribute('data-key');
    const cards = /** @type {any[]} */ (state.cards);
    const order = /** @type {string[]} */ (state.order);
    board.replaceChildren();

    if (!cards.length) {
      const empty = el('div', 'empty');
      empty.append(icon('idle'), el('p', 'empty-title', 'No Claude Code sessions are running.'));
      empty.append(el('p', 'empty-hint', 'Start one here, or run claude in any terminal: it shows up on its own.'));
      empty.append(button('New session', 'btn primary', () => send({ type: 'new' })));
      board.append(empty);
      return;
    }

    const groups = order.map((g) => ({ g, mine: cards.filter((c) => c.group === g) })).filter((x) => x.mine.length);

    const summary = el('nav', 'summary');
    summary.setAttribute('aria-label', 'Sessions by state');
    for (const { g, mine } of groups) {
      const pill = button('', `pill g-${g}`, () => {
        ui.folded[g] = false;
        vscode.setState(ui);
        render();
        document.getElementById(`group-${g}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      const unread = mine.filter((c) => c.unread).length;
      pill.append(el('span', 'dot'), el('span', 'n', String(mine.length)), el('span', '', SHORT[g](mine.length)));
      if (unread) pill.classList.add('has-unread');
      pill.title = `${state.labels[g]}: ${mine.map((c) => c.title).join(', ')}`;
      summary.append(pill);
    }
    board.append(summary);

    const now = Date.now();
    for (const { g, mine } of groups) {
      const section = el('section', `group g-${g}`);
      section.id = `group-${g}`;
      const folded = !!ui.folded[g];
      const head = button('', 'group-head', () => {
        ui.folded[g] = !folded;
        vscode.setState(ui);
        render();
      });
      head.setAttribute('aria-expanded', String(!folded));
      head.append(el('span', `chev${folded ? ' folded' : ''}`), icon(g), el('span', 'group-label', state.labels[g]), el('span', 'count', String(mine.length)));
      section.append(head);
      if (!folded) {
        const list = el('div', 'cards');
        list.setAttribute('role', 'list');
        for (const c of mine) list.append(card(c, now));
        section.append(list);
      }
      board.append(section);
    }

    if (focusKey) /** @type {HTMLElement | null} */ (board.querySelector(`[data-key="${CSS.escape(focusKey)}"]`))?.focus();
  }

  /** @param {any} c @param {number} now */
  function card(c, now) {
    const n = el('div', `card g-${c.group}${c.unread ? ' unread' : ''}`);
    n.dataset.key = c.key;
    n.tabIndex = 0;
    n.setAttribute('role', 'listitem');
    n.title = [...c.tip, 'Click to open'].join('\n');
    n.setAttribute('aria-label', `${c.title}. ${state.labels[c.group]}: ${c.state}.${c.unread ? ' New.' : ''}`);
    n.addEventListener('click', () => send({ type: 'open', key: c.key }));
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        send({ type: 'open', key: c.key });
      }
    });

    const top = el('div', 'top');
    top.append(icon(c.group));
    const title = el('span', 'title', c.title);
    top.append(title);
    if (c.unread) {
      const seen = button('', 'seen', () => send({ type: 'seen', key: c.key }), 'Mark as read');
      seen.setAttribute('aria-label', 'Mark as read');
      seen.append(svgOf(['M3.5 8.4l2.9 2.9 6.1-6.6'], 'tick'));
      top.append(seen);
    }
    if (c.changedAt) {
      const a = el('span', 'age', age(now - c.changedAt));
      a.dataset.at = String(c.changedAt);
      top.append(a);
    }
    n.append(top);

    const meta = el('div', 'meta');
    const folder = el('span', 'folder', c.folder);
    folder.prepend(svgOf(FOLDER, 'fold'));
    meta.append(el('span', 'state', c.state), folder);
    for (const chip of c.chips) meta.append(el('span', 'chip', chip));
    if (c.tokens !== undefined) {
      const ctx = el('span', 'ctx');
      const ratio = c.freshTokens > 0 ? c.tokens / c.freshTokens : 0;
      ctx.classList.add(ratio >= 1 ? 'high' : ratio >= 0.7 ? 'mid' : 'low');
      const bar = el('span', 'bar');
      const fill = el('i');
      fill.style.setProperty('--fill', `${Math.min(100, Math.round(ratio * 100))}%`);
      bar.append(fill);
      if (c.freshTokens > 0) ctx.append(bar);
      ctx.append(el('span', '', tokens(c.tokens)));
      ctx.title = c.freshTokens > 0 ? `Context: ${c.tokens.toLocaleString()} tokens. A new session is suggested from ${tokens(c.freshTokens)}.` : `Context: ${c.tokens.toLocaleString()} tokens.`;
      meta.append(ctx);
    } else if (c.compacted) {
      meta.append(el('span', 'chip', 'compacted'));
    }
    n.append(meta);

    if (c.detail) n.append(el('div', `detail${c.quote ? ' quote' : ''}`, c.detail));

    if (c.group === 'handoff') {
      const actions = el('div', 'actions');
      actions.append(
        button('Start next session', 'btn primary', () => send({ type: 'next', key: c.key }),
          c.prompt ? 'Open a new session in this folder, with the kickoff prompt as its first message' : 'Open a new session in this folder'),
      );
      if (c.prompt) actions.append(button('Copy prompt', 'btn', () => send({ type: 'copy', key: c.key }), 'Copy the kickoff prompt'));
      n.append(actions);
    }
    return n;
  }
})();
