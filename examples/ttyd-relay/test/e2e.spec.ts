import { test, expect } from "@playwright/test";
import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTYD_BIN =
  process.env.TTYD_BIN || path.join(__dirname, "../../../build/ttyd");
const OSC7_SERVER_URI = pathToFileURL(path.resolve(__dirname, "..")).toString();
const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:3842";
const WS_BASE_URL = BASE_URL.replace(/^http/, "ws");
const SESSION_ID_RE = /\/session\/[A-Za-z0-9_-]{22}$/;

function startTtyd(wsUrl: string, command: string[], sharedKey?: string): ChildProcess {
  const args = [];
  if (sharedKey) args.push("--connect-write-key", sharedKey);
  args.push("--connect", wsUrl, "-W", ...command);
  return spawn(TTYD_BIN, args, { stdio: "pipe" });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTtydConnected(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ttyd did not connect within 10s")), 10000);
    proc.stderr?.on("data", (data: Buffer) => {
      if (data.toString().includes("WS client connected")) { clearTimeout(timeout); resolve(); }
    });
    proc.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`ttyd exited: ${code}`)); });
  });
}

/** Extract the WS URL for the active tab from its DOM metadata */
async function getWsUrl(page: import("@playwright/test").Page): Promise<string> {
  const wsUrl = await page.locator(".terminal-pane.active").getAttribute("data-ws-url");
  expect(wsUrl).toBeTruthy();
  return wsUrl!;
}

async function getWriteKey(page: import("@playwright/test").Page): Promise<string> {
  const key = await page.evaluate(() => {
    const parts = location.pathname.split('/');
    const sessionId = parts[parts.indexOf('session') + 1];
    return localStorage.getItem(`ttyd-ui:write:${sessionId}`);
  });
  expect(key).toBeTruthy();
  return key!;
}

async function getTabLabels(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator("#tab-list .tab-item .tab-name").allTextContents();
}

async function getReadLink(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => location.href);
}

test.describe("home page", () => {
  test("root opens a base64 session with a tab", async ({ page }) => {
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => location.pathname)).toMatch(SESSION_ID_RE);
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#r=[A-Za-z0-9_-]{43}$/);
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN");
  });

  test("root reuses stored session id", async ({ page }) => {
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => location.pathname)).toMatch(SESSION_ID_RE);
    const firstPath = await page.evaluate(() => location.pathname);
    const storedId = await page.evaluate(() => localStorage.getItem("ttyd-session-id"));
    expect(storedId).toBeTruthy();
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe(firstPath);
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe(`/session/${storedId}`);
  });
});

