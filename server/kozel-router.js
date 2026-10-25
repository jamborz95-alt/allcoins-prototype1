import express from "express";
import crypto from "node:crypto";
import { recordGameCommission } from "./commission.js";

const RANKS = ["7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];
const SCORE = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0 };
const SUIT_ORDER = { "♣": 4, "♠": 3, "♥": 2, "♦": 1 };
const MATCH_LETTERS = ["К", "О", "З", "Ё", "Л"];

class KozelError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function safeStake(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 100 && amount <= 1000000 ? amount : null;
}
function isTrump(card) {
  return card.suit === "♣" || card.rank === "Q" || card.rank === "J";
}
function trumpStrength(card) {
  if (card.rank === "7" && card.suit === "♣") return 1000;
  if (card.rank === "Q") return 990 + SUIT_ORDER[card.suit];
  if (card.rank === "J") return 980 + SUIT_ORDER[card.suit];
  if (card.suit === "♣") {
    return ({ A: 970, "10": 960, K: 950, "9": 940, "8": 930 })[card.rank] || 0;
  }
  return 0;
}
function plainStrength(card) {
  return ({ A: 6, "10": 5, K: 4, "9": 3, "8": 2, "7": 1 })[card.rank] || 0;
}
function cardPoints(card) { return SCORE[card.rank] || 0; }
function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: rank + suit,
        rank,
        suit,
        points: cardPoints({ rank, suit }),
        trump: isTrump({ rank, suit })
      });
    }
  }
  return shuffle(deck);
}
function getGroup(card) { return isTrump(card) ? "trump" : "suit:" + card.suit; }
function getLegalCards(game, player) {
  if (!player || !player.hand.length) return [];
  if (!game.table.length) {
    if (game.roundNo === 1 && game.trickNo === 1 && game.firstLeadForced) {
      const aceDiamonds = player.hand.find(card => card.rank === "A" && card.suit === "♦");
      return aceDiamonds ? [aceDiamonds] : [];
    }
    const nonTrumps = player.hand.filter(card => !isTrump(card));
    const score = game.matchPoints || [0, 0];
    const kozlyachyBattle = score[0] === 10 && score[1] === 10;
    if (nonTrumps.length && !kozlyachyBattle) {
      if (game.roundNo === 1 || player.team !== Number(game.firstLeadTeam)) return nonTrumps;
    }
    return player.hand.slice();
  }
  const leadCard = game.table[0].card;
  const requiredGroup = getGroup(leadCard);
  const matching = player.hand.filter(card => getGroup(card) === requiredGroup);
  return matching.length ? matching : player.hand.slice();
}
function trickWinner(plays) {
  const leadCard = plays[0].card;
  const trumps = plays.filter(play => isTrump(play.card));
  if (trumps.length) {
    return trumps.reduce((best, play) =>
      trumpStrength(play.card) > trumpStrength(best.card) ? play : best
    );
  }
  return plays
    .filter(play => !isTrump(play.card) && play.card.suit === leadCard.suit)
    .reduce((best, play) => plainStrength(play.card) > plainStrength(best.card) ? play : best);
}
function trickPoints(plays) { return plays.reduce((sum, play) => sum + cardPoints(play.card), 0); }
function dealCards(game, firstLeadIndex, forcedFirstLead) {
  const deck = makeDeck();
  const hands = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) hands[i % 4].push(deck[i]);
  game.players.forEach((player, index) => { player.hand = hands[index]; });
  game.table = [];
  game.lastTrick = null;
  game.trickNo = 1;
  game.teamPoints = [0, 0];
  game.tricksWon = [0, 0];
  game.firstLeadForced = Boolean(forcedFirstLead);
  game.currentPlayerIndex = forcedFirstLead
    ? game.players.findIndex(player => player.hand.some(card => card.rank === "A" && card.suit === "♦"))
    : ((Number(firstLeadIndex) % 4) + 4) % 4;
  game.firstLeadTeam = game.players[game.currentPlayerIndex]?.team ?? 0;
}
function makeGame(players, stake, botMode, startedBy) {
  const game = {
    status: "playing",
    botMode: Boolean(botMode),
    stake: Number(stake),
    pot: botMode ? 0 : Number(stake) * 4,
    roundNo: 1,
    trickNo: 1,
    players: players.map((player, index) => ({
      id: String(player.id),
      name: String(player.name || ("Игрок " + (index + 1))),
      isBot: Boolean(player.isBot),
      team: index % 2 === 0 ? 0 : 1,
      hand: []
    })),
    currentPlayerIndex: 0,
    table: [],
    lastTrick: null,
    teamPoints: [0, 0],
    lastDealPoints: [0, 0],
    tricksWon: [0, 0],
    matchPoints: [0, 0],
    pendingDrawBonus: 0,
    firstLeadForced: true,
    firstLeadTeam: 0,
    startingIndex: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    winnerTeam: null,
    payouts: {},
    commissionAmount: 0,
    settlementApplied: false,
    message: "Первая раздача. Начинает игрок с тузом бубен."
  };
  dealCards(game, startedBy || 0, true);
  game.startingIndex = game.currentPlayerIndex;
  return game;
}
function chooseBotCard(game, player) {
  const legal = getLegalCards(game, player);
  if (!legal.length) return null;
  if (!game.table.length) {
    const nonTrumps = legal.filter(card => !isTrump(card));
    const pool = nonTrumps.length ? nonTrumps : legal;
    return pool.slice().sort((a, b) => cardPoints(a) - cardPoints(b) || (isTrump(a) ? trumpStrength(a) : plainStrength(a)) - (isTrump(b) ? trumpStrength(b) : plainStrength(b)))[0];
  }
  const currentBest = trickWinner(game.table);
  const teammateWinning = currentBest && game.players[currentBest.playerIndex].team === player.team;
  const evaluated = legal.map(card => {
    const hypothetical = game.table.concat([{ playerIndex: game.currentPlayerIndex, card }]);
    const best = trickWinner(hypothetical);
    const wins = best.playerIndex === game.currentPlayerIndex;
    return { card, wins, points: cardPoints(card), strength: isTrump(card) ? trumpStrength(card) : plainStrength(card) };
  });
  if (teammateWinning) {
    return evaluated.sort((a, b) => a.points - b.points || a.strength - b.strength)[0].card;
  }
  const winningCards = evaluated.filter(item => item.wins);
  if (winningCards.length) {
    return winningCards.sort((a, b) => a.points - b.points || a.strength - b.strength)[0].card;
  }
  return evaluated.sort((a, b) => a.points - b.points || a.strength - b.strength)[0].card;
}
function processPlayedCard(game, playerIndex, card) {
  const player = game.players[playerIndex];
  const pos = player.hand.findIndex(item => item.id === card.id);
  if (pos < 0) throw new KozelError(400, "Эта карта уже недоступна.");
  player.hand.splice(pos, 1);
  game.table.push({ playerIndex, card: { ...card } });
  if (game.table.length < 4) {
    game.currentPlayerIndex = (playerIndex + 1) % 4;
    game.message = "Ходит: " + game.players[game.currentPlayerIndex].name + ".";
    return;
  }

  const winningPlay = trickWinner(game.table);
  const winnerIndex = winningPlay.playerIndex;
  const winningTeam = game.players[winnerIndex].team;
  const points = trickPoints(game.table);
  const completedPlays = game.table.map(play => ({
    playerIndex: play.playerIndex,
    playerName: game.players[play.playerIndex].name,
    team: game.players[play.playerIndex].team,
    card: { ...play.card }
  }));
  game.teamPoints[winningTeam] += points;
  game.tricksWon[winningTeam] = Number(game.tricksWon[winningTeam] || 0) + 1;
  game.lastTrick = {
    plays: completedPlays,
    winnerIndex,
    winnerName: game.players[winnerIndex].name,
    winnerTeam: winningTeam,
    points,
    trickNo: game.trickNo
  };
  game.table = [];
  game.currentPlayerIndex = winnerIndex;
  game.trickNo += 1;
  game.firstLeadForced = false;

  if (game.players.every(item => item.hand.length === 0)) {
    finishDeal(game, winnerIndex);
  } else {
    game.message = game.players[winnerIndex].name + " забирает взятку (" + points + " очков). Следующий заход — его.";
  }
}
function finishDeal(game, previousWinnerIndex) {
  const [team0Points, team1Points] = game.teamPoints;
  game.lastDealPoints = [team0Points, team1Points];

  if (team0Points === team1Points) {
    game.pendingDrawBonus = Number(game.pendingDrawBonus || 0) + 2;
    game.message = "Раздача завершена со счётом 60:60. Эти 2 балла перейдут победителю следующей раздачи.";
    const nextLeader = game.startingIndex;
    game.roundNo += 1;
    game.startingIndex = nextLeader;
    dealCards(game, nextLeader, false);
    return;
  }

  const winningTeam = team0Points > team1Points ? 0 : 1;
  const losingTeam = 1 - winningTeam;
  const bonus = Math.max(0, Number(game.pendingDrawBonus) || 0);
  game.pendingDrawBonus = 0;
  let gained = 0;
  let note = "";

  if (Number(game.tricksWon[winningTeam] || 0) === 8) {
    if (game.matchPoints[0] === 0 && game.matchPoints[1] === 0) {
      gained = 6 + bonus;
      game.matchPoints[winningTeam] += gained;
      note = "Команда взяла все 8 взяток и получает " + gained + " баллов.";
    } else if (Number(game.matchPoints[losingTeam] || 0) > 0) {
      game.matchPoints[losingTeam] = 0;
      if (bonus > 0) {
        game.matchPoints[winningTeam] += bonus;
        gained = bonus;
      }
      note = "Команда взяла все 8 взяток: баллы соперников сброшены до 0." +
        (bonus ? " Дополнительно перенесено " + bonus + " балла." : "");
    } else {
      game.status = "finished";
      game.winnerTeam = winningTeam;
      game.finishedAt = new Date().toISOString();
      game.table = [];
      game.currentPlayerIndex = previousWinnerIndex;
      game.message = "Партия завершена: команда " + (winningTeam + 1) +
        " взяла все 8 взяток, а соперники не имели баллов для сброса. Команда " +
        (winningTeam + 1) + " победила.";
      return;
    }
  } else {
    if (game.teamPoints[winningTeam] === 120) gained = 6;
    else if (game.teamPoints[winningTeam] >= 90) gained = 4;
    else if (game.teamPoints[winningTeam] >= 61) gained = 2;
    gained += bonus;
    game.matchPoints[winningTeam] += gained;
    note = "Команда " + (winningTeam + 1) + " получает " + gained + " баллов за раздачу.";
  }

  if (game.matchPoints[winningTeam] >= 12) {
    game.status = "finished";
    game.winnerTeam = winningTeam;
    game.finishedAt = new Date().toISOString();
    game.table = [];
    game.currentPlayerIndex = previousWinnerIndex;
    game.message = "Партия завершена! Команда " + (winningTeam + 1) + " набрала " +
      game.matchPoints[winningTeam] + " баллов и победила. Счёт раздачи: " +
      team0Points + ":" + team1Points + ".";
    return;
  }

  game.message = "Раздача " + game.roundNo + " завершена: " + team0Points + ":" + team1Points +
    ". " + note + " Матч: " + game.matchPoints[0] + ":" + game.matchPoints[1] + ".";
  const nextLeader = (game.startingIndex + 1) % 4;
  game.roundNo += 1;
  game.startingIndex = nextLeader;
  dealCards(game, nextLeader, false);
}
async function settlePayout(client, roomId, game) {
  if (game.status !== "finished" || game.settlementApplied) return;
  game.payouts = {};
  game.commissionAmount = 0;
  if (game.botMode) {
    game.settlementApplied = true;
    game.message += " Тестовая партия: AC не начислялись.";
    return;
  }
  const commission = await recordGameCommission(client, {
    game: "kozel",
    eventKey: "kozel:" + String(roomId) + ":" + String(game.startedAt || "legacy"),
    grossAmount: Math.max(0, Number(game.pot) || 0)
  });
  const fee = Math.min(Number(game.pot) || 0, Math.max(0, Math.floor(Number(commission?.amount) || 0)));
  const pool = Math.max(0, Number(game.pot) - fee);
  const winners = game.players.filter(player => player.team === game.winnerTeam && !player.isBot);
  const base = winners.length ? Math.floor(pool / winners.length) : 0;
  let remainder = winners.length ? pool % winners.length : 0;
  for (const winner of winners) {
    const amount = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    const credited = await client.query(
      "UPDATE players SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING balance",
      [String(amount), String(winner.id)]
    );
    if (!credited.rows.length) throw new Error("Не найден баланс победителя Козла.");
    game.payouts[String(winner.id)] = amount;
  }
  game.commissionAmount = fee;
  game.settlementApplied = true;
  game.message += " Банк " + Number(game.pot).toLocaleString("ru-RU") + " AC, комиссия 5%: " +
    fee.toLocaleString("ru-RU") + " AC.";
}
function publicGame(game, userId) {
  if (!game) return null;
  const ended = game.status === "finished";
  const me = game.players.find(player => player.id === String(userId));
  return {
    status: game.status,
    botMode: Boolean(game.botMode),
    stake: Number(game.stake || 0),
    pot: Number(game.pot || 0),
    roundNo: Number(game.roundNo || 1),
    trickNo: Number(game.trickNo || 1),
    teamPoints: [...(game.teamPoints || [0, 0])],
    lastDealPoints: [...(game.lastDealPoints || [0, 0])],
    tricksWon: [...(game.tricksWon || [0, 0])],
    matchPoints: [...(game.matchPoints || [0, 0])],
    pendingDrawBonus: Number(game.pendingDrawBonus || 0),
    currentPlayerIndex: Number(game.currentPlayerIndex || 0),
    currentPlayerId: game.players[game.currentPlayerIndex]?.id || null,
    currentPlayerName: game.players[game.currentPlayerIndex]?.name || "",
    myTeam: me?.team ?? null,
    winnerTeam: game.winnerTeam,
    myPayout: Number(game.payouts?.[String(userId)] || 0),
    commissionAmount: Number(game.commissionAmount || 0),
    message: String(game.message || ""),
    lastTrick: game.lastTrick || null,
    table: (game.table || []).map(play => ({
      playerIndex: play.playerIndex,
      playerName: game.players[play.playerIndex]?.name || "Игрок",
      team: game.players[play.playerIndex]?.team ?? 0,
      card: { ...play.card }
    })),
    players: game.players.map((player, index) => ({
      id: String(player.id),
      name: String(player.name || "Игрок"),
      isBot: Boolean(player.isBot),
      team: Number(player.team),
      isYou: String(player.id) === String(userId),
      hand: (ended || String(player.id) === String(userId)) ? player.hand.map(card => ({ ...card })) : [],
      cardsCount: player.hand.length,
      payout: Number(game.payouts?.[String(player.id)] || 0),
      isCurrent: game.status === "playing" && index === game.currentPlayerIndex
    })),
    legalCardIds: game.status === "playing" && me && game.currentPlayerIndex === game.players.indexOf(me)
      ? getLegalCards(game, me).map(card => card.id)
      : [],
    startedAt: game.startedAt,
    finishedAt: game.finishedAt
  };
}
function mapRoom(row, playersCount, userId) {
  return {
    id: String(row.id),
    name: String(row.name || "Комната Козёл"),
    ownerTelegramId: String(row.owner_telegram_id),
    ownerName: String(row.owner_name || "Игрок"),
    stake: Number(row.stake),
    maxPlayers: 4,
    status: String(row.status),
    botMode: Boolean(row.bot_mode),
    playersCount: Number(playersCount || 0),
    isOwner: String(row.owner_telegram_id) === String(userId)
  };
}

