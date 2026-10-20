import test from "node:test";
import assert from "node:assert/strict";
import { createDurakDeck, beatsCard, cardRank } from "../server/durak-rules.js";

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
