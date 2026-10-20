import test from "node:test";
import assert from "node:assert/strict";
import { createDurakDeck, shuffleDurakDeck, cardRank, beatsCard, dealInitialHands } from "../server/durak-rules.js";

test("36-card deck has 36 unique cards and correct ranks", () => {
  const deck = createDurakDeck(36);
  assert.equal(deck.length, 36);
  assert.equal(new Set(deck.map(card => card.id)).size, 36);
  assert.deepEqual(new Set(deck.map(card => card.rank)), new Set(["6", "7", "8", "9", "10", "В", "Д", "К", "Т"]));
});

test("52-card deck has 52 unique cards", () => {
  const deck = createDurakDeck(52);
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(card => card.id)).size, 52);
  assert.ok(deck.some(card => card.rank === "2" && card.suit === "♠"));
  assert.ok(deck.some(card => card.rank === "Туз" && card.suit === "♣"));
});

test("deck factory rejects unsupported deck sizes instead of silently using 36 cards", () => {
  assert.throws(() => createDurakDeck(24), /36 или 52/);
  assert.throws(() => createDurakDeck(40), /36 или 52/);
});

test("52-card deck can deal six players and still leave the trump card", () => {
  const { hands, deck, trumpCard, trumpSuit } = dealInitialHands(createDurakDeck(52), 6, 6);
  assert.deepEqual(hands.map(hand => hand.length), [6, 6, 6, 6, 6, 6]);
  assert.equal(deck.length, 16);
  assert.ok(trumpCard);
  assert.equal(trumpSuit, trumpCard.suit);
  const allCards = [...hands.flat(), ...deck].map(card => card.id);
  assert.equal(new Set(allCards).size, 52);
});

test("36-card deck cannot deal six players while reserving a trump card", () => {
  assert.throws(() => dealInitialHands(createDurakDeck(36), 6, 6), /недостаточно карт/);
});

test("shuffle returns every card exactly once and does not mutate source", () => {
  const deck = createDurakDeck(36);
  const original = deck.map(card => card.id);
  const shuffled = shuffleDurakDeck(deck, () => 0);
  assert.equal(shuffled.length, 36);
  assert.deepEqual(new Set(shuffled.map(card => card.id)), new Set(original));
  assert.deepEqual(deck.map(card => card.id), original);
  assert.notDeepEqual(shuffled.map(card => card.id), original);
});

test("card ranking supports Russian and common English rank labels", () => {
  assert.ok(cardRank({ rank: "К" }) > cardRank({ rank: "Д" }));
  assert.equal(cardRank({ rank: "Туз" }), 14);
  assert.equal(cardRank({ rank: "A" }), 14);
  assert.equal(cardRank({ rank: "unknown" }), 0);
});

test("defense rules: higher same suit or trump beats, lower and non-trump off-suit do not", () => {
  const attack = { rank: "9", suit: "♣" };
  assert.equal(beatsCard({ rank: "10", suit: "♣" }, attack, "♥"), true);
  assert.equal(beatsCard({ rank: "8", suit: "♣" }, attack, "♥"), false);
  assert.equal(beatsCard({ rank: "6", suit: "♥" }, attack, "♥"), true);
  assert.equal(beatsCard({ rank: "Туз", suit: "♦" }, attack, "♥"), false);
  assert.equal(beatsCard(null, attack, "♥"), false);
});

test("initial deal gives six cards per player and leaves a trump card in the deck", () => {
  const deck = createDurakDeck(36);
  const { hands, deck: remaining, trumpCard, trumpSuit } = dealInitialHands(deck, 2, 6);
  assert.deepEqual(hands.map(hand => hand.length), [6, 6]);
  assert.equal(remaining.length, 24);
  assert.ok(trumpCard);
  assert.equal(trumpSuit, trumpCard.suit);
  const allDealtIds = [...hands.flat(), ...remaining].map(card => card.id);
  assert.equal(new Set(allDealtIds).size, 36);
});

test("deal refuses impossible player counts and decks that cannot leave a trump", () => {
  assert.throws(() => dealInitialHands(createDurakDeck(36), 1), /минимум 2/);
  assert.throws(() => dealInitialHands(createDurakDeck(36).slice(0, 12), 2), /недостаточно карт/);
});
