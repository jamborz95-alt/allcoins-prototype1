const SEKA_SUITS = ["♠", "♥", "♦", "♣"];
const SEKA_RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];

export function createSekaDeck(random = Math.random) {
  const deck = [];
  for (const suit of SEKA_SUITS) {
    for (const rank of SEKA_RANKS) deck.push({ id: "seka-" + rank + "-" + suit, rank, suit });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function sekaCardPoints(card) {
  const rank = String(card && card.rank || "").toUpperCase();
  if (rank === "A" || rank === "Т" || rank === "ТУЗ") return 11;
  if (rank === "10" || rank === "J" || rank === "Q" || rank === "K") return 10;
  const number = Number(rank);
  return Number.isFinite(number) ? number : 0;
}

function tripletValue(rank) {
  if (rank === "6") return 34;
  if (rank === "A") return 33;
  return sekaCardPoints({ rank }) * 3;
}

export function scoreSekaHand(cards = []) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    return { score: 0, type: 0, label: "Нет комбинации" };
  }
  const ranks = cards.map(card => String(card && card.rank || "").toUpperCase());
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);

  if (counts.size === 1) {
    const rank = ranks[0];
    return { score: tripletValue(rank), type: 3, label: "Три " + rank };
  }

  const jokerIndex = cards.findIndex(card =>
    String(card && card.rank || "").toUpperCase() === "7" && String(card && card.suit || "") === "♣"
  );
  if (jokerIndex >= 0) {
    const otherCards = cards.filter((card, index) => index !== jokerIndex);
    const otherRanks = otherCards.map(card => String(card && card.rank || "").toUpperCase());
    if (otherRanks[0] === otherRanks[1]) {
      return { score: tripletValue(otherRanks[0]), type: 3, label: "Тройка с джокером" };
    }
  }

  if (ranks.filter(rank => rank === "A").length >= 2) {
    return { score: 22, type: 2, label: "Два туза" };
  }
  let best = { score: 0, type: 1, label: "Старшая карта" };

  const suitTotals = new Map();
  for (const card of cards) {
    const suit = String(card && card.suit || "");
    const points = String(card && card.rank || "").toUpperCase() === "7" && suit === "♣"
      ? 11 : sekaCardPoints(card);
    suitTotals.set(suit, (suitTotals.get(suit) || 0) + points);
  }
  for (const [suit, total] of suitTotals.entries()) {
    const sameSuitCount = cards.filter(card => String(card && card.suit || "") === suit).length;
    if (sameSuitCount >= 2 && (best.type < 2 || total > best.score)) {
      best = { score: total, type: 2, label: "Одна масть" };
    }
  }
  if (best.type < 2) {
    const highest = cards.reduce((max, card) => Math.max(max, (
      String(card && card.rank || "").toUpperCase() === "7" && String(card && card.suit || "") === "♣"
    ) ? 11 : sekaCardPoints(card)), 0);
    best = { score: highest, type: 1, label: "Старшая карта" };
  }
  return best;
}

export function compareSekaHands(leftCards = [], rightCards = []) {
  const left = scoreSekaHand(leftCards);
  const right = scoreSekaHand(rightCards);
  if (left.type !== right.type) return left.type > right.type ? 1 : -1;
  if (left.score !== right.score) return left.score > right.score ? 1 : -1;
  return 0;
}

export function createSekaGame(players, ante, random = Math.random) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("Для игры в Секу нужно от 2 до 6 игроков");
  }
  if (!Number.isSafeInteger(Number(ante)) || Number(ante) < 100) {
    throw new Error("Начальная ставка должна быть целым числом не меньше 100 AC");
  }
  const deck = createSekaDeck(random);
  const gamePlayers = players.map((player, index) => ({
    telegramId: String(player.telegramId),
    label: String(player.label || "Игрок"),
    isBot: Boolean(player.isBot || String(player.telegramId) === "0"),
    seatNo: index,
    hand: [deck.pop(), deck.pop(), deck.pop()],
    folded: false,
    contribution: Number(ante),
    acted: false,
    score: null,
    handType: null,
    payout: 0
  }));
  return {
    status: "playing",
    deckCount: deck.length,
    players: gamePlayers,
    // Test bots do not stake real AC. Only actual players' ante goes into the pot.
    pot: gamePlayers.filter(player => !player.isBot).reduce((sum, player) => sum + Number(ante), 0),
    ante: Number(ante),
    currentBet: Number(ante),
    currentPlayerIndex: 0,
    currentPlayerTelegramId: gamePlayers[0].telegramId,
    winnerTelegramIds: [],
    message: "Карты розданы. Ходит " + gamePlayers[0].label + ".",
    settlementApplied: false,
    startedAt: new Date().toISOString()
  };
}

export function nextSekaTurnIndex(game, afterIndex) {
  if (!game || !Array.isArray(game.players) || !game.players.length) return -1;
  const count = game.players.length;
  for (let offset = 1; offset <= count; offset++) {
    const index = (Number(afterIndex) + offset + count) % count;
    if (!game.players[index].folded) return index;
  }
  return -1;
}

export function activeSekaPlayers(game) {
  return (game && Array.isArray(game.players) ? game.players : []).filter(player => !player.folded);
}

export function allActiveSekaPlayersMatched(game) {
  const active = activeSekaPlayers(game);
  return active.length > 1 && active.every(player =>
    player.acted && Number(player.contribution) >= Number(game.currentBet)
  );
}
