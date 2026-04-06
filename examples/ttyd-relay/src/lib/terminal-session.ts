import {
  OUTPUT,
  SET_WINDOW_TITLE,
  SET_PREFERENCES,
  INPUT,
  RESIZE_TERMINAL,
  PAUSE,
  RESUME,
} from "./protocol";
import type { ViewerMessage, ServerMessage } from "./protocol";

import { DurableObject } from "cloudflare:workers";

const MAX_VIEWERS = 10;
const MAX_PAYLOAD_SIZE = 1024 * 1024;
const AUTO_EMIT_BASE_MS = 1000;
const AUTO_EMIT_MAX_MS = 30000;

interface WsAttachment {
  role: "terminal" | "viewer";
  tab?: string;
}

export class TerminalSession extends DurableObject {
  private urlWriters: Array<WritableStreamDefaultWriter<Uint8Array>> = [];
  private pendingTabs: string[] = [];
  private autoEmitAttempts = 0;
  private autoEmitCounter = 0;
  private autoEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingTerminal = false;
  private sessionId: string | null = null;
  private sessionHost: string | null = null;
  private sessionProto: "ws:" | "wss:" | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    this.updateSessionContext(url);

    // Streaming /urls endpoint — blocks until viewer sends new_tab messages
    if (path.endsWith("/urls")) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      this.urlWriters.push(writer);
      this.flushPendingTabs(writer);
      this.ensureAutoEmitLoop();

      // Clean up when client disconnects
      request.signal.addEventListener("abort", () => {
        const idx = this.urlWriters.indexOf(writer);
        if (idx >= 0) this.urlWriters.splice(idx, 1);
        writer.close().catch(() => {});
        this.ensureAutoEmitLoop();
      });

      return new Response(readable, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Not found", { status: 404 });
    }

    // /ws/terminal/:tabId
    const terminalMatch = path.match(/\/ws\/terminal\/([^/]+)$/);
    if (terminalMatch) {
      const tabId = terminalMatch[1];
      if (!/^[a-zA-Z0-9_-]+$/.test(tabId)) {
        return new Response("Invalid tab ID", { status: 400 });
      }
      return this.handleTerminalUpgrade(request, tabId);
    }

