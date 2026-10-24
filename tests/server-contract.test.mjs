import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server/server.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const twentyOneRulesSource = await readFile(new URL("../server/twentyone-rules.js", import.meta.url), "utf8");
import { createTwentyOneDeck, createTwentyOneRound, applyTwentyOneAction, scoreTwentyOneHand } from "../server/twentyone-rules.js";

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
  assert.match(body, /\[24, 36, 52\]\.includes\(deck\)/);
  assert.match(body, /const maxPlayersForDeck = deck === 24 \? 3 : deck === 36 \? 5 : 6/);
  assert.match(body, /С колодой на 24 карты можно играть максимум втроём/);
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

test("leaving a waiting room removes the guest or closes the owner's room, and the UI has a clear exit", () => {
  const body = routeBody("/api/durak/rooms/leave");
  assert.match(body, /verifyTelegram\(req\.body\?\.initData\)/);
  assert.match(body, /room\.status !== "waiting"/);
  assert.match(body, /FOR UPDATE/);
  assert.match(body, /DELETE FROM durak_room_players/);
  assert.match(body, /DELETE FROM durak_rooms/);
  assert.match(body, /COMMIT/);
  assert.match(body, /ROLLBACK/);
  assert.match(routeBody("/api/durak/rooms/start"), /WHERE id = \$1\s+FOR UPDATE/);
  assert.match(clientSource, /apiRequest\("\/api\/durak\/rooms\/leave"/);
  assert.match(clientSource, /🚪 Выйти из комнаты/);
  assert.match(clientSource, /color: #fff9e8 !important/);
  assert.match(clientSource, /color: #8ff5d3 !important/);
});

test("starting a game checks owner, minimum players, and guest readiness", () => {
  const body = routeBody("/api/durak/rooms/start");
  assert.match(body, /Начать игру может только создатель комнаты/);
  assert.match(body, /total < 2/);
  assert.match(body, /\[24, 36, 52\]\.includes\(selectedDeck\)/);
  assert.match(body, /const maxPlayersForDeck = selectedDeck === 24 \? 3 : selectedDeck === 36 \? 5 : 6/);
  assert.match(body, /В колоде на 24 карты максимум 3 игрока/);
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
  assert.match(body, /\["attack", "defend", "transfer", "take", "beat"\]/);
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
  const gameFetch = clientSource.indexOf(
    'const game = await apiRequest("/api/durak/game"', loadStart
  );
  const renderGuard = clientSource.indexOf(
    "if (durakCardDragging || durakActionInProgress) {", gameFetch
  );
  const flyingCardCleanup = clientSource.indexOf(
    'document.querySelectorAll("#durakGame .durak-flying-card, body > .durak-flying-card")', loadStart
  );
  assert.ok(loadStart !== -1 && gameFetch !== -1 && renderGuard !== -1 && flyingCardCleanup !== -1);
  assert.ok(gameFetch < renderGuard && renderGuard < flyingCardCleanup,
    "a poll that finishes mid-throw must defer before removing the flyer or rebuilding the table");
});


test("21 Ochko has five-seat rooms, stake presets and public stake filters", () => {
  assert.match(clientSource, /id="twentyOneRoomPlayers"/);
  assert.match(clientSource, /<option value="5">5 игроков<\/option>/);
  assert.match(clientSource, /id="twentyOneStakeFilters"/);
  assert.match(clientSource, /data-stake-filter="100-999"/);
  assert.match(clientSource, /data-stake-filter="1000-9999"/);
  assert.match(clientSource, /data-stake-filter="10000-99999"/);
  assert.match(clientSource, /data-stake-filter="100000-499999"/);
  assert.match(clientSource, /data-stake-filter="500000-1000000"/);
  assert.match(clientSource, /data-stake-preset="1000000"/);
  assert.match(clientSource, /id="twentyOneSoloStakePresets"/);
  assert.match(clientSource, /max="1000000"/);
  assert.doesNotMatch(clientSource, /id="durakStakeFilters"/);
});

test("21 Ochko room creation authenticates users and limits room size and stakes", () => {
  const body = routeBody("/api/twentyone/rooms/create");
  assert.match(body, /verifyTelegram\(req\.body\?\.initData\)/);
  assert.match(body, /maxPlayers < 1 \|\| maxPlayers > 5/);
  assert.match(body, /stake < 100 \|\| stake > 1000000/);
  assert.match(body, /INSERT INTO twentyone_rooms/);
  assert.match(body, /INSERT INTO twentyone_room_players/);
});

test("21 Ochko lobby and room joining enforce membership, room state and capacity", () => {
  const listBody = routeBody("/api/twentyone/rooms/list");
  assert.match(listBody, /status = 'waiting'/);
  assert.match(listBody, /COUNT\(p\.telegram_id\) < r\.max_players/);
  const joinBody = routeBody("/api/twentyone/rooms/join");
  assert.match(joinBody, /room\.status !== "waiting"/);
  assert.match(joinBody, /Комната заполнена/);
  assert.match(joinBody, /max_players/);
  assert.match(joinBody, /INSERT INTO twentyone_room_players/);
});

test("21 Ochko starts shared server rounds, debits each stake once, and settles winners", () => {
  const body = routeBody("/api/twentyone/rooms/start");
  assert.match(body, /Начать раунд может только создатель комнаты/);
  assert.match(body, /WHERE id = \$1 FOR UPDATE/);
  assert.match(body, /balance >= \$1/);
  assert.match(body, /createTwentyOneRound/);
  assert.match(body, /INSERT INTO twentyone_games/);
  assert.match(body, /creditTwentyOneWinners/);
  assert.match(body, /await client\.query\("BEGIN"\)/);
  assert.match(body, /await client\.query\("COMMIT"\)/);
  assert.match(body, /await client\.query\("ROLLBACK"\)/);
});

test("21 Ochko actions verify the current turn and protect hidden dealer and opponent cards", () => {
  const actionBody = routeBody("/api/twentyone/rooms/action");
  assert.match(actionBody, /applyTwentyOneAction/);
  assert.match(actionBody, /Ты не состоишь в этой комнате/);
  assert.match(actionBody, /FOR UPDATE/);
  const stateBody = routeBody("/api/twentyone/rooms/state");
  assert.match(stateBody, /revealAll = raw\.status === "finished"/);
  assert.match(stateBody, /21-dealer-hidden-card/);
  assert.match(stateBody, /revealHand \? player\.hand : \[\]/);
  assert.match(stateBody, /cardsCount/);
});

test("21 Ochko rules deal 36 cards, score court cards, and enforce turn order", () => {
  const deck = createTwentyOneDeck(() => 0.5);
  assert.equal(deck.length, 36);
  assert.equal(new Set(deck.map(card => card.id)).size, 36);
  assert.equal(scoreTwentyOneHand([
    { rank: "A" }, { rank: "10" }
  ]), 21);
  assert.equal(scoreTwentyOneHand([
    { rank: "J" }, { rank: "Q" }, { rank: "K" }, { rank: "6" }
  ]), 15);
  assert.match(twentyOneRulesSource, /if \(player\.score === 21\)/);
  const game = createTwentyOneRound([
    { telegramId: "101", label: "Игрок 1" },
    { telegramId: "202", label: "Игрок 2" }
  ], 500, () => 0.37);
  if (game.status === "playing") {
    const firstTurn = game.currentPlayerTelegramId;
    const wrongTurn = firstTurn === "101" ? "202" : "101";
    assert.throws(() => applyTwentyOneAction(game, wrongTurn, "stand"), /Сейчас ход другого игрока/);
    while (game.status === "playing") {
      applyTwentyOneAction(game, game.currentPlayerTelegramId, "stand");
    }
  }
  assert.equal(game.status, "finished");
  assert.equal(game.players.length, 2);
  assert.ok(game.players.every(player => Number.isInteger(player.payout) && player.payout >= 0));
});


test("21 Ochko shows player count and all scores without exposing opponent hands", () => {
  assert.match(clientSource, /id="twentyOneRoomPlayerCount"/);
  assert.match(clientSource, /Игроков в раунде:/);
  assert.match(clientSource, /const roomPlayerCount = Array\.isArray\(game\?\.players\)/);
  assert.match(clientSource, /stateLabel\.textContent = scoreText \+ " · " \+ stateNote/);
  const body = routeBody("/api/twentyone/rooms/state");
  assert.match(body, /score: scoreTwentyOneHand\(player\.hand \|\| \[\]\)/);
  assert.match(body, /hand: revealHand \? player\.hand : \[\]/);
  assert.match(body, /cardsCount: Array\.isArray\(player\.hand\) \? player\.hand\.length : 0/);
});
