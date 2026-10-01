/** Keep editor addresses independent of property captions and JSON object key order. */
export function fieldId(path) { return JSON.stringify(path); }

/** A property owns only leaves explicitly advertised in the backend's closed editing schema. */
export function editableFields(property, editing) {
  if (!editing?.unlocked) return [];
  return (editing.schema?.fields ?? []).map((field, index) => ({ field, index }))
    .filter(({ field }) => field.path[0].key.name === property.key.name && field.path[0].key.namespace === property.key.namespace);
}

/** Extract collection identities for readable labels without using them as write addresses. */
function fieldLabel(property, field, language) {
  if (field.language) return field.language;
  let node = property;
  const labels = [];
  for (let i = 1; i < field.path.length; i++) {
    const step = field.path[i];
    node = node?.value.kind === "record" ? node.value.fields.filter(child => child.key.name === step.key.name && child.key.namespace === step.key.namespace)[step.occurrence] : undefined;
    const identity = node?.qualifiers.find(item => item.key.name === "name");
    const link = step.key.name === "Link" && step.key.namespace === "http://v8.1c.ru/8.3/xcf/readable";
    const discriminator = node?.value.kind === "record" ? node.value.fields.find(child => (link ? child.key.name === "Name" : ["functionality", "permission"].includes(child.key.name)) && child.value.kind === "text") : undefined;
    if (identity) labels.push(identity.caption?.[language] ?? identity.value);
    else if (discriminator) labels.push(discriminator.value.caption?.[language] ?? discriminator.value.text);
    else if (i === field.path.length - 1 && !(step.key.name === "use" && labels.length)) labels.push(field.captions[i]?.[language] ?? step.key.name);
  }
  return labels.join(" · ");
}

