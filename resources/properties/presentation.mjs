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