export function createKozelRouter({ pool, verifyTelegram }) {
  const router = express.Router();
  function userFor(req, res) {
    const user = verifyTelegram(req.body?.initData);
    if (!user?.id) {
      res.status(401).json({ ok: false, error: "Открой Козёл через ALLCOINS в Telegram." });
      return null;
    }
    return user;
  }
  async function ensurePlayer(client, user) {
    const result = await client.query(
      "INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance",
      [String(user.id)]
    );
    return Number(result.rows[0]?.balance || 0);
  }
  async function readRoom(roomId) {
    const result = await pool.query(
      `SELECT r.*, COUNT(rp.telegram_id)::INTEGER AS players_count
       FROM kozel_rooms r LEFT JOIN kozel_room_players rp ON rp.room_id = r.id
       WHERE r.id = $1 GROUP BY r.id`,
      [roomId]
    );
    return result.rows[0] || null;
  }
  async function publicRoomState(roomId, userId) {
    const room = await readRoom(roomId);
    if (!room) throw new KozelError(404, "Комната Козёл не найдена.");
    const member = await pool.query(
      "SELECT 1 FROM kozel_room_players WHERE room_id = $1 AND telegram_id = $2",
      [String(roomId), String(userId)]
    );
    if (!member.rows.length) throw new KozelError(403, "Ты не состоишь в этой комнате.");
    const playersResult = await pool.query(
      `SELECT telegram_id, display_name, joined_at FROM kozel_room_players
       WHERE room_id = $1 ORDER BY seat_no ASC, joined_at ASC`,
      [String(roomId)]
    );
    const gameResult = await pool.query(
      "SELECT game_state FROM kozel_games WHERE room_id = $1",
      [String(roomId)]
    );
    const profileResult = await pool.query(
      "SELECT balance FROM players WHERE telegram_id = $1",
      [String(userId)]
    );
    const members = playersResult.rows.map((player, index) => ({
      telegramId: String(player.telegram_id),
      name: String(player.display_name || "Игрок"),
      seatNo: index
    }));
    const rawGame = gameResult.rows[0]?.game_state || null;
    return {
      ok: true,
      balance: Number(profileResult.rows[0]?.balance || 0),
      room: mapRoom(room, members.length, userId),
      roomPlayers: members,
      game: publicGame(rawGame, userId)
    };
  }
  async function startGame(client, room, members, user) {
    if (!members || members.length !== 4) throw new KozelError(400, "Для Козла нужны четыре игрока. Добавь остальных в комнату.");
    const botMode = Boolean(room.bot_mode);
    if (!botMode) {
      for (const member of members) {
        const result = await client.query("SELECT balance FROM players WHERE telegram_id = $1 FOR UPDATE", [String(member.telegram_id)]);
        if (!result.rows.length || Number(result.rows[0].balance) < Number(room.stake)) {
          throw new KozelError(400, "У игрока " + String(member.display_name || "Игрок") + " недостаточно AC для ставки " + Number(room.stake).toLocaleString("ru-RU") + ".");
        }
      }
      for (const member of members) {
        const debit = await client.query(
          "UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2 AND balance >= $1 RETURNING balance",
          [Number(room.stake), String(member.telegram_id)]
        );
        if (!debit.rows.length) throw new KozelError(400, "Не удалось списать ставку у всех игроков.");
      }
    }
    const game = makeGame(members.map(member => ({
      id: String(member.telegram_id),
      name: String(member.display_name || "Игрок"),
      isBot: String(member.telegram_id).startsWith("kozel-bot-")
    })), Number(room.stake), botMode, 0);
    game.startingIndex = Math.max(0, game.currentPlayerIndex);
    if (botMode) autoPlayBots(game);
    await client.query(
      `INSERT INTO kozel_games (room_id, game_state, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (room_id) DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = NOW()`,
      [String(room.id), JSON.stringify(game)]
    );
    await client.query(
      "UPDATE kozel_rooms SET status = $2, started_at = NOW() WHERE id = $1",
      [String(room.id), game.status]
    );
    return game;
  }
  function autoPlayBots(game) {
    let count = 0;
    while (game.status === "playing" && game.players[game.currentPlayerIndex]?.isBot && count < 40) {
      const playerIndex = game.currentPlayerIndex;
      const player = game.players[playerIndex];
      const card = chooseBotCard(game, player);
      if (!card) break;
      processPlayedCard(game, playerIndex, card);
      count += 1;
    }
  }

  router.initialize = async function initializeKozelTables() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS kozel_rooms (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Комната Козёл',
        owner_telegram_id TEXT NOT NULL,
        owner_name TEXT NOT NULL DEFAULT 'Игрок',
        stake BIGINT NOT NULL CHECK (stake BETWEEN 100 AND 1000000),
        max_players INTEGER NOT NULL DEFAULT 4 CHECK (max_players = 4),
        bot_mode BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ
      )`
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS kozel_room_players (
        room_id BIGINT NOT NULL REFERENCES kozel_rooms(id) ON DELETE CASCADE,
        telegram_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT 'Игрок',
        seat_no INTEGER NOT NULL DEFAULT 0,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (room_id, telegram_id)
      )`
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS kozel_games (
        room_id BIGINT PRIMARY KEY REFERENCES kozel_rooms(id) ON DELETE CASCADE,
        game_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await pool.query("CREATE INDEX IF NOT EXISTS kozel_rooms_waiting_idx ON kozel_rooms (status, created_at DESC)");
  };

  router.post("/rooms/list", async (req, res) => {
    const user = userFor(req, res);
    if (!user) return;
    try {
      await pool.query("INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING", [String(user.id)]);
      const result = await pool.query(
        `SELECT r.*, COUNT(rp.telegram_id)::INTEGER AS players_count
         FROM kozel_rooms r LEFT JOIN kozel_room_players rp ON rp.room_id = r.id
         WHERE r.status = 'waiting' AND r.bot_mode = FALSE
         GROUP BY r.id ORDER BY r.created_at DESC LIMIT 50`
      );
      const balance = await pool.query("SELECT balance FROM players WHERE telegram_id = $1", [String(user.id)]);
      return res.json({
        ok: true,
        balance: Number(balance.rows[0]?.balance || 0),
        rooms: result.rows.map(row => mapRoom(row, row.players_count, user.id))
      });
    } catch (error) {
      console.error("List Kozel rooms error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить комнаты Козёл." });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const user = userFor(req, res);
    if (!user) return;
    const stake = safeStake(req.body?.stake);
    if (stake === null) return res.status(400).json({ ok: false, error: "Ставка должна быть от 100 до 1 000 000 AC." });
    const name = String(req.body?.name || "Комната Козёл").trim().slice(0, 30) || "Комната Козёл";
    const botMode = req.body?.botMode === true;
    const ownerName = String(user.first_name || user.username || "Игрок").trim().slice(0, 40) || "Игрок";
    const client = await pool.connect();
    let open = false;
    let roomId = null;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await ensurePlayer(client, user);
      if (!botMode && balance < stake) throw new KozelError(400, "Недостаточно AC для выбранной ставки.");
      const inserted = await client.query(
        `INSERT INTO kozel_rooms (name, owner_telegram_id, owner_name, stake, max_players, bot_mode, status)
         VALUES ($1, $2, $3, $4, 4, $5, $6)
         RETURNING id`,
        [name, String(user.id), ownerName, stake, botMode, botMode ? "playing" : "waiting"]
      );
      roomId = String(inserted.rows[0].id);
      await client.query(
        "INSERT INTO kozel_room_players (room_id, telegram_id, display_name, seat_no) VALUES ($1, $2, $3, 0)",
        [roomId, String(user.id), ownerName]
      );
      if (botMode) {
        for (let i = 1; i <= 3; i++) {
          await client.query(
            "INSERT INTO kozel_room_players (room_id, telegram_id, display_name, seat_no) VALUES ($1, $2, $3, $4)",
            [roomId, "kozel-bot-" + i, ["Борис", "Галина", "Степан"][i - 1], i]
          );
        }
      }
      await client.query("COMMIT"); open = false;
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      if (error.status) return res.status(error.status).json({ ok: false, error: error.message });
      console.error("Create Kozel room error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось создать комнату Козёл." });
    } finally {
      client.release();
    }

    if (botMode) {
      const startClient = await pool.connect();
      let tx = false;
      try {
        await startClient.query("BEGIN"); tx = true;
        const roomResult = await startClient.query("SELECT * FROM kozel_rooms WHERE id = $1 FOR UPDATE", [roomId]);
        const playersResult = await startClient.query(
          "SELECT telegram_id, display_name, seat_no FROM kozel_room_players WHERE room_id = $1 ORDER BY seat_no ASC",
          [roomId]
        );
        const room = roomResult.rows[0];
        const game = await startGame(startClient, room, playersResult.rows, user);
        if (game.status === "finished") await settlePayout(startClient, roomId, game);
        await startClient.query("UPDATE kozel_games SET game_state = $2::jsonb WHERE room_id = $1", [roomId, JSON.stringify(game)]);
        await startClient.query("COMMIT"); tx = false;
      } catch (error) {
        if (tx) { try { await startClient.query("ROLLBACK"); } catch {} }
        console.error("Start Kozel bot game error:", error.message || error);
        return res.status(500).json({ ok: false, error: "Не удалось запустить игру с ботами." });
      } finally { startClient.release(); }
    }
    try { return res.json(await publicRoomState(roomId, user.id)); }
    catch (error) { return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось открыть комнату." }); }
  });

  router.post("/rooms/join", async (req, res) => {
    const user = userFor(req, res);
    if (!user) return;
    const roomId = String(req.body?.roomId || "");
    if (!/^\d+$/.test(roomId)) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query("SELECT * FROM kozel_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new KozelError(404, "Комната Козёл не найдена.");
      if (room.status !== "waiting" || room.bot_mode) throw new KozelError(400, "Эта комната уже недоступна для входа.");
      await ensurePlayer(client, user);
      const oldMember = await client.query("SELECT 1 FROM kozel_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, String(user.id)]);
      if (!oldMember.rows.length) {
        const count = await client.query("SELECT COUNT(*)::INTEGER AS total FROM kozel_room_players WHERE room_id = $1", [roomId]);
        if (Number(count.rows[0]?.total || 0) >= 4) throw new KozelError(400, "Комната уже заполнена.");
        const profile = await client.query("SELECT balance FROM players WHERE telegram_id = $1", [String(user.id)]);
        if (Number(profile.rows[0]?.balance || 0) < Number(room.stake)) throw new KozelError(400, "Недостаточно AC для ставки этой комнаты.");
        const index = Number(count.rows[0]?.total || 0);
        const displayName = String(user.first_name || user.username || "Игрок").trim().slice(0, 40) || "Игрок";
        await client.query(
          "INSERT INTO kozel_room_players (room_id, telegram_id, display_name, seat_no) VALUES ($1, $2, $3, $4)",
          [roomId, String(user.id), displayName, index]
        );
      }
      await client.query("COMMIT"); open = false;
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      if (error.status) return res.status(error.status).json({ ok: false, error: error.message });
      console.error("Join Kozel room error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось войти в комнату Козёл." });
    } finally { client.release(); }
    try { return res.json(await publicRoomState(roomId, user.id)); }
    catch (error) { return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось открыть комнату." }); }
  });

  router.post("/rooms/state", async (req, res) => {
    const user = userFor(req, res);
    if (!user) return;
    const roomId = String(req.body?.roomId || "");
    if (!/^\d+$/.test(roomId)) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });
    try { return res.json(await publicRoomState(roomId, user.id)); }
    catch (error) {
      if (error.status) return res.status(error.status).json({ ok: false, error: error.message });
      console.error("Get Kozel room state error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось обновить комнату Козёл." });
    }
  });

  router.post("/rooms/start", async (req, res) => {
    const user = userFor(req, res);
    if (!user) return;
    const roomId = String(req.body?.roomId || "");
    if (!/^\d+$/.test(roomId)) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query("SELECT * FROM kozel_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new KozelError(404, "Комната не найдена.");
      if (String(room.owner_telegram_id) !== String(user.id)) throw new KozelError(403, "Начать партию может только создатель комнаты.");
      if (room.status !== "waiting") throw new KozelError(400, "Партия уже запущена.");
      const membersResult = await client.query(
        "SELECT telegram_id, display_name, seat_no FROM kozel_room_players WHERE room_id = $1 ORDER BY seat_no ASC",
        [roomId]
      );
      const game = await startGame(client, room, membersResult.rows, user);
      if (game.status === "finished") await settlePayout(client, roomId, game);
      await client.query("UPDATE kozel_games SET game_state = $2::jsonb WHERE room_id = $1", [roomId, JSON.stringify(game)]);
      await client.query("COMMIT"); open = false;
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      if (error.status) return res.status(error.status).json({ ok: false, error: error.message });
      console.error("Start Kozel game error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось начать партию Козёл." });
    } finally { client.release(); }
    try { return res.json(await publicRoomState(roomId, user.id)); }
    catch (error) { return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось открыть комнату." }); }
  });

  router.post("/game/action", async (req, res) => {
    const user = userFor(req, res);
    if (!user) return;
    const roomId = String(req.body?.roomId || "");
    const cardId = String(req.body?.cardId || "");
    if (!/^\d+$/.test(roomId) || !cardId) return res.status(400).json({ ok: false, error: "Неверный ход." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query("SELECT * FROM kozel_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new KozelError(404, "Комната не найдена.");
      const memberResult = await client.query("SELECT 1 FROM kozel_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, String(user.id)]);
      if (!memberResult.rows.length) throw new KozelError(403, "Ты не состоишь в комнате.");
      const gameResult = await client.query("SELECT game_state FROM kozel_games WHERE room_id = $1 FOR UPDATE", [roomId]);
      if (!gameResult.rows.length) throw new KozelError(404, "Партия ещё не подготовлена.");
      const game = gameResult.rows[0].game_state;
      if (game.status !== "playing") throw new KozelError(400, "Партия уже завершена.");
      const playerIndex = game.players.findIndex(player => String(player.id) === String(user.id));
      if (playerIndex < 0) throw new KozelError(403, "Ты не участвуешь в этой партии.");
      if (playerIndex !== Number(game.currentPlayerIndex)) throw new KozelError(409, "Сейчас ход другого игрока.");
      const player = game.players[playerIndex];
      const card = player.hand.find(item => String(item.id) === cardId);
      if (!card) throw new KozelError(400, "Этой карты нет на твоей руке.");
      const legalIds = getLegalCards(game, player).map(item => item.id);
      if (!legalIds.includes(card.id)) throw new KozelError(400, "Нужно ответить в масть или положить козырь, если он есть.");
      processPlayedCard(game, playerIndex, card);
      if (game.botMode) autoPlayBots(game);
      if (game.status === "finished") {
        await settlePayout(client, roomId, game);
        await client.query("UPDATE kozel_rooms SET status = 'finished' WHERE id = $1", [roomId]);
      }
      await client.query("UPDATE kozel_games SET game_state = $2::jsonb, updated_at = NOW() WHERE room_id = $1", [roomId, JSON.stringify(game)]);
      await client.query("COMMIT"); open = false;
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      if (error.status) return res.status(error.status).json({ ok: false, error: error.message });
      console.error("Kozel move error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось выполнить ход в Козле." });
    } finally { client.release(); }
    try { return res.json(await publicRoomState(roomId, user.id)); }
    catch (error) { return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось получить результат хода." }); }
  });

  router.post("/rooms/leave", async (req, res) => {
    const user = userFor(req, res);
    if (!user) return;
    const roomId = String(req.body?.roomId || "");
    if (!/^\d+$/.test(roomId)) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query("SELECT * FROM kozel_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new KozelError(404, "Комната не найдена.");
      if (room.status === "playing") throw new KozelError(400, "Во время активной партии нельзя покинуть стол. Дождись завершения раздачи.");
      if (String(room.owner_telegram_id) === String(user.id)) {
        await client.query("DELETE FROM kozel_rooms WHERE id = $1", [roomId]);
      } else {
        await client.query("DELETE FROM kozel_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, String(user.id)]);
      }
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      if (error.status) return res.status(error.status).json({ ok: false, error: error.message });
      console.error("Leave Kozel room error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось выйти из комнаты Козёл." });
    } finally { client.release(); }
  });

  return router;
}
