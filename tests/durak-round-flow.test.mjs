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

test("a defender who cannot beat a card takes the whole table", () => {
  assert.match(body, /if \(action === "take"\)[\s\S]*?for \(const item of game\.table\)[\s\S]*?player\.hand\.push\(item\.attack\)/);
  assert.match(body, /if \(game\.defenderIndex === botIndex\)[\s\S]*?if \(defenseIndex >= 0\)[\s\S]*?else \{[\s\S]*?bot\.hand\.push\(item\.attack\)/);
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
  assert.match(body, /const canAddMore = game.table.length < defender.hand.length/);
  assert.match(body, /chooseBotAttackIndex\(bot\.hand, game\.trumpSuit, tableRanks\)/);
  assert.match(body, /Бот завершает атаку только когда больше не может подкинуть карту/);
});

test("the bot continues defending until no uncovered attack cards remain", () => {
  assert.match(body, /for \(let botStep = 0; botStep < 12 && game\.status === "playing"; botStep\+\+\)/);
  assert.match(body, /openItem\.defense = bot\.hand\.splice\(defenseIndex, 1\)\[0\];[\s\S]*?continue;\s*\} else \{/);
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
  const createEnd = source.indexOf("\\napp.post(", createStart + 1);
  assert.notEqual(createStart, -1, "Normal room creation route must exist");
  const createBody = source.slice(createStart, createEnd);
  assert.doesNotMatch(createBody, /VALUES\\s*\\(\\s*\\$1\\s*,\\s*0\\s*,/);

  const addBotStart = source.indexOf('app.post("/api/durak/rooms/add-bot",');
  const addBotEnd = source.indexOf("\\napp.post(", addBotStart + 1);
  assert.notEqual(addBotStart, -1, "Explicit test-bot route must exist");
  const addBotBody = source.slice(addBotStart, addBotEnd);
  assert.match(addBotBody, /room\\.status !== "waiting"/);
  assert.match(addBotBody, /String\\(room\\.owner_telegram_id\\) !== String\\(user\\.id\\)/);
  assert.match(addBotBody, /VALUES \\(\\$1, 0, TRUE, '🤖 Бот ALLCOINS'\\)/);
});

test("bot automation runs only for a bot already present in the game", () => {
  assert.match(body, /const botIndex = game\\.players\\.findIndex\\(p => String\\(p\\.telegramId\\) === "0"\\);\\s*if \\(botIndex >= 0\\) \{/);
});
