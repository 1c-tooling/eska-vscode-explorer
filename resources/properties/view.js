import { presentationView } from "./presentation.mjs";
import { createPictureView } from "./picture.mjs";
import { booleanValue, checklistEntry, childrenWithPaths, identity, isCollection, localizedEntries, searchable, summary, translated } from "./model.mjs";

const vscode = acquireVsCodeApi();
const search = document.getElementById("search");
const items = document.getElementById("items");
const notice = document.getElementById("notice");
const count = document.getElementById("count");
const refresh = document.getElementById("refresh");
const saved = vscode.getState();
const expanded = new Map(Object.entries(saved?.expanded ?? {}).filter(([, value]) => typeof value === "boolean"));
let snapshot;
const pictureView = createPictureView(document);
search.value = saved?.query ?? "";

/** Persist only presentation state; property values remain backend-owned. */
function saveState() {
  vscode.setState({ query: search.value, expanded: Object.fromEntries(expanded) });
}
search.addEventListener("input", () => { saveState(); render(); });
refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
window.addEventListener("message", event => {
  if (event.data?.type !== "state") return;
  snapshot = event.data;
  pictureView.render(snapshot);
  render();
});

/** Workspace strings always become text nodes, never HTML. */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Display the readable caption; raw identities remain searchable and available in XML. */
function namedText(title) {
  const node = element("span", "name-text");
  node.append(element("span", "caption", title));
  return node;
}

/** Checkbox values are accessible and read-only in every layout. */
function checkbox(checked, label) {
  const node = element("input", "boolean-checkbox");
  node.type = "checkbox";
  node.checked = checked;
  node.disabled = true;
  node.setAttribute("aria-label", label);
  return node;
}

/** Property and structure labels use the same platform vocabulary. */
function propertyName(tag, className, field) {
  const node = element(tag, className);
  const title = translated(field, snapshot.language, field.key.name);
  const checked = booleanValue(field.value);
  if (checked !== undefined) node.append(checkbox(checked, title));
  node.append(namedText(title));
  return node;
}

/** A matching group name reveals the whole group; a matching child filters its siblings. */
function childQuery(field, query) {
  const own = field.value.kind === "record" ? { ...field, value: { kind: "record", fields: [] } } : field;
  return searchable(own, snapshot.language).includes(query) ? "" : query;
}

/** Native details retain keyboard behavior and restore the user's expansion choice. */
function disclosure(path, title, preview) {
  const details = element("details", "record");
  details.open = Boolean(search.value.trim()) || (expanded.get(path) ?? false);
  const heading = element("summary", "record-summary");
  heading.append(title);
  if (preview) heading.append(element("span", "record-preview", preview));
  details.append(heading);
  let open = details.open;
  details.addEventListener("toggle", () => {
    if (open === details.open) return;
    open = details.open;
    if (search.value.trim()) return;
    expanded.set(path, open);
    saveState();
  });
  return details;
}

/** Structured scalar fields align in two columns; complex children get the full width. */
function structureView(field, path, query, depth) {
  const group = element("div", "structure");
  for (const child of childrenWithPaths(field.value.fields, path)) {
    if (query && !searchable(child.field, snapshot.language).includes(query)) continue;
    const complex = child.field.value.kind === "record";
    const row = element("div", `field${complex ? " complex-field" : ""}${booleanValue(child.field.value) !== undefined ? " boolean-field" : ""}`);
    row.append(propertyName("div", "field-name", child.field));
    if (booleanValue(child.field.value) === undefined) row.append(valueView(child.field, child.path, childQuery(child.field, query), depth + 1));
    group.append(row);
  }
  return group;
}

/** Collections use names and previews instead of repeating XML wrapper fields. */
function collectionEntry(root, field, path, index, query, depth) {
  const flag = checklistEntry(root, field);
  if (flag) {
    const row = element("div", "checklist-row");
    const title = translated(flag.name, snapshot.language, flag.name.text);
    row.append(checkbox(flag.checked, title), namedText(title));
    return row;
  }
  if (field.presentation || field.value.kind !== "record") {
    const row = element("div", "collection-value");
    const checked = booleanValue(field.value);
    row.append(checked === undefined ? valueView(field, path, query, depth + 1) : propertyName("div", "field-name", field));
    return row;
  }
  const name = identity(field, snapshot.language);
  const title = namedText(name?.title ?? `${translated(field, snapshot.language, field.key.name)} · ${snapshot.labels.item.replace("{0}", String(index + 1))}`);
  const details = disclosure(path, title, summary(field, snapshot.language));
  const body = element("div", "entry-body");
  body.append(valueView(field, `${path}/body`, childQuery(field, query), depth + 1));
  details.append(body);
  return details;
}