test.describe("session page", () => {
  test("first tab shows connect command", async ({ page }) => {
    await page.goto("/session/test-session");
    const cmd = page.locator(".waiting .cmd").first();
    const sharedKey = await getWriteKey(page);
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#r=[A-Za-z0-9_-]{43}$/);
    await expect.poll(() => page.evaluate(() => location.hash.includes('#w='))).toBe(false);
    await expect(cmd).toContainText("curl -sN", { timeout: 5000 });
    await expect(cmd).toContainText("/session/test-session/urls");
    await expect(cmd).toContainText("--connect-write-key");
    await expect(cmd).toContainText(sharedKey);
    await expect(cmd).toContainText("while read -r _url; do ttyd --connect-write-key");
    await expect(cmd).toContainText("test-session");
    // No token in the URL
    await expect(cmd).not.toContainText("token=");
  });

  test("copy button works", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/session/copy-test");
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN", { timeout: 5000 });
    const cmdText = await page.locator(".waiting .cmd").first().textContent();
    await page.click(".waiting .copy-btn");
    await expect(page.locator(".waiting .copy-btn")).toHaveText("✓");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(cmdText);
  });

  test("copy read and write link buttons expose the right capabilities", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/session/link-copy-test");
    const writeKey = await getWriteKey(page);

    await page.click("#btn-copy-read");
    const readLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(readLink).toContain("#r=");
    expect(readLink).not.toContain("#w=");
    expect(readLink).not.toContain(writeKey);

    await page.click("#btn-copy-write");
    const writeLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(writeLink).toContain(`#w=${writeKey}`);
  });

  test("read-only link can view but cannot write or create tabs", async ({ page, browser }) => {
    await page.goto("/session/readonly-test");
    const writeKey = await getWriteKey(page);
    const ttyd = startTtyd(await getWsUrl(page), ["bash"], writeKey);

    const readerContext = await browser.newContext();
    try {
      await waitForTtydConnected(ttyd);
      await expect(page.locator("textarea.xterm-helper-textarea")).toBeVisible({ timeout: 5000 });

      const readLink = await getReadLink(page);
      const reader = await readerContext.newPage();
      await reader.goto(readLink);

      await expect(reader.locator(".terminal-pane.active .xterm-screen")).toBeVisible({ timeout: 5000 });
      await expect(reader.locator("#btn-new")).toBeDisabled();
      await expect(reader.locator("#btn-copy-write")).toBeDisabled();

      const readerWriteKey = await reader.evaluate(() => {
        const parts = location.pathname.split('/');
        const sessionId = parts[parts.indexOf('session') + 1];
        return localStorage.getItem(`ttyd-ui:write:${sessionId}`);
      });
      expect(readerWriteKey).toBeNull();

      await reader.keyboard.press("Control+Shift+N");
      await expect(reader.locator("#tab-list .tab-item")).toHaveCount(1);
    } finally {
      await readerContext.close();
      ttyd.kill();
    }
  });

  test("Ctrl+Shift+N creates a new tab in sidebar", async ({ page }) => {
    await page.goto("/session/newtab-test");
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1, { timeout: 5000 });
    await page.keyboard.press("Control+Shift+N");
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(2);
  });

  test("tabs are in left sidebar", async ({ page }) => {
    await page.goto("/session/sidebar-test");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1);
  });

  test("new session button clears stored state and navigates to a fresh base64 session", async ({ page }) => {
    await page.goto("/session/clear-state-test");
    await page.evaluate(() => {
      localStorage.setItem("ttyd-session-id", "AAAAAAAAAAAAAAAAAAAAAA");
      localStorage.setItem("ttyd-ui:clear-state-test", JSON.stringify({ hello: "world" }));
    });
    const currentUrl = page.url();
    await page.click("#btn-session");
    await expect.poll(() => page.evaluate(() => location.pathname)).toMatch(SESSION_ID_RE);
    expect(page.url()).not.toBe(currentUrl);
    const state = await page.evaluate(() => ({
      sessionId: localStorage.getItem("ttyd-session-id"),
      oldPrefs: localStorage.getItem("ttyd-ui:clear-state-test"),
    }));
    expect(state.sessionId).toBeTruthy();
    expect(state.sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(state.oldPrefs).toBeNull();
  });

  test("double click sets a manual label that overrides terminal title", async ({ page }) => {
    await page.goto("/session/rename-test");
    const ttyd = startTtyd(await getWsUrl(page), ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd);
      page.once("dialog", (dialog) => dialog.accept("api"));
      await page.locator("#tab-list .tab-item").first().dblclick();
      await expect(page.locator("#tab-list .tab-item .tab-name").first()).toHaveText("api");

      const textarea = page.locator("textarea.xterm-helper-textarea");
      await expect(textarea).toBeVisible({ timeout: 5000 });
      await textarea.focus();
      await page.keyboard.type("echo -ne '\\033]0;ignored-title\\007'");
      await page.keyboard.press("Enter");
      await expect(page.locator("#tab-list .tab-item .tab-name").first()).toHaveText("api");

      await page.keyboard.type("printf '\\033]7;file://localhost/tmp/osc7-ignored\\007'");
      await page.keyboard.press("Enter");
      await expect(page.locator("#tab-list .tab-item .tab-name").first()).toHaveText("api");
    } finally { ttyd.kill(); }
  });

  test("OSC 7 updates tab label from cwd", async ({ page }) => {
    await page.goto("/session/osc7-test");
    const ttyd = startTtyd(await getWsUrl(page), ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd);
      const textarea = page.locator("textarea.xterm-helper-textarea");
      await expect(textarea).toBeVisible({ timeout: 5000 });
      await textarea.focus();
      await page.keyboard.type(`printf '\\033]7;${OSC7_SERVER_URI}\\007'`);
      await page.keyboard.press("Enter");
      await expect(page.locator("#tab-list .tab-item .tab-name").first()).toContainText("ttyd-relay", { timeout: 5000 });
    } finally { ttyd.kill(); }
  });

  test("tab label includes both terminal title and cwd", async ({ page }) => {
    await page.goto("/session/title-cwd-test");
    const ttyd = startTtyd(await getWsUrl(page), ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd);
      const textarea = page.locator("textarea.xterm-helper-textarea");
      await expect(textarea).toBeVisible({ timeout: 5000 });
      await textarea.focus();
      await page.keyboard.type(`printf '\\033]0;api\\007\\033]7;${OSC7_SERVER_URI}\\007'`);
      await page.keyboard.press("Enter");
      await expect(page.locator("#tab-list .tab-item .tab-name").first()).toHaveText("ttyd-relay · api", { timeout: 5000 });
    } finally { ttyd.kill(); }
  });

  test("sidebar can be resized and persists across reload", async ({ page }) => {
    await page.goto("/session/sidebar-resize-test");
    const sidebar = page.locator("#sidebar");
    const resizer = page.locator("#sidebar-resizer");
    const before = await sidebar.boundingBox();
    expect(before).toBeTruthy();

    const handle = await resizer.boundingBox();
    expect(handle).toBeTruthy();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 90, handle!.y + handle!.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan((before?.width ?? 0) + 60);
    const resizedWidth = (await sidebar.boundingBox())?.width ?? 0;

    await page.reload();
    await expect.poll(async () => (await page.locator("#sidebar").boundingBox())?.width ?? 0).toBeGreaterThan(resizedWidth - 8);
  });

  test("pinning moves a tab ahead of regular tabs", async ({ page }) => {
    await page.goto("/session/pin-test");
    await page.keyboard.press("Control+Shift+N");
    await page.keyboard.press("Control+Shift+N");
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(3);

    await page.locator("#tab-list .tab-item").nth(2).locator(".tab-pin").click();
    await expect.poll(() => getTabLabels(page)).toEqual(["t3", "t1", "t2"]);
  });

  test("dragging reorders tabs", async ({ page }) => {
    await page.goto("/session/reorder-test");
    await page.keyboard.press("Control+Shift+N");
    await page.keyboard.press("Control+Shift+N");
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(3);

    await page.locator("#tab-list .tab-item").nth(2).dragTo(page.locator("#tab-list .tab-item").first());
    await expect.poll(() => getTabLabels(page)).toEqual(["t3", "t1", "t2"]);
  });
});

