/* The renderer displays core DTOs; it never parses or generates query syntax. */
(() => {
  const api = acquireVsCodeApi(), root = document.getElementById("root");
  let state, selected = 0, editing, pendingEdit;

  /** Create labels and expressions exclusively as text, including untrusted XML/SDBL content. */
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  /** Only a user intention is sent; ESKA supplies all offsets and syntax. */
  function send(action) { if (editing) pendingEdit = { ...editing, initial: action.text }; editing = undefined; api.postMessage({ type: "action", action }); }

  /** Every disabled control carries the core's reason, translated by the native adapter. */
  function button(text, action, reason) {
    const node = element("button", text); node.type = "button";
    node.disabled = !!reason || state.busy || state.paused;
    if (reason) node.title = state.reasons[reason] ?? reason;
    node.addEventListener("click", action); return node;
  }

  /** Editing a row is a bounded expression input, never a replacement SQL document. */
  function editor(action, initial) {
    editing = { action, initial }; render();
  }

  /** Re-render exact server state after an acknowledged action; local text never becomes another canonical model. */
  function render() {
    root.replaceChildren(); if (!state) return;
    const { labels: l, model } = state, toolbar = element("header"), apply = button(l.apply, () => api.postMessage({ type: "apply" }));
    apply.className = "primary"; toolbar.append(apply);
    const cancel = button(l.cancel, () => api.postMessage({ type: "cancel" })); cancel.disabled = state.busy; toolbar.append(cancel); root.append(toolbar);
    root.append(element("p", l.notice, "notice"));
    if (state.paused) root.append(element("p", state.pausedText, "error"));
    const choices = element("select"); choices.setAttribute("aria-label", l.statement);
    for (const statement of model.statements) { const option = element("option", `${l.statement} ${statement.index + 1} · ${statement.preview.slice(0, 70)}`); option.value = String(statement.index); choices.append(option); }
    selected = Math.min(selected, Math.max(0, model.statements.length - 1)); choices.value = String(selected);
    choices.addEventListener("change", () => { selected = Number(choices.value); editing = undefined; render(); }); root.append(choices);
    const statement = model.statements[selected];
    if (!statement) root.append(element("p", l.empty));
    else if (statement.unavailable) root.append(element("p", state.reasons[statement.unavailable] ?? l.empty, "notice"));
    else {
      const sections = element("div", undefined, "sections");
      for (const option of statement.append) {
        const card = element("section"), heading = element("div", undefined, "section-title");
        heading.append(element("h2", l[option.kind]));
        heading.append(button(l.add, () => editor({ kind: "append", statement: selected, clause: option.kind }, ""), option.unavailable)); card.append(heading);
        for (const clause of statement.clauses.filter(clause => clause.kind === option.kind)) {
          if (option.kind === "joins") card.append(element("small", clause.header));
          for (const item of clause.items) {
            const row = element("div", undefined, "row"), selection = { statement: selected, clause: clause.index, item: item.index };
            row.append(element("pre", item.preview));
            const controls = element("div", undefined, "controls");
            controls.append(button(l.edit, () => editor({ kind: "replace", selection }, item.expression ?? ""), item.unavailable.replace));
            controls.append(button(l.remove, () => send({ kind: "remove", selection }), item.unavailable.remove));
            controls.append(button(l.up, () => send({ kind: "move", selection, to: item.index - 1 }), item.index === 0 ? "single_item" : item.unavailable.move));
            controls.append(button(l.down, () => send({ kind: "move", selection, to: item.index + 1 }), item.index + 1 === clause.items.length ? "single_item" : item.unavailable.move));
            row.append(controls); card.append(row);
          }
        }
        sections.append(card);
      }
      root.append(sections);
    }
    if (editing) {
      const dialog = element("section", undefined, "expression"), input = element("textarea"); input.value = editing.initial; input.rows = 4;
      input.setAttribute("aria-label", l.expression); dialog.append(element("h2", l.expression), input);
      let join;
      if (editing.action.kind === "append" && editing.action.clause === "joins") {
        join = element("select"); for (const kind of ["inner", "left", "right", "full"]) { const option = element("option", l[kind]); option.value = kind; join.append(option); } dialog.append(join);
      }
      dialog.append(button(l.submit, () => {
        if (!input.value.trim() || new TextEncoder().encode(input.value).length > state.maxExpression) { input.setCustomValidity(state.reasons.expression_too_large); input.reportValidity(); return; }
        send({ ...editing.action, text: input.value, ...(join ? { join: join.value } : {}) });
      }), button(l.close, () => { editing = undefined; render(); })); root.append(dialog); input.focus();
    }
    const details = element("details"), summary = element("summary", l.text); details.append(summary, element("pre", model.text)); root.append(details);
  }

  /** Errors are text nodes and do not replace the last acknowledged model or a user's pending input. */
  window.addEventListener("message", event => {
    if (event.data?.type === "model") {
      if (state && state.model.revision !== event.data.model.revision) pendingEdit = undefined;
      state = event.data; render();
    }
    else if (event.data?.type === "error") { if (pendingEdit) { editing = pendingEdit; render(); } const error = element("p", event.data.text, "error"); error.setAttribute("role", "alert"); root.prepend(error); }
  });
  api.postMessage({ type: "ready" });
})();
