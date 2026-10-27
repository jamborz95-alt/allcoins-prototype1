import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const html = await readFile(resolve(root, "drag-racing.html"), "utf8");
const indexHtml = await readFile(resolve(root, "index.html"), "utf8");
await readFile(resolve(root, "server/drag-racing-router.js"), "utf8");
assert.ok(indexHtml.includes('id="dragRacingEntry"'), "The game tile should be present in ALLCOINS.");
assert.ok(indexHtml.includes('href="./drag-racing.html?v=20261027-drag2"'), "The game tile should link to the cache-busted Drag Racing page.");

let balance = 10000;
let ownedCars = ["2107"];
let selectedCarId = "2107";
let upgrades = { "2107": {} };
let tune = { ecu: 50, boost: 25, grip: 70, shift: 45 };
let activeRoom = null;
const apiCalls = [];
const carPrices = { "2105": 3500, "2104": 4500, "2106": 6000, "2109": 7500, "2110": 11000, priora: 18000, kalina: 25000, granta: 35000, niva: 50000, vesta: 85000 };

function profilePayload() {
  return { ok: true, balance, profile: { ownedCars: [...ownedCars], selectedCarId, upgrades: structuredClone(upgrades), tune: { ...tune } } };
}
function roomPayload() {
  return { ok: true, balance, room: activeRoom.room, players: activeRoom.players, game: activeRoom.game };
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1:4174");
  if (url.pathname === "/drag-racing.html" || url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});
await new Promise(resolveListen => server.listen(4174, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Telegram={WebApp:{initData:'mock-init-data',initDataUnsafe:{user:{id:12345,first_name:'Test Driver'}},ready(){},expand(){},colorScheme:'dark'}};"
  }));
  await page.route("https://allcoins-server.onrender.com/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    apiCalls.push({ path: url.pathname, body });
    if (url.pathname === "/api/drag-racing/profile") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/rooms/list") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, currentRoom: activeRoom ? roomPayload() : null, rooms: []
      }) });
    }
    if (url.pathname === "/api/drag-racing/garage/buy") {
      const id = String(body.carId || "");
      const price = Number(carPrices[id] || 0);
      if (ownedCars.includes(id)) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Already owned" }) });
      if (balance < price) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Not enough" }) });
      balance -= price;
      ownedCars.push(id);
      selectedCarId = id;
      upgrades[id] = {};
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/garage/select") {
      selectedCarId = String(body.carId);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/garage/upgrade") {
      const id = String(body.carId), part = String(body.partId);
      upgrades[id] = upgrades[id] || {};
      upgrades[id][part] = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/garage/tune") {
      tune = { ...body.tune };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/rooms/create") {
      const stake = Number(body.stake);
      if (balance < stake) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Not enough balance" }) });
      balance -= stake;
      activeRoom = {
        room: { id: "DR-71", roomId: "71", ownerId: "12345", ownerName: "Test Driver",
          stake, maxPlayers: Number(body.maxPlayers), playersCount: 1, mode: body.mode,
          status: "waiting", isOwner: true },
        players: [{ id: "12345", name: "Test Driver", carId: selectedCarId, isYou: true, isOwner: true, connected: true, finishTimeMs: null }],
        game: { phase: "waiting", startedAt: null, results: {}, winners: [], payout: 0, commission: 0, message: "" }
      };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(roomPayload()) });
    }
    if (url.pathname === "/api/drag-racing/rooms/state") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(roomPayload()) });
    }
    if (url.pathname === "/api/drag-racing/rooms/leave") {
      if (activeRoom?.room.status === "waiting") balance += activeRoom.room.stake;
      activeRoom = null;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, balance, message: "Left room" }) });
    }
    if (url.pathname === "/api/drag-racing/rooms/start") {
      activeRoom.room.status = "racing";
      activeRoom.game = { phase: "racing", startedAt: Date.now(), results: {}, winners: [], payout: 0, commission: 0, message: "" };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(roomPayload()) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Mock route not found" }) });
  });

  await page.goto("http://127.0.0.1:4174/drag-racing.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#roomStatus")?.textContent.includes("Баланс") ||
    document.querySelector("#roomStatus")?.textContent.includes("Открытых"));
  assert.equal((await page.locator("#balance").textContent()).replace(/\\s/g, ""), "10000");
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/profile" && call.body.initData === "mock-init-data"),
    "Profile request should contain Telegram initData.");

  await page.getByRole("button", { name: "🛒 Магазин" }).click();
  const cheapCar = page.locator(".car-card").filter({ hasText: "ВАЗ-2104" });
  await cheapCar.getByRole("button", { name: "Купить" }).click();
  await page.waitForFunction(() => Number(document.querySelector("#balance")?.textContent.replace(/\\D/g, "")) === 5500);
  assert.ok(ownedCars.includes("2104"), "The inexpensive VAZ-2104 should be bought through the mocked server wallet.");
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/garage/buy" && call.body.carId === "2104"),
    "Garage purchase should be sent to the authenticated server.");

  await page.getByRole("button", { name: "🏁 Гонки" }).click();
  await page.locator("#stake").fill("1000");
  await page.locator("#createRoom").click();
  await page.waitForFunction(() => !document.querySelector("#onlineRoom")?.classList.contains("hidden"));
  assert.equal(await page.locator("#onlineRoomInfo").locator(".title").textContent(), "DR-71 · ¼ мили");
  assert.equal(activeRoom.room.status, "waiting");
  assert.equal(activeRoom.room.stake, 1000);
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/rooms/create" &&
    call.body.initData === "mock-init-data" && call.body.stake === 1000),
    "Creating a room should send Telegram identity and the requested stake.");
  assert.ok(pageErrors.length === 0, "Browser console errors: " + pageErrors.join("; "));

  console.log("Drag Racing UI smoke test passed: mobile page, server garage purchase and online room creation.");
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
