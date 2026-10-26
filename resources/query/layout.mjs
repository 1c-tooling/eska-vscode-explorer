const pages = new Set(['tablesFields', 'joins', 'group', 'conditions', 'order', 'unions', 'totals', 'packages', 'dcs']);

/** Stored webview state contains bounded presentation preferences, never a query or a second draft. */
export function layoutPreferences(value) {
  const stored = value?.version === 1 ? value : {};
  const views = Object.fromEntries(Object.entries(stored.views ?? {}).slice(-32).filter(([key]) => /^\d+:[a-zA-Z]+$/.test(key)).map(([key, view]) => [key, {
    scroll: Object.fromEntries(Object.entries(view?.scroll ?? {}).slice(0, 64).filter(([key, offset]) => key.length <= 512 && Number.isFinite(offset) && offset >= 0).map(([key, offset]) => [key, Math.min(offset, 10000000)])),
    details: Object.fromEntries(Object.entries(view?.details ?? {}).slice(0, 64).filter(([key, open]) => key.length <= 512 && typeof open === 'boolean'))
  }]));
  return { version: 1, views,
    page: Object.fromEntries(Object.entries(stored.page ?? {}).slice(-32).filter(([key, page]) => /^\d+$/.test(key) && pages.has(page))),
    extra: [...new Set(Array.isArray(stored.extra) ? stored.extra.filter(page => pages.has(page)) : [])],
    expanded: Array.isArray(stored.expanded) ? stored.expanded.filter(key => typeof key === 'string' && key.length <= 512).slice(0, 512) : [],
    widths: Object.fromEntries([2, 3].map(count => {
      const values = stored.widths?.[count];
      return [count, Array.isArray(values) && values.length === count && values.every(value => Number.isFinite(value) && value >= .1 && value <= .9) && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < .000001
        ? values.map(value => value / values.reduce((sum, value) => sum + value, 0)) : Array(count).fill(1 / count)];
    })),
    catalogCollapsed: typeof stored.catalogCollapsed === 'boolean' ? stored.catalogCollapsed : null,
    previewOpen: stored.previewOpen === true,
    previewHeight: Number.isFinite(stored.previewHeight) ? Math.min(600, Math.max(64, stored.previewHeight)) : 180
  };
}

/** Ratios preserve the adjacent pair's combined width and leave every pane reachable. */
export function moveDivider(widths, index, change) {
  const result = [...widths], total = result[index] + result[index + 1];
  result[index] = Math.max(.1, Math.min(total - .1, result[index] + change));
  result[index + 1] = total - result[index]; return result;
}

/** A stable DOM path distinguishes repeated expression inputs without interpreting their contents. */
function keyFor(node, root) {
  const path = [];
  while (node && node !== root) {
    const id = ['id', 'data-section', 'data-source', 'data-category', 'data-value', 'name'].map(name => node.getAttribute(name)).find(Boolean);
    // Named form inputs can shadow native properties such as `children` and `name`.
    const siblings = node.parentElement ? [...node.parentElement.querySelectorAll(':scope > *')].filter(value => value.tagName === node.tagName) : [];
    path.unshift(`${node.tagName}:${id || siblings.indexOf(node)}`); node = node.parentElement;
  }
  return path.join('/');
}

/** Native focus, scroll and geometry belong to this adapter; all accepted text remains in ESKA. */
export class ConstructorLayout {
  constructor(api, root) {
    this.api = api; this.root = root; this.preferences = layoutPreferences(api.getState());
    this.inputs = []; this.focus = undefined; this.context = undefined; this.revision = undefined;
    window.addEventListener('resize', () => { this.grid(); this.previewSize(); });
  }

  /** Persist only a sanitized, size-bounded preference snapshot. */
  save() { this.preferences = layoutPreferences(this.preferences); this.api.setState(this.preferences); }

  /** Scope navigation restores its former page independently from the child's page. */
  page(statement, fallback = 'tablesFields') { return this.preferences.page[statement] ?? fallback; }

  /** Explicit page selection makes an optional section reachable on subsequent publications. */
  select(statement, page) {
    this.preferences.page[statement] = page;
    if (!this.preferences.extra.includes(page)) this.preferences.extra.push(page);
    this.save();
  }

