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

test("two aces always score 22 and do not add the third card's suit value", () => {
  assert.deepEqual(scoreSekaHand([
    { rank: "A", suit: "♥" }, { rank: "A", suit: "♦" }, { rank: "K", suit: "♥" }
  ]), { score: 22, type: 2, label: "Два туза" });
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

test("test bot receives three cards but does not add virtual AC to the real pot", () => {
  const game = createSekaGame([
    { telegramId: "123", label: "Игрок" },
    { telegramId: "0", label: "🤖 Бот проверки", isBot: true }
  ], 100, () => 0.5);
  assert.equal(game.players.length, 2);
  assert.equal(game.players[1].isBot, true);
  assert.equal(game.players[1].hand.length, 3);
  assert.equal(game.pot, 100);
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
  assert.match(page, /\/rooms\/add-bot/);
  assert.match(page, /id="addBotButton"/);
  assert.match(page, /Добавить бота для проверки/);
  const router = await readFile(new URL("../server/seka-router.js", import.meta.url), "utf8");
  assert.match(router, /async function runSekaBots/);
  assert.match(router, /\/rooms\/add-bot/);
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length > 0, "страница должна иметь рабочий игровой скрипт");
  for (const script of scripts) assert.doesNotThrow(() => new Function(script), "игровой JavaScript должен разбираться без синтаксических ошибок");
});
