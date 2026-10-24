import express from "express";
import { isRpsChoice, resolveRpsRound } from "./rps-rules.js";

const MAX_PLAYERS = 3;
const MIN_STAKE = 100;
const RPS_BOT_ID = "0";
const RPS_BOT_NAME = "🤖 Бот проверки";
const CHOICE_LABELS = Object.freeze({ rock: "Камень", paper: "Бумага", scissors: "Ножницы" });
const CHOICE_SYMBOLS = Object.freeze({ rock: "✊", paper: "✋", scissors: "✌️" });

class RpsHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseStake(value) {
  if (value === "" || value === null || value === undefined) return null;
  const stake = Number(value);
  return Number.isSafeInteger(stake) && stake >= MIN_STAKE ? stake : null;
}

function parseRoomId(value) {
  const id = String(value ?? "");
  return /^\d+$/.test(id) ? id : null;
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {}
  }
  return {};
}

function randomRpsChoice() {
  const choices = ["rock", "paper", "scissors"];
  return choices[Math.floor(Math.random() * choices.length)];
}

function cleanName(user) {
  const name = String(user?.first_name || user?.username || "Игрок").trim().slice(0, 48);
  return name || "Игрок";
}

function httpError(res, error) {
  if (error instanceof RpsHttpError) {
    return res.status(error.statusCode).json({ ok: false, error: error.message });
  }
  console.error("Rock Paper Scissors API error:", error?.stack || error?.message || error);
  return res.status(500).json({ ok: false, error: "Ошибка сервера игры. Попробуй ещё раз." });
}

