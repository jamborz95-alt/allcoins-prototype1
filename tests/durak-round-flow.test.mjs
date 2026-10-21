import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server/server.js", import.meta.url), "utf8");
const marker = 'app.post("/api/durak/action", async (req, res) => {';
const start = source.indexOf(marker);
assert.notEqual(start, -1, "Durak action route must exist");
const nextRoute = source.indexOf("\napp.post(", start + marker.length);
const body = source.slice(start, nextRoute === -1 ? source.length : nextRoute);

test("a round cannot be declared beaten until every attack is covered", () => {
  assert.match(body, /game\.table\.every\(item => item\.attack && item\.defense\)/);
  assert.match(body, /Сначала нужно побить все карты на столе/);
});

test("round completion clears the table and draws cards for players", () => {
  assert.match(body, /game\.table = \[\]/);
  assert.match(body, /function drawCardsAfterRound\(\)/);
  assert.match(body, /target\.hand\.length < 6 &&\s*game\.deck\.length > 0/);
});

test("a defender who cannot beat a card marks a pending take without collecting immediately", () => {
  assert.match(body, /if \(action === "take"\)[\s\S]*?game\.takePending = true;[\s\S]*?game\.phase = "takePending";/);
  assert.match(body, /function finishTakingRound\(\)[\s\S]*?taker\.hand\.push\(item\.attack\)[\s\S]*?taker\.hand\.push\(item\.defense\)[\s\S]*?game\.table = \[\][\s\S]*?drawCardsAfterRound\(\)/);
  assert.match(body, /if \(game\.takePending === true\) \{[\s\S]*?finishTakingRound\(\)/);
  assert.match(body, /if \(game\.defenderIndex === botIndex\)[\s\S]*?game\.takePending = true;[\s\S]*?game\.phase = "takePending";/);
});

test("the test bot has separate attack and defense behavior", () => {
  assert.match(body, /if \(game\.attackerIndex === botIndex\)/);
  assert.match(body, /if \(game\.defenderIndex === botIndex\)/);
  assert.match(body, /const defenseIndex = chooseBotDefenseIndex\(bot\.hand, openItem\.attack, game\.trumpSuit\)/);
});

test("finished games are persisted under the same locked transaction", () => {
  assert.match(body, /SELECT game_state[\s\S]*FOR UPDATE/);
  assert.match(body, /UPDATE durak_games[\s\S]*JSON\.stringify\(game\)/);
  assert.match(body, /await client\.query\("COMMIT"\)/);
});


test("the bot may throw in a matching rank while the defender still has capacity", () => {
  assert.match(body, /const canAddMore = game.table.length < game.defenderHandAtRoundStart/);
  assert.match(body, /chooseBotAttackIndex\(bot\.hand, game\.trumpSuit, tableRanks\)/);
  assert.match(body, /Бот завершает атаку только когда больше не может подкинуть карту/);
});

test("attack action supports a batch of same-rank cards and respects the round limit", () => {
  assert.ok(body.includes("const requestedCardIds = Array.isArray(req.body?.cardIds)"));
  assert.ok(body.includes("selectedCards.some(card => card.rank !== selectedRank)"));
  assert.ok(body.includes("game.table.length + requestedCardIds.length > attackLimit"));
  assert.ok(body.includes("for (const card of cardsToPlay) {") && body.includes("game.table.push({ attack: card, defense: null })"));
  assert.ok(body.includes("game.defenderHandAtRoundStart"));
});

test("the bot continues defending until no uncovered attack cards remain", () => {
  assert.match(body, /for \(let botStep = 0; botStep < 12 && game\.status === "playing"; botStep\+\+\)/);
  assert.match(body, /openItem\.defense = bot\.hand\.splice\(defenseIndex, 1\)\[0\];[\s\S]*?continue;\s*\} else \{/);
});

test("drag-and-drop sends a deliberate throw from any direction to the correct table slot", async () => {
  const { readFile } = await import("node:fs/promises");
  const frontend = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(frontend, /const throwDistance = Math\.hypot\(pointX - startX, pointY - startY\)/);
  assert.match(frontend, /const intentionalThrow = throwDistance >= 24/);
  assert.match(frontend, /const canAttack = isAttacker &&[\s\S]*?intentionalThrow/);
  assert.match(frontend, /const canDefend = isDefender && game\.phase === "defense" &&[\s\S]*?intentionalThrow/);
  assert.match(frontend, /return !pair\?\.querySelector\('\.durak-card\[data-table-card-type="defense"\]'\)/);
  assert.doesNotMatch(frontend, /const canAttack = isAttacker && \(game\.phase === "attack" \|\| game\.phase === "defense"\) && droppedOnTable/);
});

test("the bot attacker can throw in a matching rank while the defender still has an open attack", () => {
  const botAttackStart = body.indexOf('if (game.attackerIndex === botIndex) {');
  const botAttackEnd = body.indexOf('if (game.defenderIndex === botIndex)', botAttackStart);
  const botAttackBody = body.slice(botAttackStart, botAttackEnd);
  assert.ok(botAttackStart >= 0, "bot attack branch must exist");
  assert.doesNotMatch(botAttackBody, /if \(game\.table\.some\(item => !item\.defense\)\) break;/);
  assert.match(botAttackBody, /else if \(canAddMore && bot\.hand\.length > 0\)[\s\S]*?chooseBotAttackIndex\(bot\.hand, game\.trumpSuit, tableRanks\)/);
});

test("the bot closes a fully covered attack when it cannot throw in another card", () => {
  assert.match(body, /if \(game\.table\.length > 0 && game\.table\.every\(item => item\.defense\)[\s\S]*?game\.table = \[\][\s\S]*?drawCardsAfterRound\(\)/);
});


test("the production server uses shared tested bot card-selection rules", () => {
  assert.match(source, /chooseBotAttackIndex, chooseBotDefenseIndex/);
  assert.match(body, /chooseBotAttackIndex\(bot\.hand, game\.trumpSuit\)/);
  assert.match(body, /chooseBotAttackIndex\(bot\.hand, game\.trumpSuit, tableRanks\)/);
  assert.match(body, /chooseBotDefenseIndex\(bot\.hand, openItem\.attack, game\.trumpSuit\)/);
});


test("the defender keeps the defense phase while any attack card remains uncovered", () => {
  assert.match(body, /if \(hasUnbeatenCards\)\s*\{\s*game\.phase = "defense";/);
  assert.doesNotMatch(body, /game\.phase = "defend";/);
});


test("bot defense keeps the canonical defense phase while attacks remain uncovered", () => {
  assert.match(body, /game\.phase = game\.table\.some\(item => item\.attack && !item\.defense\)\s*\? "defense"\s*:\s*"attack"/);
  assert.doesNotMatch(body, /\? "defend"/);
});

test("finished Durak games record the last player holding cards as the loser", () => {
  assert.match(body, /function markGameFinished\(\)[\s\S]*?game\.status = "finished"[\s\S]*?playersWithCards = game\.players\.filter\([\s\S]*?game\.loserTelegramId = playersWithCards\.length === 1/);
  assert.match(source, /hasLoser: Boolean\(gameState\.loserTelegramId\)/);
  assert.match(source, /isLoser: String\(gameState\.loserTelegramId \?\? ""\) === String\(user\.id\)/);
});


test("the test bot is opt-in and is never inserted by normal room creation", () => {
  const createStart = source.indexOf('app.post("/api/durak/rooms",');
  const createEnd = source.indexOf("\napp.post(", createStart + 1);
  assert.notEqual(createStart, -1, "Normal room creation route must exist");
  const createBody = source.slice(createStart, createEnd);
  assert.doesNotMatch(createBody, /VALUES\s*\(\s*\$1\s*,\s*0\s*,/);

  const addBotStart = source.indexOf('app.post("/api/durak/rooms/add-bot",');
  const addBotEnd = source.indexOf("\napp.post(", addBotStart + 1);
  assert.notEqual(addBotStart, -1, "Explicit test-bot route must exist");
  const addBotBody = source.slice(addBotStart, addBotEnd);
  assert.match(addBotBody, /room\.status !== "waiting"/);
  assert.match(addBotBody, /String\(room\.owner_telegram_id\) !== String\(user\.id\)/);
  assert.match(addBotBody, /VALUES \(\$1, 0, TRUE, '🤖 Бот ALLCOINS'\)/);
});

test("bot automation runs only for a bot already present in the game", () => {
  assert.match(body, /const botIndex = game\.players\.findIndex\(p => String\(p\.telegramId\) === "0"\);\s*if \(botIndex >= 0\) \{/);
});
