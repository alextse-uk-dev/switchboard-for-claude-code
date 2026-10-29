// The Switchboard board. Draws the cards the extension sends; every action
// goes back to the extension as a message. Text is only ever set with
// textContent, never parsed as HTML: titles and replies come from transcripts.
// @ts-check
(function () {
  // @ts-ignore: provided by VS Code inside a webview.
  const vscode = acquireVsCodeApi();
  const board = /** @type {HTMLElement} */ (document.getElementById('board'));
  /** Folded sections, cards whose whole reply is open, and whether done to-dos show. */
  /** @type {{ folded: Record<string, boolean>, open: Record<string, boolean>, showDone: boolean }} */
  const ui = Object.assign({ folded: {}, open: {}, showDone: false }, vscode.getState());
  /** @type {any} */
  let state;
  /** The add-a-to-do field is made once, so a redraw keeps what is being typed. */
  const addInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
  addInput.type = 'text';
  addInput.className = 'todo-input';
  addInput.placeholder = 'Add a to-do…';
  addInput.setAttribute('aria-label', 'Add a to-do');
  addInput.maxLength = 10000;
  // A redraw moves the field, which would end a word being typed with an
  // input method (Cantonese, Japanese, …). So while something is being typed
  // in it, redraws wait until it loses focus.
  let composing = false;
  let redrawLater = false;
  addInput.addEventListener('compositionstart', () => (composing = true));
  addInput.addEventListener('compositionend', () => (composing = false));
  addInput.addEventListener('blur', () => {
    if (redrawLater) {
      redrawLater = false;
      render();
    }
  });
  addInput.addEventListener('keydown', (e) => {
    if (e.isComposing || composing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      addTodo();
    } else if (e.key === 'Escape') {
      addInput.value = '';
    }
  });

  /** The summary pill's words for n sessions in a section. @type {Record<string, (n: number) => string>} */
  const SHORT = {
    todo: () => 'to do',
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
    todo: ['M2.8 3.2h2.4v2.4H2.8z', 'M7.4 4.4h5.8', 'M2.8 10.4h2.4v2.4H2.8z', 'M7.4 11.6h5.8', 'M3.3 8.1l.9.9 1.6-1.8'],
    needs: ['M8 2a3.6 3.6 0 0 0-3.6 3.6v2.6L3 10.6h10l-1.4-2.4V5.6A3.6 3.6 0 0 0 8 2z', 'M6.6 12.6a1.5 1.5 0 0 0 2.8 0'],
    reply: ['M2.5 3.5h11v7.2H8.2L5 13.2v-2.5H2.5z', 'M6.6 5.9a1.4 1.4 0 1 1 2 1.3c-.4.2-.6.5-.6.9', 'M8 9.4v.01'],
    handoff: ['M2.5 8h7.5', 'M7 4.8 10.2 8 7 11.2', 'M13 3v10'],
    stopped: ['M5.6 2.5h4.8l3.1 3.1v4.8l-3.1 3.1H5.6l-3.1-3.1V5.6z', 'M6 6l4 4M10 6l-4 4'],
    done: ['M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2z', 'M5.3 8.2l1.9 1.9 3.6-3.8'],
    working: ['M8 2.2a5.8 5.8 0 1 0 5.8 5.8'],
    idle: ['M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2z'],
  };

  let lastState = '';
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'state') return;
    // Ages tick on their own, so a state that hasn't changed needs no redraw.
    const json = JSON.stringify(e.data);
    if (json === lastState) return;
    lastState = json;
    state = e.data;
    if ((document.activeElement === addInput && (composing || addInput.value)) || selecting()) redrawLater = true;
    else render();
  });

  /** Text selected on the board (in a reply, say), which a redraw would lose. */
  function selecting() {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && !!sel.anchorNode && board.contains(sel.anchorNode);
  }
  document.addEventListener('selectionchange', () => {
    if (redrawLater && !selecting() && !(document.activeElement === addInput && (composing || addInput.value))) {
      redrawLater = false;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
  setInterval(() => state && updateAges(), 30_000);

  // The extension sets the side bar's default width from what the page measures.
  let sentWidth = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let widthTimer;
  new ResizeObserver(() => {
    clearTimeout(widthTimer);
    widthTimer = setTimeout(() => {
      const px = document.documentElement.clientWidth;
      if (px > 0 && px !== sentWidth) {
        sentWidth = px;
        vscode.postMessage({ type: 'width', px });
      }
    }, 150);
  }).observe(document.documentElement);

  function addTodo() {
    const text = addInput.value.trim();
    if (!text) return;
    addInput.value = '';
    vscode.postMessage({ type: 'todoAdd', text });
    if (redrawLater) {
      redrawLater = false;
      render();
    }
  }

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
    redrawLater = false;
    // Every control that can hold focus has a data-focus name, so focus comes back to it after the redraw.
    const focusName = /** @type {HTMLElement | null} */ (document.activeElement)?.closest?.('[data-focus]')?.getAttribute('data-focus');
    const typing = document.activeElement === addInput;
    const sel = [addInput.selectionStart, addInput.selectionEnd];
    const cards = /** @type {any[]} */ (state.cards);
    const todos = /** @type {any[]} */ (state.todos || []);
    const order = /** @type {string[]} */ (state.order);
    board.replaceChildren();

    const groups = order.map((g) => ({ g, mine: cards.filter((c) => c.group === g) })).filter((x) => x.mine.length);
    const openTodos = todos.filter((t) => !t.doneAt);

    const summary = el('nav', 'summary');
    summary.setAttribute('aria-label', 'Sessions by state');
    const pills = [{ g: 'todo', n: openTodos.length, unread: 0, tip: `To do: ${openTodos.length} open` }];
    for (const { g, mine } of groups) {
      pills.push({ g, n: mine.length, unread: mine.filter((c) => c.unread).length, tip: `${state.labels[g]}: ${mine.map((c) => c.title).join(', ')}` });
    }
    for (const p of pills) {
      if (p.g === 'todo' && !p.n) continue;
      const pill = named(button('', `pill g-${p.g}`, () => {
        ui.folded[p.g] = false;
        vscode.setState(ui);
        render();
        document.getElementById(`group-${p.g}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }), `pill:${p.g}`);
      pill.append(el('span', 'dot'), el('span', 'n', String(p.n)), el('span', '', SHORT[p.g](p.n)));
      if (p.unread) pill.classList.add('has-unread');
      pill.title = p.tip;
      summary.append(pill);
    }
    if (summary.childElementCount) board.append(summary);

    board.append(todoSection(todos, openTodos));

    if (!cards.length) {
      const empty = el('div', 'empty');
      empty.append(icon('idle'), el('p', 'empty-title', 'No Claude Code sessions are running.'));
      empty.append(el('p', 'empty-hint', 'Start one here, or run claude in any terminal: it shows up on its own.'));
      empty.append(named(button('New session', 'btn primary', () => send({ type: 'new' })), 'new'));
      board.append(empty);
    }

    const now = Date.now();
    for (const { g, mine } of groups) {
      const { section, folded } = sectionOf(g, state.labels[g], mine.length);
      if (!folded) {
        const list = el('div', 'cards');
        list.setAttribute('role', 'list');
        for (const c of mine) list.append(card(c, now));
        section.append(list);
      }
      board.append(section);
    }

    if (typing) {
      addInput.focus();
      addInput.setSelectionRange(sel[0], sel[1]);
    } else if (focusName) /** @type {HTMLElement | null} */ (board.querySelector(`[data-focus="${CSS.escape(focusName)}"]`))?.focus();
  }

  /** @template {HTMLElement} T @param {T} node @param {string} name @returns {T} */
  function named(node, name) {
    node.dataset.focus = name;
    return node;
  }

  /** A section with its foldable head. @param {string} g @param {string} label @param {number} count */
  function sectionOf(g, label, count) {
    const section = el('section', `group g-${g}`);
    section.id = `group-${g}`;
    const folded = !!ui.folded[g];
    const head = named(button('', 'group-head', () => {
      ui.folded[g] = !folded;
      vscode.setState(ui);
      render();
    }), `group:${g}`);
    head.setAttribute('aria-expanded', String(!folded));
    head.append(el('span', `chev${folded ? ' folded' : ''}`), icon(g), el('span', 'group-label', label), el('span', 'count', String(count)));
    section.append(head);
    return { section, folded };
  }

  /** The user's to-do list: open items, the add field, then the done ones (folded). @param {any[]} todos @param {any[]} open */
  function todoSection(todos, open) {
    const { section, folded } = sectionOf('todo', 'To do', open.length);
    if (folded) return section;
    const list = el('div', 'todos');
    list.setAttribute('role', 'list');
    const now = Date.now();
    if (!open.length) list.append(el('p', 'todo-empty', 'Nothing to do. When Claude writes "Needs you: …" in a reply, it lands here. You can add your own too.'));
    for (const t of open) list.append(todoRow(t, now));
    const add = el('div', 'todo-add');
    add.append(addInput, named(button('Add', 'btn', addTodo, 'Add to your to-do list'), 'todo:add'));
    list.append(add);
    const done = todos.filter((t) => t.doneAt);
    if (done.length) {
      const bar = el('div', 'todo-donebar');
      const toggle = named(button(`${ui.showDone ? 'Hide' : 'Show'} done (${done.length})`, 'link', () => {
        ui.showDone = !ui.showDone;
        vscode.setState(ui);
        render();
      }), 'todo:showDone');
      toggle.setAttribute('aria-expanded', String(!!ui.showDone));
      bar.append(toggle, named(button('Clear done', 'link', () => send({ type: 'todoClear' }), 'Remove the done items'), 'todo:clear'));
      list.append(bar);
      if (ui.showDone) for (const t of done) list.append(todoRow(t, now));
    }
    section.append(list);
    return section;
  }

  /** @param {any} t @param {number} now */
  function todoRow(t, now) {
    const done = !!t.doneAt;
    const row = el('div', `todo${done ? ' done' : ''}`);
    row.setAttribute('role', 'listitem');
    const check = named(button('', 'check', () => send({ type: 'todoDone', id: t.id, done: !done }), done ? 'Mark as not done' : 'Mark as done'), `todo:${t.id}:check`);
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(done));
    check.setAttribute('aria-label', t.text);
    check.append(svgOf(done ? ['M2.5 2.5h11v11h-11z', 'M5 8.2l2 2 4-4.4'] : ['M2.5 2.5h11v11h-11z'], 'box'));
    const body = el('div', 'todo-body');
    body.append(el('div', 'todo-text', t.text));
    const meta = el('div', 'todo-meta');
    if (t.from === 'claude') meta.append(el('span', 'by', 'asked by'));
    if (t.session) {
      if (t.key) {
        meta.append(named(button(t.session, 'from link', () => send({ type: 'open', key: t.key }), 'Open this session'), `todo:${t.id}:from`));
      } else {
        const gone = el('span', 'from gone', t.session);
        gone.title = 'This session has ended';
        meta.append(gone);
      }
    } else if (t.from === 'you') {
      meta.append(el('span', 'by', 'your note'));
    }
    const a = el('span', 'age', age(now - (t.doneAt || t.createdAt)));
    a.dataset.at = String(t.doneAt || t.createdAt);
    meta.append(a);
    body.append(meta);
    const del = named(button('', 'x', () => send({ type: 'todoDelete', id: t.id }), 'Delete'), `todo:${t.id}:x`);
    del.setAttribute('aria-label', `Delete: ${t.text}`);
    del.append(svgOf(['M4.5 4.5l7 7M11.5 4.5l-7 7'], 'tick'));
    row.append(check, body, del);
    return row;
  }

  /** @param {any} c @param {number} now */
  function card(c, now) {
    const n = named(el('div', `card g-${c.group}${c.unread ? ' unread' : ''}`), `card:${c.key}`);
    n.dataset.key = c.key;
    n.tabIndex = 0;
    n.setAttribute('role', 'listitem');
    n.title = [...c.tip, 'Click to open'].join('\n');
    n.setAttribute('aria-label', `${c.title}. ${state.labels[c.group]}: ${c.state}.${c.unread ? ' New.' : ''}`);
    n.addEventListener('click', () => {
      // The end of a drag that selected text is not a click on the card.
      if (selecting()) return;
      send({ type: 'open', key: c.key });
    });
    n.addEventListener('keydown', (e) => {
      if (e.target === n && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        send({ type: 'open', key: c.key });
      }
    });

    const top = el('div', 'top');
    top.append(icon(c.group));
    top.append(el('span', 'title', c.title));
    const tools = el('span', 'tools');
    const todo = named(button('', 'tool', () => send({ type: 'todo', key: c.key }), 'Add what this card says to your to-do list'), `card:${c.key}:todo`);
    todo.setAttribute('aria-label', 'Add to my to-do list');
    todo.append(svgOf(ICON.todo, 'tick'));
    tools.append(todo);
    if (c.unread) {
      const seen = named(button('', 'tool', () => send({ type: 'seen', key: c.key }), 'Mark as read'), `card:${c.key}:seen`);
      seen.setAttribute('aria-label', 'Mark as read');
      seen.append(svgOf(['M3.5 8.4l2.9 2.9 6.1-6.6'], 'tick'));
      tools.append(seen);
    }
    top.append(tools);
    if (c.changedAt) {
      const a = el('span', 'age', age(now - c.changedAt));
      a.dataset.at = String(c.changedAt);
      top.append(a);
    }
    n.append(top);

    const meta = el('div', 'meta');
    const folder = el('span', 'folder', c.cwd);
    folder.prepend(svgOf(FOLDER, 'fold'));
    meta.append(el('span', 'state', c.state), folder);
    for (const chip of c.chips) meta.append(el('span', 'chip', chip));
    n.append(meta);

    const stats = el('div', 'stats');
    if (c.tokens !== undefined) {
      const ctx = el('span', 'ctx');
      const ratio = c.freshTokens > 0 ? c.tokens / c.freshTokens : 0;
      ctx.classList.add(ratio >= 1 ? 'high' : ratio >= 0.7 ? 'mid' : 'low');
      if (c.freshTokens > 0) {
        const bar = el('span', 'bar');
        const fill = el('i');
        fill.style.setProperty('--fill', `${Math.min(100, Math.round(ratio * 100))}%`);
        bar.append(fill);
        ctx.append(bar);
      }
      ctx.append(el('span', 'k', 'Context'), el('span', 'v', tokens(c.tokens)));
      ctx.title = c.freshTokens > 0 ? `Context: ${c.tokens.toLocaleString()} tokens. A new session is suggested from ${tokens(c.freshTokens)}.` : `Context: ${c.tokens.toLocaleString()} tokens.`;
      stats.append(ctx);
    } else if (c.compacted) {
      stats.append(el('span', 'chip', 'compacted'));
    }
    if (c.cost) {
      const cost = el('span', 'cost');
      cost.append(el('span', 'k', 'Cost'), el('span', 'v', c.cost));
      cost.title = c.costTip.join('\n');
      stats.append(cost);
    }
    if (c.model) stats.append(el('span', 'model', c.model));
    if (stats.childElementCount) n.append(stats);

    if (c.detail) n.append(el('div', `detail${c.quote ? ' quote' : ''}`, c.detail));

    if (c.reply) {
      const open = !!ui.open[c.key];
      const more = named(button(open ? 'Hide the whole reply' : 'Show the whole reply', 'link more', () => {
        if (open) delete ui.open[c.key];
        else ui.open[c.key] = true;
        vscode.setState(ui);
        render();
      }), `card:${c.key}:more`);
      more.setAttribute('aria-expanded', String(open));
      n.append(more);
      if (open) {
        const full = el('div', 'reply');
        full.append(markdown(c.reply));
        // Selecting text in the reply must not open the tab.
        full.addEventListener('click', (e) => e.stopPropagation());
        n.append(full);
      }
    }

    if (c.group === 'handoff') {
      const actions = el('div', 'actions');
      actions.append(
        named(button('Start next session', 'btn primary', () => send({ type: 'next', key: c.key }),
          c.prompt ? 'Open a new session in this folder, with the kickoff prompt as its first message' : 'Open a new session in this folder'), `card:${c.key}:next`),
      );
      if (c.prompt) actions.append(named(button('Copy prompt', 'btn', () => send({ type: 'copy', key: c.key }), 'Copy the kickoff prompt'), `card:${c.key}:copy`));
      n.append(actions);
    }
    return n;
  }

  /**
   * A small markdown reader for Claude's replies: headings, lists, quotes,
   * tables, code blocks, bold, italics and inline code. Everything is set as
   * text; links show their words only.
   * @param {string} md
   */
  function markdown(md) {
    const out = document.createDocumentFragment();
    const lines = md.replace(/\r/g, '').split('\n');
    /** @type {string[]} */
    let para = [];
    const flush = () => {
      if (para.length) out.append(inline(el('p'), para.join(' ')));
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        flush();
        const body = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
        const pre = el('pre');
        pre.append(el('code', '', body.join('\n')));
        out.append(pre);
        continue;
      }
      if (/^\s*\|/.test(line)) {
        flush();
        const rows = [];
        for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);
        i--;
        out.append(table(rows));
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        flush();
        out.append(inline(el('div', 'md-h'), h[1]));
        continue;
      }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flush();
        const item = inline(el('div', 'md-li'), li[3]);
        item.dataset.mark = /\d/.test(li[2]) ? li[2] : '•';
        item.style.setProperty('--indent', String(Math.min(4, Math.floor(li[1].length / 2))));
        out.append(item);
        continue;
      }
      const q = /^\s*>\s?(.*)$/.exec(line);
      if (q) {
        flush();
        out.append(inline(el('blockquote'), q[1]));
        continue;
      }
      para.push(line.trim());
    }
    flush();
    return out;
  }

  /** @param {string[]} rows */
  function table(rows) {
    const wrap = el('div', 'md-table');
    const t = el('table');
    const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    rows.forEach((r, i) => {
      if (/^\s*\|?\s*:?-{2,}/.test(r) && /^[\s|:-]+$/.test(r)) return;
      const tr = el('tr');
      for (const c of cells(r)) tr.append(inline(el(i === 0 ? 'th' : 'td'), c));
      t.append(tr);
    });
    wrap.append(t);
    return wrap;
  }

  /** Fills a node with one line of markdown: **bold**, *italics*, `code`, [links](…) as words. @param {HTMLElement} node @param {string} text */
  function inline(node, text) {
    // Emphasis is not looked for in very long lines: the pattern would be slow there.
    if (text.length > 4000) {
      node.append(text);
      return node;
    }
    // Single underscores stay as they are: they are far more often in names (file_name) than italics.
    const re = /(\*\*|__)(\S(?:.*?\S)?)\1|`([^`]+)`|!?\[([^\]]*)\]\([^)]*\)|(\*)(\S(?:.*?\S)?)\5/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) node.append(text.slice(last, m.index));
      if (m[2] !== undefined) node.append(el('strong', '', m[2]));
      else if (m[3] !== undefined) node.append(el('code', '', m[3]));
      else if (m[4] !== undefined) node.append(m[4]);
      else node.append(el('em', '', m[6]));
      last = m.index + m[0].length;
    }
    if (last < text.length) node.append(text.slice(last));
    return node;
  }
})();
