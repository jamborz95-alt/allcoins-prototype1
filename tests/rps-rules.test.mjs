import test from "node:test";
import assert from "node:assert/strict";
import { isRpsChoice, resolveRpsRound } from "../server/rps-rules.js";

test("камень побеждает ножницы", () => {
  const result = resolveRpsRound({ "10": "rock", "20": "scissors" });
  assert.equal(result.outcome, "win");
  assert.equal(result.winningChoice, "rock");
  assert.deepEqual(result.winnerIds, ["10"]);
  assert.deepEqual(result.loserIds, ["20"]);
});

test("бумага побеждает камень", () => {
  const result = resolveRpsRound({ "10": "paper", "20": "rock" });
  assert.equal(result.winningChoice, "paper");
  assert.deepEqual(result.winnerIds, ["10"]);
});

test("ножницы побеждают бумагу", () => {
  const result = resolveRpsRound({ "10": "scissors", "20": "paper" });
  assert.equal(result.winningChoice, "scissors");
  assert.deepEqual(result.winnerIds, ["10"]);
});

test("одинаковые жесты — ничья", () => {
  const result = resolveRpsRound({ "10": "paper", "20": "paper" });
  assert.equal(result.outcome, "draw");
  assert.deepEqual(result.winnerIds, []);
});

test("если три игрока выбрали все три жеста — ничья", () => {
  const result = resolveRpsRound({ "10": "rock", "20": "paper", "30": "scissors" });
  assert.equal(result.outcome, "draw");
  assert.deepEqual(result.winnerIds, []);
});

test("два одинаковых выигрышных жеста делят победу против третьего", () => {
  const result = resolveRpsRound({ "10": "rock", "20": "rock", "30": "scissors" });
  assert.equal(result.outcome, "win");
  assert.deepEqual(result.winnerIds, ["10", "20"]);
  assert.deepEqual(result.loserIds, ["30"]);
});

test("проверка допустимых жестов", () => {
  assert.equal(isRpsChoice("rock"), true);
  assert.equal(isRpsChoice("paper"), true);
  assert.equal(isRpsChoice("scissors"), true);
  assert.equal(isRpsChoice("lizard"), false);
});

test("нельзя рассчитать раунд для одного игрока", () => {
  assert.throws(() => resolveRpsRound({ "10": "rock" }), /at least two players/);
});

test("недопустимый выбор не принимается", () => {
  assert.throws(() => resolveRpsRound({ "10": "rock", "20": "lizard" }), /Invalid choice/);
});
