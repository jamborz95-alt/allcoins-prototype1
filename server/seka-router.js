import express from "express";
import {
  createSekaGame,
  scoreSekaHand,
  compareSekaHands,
  nextSekaTurnIndex,
  activeSekaPlayers,
  allActiveSekaPlayersMatched
} from "./seka-rules.js";

const SEKA_LIMITS = {
  1: { min: 100, max: 1000, label: "100–1 000 AC" },
  2: { min: 1000, max: 10000, label: "1 000–10 000 AC" },
  3: { min: 10000, max: 100000, label: "10 000–100 000 AC" },
  4: { min: 100000, max: 1000000, label: "100 000–1 000 000 AC" },
  5: { min: 1000000, max: null, label: "От 1 000 000 AC без верхнего лимита" }
};

const SEKA_BOT_ID = "0";
const SEKA_BOT_LABEL = "🤖 Бот проверки";

class SekaHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function safeAmount(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function mapRoom(row, userId) {
  return {
    id: String(row.id),
    name: String(row.name || "Комната Сека"),
    ownerTelegramId: String(row.owner_telegram_id),
    tier: Number(row.limit_tier),
    limitLabel: SEKA_LIMITS[Number(row.limit_tier)]?.label || "",
    minBet: Number(row.min_bet),
    maxBet: row.max_bet == null ? null : Number(row.max_bet),
    ante: Number(row.ante),
    maxPlayers: Number(row.max_players || 6),
    status: String(row.status),
    playersCount: Number(row.players_count || 0),
    isOwner: String(row.owner_telegram_id) === String(userId)
  };
}

export function createSekaRouter({ pool, verifyTelegram }) {
  const router = express.Router();

  function authenticatedUser(req, res) {
    const user = verifyTelegram(req.body?.initData);
    if (!user?.id) {
      res.status(401).json({ ok: false, error: "Не удалось проверить Telegram. Открой Секу из ALLCOINS." });
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

  async function getRoomRow(client, roomId, lock = false) {
    const result = await client.query(
      "SELECT id, name, owner_telegram_id, limit_tier, min_bet, max_bet, ante, max_players, status, created_at FROM seka_rooms WHERE id = $1" + (lock ? " FOR UPDATE" : ""),
      [roomId]
    );
    return result.rows[0] || null;
  }

  async function getRoomCounts(client, roomId) {
    const result = await client.query(
      "SELECT COUNT(*)::INTEGER AS total FROM seka_room_players WHERE room_id = $1",
      [roomId]
    );
    return Number(result.rows[0]?.total || 0);
  }

  async function chargePlayer(client, telegramId, amount) {
    const charge = safeAmount(amount);
    if (charge === null) throw new SekaHttpError(400, "Некорректная сумма ставки");
    if (charge === 0) return;
    const result = await client.query(
      "UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2 AND balance >= $1 RETURNING balance",
      [charge, String(telegramId)]
    );
    if (!result.rows.length) {
      throw new SekaHttpError(400, "Недостаточно AC для этой ставки. Поддержи меньшую ставку или нажми «Пас».");
    }
  }

  async function creditWinners(client, game, winners, message) {
    if (game.settlementApplied) return;
    const allWinners = [...new Map(winners.map(player => [String(player.telegramId), player])).values()];
    if (!allWinners.length) throw new SekaHttpError(500, "Не удалось определить победителя партии");
    // Бот нужен только для проверки механики и никогда не получает реальные AC.
    const uniqueWinners = game.testMode
      ? []
      : allWinners.filter(player => !player.isBot && String(player.telegramId) !== SEKA_BOT_ID);
    const totalPot = Math.max(0, Math.floor(Number(game.pot) || 0));
    let remainder = uniqueWinners.length ? totalPot % uniqueWinners.length : 0;
    const baseShare = uniqueWinners.length ? Math.floor(totalPot / uniqueWinners.length) : 0;
    for (const player of game.players) player.payout = 0;
    const payoutRows = [];
    for (const winner of uniqueWinners) {
      const amount = baseShare + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      const result = await client.query(
        "UPDATE players SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING balance",
        [amount, String(winner.telegramId)]
      );
      if (!result.rows.length) throw new SekaHttpError(500, "Не найден баланс победителя");
      winner.payout = amount;
      payoutRows.push({ telegramId: String(winner.telegramId), label: winner.label, amount });
    }
    game.status = "finished";
    game.currentPlayerIndex = -1;
    game.currentPlayerTelegramId = null;
    game.winnerTelegramIds = allWinners.map(player => String(player.telegramId));
    game.payouts = payoutRows;
    game.settlementApplied = true;
    game.finishedAt = new Date().toISOString();
    game.message = message;
  }

  async function finishByFold(client, game, winner) {
    game.revealHands = false;
    await creditWinners(
      client,
      game,
      [winner],
      winner.label + " забирает банк: все остальные игроки сбросили карты."
    );
  }

  async function finishByShowdown(client, game, openerLabel = "") {
    game.revealHands = true;
    const active = activeSekaPlayers(game);
    if (!active.length) throw new SekaHttpError(500, "В партии не осталось игроков");
    let winners = [active[0]];
    for (const player of game.players) {
      const score = scoreSekaHand(player.hand);
      player.score = score.score;
      player.handType = score.label;
    }
    for (const player of active.slice(1)) {
      const compared = compareSekaHands(player.hand, winners[0].hand);
      if (compared > 0) winners = [player];
      else if (compared === 0) winners.push(player);
    }
    const winningScore = scoreSekaHand(winners[0].hand).score;
    const names = winners.map(player => player.label).join(", ");
    const prefix = openerLabel ? openerLabel + " вскрыл карты. " : "Карты вскрыты. ";
    await creditWinners(
      client,
      game,
      winners,
      prefix + "Победитель: " + names + " (" + winningScore + " очков). Банк: " + Number(game.pot).toLocaleString("ru-RU") + " AC."
    );
  }

  async function advanceOrFinish(client, game, actorIndex) {
    const active = activeSekaPlayers(game);
    if (active.length === 1) {
      await finishByFold(client, game, active[0]);
      return;
    }
    if (allActiveSekaPlayersMatched(game)) {
      await finishByShowdown(client, game);
      return;
    }
    const nextIndex = nextSekaTurnIndex(game, actorIndex);
    if (nextIndex < 0) throw new SekaHttpError(500, "Не удалось определить следующий ход");
    game.currentPlayerIndex = nextIndex;
    game.currentPlayerTelegramId = game.players[nextIndex].telegramId;
    game.message = "Ходит " + game.players[nextIndex].label + ". Банк: " + Number(game.pot).toLocaleString("ru-RU") + " AC.";
  }

  async function runSekaBots(client, room, game) {
    let steps = 0;
    while (game && game.status === "playing" && steps < 24) {
      const actorIndex = game.players.findIndex(player =>
        String(player.telegramId) === String(game.currentPlayerTelegramId)
      );
      const actor = game.players[actorIndex];
      if (!actor || !(actor.isBot || String(actor.telegramId) === SEKA_BOT_ID)) return;

      const active = activeSekaPlayers(game);
      if (active.length <= 1) {
        if (active.length === 1) await finishByFold(client, game, active[0]);
        return;
      }
      const currentBet = Number(game.currentBet || 0);
      const due = Math.max(0, currentBet - Number(actor.contribution || 0));
      const score = scoreSekaHand(actor.hand);
      const raiseAmount = Math.max(Number(room.min_bet) || 100, Number(room.ante) || 100);
      const targetBet = currentBet + raiseAmount;
      const canRaise = Number.isSafeInteger(targetBet) &&
        (room.max_bet == null || targetBet <= Number(room.max_bet));
      let action = "call";

      if (active.length <= 2 && (score.type >= 3 || score.score >= 21 || due === 0)) {
        action = "open";
      } else if (canRaise && (score.type >= 3 || score.score >= 28) && Math.random() < 0.45) {
        action = "raise";
      } else if (due > 0 && score.score < 13 && currentBet >= Number(room.ante) * 2) {
        action = "fold";
      }

      if (action === "fold") {
        actor.folded = true;
        actor.acted = true;
        const stillActive = activeSekaPlayers(game);
        if (stillActive.length === 1) {
          await finishByFold(client, game, stillActive[0]);
        } else {
          await advanceOrFinish(client, game, actorIndex);
          game.message = SEKA_BOT_LABEL + " сбросил карты. " + game.message;
        }
      } else if (action === "raise") {
        actor.contribution = targetBet;
        actor.acted = true;
        game.currentBet = targetBet;
        for (const player of game.players) {
          if (!player.folded) player.acted = String(player.telegramId) === String(actor.telegramId);
        }
        await advanceOrFinish(client, game, actorIndex);
        if (game.status === "playing") game.message = SEKA_BOT_LABEL + " повысил ставку до " +
          targetBet.toLocaleString("ru-RU") + " AC. " + game.message;
      } else if (action === "open") {
        actor.contribution = currentBet;
        actor.acted = true;
        await finishByShowdown(client, game, actor.label);
      } else {
        // The bot tracks the current bet, but does not deduct or add virtual AC to the pot.
        actor.contribution = currentBet;
        actor.acted = true;
        await advanceOrFinish(client, game, actorIndex);
        if (game.status === "playing") game.message = SEKA_BOT_LABEL + " поддержал ставку. " + game.message;
      }
      steps++;
    }
    if (steps >= 24 && game.status === "playing" &&
        String(game.currentPlayerTelegramId) === SEKA_BOT_ID) {
      const bot = game.players.find(player => String(player.telegramId) === SEKA_BOT_ID);
      if (bot && !bot.folded) {
        bot.folded = true;
        bot.acted = true;
        const remaining = activeSekaPlayers(game);
        if (remaining.length === 1) await finishByFold(client, game, remaining[0]);
        else await advanceOrFinish(client, game, game.players.indexOf(bot));
      }
    }
  }

  function publicGame(game, userId) {
    if (!game) return null;
    const revealed = game.status === "finished" && game.revealHands === true;
    return {
      status: game.status,
      testMode: Boolean(game.testMode),
      pot: Number(game.pot || 0),
      ante: Number(game.ante || 0),
      currentBet: Number(game.currentBet || 0),
      currentPlayerTelegramId: game.currentPlayerTelegramId == null ? null : String(game.currentPlayerTelegramId),
      isYourTurn: String(game.currentPlayerTelegramId || "") === String(userId),
      winnerTelegramIds: game.winnerTelegramIds || [],
      payouts: game.payouts || [],
      message: String(game.message || ""),
      settlementApplied: Boolean(game.settlementApplied),
      revealHands: revealed,
      rematchVotes: Array.isArray(game.rematchVotes) ? game.rematchVotes.map(String) : [],
      roundNumber: Math.max(1, Number(game.roundNumber) || 1),
      players: (game.players || []).map(player => {
        const showHand = revealed || String(player.telegramId) === String(userId);
        return {
          telegramId: String(player.telegramId),
          label: String(player.label || "Игрок"),
          isBot: Boolean(player.isBot || String(player.telegramId) === SEKA_BOT_ID),
          seatNo: Number(player.seatNo || 0),
          folded: Boolean(player.folded),
          contribution: Number(player.contribution || 0),
          acted: Boolean(player.acted),
          cardCount: Array.isArray(player.hand) ? player.hand.length : 3,
          hand: showHand ? (player.hand || []) : [],
          score: revealed ? player.score : null,
          handType: revealed ? player.handType : null,
          payout: revealed ? Number(player.payout || 0) : 0
        };
      })
    };
  }

  router.initialize = async function initializeSekaTables() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS seka_rooms (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL,
        owner_telegram_id BIGINT NOT NULL,
        limit_tier SMALLINT NOT NULL CHECK (limit_tier BETWEEN 1 AND 5),
        min_bet BIGINT NOT NULL CHECK (min_bet >= 100),
        max_bet BIGINT NULL,
        ante BIGINT NOT NULL CHECK (ante >= 100),
        max_players INTEGER NOT NULL DEFAULT 6 CHECK (max_players BETWEEN 2 AND 6),
        status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS seka_room_players (
        room_id BIGINT NOT NULL REFERENCES seka_rooms(id) ON DELETE CASCADE,
        telegram_id BIGINT NOT NULL REFERENCES players(telegram_id) ON DELETE CASCADE,
        display_name TEXT NOT NULL DEFAULT 'Игрок',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (room_id, telegram_id)
      )`
    );
    await pool.query(
      `INSERT INTO players (telegram_id, balance, energy)
       VALUES ($1, 0, 0)
       ON CONFLICT (telegram_id) DO NOTHING`,
      [SEKA_BOT_ID]
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS seka_games (
        room_id BIGINT PRIMARY KEY REFERENCES seka_rooms(id) ON DELETE CASCADE,
        game_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await pool.query("CREATE INDEX IF NOT EXISTS seka_rooms_waiting_idx ON seka_rooms (status, created_at DESC)");
  };

  router.post("/rooms/list", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    try {
      const tier = req.body?.tier == null || req.body?.tier === "" || req.body?.tier === "all"
        ? null : Number(req.body.tier);
      if (tier !== null && (!Number.isInteger(tier) || !SEKA_LIMITS[tier])) {
        return res.status(400).json({ ok: false, error: "Выбери один из пяти уровней ставок" });
      }
      await pool.query("DELETE FROM seka_rooms WHERE status = 'waiting' AND created_at < NOW() - INTERVAL '45 minutes'");
      const result = await pool.query(
        `SELECT r.id, r.name, r.owner_telegram_id, r.limit_tier, r.min_bet, r.max_bet, r.ante, r.max_players, r.status,
                COUNT(rp.telegram_id)::INTEGER AS players_count
         FROM seka_rooms r
         LEFT JOIN seka_room_players rp ON rp.room_id = r.id
         WHERE r.status = 'waiting'
           AND NOT EXISTS (
             SELECT 1 FROM seka_room_players sb
             WHERE sb.room_id = r.id AND sb.telegram_id = 0
           )
           AND ($1::INTEGER IS NULL OR r.limit_tier = $1)
         GROUP BY r.id
         ORDER BY r.created_at DESC
         LIMIT 50`,
        [tier]
      );
      return res.json({ ok: true, rooms: result.rows.map(row => mapRoom(row, user.id)) });
    } catch (error) {
      console.error("List Seka rooms error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить комнаты Сека" });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    let client;
    let transactionOpen = false;
    try {
      const name = String(req.body?.name || "").trim().slice(0, 30) || "Комната Сека";
      const tier = Number(req.body?.tier);
      const limit = SEKA_LIMITS[tier];
      if (!limit) return res.status(400).json({ ok: false, error: "Выбери уровень лимита комнаты" });
      const ante = safeAmount(req.body?.stake);
      if (ante === null || ante < limit.min || (limit.max !== null && ante > limit.max)) {
        return res.status(400).json({ ok: false, error: "Начальная ставка должна быть в пределах выбранного лимита: " + limit.label });
      }
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      // Room creation itself does not deduct AC. Real-money-free bot practice can use any tier;
      // normal multiplayer games still validate everyone's balance when the round starts.
      await ensurePlayer(client, user);
      const inserted = await client.query(
        `INSERT INTO seka_rooms (name, owner_telegram_id, limit_tier, min_bet, max_bet, ante, max_players, status)
         VALUES ($1, $2, $3, $4, $5, $6, 6, 'waiting')
         RETURNING id, name, owner_telegram_id, limit_tier, min_bet, max_bet, ante, max_players, status`,
        [name, String(user.id), tier, limit.min, limit.max, ante]
      );
      const room = inserted.rows[0];
      await client.query(
        "INSERT INTO seka_room_players (room_id, telegram_id, display_name) VALUES ($1, $2, $3)",
        [room.id, String(user.id), user.first_name || user.username || "Игрок"]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, room: mapRoom({ ...room, players_count: 1 }, user.id) });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      const status = error.statusCode || 500;
      if (status === 500) console.error("Create Seka room error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось создать комнату Сека" });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/add-bot", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    let client;
    let transactionOpen = false;
    try {
      const roomId = req.body?.roomId;
      if (!roomId || !/^\d+$/.test(String(roomId))) throw new SekaHttpError(400, "Неверный номер комнаты");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomRow(client, roomId, true);
      if (!room) throw new SekaHttpError(404, "Комната не найдена");
      if (String(room.owner_telegram_id) !== String(user.id)) {
        throw new SekaHttpError(403, "Добавить бота может только создатель комнаты");
      }
      if (room.status !== "waiting") throw new SekaHttpError(400, "Игра уже началась");
      const existing = await client.query(
        "SELECT 1 FROM seka_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, SEKA_BOT_ID]
      );
      if (!existing.rows.length) {
        const count = await getRoomCounts(client, roomId);
        if (count !== 1) throw new SekaHttpError(400, "Бота для проверки можно добавить, пока в комнате только вы.");
        if (count >= Number(room.max_players)) throw new SekaHttpError(400, "В комнате нет свободных мест для бота");
        await client.query(
          "INSERT INTO seka_room_players (room_id, telegram_id, display_name) VALUES ($1, $2, $3)",
          [roomId, SEKA_BOT_ID, SEKA_BOT_LABEL]
        );
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, roomId: String(roomId), botAdded: true, label: SEKA_BOT_LABEL });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      const status = error.statusCode || 500;
      if (status === 500) console.error("Add Seka test bot error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось добавить бота для проверки" });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/join", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    let client;
    let transactionOpen = false;
    try {
      const roomId = req.body?.roomId;
      if (!roomId || !/^\d+$/.test(String(roomId))) throw new SekaHttpError(400, "Неверный номер комнаты");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomRow(client, roomId, true);
      if (!room) throw new SekaHttpError(404, "Комната не найдена");
      if (room.status !== "waiting") throw new SekaHttpError(400, "Партия уже началась. Выбери другую комнату.");
      const testBot = await client.query(
        "SELECT 1 FROM seka_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, SEKA_BOT_ID]
      );
      if (testBot.rows.length) throw new SekaHttpError(400, "Эта комната предназначена для проверки с ботом и не принимает других игроков.");
      const existing = await client.query(
        "SELECT 1 FROM seka_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, String(user.id)]
      );
      if (!existing.rows.length) {
        const count = await getRoomCounts(client, roomId);
        if (count >= Number(room.max_players)) throw new SekaHttpError(400, "Комната заполнена");
        const balance = await ensurePlayer(client, user);
        if (balance < Number(room.ante)) throw new SekaHttpError(400, "Недостаточно AC для входа в комнату с такой начальной ставкой.");
        await client.query(
          "INSERT INTO seka_room_players (room_id, telegram_id, display_name) VALUES ($1, $2, $3)",
          [roomId, String(user.id), user.first_name || user.username || "Игрок"]
        );
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, roomId: String(roomId) });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      const status = error.statusCode || 500;
      if (status === 500) console.error("Join Seka room error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось войти в комнату Сека" });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/leave", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    let client;
    let transactionOpen = false;
    try {
      const roomId = req.body?.roomId;
      if (!roomId || !/^\d+$/.test(String(roomId))) throw new SekaHttpError(400, "Неверный номер комнаты");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomRow(client, roomId, true);
      if (!room) throw new SekaHttpError(404, "Комната не найдена");
      if (room.status === "playing") throw new SekaHttpError(400, "Из активной партии пока нельзя выйти. Дождись завершения раунда.");
      const isOwner = String(room.owner_telegram_id) === String(user.id);
      const member = await client.query(
        "SELECT 1 FROM seka_room_players WHERE room_id = $1 AND telegram_id = $2 FOR UPDATE",
        [roomId, String(user.id)]
      );
      if (!member.rows.length) throw new SekaHttpError(403, "Ты не состоишь в этой комнате");
      if (isOwner) {
        await client.query("DELETE FROM seka_rooms WHERE id = $1", [roomId]);
      } else {
        await client.query("DELETE FROM seka_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, String(user.id)]);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, ownerLeft: isOwner });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      const status = error.statusCode || 500;
      if (status === 500) console.error("Leave Seka room error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось выйти из комнаты Сека" });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/start", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    let client;
    let transactionOpen = false;
    try {
      const roomId = req.body?.roomId;
      if (!roomId || !/^\d+$/.test(String(roomId))) throw new SekaHttpError(400, "Неверный номер комнаты");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomRow(client, roomId, true);
      if (!room) throw new SekaHttpError(404, "Комната не найдена");
      if (String(room.owner_telegram_id) !== String(user.id)) throw new SekaHttpError(403, "Начать игру может только создатель комнаты");
      if (room.status !== "waiting") throw new SekaHttpError(400, "Эта комната уже запускалась");
      const membersResult = await client.query(
        `SELECT rp.telegram_id, rp.display_name, pl.balance
         FROM seka_room_players rp
         JOIN players pl ON pl.telegram_id = rp.telegram_id
         WHERE rp.room_id = $1
         ORDER BY rp.joined_at ASC
         FOR UPDATE OF rp, pl`,
        [roomId]
      );
      const members = membersResult.rows;
      if (members.length < 2) throw new SekaHttpError(400, "Для начала партии нужны минимум два игрока");
      if (members.length > Number(room.max_players)) throw new SekaHttpError(400, "В комнате слишком много игроков");
      const testMode = members.some(member => String(member.telegram_id) === SEKA_BOT_ID);
      if (!testMode) {
        for (const member of members) {
          if (Number(member.balance) < Number(room.ante)) {
            throw new SekaHttpError(400, "У игрока " + String(member.display_name || "Игрок") + " недостаточно AC. Он должен выйти или пополнить баланс.");
          }
        }
        for (const member of members) await chargePlayer(client, member.telegram_id, Number(room.ante));
      }
      const game = createSekaGame(members.map(member => ({
        telegramId: String(member.telegram_id),
        label: String(member.display_name || "Игрок"),
        isBot: String(member.telegram_id) === SEKA_BOT_ID
      })), Number(room.ante));
      game.testMode = testMode;
      if (testMode) game.pot = Number(room.ante) * game.players.length;
      await runSekaBots(client, room, game);
      await client.query(
        `INSERT INTO seka_games (room_id, game_state) VALUES ($1, $2::jsonb)
         ON CONFLICT (room_id) DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = NOW()`,
        [roomId, JSON.stringify(game)]
      );
      await client.query("UPDATE seka_rooms SET status = 'playing' WHERE id = $1", [roomId]);
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, roomId: String(roomId), started: true });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      const status = error.statusCode || 500;
      if (status === 500) console.error("Start Seka room error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось начать игру Сека" });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/rematch", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    let client;
    let transactionOpen = false;
    try {
      const roomId = req.body?.roomId;
      if (!roomId || !/^\d+$/.test(String(roomId))) {
        throw new SekaHttpError(400, "Неверный номер комнаты");
      }
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;

      const room = await getRoomRow(client, roomId, true);
      if (!room) throw new SekaHttpError(404, "Комната не найдена");
      if (room.status !== "finished") {
        throw new SekaHttpError(409, "Рематч доступен после завершения партии");
      }

      const gameResult = await client.query(
        "SELECT game_state FROM seka_games WHERE room_id = $1 FOR UPDATE",
        [roomId]
      );
      if (!gameResult.rows.length || !gameResult.rows[0].game_state) {
        throw new SekaHttpError(404, "Не найдены результаты завершённой партии");
      }
      const previousGame = gameResult.rows[0].game_state;
      if (previousGame.status !== "finished") {
        throw new SekaHttpError(409, "Предыдущая партия ещё не завершена");
      }

      const membersResult = await client.query(
        `SELECT rp.telegram_id, rp.display_name, pl.balance
         FROM seka_room_players rp
         JOIN players pl ON pl.telegram_id = rp.telegram_id
         WHERE rp.room_id = $1
         ORDER BY rp.joined_at ASC
         FOR UPDATE OF rp, pl`,
        [roomId]
      );
      const members = membersResult.rows;
      if (!members.some(member => String(member.telegram_id) === String(user.id))) {
        throw new SekaHttpError(403, "Ты не состоишь в этой комнате");
      }
      if (members.length < 2) {
        throw new SekaHttpError(400, "Для рематча нужны минимум два игрока в комнате");
      }
      if (members.length > Number(room.max_players)) {
        throw new SekaHttpError(400, "В комнате слишком много игроков");
      }

      const eligibleIds = members
        .filter(member => String(member.telegram_id) !== SEKA_BOT_ID)
        .map(member => String(member.telegram_id));
      if (!eligibleIds.length) throw new SekaHttpError(400, "Для рематча нужен хотя бы один реальный игрок");
      const validOldVotes = Array.isArray(previousGame.rematchVotes)
        ? previousGame.rematchVotes.map(String).filter(id => eligibleIds.includes(id))
        : [];
      const votes = [...new Set([...validOldVotes, String(user.id)])];
      const everyoneReady = eligibleIds.every(id => votes.includes(id));

      if (!everyoneReady) {
        previousGame.rematchVotes = votes;
        await client.query(
          "UPDATE seka_games SET game_state = $2::jsonb, updated_at = NOW() WHERE room_id = $1",
          [roomId, JSON.stringify(previousGame)]
        );
        await client.query("COMMIT");
        transactionOpen = false;
        return res.json({
          ok: true,
          started: false,
          readyCount: votes.length,
          totalPlayers: eligibleIds.length,
          message: "Готовность к рематчу сохранена. Ждём остальных игроков."
        });
      }

      const testMode = Boolean(previousGame.testMode) ||
        members.some(member => String(member.telegram_id) === SEKA_BOT_ID);
      if (!testMode) {
        for (const member of members) {
          if (Number(member.balance) < Number(room.ante)) {
            throw new SekaHttpError(
              400,
              "У игрока " + String(member.display_name || "Игрок") +
              " недостаточно AC для новой партии. Взнос: " +
              Number(room.ante).toLocaleString("ru-RU") + " AC."
            );
          }
        }
        for (const member of members) {
          await chargePlayer(client, member.telegram_id, Number(room.ante));
        }
      }

      const nextGame = createSekaGame(members.map(member => ({
        telegramId: String(member.telegram_id),
        label: String(member.display_name || "Игрок"),
        isBot: String(member.telegram_id) === SEKA_BOT_ID
      })), Number(room.ante));
      nextGame.testMode = testMode;
      nextGame.roundNumber = Math.max(1, Number(previousGame.roundNumber) || 1) + 1;
      if (testMode) nextGame.pot = Number(room.ante) * nextGame.players.length;

      await runSekaBots(client, room, nextGame);
      await client.query(
        "UPDATE seka_games SET game_state = $2::jsonb, updated_at = NOW() WHERE room_id = $1",
        [roomId, JSON.stringify(nextGame)]
      );
      await client.query("UPDATE seka_rooms SET status = 'playing' WHERE id = $1", [roomId]);
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({
        ok: true,
        started: true,
        roomId: String(roomId),
        roundNumber: nextGame.roundNumber,
        message: "Рематч начался! Карты розданы заново."
      });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      const status = error.statusCode || 500;
      if (status === 500) console.error("Seka rematch error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось начать рематч в Секе" });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/state", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    try {
      const roomId = req.body?.roomId;
      if (!roomId || !/^\d+$/.test(String(roomId))) throw new SekaHttpError(400, "Неверный номер комнаты");
      const roomResult = await pool.query(
        `SELECT r.id, r.name, r.owner_telegram_id, r.limit_tier, r.min_bet, r.max_bet, r.ante, r.max_players, r.status,
                COUNT(rp.telegram_id)::INTEGER AS players_count
         FROM seka_rooms r
         LEFT JOIN seka_room_players rp ON rp.room_id = r.id
         WHERE r.id = $1
         GROUP BY r.id`,
        [roomId]
      );
      if (!roomResult.rows.length) throw new SekaHttpError(404, "Комната уже закрыта или не найдена");
      const roomRow = roomResult.rows[0];
      const membership = await pool.query(
        "SELECT 1 FROM seka_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, String(user.id)]
      );
      if (!membership.rows.length) throw new SekaHttpError(403, "Ты не состоишь в этой комнате");
      const playersResult = await pool.query(
        `SELECT rp.telegram_id, rp.display_name, rp.joined_at, pl.balance
         FROM seka_room_players rp
         JOIN players pl ON pl.telegram_id = rp.telegram_id
         WHERE rp.room_id = $1
         ORDER BY rp.joined_at ASC`,
        [roomId]
      );
      const gameResult = await pool.query("SELECT game_state FROM seka_games WHERE room_id = $1", [roomId]);
      const ownProfile = await pool.query("SELECT balance FROM players WHERE telegram_id = $1", [String(user.id)]);
      const game = gameResult.rows[0]?.game_state || null;
      return res.json({
        ok: true,
        room: mapRoom(roomRow, user.id),
        players: playersResult.rows.map((row, index) => ({
          telegramId: String(row.telegram_id),
          label: String(row.display_name || "Игрок"),
          seatNo: index,
          balance: Number(row.balance),
          joinedAt: row.joined_at
        })),
        game: publicGame(game, user.id),
        balance: Number(ownProfile.rows[0]?.balance || 0)
      });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status === 500) console.error("Seka room state error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось обновить партию Сека" });
    }
  });

  router.post("/rooms/action", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    let client;
    let transactionOpen = false;
    try {
      const roomId = req.body?.roomId;
      if (!roomId || !/^\d+$/.test(String(roomId))) throw new SekaHttpError(400, "Неверный номер комнаты");
      const action = String(req.body?.action || "");
      if (!["fold", "call", "raise", "open"].includes(action)) throw new SekaHttpError(400, "Неизвестное действие");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomRow(client, roomId, true);
      if (!room) throw new SekaHttpError(404, "Комната не найдена");
      if (room.status !== "playing") throw new SekaHttpError(409, "Партия уже завершена");
      const gameResult = await client.query("SELECT game_state FROM seka_games WHERE room_id = $1 FOR UPDATE", [roomId]);
      if (!gameResult.rows.length) throw new SekaHttpError(404, "Данные партии не найдены");
      const game = gameResult.rows[0].game_state;
      if (!game || game.status !== "playing") throw new SekaHttpError(409, "Партия уже завершена");
      const actorIndex = game.players.findIndex(player => String(player.telegramId) === String(user.id));
      if (actorIndex < 0) throw new SekaHttpError(403, "Ты не состоишь в этой партии");
      if (String(game.currentPlayerTelegramId) !== String(user.id)) throw new SekaHttpError(409, "Сейчас ход другого игрока");
      const actor = game.players[actorIndex];
      if (actor.folded) throw new SekaHttpError(409, "Ты уже сбросил карты");
      const liveCount = activeSekaPlayers(game).length;
      const currentBet = Number(game.currentBet);

      if (action === "fold") {
        actor.folded = true;
        actor.acted = true;
        const active = activeSekaPlayers(game);
        if (active.length === 1) {
          await finishByFold(client, game, active[0]);
        } else {
          await advanceOrFinish(client, game, actorIndex);
          game.message = actor.label + " сбросил карты. " + game.message;
        }
      } else if (action === "call") {
        const due = Math.max(0, currentBet - Number(actor.contribution || 0));
        if (!game.testMode) await chargePlayer(client, actor.telegramId, due);
        actor.contribution = currentBet;
        actor.acted = true;
        game.pot = Number(game.pot) + due;
        await advanceOrFinish(client, game, actorIndex);
      } else if (action === "raise") {
        const raiseAmount = safeAmount(req.body?.amount);
        if (raiseAmount === null || raiseAmount < Number(room.min_bet)) {
          throw new SekaHttpError(400, "Повышение должно быть не меньше " + Number(room.min_bet).toLocaleString("ru-RU") + " AC");
        }
        const targetBet = currentBet + raiseAmount;
        if (!Number.isSafeInteger(targetBet)) throw new SekaHttpError(400, "Слишком большая ставка");
        if (room.max_bet != null && targetBet > Number(room.max_bet)) {
          throw new SekaHttpError(400, "В этой комнате максимальная ставка — " + Number(room.max_bet).toLocaleString("ru-RU") + " AC");
        }
        const due = Math.max(0, targetBet - Number(actor.contribution || 0));
        if (!game.testMode) await chargePlayer(client, actor.telegramId, due);
        game.pot = Number(game.pot) + due;
        game.currentBet = targetBet;
        actor.contribution = targetBet;
        for (const player of game.players) {
          if (!player.folded) player.acted = String(player.telegramId) === String(actor.telegramId);
        }
        await advanceOrFinish(client, game, actorIndex);
        game.message = actor.label + " повысил ставку до " + targetBet.toLocaleString("ru-RU") + " AC. " + game.message;
      } else if (action === "open") {
        if (liveCount > 2) throw new SekaHttpError(400, "Вскрыться можно, когда в игре осталось два игрока");
        const due = Math.max(0, currentBet - Number(actor.contribution || 0));
        if (!game.testMode) await chargePlayer(client, actor.telegramId, due);
        actor.contribution = currentBet;
        actor.acted = true;
        game.pot = Number(game.pot) + due;
        await finishByShowdown(client, game, actor.label);
      }

      await runSekaBots(client, room, game);
      await client.query(
        "UPDATE seka_games SET game_state = $2::jsonb, updated_at = NOW() WHERE room_id = $1",
        [roomId, JSON.stringify(game)]
      );
      if (game.status === "finished") await client.query("UPDATE seka_rooms SET status = 'finished' WHERE id = $1", [roomId]);
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, status: game.status, message: game.message });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      const status = error.statusCode || 500;
      if (status === 500) console.error("Seka action error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось выполнить действие в Секе" });
    } finally {
      client?.release();
    }
  });

  return router;
}

export const SEKA_BET_LIMITS = SEKA_LIMITS;
