const vscode = acquireVsCodeApi();
const search = document.getElementById("search");
const items = document.getElementById("items");
const notice = document.getElementById("notice");
const count = document.getElementById("count");
const refresh = document.getElementById("refresh");
let snapshot;

search.value = vscode.getState()?.query ?? "";
search.addEventListener("input", () => {
  vscode.setState({ query: search.value });
  render();
});
refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
window.addEventListener("message", event => {
  if (event.data?.type !== "state") return;
  snapshot = event.data;
  render();
});

/** Create text nodes for metadata values so XML content cannot become markup. */
function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

/** Use backend captions so object context and platform vocabulary stay consistent. */
function caption(field) {
  return field.caption?.[snapshot.language];
}

/** Show the platform caption beside its exact Designer XML name. */
function appendPropertyName(container, field) {
  const { key } = field;
  const translated = caption(field);
  container.append(document.createTextNode(translated ?? key.name));
  if (translated && translated !== key.name) container.append(element("span", "technical-name", key.name));
}

/** Designer's exact boolean text is a display hint; other scalar text stays unchanged. */
function booleanValue(value) {
  if (value?.kind !== "text") return undefined;
  if (value.text === "true") return true;
  if (value.text === "false") return false;
  return undefined;
}

/** A disabled native checkbox exposes the value without suggesting it can be edited. */
function propertyName(tag, className, field) {
  const { key, value } = field;
  const container = element(tag, className);
  const checked = booleanValue(value);
  if (checked !== undefined) {
    const checkbox = element("input", "boolean-checkbox");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.disabled = true;
    checkbox.setAttribute("aria-label", caption(field) ?? key.name);
    container.append(checkbox);
  }
  const name = element("span", "name-text");
  appendPropertyName(name, field);
  container.append(name);
  container.title = key.namespace ?? "";
  return container;
}

/** Find nested record fields and localized values through the same search box. */
function searchable(value, depth = 0) {
  if (!value || depth > 32) return "";
  if (value.kind === "text") return value.text;
  if (value.kind === "localized") return value.items.map(item => `${item.language} ${item.content}`).join(" ");
  if (value.kind === "record") return value.fields.map(field =>
    `${field.key.name} ${caption(field) ?? ""} ${field.qualifiers.map(q => `${q.key.name} ${q.value}`).join(" ")} ${searchable(field.value, depth + 1)}`).join(" ");
  return "";
}

/** Display all backend value variants without flattening repeated record fields. */
function valueView(value, labels, depth = 0) {
  if (!value || depth > 32) return element("span", "value unsupported", labels.xmlOnly);
  if (value.kind === "text") return element("span", "value text-value", value.text || "—");
  if (value.kind === "localized") {
    const group = element("div", "localized");
    if (!value.items.length) group.append(element("span", "value", "—"));
    for (const item of value.items) {
      const row = element("div", "localized-row");
      row.append(element("span", "language", item.language), element("span", "value text-value", item.content || "—"));
      group.append(row);
    }
    return group;
  }
  if (value.kind === "record") {
    const details = element("details", "record");
    details.open = search.value.trim().length > 0;
    details.append(element("summary", "record-summary", labels.fields.replace("{0}", String(value.fields.length))));
    const fields = element("div", "fields");
    for (const field of value.fields) {
      const row = element("div", "field");
      row.append(propertyName("div", "field-name", field));
      if (booleanValue(field.value) === undefined) row.append(valueView(field.value, labels, depth + 1));
      if (field.qualifiers.length) row.append(qualifiersView(field.qualifiers));
      fields.append(row);
    }
    details.append(fields);
    return details;
  }
  return element("span", "value unsupported", labels.xmlOnly);
}

/** Keep XML annotations readable without confusing them with nested properties. */
function qualifiersView(qualifiers) {
  const group = element("div", "qualifiers");
  for (const qualifier of qualifiers) {
    const chip = element("span", "qualifier", `@${qualifier.key.name} = ${qualifier.value}`);
    chip.title = qualifier.key.namespace ?? "";
    group.append(chip);
  }
  return group;
}

/** A settings-style row has one explicit source action and a full structured value. */
function propertyView(property, labels) {
  const card = element("article", "property");
  const checked = booleanValue(property.value);
  if (checked !== undefined) card.classList.add("boolean-property");
  const head = element("div", "property-head");
  const title = propertyName("h2", "property-name", property);
  const button = element("button", "source-button", labels.openXml);
  button.type = "button";
  button.addEventListener("click", () => vscode.postMessage({ type: "openXml", index: property.index }));
  head.append(title, button);
  card.append(head);
  if (checked === undefined) card.append(valueView(property.value, labels));
  if (property.qualifiers.length) card.append(qualifiersView(property.qualifiers));
  return card;
}

/** Rebuild only the visible property rows when data or search text changes. */
function render() {
  if (!snapshot) return;
  const labels = snapshot.labels;
  document.getElementById("breadcrumb").textContent = snapshot.path;
  document.getElementById("title").textContent = snapshot.title;
  document.getElementById("read-only").textContent = labels.readOnly;
  items.setAttribute("aria-label", labels.properties);
  search.placeholder = labels.search;
  search.setAttribute("aria-label", labels.search);
  refresh.textContent = labels.refresh;
  refresh.setAttribute("aria-label", labels.refresh);
  const query = search.value.trim().toLocaleLowerCase();
  const matches = snapshot.status === "ready" ? snapshot.properties.filter(property =>
    `${property.label} ${caption(property) ?? ""} ${property.description} ${property.qualifiers.map(q => `${q.key.name} ${q.value}`).join(" ")} ${searchable(property.value)}`
      .toLocaleLowerCase().includes(query)) : [];
  count.textContent = snapshot.status === "ready" ? labels.count.replace("{0}", String(matches.length)) : "";
  notice.textContent = snapshot.notice || (snapshot.status === "ready" && !matches.length
    ? query ? labels.noMatches : labels.empty : "");
  items.replaceChildren(...matches.map(property => propertyView(property, labels)));
}

vscode.postMessage({ type: "ready" });
search.focus();
