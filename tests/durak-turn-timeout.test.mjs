import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DURAK_TURN_TIMEOUT_MS, expireDurakTurnIfNeeded } from "../server/durak-rules.js";

function gameWith({ phase = "attack", active = "attacker", startedAgo = 0, status = "playing" } = {}) {
  const now = 2_000_000_000_000;
  return {
    status,
    phase,
    turnStartedAt: new Date(now - startedAgo).toISOString(),
    attackerIndex: 0,
    defenderIndex: 1,
    players: [
      { telegramId: "attacker-id", hand: [{ id: "a" }] },
      { telegramId: "defender-id", hand: [{ id: "b" }] }
    ],
    deck: [],
    table: [{ attack: { id: "table-a" }, defense: null }],
    ...(active === "defender" ? { phase: "defense" } : {})
  };
}

test("a Durak turn does not expire before the two-minute limit", () => {
  const game = gameWith({ startedAgo: DURAK_TURN_TIMEOUT_MS - 1 });
  const before = game.turnStartedAt;
  const result = expireDurakTurnIfNeeded(game, 2_000_000_000_000);
  assert.equal(result.timedOut, false);
  assert.equal(game.status, "playing");
  assert.equal(game.turnStartedAt, before);
});

test("the attacker automatically loses after two minutes without acting", () => {
  const game = gameWith({ startedAgo: DURAK_TURN_TIMEOUT_MS });
  const result = expireDurakTurnIfNeeded(game, 2_000_000_000_000);
  assert.equal(result.timedOut, true);
  assert.equal(game.status, "finished");
  assert.equal(game.phase, "finished");
  assert.equal(game.finishedReason, "timeout");
  assert.equal(game.loserTelegramId, "attacker-id");
  assert.equal(result.loserTelegramId, "attacker-id");
});

test("during the defense phase the idle defender loses, not the attacker", () => {
  const game = gameWith({ phase: "defense", active: "defender", startedAgo: DURAK_TURN_TIMEOUT_MS + 100 });
  const result = expireDurakTurnIfNeeded(game, 2_000_000_000_000);
  assert.equal(result.timedOut, true);
  assert.equal(game.loserTelegramId, "defender-id");
  assert.equal(game.turnTimedOutPlayerId, "defender-id");
});

test("during pending take the attacker owns the next timed action", () => {
  const game = gameWith({ phase: "takePending", startedAgo: DURAK_TURN_TIMEOUT_MS + 1 });
  game.takePending = true;
  const result = expireDurakTurnIfNeeded(game, 2_000_000_000_000);
  assert.equal(result.timedOut, true);
  assert.equal(game.loserTelegramId, "attacker-id");
});

test("finished games do not get a second timeout result", () => {
  const game = gameWith({ startedAgo: DURAK_TURN_TIMEOUT_MS + 500, status: "finished" });
  game.loserTelegramId = "existing-loser";
  const result = expireDurakTurnIfNeeded(game, 2_000_000_000_000);
  assert.deepEqual(result, { changed: false, timedOut: false });
  assert.equal(game.loserTelegramId, "existing-loser");
});

test("a test bot is never auto-forfeited by the idle-turn timer", () => {
  const game = gameWith({ startedAgo: DURAK_TURN_TIMEOUT_MS + 10 });
  game.players[0].telegramId = "0";
  const result = expireDurakTurnIfNeeded(game, 2_000_000_000_000);
  assert.deepEqual(result, { changed: false, timedOut: false });
  assert.equal(game.status, "playing");
});

test("the Durak action timeout records housekeeping before returning its timeout response", async () => {
  const source = await readFile(new URL("../server/server.js", import.meta.url), "utf8");
  const timeoutStart = source.indexOf("const timeoutCheck = expireDurakTurnIfNeeded(game);");
  const timeoutEnd = source.indexOf("\n    const count = game.players.length;", timeoutStart);
  assert.ok(timeoutStart >= 0 && timeoutEnd > timeoutStart, "the action route timeout branch should exist");
  const timeoutBranch = source.slice(timeoutStart, timeoutEnd);

  assert.match(timeoutBranch, /await settleDurakGamePayout\(client, game, roomId\)/);
  assert.match(timeoutBranch, /DELETE FROM durak_room_players WHERE room_id = \$1 AND telegram_id = \$2/);
  assert.match(timeoutBranch, /game\.timeoutBalanceAwards = \[\]/);
  assert.match(timeoutBranch, /game\.timeoutBalanceForfeited = 0/);
  assert.match(timeoutBranch, /game\.timeoutBalanceTransferred = 0/);
  assert.match(timeoutBranch, /game\.timeoutBalanceSettled = true/);
  assert.ok(timeoutBranch.indexOf("game.timeoutBalanceSettled = true") <
    timeoutBranch.indexOf("UPDATE durak_games"), "timeout housekeeping must be saved with the finished game state");
  assert.ok(timeoutBranch.indexOf("UPDATE durak_games") < timeoutBranch.indexOf("COMMIT"),
    "timeout state and payout must commit in the same transaction");
});
