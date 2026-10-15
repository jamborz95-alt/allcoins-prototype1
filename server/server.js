import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;
const app = express();

app.use(cors({
  origin: [
    "https://jamborz95-alt.github.io",
    "http://localhost:5173"
  ]
}));

app.use(express.json({ limit: "20kb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Проверяем подлинность данных Telegram
function verifyTelegram(initData) {
  const botToken = process.env.BOT_TOKEN;

  if (!botToken || !initData || typeof initData !== "string") {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest();

    const receivedBuffer = Buffer.from(receivedHash, "hex");

    if (
      receivedBuffer.length !== calculatedHash.length ||
      !crypto.timingSafeEqual(receivedBuffer, calculatedHash)
    ) {
      return null;
    }

    const authDate = Number(params.get("auth_date"));

    if (
      !Number.isFinite(authDate) ||
      authDate > Math.floor(Date.now() / 1000) + 60 ||
      Math.floor(Date.now() / 1000) - authDate > 86400
    ) {
      return null;
    }

    const userText = params.get("user");

    if (!userText) return null;

    const user = JSON.parse(userText);

    if (!Number.isSafeInteger(user.id) || user.id <= 0) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

// Получаем пользователя и создаём профиль при первом входе
async function getPlayer(req, res) {
  const user = verifyTelegram(req.body?.initData);

  if (!user) {
    res.status(401).json({
      ok: false,
      error: "Telegram authentication failed. Open the app through Telegram."
    });
    return null;
  }

  const result = await pool.query(
    `INSERT INTO players (telegram_id)
     VALUES ($1)
     ON CONFLICT (telegram_id) DO UPDATE
       SET updated_at = NOW()
     RETURNING telegram_id, balance, energy`,
    [String(user.id)]
  );

  return {
    telegramId: String(result.rows[0].telegram_id),
    balance: Number(result.rows[0].balance),
    energy: result.rows[0].energy,
    firstName: user.first_name || "Игрок",
    username: user.username || null
  };
}

app.get("/", (req, res) => {
  res.json({
    app: "ALLCOINS",
    status: "running"
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      app: "ALLCOINS",
      database: "connected",
      version: "1.1.0"
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(500).json({
      ok: false,
      app: "ALLCOINS",
      database: "disconnected"
    });
  }
});

// Вход и получение сохранённого профиля
app.post("/api/auth", async (req, res) => {
  try {
    const player = await getPlayer(req, res);

    if (!player) return;

    res.json({
      ok: true,
      player
    });
  } catch (error) {
    console.error("Authentication error:", error.message);
    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

// Нажатие на монету: -1 энергия, +100 Allcoins
app.post("/api/tap", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Telegram authentication failed"
      });
    }

    const result = await pool.query(
      `UPDATE players
       SET balance = balance + 100,
           energy = energy - 1,
           updated_at = NOW()
       WHERE telegram_id = $1
         AND energy > 0
       RETURNING telegram_id, balance, energy`,
      [String(user.id)]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        ok: false,
        error: "No energy or profile not found"
      });
    }

        res.json({
      ok: true,
      player: {
        balance: Number(result.rows[0].balance),
        energy: result.rows[0].energy
      }
    });
  } catch (error) {
    console.error("Tap error:", error.message);
    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

// Демо-восстановление энергии.
// Позже заменим его проверкой настоящего рекламного просмотра.
app.post("/api/restore-energy", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Telegram authentication failed"
      });
    }

    const result = await pool.query(
      `UPDATE players
       SET energy = 100,
           updated_at = NOW()
       WHERE telegram_id = $1
       RETURNING balance, energy`,
      [String(user.id)]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: "Player not found"
      });
    }

    res.json({
      ok: true,
      balance: Number(result.rows[0].balance),
      energy: result.rows[0].energy,
      demo: true
    });
  } catch (error) {
    console.error("Energy restore error:", error.message);
    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});
