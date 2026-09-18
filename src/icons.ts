import type { MetadataNode } from "./tree.js";

// Presentation mapping only; all semantic kinds are supplied by the backend.
export const metadataIcons: Readonly<Record<string, string>> = {
  "configuration": "configuration",
  "data-processor": "data-processor",
  "report": "report",
  "accounting-register": "accounting-register",
  "accumulation-register": "accumulation-register",
  "bot": "bot",
  "business-process": "business-process",
  "calculation-register": "calculation-register",
  "catalog": "catalog",
  "common-module": "common-module",
  "constant": "constant",
  "document": "document",
  "enum": "enum",
  "external-data-source": "external-data-source",
  "information-register": "information-register",
  "language": "language",
  "role": "role",
  "form": "form",
  "template": "template",
  "command": "command",
  "attribute": "attribute",
  "tabular-section": "tabular-section",
  "dimension": "dimension",
  "resource": "resource",
  "recalculation": "recalculation",
  "method": "method",
  "parameter": "parameter",
  "chart-of-accounts": "accounts",
  "chart-of-calculation-types": "calculation-types",
  "chart-of-characteristic-types": "characteristic-types",
  "command-group": "folder",
  "common-attribute": "attribute",
  "common-command": "command",
  "common-form": "form",
  "common-picture": "picture",
  "common-template": "template",
  "defined-type": "parameter",
  "document-journal": "document",
  "document-numerator": "number",
  "event-subscription": "event",
  "exchange-plan": "exchange",
  "filter-criterion": "filter",
  "functional-option": "option",
  "functional-option-parameter": "parameter",
  "http-service": "service",
  "integration-service": "exchange",
  "scheduled-job": "clock",
  "sequence": "exchange",
  "session-parameter": "parameter",
  "settings-storage": "storage",
  "style": "palette",
  "style-item": "palette",
  "subsystem": "folder",
  "task": "check",
  "web-service": "service",
  "web-socket-client": "exchange",
  "ws-reference": "link",
  "xdto-package": "package",
  "addressing-attribute": "attribute",
  "requisite": "attribute",
  "enum-value": "enum",
  "accounting-flag": "check",
  "ext-dimension-accounting-flag": "check",
  "column": "attribute",
  "url-template": "link",
  "operation": "method",
  "integration-service-channel": "exchange"
};

export const moduleIcons: Readonly<Record<string, string>> = {
  "module": "module",
  "object": "module",
  "manager": "module",
  "record-set": "module",
  "value-manager": "module",
  "managed-application": "module",
  "ordinary-application": "module",
  "session": "module",
  "external-connection": "module",
  "command": "module"
};

/** Unknown backend kinds never become paths or alter the shape of the metadata tree. */
export function iconName(node: MetadataNode): string {
  const id = node.id;
  if (id.kind === "module") return Object.hasOwn(moduleIcons, id.role) ? moduleIcons[id.role]! : "unknown";
  if (id.kind === "collection") {
    if (id.collection.kind === "common") return "common";
    if (id.collection.kind === "modules") return "modules";
    if (id.collection.kind === "metadata") return knownKind(id.collection.metadataKind);
    return "unknown";
  }
  return knownKind(node.metadataKind);
}

/** No inference from labels, paths or opaque object IDs, including for older backends. */
function knownKind(kind: string | null | undefined): string {
  return kind && Object.hasOwn(metadataIcons, kind) ? metadataIcons[kind]! : "unknown";
}
