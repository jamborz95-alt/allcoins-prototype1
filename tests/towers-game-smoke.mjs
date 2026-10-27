import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

await mkdir(resolve(process.cwd(), "artifacts"), { recursive: true });
const html = await readFile(resolve(process.cwd(), "towers.html"), "utf8");
const index = await readFile(resolve(process.cwd(), "index.html"), "utf8");
const towersRouter = await readFile(resolve(process.cwd(), "server/towers-router.js"), "utf8");
assert.ok(index.includes('id="towersEntry"') && /href="\.\/towers\.html\?v=[^"]+"/.test(index),
  "The Games menu should link to Towers Capture.");
assert.ok(html.includes('id="gameView"') && html.includes('id="practice"') &&
  html.includes('id="stakeInput"') && html.includes('id="playersInput"'),
  "The game needs a fullscreen battlefield, bot practice and room options.");
assert.ok(html.includes(".turret-head") && html.includes(".soldier-helmet") &&
  html.includes('type-shooter') && towersRouter.includes('type: "shooter"'),
  "The battlefield should render detailed 3D-style troop figures and a shooting tower.");
assert.ok(html.includes("function updateShooterAims") && html.includes("function animateCannonShot") &&
  html.includes("tower-projectile") && html.includes("@keyframes towerEntryMove") &&
  html.includes("function animateTowerEntry") && html.includes("function detectOnlineArrivals") &&
  html.includes("@keyframes cannonRecoil") && html.includes("function spawnShotImpact"),
  "The turret should smoothly rotate and launch a moving projectile; troops should visibly enter captured towers.");
assert.ok(html.includes("stampFleetProgress(state,previousState=null)") &&
  html.includes("fleetProgressAt(old,stamp)") && html.includes("f._visualProgressBase=f.progress") &&
  html.includes("el.classList.toggle('hit',stillHit)") &&
  html.includes("(gameState.fleets||[]).length===0)return"),
  "Troop motion should stay continuous across network snapshots, preserve soldier CSS animations and stop idle animation frames.");
assert.ok(towersRouter.includes("function tickShooterTowers(game, now)") &&
  html.includes("function fireShooterTowers(state,now)") && html.includes("el.classList.add('firing')") &&
  html.includes("spawnShotImpact") && html.includes("fleet-count"),
  "The shooting tower should damage enemy troops, animate projectile impacts, show troop losses and display current troop counts.");
assert.ok(html.includes("Стратегия в реальном времени") && html.includes("function localTick()"),
  "The game should implement real-time tower control and local practice.");
assert.ok(towersRouter.includes("roads: []") && towersRouter.includes("function rememberRoad(game, fromId, toId, ownerId = null)") &&
  towersRouter.includes("rememberRoad(game, fromId, toId, String(user.id));") &&
  towersRouter.includes("function tickAutoRoads(game, now)"),
  "The backend should persist roads and auto-send troops after the route is created.");
assert.ok(html.includes(".road-group.road-blue") && html.includes(".road-group.road-red") &&
  html.includes(".road-group.road-green") && html.includes("requestAnimationFrame(fleetAnimationTick)"),
  "Roads should use player colours and fleets should move through frame-based animation.");
assert.ok(html.includes("function travelDuration(from,to,troops)") && towersRouter.includes("function travelDuration(from, to, troops)") &&
  html.includes("roadColorFor(id,explicitColor)") && html.includes("Маршрут сохранён: войска будут идти автоматически"),
  "Travel speed should scale with the dispatched army size.");
