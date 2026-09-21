import type { ProjectInfo } from "./protocol.js";
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
  "predefined-item": "predefined-item",
  "accounting-flag": "check",
  "ext-dimension-accounting-flag": "check",
  "column": "attribute",
  "url-template": "link",
  "operation": "method",
  "integration-service-channel": "exchange"
};

// Collections have their own silhouettes where object artwork would repeat.
export const collectionIcons: Readonly<Record<string, string>> = {
  "command-group": "command-group",
  "common-attribute": "common-attributes",
  "common-command": "common-commands",
  "common-form": "common-forms",
  "common-template": "common-templates",
  "defined-type": "defined-type",
  "document-journal": "document-journal",
  "functional-option-parameter": "option-parameters",
  "integration-service": "integration-service",
  "sequence": "sequence",
  "session-parameter": "session-parameters",
  "style-item": "style-item",
  "web-service": "web-service",
  "web-socket-client": "web-socket-client",
  "addressing-attribute": "addressing-attributes",
  "attribute": "attributes",
  "requisite": "requisites",
  "enum-value": "enum-values",
  "predefined-item": "predefined-data",
  "accounting-flag": "accounting-flag",
  "ext-dimension-accounting-flag": "dimension-flag",
  "column": "columns",
  "url-template": "url-template",
  "operation": "operations",
  "integration-service-channel": "integration-channel"
};

export const projectIcons: Readonly<Record<ProjectInfo["type"], string>> = {
  configuration: "configuration",
  extension: "extension",
  report: "report",
  processing: "data-processor"
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
export function iconName(node: MetadataNode, projectType?: ProjectInfo["type"]): string {
  const id = node.id;
  if (id.kind === "object" && node.parent === null && projectType) {
    return Object.hasOwn(projectIcons, projectType) ? projectIcons[projectType] : "unknown";
  }
  if (id.kind === "module") return Object.hasOwn(moduleIcons, id.role) ? moduleIcons[id.role]! : "unknown";
  if (id.kind === "collection") {
    if (id.collection.kind === "common") return "common";
    if (id.collection.kind === "modules") return "modules";
    if (id.collection.kind === "metadata") {
      const kind = id.collection.metadataKind;
      return Object.hasOwn(collectionIcons, kind) ? collectionIcons[kind]! : knownKind(kind);
    }
    return "unknown";
  }
  return knownKind(node.metadataKind);
}

/** No inference from labels, paths or opaque object IDs, including for older backends. */
function knownKind(kind: string | null | undefined): string {
  return kind && Object.hasOwn(metadataIcons, kind) ? metadataIcons[kind]! : "unknown";
}