/** Large collections have one disclosure and a meaningful count, including enabled flags. */
function collectionView(field, path, query, depth) {
  const children = childrenWithPaths(field.value.fields, path);
  const visible = children.filter(child => !query || searchable(child.field, snapshot.language).includes(query));
  const group = element("div", "collection");
  for (const [index, child] of children.entries()) {
    if (query && !searchable(child.field, snapshot.language).includes(query)) continue;
    group.append(collectionEntry(field, child.field, child.path, index, query, depth));
  }
  if (children.length <= 6) return group;
  const flags = visible.map(child => checklistEntry(field, child.field)).filter(Boolean);
  const info = flags.length ? snapshot.labels.enabled.replace("{0}", String(flags.filter(flag => flag.checked).length)).replace("{1}", String(flags.length)) : "";
  const title = element("span", "collection-count", snapshot.labels.items.replace("{0}", String(query ? visible.length : children.length)));
  const details = disclosure(path, title, info);
  details.classList.add("collection-group");
  details.append(group);
  return details;
}

/** Render full values without pushing nested records into progressively narrower columns. */
function valueView(field, path, query, depth = 0) {
  const value = field.value;
  const labels = snapshot.labels;
  if (depth > 32) return element("span", "value unsupported", labels.xmlOnly);
  if (field.presentation) {
    const revision = snapshot.revision;
    return presentationView(document, field.presentation, snapshot.language, labels, snapshot.icons,
      target => vscode.postMessage({ type: "openReference", revision, target }));
  }
  if (value.kind === "text") {
    const translatedValue = translated(value, snapshot.language, value.text);
    const node = element("div", "value text-value");
    node.append(namedText(translatedValue || "—"));
    return node;
  }
  const localized = localizedEntries(value);
  if (localized) {
    const multipleLanguages = localized.length > 1;
    const group = element("div", multipleLanguages ? "localized multilingual" : "localized");
    if (!localized.length) group.append(element("span", "value", "—"));
    for (const item of localized) {
      const row = element("div", "localized-row");
      if (multipleLanguages) row.append(element("span", "language", item.language));
      row.append(element("span", "value text-value", item.content || "—"));
      group.append(row);
    }
    return group;
  }
  if (value.kind === "record") return isCollection(field)
    ? collectionView(field, path, query, depth) : structureView(field, path, query, depth);
  return element("span", "value unsupported", labels.xmlOnly);
}

/** Capture the displayed revision so queued clicks cannot address a replacement snapshot. */
function propertyView(property, path, query) {
  const revision = snapshot.revision;
  const card = element("article", "property");
  const checked = booleanValue(property.value);
  if (checked !== undefined) card.classList.add("boolean-property");
  const head = element("div", "property-head");
  const button = element("button", "source-button", snapshot.labels.openXml);
  button.type = "button";
  button.addEventListener("click", () => vscode.postMessage({ type: "openXml", revision, index: property.index }));
  head.append(propertyName("h2", "property-name", property), button);
  card.append(head);
  if (checked === undefined) card.append(valueView(property, path, childQuery(property, query)));
  return card;
}

/** Filter inside collections and auto-reveal matches without overwriting saved expansion. */
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
  const query = search.value.trim().toLocaleLowerCase();
  const matches = snapshot.status === "ready" ? childrenWithPaths(snapshot.properties, "properties")
    .filter(({ field }) => !query || searchable(field, snapshot.language).includes(query)) : [];
  count.textContent = snapshot.status === "ready" ? labels.count.replace("{0}", String(matches.length)) : "";
  notice.textContent = snapshot.notice || (snapshot.status === "ready" && !matches.length
    ? query ? labels.noMatches : labels.empty : "");
  items.replaceChildren(...matches.map(({ field, path }) => propertyView(field, path, query)));
}

vscode.postMessage({ type: "ready" });
search.focus();
