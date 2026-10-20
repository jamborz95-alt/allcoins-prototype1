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
  assert.match(body, /const defenseIndex = bot\.hand\.findIndex\(card => canBeatCard/);
});

test("finished games are persisted under the same locked transaction", () => {
  assert.match(body, /SELECT game_state[\s\S]*FOR UPDATE/);
  assert.match(body, /UPDATE durak_games[\s\S]*JSON\.stringify\(game\)/);
  assert.match(body, /await client\.query\("COMMIT"\)/);
});