export function createRpsRouter({ pool, verifyTelegram }) {
  const router = express.Router();
  let schemaPromise = null;

  function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await pool.query(
          "CREATE TABLE IF NOT EXISTS rps_rooms (" +
          "id BIGSERIAL PRIMARY KEY, " +
          "name TEXT NOT NULL DEFAULT 'Комната КНБ', " +
          "owner_telegram_id TEXT NOT NULL, " +
          "stake BIGINT NOT NULL CHECK (stake >= 100), " +
          "max_players SMALLINT NOT NULL DEFAULT 3 CHECK (max_players = 3), " +
          "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing')), " +
          "current_round INTEGER NOT NULL DEFAULT 1, " +
          "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
          "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" +
          ")"
        );
        await pool.query(
          "CREATE TABLE IF NOT EXISTS rps_room_players (" +
          "room_id BIGINT NOT NULL REFERENCES rps_rooms(id) ON DELETE CASCADE, " +
          "telegram_id TEXT NOT NULL, " +
          "display_name TEXT NOT NULL DEFAULT 'Игрок', " +
          "joined_round INTEGER NOT NULL DEFAULT 1, " +
          "joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
          "PRIMARY KEY (room_id, telegram_id)" +
          ")"
        );
        await pool.query(
          "CREATE TABLE IF NOT EXISTS rps_room_rounds (" +
          "room_id BIGINT NOT NULL REFERENCES rps_rooms(id) ON DELETE CASCADE, " +
          "round_number INTEGER NOT NULL, " +
          "participants TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], " +
          "choices JSONB NOT NULL DEFAULT '{}'::JSONB, " +
          "status TEXT NOT NULL DEFAULT 'playing' CHECK (status IN ('playing','finished')), " +
          "result JSONB, " +
          "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
          "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
          "finished_at TIMESTAMPTZ, " +
          "PRIMARY KEY (room_id, round_number)" +
          ")"
        );
        await pool.query(
          "CREATE INDEX IF NOT EXISTS rps_rooms_status_updated_idx ON rps_rooms(status, updated_at DESC)"
        );
      })().catch(error => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  }

  function authenticatedUser(req, res) {
    const user = verifyTelegram(req.body?.initData);
    if (!user?.id) {
      res.status(401).json({
        ok: false,
        error: "Не удалось проверить Telegram. Открой игру через ALLCOINS."
      });
      return null;
    }
    return user;
  }

  async function ensurePlayer(client, user) {
    const result = await client.query(
      "INSERT INTO players (telegram_id) VALUES ($1) " +
      "ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() " +
      "RETURNING balance",
      [String(user.id)]
    );
    return Number(result.rows[0]?.balance || 0);
  }

  async function getRoomOrThrow(client, roomId, lock = false) {
    const result = await client.query(
      "SELECT id, name, owner_telegram_id, stake, max_players, status, current_round, created_at " +
      "FROM rps_rooms WHERE id = $1" + (lock ? " FOR UPDATE" : ""),
      [roomId]
    );
    if (!result.rows.length) throw new RpsHttpError(404, "Комната не найдена или уже закрыта.");
    return result.rows[0];
  }

  async function ensureCurrentRound(client, roomId, roundNumber, participantIds) {
    await client.query(
      "INSERT INTO rps_room_rounds (room_id, round_number, participants, choices, status) " +
      "VALUES ($1, $2, $3::TEXT[], '{}'::JSONB, 'playing') " +
      "ON CONFLICT (room_id, round_number) DO UPDATE SET " +
      "participants = EXCLUDED.participants, choices = '{}'::JSONB, status = 'playing', " +
      "result = NULL, updated_at = NOW(), finished_at = NULL",
      [roomId, roundNumber, participantIds]
    );
  }

  async function currentMembers(client, roomId) {
    const result = await client.query(
      "SELECT telegram_id, display_name, joined_round, joined_at " +
      "FROM rps_room_players WHERE room_id = $1 ORDER BY joined_at, telegram_id",
      [roomId]
    );
    return result.rows;
  }

  async function buildState(client, room, user, balance) {
    const currentRoundQuery = await client.query(
      "SELECT round_number, participants, choices, status, updated_at " +
      "FROM rps_room_rounds WHERE room_id = $1 AND round_number = $2",
      [room.id, Number(room.current_round)]
    );
    const currentRound = currentRoundQuery.rows[0] || null;
    let choices = jsonObject(currentRound?.choices);

    // If somebody disappears after choosing, unlock the round after 90 seconds.
    if (
      currentRound &&
      currentRound.status === "playing" &&
      Object.keys(choices).length > 0 &&
      Date.now() - new Date(currentRound.updated_at).getTime() > 90000
    ) {
      await client.query(
        "UPDATE rps_room_rounds SET choices = '{}'::JSONB, updated_at = NOW() " +
        "WHERE room_id = $1 AND round_number = $2 AND status = 'playing'",
        [room.id, Number(room.current_round)]
      );
      choices = {};
    }

    const members = await currentMembers(client, room.id);
    const participantIds = (currentRound?.participants || []).map(String);
    const submittedIds = Object.keys(choices);
    const players = members.map(player => ({
      telegramId: String(player.telegram_id),
      displayName: String(player.display_name || "Игрок"),
      joinedRound: Number(player.joined_round),
      isMe: String(player.telegram_id) === String(user.id),
      isBot: String(player.telegram_id) === RPS_BOT_ID,
      isOwner: String(player.telegram_id) === String(room.owner_telegram_id),
      inCurrentRound: participantIds.includes(String(player.telegram_id)),
      waitingNextRound: Number(player.joined_round) > Number(room.current_round),
      hasSubmitted: submittedIds.includes(String(player.telegram_id))
    }));

    const lastResultQuery = await client.query(
      "SELECT result FROM rps_room_rounds " +
      "WHERE room_id = $1 AND status = 'finished' AND round_number < $2 " +
      "ORDER BY round_number DESC LIMIT 1",
      [room.id, Number(room.current_round)]
    );
    const lastResult = lastResultQuery.rows[0]?.result || null;

    return {
      ok: true,
      balance,
      room: {
        id: String(room.id),
        name: String(room.name || "Комната КНБ"),
        ownerTelegramId: String(room.owner_telegram_id),
        stake: Number(room.stake),
        maxPlayers: Number(room.max_players || MAX_PLAYERS),
        status: String(room.status),
        currentRound: Number(room.current_round),
        playersCount: players.length,
        isOwner: String(room.owner_telegram_id) === String(user.id),
        hasBot: members.some(player => String(player.telegram_id) === RPS_BOT_ID),
        testMode: members.some(player => String(player.telegram_id) === RPS_BOT_ID),
        players
      },
      round: currentRound ? {
        number: Number(currentRound.round_number),
        status: String(currentRound.status),
        participantIds,
        submittedIds,
        submittedCount: submittedIds.length,
        submittedByMe: submittedIds.includes(String(user.id)),
        canChoose: currentRound.status === "playing" &&
          participantIds.includes(String(user.id)) &&
          !submittedIds.includes(String(user.id))
      } : null,
      lastResult
    };
  }

  router.post("/rooms/list", async (req, res) => {
    try {
      await ensureSchema();
      const user = authenticatedUser(req, res);
      if (!user) return;
      const balance = await ensurePlayer(pool, user);
      const result = await pool.query(
        "SELECT r.id, r.name, r.stake, r.status, r.current_round, r.owner_telegram_id, " +
        "COUNT(p.telegram_id)::INTEGER AS players_count, " +
        "COALESCE(BOOL_OR(p.telegram_id = $1), FALSE) AS is_member " +
        "FROM rps_rooms r LEFT JOIN rps_room_players p ON p.room_id = r.id " +
        "WHERE r.status IN ('waiting','playing') AND r.created_at > NOW() - INTERVAL '24 hours' " +
        "GROUP BY r.id " +
        "HAVING COUNT(p.telegram_id) < 3 OR COALESCE(BOOL_OR(p.telegram_id = $1), FALSE) " +
        "ORDER BY r.updated_at DESC LIMIT 100",
        [String(user.id)]
      );
      return res.json({
        ok: true,
        balance,
        rooms: result.rows.map(room => ({
          id: String(room.id),
          name: String(room.name || "Комната КНБ"),
          stake: Number(room.stake),
          status: String(room.status),
          currentRound: Number(room.current_round),
          playersCount: Number(room.players_count || 0),
          maxPlayers: MAX_PLAYERS,
          isMember: Boolean(room.is_member),
          isOwner: String(room.owner_telegram_id) === String(user.id)
        }))
      });
    } catch (error) {
      return httpError(res, error);
    }
  });

  router.post("/rooms/create", async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
      await ensureSchema();
      const user = authenticatedUser(req, res);
      if (!user) return;
      const stake = parseStake(req.body?.stake);
      if (stake === null) throw new RpsHttpError(400, "Ставка должна быть целым числом не меньше 100 AC. Верхнего лимита у поля нет.");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      await ensurePlayer(client, user);
      const roomResult = await client.query(
        "INSERT INTO rps_rooms (name, owner_telegram_id, stake, max_players, status, current_round) " +
        "VALUES ('Комната КНБ', $1, $2, 3, 'waiting', 1) RETURNING id",
        [String(user.id), stake]
      );
      const roomId = String(roomResult.rows[0].id);
      await client.query(
        "INSERT INTO rps_room_players (room_id, telegram_id, display_name, joined_round) " +
        "VALUES ($1, $2, $3, 1)",
        [roomId, String(user.id), cleanName(user)]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, roomId, message: "Комната создана. Ждём второго игрока." });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      return httpError(res, error);
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/add-bot", async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
      await ensureSchema();
      const user = authenticatedUser(req, res);
      if (!user) return;
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new RpsHttpError(400, "Неверный номер комнаты.");

      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomOrThrow(client, roomId, true);
      if (String(room.owner_telegram_id) !== String(user.id)) {
        throw new RpsHttpError(403, "Добавить бота может только создатель комнаты.");
      }
      if (room.status !== "waiting") {
        throw new RpsHttpError(400, "Бота можно добавить только до начала раунда.");
      }

      const members = await currentMembers(client, roomId);
      if (members.some(player => String(player.telegram_id) === RPS_BOT_ID)) {
        await client.query("COMMIT");
        transactionOpen = false;
        return res.json({ ok: true, roomId, alreadyAdded: true, message: "Бот уже в комнате." });
      }
      if (members.length >= MAX_PLAYERS) {
        throw new RpsHttpError(400, "В комнате уже 3 игрока.");
      }

      await client.query(
        "INSERT INTO rps_room_players (room_id, telegram_id, display_name, joined_round) " +
        "VALUES ($1, $2, $3, $4)",
        [roomId, RPS_BOT_ID, RPS_BOT_NAME, Number(room.current_round)]
      );
      const participantIds = [
        ...members
          .filter(player => Number(player.joined_round) <= Number(room.current_round))
          .map(player => String(player.telegram_id)),
        RPS_BOT_ID
      ];
      if (participantIds.length < 2) {
        throw new RpsHttpError(400, "Для проверки нужны игрок и бот.");
      }
      await ensureCurrentRound(client, roomId, Number(room.current_round), participantIds);
      await client.query(
        "UPDATE rps_rooms SET status = 'playing', updated_at = NOW() WHERE id = $1",
        [roomId]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({
        ok: true,
        roomId,
        message: "Бот добавлен. Это тестовый режим: баланс AC не меняется."
      });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      return httpError(res, error);
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/join", async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
      await ensureSchema();
      const user = authenticatedUser(req, res);
      if (!user) return;
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new RpsHttpError(400, "Неверный номер комнаты.");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      await ensurePlayer(client, user);
      const room = await getRoomOrThrow(client, roomId, true);
      const userId = String(user.id);
      const existing = await client.query(
        "SELECT 1 FROM rps_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, userId]
      );
      if (existing.rows.length) {
        await client.query("COMMIT");
        transactionOpen = false;
        return res.json({ ok: true, roomId, alreadyMember: true });
      }
      const countResult = await client.query(
        "SELECT COUNT(*)::INTEGER AS total FROM rps_room_players WHERE room_id = $1",
        [roomId]
      );
      if (Number(countResult.rows[0]?.total || 0) >= MAX_PLAYERS) {
        throw new RpsHttpError(400, "В комнате уже 3 игрока. Выбери другую комнату.");
      }
      if (room.status !== "waiting" && room.status !== "playing") {
        throw new RpsHttpError(400, "Эта комната больше не принимает игроков.");
      }
      const joinRound = room.status === "playing"
        ? Number(room.current_round) + 1
        : Number(room.current_round);
      await client.query(
        "INSERT INTO rps_room_players (room_id, telegram_id, display_name, joined_round) " +
        "VALUES ($1, $2, $3, $4)",
        [roomId, userId, cleanName(user), joinRound]
      );

      const countAfter = await client.query(
        "SELECT COUNT(*)::INTEGER AS total FROM rps_room_players WHERE room_id = $1",
        [roomId]
      );
      if (room.status === "waiting" && Number(countAfter.rows[0].total) >= 2) {
        const active = await client.query(
          "SELECT telegram_id FROM rps_room_players WHERE room_id = $1 AND joined_round <= $2 " +
          "ORDER BY joined_at, telegram_id",
          [roomId, Number(room.current_round)]
        );
        const participantIds = active.rows.map(row => String(row.telegram_id));
        if (participantIds.length >= 2) {
          await ensureCurrentRound(client, roomId, Number(room.current_round), participantIds);
          await client.query(
            "UPDATE rps_rooms SET status = 'playing', updated_at = NOW() WHERE id = $1",
            [roomId]
          );
        }
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({
        ok: true,
        roomId,
        joinedRound: joinRound,
        message: room.status === "playing"
          ? "Ты в комнате. Этот раунд играют прежние участники; ты подключишься со следующего раунда."
          : "Ты вошёл в комнату. Раунд начинается."
      });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      return httpError(res, error);
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/state", async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
      await ensureSchema();
      const user = authenticatedUser(req, res);
      if (!user) return;
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new RpsHttpError(400, "Неверный номер комнаты.");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomOrThrow(client, roomId, true);
      const member = await client.query(
        "SELECT 1 FROM rps_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, String(user.id)]
      );
      if (!member.rows.length) throw new RpsHttpError(403, "Ты больше не состоишь в этой комнате.");
      const balance = await ensurePlayer(client, user);
      const payload = await buildState(client, room, user, balance);
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json(payload);
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      return httpError(res, error);
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/choose", async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
      await ensureSchema();
      const user = authenticatedUser(req, res);
      if (!user) return;
      const roomId = parseRoomId(req.body?.roomId);
      const choice = req.body?.choice;
      if (!roomId) throw new RpsHttpError(400, "Неверный номер комнаты.");
      if (!isRpsChoice(choice)) throw new RpsHttpError(400, "Выбери камень, ножницы или бумагу.");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomOrThrow(client, roomId, true);
      const userId = String(user.id);
      const membership = await client.query(
        "SELECT display_name FROM rps_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, userId]
      );
      if (!membership.rows.length) throw new RpsHttpError(403, "Сначала войди в комнату.");
      const currentResult = await client.query(
        "SELECT round_number, participants, choices, status FROM rps_room_rounds " +
        "WHERE room_id = $1 AND round_number = $2 FOR UPDATE",
        [roomId, Number(room.current_round)]
      );
      const round = currentResult.rows[0];
      if (!round || room.status !== "playing" || round.status !== "playing") {
        throw new RpsHttpError(400, "Раунд начнётся, когда в комнате будет минимум два игрока.");
      }
      const participantIds = (round.participants || []).map(String);
      if (!participantIds.includes(userId)) {
        throw new RpsHttpError(400, "Ты подключился во время раунда. Ты сможешь сделать ход в следующем раунде.");
      }
      const choices = jsonObject(round.choices);
      if (Object.prototype.hasOwnProperty.call(choices, userId)) {
        throw new RpsHttpError(409, "Ты уже сделал выбор. Дождись остальных игроков.");
      }
      const candidateChoices = { ...choices, [userId]: choice };
      // Test bot chooses automatically. Its choice stays hidden until the human(s) have chosen.
      if (participantIds.includes(RPS_BOT_ID) && !Object.prototype.hasOwnProperty.call(candidateChoices, RPS_BOT_ID)) {
        candidateChoices[RPS_BOT_ID] = randomRpsChoice();
      }
      if (Object.keys(candidateChoices).length < participantIds.length) {
        await client.query(
          "UPDATE rps_room_rounds SET choices = $3::JSONB, updated_at = NOW() " +
          "WHERE room_id = $1 AND round_number = $2",
          [roomId, Number(room.current_round), JSON.stringify(candidateChoices)]
        );
        await client.query("UPDATE rps_rooms SET updated_at = NOW() WHERE id = $1", [roomId]);
        await client.query("COMMIT");
        transactionOpen = false;
        return res.json({ ok: true, resolved: false, message: "Ход скрыт до выбора остальных игроков." });
      }

      // Test-bot rooms are practice only: they never change any real player balance.
      const testMode = participantIds.includes(RPS_BOT_ID);
      if (!testMode) {
      // Charge everybody together only after every participant has chosen.
      const walletResult = await client.query(
        "SELECT telegram_id, balance FROM players WHERE telegram_id::TEXT = ANY($1::TEXT[]) " +
        "ORDER BY telegram_id FOR UPDATE",
        [participantIds]
      );
      const wallets = new Map(walletResult.rows.map(row => [String(row.telegram_id), Number(row.balance)]));
      const shortPlayers = participantIds.filter(id => !wallets.has(id) || wallets.get(id) < Number(room.stake));
      if (shortPlayers.length) {
        await client.query(
          "UPDATE rps_room_rounds SET choices = '{}'::JSONB, updated_at = NOW() " +
          "WHERE room_id = $1 AND round_number = $2",
          [roomId, Number(room.current_round)]
        );
        await client.query("UPDATE rps_rooms SET updated_at = NOW() WHERE id = $1", [roomId]);
        await client.query("COMMIT");
        transactionOpen = false;
        return res.status(400).json({
          ok: false,
          error: "У одного или нескольких игроков недостаточно AC для ставки. Все выборы сброшены; пополните баланс и выберите снова."
        });
      }

      for (const telegramId of participantIds) {
        const debit = await client.query(
          "UPDATE players SET balance = balance - $1, updated_at = NOW() " +
          "WHERE telegram_id = $2 AND balance >= $1 RETURNING telegram_id",
          [Number(room.stake), telegramId]
        );
        if (!debit.rows.length) throw new RpsHttpError(400, "Не удалось подтвердить ставку. Выбери жест ещё раз.");
      }

      }

      const resolution = resolveRpsRound(candidateChoices);
      const labelResult = await client.query(
        "SELECT telegram_id, display_name FROM rps_room_players " +
        "WHERE room_id = $1 AND telegram_id = ANY($2::TEXT[])",
        [roomId, participantIds]
      );
      const labels = new Map(labelResult.rows.map(row => [
        String(row.telegram_id),
        String(row.display_name || "Игрок")
      ]));
      const pot = testMode ? 0 : Number(room.stake) * participantIds.length;
      const payouts = [];
      if (testMode) {
        // Never debit, refund, or pay out AC in test-bot mode.
      } else if (resolution.outcome === "draw") {
        for (const telegramId of participantIds) {
          const refund = await client.query(
            "UPDATE players SET balance = balance + $1, updated_at = NOW() " +
            "WHERE telegram_id = $2 RETURNING balance",
            [Number(room.stake), telegramId]
          );
          if (!refund.rows.length) throw new RpsHttpError(500, "Не удалось вернуть ставку при ничьей.");
          payouts.push({
            telegramId,
            label: labels.get(telegramId) || "Игрок",
            amount: Number(room.stake),
            kind: "refund"
          });
        }
      } else {
        let remainder = pot % resolution.winnerIds.length;
        const baseShare = Math.floor(pot / resolution.winnerIds.length);
        for (const telegramId of resolution.winnerIds) {
          const amount = baseShare + (remainder > 0 ? 1 : 0);
          if (remainder > 0) remainder -= 1;
          const credit = await client.query(
            "UPDATE players SET balance = balance + $1, updated_at = NOW() " +
            "WHERE telegram_id = $2 RETURNING balance",
            [amount, telegramId]
          );
          if (!credit.rows.length) throw new RpsHttpError(500, "Не удалось выплатить банк победителям.");
          payouts.push({
            telegramId,
            label: labels.get(telegramId) || "Игрок",
            amount,
            kind: "win"
          });
        }
      }

      const revealedChoices = participantIds.map(telegramId => ({
        telegramId,
        label: labels.get(telegramId) || "Игрок",
        choice: candidateChoices[telegramId],
        choiceLabel: CHOICE_LABELS[candidateChoices[telegramId]],
        symbol: CHOICE_SYMBOLS[candidateChoices[telegramId]]
      }));
      const result = {
        roundNumber: Number(room.current_round),
        outcome: resolution.outcome,
        winningChoice: resolution.winningChoice,
        winnerTelegramIds: resolution.winnerIds,
        winnerLabels: resolution.winnerIds.map(id => labels.get(id) || "Игрок"),
        choices: revealedChoices,
        pot,
        stake: Number(room.stake),
        testMode,
        payouts,
        finishedAt: new Date().toISOString()
      };
      await client.query(
        "UPDATE rps_room_rounds SET choices = $3::JSONB, status = 'finished', result = $4::JSONB, " +
        "updated_at = NOW(), finished_at = NOW() WHERE room_id = $1 AND round_number = $2",
        [roomId, Number(room.current_round), JSON.stringify(candidateChoices), JSON.stringify(result)]
      );

      const nextRound = Number(room.current_round) + 1;
      const activeNext = await client.query(
        "SELECT telegram_id FROM rps_room_players WHERE room_id = $1 AND joined_round <= $2 " +
        "ORDER BY joined_at, telegram_id",
        [roomId, nextRound]
      );
      const nextParticipants = activeNext.rows.map(row => String(row.telegram_id));
      if (nextParticipants.length >= 2) {
        await ensureCurrentRound(client, roomId, nextRound, nextParticipants);
        await client.query(
          "UPDATE rps_rooms SET current_round = $2, status = 'playing', updated_at = NOW() WHERE id = $1",
          [roomId, nextRound]
        );
      } else {
        await client.query(
          "UPDATE rps_rooms SET current_round = $2, status = 'waiting', updated_at = NOW() WHERE id = $1",
          [roomId, nextRound]
        );
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, resolved: true, result });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      return httpError(res, error);
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/leave", async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
      await ensureSchema();
      const user = authenticatedUser(req, res);
      if (!user) return;
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new RpsHttpError(400, "Неверный номер комнаты.");
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await getRoomOrThrow(client, roomId, true);
      const userId = String(user.id);
      const member = await client.query(
        "SELECT 1 FROM rps_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, userId]
      );
      if (!member.rows.length) {
        await client.query("COMMIT");
        transactionOpen = false;
        return res.json({ ok: true, message: "Ты уже вышел из комнаты." });
      }
      if (room.status === "waiting" && String(room.owner_telegram_id) === userId) {
        await client.query("DELETE FROM rps_rooms WHERE id = $1", [roomId]);
        await client.query("COMMIT");
        transactionOpen = false;
        return res.json({ ok: true, message: "Комната закрыта." });
      }

      const currentResult = await client.query(
        "SELECT participants, choices FROM rps_room_rounds " +
        "WHERE room_id = $1 AND round_number = $2 AND status = 'playing' FOR UPDATE",
        [roomId, Number(room.current_round)]
      );
      const current = currentResult.rows[0] || null;
      await client.query(
        "DELETE FROM rps_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, userId]
      );
      if (current && (current.participants || []).map(String).includes(userId)) {
        const remaining = (current.participants || []).map(String).filter(id => id !== userId);
        if (remaining.length >= 2) {
          await client.query(
            "UPDATE rps_room_rounds SET participants = $3::TEXT[], choices = '{}'::JSONB, updated_at = NOW() " +
            "WHERE room_id = $1 AND round_number = $2",
            [roomId, Number(room.current_round), remaining]
          );
        } else {
          await client.query(
            "DELETE FROM rps_room_rounds WHERE room_id = $1 AND round_number = $2",
            [roomId, Number(room.current_round)]
          );
          await client.query(
            "UPDATE rps_rooms SET status = 'waiting', updated_at = NOW() WHERE id = $1",
            [roomId]
          );
        }
      }

      const remainingMembers = await currentMembers(client, roomId);
      const remainingHumans = remainingMembers.filter(player => String(player.telegram_id) !== RPS_BOT_ID);
      if (!remainingHumans.length) {
        await client.query("DELETE FROM rps_rooms WHERE id = $1", [roomId]);
      } else if (String(room.owner_telegram_id) === userId) {
        await client.query(
          "UPDATE rps_rooms SET owner_telegram_id = $2, updated_at = NOW() WHERE id = $1",
          [roomId, String(remainingHumans[0].telegram_id)]
        );
      } else {
        await client.query("UPDATE rps_rooms SET updated_at = NOW() WHERE id = $1", [roomId]);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, message: "Ты вышел из комнаты." });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      return httpError(res, error);
    } finally {
      client?.release();
    }
  });

  return router;
}