test.describe("terminal connection", () => {
  test("terminal appears when ttyd connects", async ({ page }) => {
    await page.goto("/session/e2e-connect");
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN", { timeout: 5000 });
    const wsUrl = await getWsUrl(page);
    const ttyd = startTtyd(wsUrl, ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd);
      await expect(page.locator("textarea.xterm-helper-textarea")).toBeVisible({ timeout: 5000 });
      await expect(page.locator(".waiting")).not.toBeVisible();
      await expect(page.locator("#tab-list .tab-item .dot")).toHaveClass(/on/);
    } finally { ttyd.kill(); }
  });

  test("ttyd with custom tab name auto-creates a tab", async ({ page }) => {
    await page.goto("/session/e2e-auto");
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1, { timeout: 5000 });

    // Connect ttyd with a custom tab name that doesn't match any existing tab
    const ttyd = startTtyd(
      `${WS_BASE_URL}/session/e2e-auto/ws/terminal/my-server`,
      ["bash"],
      await getWriteKey(page)
    );
    try {
      await waitForTtydConnected(ttyd);
      // A new tab should auto-appear (ttyd may override the name with its title)
      await expect(page.locator("#tab-list .tab-item")).toHaveCount(2, { timeout: 5000 });
      // It should be active with a working terminal
      await expect(page.locator(".terminal-pane.active textarea.xterm-helper-textarea")).toBeVisible({ timeout: 5000 });
    } finally { ttyd.kill(); }
  });

  test("typing executes in shell", async ({ page }) => {
    await page.goto("/session/e2e-type");
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN", { timeout: 5000 });
    const ttyd = startTtyd(await getWsUrl(page), ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd);
      const textarea = page.locator("textarea.xterm-helper-textarea");
      await expect(textarea).toBeVisible({ timeout: 5000 });
      const marker = `/tmp/ttyd-e2e-type-${Date.now()}`;
      await textarea.focus();
      await page.keyboard.type(`touch ${marker}`);
      await page.keyboard.press("Enter");
      await expect.poll(() => {
        try { execSync(`test -f ${marker}`); return true; } catch { return false; }
      }, { timeout: 5000 }).toBe(true);
      execSync(`rm -f ${marker}`);
    } finally { ttyd.kill(); }
  });

  test("UTF-8 characters work", async ({ page }) => {
    await page.goto("/session/e2e-utf8");
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN", { timeout: 5000 });
    const ttyd = startTtyd(await getWsUrl(page), ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd);
      const textarea = page.locator("textarea.xterm-helper-textarea");
      await expect(textarea).toBeVisible({ timeout: 5000 });
      await textarea.focus();
      const marker = `/tmp/ttyd-e2e-utf8-${Date.now()}`;
      await page.keyboard.type(`echo '· café ★' > ${marker}`);
      await page.keyboard.press("Enter");
      await expect.poll(() => {
        try { return execSync(`cat ${marker}`).toString().trim(); } catch { return ""; }
      }, { timeout: 5000 }).toBe("· café ★");
      execSync(`rm -f ${marker}`);
    } finally { ttyd.kill(); }
  });

  test("TUI program (top) runs without crashing", async ({ page }) => {
    await page.goto("/session/e2e-top");
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN", { timeout: 5000 });
    const ttyd = startTtyd(await getWsUrl(page), ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd);
      const textarea = page.locator("textarea.xterm-helper-textarea");
      await expect(textarea).toBeVisible({ timeout: 5000 });
      await textarea.focus();

      // Run top, let it render for 2 seconds, then quit
      await page.keyboard.type("top");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2000);

      // Terminal should still be alive (xterm visible, dot green)
      await expect(page.locator(".xterm-screen")).toBeVisible();
      await expect(page.locator("#tab-list .tab-item .dot")).toHaveClass(/on/);

      // Quit top
      await page.keyboard.press("q");
      await page.waitForTimeout(500);

      // Terminal should still work after quitting top — type a command
      const marker = `/tmp/ttyd-e2e-top-${Date.now()}`;
      await page.keyboard.type(`touch ${marker}`);
      await page.keyboard.press("Enter");
      await expect.poll(() => {
        try { execSync(`test -f ${marker}`); return true; } catch { return false; }
      }, { timeout: 5000 }).toBe(true);
      execSync(`rm -f ${marker}`);
    } finally { ttyd.kill(); }
  });

  test("multiple tabs have independent terminals", async ({ page }) => {
    await page.goto("/session/e2e-multi");
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN", { timeout: 5000 });
    const wsUrl1 = await getWsUrl(page);
    const sharedKey = await getWriteKey(page);

    await page.keyboard.press("Control+Shift+N");
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(2);
    const wsUrl2 = await getWsUrl(page);
    expect(wsUrl1).not.toBe(wsUrl2);

    const ttyd1 = startTtyd(wsUrl1, ["bash"], sharedKey);
    const ttyd2 = startTtyd(wsUrl2, ["bash"], sharedKey);
    try {
      await waitForTtydConnected(ttyd1);
      await waitForTtydConnected(ttyd2);
      await expect(page.locator("#tab-list .tab-item .dot.on")).toHaveCount(2, { timeout: 5000 });

      const m2 = `/tmp/ttyd-e2e-m2-${Date.now()}`;
      const t2 = page.locator(".terminal-pane.active textarea.xterm-helper-textarea");
      await expect(t2).toBeVisible({ timeout: 5000 });
      await t2.focus();
      await page.keyboard.type(`touch ${m2}`);
      await page.keyboard.press("Enter");
      await expect.poll(() => { try { execSync(`test -f ${m2}`); return true; } catch { return false; } }, { timeout: 5000 }).toBe(true);
      execSync(`rm -f ${m2}`);

      await page.locator("#tab-list .tab-item").first().click();
      const m1 = `/tmp/ttyd-e2e-m1-${Date.now()}`;
      const t1 = page.locator(".terminal-pane.active textarea.xterm-helper-textarea");
      await expect(t1).toBeVisible({ timeout: 5000 });
      await t1.focus();
      await page.keyboard.type(`touch ${m1}`);
      await page.keyboard.press("Enter");
      await expect.poll(() => { try { execSync(`test -f ${m1}`); return true; } catch { return false; } }, { timeout: 5000 }).toBe(true);
      execSync(`rm -f ${m1}`);
    } finally { ttyd1.kill(); ttyd2.kill(); }
  });
});

