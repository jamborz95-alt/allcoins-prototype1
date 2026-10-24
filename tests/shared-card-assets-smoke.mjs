import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png"
};

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
    const safePath = resolve(root, "." + pathname);
    if (safePath !== root && !safePath.startsWith(root + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const data = await readFile(safePath);
    const extension = safePath.slice(safePath.lastIndexOf("."));
    res.writeHead(200, {
      "content-type": contentTypes[extension] || "application/octet-stream",
      "cache-control": "public, max-age=3600"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});
await new Promise((resolveListen) => server.listen(4175, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const pageErrors = [];
  const cardAssetRequests = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/cards/") && url.pathname.endsWith(".png")) {
      cardAssetRequests.push(url.pathname);
    }
  });
  let roomCreated = false;
  let botAdded = false;
  let gameStarted = false;
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: `
      window.__tgFullscreenRequests = 0;
      window.Telegram = { WebApp: {
        initData: "mock-init-data",
        initDataUnsafe: { user: { id: 12345, first_name: "Тестовый игрок" } },
        ready() {}, expand() {},
        requestFullscreen() { window.__tgFullscreenRequests++; this.isFullscreen = true; },
        exitFullscreen() { this.isFullscreen = false; },
        BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} }
      } };
    `
  }));
  await page.route("https://sad.adsgram.ai/**", route => route.fulfill({
    status: 200, contentType: "application/javascript", body: ""
  }));
  await page.route("https://allcoins-server.onrender.com/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(body)
    });

    if (path === "/api/auth") {
      return json({ ok: true, player: {
        telegram_id: "12345", first_name: "Тестовый игрок", balance: 10000, energy: 100
      } });
    }
    if (path === "/api/durak/rooms/list") return json({ ok: true, rooms: [] });
    if (path === "/api/seka/rooms/list") return json({ ok: true, rooms: [] });
    if (path === "/api/seka/rooms/create") {
      roomCreated = true;
      return json({ ok: true, room: { id: "321" } });
    }
    if (path === "/api/seka/rooms/add-bot") {
      botAdded = true;
      return json({ ok: true, roomId: "321", botAdded: true, label: "🤖 Бот ALLCOINS" });
    }
    if (path === "/api/seka/rooms/start") {
      gameStarted = true;
      return json({ ok: true, roomId: "321", started: true });
    }
    if (path === "/api/seka/rooms/state") {
      const suits = ["♠", "♥", "♦", "♣"];
      const ranks = ["10", "A", "J", "Q", "K"];
      const hand = ranks.flatMap(rank => suits.map((suit, index) => ({
        id: rank + "-" + suit + "-" + index, rank, suit
      })));
      const players = [{ telegramId: "12345", label: "Тестовый игрок", balance: 10000 }];
      if (botAdded) players.push({ telegramId: "0", label: "🤖 Бот ALLCOINS", balance: 100000 });
      const room = {
        id: "321", name: "Тестовая Сека", ownerTelegramId: "12345", tier: 1,
        limitLabel: "100–1 000 AC", minBet: 100, maxBet: 1000, ante: 100,
        maxPlayers: 6, playersCount: players.length,
        status: gameStarted ? "playing" : "waiting", isOwner: true
      };
      const game = gameStarted ? {
        status: "playing", testMode: true, pot: 200, ante: 100, currentBet: 100,
        currentPlayerTelegramId: "12345", isYourTurn: true, winnerTelegramIds: [],
        payouts: [], message: "Тестовая партия началась", settlementApplied: false,
        revealHands: false,
        players: [
          { telegramId: "12345", label: "Тестовый игрок", isBot: false, folded: false,
            contribution: 100, hand, score: null, payout: 0, cardCount: hand.length, handType: null },
          { telegramId: "0", label: "🤖 Бот ALLCOINS", isBot: true, folded: false,
            contribution: 100, hand: [], score: null, payout: 0, cardCount: 3, handType: null }
        ]
      } : null;
      return json({ ok: true, room, players, game, balance: 10000 });
    }
    return json({ ok: true, rooms: [] });
  });

  // Seka should navigate on a native tap, with no giant Durak PNG downloads competing for attention.
  await page.goto("http://127.0.0.1:4175/index.html", { waitUntil: "domcontentloaded" });
  await page.locator("#openSeka").waitFor({ state: "attached" });
  await page.locator('.nav button[data-page="games"]').click();
  await page.locator("#openSeka").waitFor({ state: "visible" });
  const sekaLink = await page.locator("#openSeka").evaluate(el => ({
    tag: el.tagName,
    href: el.getAttribute("href"),
    touchAction: getComputedStyle(el).touchAction
  }));
  assert.equal(sekaLink.tag, "A", "Seka launcher should be a native link so taps trigger navigation directly");
  assert.match(sekaLink.href, /^\.\/seka\.html\?v=/, "Seka link should keep the existing app base URL and open the separate page");
  assert.equal(sekaLink.touchAction, "manipulation", "Seka link should respond directly to touch");
  assert.equal(cardAssetRequests.length, 0, "opening ALLCOINS should not download all large Durak card PNGs in the background");

  await Promise.all([
    page.waitForURL(url => url.pathname.endsWith("/seka.html")),
    page.locator("#openSeka").click()
  ]);
  assert.match(await page.title(), /Сека Онлайн/, "tapping Seka should open its separate page");
  assert.equal(cardAssetRequests.length, 0, "opening Seka should not trigger Durak-only image preloads");
  await page.goto("http://127.0.0.1:4175/index.html", { waitUntil: "domcontentloaded" });
  await page.locator("#openTwentyOne").waitFor({ state: "attached" });
  await page.locator('.nav button[data-page="games"]').click();
  await page.locator("#openTwentyOne").waitFor({ state: "visible" });
  await page.locator("#openTwentyOne").click();

  const cardSet = ["10", "A", "J", "Q", "K"].flatMap(rank =>
    ["♠", "♥", "♦", "♣"].map((suit, index) => ({
      id: "asset-" + rank + "-" + suit + "-" + index, rank, suit
    }))
  );
  await page.evaluate(cards => {
    window.renderTwentyOneCardRow("twentyOnePlayerCards", cards);
  }, cardSet);
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll("#twentyOnePlayerCards img")];
    return images.length === 20 && images.every(img => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 15000 });

  const twentyOneResult = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#twentyOnePlayerCards .durak-card")];
    const images = cards.map(card => card.querySelector("img"));
    const styles = images.map(img => getComputedStyle(img));
    return {
      cardCount: cards.length,
      imageCount: images.filter(Boolean).length,
      allLoaded: images.every(img => img && img.complete && img.naturalWidth > 0),
      allImageCards: cards.every(card => card.classList.contains("image-card")),
      allUseSharedVersion: images.every(img => new URL(img.src).searchParams.get("v") === "20261024-shared-cards-v2"),
      objectFits: [...new Set(styles.map(style => style.objectFit))],
      transforms: [...new Set(styles.map(style => style.transform))]
    };
  });
  assert.equal(twentyOneResult.cardCount, 20, "21 Ochko should render all 20 cards with available shared PNG artwork");
  assert.equal(twentyOneResult.imageCount, 20, "each mapped 21 Ochko card should contain the shared PNG");
  assert.equal(twentyOneResult.allLoaded, true, "all 21 Ochko shared PNGs should load successfully");
  assert.equal(twentyOneResult.allImageCards, true, "the 21 Ochko cards should use the image-card rendering path");
  assert.equal(twentyOneResult.allUseSharedVersion, true, "21 Ochko should use the shared asset cache version");
  assert.ok(twentyOneResult.objectFits.includes("fill"), "21 Ochko PNGs should fill the card surface without inner shrinkage");

  // Seka: create a room, add the test bot, start the round and verify all four suits.
  await page.goto("http://127.0.0.1:4175/seka.html", { waitUntil: "domcontentloaded" });
  await page.locator("#createRoomButton").waitFor();
  await page.waitForFunction(() => document.querySelector("#balanceValue")?.textContent.includes("AC"));
  await page.locator("#createRoomButton").click();
  await page.waitForFunction(() =>
    document.querySelector("#addBotButton")?.classList.contains("hidden") === false
  );
  assert.equal(roomCreated, true, "Seka room should be created in the test flow");
  await page.locator("#addBotButton").click();
  await page.waitForFunction(() => document.querySelector("#startGameButton")?.disabled === false);
  assert.equal(botAdded, true, "Seka test bot should be added");
  await page.locator("#startGameButton").click();
  await page.waitForFunction(() => document.querySelector("#myHand .playing-card.image-card img") !== null);
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll("#myHand .playing-card img")];
    return images.length === 20 && images.every(img => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 15000 });

  const sekaResult = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#myHand .playing-card")];
    const images = cards.map(card => card.querySelector("img"));
    const paths = images.map(img => new URL(img.src).pathname.split("/").pop());
    return {
      cardCount: cards.length,
      imageCount: images.filter(Boolean).length,
      allLoaded: images.every(img => img && img.complete && img.naturalWidth > 0),
      allImageCards: cards.every(card => card.classList.contains("image-card")),
      allUseSharedVersion: images.every(img => new URL(img.src).searchParams.get("v") === "20261024-shared-cards-v2"),
      uniqueFiles: new Set(paths).size,
      paths
    };
  });
  assert.equal(sekaResult.cardCount, 20, "Seka should render the 20 cards with available shared PNG artwork");
  assert.equal(sekaResult.imageCount, 20, "every tested Seka card should use an image");
  assert.equal(sekaResult.allLoaded, true, "all Seka card images should load successfully");
  assert.equal(sekaResult.allImageCards, true, "Seka should use image cards rather than fallback-only cards");
  assert.equal(sekaResult.allUseSharedVersion, true, "Seka should use the shared asset cache version");
  assert.equal(sekaResult.uniqueFiles, 20, "all available card image files should be mapped across ranks and suits");

  assert.deepEqual(pageErrors, [], "the shared card integration should not produce JavaScript errors");
  console.log("PASS: 21 Ochko and Seka both load and display the 20 available PNG assets from /cards; card artwork fills the full card.");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close(err => err ? rejectClose(err) : resolveClose()));
}