// Ежедневный бонус +500 AC, один раз в 24 часа
app.post("/api/daily-bonus", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Telegram authentication failed"
      });
    }

    const result = await pool.query(
      `UPDATE players
       SET balance = balance + 500,
           daily_bonus_at = NOW(),
           updated_at = NOW()
       WHERE telegram_id = $1
         AND (
           daily_bonus_at IS NULL
           OR daily_bonus_at <= NOW() - INTERVAL '24 hours'
         )
       RETURNING balance, energy, daily_bonus_at`,
      [String(user.id)]
    );

    if (result.rowCount === 0) {
      const playerResult = await pool.query(
        `SELECT balance, energy
         FROM players
         WHERE telegram_id = $1`,
        [String(user.id)]
      );

      if (playerResult.rowCount === 0) {
        return res.status(404).json({
          ok: false,
          error: "Player not found"
        });
      }

      return res.json({
        ok: false,
        error: "Бонус уже получен. Возвращайся через 24 часа.",
        player: {
          balance: Number(playerResult.rows[0].balance),
          energy: playerResult.rows[0].energy
        }
      });
    }

    return res.json({
      ok: true,
      player: {
        balance: Number(result.rows[0].balance),
        energy: result.rows[0].energy,
        dailyBonusAt: result.rows[0].daily_bonus_at
      }
    });
  } catch (error) {
    console.error("Daily bonus error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});
// Создание комнаты Дурак Онлайн
app.post("/api/durak/rooms", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

if (!user || !user.id) {
  return res.status(401).json({
    ok: false,
    error: "Telegram authentication failed"
  });
}

    const name = String(req.body.name || "Комната Дурак").trim().slice(0, 50);
    const maxPlayers = Number(req.body.maxPlayers);
    const stake = Number(req.body.stake);

    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 6) {
      return res.status(400).json({
        ok: false,
        error: "Количество игроков должно быть от 2 до 6"
      });
    }

    if (!Number.isSafeInteger(stake) || stake < 1) {
      return res.status(400).json({
        ok: false,
        error: "Ставка должна быть целым числом больше нуля"
      });
    }

    const result = await pool.query(
      `SELECT balance FROM players WHERE telegram_id = $1`,
      [String(user.id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Игрок не найден. Сначала войдите через Telegram."
      });
    }

    if (Number(result.rows[0].balance) < stake) {
      return res.status(400).json({
        ok: false,
        error: "Недостаточно AC"
      });
    }

    const roomResult = await pool.query(
      `INSERT INTO durak_rooms
        (name, owner_telegram_id, max_players, stake)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, max_players, stake, status`,
      [name, String(user.id), maxPlayers, stake]
    );

    await pool.query(
      `INSERT INTO durak_room_players (room_id, telegram_id)
       VALUES ($1, $2)`,
      [roomResult.rows[0].id, String(user.id)]
    );

    return res.json({
      ok: true,
      room: roomResult.rows[0]
    });
  } catch (error) {
    console.error("Create Durak room error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});// Получение списка комнат Дурак Онлайн
app.post("/api/durak/rooms/list", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user || !user.id) {
      return res.status(401).json({
        ok: false,
        error: "Telegram authentication failed"
      });
    }

   const result = await pool.query(
  `SELECT
     r.id,
     r.name,
     r.max_players,
     r.stake,
     r.status,
     (r.owner_telegram_id = $1::bigint) AS is_owner,
     COUNT(p.telegram_id)::INTEGER AS players_count
   FROM durak_rooms r
   LEFT JOIN durak_room_players p ON p.room_id = r.id
   WHERE r.status = 'waiting'
   GROUP BY r.id
   ORDER BY r.created_at DESC
   LIMIT 100`,
  [String(user.id)]
); 

    return res.json({
      ok: true,
      rooms: result.rows
    });

  } catch (error) {
    console.error("Get Durak rooms error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Не удалось загрузить комнаты"
    });
  }
});
// Присоединение к комнате Дурак Онлайн
app.post("/api/durak/rooms/join", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user || !user.id) {
      return res.status(401).json({
        ok: false,
        error: "Необходимо войти через Telegram"
      });
    }

    const roomId = req.body?.roomId;
    const telegramId = String(user.id);

    if (!roomId || !/^\d+$/.test(String(roomId))) {
      return res.status(400).json({
        ok: false,
        error: "Неверный номер комнаты"
      });
    }

    const roomResult = await pool.query(
      `SELECT id, name, max_players, stake, status
       FROM durak_rooms
       WHERE id = $1`,
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Комната не найдена"
      });
    }

    const room = roomResult.rows[0];

    if (room.status !== "waiting") {
      return res.status(400).json({
        ok: false,
        error: "Комната уже недоступна"
      });
    }

    const existing = await pool.query(
      `SELECT 1
       FROM durak_room_players
       WHERE room_id = $1 AND telegram_id = $2`,
      [roomId, telegramId]
    );

    if (existing.rows.length > 0) {
      return res.json({
        ok: true,
        message: "Ты уже находишься в этой комнате",
        room
      });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total
       FROM durak_room_players
       WHERE room_id = $1`,
      [roomId]
    );

    if (countResult.rows[0].total >= room.max_players) {
      return res.status(400).json({
        ok: false,
        error: "Комната заполнена"
      });
    }

    await pool.query(
      `INSERT INTO durak_room_players (room_id, telegram_id)
       VALUES ($1, $2)`,
      [roomId, telegramId]
    );

    return res.json({
      ok: true,
      message: "Ты присоединился к комнате",
      room
    });
  } catch (error) {
    console.error("Join Durak room error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Не удалось присоединиться к комнате"
    });
  }
});// Начало игры Дурак Онлайн
app.post("/api/durak/rooms/start", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user || !user.id) {
      return res.status(401).json({
        ok: false,
        error: "Необходимо войти через Telegram"
      });
    }

    const roomId = req.body?.roomId;

    if (!roomId || !/^\d+$/.test(String(roomId))) {
      return res.status(400).json({
        ok: false,
        error: "Неверный номер комнаты"
      });
    }

    const roomResult = await pool.query(
      `SELECT id, name, owner_telegram_id, max_players, status
       FROM durak_rooms
       WHERE id = $1`,
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Комната не найдена"
      });
    }

    const room = roomResult.rows[0];

    if (String(room.owner_telegram_id) !== String(user.id)) {
      return res.status(403).json({
        ok: false,
        error: "Начать игру может только создатель комнаты"
      });
    }

    if (room.status !== "waiting") {
      return res.status(400).json({
        ok: false,
        error: "Игра уже началась или завершена"
      });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total
       FROM durak_room_players
       WHERE room_id = $1`,
      [roomId]
    );

    const total = countResult.rows[0].total;

    if (total < 2) {
      return res.status(400).json({
        ok: false,
        error: "Для начала игры нужны минимум 2 игрока"
      });
    }

    const updateResult = await pool.query(
      `UPDATE durak_rooms
       SET status = 'playing'
       WHERE id = $1 AND status = 'waiting'
       RETURNING id, name, max_players, status`,
      [roomId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(409).json({
        ok: false,
        error: "Не удалось запустить игру"
      });
    }

    return res.json({
      ok: true,
      message: "Игра началась!",
      room: updateResult.rows[0],
      playersCount: total
    });
  } catch (error) {
    console.error("Start Durak game error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Не удалось начать игру"
    });
  }
});
async function startServer() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        balance BIGINT NOT NULL DEFAULT 10000,
        energy INTEGER NOT NULL DEFAULT 100,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
        `);

    await pool.query(`
      ALTER TABLE players
      ADD COLUMN IF NOT EXISTS daily_bonus_at TIMESTAMPTZ
    `);

    console.log("Players table is ready");
  
    await pool.query(`
      CREATE TABLE IF NOT EXISTS durak_rooms (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL,
        owner_telegram_id BIGINT NOT NULL,
        max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 6),
        stake BIGINT NOT NULL CHECK (stake > 0),
        status TEXT NOT NULL DEFAULT 'waiting'
          CHECK (status IN ('waiting', 'playing', 'finished')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS durak_room_players (
        room_id BIGINT NOT NULL REFERENCES durak_rooms(id) ON DELETE CASCADE,
        telegram_id BIGINT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (room_id, telegram_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS durak_games (
        room_id BIGINT PRIMARY KEY
          REFERENCES durak_rooms(id) ON DELETE CASCADE,
        game_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    console.log("Durak games table is ready");

    const port = process.env.PORT || 3000;
    

    app.listen(port, "0.0.0.0", () => {
      console.log(`ALLCOINS server started on port ${port}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();  