const distanceFn = towersRouter.match(/function distance\(a, b\) \{[\s\S]*?\n\}/)?.[0];
const durationFn = towersRouter.match(/function travelDuration\(from, to, troops\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(distanceFn && durationFn, "The backend should define route distance and speed calculations.");
const getDuration = new Function(distanceFn + "\n" + durationFn + "\nreturn travelDuration;")();
assert.ok(getDuration({ x: 0, y: 0 }, { x: 70, y: 0 }, 100) < getDuration({ x: 0, y: 0 }, { x: 70, y: 0 }, 4),
  "A larger army must travel faster than a smaller army.");

const colourFn = towersRouter.match(/function playerColorFor\(game, ownerId\) \{[\s\S]*?\n\}/)?.[0];
const rememberFn = towersRouter.match(/function rememberRoad\(game, fromId, toId, ownerId = null\) \{[\s\S]*?\n\}/)?.[0];
const autoFn = towersRouter.match(/function tickAutoRoads\(game, now\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(colourFn && rememberFn && autoFn, "Road ownership and automatic dispatch helpers should exist.");
const roadHelpers = new Function(distanceFn + "\n" + durationFn + "\n" + colourFn + "\n" + rememberFn + "\n" + autoFn +
  "\nreturn { rememberRoad, tickAutoRoads };")();
const roadSimulation = {
  players: [
    { telegramId: "100", name: "Blue", color: "blue" },
    { telegramId: "200", name: "Red", color: "red" },
    { telegramId: "300", name: "Green", color: "green" }
  ],
  towers: [
    { id: 1, x: 0, y: 0, ownerId: "100", units: 30, income: 1.7 },
    { id: 2, x: 70, y: 0, ownerId: "200", units: 20, income: 1.7 }
  ],
  roads: [],
  fleets: [],
  nextFleetId: 1
};
roadHelpers.rememberRoad(roadSimulation, 1, 2, "100");
assert.equal(roadSimulation.roads[0].ownerColor, "blue", "The route must retain the sender's blue colour.");
const fleetsBeforeAutoSend = roadSimulation.fleets.length;
roadHelpers.tickAutoRoads(roadSimulation, Date.now() + 3000);
assert.ok(roadSimulation.fleets.length > fleetsBeforeAutoSend, "The route should dispatch a new troop wave without another manual action.");
roadHelpers.rememberRoad(roadSimulation, 2, 1, "200");
assert.equal(roadSimulation.roads.find(road => road.fromId === 2).ownerColor, "red", "A route laid by a red player must not turn blue.");

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/towers.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end("Not found");
});
await new Promise(resolveListen => server.listen(4175, "127.0.0.1", resolveListen));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200, contentType: "application/javascript", body: `
      window.Telegram={WebApp:{initData:"mock-init-data",initDataUnsafe:{user:{id:12345,first_name:"Тестовый игрок"}},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},requestFullscreen(){window.__fullscreenRequests=(window.__fullscreenRequests||0)+1;return Promise.resolve();},BackButton:{show(){},hide(){},onClick(){}}}};
    `
  }));
  await page.route("https://allcoins-server.onrender.com/**", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rooms: [] })
  }));
  // This smoke scenario exercises the DOM interaction layer deterministically.
  // A separate page below checks that the real WebGL battlefield also starts.
  await page.route("https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js", route => route.abort());
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:4175/towers.html", { waitUntil: "domcontentloaded" });
  await page.locator("#practice").waitFor();
  await page.locator("#practice").click();
  await page.locator("#gameView:not(.hidden)").waitFor();
  assert.ok(await page.evaluate(() => (window.__fullscreenRequests || 0) >= 1), "Starting a match should request Telegram fullscreen.");
  await page.locator(".tower[data-tower='1']").waitFor();
  assert.equal(await page.locator(".tower").count(), 10, "Practice mode should draw ten towers including the shooting turret.");
  assert.equal(await page.locator(".tower.type-shooter").count(), 1, "The battlefield should have one shooting turret.");
  assert.equal(await page.locator(".tower.type-shooter .shooter-model").count(), 1, "The shooting turret should use its own 3D model.");
  await page.locator(".tower[data-tower='1']").click();
  await page.locator(".tower[data-tower='4']").click();
  await page.locator(".fleet").first().waitFor({ timeout: 3000 });
  const firstFleet = page.locator("#fleets .fleet").first();
  assert.equal(await firstFleet.locator(".fleet-soldier").count(), 5, "Moving armies should show a squad of detailed soldier figures.");
  const firstTransform = await firstFleet.evaluate(el => el.style.transform);
  await page.waitForTimeout(90);
  const nextTransform = await firstFleet.evaluate(el => el.style.transform);
  assert.notEqual(nextTransform, firstTransform, "Fleet position should update smoothly between server/game ticks.");
  await page.locator(".tower[data-tower='1']").click();
  await page.locator(".tower[data-tower='5']").click();
  await page.waitForFunction(() => document.querySelectorAll("#fleets .fleet").length >= 2, null, { timeout: 3000 });
  assert.ok(await page.locator("#routeSvg .road-group").count() >= 2, "Multiple attacks should leave multiple asphalt roads on the map.");
  assert.ok(await page.locator("#routeSvg .road-group.road-blue").count() >= 2, "Player roads should use the player's colour.");
  assert.ok(await page.locator("#routeSvg line.road-asphalt").count() >= 2, "Each route should have an asphalt road surface.");
  assert.ok(await page.locator("#fleets .fleet-soldier").count() >= 6, "Armies on multiple roads should contain animated soldier figures.");

  assert.deepEqual(errors, [], "The Towers Capture page should not throw browser errors.");

  // Independent runtime check for the actual Three.js battlefield. The preceding
  // scenario intentionally forces the safe DOM fallback so interaction assertions
  // do not target hidden DOM layers underneath the WebGL canvas.
  const visualPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true
  });
  const visualErrors = [];
  await visualPage.route("https://telegram.org/**", route => route.fulfill({
    status: 200, contentType: "application/javascript", body: `
      window.Telegram={WebApp:{initData:"mock-init-data",initDataUnsafe:{user:{id:12345,first_name:"Тестовый игрок"}},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},requestFullscreen(){window.__fullscreenRequests=(window.__fullscreenRequests||0)+1;return Promise.resolve();},BackButton:{show(){},hide(){},onClick(){}}}};
    `
  }));
  await visualPage.route("https://allcoins-server.onrender.com/**", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rooms: [] })
  }));
  visualPage.on("pageerror", error => visualErrors.push(error.message));
  await visualPage.goto("http://127.0.0.1:4175/towers.html", { waitUntil: "domcontentloaded" });
  await visualPage.locator("#practice").click();
  await visualPage.locator("#field.tower3d-active").waitFor({ timeout: 20000 });
  const canvas = visualPage.locator("#field > canvas.tower3d-canvas");
  await canvas.waitFor({ state: "visible", timeout: 10000 });
  const canvasInfo = await canvas.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const ctx = el.getContext("webgl2") || el.getContext("webgl");
    return { width: rect.width, height: rect.height, backingWidth: el.width, backingHeight: el.height, hasWebGL: Boolean(ctx) };
  });
  assert.ok(canvasInfo.width >= 300 && canvasInfo.height >= 350 && canvasInfo.backingWidth >= 300 && canvasInfo.backingHeight >= 350,
    "The Three.js battlefield canvas should render at mobile viewport size: " + JSON.stringify(canvasInfo));
  assert.equal(canvasInfo.hasWebGL, true, "The 3D battlefield should have a working WebGL context.");
  assert.deepEqual(visualErrors, [], "The 3D Towers Capture page should not throw browser errors.");
  await visualPage.screenshot({ path: resolve(process.cwd(), "artifacts/towers-3d-mobile.png"), fullPage: true });
  await visualPage.close();
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
console.log("Towers Capture mobile smoke test passed: DOM fallback interactions and real 3D battlefield renderer.");
