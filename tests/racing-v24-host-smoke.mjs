import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const hostScript = await readFile(resolve(root, "racing-host.js"), "utf8");
const indexHtml = await readFile(resolve(root, "index.html"), "utf8");

assert.match(indexHtml, /id="openDragRacing"[^>]*data-allcoins-racing-launch="true"/,
  "The existing drag-racing tile must launch V24.");
assert.match(indexHtml, /<script src="\.\/racing-host\.js\?v=[^"]+"/,
  "The main Mini App must load the V24 host bridge.");
assert.match(hostScript, /\/api\/auth\/telegram/,
  "The bridge must authenticate using Telegram initData.");
assert.match(hostScript, /\/api\/racing\/shared-model-asset/,
  "The bridge must load the saved GLB through the Engine API.");
assert.match(hostScript, /indexedDB\.open\(MODEL_CACHE_DB/,
  "The bridge must persist the car model in the browser cache.");
assert.match(hostScript, /id = "allcoinsRacingModelProgress"/,
  "The model transfer must show a visible progress panel.");
assert.match(hostScript, /response\.arrayBuffer\(\)/,
  "The model transfer must use the reliable ranged binary response path.");
assert.match(hostScript, /allcoins-model-progress-sweep/,
  "The visible progress bar must animate while a range is being downloaded.");
assert.match(hostScript, /tg\.requestFullscreen\(\)/,
  "The racing launch must request Telegram's native fullscreen mode.");
assert.match(hostScript, /height:100dvh/,
  "The V24 overlay and iframe must occupy the full dynamic Android viewport.");
assert.match(hostScript, /requestRacingFullscreen\(\);\s*void openRacing\(\)/,
  "Fullscreen must be requested synchronously from the racing tile tap.");

const gameHtml = [
  "<!doctype html>",
  "<html><head><meta charset=\"utf-8\"><title>V24 bridge test</title></head>",
  "<body><div id=\"test-state\">ready</div><script>",
  "window.__bridgeResponses = {};",
  "window.__bridgeModel = null;",
  "window.addEventListener(\"message\", event => {",
  "  const data = event.data || {};",
  "  if (data.type === \"allcoins:racing:response\" && data.requestId) window.__bridgeResponses[data.requestId] = data;",
  "  if (data.type === \"allcoins:car-model\") window.__bridgeModel = { fileName: data.fileName, byteLength: data.buffer && data.buffer.byteLength };",
  "  if (data.type === \"allcoins:car-model-error\") window.__bridgeModel = { error: data.message };",
  "});",
  "window.parent.postMessage({ type: \"allcoins:racing:request\", requestId: \"rooms-list-check\", action: \"rooms:list\" }, \"*\");",
  "window.parent.postMessage({ type: \"allcoins:racing:request\", requestId: \"room-create-check\", action: \"room:create\", maxPlayers: 2 }, \"*\");",
  "window.parent.postMessage({ type: \"allcoins:request-car-model\" }, \"*\");",
  "</script></body></html>"
].join("\n");

const fixtureHtml = [
  "<!doctype html>",
  "<html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>ALLCOINS V24 bridge test</title></head>",
  "<body>",
  "<a id=\"openDragRacing\" href=\"#allcoins-racing-v24\" data-allcoins-racing-launch=\"true\">Драг-рейсинг 3D</a>",
  "<script>window.__telegramFullscreenCalls = { request: 0, exit: 0 }; window.Telegram = { WebApp: { initData: \"mock-telegram-init-data\", isFullscreen: false, ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, requestFullscreen() { window.__telegramFullscreenCalls.request++; this.isFullscreen = true; }, exitFullscreen() { window.__telegramFullscreenCalls.exit++; this.isFullscreen = false; } } };</script>",
  "<script src=\"/racing-host.js\"></script>",
  "</body></html>"
].join("\n");

const calls = [];
const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (path === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
    return;
  }
  if (path === "/racing-host.js") {
    response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    response.end(hostScript);
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

let browser;
try {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "The local test server must start.");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.route("https://harold-overcome-acdbentity-breeding.trycloudflare.com/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    calls.push({
      path: url.pathname,
      method: request.method(),
      authorization: headers.authorization || "",
      range: headers.range || "",
      body
    });

    if (url.pathname === "/api/auth/telegram" && request.method() === "POST") {
      assert.equal(body.initData, "mock-telegram-init-data",
        "Telegram initData must be sent to the Engine authentication endpoint.");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "mock-engine-session-token", user: { id: "test-user" } })
      });
    }

    if (url.pathname === "/api/racing/game" && request.method() === "GET") {
      assert.equal(headers.authorization, "Bearer mock-engine-session-token",
        "The V24 game file must require an authenticated Engine session.");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ content: gameHtml })
      });
    }

    if (url.pathname === "/api/racing/rooms" && request.method() === "GET") {
      assert.equal(headers.authorization, "Bearer mock-engine-session-token");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ rooms: [] })
      });
    }

    if (url.pathname === "/api/racing/rooms" && request.method() === "POST") {
      assert.equal(headers.authorization, "Bearer mock-engine-session-token");
      assert.equal(body.maxPlayers, 2, "Room creation must preserve the requested two-player capacity.");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ room: { code: "RACE2345", maxPlayers: 2 } })
      });
    }

    if (url.pathname === "/api/racing/shared-model-asset" && request.method() === "GET") {
      assert.equal(headers.authorization, "Bearer mock-engine-session-token",
        "The GLB asset must be requested with the Engine session.");
      assert.match(headers.range || "", /^bytes=0-/,
        "The GLB transfer must use a byte range.");
      // Keep the response open briefly so the test can observe the progress panel before bytes arrive.
      await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "model/gltf-binary",
          "x-file-name": "test-vaz-2107.glb",
          "access-control-expose-headers": "X-File-Name, Content-Length, Content-Range, Accept-Ranges"
        },
        body: Buffer.from([0x67, 0x6c, 0x54, 0x46])
      });
    }

    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unexpected V24 API request: " + url.pathname })
    });
  });

  await page.goto("http://127.0.0.1:" + address.port + "/", { waitUntil: "domcontentloaded" });
  await page.locator("#openDragRacing").click();
  assert.equal(await page.evaluate(() => window.__telegramFullscreenCalls.request), 1,
    "Tapping the racing tile must request Telegram fullscreen immediately.");
  const frame = page.locator("#allcoinsRacingV24Overlay iframe");
  await frame.waitFor({ state: "attached", timeout: 8000 });

  const progressPanel = page.locator("#allcoinsRacingModelProgress");
  await progressPanel.waitFor({ state: "visible", timeout: 5000 });
  assert.match(await progressPanel.textContent(), /Загружаем 3D-модель автомобиля|Загрузка автомобиля|Подключаемся/,
    "The visible progress panel must explain that the car model is loading.");

  await page.waitForFunction(() => {
    const element = document.querySelector("#allcoinsRacingV24Overlay iframe");
    const child = element && element.contentWindow;
    return child &&
      child.__bridgeResponses &&
      child.__bridgeResponses["rooms-list-check"] &&
      child.__bridgeResponses["room-create-check"] &&
      child.__bridgeModel;
  }, null, { timeout: 10000 });

  const bridgeState = await frame.evaluate(element => ({
    responses: element.contentWindow.__bridgeResponses,
    model: element.contentWindow.__bridgeModel
  }));

  assert.equal(bridgeState.responses["rooms-list-check"].ok, true,
    "The V24 frame must receive the room-list response.");
  assert.equal(bridgeState.responses["room-create-check"].ok, true,
    "The V24 frame must receive the room-create response.");
  assert.equal(bridgeState.responses["room-create-check"].data.room.code, "RACE2345",
    "The V24 frame must receive the created room code.");
  assert.deepEqual(bridgeState.model, { fileName: "test-vaz-2107.glb", byteLength: 4 },
    "The V24 frame must receive the GLB bytes and file name.");
  await progressPanel.waitFor({ state: "hidden", timeout: 5000 });

  assert.ok(calls.some(call => call.path === "/api/auth/telegram"));
  assert.ok(calls.some(call => call.path === "/api/racing/game" && call.authorization === "Bearer mock-engine-session-token"));
  assert.ok(calls.some(call => call.path === "/api/racing/rooms" && call.method === "GET"));
  assert.ok(calls.some(call => call.path === "/api/racing/rooms" && call.method === "POST"));
  assert.ok(calls.some(call => call.path === "/api/racing/shared-model-asset" && call.range.startsWith("bytes=0-")));
  assert.deepEqual(pageErrors, [], "The V24 host fixture must not raise browser runtime errors.");

  // Close and reopen the game: the GLB must be served from IndexedDB without another API download.
  await page.locator("#allcoinsRacingV24Overlay button").filter({ hasText: "Назад" }).click();
  await page.locator("#allcoinsRacingV24Overlay").waitFor({ state: "detached", timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__telegramFullscreenCalls.exit), 1,
    "Closing the racing screen must request exiting Telegram fullscreen.");
  await page.locator("#openDragRacing").click();
  assert.equal(await page.evaluate(() => window.__telegramFullscreenCalls.request), 2,
    "Reopening the racing screen must request fullscreen again.");
  const reopenedFrame = page.locator("#allcoinsRacingV24Overlay iframe");
  await reopenedFrame.waitFor({ state: "attached", timeout: 8000 });
  await page.waitForFunction(() => {
    const element = document.querySelector("#allcoinsRacingV24Overlay iframe");
    return element?.contentWindow?.__bridgeModel;
  }, null, { timeout: 8000 });
  const secondModel = await reopenedFrame.evaluate(element => element.contentWindow.__bridgeModel);
  assert.deepEqual(secondModel, { fileName: "test-vaz-2107.glb", byteLength: 4 },
    "Reopening V24 must restore the locally cached GLB.");
  assert.equal(calls.filter(call => call.path === "/api/racing/shared-model-asset").length, 1,
    "Reopening the game must not download the same GLB from the local database again.");

  console.log("V24 host bridge smoke test passed: Telegram auth/fullscreen, full-height overlay, rooms, GLB transfer, and persistent local cache.");
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
}
