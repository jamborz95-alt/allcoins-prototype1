import crypto from "node:crypto";

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS_36 = ["6", "7", "8", "9", "10", "В", "Д", "К", "Т"];
const RANKS_52 = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "В", "Д", "К", "Туз"];

const RANK_ORDER = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
  "9": 9, "10": 10, "В": 11, "J": 11, "Д": 12, "Q": 12,
  "К": 13, "K": 13, "Т": 14, "Туз": 14, "A": 14
};

export function createDurakDeck(deckSize = 36) {
  const ranks = Number(deckSize) === 52 ? RANKS_52 : RANKS_36;
  return SUITS.flatMap((suit) => ranks.map((rank) => ({
    suit,
    rank,
    id: `${rank}${suit}`
  })));
}

export function shuffleDurakDeck(deck, randomInt = crypto.randomInt) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function cardRank(card) {
  return RANK_ORDER[String(card?.rank)] || 0;
}

export function beatsCard(defense, attack, trumpSuit) {
  if (!defense || !attack) return false;
  const defenseSuit = String(defense.suit ?? "");
  const attackSuit = String(attack.suit ?? "");
  const trump = String(trumpSuit ?? "");
  if (defenseSuit === attackSuit) {
    return cardRank(defense) > cardRank(attack);
  }
  return defenseSuit === trump && attackSuit !== trump;
}

export function dealInitialHands(deck, playerCount, cardsPerPlayer = 6) {
  if (!Number.isInteger(playerCount) || playerCount < 2) {
    throw new RangeError("Для игры нужны минимум 2 игрока");
  }
  if (!Number.isInteger(cardsPerPlayer) || cardsPerPlayer < 1) {
    throw new RangeError("Некорректное количество карт");
  }
  if (deck.length < playerCount * cardsPerPlayer + 1) {
    throw new RangeError("В колоде недостаточно карт для раздачи и козыря");
  }
  const remaining = [...deck];
  const hands = Array.from({ length: playerCount }, () => []);
  for (const hand of hands) {
    for (let i = 0; i < cardsPerPlayer; i++) hand.push(remaining.pop());
  }
  const trumpCard = remaining[remaining.length - 1];
  return { hands, deck: remaining, trumpCard, trumpSuit: trumpCard.suit };
}
