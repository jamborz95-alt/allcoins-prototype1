import express from "express";

class CheckersHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validStake(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 100 && amount <= 1000000 && amount % 100 === 0
    ? amount
    : null;
}

function mapRoom(row) {
  return {
    id: "SH-" + String(row.id),
    roomId: String(row.id),
    name: String(row.name || "Комната шашек"),
    stake: Number(row.stake),
    owner: String(row.owner_name || "Игрок"),
    ownerTelegramId: String(row.owner_telegram_id),
    status: row.status === "waiting" ? "Ожидает игрока" : String(row.status),
    statusCode: String(row.status),
    playersCount: Number(row.players_count || 0),
    maxPlayers: Number(row.max_players || 2),
    createdAt: row.created_at
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

  async function ensurePlayer(client, user) {
    await client.query(
      `INSERT INTO players (telegram_id)
       VALUES ($1)
       ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW()`,
      [String(user.id)]
    );
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
      "CREATE INDEX IF NOT EXISTS checkers_rooms_waiting_idx ON checkers_rooms (status, created_at DESC)"
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
         ORDER BY r.created_at DESC
         LIMIT 50`
      );
      return res.json({ ok: true, rooms: result.rows.map(mapRoom) });
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

    const ownerName = String(user.first_name || user.username || "Игрок").trim().slice(0, 40) || "Игрок";
    const client = await pool.connect();
    let transactionOpen = false;
    try {
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
      return res.json({ ok: true, room: mapRoom({ ...row, players_count: 1 }) });
    } catch (error) {
      if (transactionOpen) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      console.error("Create Checkers room error:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось создать общую комнату шашек." });
    } finally {
      client.release();
    }
  });

  return router;
}
