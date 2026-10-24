import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const sekaHtml = await readFile(resolve(root, "seka.html"), "utf8");
const server = createServer((req, res) => {
  if (new URL(req.url || "/", "http://127.0.0.1").pathname === "/seka.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(sekaHtml);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});
await new Promise((resolveListen) => server.listen(4174, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  let roomCreated = false;
  let botAdded = false;
  let gameStarted = false;
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("https://telegram.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: `
      window.__tgFullscreenRequests = 0;
      window.Telegram = {
        WebApp: {
          initData: "mock-init-data",
          initDataUnsafe: { user: { id: 12345, first_name: "Тестовый игрок" } },
          isFullscreen: false,
          ready() {},
          expand() {},
          requestFullscreen() {
            window.__tgFullscreenRequests++;
            this.isFullscreen = true;
          },
          exitFullscreen() { this.isFullscreen = false; },
          BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} }
        }
      };
    `
  }));

  await page.route("https://allcoins-server.onrender.com/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(body)
    });
    if (pathname === "/api/auth") {
      return json({ ok: true, player: { telegram_id: "12345", first_name: "Тестовый игрок", balance: 10000 } });
    }
    if (pathname === "/api/seka/rooms/list") return json({ ok: true, rooms: [] });
    if (pathname === "/api/seka/rooms/create") {
      roomCreated = true;
      return json({ ok: true, room: { id: "321", name: "Тестовая Сека", status: "waiting" } });
    }
    if (pathname === "/api/seka/rooms/add-bot") {
      botAdded = true;
      return json({ ok: true, roomId: "321", botAdded: true, label: "🤖 Бот ALLCOINS" });
    }
    if (pathname === "/api/seka/rooms/start") {
      // Keep the server response pending briefly. Fullscreen must be requested
      // synchronously from the Start button, before this network response.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      gameStarted = true;
      return json({ ok: true, roomId: "321", started: true });
    }
    if (pathname === "/api/seka/rooms/state") {
      const players = [{
        telegramId: "12345", label: "Тестовый игрок", balance: 10000, isBot: false
      }];
      if (botAdded) players.push({
        telegramId: "0", label: "🤖 Бот ALLCOINS", balance: 100000, isBot: true
      });
      const room = {
        id: "321", name: "Тестовая Сека", ownerTelegramId: "12345",
        tier: 1, limitLabel: "100–1 000 AC", minBet: 100, maxBet: 1000,
        ante: 100, maxPlayers: 6, playersCount: players.length,
        status: gameStarted ? "playing" : "waiting", isOwner: true
      };
      const game = gameStarted ? {
        status: "playing", testMode: true, pot: 200, ante: 100, currentBet: 100,
        currentPlayerTelegramId: "12345", isYourTurn: true,
        winnerTelegramIds: [], payouts: [], message: "Тестовая партия началась",
        settlementApplied: false, revealHands: false,
        players: [
          { telegramId: "12345", label: "Тестовый игрок", isBot: false, folded: false,
            contribution: 100, hand: [
              { rank: "9", suit: "♠" }, { rank: "8", suit: "♠" }, { rank: "7", suit: "♠" }
            ], score: null, payout: 0, cardCount: 3, handType: null },
          { telegramId: "0", label: "🤖 Бот ALLCOINS", isBot: true, folded: false,
            contribution: 100, hand: [], score: null, payout: 0, cardCount: 3, handType: null }
        ]
      } : null;
      return json({ ok: true, room, players, game, balance: 10000 });
    }
    return json({ ok: false, error: "Unexpected mock endpoint: " + pathname }, 404);
  });

  await page.goto("http://127.0.0.1:4174/seka.html", { waitUntil: "domcontentloaded" });
  await page.locator("#createRoomButton").waitFor();
  await page.waitForFunction(() => document.querySelector("#balanceValue")?.textContent.includes("AC"));

  await page.locator("#createRoomButton").click();
  await page.waitForFunction(() => document.querySelector("#addBotButton")?.classList.contains("hidden") === false);
  assert.equal(roomCreated, true, "room creation should complete before the fullscreen test");

  await page.locator("#addBotButton").click();
  await page.waitForFunction(() => document.querySelector("#startGameButton")?.disabled === false);
  assert.equal(botAdded, true, "test bot should be added before starting the round");

  await page.locator("#startGameButton").click();
  // The start endpoint deliberately responds after 500 ms; fullscreen request
  // must already have happened during the click's synchronous call stack.
  await page.waitForFunction(() => window.__tgFullscreenRequests > 0, null, { timeout: 250 });
  assert.equal(await page.locator("body").evaluate((el) => el.classList.contains("seka-playing")), true,
    "fullscreen layout class should turn on immediately when Start is pressed");
  assert.equal(gameStarted, false, "the mocked start request should still be pending when fullscreen is requested");

  await page.waitForFunction(() => document.querySelector("#myHand .playing-card"));
  await page.waitForFunction(() => document.body.classList.contains("seka-playing") &&
    document.querySelector("#gameWrap")?.classList.contains("hidden") === false);
  assert.equal(await page.locator(".topbar").evaluate((el) => getComputedStyle(el).display), "none",
    "the app header should be hidden during a started Seка round");
  assert.equal(await page.locator("#roomPanel > .room-facts").evaluate((el) => getComputedStyle(el).display), "none",
    "room details should be hidden during the fullscreen game");
  assert.equal(await page.locator("#gameWrap").evaluate((el) => getComputedStyle(el).display), "grid",
    "the actual game table should fill the fullscreen layout");
  assert.equal(await page.locator("#myHand .playing-card").count(), 3,
    "all three cards in the player's hand should remain visible in fullscreen");
  assert.equal(await page.locator("#myHandScore").textContent(), "24 очков",
    "the player should see their own numeric combination score before showdown");
  assert.equal(await page.locator("#myHandType").textContent(), "Одна масть",
    "the player should see the type of their own combination before showdown");
  assert.equal(await page.locator("#gamePlayerSeats .game-player-seat").count(), 2,
    "both player nicknames should be rendered around the table");
  assert.equal(await page.locator("#gamePlayerSeats .seat-bottom").count(), 1,
    "the current player should be seated at the bottom of the table");
  assert.equal(await page.locator("#gamePlayerSeats .seat-top-center").count(), 1,
    "the opponent should be seated across the table");
  assert.notEqual(await page.locator("#raiseButton").evaluate((el) => getComputedStyle(el).display), "none",
    "betting controls should remain available in fullscreen");
  assert.deepEqual(pageErrors, [], "the Seka page should not produce JavaScript errors");

  console.log("PASS: Seka requests Telegram fullscreen from the Start click before the network response and renders the table, hand and controls in the fullscreen layout.");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((err) => err ? rejectClose(err) : resolveClose()));
}
