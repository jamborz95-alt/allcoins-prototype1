import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createSekaDeck,
  sekaCardPoints,
  scoreSekaHand,
  compareSekaHands,
  createSekaGame,
  allActiveSekaPlayersMatched
} from "../server/seka-rules.js";

test("Сека uses a 36-card deck with unique cards", () => {
  const deck = createSekaDeck(() => 0.5);
  assert.equal(deck.length, 36);
  assert.equal(new Set(deck.map(card => card.id)).size, 36);
  assert.equal(deck.some(card => card.rank === "2"), false);
});

test("card points match common Seka values", () => {
  assert.equal(sekaCardPoints({ rank: "A", suit: "♠" }), 11);
  assert.equal(sekaCardPoints({ rank: "K", suit: "♥" }), 10);
  assert.equal(sekaCardPoints({ rank: "10", suit: "♦" }), 10);
  assert.equal(sekaCardPoints({ rank: "8", suit: "♣" }), 8);
});

test("three sixes are the strongest set and three aces are next", () => {
  assert.deepEqual(scoreSekaHand([
    { rank: "6", suit: "♠" }, { rank: "6", suit: "♥" }, { rank: "6", suit: "♦" }
  ]), { score: 34, type: 3, label: "Три 6" });
  assert.equal(scoreSekaHand([
    { rank: "A", suit: "♠" }, { rank: "A", suit: "♥" }, { rank: "A", suit: "♦" }
  ]).score, 33);
});

test("the seven of clubs completes a pair into a set", () => {
  assert.deepEqual(scoreSekaHand([
    { rank: "9", suit: "♠" }, { rank: "9", suit: "♥" }, { rank: "7", suit: "♣" }
  ]), { score: 27, type: 3, label: "Тройка с джокером" });
});

test("a set beats a same-suit hand; equal sets tie", () => {
  const setOfKings = [
    { rank: "K", suit: "♠" }, { rank: "K", suit: "♥" }, { rank: "K", suit: "♦" }
  ];
  const suitedThirty = [
    { rank: "A", suit: "♥" }, { rank: "10", suit: "♥" }, { rank: "9", suit: "♥" }
  ];
  const setOfQueens = [
    { rank: "Q", suit: "♠" }, { rank: "Q", suit: "♥" }, { rank: "Q", suit: "♦" }
  ];
  assert.equal(compareSekaHands(setOfKings, suitedThirty), 1);
  assert.equal(compareSekaHands(setOfKings, setOfQueens), 0);
});

test("initial game deals three cards, puts antes in the pot and starts with first player", () => {
  const game = createSekaGame([
    { telegramId: "1", label: "A" }, { telegramId: "2", label: "B" }, { telegramId: "3", label: "C" }
  ], 100, () => 0.5);
  assert.equal(game.status, "playing");
  assert.equal(game.players.length, 3);
  assert.ok(game.players.every(player => player.hand.length === 3 && player.contribution === 100));
  assert.equal(game.pot, 300);
  assert.equal(game.currentPlayerTelegramId, "1");
});

test("all active players must act and match the current bet before automatic showdown", () => {
  const game = {
    currentBet: 200,
    players: [
      { folded: false, acted: true, contribution: 200 },
      { folded: false, acted: true, contribution: 200 },
      { folded: false, acted: false, contribution: 200 },
      { folded: true, acted: true, contribution: 100 }
    ]
  };
  assert.equal(allActiveSekaPlayersMatched(game), false);
  game.players[2].acted = true;
  assert.equal(allActiveSekaPlayersMatched(game), true);
});

test("the main Games tab links to a separate Seka page with all five stake ranges", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const page = await readFile(new URL("../seka.html", import.meta.url), "utf8");
  assert.match(html, /id="sekaEntry"/);
  assert.match(html, /id="openSeka"/);
  assert.match(page, /100–1 000 AC/);
  assert.match(page, /1 000–10 000 AC/);
  assert.match(page, /10 000–100 000 AC/);
  assert.match(page, /100 000–1 000 000 AC/);
  assert.match(page, /без верхнего лимита/);
  assert.match(page, /\/rooms\/create/);
  assert.match(page, /\/rooms\/action/);
});
