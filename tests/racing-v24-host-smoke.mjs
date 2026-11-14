import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const files = new Map([
  ["/racing-host.js", ["racing-host.js", "text/javascript; charset=utf-8"]],
  ["/racing-game.html", ["racing-game.html", "text/html; charset=utf-8"]],
  ["/vendor/three-r147.min.js", ["vendor/three-r147.min.js", "text/javascript; charset=utf-8"]],
  ["/vendor/GLTFLoader-r147.js", ["vendor/GLTFLoader-r147.js", "text/javascript; charset=utf-8"]]
]);
const pageHtml = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALLCOINS Racing classic runtime test</title></head>
<body>
<a id="openDragRacing" href="#race" data-allcoins-racing-launch="true">Драг-рейсинг 3D</a>
<script>
window.__telegramFullscreenCalls = 0;
window.Telegram = { WebApp: {
  initData: "mock-telegram-init-data",
  ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
  requestFullscreen() { window.__telegramFullscreenCalls++; },
  isFullscreen: false, exitFullscreen() {}
}};
</script>
<script src="/racing-host.js"></script>
</body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(pageHtml);
    return;
  }
  const entry = files.get(pathname);
  if (entry) {
    const body = await readFile(resolve(root, entry[0]));
    response.writeHead(200, {
      "content-type": entry[1],
      "content-length": String(body.byteLength),
      "cache-control": "no-store"
    });
    response.end(body);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found: " + pathname);
});

let browser;
try {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  browser = await chromium.launch({
    headless: true,
    args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader", "--disable-gpu-sandbox"]
  });
  const page = await browser.newPage({
    viewport: { width: 1365, height: 768 },
    isMobile: true,
    hasTouch: true
  });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  const apiCalls = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    apiCalls.push({ path: url.pathname, method: request.method() });

    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "Authorization,Content-Type,Range",
          "access-control-max-age": "600"
        }
      });
    }

    if (url.pathname === "/api/auth/telegram" && request.method() === "POST") {
      const body = request.postDataJSON();
      assert.equal(body.initData, "mock-telegram-init-data");
      return route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify({ token: "mock-engine-session-token", user: { id: "test-user" } })
      });
    }

    if (url.pathname === "/api/racing/shared-model-asset" && request.method() === "GET") {
      assert.equal(request.headers().authorization, "Bearer mock-engine-session-token");
      assert.match(request.headers().range || "", /^bytes=0-/);
      return route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "X-File-Name, Content-Length, Content-Range, Accept-Ranges",
          "content-type": "model/gltf-binary",
          "content-length": "4",
          "x-file-name": "test-vaz-2107.glb"
        },
        body: Buffer.from("glTF", "ascii")
      });
    }

    return route.fulfill({
      status: 404,
      headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
      body: JSON.stringify({ error: "Unexpected Racing API request: " + url.pathname })
    });
  });

  await page.goto("http://127.0.0.1:" + address.port + "/", { waitUntil: "domcontentloaded" });
  await page.locator("#openDragRacing").click();
  assert.equal(await page.evaluate(() => window.__telegramFullscreenCalls), 1);

  const frameLocator = page.locator("#allcoinsRacingV24Overlay iframe");
  await frameLocator.waitFor({ state: "attached", timeout: 10000 });
  await page.waitForFunction(() => {
    const frame = document.querySelector("#allcoinsRacingV24Overlay iframe");
    return frame && /racing-game\\.html/.test(frame.src) && !frame.srcdoc;
  }, null, { timeout: 10000 });

  let gameFrame;
  for (let attempt = 0; attempt < 50 && !gameFrame; attempt++) {
    gameFrame = page.frames().find(frame => frame.url().includes("racing-game.html"));
    if (!gameFrame) await page.waitForTimeout(100);
  }
  assert.ok(gameFrame, "The game must load as a normal same-origin iframe document.");

  await gameFrame.waitForFunction(() => {
    const state = window.__allcoinsRacingBoot;
    return state && state.moduleStarted && state.webglReady && state.modelRequestSent && state.modelAckReceived;
  }, null, { timeout: 20000 });

  await gameFrame.locator("#pause").click();
  assert.equal(await gameFrame.locator("#pause").textContent(), "ПРОДОЛЖИТЬ",
    "The pause control must respond to taps/clicks.");
  await gameFrame.locator("#pause").click();
  assert.equal(await gameFrame.locator("#pause").textContent(), "ПАУЗА");

  const suspensionBefore = await gameFrame.locator("#suspension").textContent();
  await gameFrame.locator("#suspension").click();
  const suspensionAfter = await gameFrame.locator("#suspension").textContent();
  assert.notEqual(suspensionAfter, suspensionBefore,
    "The suspension control must respond to taps/clicks.");

  await gameFrame.locator("#headlights").click();
  assert.equal(await gameFrame.locator("#headlights").textContent(), "ФАРЫ · ВКЛ",
    "The headlight control must respond to taps/clicks.");

  await page.waitForFunction(() =>
    document.querySelector("#allcoinsRacingV24Overlay")?.textContent.includes("3D-модель передана в игровую сцену"),
    null,
    { timeout: 10000 }
  );
  assert.ok(apiCalls.some(call => call.path === "/api/auth/telegram"));
  assert.ok(apiCalls.some(call => call.path === "/api/racing/shared-model-asset"));
  assert.deepEqual(pageErrors, [],
    "Classic Three.js startup and UI control binding must not raise uncaught browser errors.");

  console.log("Racing smoke test passed: same-origin scene, local classic Three.js/GLTFLoader, WebGL startup, model request handshake, and interactive pause/suspension/headlight controls.");
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
}
