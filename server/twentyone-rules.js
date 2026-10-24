const TWENTY_ONE_RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const TWENTY_ONE_SUITS = ["♠", "♥", "♦", "♣"];

export function scoreTwentyOneHand(cards = []) {
  return cards.reduce((total, card) => {
    const rank = String(card?.rank || "").toUpperCase();
    if (rank === "A" || rank === "Т" || rank === "ТУЗ") return total + 11;
    if (rank === "K" || rank === "К") return total + 4;
    if (rank === "Q" || rank === "Д") return total + 3;
    if (rank === "J" || rank === "В") return total + 2;
    const value = Number(rank);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

export function createTwentyOneDeck(random = Math.random) {
  const deck = [];
  for (const suit of TWENTY_ONE_SUITS) {
    for (const rank of TWENTY_ONE_RANKS) {
      deck.push({ id: "21-" + rank + "-" + suit, rank, suit });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function finishTwentyOneRound(game) {
  if (game.status === "finished") return game;
  while (scoreTwentyOneHand(game.dealerHand) < 17 && game.deck.length) {
    game.dealerHand.push(game.deck.pop());
  }

  const dealerScore = scoreTwentyOneHand(game.dealerHand);
  game.dealerScore = dealerScore;
  for (const player of game.players) {
    const playerScore = scoreTwentyOneHand(player.hand);
    player.score = playerScore;
    if (player.status === "bust") {
      player.payout = 0;
    } else if (player.status === "won" && playerScore === 21) {
      player.payout = game.stake * 2;
    } else if (dealerScore > 21 || playerScore > dealerScore) {
      player.status = "won";
      player.payout = game.stake * 2;
    } else {
      player.status = "lost";
      player.payout = 0;
    }
  }
  game.status = "finished";
  game.currentPlayerTelegramId = null;
  game.settlementApplied = false;
  const winners = game.players.filter(player => player.status === "won").map(player => player.label);
  game.message = dealerScore > 21
    ? "У банкира перебор (" + dealerScore + "). Победители: " + (winners.join(", ") || "нет") + "."
    : "У банкира " + dealerScore + " очков. Победители: " + (winners.join(", ") || "нет") + ".";
  return game;
}

function advanceTwentyOneTurn(game, afterIndex) {
  const count = game.players.length;
  for (let offset = 1; offset <= count; offset++) {
    const index = (afterIndex + offset + count) % count;
    if (game.players[index].status === "playing") {
      game.currentPlayerIndex = index;
      game.currentPlayerTelegramId = String(game.players[index].telegramId);
      return game;
    }
  }
  return finishTwentyOneRound(game);
}

export function createTwentyOneRound(players, stake, random = Math.random) {
  if (!Array.isArray(players) || players.length < 1 || players.length > 5) {
    throw new Error("В комнате должно быть от 1 до 5 игроков");
  }
  if (!Number.isSafeInteger(Number(stake)) || Number(stake) < 100 || Number(stake) > 1000000) {
    throw new Error("Ставка должна быть от 100 до 1 000 000 AC");
  }

  const deck = createTwentyOneDeck(random);
  const gamePlayers = players.map(player => ({
    telegramId: String(player.telegramId),
    label: String(player.label || "Игрок"),
    hand: [deck.pop(), deck.pop()],
    status: "playing",
    score: 0,
    payout: 0
  }));
  const dealerHand = [deck.pop(), deck.pop()];
  for (const player of gamePlayers) {
    player.score = scoreTwentyOneHand(player.hand);
    if (player.score === 21) {
      player.status = "won";
      player.payout = Number(stake) * 2;
    }
  }

  const game = {
    status: "playing",
    stake: Number(stake),
    deck,
    dealerHand,
    dealerScore: null,
    players: gamePlayers,
    currentPlayerIndex: -1,
    currentPlayerTelegramId: null,
    message: "Карты розданы. Игроки ходят по очереди.",
    settlementApplied: false
  };
  return advanceTwentyOneTurn(game, -1);
}

export function applyTwentyOneAction(game, telegramId, action) {
  if (!game || game.status !== "playing") {
    throw new Error("Раунд уже завершён");
  }
  if (action !== "hit" && action !== "stand") {
    throw new Error("Недопустимое действие");
  }
  if (String(game.currentPlayerTelegramId) !== String(telegramId)) {
    throw new Error("Сейчас ход другого игрока");
  }

  const index = Number(game.currentPlayerIndex);
  const player = game.players[index];
  if (!player || player.status !== "playing") {
    throw new Error("Сейчас не твой ход");
  }

  if (action === "hit") {
    if (!game.deck.length) {
      player.status = "stand";
      game.message = player.label + " остановился: в колоде больше нет карт.";
    } else {
      const card = game.deck.pop();
      player.hand.push(card);
      player.score = scoreTwentyOneHand(player.hand);
      if (player.score > 21) {
        player.status = "bust";
        game.message = player.label + " перебор: " + player.score + " очков.";
      } else if (player.score === 21) {
        player.status = "won";
        player.payout = game.stake * 2;
        game.message = player.label + " набрал 21 очко и сразу выиграл!";
      } else {
        game.message = player.label + " взял карту (" + player.score + " очков).";
      }
    }
  } else {
    player.score = scoreTwentyOneHand(player.hand);
    player.status = "stand";
    game.message = player.label + " остановился на " + player.score + " очках.";
  }

  return advanceTwentyOneTurn(game, index);
}
