/** Namespace identities are part of the layout contract, independent of XML prefixes. */
export const MD = "http://v8.1c.ru/8.3/MDClasses";
export const APP = "http://v8.1c.ru/8.2/managed-application/core";
const CORE = "http://v8.1c.ru/8.1/data/core";
const collections = new Set(["UsedMobileApplicationFunctionalities", "RequiredMobileApplicationPermissions",
  "RequiredMobileApplicationPermissions8315", "AllowedIncomingShareRequestTypes", "StandardAttributes",
  "StandardTabularSections", "UsePurposes", "ChoiceParameters", "ChoiceParameterLinks", "Content",
  "Owners", "BasedOn", "RegisterRecords", "DefaultRoles", "Documents", "XDTOPackages"]);

/** Use an optional backend caption while preserving the original token for source/search. */
export function translated(value, language, fallback) {
  return value.caption?.[language] ?? fallback;
}

/** A backend type hint distinguishes booleans from user text such as Comment="true". */
export function booleanValue(value) {
  if (value?.kind !== "text" || value.scalarType !== "boolean") return undefined;
  const text = value.text.trim();
  return text === "true" || text === "1" ? true : text === "false" || text === "0" ? false : undefined;
}

/** Distinguish a repeated collection from a record with individually named fields. */
export function isCollection(field) {
  if (field.value.kind !== "record" || !field.value.fields.length) return false;
  if (field.key.namespace === MD && collections.has(field.key.name)) return true;
  const fields = field.value.fields;
  return fields.length > 1 && fields.every(item => item.key.name === fields[0].key.name
    && item.key.namespace === fields[0].key.namespace);
}

/** Flatten only the recognized mobile functionality pair; extra fields retain their details. */
export function checklistEntry(root, field) {
  if (root.key.namespace !== MD || root.key.name !== "UsedMobileApplicationFunctionalities"
    || field.key.namespace !== APP || field.key.name !== "functionality"
    || field.qualifiers.length || field.value.kind !== "record" || field.value.fields.length !== 2) return undefined;
  const name = field.value.fields.find(item => item.key.namespace === APP && item.key.name === "functionality");
  const use = field.value.fields.find(item => item.key.namespace === APP && item.key.name === "use");
  if (name?.value.kind !== "text" || !name.value.text.trim() || name.qualifiers.length
    || !use || use.qualifiers.length || booleanValue(use.value) === undefined) return undefined;
  return { name: name.value, checked: booleanValue(use.value) };
}

/** Display exact localized-text wrappers as language rows without discarding extra annotations. */
export function localizedEntries(value) {
  if (value.kind === "localized") return value.items;
  if (value.kind !== "record" || !value.fields.length) return undefined;
  const items = [];
  for (const field of value.fields) {
    if (field.key.namespace !== CORE || field.key.name !== "item" || field.qualifiers.length
      || field.value.kind !== "record" || field.value.fields.length !== 2) return undefined;
    const language = field.value.fields.find(child => child.key.namespace === CORE && child.key.name === "lang");
    const content = field.value.fields.find(child => child.key.namespace === CORE && child.key.name === "content");
    if (language?.value.kind !== "text" || !language.value.text.trim() || language.qualifiers.length
      || content?.value.kind !== "text" || content.qualifiers.length) return undefined;
    items.push({ language: language.value.text, content: content.value.text });
  }
  return items;
}

/** Prefer a stable object identity over the repeated XML container name. */
export function identity(field, language) {
  const name = field.qualifiers.find(item => item.key.namespace === null && item.key.name === "name" && item.value.trim());
  if (name) return { title: translated(name, language, name.value), raw: name.value };
  if (field.value.kind === "text") return { title: translated(field.value, language, field.value.text), raw: field.value.text };
  if (field.value.kind === "record") {
    const candidate = field.value.fields.find(item => ["Name", "name", "functionality", "permission", "Ref"].includes(item.key.name)
      && item.value.kind === "text" && item.value.text.trim());
    if (candidate) return { title: translated(candidate.value, language, candidate.value.text), raw: candidate.value.text };
  }
  return undefined;
}

/** Include translated and technical text at every depth, without changing data or qualifiers. */
export function searchable(field, language, depth = 0) {
  if (depth > 32) return "";
  const parts = [field.key.name, translated(field, language, ""), ...field.qualifiers.flatMap(q => [q.key.name, q.value, translated(q, language, "")])];
  const view = field.presentation;
  if (view) for (const item of view.kind === "types" ? view.items : [view]) {
    parts.push(item.caption[language], item.category?.[language] ?? "", item.detail?.[language] ?? "");
  }
  if (field.value.kind === "text") parts.push(field.value.text, translated(field.value, language, ""));
  if (field.value.kind === "localized") parts.push(...field.value.items.flatMap(item => [item.language, item.content]));
  if (field.value.kind === "record") parts.push(...field.value.fields.map(item => searchable(item, language, depth + 1)));
  return parts.join(" ").toLocaleLowerCase();
}

/** A short summary gives named collection entries useful context before expansion. */
export function summary(field, language) {
  if (field.presentation?.kind === "types") return field.presentation.items.map(item => item.caption[language]).join(" · ");
  if (field.value.kind !== "record") return "";
  const parts = [];
  /** Bound traversal and text size so large records cannot dominate their collection row. */
  function visit(fields, depth) {
    for (const item of fields) {
      if (parts.length >= 3 || depth > 3) return;
      if (item.value.kind === "record") visit(item.value.fields, depth + 1);
      else if (item.value.kind === "text" && booleanValue(item.value) === undefined
        && !["Name", "name", "Comment", "functionality", "permission", "Ref"].includes(item.key.name) && item.value.text.trim()) {
        const text = translated(item.value, language, item.value.text).replace(/\s+/gu, " ");
        parts.push(`${translated(item, language, item.key.name)}: ${text.slice(0, 70)}`);
      }
    }
  }
  visit(field.value.fields, 0);
  return parts.join(" · ");
}

/** Expansion paths are independent of captions and of unrelated sibling insertions. */
export function childrenWithPaths(fields, parent) {
  const occurrences = new Map();
  return fields.map(field => {
    const id = JSON.stringify([field.key.namespace, field.key.name,
      field.qualifiers.filter(q => q.key.name === "name").map(q => [q.key.namespace, q.value])]);
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    return { field, path: `${parent}/${id}/${occurrence}` };
  });
}
