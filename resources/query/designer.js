/* This renderer owns presentation only. ESKA supplies metadata, bindings, syntax and every accepted model. */
import { ConstructorLayout } from './layout.mjs';

(() => {
  const api = acquireVsCodeApi(), root = document.getElementById("root");
  const layout = new ConstructorLayout(api, root);
  const basePages = ["tablesFields", "joins", "group", "conditions", "order"];
  let state, totalSection = 0, totalScope = -1, selected = 0, page = layout.page(0), editing, pendingEdit, search = "", chosenField = "";
  const expanded = new Set(layout.preferences.expanded);

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
  function statement(kind) {
    const owner = state?.model.statements[selected];
    if (["order", "totals", "totalGroups", "index"].includes(kind) && owner?.scope !== undefined) return state.model.statements[state.model.scopes[owner.scope].result];
    return owner;
  }

  /** Scope edges are supplied by ESKA and keep navigation inside this one modal editor. */
  function navigate(index) { editing = undefined; chosenField = ""; api.postMessage({ type: "select", statement: index }); }

  /** Eligibility reasons are supplied by the backend for this exact model revision. */
  function unavailable(kind) { const owner = statement(kind); return owner?.append.find(option => option.kind === kind)?.unavailable ?? (owner?.unavailable || null); }

  /** All buttons preserve native busy/paused state, with explicit backend explanations for disabled actions. */
  function button(label, action, reason, className) {
    const node = element("button", label, className); node.type = "button";
    const accessible = label === "↑" ? state.labels.up : label === "↓" ? state.labels.down : label === "+" ? state.labels.add : label;
    node.title = accessible; node.setAttribute("aria-label", accessible);
    node.disabled = !!reason || state.busy || state.paused;
    if (reason) node.title = `${accessible}: ${state.reasons[reason] ?? reason}`;
    node.addEventListener("click", action); return node;
  }

  /** A user intention cannot supply a session, source path or constructor identity. */
  function send(action) {
    if (state.features.totalSections && action.kind === "append" && ["totals", "totalGroups"].includes(action.clause)) {
      const section = activeTotal();
      if (section) action = { kind: "appendTotal", statement: action.statement, section: section.index, clause: action.clause, text: action.text };
    }
    pendingEdit = editing ? structuredClone(editing) : undefined;
    editing = undefined; api.postMessage({ type: "action", action });
  }

  /** Typed expressions are formatted and validated by ESKA, including language-specific keywords. */
  function compose(expression, selection = null) {
    const kind = expression.kind === "totalField" ? "totals" : ["totalGroup", "overall"].includes(expression.kind) ? "totalGroups" : expression.kind;
    const section = state.features.totalSections && ["totals", "totalGroups"].includes(kind) ? activeTotal() : undefined;
    send({ kind: section ? "composeTotal" : "compose", statement: selection?.statement ?? statement(kind).index, ...(section ? { section: section.index } : {}), selection, expression });
  }

  /** Free expression editing remains available for nodes outside the recognized structured subset. */
  function begin(action, expression, initial = "") {
    editing = { action, expression: expression ? structuredClone(expression) : undefined, initial, raw: !state.visual || !expression }; render();
    if (["virtualSource", "virtualJoin"].includes(expression?.kind) && !new Map(state.metadata.details).has(expression.table)) api.postMessage({ type: "catalog", table: expression.table });
  }

  /** Empty forms contain values only; their corresponding query syntax is never built in the webview. */
  function blank(kind, expression = chosenField) {
    if (kind === "index") return undefined;
    if (kind === "sources") return { kind: "source", table: "", alias: "" };
    if (kind === "joins") return { kind: "join", table: "", alias: "", join: "left", left: expression, comparison: "equal", right: "" };
    if (kind === "conditions" || kind === "having") return { kind: kind === "having" ? "having" : "condition", left: expression, comparison: "equal", right: "" };
    if (kind === "group") return { kind: "group", expression };
    if (kind === "order") return { kind: "order", expression, descending: false };
    if (kind === "totals") return { kind: "totalField", expression, alias: "", aggregate: "sum" };
    if (kind === "totalGroups") return { kind: "totalGroup", expression, alias: "", hierarchy: "none", period: null };
    return { kind: "field", expression, alias: "", aggregate: null };
  }

  /** Section ownership and clause references come from ESKA; selection is presentation state only. */
  function activeTotal() {
    const owner = statement("totals");
    if (!state.features.totalSections || !owner) return undefined;
    if (totalScope !== owner.scope) { totalScope = owner.scope; totalSection = 0; }
    totalSection = Math.min(totalSection, Math.max(0, owner.totalSections.length - 1));
    return owner.totalSections[totalSection];
  }

  /** A clause row's indices are immutable until the backend returns its next revision. */
  function rows(kind) {
    const owner = statement(kind);
    const section = state.features.totalSections && ["totals", "totalGroups"].includes(kind) ? activeTotal() : undefined;
    return (owner?.clauses ?? []).filter(clause => clause.kind === kind && (!section || clause.index === (kind === "totals" ? section.fields : section.groups))).flatMap(clause => clause.items.map(item => ({
      clause, item, selection: { statement: owner.index, clause: clause.index, item: item.index }
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
    for (const child of item.children ?? []) node.append(button(l.editNested, () => navigate(state.model.scopes[child].branches[0]), null, "edit-nested"));
    node.append(button("↑", () => send({ kind: "move", selection, to: item.index - 1 }), item.moveUp === false || item.index === 0 ? "single_item" : item.unavailable.move));
    node.append(button("↓", () => send({ kind: "move", selection, to: item.index + 1 }), item.moveDown === false || item.index + 1 === clause.items.length ? "single_item" : item.unavailable.move));
    return node;
  }

  /** Acknowledged rows remain readable even when their syntax has no structured projection. */
  function list(kind, title, filter) {
    const l = state.labels, node = panel(title), add = button(l.add, () => { const value = blank(kind); if (page === "group" && kind === "fields") value.aggregate = "sum"; begin({ kind: "append", statement: statement(kind).index, clause: kind }, value); }, unavailable(kind), "action-add");
    node.dataset.section = kind; node.querySelector(".section-title").append(add);
    if (kind === "joins" && state.features.nestedQueries) node.querySelector(".section-title").append(button(l.nested, () => begin({ kind: "append", statement: selected, clause: kind }, { kind: "subqueryJoin", alias: "", join: "left", left: chosenField, comparison: "equal", right: "" }), unavailable(kind), "add-nested"));
    const entries = rows(kind).filter(row => !filter || filter(row.item));
    for (const row of entries) {
      const item = element("div", undefined, "row"), text = element("pre", row.item.preview); text.title = row.item.preview;
      item.append(text, controls(row)); node.append(item);
    }
    if (!entries.length) node.append(element("p", l.noRows, "empty"));
    return node;
  }

  /** A virtual table selection opens positional value controls; ESKA builds the eventual call. */
  function chooseTable(table) {
    const path = name(table);
    if (!table.virtualTable) { compose({ kind: "source", table: path, alias: "" }); return; }
    begin({ kind: "append", statement: selected, clause: "sources" }, { kind: "virtualSource", table: path, alias: "", parameters: [] });
  }

  /** Database tables are paged by ESKA; only explicitly expanded descriptors are requested. */
  function database() {
    const l = state.labels, node = panel(l.database, "database"), toolbar = element("form", undefined, "search");
    const input = element("input"); input.name = "catalogSearch"; input.type = "search"; input.value = search; input.placeholder = l.search; input.setAttribute("aria-label", l.search);
    input.addEventListener("input", () => { search = input.value; });
    toolbar.append(input, button(l.find, () => api.postMessage({ type: "catalog", search, offset: 0 })));
    toolbar.addEventListener("submit", event => { event.preventDefault(); if (!state.busy) api.postMessage({ type: "catalog", search, offset: 0 }); }); node.append(toolbar);
    if (!state.visual) { node.append(element("p", l.metadataUnavailable, "notice")); return node; }
    if (state.metadata.failed) node.append(element("p", l.metadataFailed, "error"));
    const catalog = state.metadata.catalog, groups = new Map();
    for (const table of [...catalog?.tables ?? [], ...(catalog?.temporaryTables ?? []).map(table => ({ ...table, category: "TemporaryTable", russian: table.name, english: table.name, alias: table.name }))]) {
      if (!groups.has(table.category)) groups.set(table.category, []);
      groups.get(table.category).push(table);
    }
    const details = new Map(state.metadata.details);
    for (const [category, tables] of groups) {
      const group = element("details", undefined, "metadata-group"); group.open = true;
      group.dataset.category = category;
      group.append(element("summary", l[`category${category}`] ?? category));
      for (const table of tables) {
        const row = element("div", undefined, "metadata-table"), path = name(table);
        const expand = button(expanded.has(path) ? "▾" : "▸", () => {
          if (expanded.has(path)) { expanded.delete(path); render(); }
          else { expanded.add(path); if (!details.has(path)) api.postMessage({ type: "catalog", table: path }); else render(); }
          layout.preferences.expanded = [...expanded]; layout.save();
        }); expand.title = `${l.toggleTable} ${table.name}`; expand.setAttribute("aria-label", expand.title);
        const label = button(table.name, () => {}, null, "table-name"); label.title = path;
        label.addEventListener("dblclick", () => { if (!label.disabled && !unavailable("sources")) chooseTable(table); });
        const add = button("+", () => chooseTable(table), unavailable("sources"), "table-add"); add.setAttribute("aria-label", `${l.add} ${table.name}`);
        row.append(expand, label, add); group.append(row);
        if (expanded.has(path)) for (const child of details.get(path)?.tables ?? []) {
          const childButton = button(child.name, () => chooseTable(child), unavailable("sources"), "tabular-section");
          childButton.title = name(child); childButton.dataset.table = name(child); group.append(childButton);
        }
      }
      node.append(group);
    }
    if (!catalog?.tables.length && !catalog?.temporaryTables?.length && !state.busy) node.append(element("p", l.noTables, "empty"));
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
      tree.dataset.source = source.alias;
      tree.addEventListener("toggle", () => { if (tree.open && !source.loaded && !state.busy) api.postMessage({ type: "fields", table: source.table, alias: source.alias, clause: source.clause, item: source.item }); });
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
    if (state.features.nestedQueries) node.querySelector(".section-title").append(button(l.nested, () => compose({ kind: "subquerySource", alias: "" }), unavailable("sources"), "add-nested"));
    for (const row of rows("sources")) {
      const properties = element("div", undefined, "source-properties"); properties.append(element("pre", row.item.preview), controls(row)); node.append(properties);
    }
    return node;
  }

  /** Result aliases and wildcard expansion are resolved by ESKA for the scope, independently of its selected branch. */
  function resultFields(kind) {
    const l = state.labels, node = panel(l.selectedFields, "result-fields");
    for (const field of state.metadata.resultFields) {
      const value = name(field), pick = button(value, () => { chosenField = value; }, unavailable(kind), "field-choice");
      pick.addEventListener("dblclick", () => { if (!pick.disabled) begin({ kind: "append", statement: statement(kind).index, clause: kind }, blank(kind, value)); }); node.append(pick);
    }
    if (!state.metadata.resultFields.length) node.append(element("p", l.noFields, "empty"));
    return node;
  }

  /** Branch controls only pass ESKA's statement identities and an explicit duplicate policy. */
  function unions() {
    const l = state.labels, node = panel(l.unions, "union-branches"), scope = state.model.scopes[statement().scope];
    node.querySelector(".section-title").append(button(l.addUnion, () => send({ kind: "addUnion", statement: selected, all: true }), statement().unavailable, "add-union"));
    for (const [index, id] of scope.branches.entries()) {
      const owner = state.model.statements[id], row = element("div", undefined, "row"); row.dataset.branch = String(id);
      row.append(button(`${l.branch} ${index + 1}`, () => navigate(id)), element("pre", owner.columns.join(", ")));
      if (index) {
        const policy = select(row, l.unions, "all", { all: scope.unions[index - 1].all ? "yes" : "no" }, [["yes", l.unionAll], ["no", l.unionDistinct]]);
        policy.disabled ||= state.paused || !state.model.writable || !!owner.unavailable;
        policy.addEventListener("change", () => send({ kind: "setUnion", statement: id, all: policy.value === "yes" }));
      }
      if (scope.branches.length > 1) row.append(button(l.remove, () => send({ kind: "removeUnion", statement: id }), !state.model.writable ? "read_only" : owner.unavailable, "remove-union"));
      node.append(row);
    }
    return node;
  }

  /** Package controls transmit destinations and operator intentions; ESKA owns lifetimes, dependencies and syntax. */
  function packages() {
    const l = state.labels, node = panel(l.packages, "package-settings"), owner = statement(), permissions = owner.package;
    if (!permissions) return node;
    node.querySelector(".section-title").append(button(l.addStatement, () => send({ kind: "addStatement", statement: selected, operation: "select", name: null }), !permissions.add ? "unsupported" : null, "add-statement"));
    for (const scope of state.model.scopes.filter(scope => scope.parent === null)) {
      const value = state.model.statements[scope.branches[0]], row = element("div", undefined, "row"), controls = value.package;
      row.append(button(`${l.statement} ${controls.position + 1}`, () => navigate(value.index)), element("pre", value.preview));
      row.append(button(l.remove, () => send({ kind: "removeStatement", statement: value.index }), !controls.remove ? "required_item" : null, "remove-statement"));
      for (const [key, label] of [["moveUp", "↑"], ["moveDown", "↓"]]) row.append(button(label, () => send({ kind: "moveStatement", statement: value.index, to: controls[key] }), controls[key] === null ? "unsupported" : null));
      node.append(row);
    }
    if (permissions.operation === "select") {
      const form = element("form", undefined, "temporary-destination"), value = { name: permissions.destination ?? "" };
      input(form, l.destination, "name", value, { required: false });
      const submit = button(l.setDestination, () => {}, !permissions.setInto ? "unsupported" : null, "set-destination"); submit.type = "submit";
      form.addEventListener("submit", event => { event.preventDefault(); if (!state.busy && !state.paused && form.reportValidity()) send({ kind: "setInto", statement: selected, name: value.name.trim() || null }); });
      form.append(submit); node.append(form, list("index", l.index));
    }
    if (permissions.operation === "destroy") node.append(list("destroy", l.destroyTable));
    const drop = element("form", undefined, "temporary-drop"), value = { name: permissions.destination ?? state.metadata.catalog?.temporaryTables?.[0]?.name ?? "" };
    input(drop, l.temporaryTable, "dropName", { dropName: value.name });
    const submit = button(l.destroyTable, () => {}, !permissions.add ? "unsupported" : null, "add-destroy"); submit.type = "submit";
    drop.addEventListener("submit", event => { event.preventDefault(); if (!state.busy && !state.paused && drop.reportValidity()) send({ kind: "addStatement", statement: selected, operation: "destroy", name: drop.querySelector("input").value }); });
    drop.append(submit); node.append(drop); return node;
  }

  /** Overall totals and ordinary groups share one backend-owned section. */
  function totals() {
    const l = state.labels, node = element("div", undefined, "total-settings"), groups = list("totalGroups", l.totalGroups);
    const overall = rows("totalGroups").find(row => row.item.visual?.kind === "overall");
    groups.querySelector(".section-title").append(button(l.overall, () => overall ? send({ kind: "remove", selection: overall.selection }) : compose({ kind: "overall" }), unavailable("totalGroups"), "overall"));
    groups.querySelector(".overall").setAttribute("aria-pressed", String(!!overall));
    const fields = list("totals", l.aggregateFields);
    const section = activeTotal(), owner = statement("totals"), clause = section ? owner.clauses[section.fields] : owner.clauses.find(clause => clause.kind === "totals");
    if (clause && !clause.items.length) fields.append(element("p", l.autoTotals, "notice"));
    if (state.features.totalSections) {
      const toolbar = panel(l.totalSection, "total-sections");
      if (owner.totalSections.length) {
        const picker = select(toolbar, l.totalSection, "totalSection", { totalSection: String(totalSection) }, owner.totalSections.map(value => [String(value.index), `${l.totalSection} ${value.index + 1}`]));
        picker.addEventListener("change", () => { totalSection = Number(picker.value); editing = undefined; render(); });
      }
      toolbar.append(button(l.addTotalSection, () => send({ kind: "addTotals", statement: owner.index, after: section?.index ?? null }), !owner.addTotals ? "unsupported" : null, "add-total-section"));
      if (section) {
        toolbar.append(button(l.remove, () => send({ kind: "removeTotals", statement: owner.index, section: section.index }), !section.remove ? "unsupported" : null, "remove-total-section"));
        for (const [key, label] of [["moveUp", "↑"], ["moveDown", "↓"]].filter(([key]) => section[key] !== null)) toolbar.append(button(label, () => send({ kind: "moveTotals", statement: owner.index, section: section.index, to: section[key] }), section[key] === null ? "unsupported" : null, `total-section-${key}`));
      }
      node.append(toolbar);
    }
    node.append(fields, groups); return node;
  }

  /** DCS positions, previews and permissions are projected by ESKA over the canonical query. */
  function dcs() {
    const l = state.labels, view = statement().dcs, node = panel(l.dcs, "dcs-settings");
    node.append(element("p", l.dcsNotice, "notice"));
    for (const [target, allowed] of [["select", view.addSelect], ["where", view.addWhere]]) {
      node.append(button(l.add + " · " + l[`dcs${target[0].toUpperCase()}${target.slice(1)}`], () => {
        editing = { dcs: { node: null, target, enabled: true, values: [{ kind: "field", expression: "", children: false, alias: "" }] } }; render();
      }, !allowed ? "unsupported" : null, `dcs-add-${target}`));
    }
    for (const value of view.nodes) {
      const row = element("div", undefined, "row dcs-node"); row.dataset.kind = value.kind; row.dataset.index = String(value.index);
      row.append(element("h3", l[`dcs${value.kind[0].toUpperCase()}${value.kind.slice(1)}`]), element("pre", value.preview));
      const reason = !value.editable || !state.model.writable ? "unsupported" : null;
      if (value.kind === "optionalSource") row.append(button(l.dcsEnabled, () => send({ kind: "setDcs", statement: selected, node: value.index, target: value.kind, values: [], enabled: !value.enabled }), reason, "dcs-toggle"));
      else row.append(button(l.edit, () => { editing = { dcs: { node: value.index, target: value.kind, values: structuredClone(value.values), enabled: true } }; render(); }, reason, "dcs-edit"));
      if (value.enabled && ["select", "where", "virtualFilter"].includes(value.kind)) row.append(button(l.remove, () => send({ kind: "setDcs", statement: selected, node: value.index, target: value.kind, values: [], enabled: false }), reason, "dcs-remove"));
      if (value.kind === "optionalSource") row.lastChild.setAttribute("aria-pressed", String(value.enabled));
      node.append(row);
    }
    return node;
  }

  /** Lists are edited as typed values; no braces, separators or query keywords are generated in the renderer. */
  function dcsForm() {
    const l = state.labels, value = editing.dcs, form = element("form", undefined, "expression dcs-expression");
    form.append(element("h2", l[`dcs${value.target[0].toUpperCase()}${value.target.slice(1)}`]));
    if (value.target === "parameter") {
      input(form, l.parameters, "name", value.values[0]);
      const label = element("label", l.dcsEnabled), check = element("input"); check.type = "checkbox"; check.name = "enabled"; check.checked = value.enabled;
      check.addEventListener("change", () => { value.enabled = check.checked; }); label.append(check); form.append(label);
    } else {
      for (const [index, entry] of value.values.entries()) {
        const row = element("fieldset"); row.dataset.value = String(index);
        if (entry.kind === "condition") condition(row, entry, false);
        else {
          input(row, l.expression, "expression", entry);
          if (value.target !== "select") input(row, l.alias, "alias", entry, { required: false });
          const label = element("label", l.dcsChildren), check = element("input"); check.type = "checkbox"; check.name = "children"; check.checked = entry.children;
          check.addEventListener("change", () => { entry.children = check.checked; }); label.append(check); row.append(label);
        }
        row.append(button(l.remove, () => { value.values.splice(index, 1); render(); })); form.append(row);
      }
      form.append(button(l.add + " · " + l.fields, () => { value.values.push({ kind: "field", expression: "", children: false, alias: "" }); render(); }, value.values.length >= 128 ? "model_limit" : null, "dcs-add-field"));
      if (value.target !== "select") form.append(button(l.add + " · " + l.conditions, () => { value.values.push({ kind: "condition", left: "", comparison: "equal", right: "" }); render(); }, value.values.length >= 128 ? "model_limit" : null, "dcs-add-condition"));
    }
    const accept = button(l.submit, () => {}); accept.type = "submit"; accept.dataset.action = "submit";
    form.addEventListener("submit", event => { event.preventDefault(); if (!state.busy && !state.paused && form.reportValidity()) send({ kind: "setDcs", statement: selected, ...structuredClone(value) }); });
    form.append(accept, button(l.close, () => { editing = undefined; render(); })); root.append(form);
  }

  /** Pages group domain clauses and scopes; selecting a page never changes query text. */
  function renderPage(container) {
    const l = state.labels;
    if (page === "dcs") { container.append(dcs()); }
    else if (page === "packages") { container.append(packages()); }
    else if (page === "tablesFields") {
      container.classList.add("three-panes"); container.append(database(), sources(), list("fields", l.selectedFields));
    } else if (page === "joins") {
      container.classList.add("two-panes"); container.append(sourceFields("joins"), list("joins", l.joins));
    } else if (page === "group") {
      container.classList.add("two-panes"); container.append(list("group", l.groupFields), list("fields", l.aggregateFields, item => !!item.visual?.aggregate));
    } else if (page === "conditions") {
      const filters = element("div", undefined, "filter-settings"); filters.append(list("conditions", l.conditions));
      if (state.features.having) filters.append(list("having", l.having));
      container.classList.add("two-panes"); container.append(sourceFields("conditions"), filters);
    } else if (page === "order") {
      container.classList.add("two-panes"); container.append(state.features.totals ? resultFields("order") : sourceFields("order"), list("order", l.order));
    } else if (page === "unions") container.append(unions());
    else if (page === "totals") {
      container.classList.add("two-panes"); container.append(resultFields("totalGroups"), totals());
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
    const values = ["order", "totalField", "totalGroup"].includes(editing?.expression?.kind) ? state.metadata.resultFields : state.metadata.fields.flatMap(source => source.fields);
    for (const field of values) { const option = element("option"); option.value = name(field); fields.append(option); }
    const tables = element("datalist"); tables.id = "query-tables";
    for (const table of state.metadata.catalog?.tables ?? []) { const option = element("option"); option.value = name(table); tables.append(option); }
    for (const [, detail] of state.metadata.details) for (const table of detail.tables) { const option = element("option"); option.value = name(table); tables.append(option); }
    const joined = element("datalist"); joined.id = "query-join-fields";
    for (const field of new Map(state.metadata.details).get(editing?.expression?.table)?.fields ?? []) { const option = element("option"); option.value = name(field); joined.append(option); }
    form.append(fields, tables, joined);
  }

  /** Parameter descriptors and keyword spellings come from the backend; empty positional values remain distinct. */
  function parameters(form, value) {
    const l = state.labels, detail = new Map(state.metadata.details).get(value.table);
    form.append(element("h3", l.parameters));
    if (!detail) return;
    if (!detail.parameters?.length) form.append(element("p", l.noParameters, "notice"));
    for (const [index, parameter] of (detail.parameters ?? []).entries()) {
      const data = { value: value.parameters[index] ?? "" }, list = `parameter-choices-${index}`;
      const node = input(form, l[`parameter${parameter.key[0].toUpperCase()}${parameter.key.slice(1)}`] ?? parameter.key, `parameter-${index}`, { [`parameter-${index}`]: data.value }, { required: parameter.required, list });
      node.addEventListener("input", () => { while (value.parameters.length <= index) value.parameters.push(""); value.parameters[index] = node.value; });
      const choices = element("datalist"); choices.id = list;
      for (const choice of parameter.choices ?? []) { const option = element("option"); option.value = name(choice); choices.append(option); } form.append(choices);
    }
  }

  /** Hierarchy and period options remain enum/value DTOs; ESKA enforces their mutual exclusion. */
  function totalGroup(form, value) {
    const l = state.labels;
    input(form, l.alias, "alias", value, { required: false });
    const hierarchy = select(form, l.hierarchy, "hierarchy", value, [["none", l.noHierarchy], ["hierarchy", l.hierarchy], ["onlyHierarchy", l.onlyHierarchy]]);
    hierarchy.addEventListener("change", () => { if (value.hierarchy !== "none") value.period = null; render(); });
    const units = ["second", "minute", "hour", "day", "week", "tenDays", "month", "quarter", "halfYear", "year"];
    const unit = select(form, l.periods, "periodUnit", { periodUnit: value.period?.unit ?? "" }, [["", l.noPeriods], ...units.map(unit => [unit, l[unit]])]);
    unit.disabled ||= value.hierarchy !== "none";
    unit.addEventListener("change", () => { value.period = unit.value ? { unit: unit.value, begin: value.period?.begin ?? null, end: value.period?.end ?? null } : null; render(); });
    if (value.period) {
      for (const [key, label] of [["begin", l.periodBegin], ["end", l.periodEnd]]) {
        const node = input(form, label, key, value.period, { required: false }); node.addEventListener("input", () => { value.period[key] = node.value || null; });
      }
    }
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
    if (["source", "join", "virtualSource", "virtualJoin"].includes(value.kind)) {
      const table = input(form, l.tables, "table", value, { list: "query-tables" });
      form.append(button(l.find, () => api.postMessage({ type: "catalog", search: table.value, offset: 0 })));
      table.addEventListener("change", () => { api.postMessage({ type: "catalog", table: table.value }); });
    }
    if (["source", "join", "virtualSource", "virtualJoin", "subquerySource", "subqueryJoin"].includes(value.kind)) input(form, l.alias, "alias", value, { required: false });
    if (["source", "join"].includes(value.kind) && new Map(state.metadata.details).get(value.table)?.parameters?.length) { value.kind = value.kind === "join" ? "virtualJoin" : "virtualSource"; value.parameters = []; }
    if (["virtualSource", "virtualJoin"].includes(value.kind)) parameters(form, value);
    if (["field", "group", "order", "totalField", "totalGroup"].includes(value.kind)) input(form, l.expression, "expression", value, { list: "query-fields" });
    if (["field", "totalField"].includes(value.kind)) {
      input(form, l.alias, "alias", value, { required: false });
      select(form, l.aggregate, "aggregate", value, [["", l.noAggregate], ["sum", l.sum], ["count", l.count], ["minimum", l.minimum], ["maximum", l.maximum], ["average", l.average]]);
    }
    if (["join", "virtualJoin", "subqueryJoin"].includes(value.kind)) select(form, l.joins, "join", value, [["inner", l.inner], ["left", l.left], ["right", l.right], ["full", l.full]]);
    if (["join", "virtualJoin", "subqueryJoin", "condition", "having"].includes(value.kind)) condition(form, value, !(["condition", "having"].includes(value.kind)));
    if (value.kind === "totalGroup") totalGroup(form, value);
    if (value.kind === "order") {
      const node = select(form, l.direction, "descending", { descending: value.descending ? "yes" : "no" }, [["no", l.ascending], ["yes", l.descending]]);
      node.addEventListener("change", () => { value.descending = node.value === "yes"; });
    }
  }

  /** Expression mode is an explicit escape hatch; switching modes never reparses text in the renderer. */
  function renderEditor() {
    if (editing.dcs) { dcsForm(); return; }
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
        if (["field", "totalField"].includes(expression.kind)) expression.aggregate ||= null;
        compose(expression, editing.action.selection ?? null);
      }
    });
    form.append(accept, button(l.close, () => { editing = undefined; render(); }));
    if (editing.expression) form.append(button(editing.raw ? l.visualEditor : l.rawExpression, () => { editing.raw = !editing.raw; render(); }));
    root.append(form);
  }

  /** Render acknowledged state with tab navigation and a complete, readonly text preview. */
  function render() {
    layout.capture();
    root.replaceChildren(); if (!state) return;
    const l = state.labels, header = element("header"), actions = element("div", undefined, "header-actions");
    actions.append(button(l.apply, () => api.postMessage({ type: "apply" }), state.model.issues?.length ? "union_field_count" : null, "primary"));
    const cancel = button(l.cancel, () => api.postMessage({ type: "cancel" })); cancel.disabled = state.busy; actions.append(cancel); header.append(actions);
    const previous = selected;
    selected = Math.min(state.statement ?? selected, Math.max(0, state.model.statements.length - 1));
    if (selected !== previous) page = layout.page(selected, state.model.scopes?.[statement()?.scope]?.parent != null ? "tablesFields" : page);
    navigation(header); root.append(header);
    const catalogToggle = button(l.database, () => { layout.preferences.catalogCollapsed = !layout.collapsed(); layout.grid(); layout.save(); }, null, "catalog-toggle");
    catalogToggle.setAttribute("aria-label", l.toggleCatalog); header.append(catalogToggle);
    const status = element("span", state.busy ? l.working : state.paused ? state.pausedText : !state.model.writable ? state.reasons.read_only : l.opened, "constructor-status");
    status.setAttribute("role", "status"); header.append(status);
    if (statement()?.package?.operation === "destroy") page = "packages";
    if (state.paused) root.append(element("p", state.pausedText, "error"));
    for (const issue of state.model.issues ?? []) root.append(element("p", issue.code === "union_field_count" ? l.unionMismatch : `${l.packageIssue}: ${issue.table}${issue.column ? `.${issue.column}` : ""}`, "error"));
    const pages = [...basePages, ...(state.features.unions ? ["unions"] : []), ...(state.features.totals ? ["totals"] : []), ...(state.features.packages && !statement()?.nested ? ["packages"] : []), ...(state.features.dcs ? ["dcs"] : [])];
    if (!pages.includes(page)) page = "tablesFields";
    const scope = state.model.scopes?.[statement()?.scope];
    const used = { unions: scope?.branches.length > 1, totals: rows("totals").length > 0 || rows("totalGroups").length > 0,
      packages: state.model.scopes?.filter(scope => scope.parent === null).length > 1 || !!statement()?.package?.destination || statement()?.package?.operation === "destroy",
      dcs: statement()?.dcs?.nodes.some(node => node.enabled) };
    const tabs = element("nav", undefined, "tabs"); tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", l.sections);
    const activate = target => { layout.select(selected, target); page = target; editing = undefined; render(); document.getElementById(`tab-${target}`)?.focus(); };
    const visiblePages = pages.filter(value => basePages.includes(value) || used[value] || layout.preferences.extra.includes(value) || value === page);
    for (const value of pages) {
      const tab = button(l[value], () => activate(value)); tab.setAttribute("role", "tab"); tab.tabIndex = page === value ? 0 : -1;
      tab.hidden = !visiblePages.includes(value);
      tab.addEventListener("keydown", event => {
        const index = visiblePages.indexOf(value);
        const next = event.key === "ArrowRight" ? visiblePages[(index + 1) % visiblePages.length] : event.key === "ArrowLeft" ? visiblePages[(index + visiblePages.length - 1) % visiblePages.length]
          : event.key === "Home" ? visiblePages[0] : event.key === "End" ? visiblePages[visiblePages.length - 1] : undefined;
        if (next && !state.busy) { event.preventDefault(); activate(next); }
      });
      tab.setAttribute("aria-selected", String(page === value)); tab.id = `tab-${value}`; tab.setAttribute("aria-controls", "query-page"); tabs.append(tab);
    }
    const sectionBar = element("div", undefined, "section-bar"); sectionBar.append(tabs);
    const optional = pages.filter(value => !visiblePages.includes(value));
    if (optional.length) {
      const more = element("select"); more.setAttribute("aria-label", l.addSection); more.className = "add-section"; more.disabled = state.busy || state.paused;
      for (const value of ["", ...optional]) { const option = element("option", value ? l[value] : l.addSection); option.value = value; more.append(option); }
      more.addEventListener("change", () => { if (optional.includes(more.value)) activate(more.value); }); sectionBar.append(more);
    }
    root.append(sectionBar);
    const owner = statement(), content = element("div", undefined, "sections"); content.id = "query-page"; content.setAttribute("role", "tabpanel"); content.setAttribute("aria-labelledby", `tab-${page}`);
    if (!owner) content.append(element("p", l.empty));
    else if (owner.unavailable && page !== "dcs") content.append(element("p", state.reasons[owner.unavailable] ?? l.empty, "notice"));
    else renderPage(content);
    root.append(content); if (editing) renderEditor();
    const preview = element("details", undefined, "query-preview"), text = element("pre", state.model.text); text.id = "query-text";
    text.tabIndex = 0; text.setAttribute("aria-label", l.text); preview.append(element("summary", l.text), text); root.append(preview);
    root.setAttribute("aria-busy", String(state.busy));
    layout.mount(selected, page, state.model.revision, l);
  }

  /** While a child scope is open, parent selectors are replaced with one explicit return control. */
  function navigation(header) {
    const l = state.labels, scope = state.model.scopes?.[statement()?.scope];
    if (scope?.parent !== null && scope?.parent !== undefined) {
      header.append(button(l.backParent, () => navigate(scope.parent), null, "back-parent"));
    } else {
      const picker = element("select"); picker.setAttribute("aria-label", l.statement); picker.disabled = state.busy || state.paused;
      const statements = state.model.scopes ? state.model.scopes.filter(scope => scope.parent === null).map(scope => state.model.statements[scope.branches[0]]) : state.model.statements;
      for (const value of statements) { const option = element("option", `${l.statement} ${value.index + 1} · ${value.preview.slice(0, 50)}`); option.value = String(value.index); picker.append(option); }
      picker.value = String(scope ? scope.branches[0] : selected); picker.addEventListener("change", () => navigate(Number(picker.value))); header.append(picker);
    }
    if (scope?.branches.length > 1) {
      const picker = element("select"); picker.setAttribute("aria-label", l.branch); picker.disabled = state.busy || state.paused;
      for (const [index, id] of scope.branches.entries()) { const option = element("option", `${l.branch} ${index + 1}`); option.value = String(id); picker.append(option); }
      picker.value = String(selected); picker.addEventListener("change", () => navigate(Number(picker.value))); header.append(picker);
    }
  }

  /** Backend errors retain pending form input and never replace the last acknowledged query text. */
  window.addEventListener("message", event => {
    if (event.data?.type === "model") {
      if (state && state.model.revision !== event.data.model.revision) {
        pendingEdit = undefined;
        if (event.data.model.totalFocus !== undefined && event.data.model.totalFocus !== null) totalSection = event.data.model.totalFocus;
      }
      state = event.data; render();
    } else if (event.data?.type === "error") {
      if (pendingEdit) { editing = pendingEdit; render(); }
      const error = element("p", event.data.text, "error"); error.setAttribute("role", "alert"); root.prepend(error);
    }
  });
  api.postMessage({ type: "ready" });
})();