test.describe("duplicate connections", () => {
  test("same URL twice creates two separate tabs", async ({ page }) => {
    await page.goto("/session/e2e-dup");
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1, { timeout: 5000 });
    const sharedKey = await getWriteKey(page);

    const wsUrl = `${WS_BASE_URL}/session/e2e-dup/ws/terminal/shell`;

    const ttyd1 = startTtyd(wsUrl, ["bash"], sharedKey);
    try {
      await waitForTtydConnected(ttyd1);
      // First connection creates tab "shell"
      await expect(page.locator("#tab-list .tab-item")).toHaveCount(2, { timeout: 5000 });

      const ttyd2 = startTtyd(wsUrl, ["bash"], sharedKey);
      try {
        await waitForTtydConnected(ttyd2);
        // Second connection with same URL creates tab "shell-2"
        await expect(page.locator("#tab-list .tab-item")).toHaveCount(3, { timeout: 5000 });

        // Both should be connected (green dots)
        await expect(page.locator("#tab-list .tab-item .dot.on")).toHaveCount(2, { timeout: 5000 });

        // Type in each to prove they're independent shells
        // Click the second auto-created tab (shell)
        await page.locator("#tab-list .tab-item").nth(1).click();
        const m1 = `/tmp/ttyd-e2e-dup1-${Date.now()}`;
        const t1 = page.locator(".terminal-pane.active textarea.xterm-helper-textarea");
        await expect(t1).toBeVisible({ timeout: 5000 });
        await t1.focus();
        await page.keyboard.type(`touch ${m1}`);
        await page.keyboard.press("Enter");
        await expect.poll(() => {
          try { execSync(`test -f ${m1}`); return true; } catch { return false; }
        }, { timeout: 5000 }).toBe(true);
        execSync(`rm -f ${m1}`);

        // Click the third tab (shell-2)
        await page.locator("#tab-list .tab-item").nth(2).click();
        const m2 = `/tmp/ttyd-e2e-dup2-${Date.now()}`;
        const t2 = page.locator(".terminal-pane.active textarea.xterm-helper-textarea");
        await expect(t2).toBeVisible({ timeout: 5000 });
        await t2.focus();
        await page.keyboard.type(`touch ${m2}`);
        await page.keyboard.press("Enter");
        await expect.poll(() => {
          try { execSync(`test -f ${m2}`); return true; } catch { return false; }
        }, { timeout: 5000 }).toBe(true);
        execSync(`rm -f ${m2}`);
      } finally { ttyd2.kill(); }
    } finally { ttyd1.kill(); }
  });
});

