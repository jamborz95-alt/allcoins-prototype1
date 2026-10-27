import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};
let balance = 1000000;
let garage = [{
  carId: "2107", upgrades: {},
  tuning: { ecu: 50, boost: 25, grip: 70, shift: 45 },
  selected: true
}];
let nextRoom = null;

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
    const path = resolve(root, "." + pathname);
    if (!path.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
});
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
const origin = "http://127.0.0.1:" + address.port;

const balancePayload = () => ({
  balance: String(balance),
  garage: garage.map(item => ({ ...item, upgrades: { ...item.upgrades }, tuning: { ...item.tuning } }))
});
const roomPayload = () => ({
  ok: true,
  room: {
    id: "77", ownerId: "12345", ownerName: "Тестовый гонщик",
    stake: "1000", maxPlayers: 2, mode: "quarter",
    status: "waiting", game: {}, createdAt: new Date().toISOString()
  },
  players: [{
    id: "12345", display_name: "Тестовый гонщик",
    car_id: garage.find(item => item.selected)?.carId || "2107",
    gear: 1, throttle: false, clutch: false, speed: 0, distance: 0,
    rpm: 900, finished_at: null, isMe: true
  }]
});

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"]
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200, contentType: "application/javascript",
    body: "window.Telegram={WebApp:{initData:'test-init-data',initDataUnsafe:{user:{id:12345,first_name:'Тестовый гонщик'}},ready(){},expand(){}}};"
  }));
  await page.route("https://allcoins-server.onrender.com/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/drag-racing", "");
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    const reply = (payload, status=200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(payload)
    });
    if (body.initData !== "test-init-data") return reply({ ok: false, error: "Bad test identity" }, 401);
    if (path === "/garage") return reply({ ok: true, ...balancePayload() });
    if (path === "/rooms/list") return reply({ ok: true, rooms: [] });
    if (path === "/shop/buy-car") {
      const price = { "2104": 95000, "2105": 75000, "2106": 85000, "2109": 125000, "2110": 165000, "2112": 205000, "2114": 220000 }[body.carId] || 0;
      if (price <= 0 || balance < price) return reply({ ok: false, error: "Недостаточно AC" }, 400);
      if (garage.some(item => item.carId === body.carId)) return reply({ ok: false, error: "Уже куплен" }, 409);
      balance -= price;
      garage = garage.map(item => ({ ...item, selected: false }));
      garage.push({
        carId: body.carId, upgrades: {},
        tuning: { ecu: 50, boost: 25, grip: 70, shift: 45 },
        selected: true
      });
      return reply({ ok: true, ...balancePayload(), message: "Автомобиль куплен." });
    }
    if (path === "/shop/buy-part") {
      return reply({ ok: true, ...balancePayload(), message: "Запчасть установлена." });
    }
    if (path === "/tuning/save") return reply({ ok: true, ...balancePayload() });
    if (path === "/rooms") {
      const stake = Number(body.stake) || 1000;
      if (balance < stake) return reply({ ok: false, error: "Недостаточно AC" }, 400);
      balance -= stake;
      nextRoom = roomPayload();
      nextRoom.room.stake = String(stake);
      nextRoom.room.maxPlayers = Number(body.players) || 2;
      nextRoom.room.mode = body.mode || "quarter";
      return reply(nextRoom);
    }
    if (path === "/rooms/state") return reply(nextRoom || { ok: false, error: "no room" }, nextRoom ? 200 : 404);
    if (path === "/rooms/action") return reply({ ok: true });
    if (path === "/rooms/start") return reply({ ok: true, ...roomPayload() });
    if (path === "/rooms/leave") {
      nextRoom = null;
      return reply({ ok: true, refunded: true });
    }
    return reply({ ok: true });
  });

  await page.goto(origin + "/drag-racing.html?v=ci-smoke", { waitUntil: "domcontentloaded" });
  // The garage tab is the default; switch to the shop before waiting for visible car cards.
  await page.locator('[data-tab="shop"]').click();
  await page.waitForSelector("#carShop .car-card", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#carShop .car-card").length === 12);
  await page.waitForSelector("#scene", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("#scene")?.classList.contains("has3d"), { timeout: 30000 });
  assert.equal(await page.locator("#race3dCanvas").count(), 1, "3D canvas should be present");
  const dimensions = await page.locator("#race3dCanvas").evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  assert.ok(dimensions.width > 250 && dimensions.height > 160, "3D renderer should size the canvas");

  await mkdir(resolve(root, "artifacts"), { recursive: true });
  await page.screenshot({ path: resolve(root, "artifacts/drag-racing-mobile.png"), fullPage: true });

  await page.locator('[data-tab="shop"]').click();
  const carPrice = await page.locator('[data-buycar="2104"]').evaluate(button => button.parentElement.textContent);
  assert.match(carPrice, /95\s*000\s*AC/);
  await page.locator('[data-buycar="2104"]').click();
  await page.waitForFunction(() => document.getElementById("balance")?.textContent.replace(/\D/g, "") === "905000");
  await page.locator('[data-tab="garage"]').click();
  assert.ok((await page.locator("#garageContent").textContent()).includes("ВАЗ-2104"));

  await page.locator('[data-tab="race"]').click();
  await page.locator("#stake").fill("1000");
  await page.locator("#createRoom").click();
  await page.waitForFunction(() => document.getElementById("rooms")?.textContent.includes("Комната #77"), { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById("balance")?.textContent.replace(/\D/g, "") === "904000");
  assert.deepEqual(pageErrors, [], "Drag Racing page should have no uncaught JavaScript errors");
  console.log("Drag Racing mobile smoke passed: 12 cars, 3D renderer, VAZ-2104 purchase, online room and stake debit.");
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
