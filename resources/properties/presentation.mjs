/** Create semantic rows from backend annotations without parsing XML tokens in the client. */
export function presentationView(document, view, language, labels, icons, openReference) {
  /** Workspace captions always enter the DOM as text. */
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const group = element("div", "semantic-values");
  if (view.kind === "empty") {
    group.append(element("span", "empty-value", view.caption[language]));
    return group;
  }
  for (const item of view.kind === "types" ? view.items : [view]) {
    const row = element("div", "semantic-row");
    const artwork = icons?.[item.metadataKind];
    if (artwork) {
      const icon = element("span", "reference-icons");
      icon.setAttribute("aria-hidden", "true");
      for (const [theme, uri] of Object.entries(artwork)) {
        const image = element("img", `reference-icon icon-${theme}`);
        image.src = uri;
        image.alt = "";
        icon.append(image);
      }
      row.append(icon);
    }
    const content = element("div", "semantic-content");
    const title = element("div", "semantic-title");
    const linked = item.status === "resolved" && item.target;
    const name = element(linked ? "button" : "span", linked ? "reference-link" : "reference-name", item.caption[language]);
    if (linked) {
      name.type = "button";
      name.addEventListener("click", () => openReference(item.target));
    }
    title.append(name);
    if (item.category) title.append(element("span", "reference-category", item.category[language]));
    content.append(title);
    if (item.detail) content.append(element("div", "type-constraints", item.detail[language]));
    if (item.status === "missing" || item.status === "unavailable") {
      content.append(element("div", "reference-status", item.status === "missing" ? labels.referenceMissing : labels.referenceUnavailable));
    }
    row.append(content);
    group.append(row);
  }
  return group;
}

/** Show exact names, namespaces, annotations and scalar text in a copyable technical view. */
export function technicalText(field, depth = 0) {
  if (depth > 32) return "";
  const indent = "  ".repeat(depth);
  const name = key => key.namespace ? `{${key.namespace}}${key.name}` : key.name;
  const lines = [`${indent}${name(field.key)}`];
  for (const qualifier of field.qualifiers) lines.push(`${indent}  @${name(qualifier.key)} = ${qualifier.value}`);
  if (field.value.kind === "text") lines.push(`${indent}  ${JSON.stringify(field.value.text)}`);
  else if (field.value.kind === "localized") {
    for (const item of field.value.items) lines.push(`${indent}  ${item.language}: ${JSON.stringify(item.content)}`);
  } else if (field.value.kind === "record") {
    for (const child of field.value.fields) lines.push(technicalText(child, depth + 1));
  } else lines.push(`${indent}  ${field.value.issue}`);
  return lines.join("\n");
}

/** Offer details only when the main view abbreviates or interprets source information. */
export function hasTechnicalDetails(field) {
  return Boolean(field.presentation || field.qualifiers.length || field.value.caption
    || (field.value.kind === "record" && field.value.fields.some(hasTechnicalDetails)));
}
