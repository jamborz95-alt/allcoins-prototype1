import express from "express";
import { createCheckersGame, applyCheckersStep, getCheckersMoves } from "./checkers-game.js";

function validStake(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 100 && amount <= 1000000 && amount % 100 === 0
    ? amount
    : null;
}

function validRoomId(value) {
  const match = String(value ?? "").trim().match(/^(?:SH-)?([1-9]\d{0,17})$/);
  return match ? match[1] : null;
}

function mapRoom(row, userId = null) {
  return {
    id: "SH-" + String(row.id),
    roomId: String(row.id),
    name: String(row.name || "Комната шашек"),
    stake: Number(row.stake),
    owner: String(row.owner_name || "Игрок"),
    isOwner: userId !== null && String(row.owner_telegram_id) === String(userId),
    status: row.status === "waiting" ? "Ожидает игрока" : String(row.status),
    statusCode: String(row.status),
    playersCount: Number(row.players_count || 0),
    maxPlayers: Number(row.max_players || 2),
    createdAt: row.created_at
  };
}

function publicPlayers(players, userId) {
  return players.map((player) => ({
    name: String(player.display_name || player.name || "Игрок"),
    color: String(player.color || ""),
    isYou: String(player.telegram_id ?? player.telegramId ?? "") === String(userId),
    isOwner: Boolean(player.isOwner)
  }));
}

function publicGame(state, userId) {
  if (!state) return null;
  const me = (state.players || []).find((player) => String(player.telegramId) === String(userId));
  const currentPlayer = (state.players || []).find((player) => String(player.telegramId) === String(state.turnTelegramId));
  return {
    board: state.board,
    turn: state.turn,
    status: state.status,
    winner: state.winner || null,
    lastMove: state.lastMove || null,
    mustContinue: state.mustContinue || null,
    players: (state.players || []).map((player) => ({
      name: player.name,
      color: player.color,
      isYou: String(player.telegramId) === String(userId),
      isOwner: Boolean(player.isOwner)
    })),
    myColor: me?.color || null,
    currentPlayerIsMe: Boolean(state.status === "playing" && String(state.turnTelegramId) === String(userId)),
    currentPlayerLabel: currentPlayer?.name || "Игрок",
    message: state.status === "finished"
      ? (state.winner === me?.color ? "Ты победил!" : state.winner ? "Партия завершена." : "Ничья.")
      : (String(state.turnTelegramId) === String(userId) ? "Твой ход." : "Ход соперника.")
  };
}

