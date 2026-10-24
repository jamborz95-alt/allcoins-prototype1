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
  let mockDurakStatus = "playing";
  let mockDurakTakePending = false;
  let mockDurakHasLoser = false;
  let mockDurakIsLoser = false;
  let failNextDurakAction = false;
  let rejectNextDurakAction = false;
  const durakActionRequestIds = [];
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
        cardsLeft: mockDurakStatus === "finished" ? 0 : 24, status: mockDurakStatus,
        takePending: mockDurakTakePending,
        turnStartedAt: new Date().toISOString(),
        finishedReason: null,
        hasLoser: mockDurakHasLoser, isLoser: mockDurakIsLoser, phase: mockDurakPhase,
        attackerIndex: 0, defenderIndex: 1, playerIndex: mockDurakPlayerIndex,
        players: [
          { telegramId: "12345", label: "👤 Тестовый Игрок", cardsCount: 6 },
          { telegramId: "0", label: "🤖 Бот ALLCOINS", cardsCount: 6 }
        ]
      }) });
    }
    if (url.pathname === "/api/durak/action") {
      durakActionRequestIds.push(body.actionRequestId);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (failNextDurakAction) {
        failNextDurakAction = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "Временная ошибка сети" })
        });
      }
      if (rejectNextDurakAction) {
        rejectNextDurakAction = false;
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "Недопустимый ход" })
        });
      }
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

  // 21 Ochko: separate page, textured felt table, deck counter and animated initial deal.
  await page.locator('.nav button[data-page="games"]').click();
  assert.equal(await page.locator("#openTwentyOne").count(), 1, "21 Ochko launcher should exist in Games");
  await page.locator("#openTwentyOne").click();
  assert.equal(await page.locator("#twentyOneGame").evaluate((el) => el.classList.contains("twentyone-fullscreen")),
    true, "21 Ochko should open as a separate full-screen page");
  await page.locator("#twentyOneShowCreate").click();
  await page.locator('#twentyOneRoomStakePresets [data-stake-preset="1000000"]').click();
  assert.equal(await page.locator("#twentyOneRoomStake").inputValue(), "1000000",
    "the 1 million AC room preset should update 21 Ochko stake");
  await page.locator("#twentyOneShowRooms").click();
  assert.equal(await page.locator("#twentyOneStakeFilters [data-stake-filter]").count(), 6,
    "21 Ochko lobby should show all stake ranges");
  await page.locator('#twentyOneStakeFilters [data-stake-filter="500000-1000000"]').click();
  assert.equal(await page.locator('#twentyOneStakeFilters [data-stake-filter="500000-1000000"]').getAttribute("aria-pressed"),
    "true", "21 Ochko stake range filter should become active");
  await page.locator('#twentyOneStakeFilters [data-stake-filter="all"]').click();
  await page.locator("#twentyOneSoloPlay").click();
  assert.equal(await page.locator("#twentyOneGame").evaluate((el) => el.classList.contains("twentyone-fullscreen")),
    true, "21 Ochko should open as a separate full-screen page");
  assert.equal(await page.locator("#twentyOneDeck").count(), 1, "21 Ochko should show a deck pile on the table");
  await page.locator("#twentyOneDeal").click();
  await page.waitForFunction(() => {
    const playerCards = document.querySelectorAll("#twentyOnePlayerCards .twentyone-card");
    const dealerCards = document.querySelectorAll("#twentyOneDealerCards .twentyone-card");
    const status = document.querySelector("#twentyOneStatus")?.textContent.trim() || "";
    const cardFlight = document.querySelector("body > .twentyone-card-flight");
    return playerCards.length === 2 && dealerCards.length === 2 &&
      document.querySelector("#twentyOneDeckCount")?.textContent.trim() === "32" &&
      !cardFlight && status !== "Идёт раздача карт…" &&
      [...playerCards, ...dealerCards].every(card => getComputedStyle(card).visibility !== "hidden");
  }, { timeout: 10000 });
  assert.equal(await page.locator("#twentyOnePlayerCards .twentyone-card").count(), 2,
    "player should be dealt two visible cards");
  assert.equal(await page.locator("#twentyOneDealerCards .twentyone-card").count(), 2,
    "dealer should be dealt two cards, including a face-down card");
  assert.equal(await page.locator("#twentyOneDealerCards .twentyone-card-face-down").count(), 1,
    "dealer's second card should stay face down during player's turn");
  assert.match((await page.locator("#twentyOnePlayerScore").innerText()).trim(), /^СЧЁТ: \d+ \/ 21$/,
    "player's current score should be shown immediately in a clear 21-point label");
  const scoreStyle = await page.locator("#twentyOnePlayerScore").evaluate(el => {
    const style = getComputedStyle(el);
    return { color: style.color, fontSize: parseFloat(style.fontSize), fontWeight: Number(style.fontWeight), visibility: style.visibility };
  });
  assert.ok(scoreStyle.fontSize >= 14 && scoreStyle.fontWeight >= 700 && scoreStyle.visibility !== "hidden",
    "player score must be large, bold and visible: " + JSON.stringify(scoreStyle));
  assert.equal(await page.locator("#twentyOneDealerCards .twentyone-card-face-down strong").count(), 0,
    "banker's card back must not show the number 21");
  assert.equal(await page.locator("#twentyOneDealerCards .twentyone-card-face-down .twentyone-back-mark").count(), 1,
    "banker's face-down card should use the decorative ALLCOINS back");

  const twentyOneCardMetrics = await page.locator("#twentyOnePlayerCards .twentyone-card").first().evaluate((el) => {
    const chain = [];
    let node = el;
    while (node && chain.length < 8) {
      const style = getComputedStyle(node);
      chain.push({
        tag: node.tagName, id: node.id, classes: String(node.className || ""),
        display: style.display, visibility: style.visibility, height: style.height,
        offsetHeight: node.offsetHeight, rectHeight: node.getBoundingClientRect().height,
        zoom: style.zoom, contentVisibility: style.contentVisibility,
        connected: node.isConnected
      });
      node = node.parentElement;
    }
    return { chain, inlineStyle: el.getAttribute("style"), transform: getComputedStyle(el).transform,
      translate: getComputedStyle(el).translate, rotate: getComputedStyle(el).rotate, scale: getComputedStyle(el).scale };
  });
  assert.ok(twentyOneCardMetrics.chain[0].rectHeight >= 70,
    "player hand cards should have a visible card-sized layout: " + JSON.stringify(twentyOneCardMetrics));
  await page.locator("#twentyOneBack").click();

  // Durak markup and test-bot control must exist.
  await page.locator('.nav button[data-page="games"]').click();
  assert.equal(await page.locator("#durakGame").count(), 1, "Durak game section should exist");
  assert.equal(await page.locator("#durakTable").count(), 1, "Durak table should exist");
  assert.equal(await page.locator("#durakAddBotButton").count(), 1, "test bot button should exist");

  // Open the actual Durak screen and show the board as if a room had been entered.
  await page.locator("#openDurak").click();
  await page.locator("#durakBoard").evaluate((el) => { el.style.display = "block"; });

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

  // Match the active-room state established by the real room-entry flow.
  await page.evaluate(() => { currentDurakRoomId = "77"; });

  // Wait until the deal-in animation has finished. Otherwise Playwright can
  // pick coordinates from the card's animated position near the deck, not its
  // final position in the player's hand, making the simulated throw invalid.
  const attackCard = page.locator('#durakHand .durak-card[data-card-id="card-6-hearts"]');
  await page.waitForFunction(() => {
    const card = document.querySelector('#durakHand .durak-card[data-card-id="card-6-hearts"]');
    if (!card) return false;
    const style = getComputedStyle(card);
    const rect = card.getBoundingClientRect();
    return Number(style.opacity) > 0.98 && rect.width > 0 && rect.height > 0 &&
      !card.style.transform.includes("translate3d");
  }, { timeout: 5000 });
  await page.waitForTimeout(250);
  // Drag a card onto the play area to attack; no action button is used.
  const actionsBeforeUiMove = apiCalls.filter((call) => call.path === "/api/durak/action").length;
  const tableTarget = page.locator("#durakTable");
  const attackBox = await attackCard.boundingBox();
  const tableBox = await tableTarget.boundingBox();
  assert.ok(attackBox && tableBox, "hand card and play area should be visible");
  const attackResponse = page.waitForResponse((response) => response.url().includes("/api/durak/action"), { timeout: 8000 });
  const handX = attackBox.x + attackBox.width / 2;
  const handY = attackBox.y + attackBox.height / 2;
  const tableX = tableBox.x + tableBox.width / 2;
  const tableY = tableBox.y + tableBox.height / 2;
  await page.mouse.move(handX, handY, { steps: 3 });
  await page.mouse.down();
  // Give the custom pointer-drag handler time to cross its movement threshold
  // and paint the floating card before releasing it over the table.
  await page.mouse.move(tableX, tableY, { steps: 12 });
  await page.mouse.move(tableX, tableY, { steps: 2 });
  await page.waitForFunction(() => document.querySelector(".durak-flying-card") !== null);
  await page.mouse.up();
  await attackResponse;
  await page.waitForFunction(() => !durakActionInProgress && pendingDurakAction === null);
  const uiMoveCalls = apiCalls.filter((call) => call.path === "/api/durak/action");
  assert.equal(uiMoveCalls.length, actionsBeforeUiMove + 1, "dragging a card to the play area submits one move");
  assert.equal(uiMoveCalls.at(-1).body.action, "attack", "dragging onto the play area sends attack");
  assert.equal(uiMoveCalls.at(-1).body.cardId, "card-6-hearts", "dragged card ID is sent");

  // A defending player should see a defense-specific prompt.
  mockDurakPhase = "defense";
  mockDurakPlayerIndex = 1;
  await page.evaluate(async () => { await loadDurakGame("77"); });
  assert.equal((await page.locator("#durakTurnMessage").innerText()).trim(), "ТВОЯ ЗАЩИТА",
    "defender should see a clear defense prompt");
  assert.notEqual(await page.locator("#durakTake").evaluate((el) => el.style.display), "none",
    "defender should be able to take an open attack");

  // Once every attack is covered, «Беру» is hidden: classic Durak requires
  // the attacker to finish the round with «Бито».
  mockDurakTable = [{
    attack: { id: "table-6-clubs", rank: "6", suit: "♣" },
    defense: { id: "table-7-clubs", rank: "7", suit: "♣" }
  }];
  mockDurakPhase = "attack";
  await page.evaluate(async () => { await loadDurakGame("77"); });
  assert.equal(await page.locator("#durakTake").evaluate((el) => el.style.display), "none",
    "defender should not be able to take after all cards are beaten");
  assert.equal(await page.locator("#durakHand .durak-card").count(), 6,
    "defender should still see their cards when all current attacks are covered");

  mockDurakTable = [
    { attack: { id: "table-6-clubs", rank: "6", suit: "♣" }, defense: { id: "table-7-clubs", rank: "7", suit: "♣" } },
    { attack: { id: "table-8-diamonds", rank: "8", suit: "♦" }, defense: null }
  ];
  mockDurakPhase = "defense";
  await page.evaluate(async () => { await loadDurakGame("77"); });
  assert.equal((await page.locator("#durakTurnMessage").innerText()).trim(), "ТВОЯ ЗАЩИТА",
    "defender should keep the defense prompt while another attack remains uncovered");
  assert.equal(await page.locator("#durakHand .durak-card").count(), 6,
    "defender should be able to select a card for the next defense");
  assert.notEqual(await page.locator("#durakTake").evaluate((el) => el.style.display), "none",
    "defender should retain the option to take the full table");

  // When the defender presses «Беру», the attacker is prompted to throw in or
  // confirm the take with «Бито»; this must not falsely mark cards as beaten.
  mockDurakTakePending = true;
  mockDurakPhase = "takePending";
  mockDurakPlayerIndex = 0;
  await page.evaluate(async () => { await loadDurakGame("77"); });
  // A refresh can be queued while a previous card flight is finishing.
  // Wait for that queued refresh instead of asserting against the stale prior frame.
  await page.waitForFunction(
    () => document.querySelector("#durakTurnMessage")?.innerText.trim() === "ПОДКИНЬ ИЛИ БИТО",
    null,
    { timeout: 5000 }
  );
  assert.equal((await page.locator("#durakTurnMessage").innerText()).trim(), "ПОДКИНЬ ИЛИ БИТО",
    "attacker should see the pending-take decision");
  assert.notEqual(await page.locator("#durakBeat").evaluate((el) => el.style.display), "none",
    "attacker should be able to transfer taken cards with the beat action");
  assert.equal(await page.locator("#durakControls #durakBeat").innerText(), "✅ Бито · отдать карты",
    "beat button should explain that it hands the table to the defender");
  mockDurakTakePending = false;

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

  // If the server response is lost, retrying the same move must reuse its request ID.
  failNextDurakAction = true;
  await page.evaluate(async () => {
    selectedDurakCardId = "card-6-hearts";
    await durakAction("attack");
  });
  assert.equal(await page.evaluate(() => Boolean(pendingDurakAction)), true,
    "uncertain action should remain pending after a network error");
  const requestIdAfterFailure = durakActionRequestIds.at(-1);
  await page.evaluate(async () => { await durakAction("attack"); });
  const requestIdAfterRetry = durakActionRequestIds.at(-1);
  assert.ok(requestIdAfterFailure, "action request should include an id");
  assert.equal(requestIdAfterRetry, requestIdAfterFailure,
    "retry after uncertain response must reuse the original action request ID");
  assert.equal(await page.evaluate(() => pendingDurakAction), null,
    "pending action should clear after server confirmation");

  // A definitive 4xx rejection must release the pending action so the player
  // can choose a different move instead of being locked to a rejected request.
  rejectNextDurakAction = true;
  await page.evaluate(async () => {
    selectedDurakCardId = "card-6-hearts";
    await durakAction("attack");
  });
  assert.equal(await page.evaluate(() => pendingDurakAction), null,
    "a definitively rejected action should not remain pending");
  const rejectedRequestId = durakActionRequestIds.at(-1);
  await page.evaluate(async () => { await durakAction("take"); });
  assert.notEqual(durakActionRequestIds.at(-1), rejectedRequestId,
    "a new move after a 4xx rejection should receive a fresh request ID");
  assert.equal(await page.evaluate(() => pendingDurakAction), null,
    "the replacement move should complete normally");

  // A successful action during an active poll must queue a fresh game-state load.
  await page.evaluate(async () => {
    currentDurakRoomId = "77";
    selectedDurakCardId = "card-6-hearts";
    durakGameLoadInProgress = true;
    await durakAction("attack");
  });
  assert.equal(await page.evaluate(() => durakGameReloadRequested), true,
    "confirmed action should queue a refresh when polling is already active");
  await page.evaluate(async () => {
    durakGameLoadInProgress = false;
    durakGameReloadRequested = false;
    durakGameReloadRoomId = null;
    await loadDurakGame("77");
  });

  mockDurakStatus = "finished";
  mockDurakHasLoser = true;
  mockDurakIsLoser = true;
  await page.evaluate(async () => { await loadDurakGame("77"); });
  assert.match(await page.locator("#durakGameStatus").innerText(), /Ты проиграл — ДУРАК/,
    "losing player should see the game result");
  assert.equal(await page.locator("#durakHand .durak-card").first().evaluate((el) => el.style.pointerEvents), "none",
    "cards should not be interactive after the game ends");
  mockDurakIsLoser = false;
  await page.evaluate(async () => { await loadDurakGame("77"); });
  assert.match(await page.locator("#durakGameStatus").innerText(), /Победа! Партия завершена/,
    "winning player should see the game result");

  assert.deepEqual(pageErrors, [], "page should not produce JavaScript errors");
  console.log("PASS: clicker, energy, navigation, 21 Ochko table/deal/visible cards, Durak player names, bot, cards, duplicate-action protection, no page errors");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((err) => err ? rejectClose(err) : resolveClose()));
}
