import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCheckersGame, applyCheckersStep, getCheckersMoves } from "../server/checkers-game.js";

const players = [
  { telegramId: "100", name: "Создатель", isOwner: true },
  { telegramId: "200", name: "Соперник", isOwner: false }
];

function blankGame() {
  const game = createCheckersGame(players);
  game.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  game.turn = "w";
  game.turnTelegramId = "100";
  game.mustContinue = null;
  return game;
}

test("new online Checkers game assigns real players opposite colors and deals 12 pieces each", () => {
  const game = createCheckersGame(players);
  const count = color => game.board.flat().filter(piece => piece && piece.color === color).length;
  assert.equal(game.status, "playing");
  assert.equal(game.turn, "w");
  assert.equal(game.turnTelegramId, "100");
  assert.equal(count("w"), 12);
  assert.equal(count("b"), 12);
  assert.equal(game.players[0].color, "w");
  assert.equal(game.players[1].color, "b");
});

test("the server rejects a move from the player whose turn has not arrived", () => {
  const game = createCheckersGame(players);
  assert.throws(
    () => applyCheckersStep(game, "200", { r: 2, c: 1 }, { r: 3, c: 0 }),
    /Сейчас ход другого игрока/
  );
});

test("a legal online move updates the board and transfers the turn to the opponent", () => {
  const game = createCheckersGame(players);
  const next = applyCheckersStep(game, "100", { r: 5, c: 0 }, { r: 4, c: 1 });
  assert.equal(next.board[5][0], null);
  assert.deepEqual(next.board[4][1], { color: "w", king: false });
  assert.equal(next.turn, "b");
  assert.equal(next.turnTelegramId, "200");
  assert.equal(next.status, "playing");
});

test("the server refuses a diagonal step when a capture is available", () => {
  const game = blankGame();
  game.board[5][2] = { color: "w", king: false };
  game.board[5][6] = { color: "w", king: false };
  game.board[4][3] = { color: "b", king: false };
  const moves = getCheckersMoves(game);
  assert.ok(moves.length > 0);
  assert.ok(moves.every(move => move.captures.length > 0));
  assert.throws(
    () => applyCheckersStep(game, "100", { r: 5, c: 6 }, { r: 4, c: 5 }),
    /Этот ход запрещён/
  );
});

test("a multi-capture keeps the same player in turn and ends only after the second jump", () => {
  const game = blankGame();
  game.board[5][2] = { color: "w", king: false };
  game.board[4][3] = { color: "b", king: false };
  game.board[2][5] = { color: "b", king: false };

  const first = applyCheckersStep(game, "100", { r: 5, c: 2 }, { r: 3, c: 4 });
  assert.equal(first.turn, "w");
  assert.equal(first.turnTelegramId, "100");
  assert.deepEqual(first.mustContinue, { r: 3, c: 4 });
  assert.equal(first.board[4][3], null);
  assert.equal(first.board[2][5].color, "b");

  assert.throws(
    () => applyCheckersStep(first, "100", { r: 3, c: 4 }, { r: 4, c: 5 }),
    /Продолжи обязательное взятие/
  );

  const second = applyCheckersStep(first, "100", { r: 3, c: 4 }, { r: 1, c: 6 });
  assert.equal(second.board[2][5], null);
  assert.equal(second.status, "finished");
  assert.equal(second.winner, "w");
  assert.equal(second.turnTelegramId, null);
});

test("server route contract has room join/state/start, authoritative move state and member checks", async () => {
  const router = await readFile(new URL("../server/checkers-router.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../checkers.html", import.meta.url), "utf8");
  for (const route of [
    'router.post("/rooms/join"',
    'router.post("/rooms/state"',
    'router.post("/rooms/start"',
    'router.post("/game/state"',
    'router.post("/game/action"',
    'router.post("/rooms/leave"'
  ]) assert.ok(router.includes(route), `Missing server route: ${route}`);
  assert.match(router, /CREATE TABLE IF NOT EXISTS checkers_games/);
  assert.match(router, /requireMember\(client, roomId, user\.id\)/);
  assert.match(router, /applyCheckersStep\(currentState, String\(user\.id\)/);
  assert.match(page, /checkersApi\("\/game\/action"/);
  assert.match(page, /checkersApi\("\/game\/state"/);
  assert.match(page, /startOnlineGame\(currentRoom, game\)/);
  assert.doesNotMatch(page, /Соперник подключился, но сервер пока не передаёт ходы шашек/);
});
