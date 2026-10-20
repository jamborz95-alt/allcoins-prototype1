import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const html = await readFile(resolve(root, "index.html"));
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((resolveListen) => server.listen(4173, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  const apiCalls = [];
  let mockDurakPhase = "attack";
  let mockDurakPlayerIndex = 0;
  let mockDurakTable = [{ attack: { id: "table-6-clubs", rank: "6", suit: "♣" }, defense: null }];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("https://telegram.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Telegram = { WebApp: { initData: 'mock-init-data', initDataUnsafe: { user: { id: 12345, first_name: 'Тестовый Игрок' } }, ready(){}, expand(){}, colorScheme:'dark' } };"
  }));
  await page.route("https://sad.adsgram.ai/**", (route) => route.fulfill({
    status: 200, contentType: "application/javascript", body: ""
  }));
  await page.route("https://allcoins-server.onrender.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    apiCalls.push({ path: url.pathname, body });

    if (url.pathname === "/api/auth") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, player: { telegram_id: "12345", first_name: "Тестовый Игрок", balance: 10000, energy: 100 } }) });
    }
    if (url.pathname === "/api/tap") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, player: { telegram_id: "12345", first_name: "Тестовый Игрок", balance: 10100, energy: 99 } }) });
    }
    if (url.pathname === "/api/durak/rooms/list") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rooms: [] }) });
    }
    if (url.pathname === "/api/durak/game") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, roomId: "77",
        hand: [
          { id: "card-6-hearts", rank: "6", suit: "♥" },
          { id: "card-ace-spades", rank: "A", suit: "♠" },
          { id: "card-king-clubs", rank: "K", suit: "♣" },
          { id: "card-9-diamonds", rank: "9", suit: "♦" },
          { id: "card-7-hearts", rank: "7", suit: "♥" },
          { id: "card-queen-spades", rank: "Q", suit: "♠" }
        ],
        trumpSuit: "♥", trumpCard: { id: "trump-8-hearts", rank: "8", suit: "♥" },
        table: mockDurakTable,
        cardsLeft: 24, status: "playing", phase: mockDurakPhase,
        attackerIndex: 0, defenderIndex: 1, playerIndex: mockDurakPlayerIndex,
        players: [
          { telegramId: "12345", label: "👤 Тестовый Игрок", cardsCount: 6 },
          { telegramId: "0", label: "🤖 Бот ALLCOINS", cardsCount: 6 }
        ]
      }) });
    }
    if (url.pathname === "/api/durak/action") {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, message: "Ход принят" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, rooms: [], player: { balance: 10000, energy: 100 } }) });
  });

  await page.goto("http://127.0.0.1:4173", { waitUntil: "domcontentloaded" });
  await page.locator("#tapButton").waitFor();

  // Clicker: +100 AC and -1 energy with a mocked authenticated API response.
  const initialBalance = Number((await page.locator("#balance").innerText()).replace(/\D/g, ""));
  const initialEnergy = Number((await page.locator("#energy").innerText()).replace(/\D/g, ""));
  await page.locator("#tapButton").click();
  await page.waitForFunction(() => document.querySelector("#energy")?.textContent?.trim() === "99");
  const newBalance = Number((await page.locator("#balance").innerText()).replace(/\D/g, ""));
  assert.equal(newBalance, initialBalance + 100, "tap should add 100 AC");
  assert.equal(Number((await page.locator("#energy").innerText()).replace(/\D/g, "")), initialEnergy - 1, "tap should consume 1 energy");

  // Bottom navigation must open each section.
  for (const section of ["games", "withdraw", "profile", "home"]) {
    await page.locator(`.nav button[data-page="${section}"]`).click();
    assert.equal(await page.locator(`#${section}`).evaluate((el) => el.classList.contains("hidden")), false,
      `navigation should show #${section}`);
  }

  // Durak markup and test-bot control must exist.
  await page.locator('.nav button[data-page="games"]').click();
  assert.equal(await page.locator("#durakGame").count(), 1, "Durak game section should exist");
  assert.equal(await page.locator("#durakTable").count(), 1, "Durak table should exist");
  assert.equal(await page.locator("#durakAddBotButton").count(), 1, "test bot button should exist");

  // Render a complete mocked game to test nicknames, card backs, cards and turn controls.
  await page.evaluate(async () => {
    await window.loadDurakGame("77");
  });
  await page.locator("#durakPlayers .durak-player").nth(1).waitFor();
  assert.equal(await page.locator("#durakPlayers .durak-player").count(), 2, "both players should appear");
  assert.match(await page.locator("#durakPlayers").innerText(), /Тестовый Игрок/, "user nickname should render");
  assert.match(await page.locator("#durakPlayers").innerText(), /Бот ALLCOINS/, "bot nickname should render");
  assert.equal(await page.locator("#durakPlayers .durak-card-back").count(), 6, "opponent card backs should render");
  assert.equal(await page.locator("#durakHand .durak-card").count(), 6, "player hand should render six cards");
  assert.equal(await page.locator("#durakTable .table-card").count(), 1, "attack card should render on table");
  assert.equal(await page.locator("#durakTurnMessage").evaluate((el) => el.style.display), "flex", "turn message should be visible for attacker");
  assert.equal((await page.locator("#durakTurnMessage").innerText()).trim(), "ТВОЯ АТАКА",
    "attacker should see a clear attack prompt");
  assert.equal(apiCalls.some((call) => call.path === "/api/durak/game" && String(call.body.roomId) === "77"), true,
    "game state should be requested from the API");

  // A defending player should see a defense-specific prompt.
  mockDurakPhase = "defense";
  mockDurakPlayerIndex = 1;
  await page.evaluate(async () => { await loadDurakGame("77"); });
  assert.equal((await page.locator("#durakTurnMessage").innerText()).trim(), "ТВОЯ ЗАЩИТА",
    "defender should see a clear defense prompt");
  assert.notEqual(await page.locator("#durakTake").evaluate((el) => el.style.display), "none",
    "defender should be able to take an open attack");

  // The defender must still be able to take after covering every current attack,
  // until the attacker explicitly declares the round beaten.
  mockDurakTable = [{
    attack: { id: "table-6-clubs", rank: "6", suit: "♣" },
    defense: { id: "table-7-clubs", rank: "7", suit: "♣" }
  }];
  mockDurakPhase = "attack";
  await page.evaluate(async () => { await loadDurakGame("77"); });
  assert.notEqual(await page.locator("#durakTake").evaluate((el) => el.style.display), "none",
    "defender should still be able to take before the attacker declares beat");
  assert.equal(await page.locator("#durakDefend").evaluate((el) => el.style.display), "none",
    "defend button should be hidden when no attack card is uncovered");

  mockDurakTable = [
    { attack: { id: "table-6-clubs", rank: "6", suit: "♣" }, defense: { id: "table-7-clubs", rank: "7", suit: "♣" } },
    { attack: { id: "table-8-diamonds", rank: "8", suit: "♦" }, defense: null }
  ];
  mockDurakPhase = "defense";
  await page.evaluate(async () => { await loadDurakGame("77"); });
  assert.notEqual(await page.locator("#durakDefend").evaluate((el) => el.style.display), "none",
    "defender should be able to defend the next uncovered attack");
  assert.notEqual(await page.locator("#durakTake").evaluate((el) => el.style.display), "none",
    "defender should retain the option to take the full table");

  mockDurakTable = [{ attack: { id: "table-6-clubs", rank: "6", suit: "♣" }, defense: null }];
  mockDurakPhase = "attack";
  mockDurakPlayerIndex = 0;
  await page.evaluate(async () => { await loadDurakGame("77"); });

  // Rapid repeated taps must not submit the same Durak move more than once.
  const actionsBefore = apiCalls.filter((call) => call.path === "/api/durak/action").length;
  await page.evaluate(async () => {
    currentDurakRoomId = "77";
    selectedDurakCardId = "card-6-hearts";
    await Promise.all([durakAction("attack"), durakAction("attack")]);
  });
  const actionsAfter = apiCalls.filter((call) => call.path === "/api/durak/action").length;
  assert.equal(actionsAfter - actionsBefore, 1, "duplicate rapid actions should be blocked");
  assert.equal(await page.locator("#durakHand .durak-card").count(), 6, "hand should re-render after a successful action");

  assert.deepEqual(pageErrors, [], "page should not produce JavaScript errors");
  console.log("PASS: clicker, energy, navigation, Durak player names, bot, cards, duplicate-action protection, no page errors");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((err) => err ? rejectClose(err) : resolveClose()));
}
