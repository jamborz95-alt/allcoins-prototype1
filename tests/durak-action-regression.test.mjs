import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDurakDeck, beatsCard, cardRank, dealInitialHands, shuffleDurakDeck, chooseBotAttackIndex, chooseBotDefenseIndex, chooseStartingPlayerIndex } from "../server/durak-rules.js";

test("a trump beats a non-trump attack", () => {
  assert.equal(beatsCard({ rank: "6", suit: "♥" }, { rank: "Туз", suit: "♠" }, "♥"), true);
});

test("a lower card of the same suit cannot defend", () => {
  assert.equal(beatsCard({ rank: "7", suit: "♠" }, { rank: "9", suit: "♠" }, "♥"), false);
});

test("a non-trump card cannot beat another suit", () => {
  assert.equal(beatsCard({ rank: "Туз", suit: "♦" }, { rank: "6", suit: "♣" }, "♥"), false);
});

test("the engine recognizes face-card ranks used by the deck", () => {
  assert.ok(cardRank({ rank: "Т" }) > cardRank({ rank: "К" }));
  assert.equal(createDurakDeck(36).length, 36);
});


test("initial deal conserves every card and leaves the trump at the bottom of the deck", () => {
  const deck = createDurakDeck(36);
  const dealt = dealInitialHands(deck, 2, 6);
  assert.equal(dealt.hands.length, 2);
  assert.deepEqual(dealt.hands.map(hand => hand.length), [6, 6]);
  assert.equal(dealt.deck.length, 24);
  assert.equal(dealt.deck.at(-1).id, dealt.trumpCard.id);
  assert.equal(dealt.trumpSuit, dealt.trumpCard.suit);
  const allCards = [...dealt.hands.flat(), ...dealt.deck];
  assert.equal(allCards.length, 36);
  assert.equal(new Set(allCards.map(card => card.id)).size, 36);
});

test("six players can start with a 52-card deck and retain the trump card", () => {
  const deck = createDurakDeck(52);
  const dealt = dealInitialHands(deck, 6, 6);
  assert.deepEqual(dealt.hands.map(hand => hand.length), [6, 6, 6, 6, 6, 6]);
  assert.equal(dealt.deck.length, 16);
  assert.equal(dealt.deck.at(-1).id, dealt.trumpCard.id);
  assert.equal(new Set([...dealt.hands.flat(), ...dealt.deck].map(card => card.id)).size, 52);
});

test("six players cannot be dealt six cards each from a 36-card deck", () => {
  assert.throws(
    () => dealInitialHands(createDurakDeck(36), 6, 6),
    /недостаточно карт/
  );
});

test("24-card deck is supported and unsupported deck sizes are rejected before a game can start", () => {
  assert.equal(createDurakDeck(24).length, 24);
  for (const size of [40, 0, -1]) {
    assert.throws(() => createDurakDeck(size), /24, 36 или 52 карты/);
  }
});

test("shuffle returns a new array without losing or duplicating cards", () => {
  const deck = createDurakDeck(36);
  const shuffled = shuffleDurakDeck(deck, (max) => max - 1);
  assert.notEqual(shuffled, deck);
  assert.equal(shuffled.length, deck.length);
  assert.deepEqual(new Set(shuffled.map(card => card.id)), new Set(deck.map(card => card.id)));
});


test("bot opens with the lowest available non-trump card", () => {
  const hand = [
    { id: "trump-6", rank: "6", suit: "♥" },
    { id: "spade-9", rank: "9", suit: "♠" },
    { id: "club-7", rank: "7", suit: "♣" }
  ];
  assert.equal(chooseBotAttackIndex(hand, "♥"), 2);
});

test("bot throw-in only selects a matching rank and prefers a non-trump", () => {
  const hand = [
    { id: "trump-9", rank: "9", suit: "♥" },
    { id: "spade-9", rank: "9", suit: "♠" },
    { id: "club-9", rank: "9", suit: "♣" }
  ];
  assert.equal(chooseBotAttackIndex(hand, "♥", ["9"]), 1);
  assert.equal(chooseBotAttackIndex(hand, "♥", ["10"]), -1);
});

test("bot defense prefers a same-suit card over spending a trump", () => {
  const hand = [
    { id: "trump-6", rank: "6", suit: "♥" },
    { id: "spade-10", rank: "10", suit: "♠" },
    { id: "spade-8", rank: "8", suit: "♠" }
  ];
  const attack = { id: "spade-7", rank: "7", suit: "♠" };
  assert.equal(chooseBotDefenseIndex(hand, attack, "♥"), 2);
});

test("bot defense uses the lowest trump that can beat a non-trump attack", () => {
  const hand = [
    { id: "trump-9", rank: "9", suit: "♥" },
    { id: "trump-7", rank: "7", suit: "♥" },
    { id: "club-ace", rank: "Туз", suit: "♣" }
  ];
  const attack = { id: "spade-ace", rank: "Туз", suit: "♠" };
  assert.equal(chooseBotDefenseIndex(hand, attack, "♥"), 1);
});



test("Durak card landing keeps card proportions and handles unavailable card PNGs", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /const cardHeight = Math\.round\(cardWidth \* 1\.5\)/,
    "cards in hand and on the table should share the same 2:3 ratio");
  assert.match(html, /const targetScaleX = targetScale;\s*const targetScaleY = targetScale;/,
    "throw animation should scale uniformly instead of squeezing cards");
  assert.match(html, /image\.onerror = \(\) => \{[\s\S]*?appendDurakFallbackCardFace\(cardElement, rank, suit\);/,
    "a missing or delayed PNG should fall back to a visible classic card face");
  assert.match(html, /lockDurakTableCardSize\(image, "transform", "none"\)/,
    "card artwork should not keep a copied hand transform after landing on the table");
});

test("the player with the lowest trump starts the game", () => {
  const hands = [
    [{ id: "king-trump", rank: "К", suit: "♥" }],
    [{ id: "six-trump", rank: "6", suit: "♥" }],
    [{ id: "seven-trump", rank: "7", suit: "♥" }]
  ];
  assert.equal(chooseStartingPlayerIndex(hands, "♥"), 1);
});

test("if nobody has a trump in hand, the first joined player starts", () => {
  const hands = [
    [{ id: "spade-6", rank: "6", suit: "♠" }],
    [{ id: "club-7", rank: "7", suit: "♣" }]
  ];
  assert.equal(chooseStartingPlayerIndex(hands, "♥"), 0);
});
