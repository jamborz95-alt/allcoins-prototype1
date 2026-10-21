import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server/server.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../index.html", import.meta.url), "utf8");

function routeBody(path) {
  const marker = `app.post("${path}", async (req, res) => {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Route not found: ${path}`);
  const nextRoute = source.indexOf("\napp.post(", start + marker.length);
  return source.slice(start, nextRoute === -1 ? source.length : nextRoute);
}

test("Durak room creation validates Telegram identity, players, and stake", () => {
  const body = routeBody("/api/durak/rooms");
  assert.match(body, /verifyTelegram\(req\.body\?\.initData\)/);
  assert.match(body, /maxPlayers/);
  assert.match(body, /max_players/);
  assert.match(body, /stake/);
  assert.match(body, /\[36, 52\]\.includes\(deck\)/);
  assert.match(body, /INSERT INTO durak_rooms/);
  assert.match(body, /INSERT INTO durak_room_players/);
});

test("only the room owner can add the test bot while the room is waiting", () => {
  const body = routeBody("/api/durak/rooms/add-bot");
  assert.match(body, /owner_telegram_id/);
  assert.match(body, /может только создатель комнаты/);
  assert.match(body, /room\.status !== "waiting"/);
  assert.match(body, /🤖 Бот ALLCOINS/);
  assert.match(body, /max_players/);
});

test("joining a room checks membership, room state, and capacity", () => {
  const body = routeBody("/api/durak/rooms/join");
  assert.match(body, /room\.status !== "waiting"/);
  assert.match(body, /Комната заполнена/);
  assert.match(body, /INSERT INTO durak_room_players/);
});

test("starting a game checks owner, minimum players, and guest readiness", () => {
  const body = routeBody("/api/durak/rooms/start");
  assert.match(body, /Начать игру может только создатель комнаты/);
  assert.match(body, /total < 2/);
  assert.match(body, /total > 5 && selectedDeck !== 52/);
  assert.match(body, /Для игры шестью игроками выбери колоду на 52 карты/);
  assert.match(body, /readyGuests < totalGuests/);
  assert.match(body, /createDurakDeck/);
  assert.match(body, /dealInitialHands\(deck, playersResult\.rows\.length, 6\)/);
  assert.match(body, /chooseStartingPlayerIndex\(\s*dealt\.hands,\s*dealt\.trumpSuit\s*\)/);
  assert.match(body, /attackerIndex: startingPlayerIndex/);
  assert.match(body, /String\(gamePlayers\[startingPlayerIndex\]\?\.telegramId\) === "0"/);
  assert.match(body, /gameState\.table\.push\(\{ attack: botCard, defense: null \}\)/);
  assert.match(body, /gameState\.phase = "defense"/);
  assert.match(body, /hand: dealt\.hands\[index\]/);
  assert.match(body, /deck: remainingDeck/);
  assert.match(body, /INSERT INTO durak_games/);
  assert.match(body, /SET status = 'playing'/);
});

test("game actions allow only known actions and verify room membership", () => {
  const body = routeBody("/api/durak/action");
  assert.match(body, /\["attack", "defend", "take", "beat"\]/);
  assert.match(body, /Ты не состоишь в этой комнате/);
  assert.match(body, /Сейчас ход атакующего игрока/);
  assert.match(body, /Защищаться может только отбивающийся игрок/);
  assert.match(body, /Этой картой нельзя побить атакующую карту/);
  assert.match(body, /Сохраняем состояние партии/);
  assert.match(body, /SELECT game_state[\s\S]*FOR UPDATE/);
  assert.match(body, /await client\.query\("BEGIN"\)/);
  assert.match(body, /await client\.query\("COMMIT"\)/);
  assert.match(body, /await client\.query\("ROLLBACK"\)/);
  assert.match(body, /client\.release\(\)/);
  assert.match(body, /UPDATE durak_games/);
  assert.match(body, /actionRequestId/);
  assert.match(body, /processedActionRequestIds\.includes\(actionRequestId\)/,
    "a previously processed request ID must be detected");
  assert.match(body, /processedActionRequestIds = \[[\s\S]*?\.slice\(-100\)/,
    "the server should retain a bounded history of processed request IDs");
});



test("the client can select same-rank cards and send them as one attack", () => {
  assert.match(clientSource, /data-group-selected/);
  assert.match(clientSource, /selectedSameRankCards/);
  assert.match(clientSource, /cardIds: actionCardIds/);
  assert.match(clientSource, /groupedCardIds/);
});

test("Durak game state exposes only the requesting player's hand, not opponents' cards", () => {
  const body = routeBody("/api/durak/game");
  assert.match(body, /const me = gameState\.players\.find\([\s\S]*?String\(player\.telegramId\) === String\(user\.id\)/);
  assert.match(body, /hand: me\.hand/);
  assert.match(body, /cardsCount: Array\.isArray\(p\.hand\) \? p\.hand\.length : 0/);
  assert.doesNotMatch(body, /hand: p\.hand/);
  assert.doesNotMatch(body, /telegramId: String\(p\.telegramId\)/);
  assert.doesNotMatch(body, /players: gameState\.players\s*[,}]/);
});


test("a pending Durak refresh never redraws the table over a card drag or throw", () => {
  assert.ok(clientSource.includes("let durakGameReloadRequested = false"));
  assert.ok(clientSource.includes("durakGameReloadRequested = true;"));
  assert.ok(clientSource.includes("durakGameReloadRoomId = actionRoomId;"));
  assert.ok(clientSource.includes("if (durakGameLoadInProgress) {"));
  assert.ok(clientSource.includes("function flushDurakGameReloadIfIdle()"));
  assert.ok(clientSource.includes("durakCardDragging || durakActionInProgress"));
  assert.ok(clientSource.includes("flushDurakGameReloadIfIdle();"));

  const loadStart = clientSource.indexOf("async function loadDurakGame(roomId)");
  const renderGuard = clientSource.indexOf(
    "if (durakCardDragging || durakActionInProgress) {", loadStart
  );
  const flyingCardCleanup = clientSource.indexOf(
    'document.querySelectorAll("#durakGame .durak-flying-card, body > .durak-flying-card")', loadStart
  );
  assert.ok(loadStart !== -1 && renderGuard !== -1 && flyingCardCleanup !== -1);
  assert.ok(renderGuard < flyingCardCleanup,
    "the interaction guard must run before an update removes flying cards and rebuilds the table");
});