  /** Capture before replacing nodes, including focus that temporarily cannot enter a disabled input. */
  capture() {
    if (!this.context) return;
    const preview = this.root.querySelector('.query-preview');
    if (preview) this.preferences.previewOpen = preview.open;
    const view = { scroll: {}, details: {} };
    for (const node of this.root.querySelectorAll('.query-pane, .query-preview pre, .expression, .tabs')) {
      const key = keyFor(node, this.root); view.scroll[key] = node.scrollTop; view.scroll[`${key}/left`] = node.scrollLeft;
    }
    for (const node of this.root.querySelectorAll('.sections details')) view.details[keyFor(node, this.root)] = node.open;
    this.preferences.views[this.context] = view;
    const active = document.activeElement;
    if (active && this.root.contains(active) && active !== this.root) this.focus = {
      key: keyFor(active, this.root), start: active.selectionStart, end: active.selectionEnd
    };
    const inputs = [...this.root.querySelectorAll('input, textarea, select')];
    if (inputs.length) this.inputs = inputs.map(node => ({ key: keyFor(node, this.root), value: node.value, checked: node.checked }));
    this.save();
  }

  /** Recreate layout handles and restore local input only within the same acknowledged revision. */
  mount(statement, page, revision, labels) {
    const context = `${statement}:${page}`, same = this.context === context;
    if (!same || revision !== this.revision) this.inputs = [];
    if (!same) this.focus = undefined;
    this.context = context; this.revision = revision; this.labels = labels;
    this.preferences.page[statement] = page;
    this.content = this.root.querySelector('.sections');
    for (const node of this.content.children) node.classList.add('query-pane');
    this.grid();
    const preview = this.root.querySelector('.query-preview');
    preview.open = this.preferences.previewOpen;
    preview.addEventListener('toggle', () => {
      if (!preview.isConnected) return;
      this.preferences.previewOpen = preview.open; this.previewSize(); this.save();
    });
    const handle = this.separator('horizontal', labels.resizeText);
    handle.classList.add('preview-separator'); handle.setAttribute('aria-controls', 'query-text');
    preview.prepend(handle);
    this.drag(handle, event => {
      const initial = this.preferences.previewHeight;
      return move => this.resizePreview(initial + event.clientY - move.clientY);
    });
    handle.addEventListener('keydown', event => {
      const change = event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : 0;
      if (!change && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault(); this.resizePreview(event.key === 'Home' ? 64 : event.key === 'End' ? innerHeight / 2 : this.preferences.previewHeight + change); this.save();
    });
    this.previewSize();
    const view = this.preferences.views[context];
    for (const node of this.root.querySelectorAll('.sections details')) {
      const open = view?.details[keyFor(node, this.root)]; if (open !== undefined) node.open = open;
      node.addEventListener('toggle', () => { if (node.isConnected) { this.capture(); } });
    }
    const controls = [...this.root.querySelectorAll('button, input, textarea, select, summary, [role=separator]')];
    for (const node of controls) {
      const previous = this.inputs.find(input => input.key === keyFor(node, this.root));
      if (!previous || node.disabled || !['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) continue;
      if (node.value !== previous.value) { node.value = previous.value; node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }
      if (node.type === 'checkbox') node.checked = previous.checked;
    }
    for (const node of this.root.querySelectorAll('.query-pane, .query-preview pre, .expression, .tabs')) {
      const key = keyFor(node, this.root);
      node.scrollTop = view?.scroll[key] ?? 0; node.scrollLeft = view?.scroll[`${key}/left`] ?? 0;
      node.addEventListener('scroll', () => { if (node.isConnected) this.capture(); }, { passive: true });
    }
    const tabs = this.root.querySelector('.tabs'), activeTab = tabs.querySelector('[aria-selected=true]');
    if (activeTab) {
      const selected = activeTab.getBoundingClientRect(), bounds = tabs.getBoundingClientRect();
      if (selected.left < bounds.left) tabs.scrollLeft += selected.left - bounds.left;
      else if (selected.right > bounds.right) tabs.scrollLeft += selected.right - bounds.right;
    }
    if (same && this.focus) {
      const node = controls.find(node => keyFor(node, this.root) === this.focus.key);
      if (node && !node.disabled) {
        node.focus({ preventScroll: true });
        if (typeof this.focus.start === 'number' && node.setSelectionRange) node.setSelectionRange(this.focus.start, this.focus.end);
      }
    }
  }

  /** Narrow windows hide only the catalogue by default; its explicit toggle always wins. */
  collapsed() { return this.preferences.catalogCollapsed ?? innerWidth < 850; }

  /** Reflow existing pane nodes without replacing inputs when the window size changes. */
  grid() {
    if (!this.content) return;
    for (const handle of this.content.querySelectorAll(':scope > .pane-separator')) handle.remove();
    const database = this.content.querySelector(':scope > .database');
    if (database) database.hidden = this.collapsed();
    const toggle = this.root.querySelector('.catalog-toggle');
    if (toggle) { toggle.hidden = !database; toggle.setAttribute('aria-expanded', String(!this.collapsed())); }
    const panes = [...this.content.children].filter(node => !node.hidden);
    if (panes.length < 2) { this.content.style.gridTemplateColumns = 'minmax(0, 1fr)'; return; }
    const widths = this.preferences.widths[panes.length] ?? Array(panes.length).fill(1 / panes.length);
    this.content.style.gridTemplateColumns = widths.map(value => `minmax(0, ${value}fr)`).join(' 6px ');
    for (let index = 0; index < panes.length - 1; index++) {
      const handle = this.separator('vertical', this.labels.resizePanes); handle.classList.add('pane-separator');
      handle.setAttribute('aria-valuemin', '10'); handle.setAttribute('aria-valuemax', String(Math.round((widths[index] + widths[index + 1] - .1) * 100)));
      handle.setAttribute('aria-valuenow', String(Math.round(widths[index] * 100)));
      const move = change => {
        this.preferences.widths[panes.length] = moveDivider(this.preferences.widths[panes.length] ?? widths, index, change);
        const next = this.preferences.widths[panes.length];
        this.content.style.gridTemplateColumns = next.map(value => `minmax(0, ${value}fr)`).join(' 6px ');
        for (const [at, node] of this.content.querySelectorAll(':scope > .pane-separator').entries()) node.setAttribute('aria-valuenow', String(Math.round(next[at] * 100)));
      };
      this.drag(handle, event => { const initial = this.preferences.widths[panes.length] ?? widths; return next => {
        this.preferences.widths[panes.length] = initial; move((next.clientX - event.clientX) / this.content.clientWidth);
      }; });
      handle.addEventListener('keydown', event => {
        const change = event.key === 'ArrowLeft' ? -.03 : event.key === 'ArrowRight' ? .03 : event.key === 'Home' ? -1 : event.key === 'End' ? 1 : 0;
        if (!change) return; event.preventDefault(); move(change); this.save();
      });
      panes[index].after(handle);
    }
  }

  /** A focusable divider exposes both pointer dragging and equivalent keyboard adjustments. */
  separator(orientation, label) {
    const node = document.createElement('div'); node.setAttribute('role', 'separator'); node.tabIndex = 0;
    node.setAttribute('aria-orientation', orientation); node.setAttribute('aria-label', label); return node;
  }

  /** Pointer capture keeps the owned divider responsive outside its six-pixel hit target. */
  drag(handle, begin) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.focus({ preventScroll: true }); handle.setPointerCapture(event.pointerId);
      const move = begin(event), stop = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('lostpointercapture', stop); this.save();
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('lostpointercapture', stop);
    });
  }

  /** Preserve the preferred text height while clamping its visible part to the current window. */
  resizePreview(height) { this.preferences.previewHeight = Math.max(64, Math.min(600, height)); this.previewSize(); }

  /** The text area shares remaining height with the workspace rather than scrolling the whole page. */
  previewSize() {
    const preview = this.root.querySelector('.query-preview'), handle = preview?.querySelector('.preview-separator');
    if (!preview || !handle) return;
    const height = Math.min(this.preferences.previewHeight, innerHeight * .5);
    preview.style.height = preview.open ? `${height}px` : '';
    handle.hidden = !preview.open; handle.setAttribute('aria-valuemin', '64'); handle.setAttribute('aria-valuemax', String(Math.floor(innerHeight * .5)));
    handle.setAttribute('aria-valuenow', String(Math.round(height)));
  }
}
