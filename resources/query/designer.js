/* This renderer owns presentation only. ESKA supplies metadata, bindings, syntax and every accepted model. */
(() => {
  const api = acquireVsCodeApi(), root = document.getElementById("root");
  const pages = ["tablesFields", "joins", "group", "conditions", "order"];
  let state, selected = 0, page = "tablesFields", editing, pendingEdit, search = "", chosenField = "";
  const expanded = new Set();

  /** Untrusted names and expressions are always text nodes, never markup. */
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  /** The selected statement controls query spelling independently of the interface locale. */
  function name(value) { return statement()?.russian ? value.russian : value.english; }

  /** Selection is presentation state; the model and its indices come exclusively from ESKA. */
  function statement() { return state?.model.statements[selected]; }

  /** Eligibility reasons are supplied by the backend for this exact model revision. */
  function unavailable(kind) { return statement()?.append.find(option => option.kind === kind)?.unavailable ?? (statement()?.unavailable || null); }

  /** All buttons preserve native busy/paused state, with explicit backend explanations for disabled actions. */
  function button(label, action, reason, className) {
    const node = element("button", label, className); node.type = "button";
    node.disabled = !!reason || state.busy || state.paused;
    if (reason) node.title = state.reasons[reason] ?? reason;
    node.addEventListener("click", action); return node;
  }

  /** A user intention cannot supply a session, source path or constructor identity. */
  function send(action) {
    pendingEdit = editing ? structuredClone(editing) : undefined;
    editing = undefined; api.postMessage({ type: "action", action });
  }

  /** Typed expressions are formatted and validated by ESKA, including language-specific keywords. */
  function compose(expression, selection = null) { send({ kind: "compose", statement: selected, selection, expression }); }

  /** Free expression editing remains available for nodes outside the recognized structured subset. */
  function begin(action, expression, initial = "") {
    editing = { action, expression, initial, raw: !state.visual || !expression }; render();
  }

  /** Empty forms contain values only; their corresponding query syntax is never built in the webview. */
  function blank(kind, expression = chosenField) {
    if (kind === "sources") return { kind: "source", table: "", alias: "" };
    if (kind === "joins") return { kind: "join", table: "", alias: "", join: "left", left: expression, comparison: "equal", right: "" };
    if (kind === "conditions") return { kind: "condition", left: expression, comparison: "equal", right: "" };
    if (kind === "group") return { kind: "group", expression };
    if (kind === "order") return { kind: "order", expression, descending: false };
    return { kind: "field", expression, alias: "", aggregate: null };
  }

  /** A clause row's indices are immutable until the backend returns its next revision. */
  function rows(kind) {
    return (statement()?.clauses ?? []).filter(clause => clause.kind === kind).flatMap(clause => clause.items.map(item => ({
      clause, item, selection: { statement: selected, clause: clause.index, item: item.index }
    })));
  }

  /** Create one titled panel without changing the statement model. */
  function panel(title, className) {
    const node = element("section", undefined, className), heading = element("div", undefined, "section-title");
    heading.append(element("h2", title)); node.append(heading); return node;
  }

  /** Row controls operate on backend selections; no SQL token is inspected in this renderer. */
  function controls(row) {
    const { clause, item, selection } = row, l = state.labels, node = element("div", undefined, "controls");
    node.append(button(l.edit, () => begin({ kind: "replace", selection }, item.visual, item.expression ?? ""), item.unavailable.replace));
    node.append(button(l.remove, () => send({ kind: "remove", selection }), item.unavailable.remove));
    node.append(button("↑", () => send({ kind: "move", selection, to: item.index - 1 }), item.index === 0 ? "single_item" : item.unavailable.move));
    node.lastChild.title = l.up;
    node.append(button("↓", () => send({ kind: "move", selection, to: item.index + 1 }), item.index + 1 === clause.items.length ? "single_item" : item.unavailable.move));
    node.lastChild.title = l.down; return node;
  }

  /** Acknowledged rows remain readable even when their syntax has no structured projection. */
  function list(kind, title, filter) {
    const l = state.labels, node = panel(title), add = button(l.add, () => { const value = blank(kind); if (page === "group" && kind === "fields") value.aggregate = "sum"; begin({ kind: "append", statement: selected, clause: kind }, value); }, unavailable(kind), "action-add");
    node.dataset.section = kind; node.querySelector(".section-title").append(add);
    const entries = rows(kind).filter(row => !filter || filter(row.item));
    for (const row of entries) {
      const item = element("div", undefined, "row"); item.append(element("pre", row.item.preview), controls(row)); node.append(item);
    }
    if (!entries.length) node.append(element("p", l.noRows, "empty"));
    return node;
  }

  /** Database tables are paged by ESKA; only explicitly expanded descriptors are requested. */
  function database() {
    const l = state.labels, node = panel(l.database, "database"), toolbar = element("form", undefined, "search");
    const input = element("input"); input.type = "search"; input.value = search; input.placeholder = l.search; input.setAttribute("aria-label", l.search);
    input.addEventListener("input", () => { search = input.value; });
    toolbar.append(input, button(l.find, () => api.postMessage({ type: "catalog", search, offset: 0 })));
    toolbar.addEventListener("submit", event => { event.preventDefault(); if (!state.busy) api.postMessage({ type: "catalog", search, offset: 0 }); }); node.append(toolbar);
    if (!state.visual) { node.append(element("p", l.metadataUnavailable, "notice")); return node; }
    if (state.metadata.failed) node.append(element("p", l.metadataFailed, "error"));
    const catalog = state.metadata.catalog, groups = new Map();
    for (const table of catalog?.tables ?? []) {
      if (!groups.has(table.category)) groups.set(table.category, []);
      groups.get(table.category).push(table);
    }
    const details = new Map(state.metadata.details);
    for (const [category, tables] of groups) {
      const group = element("details", undefined, "metadata-group"); group.open = true;
      group.append(element("summary", l[`category${category}`] ?? category));
      for (const table of tables) {
        const row = element("div", undefined, "metadata-table"), path = name(table);
        const expand = button(expanded.has(path) ? "▾" : "▸", () => {
          if (expanded.has(path)) { expanded.delete(path); render(); }
          else { expanded.add(path); if (!details.has(path)) api.postMessage({ type: "catalog", table: path }); else render(); }
        }); expand.title = table.name;
        const label = button(table.name, () => {}, null, "table-name"); label.title = path;
        label.addEventListener("dblclick", () => { if (!label.disabled && !unavailable("sources")) compose({ kind: "source", table: path, alias: "" }); });
        const add = button("+", () => compose({ kind: "source", table: path, alias: "" }), unavailable("sources"), "table-add"); add.title = l.add;
        row.append(expand, label, add); group.append(row);
        if (expanded.has(path)) for (const child of details.get(path)?.tables ?? []) {
          const childButton = button(child.name, () => compose({ kind: "source", table: name(child), alias: "" }), unavailable("sources"), "tabular-section");
          childButton.title = name(child); group.append(childButton);
        }
      }
      node.append(group);
    }
    if (!catalog?.tables.length && !state.busy) node.append(element("p", l.noTables, "empty"));
    if (catalog?.nextOffset !== null && catalog?.nextOffset !== undefined) node.append(button(l.more,
      () => api.postMessage({ type: "catalog", search, offset: catalog.nextOffset })));
    if (catalog?.limitedContext) node.append(element("p", l.limitedContext, "notice"));
    return node;
  }

  /** Source trees share already qualified field choices from the backend. */
  function sourceFields(choose) {
    const l = state.labels, node = panel(l.tables, "source-fields");
    for (const source of state.metadata.fields) {
      const tree = element("details", undefined, "source-tree"); tree.open = source.loaded;
      tree.addEventListener("toggle", () => { if (tree.open && !source.loaded && !state.busy) api.postMessage({ type: "fields", table: source.table, alias: source.alias }); });
      tree.append(element("summary", source.alias), element("small", source.table));
      if (choose === "fields" && source.fields.length) {
        tree.append(button(l.allFields, () => send({ kind: "appendFields", statement: selected, fields: source.fields.map(name) }),
          source.fields.length > 512 ? "model_limit" : unavailable("fields"), "all-fields"));
      }
      for (const field of source.fields) {
        const value = name(field), pick = button(value, () => { chosenField = value; }, unavailable(choose === "fields" ? "fields" : choose), "field-choice");
        pick.addEventListener("dblclick", () => {
          if (pick.disabled) return;
          chosenField = value;
          if (choose === "fields" || choose === "group") compose(blank(choose, value));
          else begin({ kind: "append", statement: selected, clause: choose }, blank(choose, value));
        }); tree.append(pick);
      }
      if (!source.found || !source.fields.length) tree.append(element("p", l.noFields, "empty"));
      node.append(tree);
    }
    if (!state.metadata.fields.length) node.append(element("p", l.noFields, "empty"));
    return node;
  }

  /** Table properties and metadata field trees stay together, as in a query wizard's middle pane. */
  function sources() {
    const node = sourceFields("fields"), l = state.labels;
    node.querySelector(".section-title").append(button(l.add, () => begin({ kind: "append", statement: selected, clause: "sources" }, blank("sources")), unavailable("sources")));
    for (const row of rows("sources")) {
      const properties = element("div", undefined, "source-properties"); properties.append(element("pre", row.item.preview), controls(row)); node.append(properties);
    }
    return node;
  }

  /** The five pages group existing core clauses; selecting a page never changes the query. */
  function renderPage(container) {
    const l = state.labels;
    if (page === "tablesFields") {
      container.classList.add("three-panes"); container.append(database(), sources(), list("fields", l.selectedFields));
    } else if (page === "joins") {
      container.classList.add("two-panes"); container.append(sourceFields("joins"), list("joins", l.joins));
    } else if (page === "group") {
      container.classList.add("two-panes"); container.append(list("group", l.groupFields), list("fields", l.aggregateFields, item => !!item.visual?.aggregate));
    } else if (page === "conditions") {
      container.classList.add("two-panes"); container.append(sourceFields("conditions"), list("conditions", l.conditions));
    } else {
      container.classList.add("two-panes"); container.append(sourceFields("order"), list("order", l.order));
    }
  }

  /** Input values persist across busy model publications without becoming a second query document. */
  function input(form, label, key, data, options = {}) {
    const wrapper = element("label", label), node = element("input"); node.name = key; node.value = data[key] ?? "";
    node.required = options.required !== false; node.disabled = state.busy; node.maxLength = state.maxExpression;
    if (options.list) node.setAttribute("list", options.list);
    node.addEventListener("input", () => { data[key] = node.value; }); wrapper.append(node); form.append(wrapper); return node;
  }

  /** Select values are stable enum identifiers, never generated query keywords. */
  function select(form, label, key, data, options) {
    const wrapper = element("label", label), node = element("select"); node.name = key; node.disabled = state.busy;
    for (const [value, text] of options) { const item = element("option", text); item.value = value; node.append(item); }
    node.value = data[key] ?? ""; node.addEventListener("change", () => { data[key] = node.value; }); wrapper.append(node); form.append(wrapper); return node;
  }

  /** Populate datalists with core-provided choices while preserving manual expressions for complex cases. */
  function choices(form) {
    const fields = element("datalist"); fields.id = "query-fields";
    for (const source of state.metadata.fields) for (const field of source.fields) { const option = element("option"); option.value = name(field); fields.append(option); }
    const tables = element("datalist"); tables.id = "query-tables";
    for (const table of state.metadata.catalog?.tables ?? []) { const option = element("option"); option.value = name(table); tables.append(option); }
    const joined = element("datalist"); joined.id = "query-join-fields";
    for (const field of new Map(state.metadata.details).get(editing?.expression?.table)?.fields ?? []) { const option = element("option"); option.value = name(field); joined.append(option); }
    form.append(fields, tables, joined);
  }

  /** A condition editor separates operands and operator without assembling any SQL in JavaScript. */
  function condition(form, expression, join) {
    const l = state.labels;
    input(form, l.leftField, "left", expression, { list: "query-fields" });
    select(form, l.comparison, "comparison", expression, [["equal", "="], ["notEqual", "<>"], ["less", "<"], ["lessOrEqual", "<="],
      ["greater", ">"], ["greaterOrEqual", ">="], ["like", l.comparisonLike], ["in", l.comparisonIn], ["inHierarchy", l.comparisonInHierarchy]]);
    input(form, join ? l.rightField : l.rightValue, "right", expression, { list: join ? "query-join-fields" : "query-fields" });
  }

  /** Structured controls edit source, field, join, condition, grouping and order values through one common backend action. */
  function visualForm(form) {
    const l = state.labels, value = editing.expression; choices(form);
    if (["source", "join"].includes(value.kind)) {
      const table = input(form, l.tables, "table", value, { list: "query-tables" });
      form.append(button(l.find, () => api.postMessage({ type: "catalog", search: table.value, offset: 0 })));
      table.addEventListener("change", () => { if (value.kind === "join") api.postMessage({ type: "catalog", table: table.value }); });
      input(form, l.alias, "alias", value, { required: false });
    }
    if (["field", "group", "order"].includes(value.kind)) input(form, l.expression, "expression", value, { list: "query-fields" });
    if (value.kind === "field") {
      input(form, l.alias, "alias", value, { required: false });
      select(form, l.aggregate, "aggregate", value, [["", l.noAggregate], ["sum", l.sum], ["count", l.count], ["minimum", l.minimum], ["maximum", l.maximum], ["average", l.average]]);
    }
    if (value.kind === "join") select(form, l.joins, "join", value, [["inner", l.inner], ["left", l.left], ["right", l.right], ["full", l.full]]);
    if (["join", "condition"].includes(value.kind)) condition(form, value, value.kind === "join");
    if (value.kind === "order") {
      const node = select(form, l.direction, "descending", { descending: value.descending ? "yes" : "no" }, [["no", l.ascending], ["yes", l.descending]]);
      node.addEventListener("change", () => { value.descending = node.value === "yes"; });
    }
  }

  /** Expression mode is an explicit escape hatch; switching modes never reparses text in the renderer. */
  function renderEditor() {
    const l = state.labels, form = element("form", undefined, "expression"); form.append(element("h2", l.edit));
    if (editing.raw) {
      const text = element("textarea"); text.name = "raw"; text.value = editing.initial; text.rows = 4;
      text.required = true; text.setAttribute("aria-label", l.expression); text.addEventListener("input", () => { editing.initial = text.value; }); form.append(text);
      if (editing.action.kind === "append" && editing.action.clause === "joins") {
        select(form, l.joins, "join", editing.action, [["inner", l.inner], ["left", l.left], ["right", l.right], ["full", l.full]]);
      }
    } else visualForm(form);
    const accept = button(l.submit, () => {}); accept.type = "submit"; accept.dataset.action = "submit";
    form.addEventListener("submit", event => {
      event.preventDefault(); if (state.busy || state.paused || !form.reportValidity()) return;
      if (editing.raw) {
        const text = form.querySelector("textarea").value;
        if (new TextEncoder().encode(text).length > state.maxExpression) { form.querySelector("textarea").setCustomValidity(state.reasons.expression_too_large); form.reportValidity(); return; }
        send({ ...editing.action, text });
      } else {
        const expression = structuredClone(editing.expression);
        if (expression.kind === "field") expression.aggregate ||= null;
        compose(expression, editing.action.selection ?? null);
      }
    });
    form.append(accept, button(l.close, () => { editing = undefined; render(); }));
    if (editing.expression) form.append(button(editing.raw ? l.visualEditor : l.rawExpression, () => { editing.raw = !editing.raw; render(); }));
    root.append(form);
  }

  /** Render acknowledged state with tab navigation and a complete, readonly text preview. */
  function render() {
    const active = document.activeElement, focus = active?.name, start = active?.selectionStart, end = active?.selectionEnd;
    root.replaceChildren(); if (!state) return;
    const l = state.labels, header = element("header"), actions = element("div", undefined, "header-actions");
    actions.append(button(l.apply, () => api.postMessage({ type: "apply" }), null, "primary"));
    const cancel = button(l.cancel, () => api.postMessage({ type: "cancel" })); cancel.disabled = state.busy; actions.append(cancel); header.append(actions);
    selected = Math.min(state.statement ?? selected, Math.max(0, state.model.statements.length - 1));
    const picker = element("select"); picker.setAttribute("aria-label", l.statement); picker.disabled = state.busy;
    for (const value of state.model.statements) { const option = element("option", `${l.statement} ${value.index + 1} · ${value.preview.slice(0, 50)}`); option.value = String(value.index); picker.append(option); }
    picker.value = String(selected); picker.addEventListener("change", () => { selected = Number(picker.value); editing = undefined; api.postMessage({ type: "select", statement: selected }); }); header.append(picker); root.append(header);
    if (state.paused) root.append(element("p", state.pausedText, "error"));
    const tabs = element("nav", undefined, "tabs"); tabs.setAttribute("role", "tablist");
    for (const value of pages) {
      const activate = target => { page = target; editing = undefined; render(); document.getElementById(`tab-${target}`)?.focus(); };
      const tab = button(l[value], () => activate(value)); tab.setAttribute("role", "tab"); tab.tabIndex = page === value ? 0 : -1;
      tab.addEventListener("keydown", event => {
        const index = pages.indexOf(value);
        const next = event.key === "ArrowRight" ? pages[(index + 1) % pages.length] : event.key === "ArrowLeft" ? pages[(index + pages.length - 1) % pages.length]
          : event.key === "Home" ? pages[0] : event.key === "End" ? pages[pages.length - 1] : undefined;
        if (next && !state.busy) { event.preventDefault(); activate(next); }
      });
      tab.setAttribute("aria-selected", String(page === value)); tab.id = `tab-${value}`; tab.setAttribute("aria-controls", "query-page"); tabs.append(tab);
    }
    root.append(tabs);
    const owner = statement(), content = element("div", undefined, "sections"); content.id = "query-page"; content.setAttribute("role", "tabpanel"); content.setAttribute("aria-labelledby", `tab-${page}`);
    if (!owner) content.append(element("p", l.empty));
    else if (owner.unavailable) content.append(element("p", state.reasons[owner.unavailable] ?? l.empty, "notice"));
    else renderPage(content);
    root.append(content); if (editing) renderEditor();
    const preview = element("details", undefined, "query-preview"); preview.append(element("summary", l.text), element("pre", state.model.text)); root.append(preview);
    root.setAttribute("aria-busy", String(state.busy));
    if (focus) {
      const restored = [...root.querySelectorAll("input,textarea,select")].find(node => node.name === focus);
      if (restored) { restored.focus(); if (typeof start === "number" && restored.setSelectionRange && !["select-one", "select-multiple"].includes(restored.type)) restored.setSelectionRange(start, end); }
    }
  }

  /** Backend errors retain pending form input and never replace the last acknowledged query text. */
  window.addEventListener("message", event => {
    if (event.data?.type === "model") {
      if (state && state.model.revision !== event.data.model.revision) pendingEdit = undefined;
      state = event.data; render();
    } else if (event.data?.type === "error") {
      if (pendingEdit) { editing = pendingEdit; render(); }
      const error = element("p", event.data.text, "error"); error.setAttribute("role", "alert"); root.prepend(error);
    }
  });
  api.postMessage({ type: "ready" });
})();
