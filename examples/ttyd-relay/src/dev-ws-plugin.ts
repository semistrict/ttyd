/**
 * Vite plugin that handles WebSocket connections in dev mode,
 * simulating the Durable Object relay locally.
 */
import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
import {
  OUTPUT,
  SET_WINDOW_TITLE,
  SET_PREFERENCES,
  INPUT,
  RESIZE_TERMINAL,
  PAUSE,
  RESUME,
} from "./lib/protocol";

import type { ServerResponse } from "http";

const AUTO_EMIT_BASE_MS = 1000;
const AUTO_EMIT_MAX_MS = 30000;

interface Tab {
  terminalWs: WebSocket | null;
}

interface Session {
  tabs: Map<string, Tab>;
  viewers: Set<WebSocket>;
  urlStreams: Set<ServerResponse>;
  pendingTabs: string[];
  autoEmitAttempts: number;
  autoEmitCounter: number;
  autoEmitTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();

function getOrCreateSession(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      tabs: new Map(),
      viewers: new Set(),
      urlStreams: new Set(),
      pendingTabs: [],
      autoEmitAttempts: 0,
      autoEmitCounter: 0,
      autoEmitTimer: null,
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function queuePendingTab(session: Session, tabId: string) {
  observeTabId(session, tabId);
  if (!session.pendingTabs.includes(tabId)) session.pendingTabs.push(tabId);
}

function removePendingTab(session: Session, tabId: string) {
  session.pendingTabs = session.pendingTabs.filter((pendingTab) => pendingTab !== tabId);
}

function observeTabId(session: Session, tabId: string) {
  const match = tabId.match(/^t(\d+)$/);
  if (!match) return;
  session.autoEmitCounter = Math.max(session.autoEmitCounter, Number(match[1]));
}

function nextAutoTabId(session: Session): string {
  const reserved = new Set([...session.pendingTabs, ...session.tabs.keys()]);
  while (true) {
    const tabId = `t${++session.autoEmitCounter}`;
    if (!reserved.has(tabId)) return tabId;
  }
}

function emitUrl(session: Session, url: string) {
  const match = url.match(/\/ws\/terminal\/([^/\n]+)$/);
  if (match) {
    observeTabId(session, match[1]);
    removePendingTab(session, match[1]);
  }
  const stale: ServerResponse[] = [];
  for (const res of session.urlStreams) {
    if (res.writableEnded || res.destroyed) {
      stale.push(res);
      continue;
    }
    try { res.write(url + "\n"); } catch { stale.push(res); }
  }
  for (const r of stale) session.urlStreams.delete(r);
}

function flushPendingTabs(session: Session, sessionId: string, host: string, res: ServerResponse) {
  if (session.pendingTabs.length === 0) return;
  const pendingTabs = [...session.pendingTabs];
  session.pendingTabs = [];
  for (const tabId of pendingTabs) {
    try { res.write(`ws://${host}/session/${sessionId}/ws/terminal/${tabId}\n`); } catch {}
  }
  session.autoEmitAttempts = 0;
  scheduleNextRetry(session, sessionId, host);
}

function resetAutoEmitLoop(session: Session) {
  if (session.autoEmitTimer) clearTimeout(session.autoEmitTimer);
  session.autoEmitTimer = null;
  session.autoEmitAttempts = 0;
}

function scheduleNextRetry(session: Session, sessionId: string, host: string) {
  if (session.autoEmitTimer || session.urlStreams.size === 0 || session.tabs.size > 0) return;
  const delay = Math.min(AUTO_EMIT_BASE_MS * (2 ** session.autoEmitAttempts), AUTO_EMIT_MAX_MS);
  session.autoEmitAttempts += 1;
  session.autoEmitTimer = setTimeout(() => {
    session.autoEmitTimer = null;
    maybeAutoEmitUrl(session, sessionId, host);
  }, delay);
}

function ensureAutoEmitLoop(session: Session, sessionId: string, host: string) {
  if (session.urlStreams.size === 0) {
    resetAutoEmitLoop(session);
    return;
  }
  if (session.tabs.size > 0) {
    resetAutoEmitLoop(session);
    return;
  }
  if (session.autoEmitTimer) return;
  if (session.autoEmitAttempts > 0) {
    scheduleNextRetry(session, sessionId, host);
    return;
  }
  maybeAutoEmitUrl(session, sessionId, host);
}

function maybeAutoEmitUrl(session: Session, sessionId: string, host: string) {
  if (session.urlStreams.size === 0) {
    resetAutoEmitLoop(session);
    return;
  }
  if (session.tabs.size > 0) {
    resetAutoEmitLoop(session);
    return;
  }
  const tabId = session.pendingTabs[0] || nextAutoTabId(session);
  if (!session.pendingTabs.includes(tabId)) session.pendingTabs.push(tabId);
  emitUrl(session, `ws://${host}/session/${sessionId}/ws/terminal/${tabId}`);
  scheduleNextRetry(session, sessionId, host);
}

function broadcastToViewers(session: Session, msg: object) {
  const json = JSON.stringify(msg);
  for (const viewer of session.viewers) {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(json);
    }
  }
}

function arrayBufferToBase64(buf: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return Buffer.from(binary, "binary").toString("base64");
}

function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

export function devWsPlugin(): Plugin {
  return {
    name: "ttyd-dev-ws",
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true });