    // /ws/viewer
    if (path.endsWith("/ws/viewer")) {
      const viewerCount = this.ctx.getWebSockets().filter((ws) => {
        const att = (ws as any).deserializeAttachment() as WsAttachment;
        return att.role === "viewer";
      }).length;
      if (viewerCount >= MAX_VIEWERS) {
        return new Response("Too many viewers", { status: 429 });
      }
      return this.handleViewerUpgrade(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private updateSessionContext(url: URL): void {
    const match = url.pathname.match(/^\/session\/([^/]+)\//);
    if (!match) return;
    this.sessionId ??= match[1];
    this.sessionHost ??= url.host;
    this.sessionProto ??= url.protocol === "https:" ? "wss:" : "ws:";
  }

  private removeUrlWriter(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    const idx = this.urlWriters.indexOf(writer);
    if (idx >= 0) this.urlWriters.splice(idx, 1);
  }

  private observeTabId(tabId: string): void {
    const match = tabId.match(/^t(\d+)$/);
    if (!match) return;
    this.autoEmitCounter = Math.max(this.autoEmitCounter, Number(match[1]));
  }

  private nextAutoTabId(): string {
    const reserved = new Set([...this.pendingTabs, ...this.getTerminalTabs()]);
    while (true) {
      const tabId = `t${++this.autoEmitCounter}`;
      if (!reserved.has(tabId)) return tabId;
    }
  }

  private resetAutoEmitLoop(): void {
    if (this.autoEmitTimer) clearTimeout(this.autoEmitTimer);
    this.autoEmitTimer = null;
    this.autoEmitAttempts = 0;
    this.awaitingTerminal = false;
  }

  private scheduleNextRetry(): void {
    if (this.autoEmitTimer || this.urlWriters.length === 0 || this.getTerminalTabs().length > 0) return;
    const delayMs = Math.min(AUTO_EMIT_BASE_MS * (2 ** this.autoEmitAttempts), AUTO_EMIT_MAX_MS);
    this.autoEmitAttempts += 1;
    if (this.autoEmitTimer) clearTimeout(this.autoEmitTimer);
    this.autoEmitTimer = setTimeout(() => {
      this.autoEmitTimer = null;
      this.maybeAutoEmitUrl();
    }, delayMs);
  }

  private ensureAutoEmitLoop(): void {
    if (this.urlWriters.length === 0) {
      this.resetAutoEmitLoop();
      return;
    }
    if (this.getTerminalTabs().length > 0) {
      this.resetAutoEmitLoop();
      return;
    }
    if (this.autoEmitTimer) return;
    if (this.awaitingTerminal) {
      this.scheduleNextRetry();
      return;
    }
    this.maybeAutoEmitUrl();
  }

  private maybeAutoEmitUrl(): void {
    if (this.urlWriters.length === 0) {
      this.resetAutoEmitLoop();
      return;
    }
    if (this.getTerminalTabs().length > 0) {
      this.resetAutoEmitLoop();
      return;
    }
    const tabId = this.pendingTabs[0] || this.nextAutoTabId();
    if (!this.pendingTabs.includes(tabId)) this.pendingTabs.push(tabId);
    this.emitUrl(tabId);
    this.awaitingTerminal = true;
    this.scheduleNextRetry();
  }

  private queuePendingTab(tabId: string): void {
    this.observeTabId(tabId);
    if (!this.pendingTabs.includes(tabId)) this.pendingTabs.push(tabId);
  }

  private removePendingTab(tabId: string): void {
    this.pendingTabs = this.pendingTabs.filter((pendingTab) => pendingTab !== tabId);
  }

  private handleTerminalUpgrade(request: Request, tabId: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.removePendingTab(tabId);
    this.observeTabId(tabId);

    // Make tab ID unique if another terminal already uses this name
    let uniqueTabId = tabId;
    const existingTabs = this.getTerminalTabs();
    if (existingTabs.includes(tabId)) {
      let suffix = 2;
      while (existingTabs.includes(`${tabId}-${suffix}`)) suffix++;
      uniqueTabId = `${tabId}-${suffix}`;
    }

    const attachment: WsAttachment = { role: "terminal", tab: uniqueTabId };
    this.ctx.acceptWebSocket(server);
    (server as any).serializeAttachment(attachment);
    this.resetAutoEmitLoop();

    this.broadcastToViewers({ type: "tab_added", tab: uniqueTabId });

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleViewerUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const attachment: WsAttachment = { role: "viewer" };
    this.ctx.acceptWebSocket(server);
    (server as any).serializeAttachment(attachment);

    const tabs = this.getTerminalTabs();
    server.send(
      JSON.stringify({
        type: "tab_list",
        tab: "",
        tabs,
      } satisfies ServerMessage)
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = (ws as any).deserializeAttachment() as WsAttachment;
    if (attachment.role === "terminal") {
      this.handleTerminalMessage(attachment.tab!, message);
    } else if (attachment.role === "viewer") {
      this.handleViewerMessage(message);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const attachment = (ws as any).deserializeAttachment() as WsAttachment;
    if (attachment.role === "terminal" && attachment.tab) {
      this.broadcastToViewers({ type: "tab_removed", tab: attachment.tab });
      this.ensureAutoEmitLoop();
    }
    try { ws.close(code, reason); } catch {}
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {}

  private handleTerminalMessage(tabId: string, message: string | ArrayBuffer): void {
    if (typeof message === "string") return;
    const buf = new Uint8Array(message);
    if (buf.length === 0 || buf.length > MAX_PAYLOAD_SIZE) return;

    const cmd = buf[0];
    const payload = buf.slice(1);
    let serverMsg: ServerMessage;

    switch (cmd) {
      case OUTPUT:
        serverMsg = { type: "output", tab: tabId, data: arrayBufferToBase64(payload) };
        break;
      case SET_WINDOW_TITLE:
        serverMsg = { type: "title", tab: tabId, data: arrayBufferToBase64(payload) };
        break;
      case SET_PREFERENCES:
        serverMsg = { type: "prefs", tab: tabId, data: arrayBufferToBase64(payload) };
        break;
      default:
        return;
    }

    this.broadcastToViewers(serverMsg);
  }

  private emitUrl(tabId: string): void {
    if (!this.sessionId || !this.sessionHost || !this.sessionProto) return;
    this.observeTabId(tabId);
    this.removePendingTab(tabId);
    const encoder = new TextEncoder();
    const url = `${this.sessionProto}//${this.sessionHost}/session/${this.sessionId}/ws/terminal/${tabId}`;
    const line = encoder.encode(url + "\n");
    for (const writer of this.urlWriters) {
      void writer.write(line).catch(() => {
        this.removeUrlWriter(writer);
        void writer.close().catch(() => {});
      });
    }
  }

  private flushPendingTabs(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    if (!this.sessionId || !this.sessionHost || !this.sessionProto || this.pendingTabs.length === 0) return;
    const encoder = new TextEncoder();
    const pendingTabs = [...this.pendingTabs];
    this.pendingTabs = [];
    for (const tabId of pendingTabs) {
      const url = `${this.sessionProto}//${this.sessionHost}/session/${this.sessionId}/ws/terminal/${tabId}`;
      void writer.write(encoder.encode(url + "\n")).catch(() => {
        this.removeUrlWriter(writer);
        void writer.close().catch(() => {});
      });
    }
    this.awaitingTerminal = true;
    this.scheduleNextRetry();
  }

  private handleViewerMessage(message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    if (message.length > 65536) return;

    let msg: ViewerMessage;
    try { msg = JSON.parse(message); } catch { return; }

    if (msg.type === "new_tab") {
      if (!msg.tab || !/^[a-zA-Z0-9_-]+$/.test(msg.tab)) return;
      if (this.urlWriters.length > 0) {
        this.emitUrl(msg.tab);
        this.awaitingTerminal = true;
        this.autoEmitAttempts = 0;
        this.scheduleNextRetry();
      } else {
        this.queuePendingTab(msg.tab);
        this.ensureAutoEmitLoop();
      }
      return;
    }

    if (!msg.tab || !/^[a-zA-Z0-9_-]+$/.test(msg.tab)) return;

    const terminalWs = this.findTerminalSocket(msg.tab);
    if (!terminalWs) return;

    const encoder = new TextEncoder();
    let cmdByte: number;
    let payload: Uint8Array;

    switch (msg.type) {
      case "input": {
        cmdByte = INPUT;
        payload = base64ToArrayBuffer(msg.data ?? "");
        if (payload.length > 16384) return;
        break;
      }
      case "resize": {
        cmdByte = RESIZE_TERMINAL;
        if (msg.data) {
          payload = base64ToArrayBuffer(msg.data);
          if (payload.length > 8192) return;
        } else {
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (!Number.isInteger(cols) || !Number.isInteger(rows) ||
              cols < 1 || cols > 500 || rows < 1 || rows > 500) return;
          payload = encoder.encode(JSON.stringify({ columns: cols, rows: rows }));
        }
        break;
      }
      case "pause": cmdByte = PAUSE; payload = new Uint8Array(0); break;
      case "resume": cmdByte = RESUME; payload = new Uint8Array(0); break;
      default: return;
    }

    const buf = new Uint8Array(1 + payload.length);
    buf[0] = cmdByte;
    buf.set(payload, 1);
    terminalWs.send(buf.buffer);
  }

  private getTerminalTabs(): string[] {
    return this.ctx.getWebSockets()
      .map((ws) => (ws as any).deserializeAttachment() as WsAttachment)
      .filter((a) => a.role === "terminal" && a.tab)
      .map((a) => a.tab!);
  }

  private findTerminalSocket(tabId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const a = (ws as any).deserializeAttachment() as WsAttachment;
      if (a.role === "terminal" && a.tab === tabId) return ws;
    }
    return null;
  }

  private broadcastToViewers(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const a = (ws as any).deserializeAttachment() as WsAttachment;
      if (a.role === "viewer") {
        try { ws.send(json); } catch { try { ws.close(1011, "send failed"); } catch {} }
      }
    }
  }
}

function arrayBufferToBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

function base64ToArrayBuffer(base64: string): Uint8Array {
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