export function createCheckersRouter({ pool, verifyTelegram }) {
  const router = express.Router();

  function authenticatedUser(req, res) {
    const user = verifyTelegram(req.body?.initData);
    if (!user?.id) {
      res.status(401).json({
        ok: false,
        error: "Не удалось проверить Telegram. Открой Шашки через ALLCOINS."
      });
      return null;
    }
    return user;
  }

  function userName(user) {
    return String(user.first_name || user.username || "Игрок").trim().slice(0, 40) || "Игрок";
  }

  async function ensurePlayer(client, user) {
    await client.query(
      `INSERT INTO players (telegram_id)
       VALUES ($1)
       ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW()`,
      [String(user.id)]
    );
  }

  async function roomPlayers(client, roomId) {
    const result = await client.query(
      `SELECT rp.telegram_id::text AS telegram_id, rp.display_name, rp.joined_at,
              (rp.telegram_id = r.owner_telegram_id) AS is_owner
       FROM checkers_room_players rp
       JOIN checkers_rooms r ON r.id = rp.room_id
       WHERE rp.room_id = $1
       ORDER BY (rp.telegram_id = r.owner_telegram_id) DESC, rp.joined_at ASC, rp.telegram_id ASC`,
      [roomId]
    );
    return result.rows.map((player) => ({
      telegram_id: String(player.telegram_id),
      display_name: String(player.display_name || "Игрок"),
      joined_at: player.joined_at,
      isOwner: Boolean(player.is_owner)
    }));
  }

  async function loadRoom(client, roomId, lock = false) {
    const result = await client.query(
    if (lock) {
      const locked = await client.query(
        `SELECT id, name, owner_telegram_id, owner_name, stake, max_players, status, created_at
         FROM checkers_rooms WHERE id = $1 FOR UPDATE`,
        [roomId]
      );
      if (!locked.rows.length) return null;
      const count = await client.query(
        "SELECT COUNT(*)::INTEGER AS players_count FROM checkers_room_players WHERE room_id = $1",
        [roomId]
      );
      return { ...locked.rows[0], players_count: Number(count.rows[0].players_count) };
    }
    const result = await client.query(
      `SELECT r.id, r.name, r.owner_telegram_id, r.owner_name, r.stake, r.max_players,
              r.status, r.created_at, COUNT(rp.telegram_id)::INTEGER AS players_count
       FROM checkers_rooms r
       LEFT JOIN checkers_room_players rp ON rp.room_id = r.id
       WHERE r.id = $1
       GROUP BY r.id`,
      [roomId]
    );
    return result.rows[0] || null;
  }

  async function requireMember(client, roomId, userId) {
    const result = await client.query(
      "SELECT 1 FROM checkers_room_players WHERE room_id = $1 AND telegram_id = $2",
      [roomId, String(userId)]
    );
    return result.rows.length > 0;
  }

  router.initialize = async function initializeCheckersTables() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS checkers_rooms (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Комната шашек',
        owner_telegram_id BIGINT NOT NULL,
        owner_name TEXT NOT NULL DEFAULT 'Игрок',
        stake BIGINT NOT NULL CHECK (stake BETWEEN 100 AND 1000000),
        max_players INTEGER NOT NULL DEFAULT 2 CHECK (max_players = 2),
        status TEXT NOT NULL DEFAULT 'waiting'
          CHECK (status IN ('waiting', 'playing', 'finished')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS checkers_room_players (
        room_id BIGINT NOT NULL REFERENCES checkers_rooms(id) ON DELETE CASCADE,
        telegram_id BIGINT NOT NULL,
        display_name TEXT NOT NULL DEFAULT 'Игрок',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (room_id, telegram_id)
      )`
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS checkers_games (
        room_id BIGINT PRIMARY KEY REFERENCES checkers_rooms(id) ON DELETE CASCADE,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS checkers_rooms_waiting_idx ON checkers_rooms (status, created_at DESC)"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS checkers_room_players_room_idx ON checkers_room_players (room_id, joined_at)"
    );
  };

  router.post("/rooms/list", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    try {
      await pool.query(
        "DELETE FROM checkers_rooms WHERE status = 'waiting' AND created_at < NOW() - INTERVAL '45 minutes'"
      );
      const result = await pool.query(
        `SELECT r.id, r.name, r.owner_telegram_id, r.owner_name, r.stake, r.max_players, r.status, r.created_at,
                COUNT(rp.telegram_id)::INTEGER AS players_count
         FROM checkers_rooms r
         LEFT JOIN checkers_room_players rp ON rp.room_id = r.id
         WHERE r.status = 'waiting'
         GROUP BY r.id
         HAVING COUNT(rp.telegram_id) < r.max_players
         ORDER BY r.created_at DESC
         LIMIT 50`
      );
      return res.json({ ok: true, rooms: result.rows.map((row) => mapRoom(row, user.id)) });
    } catch (error) {
      console.error("List Checkers rooms error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить общий список комнат шашек." });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    const stake = validStake(req.body?.stake);
    if (stake === null) {
      return res.status(400).json({ ok: false, error: "Ставка должна быть от 100 до 1 000 000 AC с шагом 100." });
    }

    const ownerName = userName(user);
    let client;
    let transactionOpen = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      await ensurePlayer(client, user);
      const inserted = await client.query(
        `INSERT INTO checkers_rooms (name, owner_telegram_id, owner_name, stake, max_players, status)
         VALUES ('Комната шашек', $1, $2, $3, 2, 'waiting')
         RETURNING id, name, owner_telegram_id, owner_name, stake, max_players, status, created_at`,
        [String(user.id), ownerName, stake]
      );
      const row = inserted.rows[0];
      await client.query(
        `INSERT INTO checkers_room_players (room_id, telegram_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, telegram_id) DO NOTHING`,
        [String(row.id), String(user.id), ownerName]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, room: mapRoom({ ...row, players_count: 1 }, user.id) });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      console.error("Create Checkers room error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось создать общую комнату шашек." });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/join", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    const roomId = validRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });

    let client;
    let transactionOpen = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await loadRoom(client, roomId, true);
      if (!room) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(404).json({ ok: false, error: "Комната не найдена." });
      }
      if (room.status !== "waiting") {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(409).json({ ok: false, error: "Партия уже началась. Найди свободную комнату." });
      }
      const isMember = await requireMember(client, roomId, user.id);
      const players = await client.query(
        "SELECT COUNT(*)::INTEGER AS total FROM checkers_room_players WHERE room_id = $1",
        [roomId]
      );
      if (!isMember && Number(players.rows[0].total) >= Number(room.max_players)) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(409).json({ ok: false, error: "Комната уже заполнена." });
      }
      if (!isMember) {
        await ensurePlayer(client, user);
        await client.query(
          `INSERT INTO checkers_room_players (room_id, telegram_id, display_name)
           VALUES ($1, $2, $3)`,
          [roomId, String(user.id), userName(user)]
        );
      }
      const updatedRoom = await loadRoom(client, roomId);
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, room: mapRoom(updatedRoom, user.id), playersCount: Number(updatedRoom.players_count) });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      console.error("Join Checkers room error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось войти в онлайн-комнату шашек." });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/state", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    const roomId = validRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });
    try {
      const room = await loadRoom(pool, roomId);
      if (!room) return res.status(404).json({ ok: false, error: "Комната не найдена." });
      if (!await requireMember(pool, roomId, user.id)) {
        return res.status(403).json({ ok: false, error: "Ты не состоишь в этой комнате." });
      }
      const members = await roomPlayers(pool, roomId);
      const gameResult = await pool.query("SELECT state FROM checkers_games WHERE room_id = $1", [roomId]);
      const state = gameResult.rows[0]?.state || null;
      return res.json({
        ok: true,
        room: mapRoom(room, user.id),
        players: members.map((player) => ({
          name: player.display_name,
          isYou: player.telegram_id === String(user.id),
          isOwner: player.isOwner
        })),
        game: publicGame(state, user.id)
      });
    } catch (error) {
      console.error("Checkers room state error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось обновить состояние комнаты шашек." });
    }
  });

  router.post("/rooms/start", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    const roomId = validRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });

    let client;
    let transactionOpen = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await loadRoom(client, roomId, true);
      if (!room) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(404).json({ ok: false, error: "Комната не найдена." });
      }
      if (String(room.owner_telegram_id) !== String(user.id)) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(403).json({ ok: false, error: "Начать онлайн-партию может только создатель комнаты." });
      }
      if (room.status === "playing") {
        const current = await client.query("SELECT state FROM checkers_games WHERE room_id = $1", [roomId]);
        await client.query("COMMIT"); transactionOpen = false;
        return res.json({ ok: true, room: mapRoom(room, user.id), game: publicGame(current.rows[0]?.state, user.id) });
      }
      if (room.status !== "waiting") {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(409).json({ ok: false, error: "Эта комната уже завершена." });
      }
      const players = await roomPlayers(client, roomId);
      if (players.length !== 2) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(409).json({ ok: false, error: "Для начала онлайн-партии нужны два реальных игрока. Бот не добавляется." });
      }
      const mappedPlayers = players.map((player, index) => ({
        telegramId: player.telegram_id,
        name: player.display_name,
        color: index === 0 ? "w" : "b",
        isOwner: player.isOwner
      }));
      const state = createCheckersGame(mappedPlayers);
      await client.query(
        "INSERT INTO checkers_games (room_id, state) VALUES ($1, $2::jsonb) ON CONFLICT (room_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()",
        [roomId, JSON.stringify(state)]
      );
      const playingRoom = await client.query(
        "UPDATE checkers_rooms SET status = 'playing' WHERE id = $1 RETURNING id, name, owner_telegram_id, owner_name, stake, max_players, status, created_at",
        [roomId]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({
        ok: true,
        room: mapRoom({ ...playingRoom.rows[0], players_count: players.length }, user.id),
        game: publicGame(state, user.id)
      });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      console.error("Start Checkers game error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось начать онлайн-партию шашек." });
    } finally {
      client?.release();
    }
  });

  router.post("/game/state", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    const roomId = validRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });
    try {
      const room = await loadRoom(pool, roomId);
      if (!room) return res.status(404).json({ ok: false, error: "Комната не найдена." });
      if (!await requireMember(pool, roomId, user.id)) {
        return res.status(403).json({ ok: false, error: "Ты не состоишь в этой комнате." });
      }
      const result = await pool.query("SELECT state FROM checkers_games WHERE room_id = $1", [roomId]);
      const state = result.rows[0]?.state || null;
      if (!state) return res.status(409).json({ ok: false, error: "Создатель ещё не начал партию." });
      return res.json({ ok: true, room: mapRoom(room), game: publicGame(state, user.id) });
    } catch (error) {
      console.error("Checkers game state error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить ход онлайн-партии." });
    }
  });

  router.post("/game/action", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    const roomId = validRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });
    if (req.body?.action !== "move") {
      return res.status(400).json({ ok: false, error: "Неизвестное действие для шашек." });
    }

    let client;
    let transactionOpen = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await loadRoom(client, roomId, true);
      if (!room) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(404).json({ ok: false, error: "Комната не найдена." });
      }
      if (!await requireMember(client, roomId, user.id)) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(403).json({ ok: false, error: "Ты не состоишь в этой комнате." });
      }
      const gameResult = await client.query(
        "SELECT state FROM checkers_games WHERE room_id = $1 FOR UPDATE",
        [roomId]
      );
      if (!gameResult.rows.length) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(409).json({ ok: false, error: "Партия ещё не началась." });
      }
      const currentState = gameResult.rows[0].state;
      const nextState = applyCheckersStep(currentState, String(user.id), req.body?.from, req.body?.to);
      await client.query(
        "UPDATE checkers_games SET state = $2::jsonb, updated_at = NOW() WHERE room_id = $1",
        [roomId, JSON.stringify(nextState)]
      );
      if (nextState.status === "finished") {
        await client.query("UPDATE checkers_rooms SET status = 'finished' WHERE id = $1", [roomId]);
      }
      const updatedRoom = await loadRoom(client, roomId);
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({
        ok: true,
        room: mapRoom({ ...updatedRoom, players_count: 2 }, user.id),
        game: publicGame(nextState, user.id)
      });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      const status = error?.statusCode || 500;
      if (status >= 500) console.error("Checkers move error:", error.message || error);
      return res.status(status).json({ ok: false, error: error.message || "Не удалось выполнить ход." });
    } finally {
      client?.release();
    }
  });

  router.post("/rooms/leave", async (req, res) => {
    const user = authenticatedUser(req, res);
    if (!user) return;
    const roomId = validRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Неверный номер комнаты." });

    let client;
    let transactionOpen = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      const room = await loadRoom(client, roomId, true);
      if (!room) {
        await client.query("COMMIT"); transactionOpen = false;
        return res.json({ ok: true, alreadyClosed: true });
      }
      if (!await requireMember(client, roomId, user.id)) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(403).json({ ok: false, error: "Ты не состоишь в этой комнате." });
      }
      const isOwner = String(room.owner_telegram_id) === String(user.id);
      if (room.status === "playing") {
        const gameResult = await client.query("SELECT state FROM checkers_games WHERE room_id = $1 FOR UPDATE", [roomId]);
        const state = gameResult.rows[0]?.state;
        if (state && state.status === "playing") {
          const leavingPlayer = (state.players || []).find((player) => String(player.telegramId) === String(user.id));
          const winner = (state.players || []).find((player) => String(player.telegramId) !== String(user.id));
          state.status = "finished";
          state.winner = winner?.color || null;
          state.turnTelegramId = winner?.telegramId || null;
          state.mustContinue = null;
          state.message = (leavingPlayer?.name || "Игрок") + " покинул партию.";
          await client.query("UPDATE checkers_games SET state = $2::jsonb, updated_at = NOW() WHERE room_id = $1", [roomId, JSON.stringify(state)]);
          await client.query("UPDATE checkers_rooms SET status = 'finished' WHERE id = $1", [roomId]);
        }
      } else if (room.status === "waiting" && isOwner) {
        await client.query("DELETE FROM checkers_rooms WHERE id = $1", [roomId]);
      } else if (room.status === "waiting") {
        await client.query("DELETE FROM checkers_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, String(user.id)]);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true });
    } catch (error) {
      if (client && transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      console.error("Leave Checkers room error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось выйти из онлайн-комнаты." });
    } finally {
      client?.release();
    }
  });

  return router;
}
