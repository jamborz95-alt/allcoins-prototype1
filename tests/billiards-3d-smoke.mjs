import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = process.cwd();
const html = await readFile(resolve(root, "billiards.html"), "utf8");
const out = resolve(root, "visual-test-output");
fs.mkdirSync(out, { recursive: true });

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/billiards.html" || pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  } else if (pathname === "/favicon.ico") {
    res.writeHead(204); res.end();
  } else {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found");
  }
});
await new Promise(resolveListen => server.listen(4175, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--enable-webgl", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"]
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true
  });
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const apiCalls = [];
  const stakeRequests = [];
  const human = { id: "12345", name: "Тестовый игрок", group: null, isYou: true, isCurrent: true, isBot: false };
  const bot = { id: "billiards-test-bot", name: "Бот (тест)", group: null, isYou: false, isCurrent: false, isBot: true };
  const room = { id: "501", name: "3D Test Room", stake: 100, status: "waiting", isOwner: true, ownerName: human.name, playersCount: 1, botMode: true };
  const initialBalls = [{ id: "cue", number: 0, type: "cue", x: 192, y: 220, active: true }];
  const rack = [1, 9, 3, 8, 10, 11, 4, 12, 5, 6, 13, 7, 14, 15, 2];
  let ballIndex = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const number = rack[ballIndex++];
      initialBalls.push({
        id: String(number), number,
        type: number === 8 ? "eight" : (number <= 7 ? "solid" : "stripe"),
        x: 518 + row * 19.5, y: 220 + (col - row / 2) * 20.5, active: true
      });
    }
  }
  let game = {
    status: "playing", stake: 100, pot: 0, testMode: true, balls: initialBalls,
    players: [human, bot], currentPlayerId: human.id, turnNo: 0, lastShot: null,
    winnerId: null, winnerName: null, payout: 0, commission: 0,
    message: "Тестовый режим: играй против бота. AC не списываются и не выплачиваются."
  };

  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Telegram = { WebApp: { initData: 'mock-billiards-init-data', ready(){}, expand(){}, colorScheme:'dark' } };"
  }));
  await page.route("https://allcoins-server.onrender.com/api/billiards/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    apiCalls.push({ path: url.pathname, body });
    const path = url.pathname.replace("/api/billiards", "");
    const respond = payload => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });

    if (path === "/rooms/list") return respond({ ok: true, rooms: [] });
    if (path === "/rooms/create") return respond({ ok: true, room: { ...room }, players: [
      { id: human.id, name: human.name, isYou: true, isOwner: true, isBot: false },
      { id: bot.id, name: bot.name, isYou: false, isOwner: false, isBot: true }
    ] });
    if (path === "/rooms/state") return respond({ ok: true, room: { ...room }, players: [
      { id: human.id, name: human.name, isYou: true, isOwner: true, isBot: false },
      { id: bot.id, name: bot.name, isYou: false, isOwner: false, isBot: true }
    ] });
    if (path === "/rooms/start") {
      game = { ...game, lastShot: null, turnNo: 0 };
      return respond({ ok: true, game });
    }
    if (path === "/game/state") return respond({ ok: true, game });
    if (path === "/game/shot") {
      stakeRequests.push({ power: Number(body.power), angle: Number(body.angle) });
      const startBalls = game.balls.map(ball => ({ ...ball }));
      game.turnNo += 1;
      game.lastShot = {
        seq: game.turnNo, shooterId: human.id, angle: Number(body.angle), power: Number(body.power),
        startBalls, endBalls: startBalls.map(ball => ({ ...ball })),
        pocketedIds: [], scratch: false
      };
      game = { ...game, message: "Удар тестируется.", lastShot: game.lastShot };
      return respond({ ok: true, game });
    }
    if (path === "/rooms/leave") return respond({ ok: true });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Unexpected test API route: " + path }) });
  });

  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", request => {
    if (!request.url().includes("allcoins-server.onrender.com") && !request.url().includes("telegram.org")) {
      failedRequests.push({ url: request.url(), error: request.failure()?.errorText || "failed" });
    }
  });

  try {
    await page.goto("http://127.0.0.1:4175/billiards.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => window.billiards3DReady === true ||
      document.getElementById("pool3DCanvas")?.style.display === "none", { timeout: 20000 });
    const threeReady = await page.evaluate(() => {
      const canvas = document.getElementById("pool3DCanvas");
      const rect = canvas?.getBoundingClientRect();
      return {
        ready: window.billiards3DReady === true,
        canvasPresent: Boolean(canvas),
        width: rect?.width || 0,
        height: rect?.height || 0,
        webgl2: (() => { try { return Boolean(canvas?.getContext("webgl2")); } catch { return false; } })(),
        threeModule: typeof window.billiards3DUpdate === "function",
        raycastMapper: typeof window.billiards3DPointerCoords === "function",
        fallbackVisible: getComputedStyle(document.getElementById("poolCanvas")).opacity === "1"
      };
    });
    assert.equal(threeReady.ready, true, "Трёхмерная сцена не запустилась: " + JSON.stringify(threeReady));
    assert.equal(threeReady.webgl2, true, "Браузер не создал контекст WebGL 2: " + JSON.stringify(threeReady));
    assert.equal(threeReady.threeModule, true, "Не создан обработчик обновления 3D-сцены");
    assert.equal(threeReady.raycastMapper, true, "Не создано преобразование координат для перспективной 3D-камеры");

    const lobbyOverflow = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth
    }));
    assert.equal(lobbyOverflow.documentWidth, lobbyOverflow.viewportWidth,
      "В лобби бильярда появилась горизонтальная прокрутка");

    await page.locator("#botTestBtn").click();
    await page.locator("#createRoomBtn").click();
    await page.waitForFunction(() => !document.getElementById("waitingView").classList.contains("hidden"));
    assert.equal(await page.locator("#startGameBtn").isDisabled(), false,
      "В тестовой комнате с ботом кнопка начала игры должна быть активна");

    await page.locator("#startGameBtn").click();
    await page.waitForFunction(() => !document.getElementById("gameView").classList.contains("hidden"));
    await page.waitForFunction(() => window.billiards3DReady === true);
    const activeCanvas = await page.evaluate(() => { const canvas = document.getElementById("pool3DCanvas"); const rect = canvas.getBoundingClientRect(); return { width: rect.width, height: rect.height, opacity: getComputedStyle(canvas).opacity }; });
    assert.ok(activeCanvas.width > 100 && activeCanvas.height > 100, "После открытия игры у 3D-стола нет видимой области: " + JSON.stringify(activeCanvas));
    assert.equal(activeCanvas.opacity, "1", "3D-стол должен быть видимым");
    assert.ok(activeCanvas.width >= 360 && activeCanvas.height >= 350, "Бильярдный стол не занимает большую часть полноэкранной области: " + JSON.stringify(activeCanvas));
    const cameraBefore = await page.evaluate(() => window.billiards3DGetCameraState());
    await page.locator("#viewModeBtn").click();
    assert.equal(await page.locator("#viewModeBtn").getAttribute("aria-pressed"), "true", "Режим настройки ракурса не включился");
    const cameraRect = await page.locator("#pool3DCanvas").boundingBox();
    await page.mouse.move(cameraRect.x + cameraRect.width * 0.45, cameraRect.y + cameraRect.height * 0.48);
    await page.mouse.down();
    await page.mouse.move(cameraRect.x + cameraRect.width * 0.61, cameraRect.y + cameraRect.height * 0.57, { steps: 5 });
    await page.mouse.up();
    const cameraAfter = await page.evaluate(() => window.billiards3DGetCameraState());
    assert.ok(Math.abs(cameraAfter.theta-cameraBefore.theta) > 0.05 || Math.abs(cameraAfter.phi-cameraBefore.phi) > 0.05, "Перетаскивание пальцем в режиме ракурса не повернуло камеру");
    assert.equal(stakeRequests.length, 0, "Настройка ракурса ошибочно отправила удар");
    await page.locator("#viewModeBtn").click();
    assert.equal(await page.locator("#viewModeBtn").getAttribute("aria-pressed"), "false", "Режим ракурса не выключился");
    assert.equal(await page.locator("#shotPowerRange").count(), 1, "На игровом экране отсутствует ползунок силы удара");
    await page.locator("#shotPowerRange").evaluate(el => {
      el.value = "78";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await page.locator("#shotPowerValue").textContent(), "78%", "Процент силы удара не обновился");

    const coordProbe = await page.evaluate(() => {
      const canvas = document.getElementById("pool3DCanvas");
      const rect = canvas.getBoundingClientRect();
      return window.billiards3DPointerCoords(rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    assert.ok(coordProbe && Number.isFinite(coordProbe.x) && Number.isFinite(coordProbe.y),
      "3D луч не преобразовал экранные координаты в координаты стола");
    assert.ok(coordProbe.x > 50 && coordProbe.x < 750 && coordProbe.y > 50 && coordProbe.y < 390,
      "Преобразование координат 3D-камеры дало точку далеко за столом: " + JSON.stringify(coordProbe));

    const rect = await page.locator("#pool3DCanvas").boundingBox();
    assert.ok(rect, "Не найдена область 3D-стола");
    await page.mouse.move(rect.x + rect.width * 0.51, rect.y + rect.height * 0.48);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * 0.62, rect.y + rect.height * 0.48, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById("gameMessage")?.textContent === "Удар тестируется." && document.getElementById("aimText")?.textContent?.endsWith("потяни в направлении удара"), { timeout: 15000 });
    assert.equal(stakeRequests.length, 1, "Жест прицеливания не вызвал API выстрела");
    assert.equal(stakeRequests[0].power, 78, "Удар не передал выбранную силу 78%");
    assert.ok(Number.isFinite(stakeRequests[0].angle), "Удар не передал числовой угол");

    await page.screenshot({ path: resolve(out, "billiards-3d-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 740 });
    const smallScreen = await page.evaluate(() => {
      const canvas = document.getElementById("pool3DCanvas");
      const r = canvas.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        gameVisible: !document.getElementById("gameView").classList.contains("hidden"),
        canvasWidth: r.width,
        canvasHeight: r.height,
        sliderVisible: (() => { const e = document.getElementById("shotPowerRange"); const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; })()
      };
    });
    fs.writeFileSync(resolve(out, "billiards-3d-mobile-report.json"), JSON.stringify({
      threeReady, lobbyOverflow, activeCanvas, cameraBefore, cameraAfter, coordProbe, smallScreen, apiCalls, shots: stakeRequests, pageErrors, consoleErrors, failedRequests
    }, null, 2));
    assert.equal(smallScreen.gameVisible, true, "На узком экране игровой экран исчез");
    assert.equal(smallScreen.documentWidth, smallScreen.viewportWidth, "На узком экране появилась горизонтальная прокрутка");
    assert.ok(smallScreen.canvasWidth > 100 && smallScreen.canvasHeight > 100, "На узком экране стол слишком мал");
    assert.equal(smallScreen.sliderVisible, true, "На узком экране ползунок силы удара не виден");
    assert.equal(pageErrors.length, 0, "Ошибки JavaScript страницы: " + pageErrors.join(" | "));
    assert.equal(failedRequests.length, 0, "Неудачные сетевые запросы: " + JSON.stringify(failedRequests));
    console.log("BILLIARDS 3D SMOKE PASS", JSON.stringify({
      threeReady, coordinateProbePassed: true, shotPowerPassed: stakeRequests[0].power,
      apiCalls: apiCalls.length, pageErrors: pageErrors.length, failedRequests: failedRequests.length
    }));
  } finally {
    await browser?.close();
    server.close();
  }
} catch (error) {
  try {
    fs.writeFileSync(resolve(out, "billiards-3d-smoke-failure.txt"), String(error?.stack || error));
  } catch {}
  throw error;
}