/** Render only typed controls; XML strings, paths and namespace prefixes never enter markup. */
export function editorView(document, property, fields, snapshot, post) {
  const group = document.createElement("div");
  group.className = "property-editors";
  for (const { field, index } of fields) {
    const id = fieldId(field.path);
    const draft = snapshot.editing.drafts[id];
    const value = draft?.kind === "text" ? draft.value : field.value;
    const row = document.createElement("div");
    row.className = "property-editor";
    const label = document.createElement("label");
    const typeCount = fields.filter(item => item.field.schema.kind === "dataType").length;
    const name = field.schema.kind === "reference" ? (fields.length > 1 ? snapshot.labels.item.replace("{0}", String(field.path.at(-1).occurrence + 1)) : "")
      : field.schema.kind === "dataType" ? (typeCount > 1 ? snapshot.labels.item.replace("{0}", String(field.path.at(-1).occurrence + 1)) : "")
      : fields.length === 1 && (field.path.length === 1 || field.language) ? "" : fieldLabel(property, field, snapshot.language);
    label.textContent = name;
    const controlId = `edit-${index}`;
    label.htmlFor = controlId;
    const schema = field.schema;
    const control = document.createElement(schema.kind === "enum" ? "select" : ["dataType", "reference", "value"].includes(schema.kind) ? "button"
      : schema.kind === "text" && (value.includes("\n") || field.path.at(-1).key.name === "Comment") ? "textarea" : "input");
    control.id = controlId;
    control.dataset.editId = id;
    control.className = schema.kind === "boolean" ? "boolean-checkbox" : "property-input";
    control.disabled = snapshot.editing.busy || snapshot.editing.blocked;
    control.setAttribute("aria-label", name || property.caption?.[snapshot.language] || property.key.name);
    const send = (type, change) => post({ type, revision: snapshot.revision, field: index, ...(change ? { change } : {}) });
    if (["dataType", "reference", "value"].includes(schema.kind)) {
      control.type = "button";
      control.textContent = `${snapshot.editing.draftTitles?.[id] ?? field.caption?.[snapshot.language] ?? (field.value || snapshot.labels.unset)} ▾`;
      control.title = schema.kind === "value" ? snapshot.labels.chooseValue : schema.kind === "reference" ? snapshot.labels.chooseReference : snapshot.labels.changeType;
      control.addEventListener("click", () => send(schema.kind === "value" ? "pickValue" : schema.kind === "reference" ? "pickReference" : "pickType"));
      if (draft) {
        const actions = document.createElement("div");
        actions.className = "draft-actions";
        const apply = document.createElement("button");
        apply.type = "button"; apply.className = "draft-save"; apply.textContent = snapshot.labels.apply;
        apply.disabled = control.disabled;
        apply.addEventListener("click", () => send("applyDraft"));
        const cancel = document.createElement("button");
        cancel.type = "button"; cancel.className = "draft-save"; cancel.textContent = snapshot.labels.cancel;
        cancel.disabled = snapshot.editing.busy;
        cancel.addEventListener("click", () => send("cancelDraft"));
        actions.append(apply, cancel);
        row.append(actions);
      }
    } else {
      if (schema.kind === "boolean") { control.type = "checkbox"; control.checked = value === "true" || value === "1"; }
      else if (schema.kind === "enum") {
        for (const item of field.options ?? []) {
          const option = document.createElement("option");
          option.value = item.value;
          option.textContent = item.caption?.[snapshot.language] ?? item.value;
          control.append(option);
        }
        control.value = value;
      } else {
        control.value = value;
        if (control.tagName === "TEXTAREA") control.rows = Math.min(8, Math.max(2, value.split("\n").length));
        else control.type = "text";
        const integer = schema.kind === "integer" || schema.kind === "unsignedInteger";
        if (integer || schema.kind === "decimal") control.inputMode = integer ? "numeric" : "decimal";
        if (integer) {
          const hint = document.createElement("small");
          hint.id = `${controlId}-range`; hint.className = "property-constraint";
          hint.textContent = snapshot.labels.integerRange.replace("{0}", String(schema.min)).replace("{1}", String(schema.max));
          control.setAttribute("aria-describedby", hint.id);
          row.append(hint);
        }
        if (schema.kind === "text" && schema.domain === "choiceParameterName") {
          const hint = document.createElement("small");
          hint.id = `${controlId}-constraint`; hint.className = "property-constraint";
          hint.textContent = snapshot.labels.choiceParameterName;
          control.setAttribute("aria-describedby", hint.id);
          row.append(hint);
        }
        if (schema.nullable) control.placeholder = snapshot.labels.unset;
        control.autocomplete = "off";
        control.spellcheck = false;
      }
      /** Explicit actions send semantic values; escaping and validation belong to the backend. */
      const change = () => ({ kind: "text", value: schema.kind === "boolean" ? String(control.checked) : control.value });
      const apply = document.createElement("button");
      apply.type = "button"; apply.className = "draft-save"; apply.textContent = snapshot.labels.apply;
      apply.hidden = !draft; apply.disabled = control.disabled;
      apply.addEventListener("click", () => send("commit", change()));
      control.addEventListener("input", () => {
        const proposal = change();
        if (proposal.value === field.value) delete snapshot.editing.drafts[id];
        else snapshot.editing.drafts[id] = proposal;
        apply.hidden = proposal.value === field.value;
        send("draft", proposal);
      });
      if (["boolean", "enum"].includes(schema.kind)) control.addEventListener("change", () => send("commit", change()));
      else {
        control.addEventListener("blur", () => { if (control.value !== field.value) send("commit", change()); });
        control.addEventListener("keydown", event => {
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation();
            control.value = field.value; delete snapshot.editing.drafts[id]; apply.hidden = true;
            send("cancelDraft");
          } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault(); send("commit", change());
          }
        });
      }
      row.append(apply);
    }
    if (schema.kind === "boolean") {
      label.textContent = name || property.caption?.[snapshot.language] || property.key.name;
      row.classList.add("boolean-editor");
      row.prepend(control, label);
    } else {
      row.prepend(label, control);
      if (!name) label.hidden = true;
    }
    group.append(row);
  }
  return group;
}