      server.middlewares.use((req, res, next) => {
        // Streaming /urls endpoint — blocks, emits a URL each time viewer sends new_tab
        const parsedUrl = new URL(req.url!, `http://${req.headers.host}`);
        const urlsMatch = parsedUrl.pathname.match(/^\/session\/([^/]+)\/urls$/);
        if (urlsMatch) {
          const sessionId = urlsMatch[1];
          const session = getOrCreateSession(sessionId);
          const host = req.headers.host || "localhost:5173";
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Transfer-Encoding", "chunked");
          res.setHeader("Cache-Control", "no-cache");
          res.flushHeaders();
          session.urlStreams.add(res);
          flushPendingTabs(session, sessionId, host, res);
          ensureAutoEmitLoop(session, sessionId, host);
          req.on("close", () => {
            session.urlStreams.delete(res);
            ensureAutoEmitLoop(session, sessionId, host);
          });
          return;
        }

        // Root: serve client bootstrap that reuses session ID from localStorage
        if (req.url === "/" || req.url === "") {
          const html = fs.readFileSync(
            path.join(process.cwd(), "public", "index.html"),
            "utf-8"
          );
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
          return;
        }
        // Serve session.html for /session/* paths
        if (req.url?.match(/^\/session\/[^/]+\/?$/) && !req.headers.upgrade) {
          const html = fs.readFileSync(
            path.join(process.cwd(), "public", "session.html"),
            "utf-8"
          );
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
          return;
        }
        next();
      });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);

        // /session/:sessionId/ws/terminal/:tabId
        const terminalMatch = url.pathname.match(
          /^\/session\/([^/]+)\/ws\/terminal\/([^/]+)$/
        );
        if (terminalMatch) {
          const [, sessionId, tabId] = terminalMatch;
          const session = getOrCreateSession(sessionId);
          removePendingTab(session, tabId);
          observeTabId(session, tabId);
          const host = req.headers.host || "localhost:5173";
          // Check for tty subprotocol
          const protocols = req.headers["sec-websocket-protocol"]?.split(",").map((s: string) => s.trim()) ?? [];
          const protocol = protocols.includes("tty") ? "tty" : undefined;

          wss.handleUpgrade(req, socket, head, (ws) => {
            // Make tab ID unique if already taken
            let uniqueTabId = tabId;
            if (session.tabs.has(tabId)) {
              let suffix = 2;
              while (session.tabs.has(`${tabId}-${suffix}`)) suffix++;
              uniqueTabId = `${tabId}-${suffix}`;
            }

            session.tabs.set(uniqueTabId, { terminalWs: ws });
            resetAutoEmitLoop(session);

            console.log(`[dev-ws] terminal connected: session=${sessionId} tab=${uniqueTabId}`);

            // Notify viewers
            broadcastToViewers(session, { type: "tab_added", tab: uniqueTabId });
            // Send updated tab list
            broadcastToViewers(session, {
              type: "tab_list",
              tab: "",
              tabs: Array.from(session.tabs.keys()),
            });

            ws.on("message", (data: Buffer) => {
              const buf = new Uint8Array(data);
              if (buf.length === 0) return;

              const cmd = buf[0];
              const payload = buf.slice(1);

              switch (cmd) {
                case OUTPUT:
                  broadcastToViewers(session, {
                    type: "output",
                    tab: uniqueTabId,
                    data: arrayBufferToBase64(payload),
                  });
                  break;
                case SET_WINDOW_TITLE:
                  broadcastToViewers(session, {
                    type: "title",
                    tab: uniqueTabId,
                    data: arrayBufferToBase64(payload),
                  });
                  break;
                case SET_PREFERENCES:
                  broadcastToViewers(session, {
                    type: "prefs",
                    tab: uniqueTabId,
                    data: arrayBufferToBase64(payload),
                  });
                  break;
              }
            });

            ws.on("close", () => {
              console.log(`[dev-ws] terminal disconnected: session=${sessionId} tab=${uniqueTabId}`);
              session.tabs.delete(uniqueTabId);
              broadcastToViewers(session, { type: "tab_removed", tab: uniqueTabId });
              ensureAutoEmitLoop(session, sessionId, host);
            });
          });
          return;
        }

        // /session/:sessionId/ws/viewer
        const viewerMatch = url.pathname.match(
          /^\/session\/([^/]+)\/ws\/viewer$/
        );
        if (viewerMatch) {
          const [, sessionId] = viewerMatch;

          wss.handleUpgrade(req, socket, head, (ws) => {
            const session = getOrCreateSession(sessionId);
            session.viewers.add(ws);

            console.log(`[dev-ws] viewer connected: session=${sessionId}`);

            // Send current tab list
            ws.send(
              JSON.stringify({
                type: "tab_list",
                tab: "",
                tabs: Array.from(session.tabs.keys()),
              })
            );

            ws.on("message", (data: Buffer | string) => {
              try {
                const msg = JSON.parse(data.toString());

                if (msg.type === "new_tab") {
                  if (!msg.tab || !/^[a-zA-Z0-9_-]+$/.test(msg.tab)) return;
                  const host = req.headers.host || "localhost:5173";
                  if (session.urlStreams.size > 0) {
                    emitUrl(session, `ws://${host}/session/${sessionId}/ws/terminal/${msg.tab}`);
                    session.autoEmitAttempts = 0;
                    scheduleNextRetry(session, sessionId, host);
                  } else {
                    queuePendingTab(session, msg.tab);
                    ensureAutoEmitLoop(session, sessionId, host);
                  }
                  return;
                }

                const tab = session.tabs.get(msg.tab);
                if (!tab?.terminalWs || tab.terminalWs.readyState !== WebSocket.OPEN) return;

                let cmdByte: number;
                let payload: Buffer;

                switch (msg.type) {
                  case "input":
                    cmdByte = INPUT;
                    payload = base64ToBuffer(msg.data ?? "");
                    break;
                  case "resize":
                    cmdByte = RESIZE_TERMINAL;
                    payload = msg.data
                      ? base64ToBuffer(msg.data)
                      : Buffer.from(JSON.stringify({ columns: msg.cols, rows: msg.rows }));
                    break;
                  case "pause":
                    cmdByte = PAUSE;
                    payload = Buffer.alloc(0);
                    break;
                  case "resume":
                    cmdByte = RESUME;
                    payload = Buffer.alloc(0);
                    break;
                  default:
                    return;
                }

                const buf = Buffer.alloc(1 + payload.length);
                buf[0] = cmdByte;
                payload.copy(buf, 1);
                tab.terminalWs.send(buf);
              } catch {}
            });

            ws.on("close", () => {
              console.log(`[dev-ws] viewer disconnected: session=${sessionId}`);
              session.viewers.delete(ws);
            });
          });
          return;
        }
      });
    },
  };
}
