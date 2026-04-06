export { TerminalSession } from "./lib/terminal-session";

interface Env {
  TERMINAL_SESSION: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route WebSocket upgrades to Durable Objects
    const doMatch = url.pathname.match(/^\/session\/([^/]+)\/(ws\/.+)$/);
    if (doMatch) {
      const sessionId = doMatch[1];
      // Validate session ID format
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        return new Response("Invalid session ID", { status: 400 });
      }
      const id = env.TERMINAL_SESSION.idFromName(sessionId);
      const stub = env.TERMINAL_SESSION.get(id);
      return stub.fetch(request);
    }

    // Route /urls streaming endpoint to Durable Object
    const urlsMatch = url.pathname.match(/^\/session\/([^/]+)\/urls$/);
    if (urlsMatch) {
      const sessionId = urlsMatch[1];
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        return new Response("Invalid session ID", { status: 400 });
      }
      const id = env.TERMINAL_SESSION.idFromName(sessionId);
      const stub = env.TERMINAL_SESSION.get(id);
      return stub.fetch(request);
    }

    // Serve session.html for /session/:id paths
    if (url.pathname.match(/^\/session\/[^/]+\/?$/)) {
      const resp = await env.ASSETS.fetch(new URL("/session.html", url.origin));
      const headers = new Headers(resp.headers);
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Root path: serve client bootstrap that reuses session ID from localStorage
    if (url.pathname === "/" || url.pathname === "") {
      const resp = await env.ASSETS.fetch(new URL("/index.html", url.origin));
      const headers = new Headers(resp.headers);
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // All other requests: serve static assets
    return env.ASSETS.fetch(request);
  },
};
