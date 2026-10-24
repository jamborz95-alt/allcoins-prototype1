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
  let gameFinished = false;
  let rematchStarted = false;
  let currentBet = 100;
  let lastRaiseAmount = null;
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
      gameFinished = false;
      return json({ ok: true, roomId: "321", started: true });
    }
    if (pathname === "/api/seka/rooms/action") {
      const payload = request.postDataJSON();
      if (payload.action === "raise") {
        lastRaiseAmount = Number(payload.amount);
        currentBet += lastRaiseAmount;
        return json({ ok: true, status: "playing", message: "Ставка принята" });
      }
      gameFinished = true;
      return json({ ok: true, status: "finished", message: "Тестовая партия завершена" });
    }
    if (pathname === "/api/seka/rooms/rematch") {
      rematchStarted = true;
      gameFinished = false;
      gameStarted = true;
      return json({ ok: true, started: true, roomId: "321", roundNumber: 2,
        message: "Рематч начался! Карты розданы заново." });
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
        status: gameFinished ? "finished" : gameStarted ? "playing" : "waiting", isOwner: true
      };
      const game = gameStarted ? {
        status: gameFinished ? "finished" : "playing", testMode: true, pot: 200, ante: 100, currentBet,
        currentPlayerTelegramId: "12345", isYourTurn: true,
        winnerTelegramIds: [], payouts: [], message: gameFinished ? "Тестовая партия завершена" : "Тестовая партия началась",
        settlementApplied: gameFinished, revealHands: gameFinished, rematchVotes: [], roundNumber: rematchStarted ? 2 : 1,
        players: [
          { telegramId: "12345", label: "Тестовый игрок", isBot: false, folded: false,
            contribution: currentBet, hand: [
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
  assert.equal(await page.locator("#myHandScore").textContent(), "24 очка",
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
  assert.match(await page.locator('label[for="raiseAmount"]').textContent(), /Новая ставка/,
    "the betting field should ask for the final bet amount, not an increment");
  await page.locator("#raiseAmount").fill("");
  // Android's numeric keyboard can briefly drop focus while the player is
  // clearing the field. Even an empty, blurred field must remain empty on poll.
  await page.locator("#actionHint").click();
  await page.waitForTimeout(1900);
  assert.equal(await page.locator("#raiseAmount").inputValue(), "",
    "polling must not restore a deleted number while the field is empty");
  await page.locator("#raiseAmount").fill("1000");
  // The room is polled every 1.8 seconds; a refresh must not overwrite a custom bet.
  await page.waitForTimeout(1900);
  assert.equal(await page.locator("#raiseAmount").inputValue(), "1000",
    "polling must preserve a custom bet while the player edits it");
  await page.locator("#actionHint").click();
  await page.waitForTimeout(1900);
  assert.equal(await page.locator("#raiseAmount").inputValue(), "1000",
    "polling must not overwrite the custom value after focus moves away");
  await page.locator("#raiseButton").click();
  await page.waitForFunction(() => document.querySelector("#roomStatus")?.textContent === "");
  assert.equal(lastRaiseAmount, 900,
    "entering a final bet of 1,000 AC from a current 100 AC bet must send only the 900 AC increase");

  await page.locator("#openButton").click();
  await page.waitForFunction(() => document.querySelector("#rematchButton")?.classList.contains("hidden") === false);
  assert.equal(await page.locator("#gameTurnLabel").textContent(), "Партия завершена",
    "the finished round should be shown before offering a rematch");
  assert.match(await page.locator("#rematchButton").textContent(), /Рематч/,
    "a rematch button should be visible after the round ends");
  await page.locator("#rematchButton").click();
  await page.waitForFunction(() => document.querySelector("#gameTurnLabel")?.textContent === "Ваш ход");
  assert.equal(rematchStarted, true, "the rematch button should call the rematch endpoint");
  assert.equal(gameFinished, false, "a successful rematch should start a new round");
  assert.deepEqual(pageErrors, [], "the Seka page should not produce JavaScript errors");

  console.log("PASS: Seka fullscreen shows scores and player seats, preserves custom editable bets during polling, converts a 1,000 AC target to the correct increase, and offers a working rematch.");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((err) => err ? rejectClose(err) : resolveClose()));
}
