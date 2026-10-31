import type { TextDocument } from "vscode";
import { isRecord } from "../protocol.js";
import { languageUri } from "./uri.js";

type Send = (method: string, params: Record<string, unknown>) => Promise<void>;
interface Stream {
  version: number; opened: boolean; poisoned: boolean; owner?: object; queue: Promise<void>;
  nativeSnapshot?: { document: TextDocument; version: number };
}

/** One URI has one synchronization stream, with LSP versions independent of native editor versions. */
export class LanguageDocuments {
  private readonly streams = new Map<string, Stream>();
  private readonly internal = new WeakSet<object>();
  private revision = 0;

  constructor(private readonly send: Send, private readonly native: (uri: string) => TextDocument | undefined, private readonly active: (uri: string) => boolean = () => true) {}

  /** Even a projection/restore round trip invalidates reads started against a previous server document model. */
  get epoch(): number { return this.revision; }

  /** Own notifications bypass native suppression but use the same client connection and ordering. */
  owns(params: unknown): boolean { return typeof params === "object" && params !== null && this.internal.has(params); }

  /** While projected, ordinary providers cannot request results using native owner coordinates. */
  projected(uri: string): boolean { return this.streams.get(languageUri(uri))?.owner !== undefined; }

  /** Upstream push reports have no version, so a previously projected URI needs guarded pull diagnostics until close. */
  poisoned(uri: string): boolean { return this.streams.get(languageUri(uri))?.poisoned === true; }

  /** Complete queued restoration before allowing an ordinary request against this URI. */
  async settled(uri: string): Promise<void> { await this.streams.get(languageUri(uri))?.queue; }

  /** A versioned edit must address the last synchronized native body, never a projection or an unsent buffer. */
  wireVersion(document: TextDocument): number | undefined {
    const uri = languageUri(document.uri.toString()), stream = this.streams.get(uri);
    return stream?.opened && !stream.owner && !document.isClosed && this.native(uri) === document
      && stream.nativeSnapshot?.document === document && stream.nativeSnapshot.version === document.version ? stream.version : undefined;
  }

  /** Client document bookkeeping stays intact; only its actual synchronization notifications are replaced. */
  async notification(method: string, params: unknown, forward: (params: unknown) => Promise<void>): Promise<void> {
    if (this.owns(params) || !["textDocument/didOpen", "textDocument/didChange", "textDocument/didClose", "textDocument/didSave"].includes(method)
      || !isRecord(params) || !isRecord(params.textDocument) || typeof params.textDocument.uri !== "string") return forward(params);
    const uri = languageUri(params.textDocument.uri), textDocument = params.textDocument, stream = this.stream(uri);
    if (!this.active(uri)) return this.enqueue(stream, () => this.suspend(uri, stream));
    // The client can flush a pending native open while sending this stream's projection. Suppression must not await itself.
    if (stream.owner) return;
    const document = this.native(uri), text = document?.getText();
    const snapshot = document ? { document, version: document.version } : undefined;
    return this.enqueue(stream, async () => {
      if (stream.owner) return;
      if (method === "textDocument/didClose") {
        ++this.revision;
        if (stream.opened) await this.publish("textDocument/didClose", { textDocument: { uri } });
        stream.opened = false; stream.poisoned = false; stream.version = 0; delete stream.nativeSnapshot;
        if (this.streams.get(uri) === stream && !this.native(uri)) this.streams.delete(uri);
      } else if (method === "textDocument/didSave") await forward({ ...params, textDocument: { ...textDocument, uri } });
      else if (text !== undefined) await this.body(uri, stream, text, snapshot);
    });
  }

  /** A projection is memory-only and never changes the native document or its dirty/save state. */
  async project(uri: string, text: string, owner: object): Promise<void> {
    uri = languageUri(uri);
    if (!this.active(uri)) throw new Error("language_uri_inactive");
    const stream = this.stream(uri);
    if (stream.owner && stream.owner !== owner) throw new Error("language_uri_owned");
    stream.owner = owner; stream.poisoned = true; ++this.revision;
    await this.enqueue(stream, () => this.body(uri, stream, text, undefined));
  }

  /** Release only the caller's overlay and restore the latest native body, including edits made during the session. */
  async release(uri: string, owner: object): Promise<void> {
    uri = languageUri(uri);
    const stream = this.streams.get(uri);
    if (!stream || stream.owner !== owner) return;
    delete stream.owner;
    ++this.revision;
    await this.enqueue(stream, async () => {
      const document = this.native(uri);
      if (!this.active(uri)) await this.suspend(uri, stream);
      else if (document && !document.isClosed) await this.body(uri, stream, document.getText(), { document, version: document.version });
      else {
        if (stream.opened) await this.publish("textDocument/didClose", { textDocument: { uri } });
        stream.opened = false; stream.poisoned = false; stream.version = 0; delete stream.nativeSnapshot;
        if (this.streams.get(uri) === stream && !this.native(uri)) this.streams.delete(uri);
      }
    });
  }

  /** Activity closes only wire documents; native buffers, versions and private draft owners survive. */
  async reconcileActivity(): Promise<void> {
    for (const [uri, stream] of this.streams) await this.enqueue(stream, async () => {
      if (!this.active(uri)) { await this.suspend(uri, stream); return; }
      const document = this.native(uri);
      if (document && !document.isClosed && !stream.owner
        && (!stream.opened || stream.nativeSnapshot?.document !== document || stream.nativeSnapshot.version !== document.version)) {
        await this.body(uri, stream, document.getText(), { document, version: document.version });
      }
    });
  }

  private async suspend(uri: string, stream: Stream): Promise<void> {
    if (stream.opened) { ++this.revision; await this.publish("textDocument/didClose", { textDocument: { uri } }); }
    stream.opened = false; delete stream.nativeSnapshot;
  }

  /** The per-URI tail recovers after an error so teardown can still restore or close its buffer. */
  private enqueue(stream: Stream, action: () => Promise<void>): Promise<void> {
    const pending = stream.queue.then(action); stream.queue = pending.catch(() => {}); return pending;
  }

  /** Streams begin with LSP version one; replacement texts never reuse a native version number. */
  private stream(uri: string): Stream {
    let stream = this.streams.get(uri);
    if (!stream) { stream = { version: 0, opened: false, poisoned: false, queue: Promise.resolve() }; this.streams.set(uri, stream); }
    return stream;
  }

  /** Full changes make Native/incremental and projected text transitions unambiguous for the published server. */
  private async body(uri: string, stream: Stream, text: string, snapshot: Stream["nativeSnapshot"]): Promise<void> {
    ++this.revision;
    const version = ++stream.version;
    delete stream.nativeSnapshot;
    if (!stream.opened) {
      await this.publish("textDocument/didOpen", { textDocument: { uri, languageId: "bsl", version, text } }); stream.opened = true;
    } else await this.publish("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    if (snapshot) stream.nativeSnapshot = snapshot;
  }

  /** Weak markers are local adapter state and never become custom protocol fields. */
  private async publish(method: string, params: Record<string, unknown>): Promise<void> {
    this.internal.add(params);
    try { await this.send(method, params); } finally { this.internal.delete(params); }
  }
}
