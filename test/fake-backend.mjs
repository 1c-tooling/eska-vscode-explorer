import { API_VERSION, MAX_HEADER, MAX_REQUEST, MAX_RESPONSE } from "../out/protocol.js";

const mode = process.argv[2] ?? "ok";
let input = Buffer.alloc(0);
let initialized = false;
let opening = 0;
const cancellable = new Map();

/** Independent writer prevents transport tests from sharing the encoder under test. */
function send(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`);
  process.stdout.write(bytes);
}

/** A deliberately small peer exposes crash, timeout and protocol incompatibility paths. */
function handle(request) {
  const ok = (result) => send({ jsonrpc: "2.0", id: request.id, result });
  if (request.method === '$/cancelRequest') {
    const pending = cancellable.get(request.params.id);
    if (pending) {
      clearTimeout(pending);
      cancellable.delete(request.params.id);
      send({ jsonrpc: '2.0', id: request.params.id, error: { code: -32000, message: 'Request failed', data: { kind: 'cancelled' } } });
    }
    return;
  }
  if (request.method === 'test/cancellable') {
    cancellable.set(request.id, setTimeout(() => { cancellable.delete(request.id); ok('done'); }, 200));
    return;
  }
  if (request.method === 'test/late') { setTimeout(() => ok('late'), 100); return; }
  if (mode === "hang") return;
  if (mode === "crash") process.exit(7);
  if (mode === "garbage") { process.stdout.write("ordinary command help\r\n\r\n"); return; }
  if (request.method === "initialize") {
    initialized = true;
    const result = { apiVersion: mode === "incompatible" ? { major: 2, minor: 0 } : API_VERSION,
      server: { name: "eska", version: "test" },
      capabilities: { search: true, clientFileEvents: true, designerXml: true, readOnly: true, multiContext: false },
      limits: { maxHeaderBytes: MAX_HEADER, maxRequestBytes: MAX_REQUEST, maxResponseBytes: MAX_RESPONSE } };
    if (mode === "slow") setTimeout(() => ok(result), 200);
    else ok(result);
  } else if (request.method === "workspace/open") {
    if (!initialized) process.exit(8);
    if (mode === "missing-manifest") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Request failed",
        data: { kind: "project_open_failed", details: { reason: "manifest_missing" } } } });
      return;
    }
    const path = request.params.start;
    ok({ sessionId: `session-${++opening}`, projects: [{ projectId: "project-1", type: "configuration",
      scope: { kind: "standalone" }, rootPath: path, sourcePath: path,
      root: { kind: "object", objectId: "opaque-root" }, generation: "9007199254740993",
      eventSequence: "0", requiresRefresh: false, requiresReopen: false }] });
  } else if (request.method === "shutdown") {
    if (mode !== "ignore-shutdown") ok(null);
  } else if (request.method === "exit") process.exit(0);
  else if (request.method === "test/crash") process.exit(9);
  else if (request.method === "test/noisy-crash") {
    process.stderr.write('n'.repeat(20000), () => process.stderr.write('LATE_PANIC_REASON', () => process.exit(17)));
  } else if (request.method === "test/error") {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "PRIVATE_RESPONSE_BODY",
      data: { kind: "xml_invalid", details: { reason: "malformed", path: { value: "Catalogs/Товары.xml", encoding: "utf-8" },
        body: "PRIVATE_RESPONSE_BODY" } } } });
  } else if (request.method === "test/truncated") {
    process.stdout.write('Content-Length: 100\r\n\r\n{}', () => process.exit(19));
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const end = input.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(input.subarray(0, end).toString().split(":")[1]);
    if (input.length < end + 4 + length) return;
    const request = JSON.parse(input.subarray(end + 4, end + 4 + length));
    input = input.subarray(end + 4 + length);
    handle(request);
  }
});
process.stdin.on("end", () => process.exit(0));