test.describe("terminal title", () => {
  test("tab title updates from terminal escape sequence", async ({ page }) => {
    await page.goto("/session/e2e-title");
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN", { timeout: 5000 });
    const ttyd = startTtyd(await getWsUrl(page), ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd);
      const textarea = page.locator("textarea.xterm-helper-textarea");
      await expect(textarea).toBeVisible({ timeout: 5000 });
      await textarea.focus();
      await page.keyboard.type("echo -ne '\\033]0;my-custom-title\\007'");
      await page.keyboard.press("Enter");
      await expect(page.locator("#tab-list .tab-item .tab-name")).toHaveText("my-custom-title", { timeout: 5000 });
      await expect(page).toHaveTitle(/my-custom-title/);
    } finally { ttyd.kill(); }
  });
});

test.describe("terminal bell", () => {
  test("bell on inactive tab triggers pulsating animation", async ({ page }) => {
    await page.goto("/session/e2e-bell");
    await expect(page.locator(".waiting .cmd").first()).toContainText("curl -sN", { timeout: 5000 });
    const wsUrl1 = await getWsUrl(page);

    // Create second tab so tab 1 can become inactive
    await page.keyboard.press("Control+Shift+N");
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(2);

    const ttyd1 = startTtyd(wsUrl1, ["bash"], await getWriteKey(page));
    try {
      await waitForTtydConnected(ttyd1);

      // Switch to tab 1, type delayed bell, switch to tab 2
      await page.locator("#tab-list .tab-item").first().click();
      const textarea = page.locator(".terminal-pane.active textarea.xterm-helper-textarea");
      await expect(textarea).toBeVisible({ timeout: 5000 });
      await textarea.focus();
      await page.keyboard.press("Control+c");
      await page.keyboard.type("(sleep 0.5 && echo -ne '\\007') &");
      await page.keyboard.press("Enter");
      await page.locator("#tab-list .tab-item").nth(1).click();
      // Bell animation should appear on tab 1
      await expect(page.locator("#tab-list .tab-item").first()).toHaveClass(/bell/, { timeout: 5000 });
    } finally { ttyd1.kill(); }
  });
});

