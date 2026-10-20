import test from "node:test";
import assert from "node:assert/strict";
import { createDurakDeck, beatsCard, cardRank, dealInitialHands, shuffleDurakDeck } from "../server/durak-rules.js";

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

test("unsupported deck sizes are rejected before a game can start", () => {
  for (const size of [24, 40, 0, -1]) {
    assert.throws(() => createDurakDeck(size), /36 или 52 карты/);
  }
});

test("shuffle returns a new array without losing or duplicating cards", () => {
  const deck = createDurakDeck(36);
  const shuffled = shuffleDurakDeck(deck, (max) => max - 1);
  assert.notEqual(shuffled, deck);
  assert.equal(shuffled.length, deck.length);
  assert.deepEqual(new Set(shuffled.map(card => card.id)), new Set(deck.map(card => card.id)));
});