test.describe("streaming /urls endpoint", () => {
  test("initial tab is emitted immediately and later tabs stream on demand", async ({ page }) => {
    const sessionId = `e2e-stream-${Date.now()}`;
    await page.goto(`/session/${sessionId}`);
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1, { timeout: 5000 });

    // Start streaming curl in background, collecting lines
    const { spawn } = await import("child_process");
    const curl = spawn("curl", ["-sN", `${BASE_URL}/session/${sessionId}/urls`], { stdio: "pipe" });
    const lines: string[] = [];
    curl.stdout.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) lines.push(line);
    });

    try {
      await expect.poll(() => lines.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
      expect(lines[0]).toMatch(new RegExp(`ws://.*/session/${sessionId}/ws/terminal/t1$`));

      await page.keyboard.press("Control+Shift+N");
      await expect(page.locator("#tab-list .tab-item")).toHaveCount(2);
      await expect.poll(() => lines.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
      expect(lines[1]).toMatch(new RegExp(`ws://.*/session/${sessionId}/ws/terminal/t2$`));

      await page.keyboard.press("Control+Shift+N");
      await expect(page.locator("#tab-list .tab-item")).toHaveCount(3);
      await expect.poll(() => lines.length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
      expect(lines[2]).toMatch(new RegExp(`ws://.*/session/${sessionId}/ws/terminal/t3$`));
    } finally { curl.kill(); }
  });

  test("initial emitted URL works with ttyd to create connected tab", async ({ page }) => {
    const sessionId = `e2e-stream-ttyd-${Date.now()}`;
    await page.goto(`/session/${sessionId}`);
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1, { timeout: 5000 });
    const sharedKey = await getWriteKey(page);

    const { spawn } = await import("child_process");
    const curl = spawn("curl", ["-sN", `${BASE_URL}/session/${sessionId}/urls`], { stdio: "pipe" });
    const lines: string[] = [];
    curl.stdout.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) lines.push(line);
    });

    try {
      await expect.poll(() => lines.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
      expect(lines[0]).toMatch(new RegExp(`ws://.*/session/${sessionId}/ws/terminal/t1$`));

      const ttyd = startTtyd(lines[0], ["bash"], sharedKey);
      try {
        await waitForTtydConnected(ttyd);
        await expect(page.locator("#tab-list .tab-item .dot.on")).toHaveCount(1, { timeout: 5000 });
        await expect(page.locator("textarea.xterm-helper-textarea")).toBeVisible({ timeout: 5000 });
      } finally { ttyd.kill(); }
    } finally { curl.kill(); }
  });

  test("retries with exponential backoff until a terminal connects", async ({ page }) => {
    const sessionId = `e2e-retry-${Date.now()}`;
    await page.goto(`/session/${sessionId}`);
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1, { timeout: 5000 });

    const { spawn } = await import("child_process");
    const curl = spawn("curl", ["-sN", `${BASE_URL}/session/${sessionId}/urls`], { stdio: "pipe" });
    const lines: string[] = [];
    const times: number[] = [];
    curl.stdout.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        lines.push(line);
        times.push(Date.now());
      }
    });

    try {
      await expect.poll(() => lines.length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
      const ids = lines.slice(0, 3).map((line) => Number((line.match(/\/terminal\/t(\d+)$/) || [])[1]));
      expect(lines[0]).toMatch(new RegExp(`ws://.*/session/${sessionId}/ws/terminal/t1$`));
      expect(ids[1]).toBeGreaterThan(ids[0]);
      expect(ids[2]).toBeGreaterThan(ids[1]);
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(800);
      expect(times[2] - times[1]).toBeGreaterThanOrEqual(1600);
    } finally { curl.kill(); }
  });

  test("suggested curl loop command works end to end", async ({ page }) => {
    const sessionId = `e2e-loop-${Date.now()}`;
    await page.goto(`/session/${sessionId}`);
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1, { timeout: 5000 });

    const suggested = await page.locator(".waiting .cmd").first().textContent();
    expect(suggested).toContain("--connect-write-key");
    const cmd = suggested!.replace(/\bttyd\b/g, shellQuote(TTYD_BIN));
    const listener = spawn("bash", ["-lc", cmd], { stdio: "pipe" });

    try {
      await expect(page.locator("#tab-list .tab-item .dot.on")).toHaveCount(1, { timeout: 10000 });
      await expect(page.locator("textarea.xterm-helper-textarea")).toBeVisible({ timeout: 10000 });
    } finally {
      listener.kill();
    }
  });

  test("open /urls stream emits a replacement URL after the last terminal closes", async ({ page }) => {
    const sessionId = `e2e-loop-recover-${Date.now()}`;
    await page.goto(`/session/${sessionId}`);
    await expect(page.locator("#tab-list .tab-item")).toHaveCount(1, { timeout: 5000 });
    const sharedKey = await getWriteKey(page);

    const { spawn } = await import("child_process");
    const curl = spawn("curl", ["-sN", `${BASE_URL}/session/${sessionId}/urls`], { stdio: "pipe" });
    const lines: string[] = [];
    curl.stdout.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) lines.push(line);
    });

    let ttyd1: ChildProcess | null = null;
    try {
      await expect.poll(() => lines.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
      ttyd1 = startTtyd(lines[0], ["bash"], sharedKey);
      await waitForTtydConnected(ttyd1);
      await expect(page.locator("#tab-list .tab-item .dot.on")).toHaveCount(1, { timeout: 10000 });

      const lineCountBeforeKill = lines.length;
      ttyd1.kill();
      await expect.poll(() => lines.length, { timeout: 5000 }).toBeGreaterThan(lineCountBeforeKill);
      await expect(page.locator("#tab-list .tab-item .dot.on")).toHaveCount(0, { timeout: 5000 });
      expect(lines[lineCountBeforeKill]).toMatch(new RegExp(`ws://.*/session/${sessionId}/ws/terminal/t\\d+$`));
    } finally {
      curl.kill();
      ttyd1?.kill();
      await sleep(200);
    }
  });
});

test.describe("shortcuts", () => {
  test("keyboard shortcuts visible in sidebar", async ({ page }) => {
    await page.goto("/session/sc-test");
    await expect(page.locator(".sidebar-footer")).toBeVisible();
    await expect(page.locator(".sidebar-footer")).toContainText("new");
    await expect(page.locator(".sidebar-footer")).toContainText("close");
  });
});
