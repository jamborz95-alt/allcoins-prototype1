import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "node:crypto";
import { createDurakDeck, shuffleDurakDeck, cardRank, beatsCard, dealInitialHands, chooseBotAttackIndex, chooseBotDefenseIndex, chooseStartingPlayerIndex, expireDurakTurnIfNeeded } from "./durak-rules.js";

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

/**
 * Делит банк между реальными победителями один раз на завершённую партию.
 * Функция вызывается внутри открытой PostgreSQL-транзакции.
 */
async function settleDurakGamePayout(client, gameState) {
  const pot = gameState?.pot;
  if (gameState?.status !== "finished" || !pot || pot.settled === true) {
    return pot?.settlement || null;
  }

  const contributors = [...new Set(
    (Array.isArray(pot.contributors) ? pot.contributors : [])
      .map(id => String(id))
      .filter(id => id && id !== "0")
  )];
  const grossPot = Math.max(0, Math.floor(Number(pot.grossPot) || 0));
  const burnedAmount = Math.min(
    grossPot,
    Math.max(0, Math.floor(Number(pot.burnedAmount ?? Math.floor(grossPot * 0.05)) || 0))
  );
  const payoutPool = Math.max(
    0,
    Math.min(grossPot - burnedAmount, Math.floor(Number(pot.payoutPool ?? grossPot - burnedAmount) || 0))
  );
  const loserId = gameState.loserTelegramId == null ? "" : String(gameState.loserTelegramId);

  let recipients = (Array.isArray(gameState.players) ? gameState.players : []).filter(player =>
    contributors.includes(String(player.telegramId)) &&
    String(player.telegramId) !== "0" &&
    String(player.telegramId) !== loserId
  );
  // Если в партии с ботом реального победителя нет, оставшиеся 95% возвращаются
  // реальному участнику: бот не получает и не создаёт виртуальные AC.
  if (!recipients.length) {
    recipients = (Array.isArray(gameState.players) ? gameState.players : []).filter(player =>
      contributors.includes(String(player.telegramId)) && String(player.telegramId) !== "0"
    );
  }

  const baseShare = recipients.length ? Math.floor(payoutPool / recipients.length) : 0;
  let remainder = recipients.length ? payoutPool % recipients.length : 0;
  const winners = [];

  for (const player of recipients) {
    const amount = baseShare + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    if (amount > 0) {
      const credited = await client.query(
        `UPDATE players
         SET balance = balance + $1,
             updated_at = NOW()
         WHERE telegram_id = $2
         RETURNING balance`,
        [amount, String(player.telegramId)]
      );
      if (!credited.rows.length) {
        throw new Error("Не найден баланс победителя для выплаты выигрыша");
      }
    }
    winners.push({ telegramId: String(player.telegramId), amount });
  }

  pot.settled = true;
  pot.settlement = {
    grossPot,
    burnedAmount,
    payoutPool,
    settledAt: new Date().toISOString(),
    winners
  };
  return pot.settlement;
}

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
      version: "1.2.0"
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
const deck = Number(req.body.deck ?? 36);
const speed = req.body.speed === "fast" ? "fast" : "normal";
    if (![36, 52].includes(deck)) {
      return res.status(400).json({
        ok: false,
        error: "Выбери колоду на 36 или 52 карты"
      });
    }
const privacy = req.body.privacy === "private" ? "private" : "public";
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

    // Гарантируем наличие профиля в базе: при первом входе/гонке авторизации
    // создаём запись, не заставляя пользователя повторно открывать приложение.
    const result = await pool.query(
      `INSERT INTO players (telegram_id)
       VALUES ($1)
       ON CONFLICT (telegram_id) DO UPDATE
         SET updated_at = NOW()
       RETURNING balance`,
      [String(user.id)]
    );

    if (Number(result.rows[0].balance) < stake) {
      return res.status(400).json({
        ok: false,
        error: "Недостаточно AC"
      });
    }

    const roomResult = await pool.query(
  `INSERT INTO durak_rooms
    (name, owner_telegram_id, max_players, stake, deck, speed, privacy)
   VALUES ($1, $2, $3, $4, $5, $6, $7)
   RETURNING id, name, max_players, stake, deck, speed, privacy, status`,
  [
    name,
    String(user.id),
    maxPlayers,
    stake,
    deck,
    speed,
    privacy
  ]
);

    await pool.query(
      `INSERT INTO durak_room_players (room_id, telegram_id, display_name)
       VALUES ($1, $2, $3)`,
      [roomResult.rows[0].id, String(user.id), user.first_name || user.username || "Игрок"]
    );

    return res.json({
      ok: true,
      room: roomResult.rows[0]
    });
  } catch (error) {
    console.error("Create Durak room error:", error.stack || error.message);

    return res.status(500).json({
      ok: false,
      error: "Не удалось создать комнату",
      debugMessage: String(error.message || "Неизвестная ошибка").slice(0, 240)
    });
  }
});// Получение списка комнат Дурак Онлайн
// Удаляем ожидающие комнаты, в которые за 2 минуты никто не присоединился.
// В таблице игроков остаётся создатель, поэтому «пустой» зал означает не больше одного участника.
async function cleanupExpiredEmptyDurakRooms() {
  const result = await pool.query(`
    DELETE FROM durak_rooms r
    WHERE r.status = 'waiting'
      AND r.created_at <= NOW() - INTERVAL '2 minutes'
      AND (
        SELECT COUNT(*)
        FROM durak_room_players p
        WHERE p.room_id = r.id
      ) <= 1
  `);
  if (result.rowCount > 0) {
    console.log(`Removed ${result.rowCount} expired empty Durak room(s)`);
  }
}

app.post("/api/durak/rooms/list", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user || !user.id) {
      return res.status(401).json({
        ok: false,
        error: "Telegram authentication failed"
      });
    }

   await cleanupExpiredEmptyDurakRooms();

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
// Добавить тестового бота в комнату Дурак Онлайн
app.post("/api/durak/rooms/add-bot", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);
    if (!user?.id) {
      return res.status(401).json({ ok: false, error: "Необходимо войти через Telegram" });
    }

    const roomId = req.body?.roomId;
    if (!roomId || !/^\d+$/.test(String(roomId))) {
      return res.status(400).json({ ok: false, error: "Неверный номер комнаты" });
    }

    const roomResult = await pool.query(
      `SELECT id, owner_telegram_id, max_players, status
       FROM durak_rooms WHERE id = $1`,
      [roomId]
    );
    if (!roomResult.rows.length) {
      return res.status(404).json({ ok: false, error: "Комната не найдена" });
    }
    const room = roomResult.rows[0];
    if (String(room.owner_telegram_id) !== String(user.id)) {
      return res.status(403).json({ ok: false, error: "Добавить тестового бота может только создатель комнаты" });
    }
    if (room.status !== "waiting") {
      return res.status(400).json({ ok: false, error: "Игра уже началась" });
    }
    if (Number(room.max_players) < 2) {
      return res.status(400).json({ ok: false, error: "Для игры с ботом выбери комнату минимум на 2 игроков" });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total
       FROM durak_room_players WHERE room_id = $1`,
      [roomId]
    );
    if (countResult.rows[0].total > 1) {
      return res.status(400).json({ ok: false, error: "В комнате уже есть другой игрок. Бот добавляется только в пустую комнату ожидания." });
    }

    await pool.query(
      `INSERT INTO durak_room_players (room_id, telegram_id, is_ready, display_name)
       VALUES ($1, 0, TRUE, '🤖 Бот ALLCOINS')
       ON CONFLICT (room_id, telegram_id)
       DO UPDATE SET is_ready = TRUE, display_name = '🤖 Бот ALLCOINS'`,
      [roomId]
    );

    return res.json({ ok: true, message: "Тестовый бот добавлен", bot: { label: "🤖 Бот ALLCOINS", isReady: true } });
  } catch (error) {
    console.error("Add Durak test bot error:", error.message);
    return res.status(500).json({ ok: false, error: "Не удалось добавить тестового бота" });
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
      `INSERT INTO durak_room_players (room_id, telegram_id, display_name)
       VALUES ($1, $2, $3)`,
      [roomId, telegramId, user.first_name || user.username || "Игрок"]
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
});

// Покинуть комнату ожидания до начала игры.
// Создатель закрывает всю ожидающую комнату, обычный игрок освобождает своё место.
app.post("/api/durak/rooms/leave", async (req, res) => {
  let client;
  let transactionOpen = false;
  try {
    const user = verifyTelegram(req.body?.initData);
    if (!user?.id) {
      return res.status(401).json({ ok: false, error: "Необходимо войти через Telegram" });
    }

    const roomId = req.body?.roomId;
    if (!roomId || !/^\\d+$/.test(String(roomId))) {
      return res.status(400).json({ ok: false, error: "Неверный номер комнаты" });
    }

    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;

    const roomResult = await client.query(
      `SELECT id, owner_telegram_id, status FROM durak_rooms WHERE id = $1 FOR UPDATE`,
      [roomId]
    );
    if (roomResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return res.status(404).json({ ok: false, error: "Комната не найдена" });
    }

    const room = roomResult.rows[0];
    if (room.status !== "waiting") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return res.status(400).json({ ok: false, error: "Выйти можно только до начала игры" });
    }

    const telegramId = String(user.id);
    const membership = await client.query(
      `SELECT 1 FROM durak_room_players WHERE room_id = $1 AND telegram_id = $2 FOR UPDATE`,
      [roomId, telegramId]
    );
    if (membership.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return res.status(403).json({ ok: false, error: "Ты уже не состоишь в этой комнате" });
    }

    const isOwner = String(room.owner_telegram_id) === telegramId;
    if (isOwner) {
      await client.query(`DELETE FROM durak_room_players WHERE room_id = $1`, [roomId]);
      await client.query(`DELETE FROM durak_rooms WHERE id = $1 AND status = 'waiting'`, [roomId]);
    } else {
      await client.query(
        `DELETE FROM durak_room_players WHERE room_id = $1 AND telegram_id = $2`,
        [roomId, telegramId]
      );
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return res.json({
      ok: true,
      ownerLeft: isOwner,
      message: isOwner ? "Комната закрыта. Ты вышел из комнаты." : "Ты вышел из комнаты."
    });
  } catch (error) {
    if (client && transactionOpen) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    console.error("Leave Durak room error:", error.message || error);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "Не удалось выйти из комнаты" });
    }
  } finally {
    client?.release();
  }
});

// Начало игры Дурак Онлайн
// Получить список игроков комнаты и их готовность
app.post("/api/durak/rooms/players", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user || !user.id) {
      return res.status(401).json({
        ok: false,
        error: "Не удалось проверить Telegram"
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

    const playerCheck = await pool.query(
      `SELECT 1
       FROM durak_room_players
       WHERE room_id = $1 AND telegram_id = $2`,
      [roomId, user.id]
    );

    if (playerCheck.rows.length === 0) {
      return res.status(403).json({
        ok: false,
        error: "Сначала войдите в комнату"
      });
    }

    const playersResult = await pool.query(
  `SELECT
     p.telegram_id,
     p.display_name,
     p.is_ready,
     (p.telegram_id = r.owner_telegram_id) AS is_owner
   FROM durak_room_players p
       JOIN durak_rooms r ON r.id = p.room_id
       WHERE p.room_id = $1
       ORDER BY p.joined_at`,
      [roomId]
    );

    const players = playersResult.rows.map((player, index) => ({
  label: String(player.telegram_id) === "0"
    ? "Бот ALLCOINS"
    : String(player.display_name || "").trim() ||
      (String(player.telegram_id) === String(user.id) ? "Ты" : "Игрок " + (index + 1)),
  isOwner: player.is_owner,
  isReady: room.status === "finished" ? player.is_ready : (player.is_owner || player.is_ready),
  isMe: String(player.telegram_id) === String(user.id)
}));

    return res.json({
      ok: true,
      room: {
        id: room.id,
        name: room.name,
        maxPlayers: room.max_players,
        status: room.status
      },
      players,
      playersCount: players.length
    });
  } catch (error) {
    console.error("Ошибка получения игроков:", error);

    return res.status(500).json({
      ok: false,
      error: "Не удалось получить список игроков"
    });
  }
});


// Отметить игрока как готового
app.post("/api/durak/rooms/ready", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user || !user.id) {
      return res.status(401).json({
        ok: false,
        error: "Не удалось проверить Telegram"
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
      `SELECT id, owner_telegram_id, status
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
    const isRematch = room.status === "finished";

    if (room.status !== "waiting" && !isRematch) {
      return res.status(400).json({
        ok: false,
        error: "Партия ещё идёт. Повторная готовность доступна после её завершения."
      });
    }

    // В первой партии создатель запускает игру сам. После завершения
    // все игроки, включая создателя, должны подтвердить новую партию.
    if (!isRematch && String(room.owner_telegram_id) === String(user.id)) {
      return res.status(400).json({
        ok: false,
        error: "Создателю комнаты не нужно нажимать «Готов»"
      });
    }

    const updateResult = await pool.query(
      `UPDATE durak_room_players
       SET is_ready = TRUE
       WHERE room_id = $1 AND telegram_id = $2
       RETURNING telegram_id`,
      [roomId, String(user.id)]
    );

    if (updateResult.rows.length === 0) {
      return res.status(403).json({
        ok: false,
        error: "Сначала войдите в комнату"
      });
    }

    if (!isRematch) {
      return res.json({
        ok: true,
        message: "Вы готовы к игре!"
      });
    }

    // Бот считается готовым автоматически; все реальные игроки должны
    // нажать «Готов к следующей игре» именно после окончания текущей партии.
    const readinessResult = await pool.query(
      `SELECT
         COUNT(*)::INTEGER AS total_players,
         COUNT(*) FILTER (
           WHERE telegram_id = 0 OR is_ready = TRUE
         )::INTEGER AS ready_players
       FROM durak_room_players
       WHERE room_id = $1`,
      [roomId]
    );

    const totalPlayers = Number(readinessResult.rows[0]?.total_players || 0);
    const readyPlayers = Number(readinessResult.rows[0]?.ready_players || 0);
    const allReady = totalPlayers >= 2 && readyPlayers === totalPlayers;
    let roomStatus = "finished";

    if (allReady) {
      const reopenResult = await pool.query(
        `UPDATE durak_rooms
         SET status = 'waiting'
         WHERE id = $1 AND status = 'finished'
         RETURNING id`,
        [roomId]
      );

      if (reopenResult.rows.length > 0) {
        roomStatus = "waiting";
      } else {
        const currentRoom = await pool.query(
          "SELECT status FROM durak_rooms WHERE id = $1",
          [roomId]
        );
        roomStatus = currentRoom.rows[0]?.status || "finished";
      }
    }

    return res.json({
      ok: true,
      rematch: true,
      allReady,
      readyPlayers,
      totalPlayers,
      roomStatus,
      message: allReady
        ? "Все готовы! Запускаем следующую партию в этой же комнате."
        : "Готовность отмечена. Ожидаем остальных игроков."
    });
  } catch (error) {
    console.error("Ошибка готовности игрока:", error);

    return res.status(500).json({
      ok: false,
      error: "Не удалось отметить готовность"
    });
  }
});

app.post("/api/durak/rooms/start", async (req, res) => {
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
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
    
     const roomResult = await client.query(
  `SELECT
     id,
     name,
     owner_telegram_id,
     max_players,
     stake,
     deck,
     speed,
     privacy,
     status
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
      // Восстанавливаем комнату, если предыдущий запуск оборвался
      // и статус сменился на playing, но состояние партии не сохранилось.
      const savedGame = await client.query(
        "SELECT room_id FROM durak_games WHERE room_id = $1",
        [roomId]
      );

      if (room.status === "playing" && savedGame.rows.length === 0) {
        await client.query(
          "UPDATE durak_rooms SET status = 'waiting' WHERE id = $1",
          [roomId]
        );
        room.status = "waiting";
        console.warn("Recovered stuck Durak room without game state:", String(roomId));
      } else {
        return res.status(400).json({
          ok: false,
          error: "Игра уже началась или завершена",
          roomId: String(roomId)
        });
      }
    }

    const countResult = await client.query(
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
    const selectedDeck = Number(room.deck);
    if (![36, 52].includes(selectedDeck)) {
      return res.status(400).json({
        ok: false,
        error: "В комнате выбрана неподдерживаемая колода. Создай новую комнату."
      });
    }
    if (total > 5 && selectedDeck !== 52) {
      return res.status(400).json({
        ok: false,
        error: "Для игры шестью игроками выбери колоду на 52 карты."
      });
    }
    // Проверяем готовность всех игроков, кроме создателя
    const readyResult = await client.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE p.telegram_id <> r.owner_telegram_id
         )::INTEGER AS total_guests,

         COUNT(*) FILTER (
           WHERE p.telegram_id <> r.owner_telegram_id
             AND p.is_ready = TRUE
         )::INTEGER AS ready_guests

       FROM durak_room_players p
       JOIN durak_rooms r ON r.id = p.room_id
       WHERE p.room_id = $1`,
      [roomId]
    );

    const totalGuests = readyResult.rows[0].total_guests;
    const readyGuests = readyResult.rows[0].ready_guests;

    if (readyGuests < totalGuests) {
      return res.status(409).json({
        ok: false,
        error: "Не все игроки готовы к игре",
        readyPlayers: readyGuests,
        totalPlayers: totalGuests
      });
    }
       // Создание и перемешивание колоды для Дурака
const deck = shuffleDurakDeck(createDurakDeck(Number(room.deck || 36)), crypto.randomInt);
        // Получаем игроков комнаты
    const playersResult = await client.query(
      `SELECT telegram_id
       FROM durak_room_players
       WHERE room_id = $1
       ORDER BY joined_at ASC`,
      [roomId]
    );

    // Списываем ставку со всех реальных участников внутри одной транзакции.
    // Если средств не хватит хотя бы одному игроку, вся операция откатится.
    const humanPlayerIds = [...new Set(
      playersResult.rows.map(row => String(row.telegram_id)).filter(id => id !== "0")
    )];
    const stakePerPlayer = Math.floor(Number(room.stake));
    if (!Number.isSafeInteger(stakePerPlayer) || stakePerPlayer <= 0 || !humanPlayerIds.length) {
      return res.status(400).json({ ok: false, error: "Некорректная ставка или нет реальных игроков" });
    }
    for (const telegramId of humanPlayerIds) {
      await client.query(
        `INSERT INTO players (telegram_id)
         VALUES ($1)
         ON CONFLICT (telegram_id) DO NOTHING`,
        [telegramId]
      );
      const debit = await client.query(
        `UPDATE players
         SET balance = balance - $1,
             updated_at = NOW()
         WHERE telegram_id = $2 AND balance >= $1
         RETURNING balance`,
        [stakePerPlayer, telegramId]
      );
      if (!debit.rows.length) {
        return res.status(400).json({
          ok: false,
          error: "У одного из игроков недостаточно AC для ставки. Списание отменено."
        });
      }
    }
    const grossPot = stakePerPlayer * humanPlayerIds.length;
    const burnedAmount = Math.floor(grossPot * 0.05);
    const payoutPool = grossPot - burnedAmount;

    // Раздаём карты через общий проверенный модуль правил.
    // Он гарантирует, что каждому игроку достанется 6 карт и останется козырь.
    let dealt;
    try {
      dealt = dealInitialHands(deck, playersResult.rows.length, 6);
    } catch (dealError) {
      return res.status(400).json({
        ok: false,
        error: "В колоде недостаточно карт для начала игры"
      });
    }

    const gamePlayers = playersResult.rows.map((row, index) => ({
      telegramId: String(row.telegram_id),
      hand: dealt.hands[index]
    }));
    const remainingDeck = dealt.deck;
    const trumpCard = dealt.trumpCard;
    const trumpSuit = dealt.trumpSuit;
        // Сохраняем состояние игры
     const startingPlayerIndex = chooseStartingPlayerIndex(
      dealt.hands,
      dealt.trumpSuit
    );
    const gameState = {
      players: gamePlayers,
      deck: remainingDeck,
      trumpCard,
      trumpSuit,
      table: [],
      currentPlayerIndex: startingPlayerIndex,
      attackerIndex: startingPlayerIndex,
      defenderIndex: (startingPlayerIndex + 1) % gamePlayers.length,
      phase: "attack",
      status: "playing",
      takePending: false,
      turnStartedAt: new Date().toISOString(),
      loserTelegramId: null,
      pot: {
        stakePerPlayer,
        contributors: humanPlayerIds,
        grossPot,
        burnPercent: 5,
        burnedAmount,
        payoutPool,
        settled: false,
        settlement: null
      }
    };

    // Если младший козырь у тестового бота, он сразу делает первый ход.
    if (String(gamePlayers[startingPlayerIndex]?.telegramId) === "0") {
      const botCardIndex = chooseBotAttackIndex(
        gamePlayers[startingPlayerIndex].hand,
        trumpSuit
      );
      if (botCardIndex >= 0) {
        const botCard = gamePlayers[startingPlayerIndex].hand.splice(botCardIndex, 1)[0];
        gameState.table.push({ attack: botCard, defense: null });
        gameState.phase = "defense";
      }
    }

    await client.query(
      `INSERT INTO durak_games (room_id, game_state, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (room_id)
       DO UPDATE SET
         game_state = EXCLUDED.game_state,
         updated_at = NOW()`,
      [roomId, JSON.stringify(gameState)]
    );
    const updateResult = await client.query(
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

    // Готовность текущей партии не переносим в следующую: после финала
    // все реальные игроки должны снова нажать «Готов».
    await client.query(
      `UPDATE durak_room_players
       SET is_ready = FALSE
       WHERE room_id = $1 AND telegram_id <> 0`,
      [roomId]
    );

    await client.query("COMMIT");
    transactionOpen = false;

    return res.json({
      ok: true,
      message: "Игра началась!",
      room: updateResult.rows[0],
      playersCount: total
    });
  } catch (error) {
    console.error("Start Durak game error:", error);

    return res.status(500).json({
      ok: false,
      error: "Не удалось начать игру",
      debugMessage: String(error?.message || error || "Неизвестная ошибка").slice(0, 300)
    });
  } finally {
    if (client && transactionOpen) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("Start Durak rollback error:", rollbackError.message); }
    }
    if (client) client.release();
  }
});
// Получение состояния игры Дурак Онлайн
app.post("/api/durak/game", async (req, res) => {
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

    // Проверяем, что игрок состоит в комнате
    const playerResult = await pool.query(
      `SELECT telegram_id
       FROM durak_room_players
       WHERE room_id = $1 AND telegram_id = $2`,
      [roomId, String(user.id)]
    );

    if (playerResult.rows.length === 0) {
      return res.status(403).json({
        ok: false,
        error: "Ты не состоишь в этой комнате"
      });
    }

    // Получаем состояние игры
    const gameResult = await pool.query(
      `SELECT game_state
       FROM durak_games
       WHERE room_id = $1`,
      [roomId]
    );

    if (gameResult.rows.length === 0) {
      // Самовосстановление: если комната уже переведена в playing, но запись
      // партии потерялась/не успела сохраниться, создаём начальное состояние.
      const roomCheck = await pool.query(
        `SELECT id, status, deck FROM durak_rooms WHERE id = $1`,
        [roomId]
      );
      const room = roomCheck.rows[0];
      if (room && room.status === "playing") {
        const playersResult = await pool.query(
          `SELECT telegram_id FROM durak_room_players WHERE room_id = $1 ORDER BY joined_at ASC`,
          [roomId]
        );
        const deckSize = Number(room.deck);
        if ([36, 52].includes(deckSize) && playersResult.rows.length >= 2 && playersResult.rows.length <= 6) {
          const shuffled = shuffleDurakDeck(createDurakDeck(deckSize), crypto.randomInt);
          const dealt = dealInitialHands(shuffled, playersResult.rows.length, 6);
          const players = playersResult.rows.map((row, index) => ({ telegramId: String(row.telegram_id), hand: dealt.hands[index] }));
          const starter = chooseStartingPlayerIndex(dealt.hands, dealt.trumpSuit);
          const repairedState = {
            players,
            deck: dealt.deck,
            trumpCard: dealt.trumpCard,
            trumpSuit: dealt.trumpSuit,
            table: [],
            currentPlayerIndex: starter,
            attackerIndex: starter,
            defenderIndex: (starter + 1) % players.length,
            phase: "attack",
            status: "playing",
            takePending: false,
            turnStartedAt: new Date().toISOString(),
            loserTelegramId: null
          };
          if (String(players[starter]?.telegramId) === "0") {
            const botIndex = chooseBotAttackIndex(players[starter].hand, dealt.trumpSuit);
            if (botIndex >= 0) {
              const botCard = players[starter].hand.splice(botIndex, 1)[0];
              repairedState.table.push({ attack: botCard, defense: null });
              repairedState.phase = "defense";
            }
          }
          await pool.query(
            `INSERT INTO durak_games (room_id, game_state, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (room_id) DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = NOW()`,
            [roomId, JSON.stringify(repairedState)]
          );
          gameResult.rows.push({ game_state: repairedState });
          console.warn("Recovered missing Durak game state for room:", String(roomId));
        }
      }
      if (gameResult.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "Игра ещё не подготовлена",
          roomId: String(roomId),
          roomStatus: room?.status || "missing"
        });
      }
    }

    let gameState = gameResult.rows[0].game_state;
    const stateBeforeTimeoutCheck = JSON.stringify(gameState);
    const timeoutCheck = expireDurakTurnIfNeeded(gameState);
    if (timeoutCheck.changed) {
      // Сравнение JSONB защищает новый ход от гонки с устаревшим опросом.
      const timeoutSave = await pool.query(
        `UPDATE durak_games
         SET game_state = $1::jsonb, updated_at = NOW()
         WHERE room_id = $2 AND game_state = $3::jsonb`,
        [JSON.stringify(gameState), roomId, stateBeforeTimeoutCheck]
      );
      if (timeoutSave.rowCount === 1) {
        if (timeoutCheck.timedOut) {
          await pool.query(
            "UPDATE durak_rooms SET status = 'finished' WHERE id = $1 AND status = 'playing'",
            [roomId]
          );
        }
      } else {
        const latestState = await pool.query(
          "SELECT game_state FROM durak_games WHERE room_id = $1",
          [roomId]
        );
        if (latestState.rows.length) gameState = latestState.rows[0].game_state;
      }
    }
    if (gameState?.status === "finished" && gameState?.pot && gameState.pot.settled !== true) {
      const payoutClient = await pool.connect();
      let payoutTransactionOpen = false;
      try {
        await payoutClient.query("BEGIN");
        payoutTransactionOpen = true;
        const lockedGame = await payoutClient.query(
          `SELECT game_state FROM durak_games WHERE room_id = $1 FOR UPDATE`,
          [roomId]
        );
        if (lockedGame.rows.length) {
          gameState = lockedGame.rows[0].game_state;
          if (gameState?.status === "finished" && gameState?.pot && gameState.pot.settled !== true) {
            await settleDurakGamePayout(payoutClient, gameState);
            await payoutClient.query(
              `UPDATE durak_games SET game_state = $1::jsonb, updated_at = NOW() WHERE room_id = $2`,
              [JSON.stringify(gameState), roomId]
            );
          }
          if (gameState?.status === "finished") {
            await payoutClient.query(
              "UPDATE durak_rooms SET status = 'finished' WHERE id = $1 AND status = 'playing'",
              [roomId]
            );
          }
        }
        await payoutClient.query("COMMIT");
        payoutTransactionOpen = false;
      } catch (payoutError) {
        if (payoutTransactionOpen) {
          try { await payoutClient.query("ROLLBACK"); }
          catch (rollbackError) { console.error("Payout recovery rollback error:", rollbackError.message); }
        }
        throw payoutError;
      } finally {
        payoutClient.release();
      }
    }

// Не пишем Telegram ID игроков в обычные логи.
    // Возвращаем игроку только его карты
    const me = gameState.players.find(
  (player) => String(player.telegramId) === String(user.id)
);

    if (!me) {
      return res.status(404).json({
        ok: false,
        error: "Карты игрока не найдены"
      });
    }

    const roomNamesResult = await pool.query(
      `SELECT telegram_id, display_name
       FROM durak_room_players
       WHERE room_id = $1`,
      [roomId]
    );
    const roomNames = new Map(
      roomNamesResult.rows.map(row => [
        String(row.telegram_id),
        row.display_name
      ])
    );
    const potState = gameState.pot && typeof gameState.pot === "object" ? gameState.pot : null;
    const payoutWinners = Array.isArray(potState?.settlement?.winners)
      ? potState.settlement.winners.map(award => ({
          name: roomNames.get(String(award.telegramId)) ||
            (String(award.telegramId) === String(user.id) ? (user.first_name || user.username || "Ты") : "Игрок"),
          amount: Math.max(0, Number(award.amount) || 0),
          isMe: String(award.telegramId) === String(user.id)
        }))
      : [];
    const visiblePot = potState ? {
      grossPot: Math.max(0, Number(potState.grossPot) || 0),
      burnedAmount: Math.max(0, Number(potState.burnedAmount) || 0),
      payoutPool: Math.max(0, Number(potState.payoutPool) || 0),
      burnPercent: 5,
      settled: potState.settled === true,
      myPrize: Math.max(0, Number(potState.settlement?.winners?.find(
        award => String(award.telegramId) === String(user.id)
      )?.amount) || 0),
      winners: payoutWinners
    } : null;

    return res.json({
  ok: true,
  roomId: String(roomId),
  hand: me.hand,
  trumpSuit: gameState.trumpSuit,
  trumpCard: gameState.trumpCard,
  table: gameState.table,
  cardsLeft: gameState.deck.length,
  status: gameState.status,
  hasLoser: Boolean(gameState.loserTelegramId),
  isLoser: String(gameState.loserTelegramId ?? "") === String(user.id),
  phase: gameState.phase,
  takePending: gameState.takePending === true,
  turnStartedAt: gameState.turnStartedAt || null,
  finishedReason: gameState.finishedReason || null,
  attackerIndex: gameState.attackerIndex,
  defenderIndex: gameState.defenderIndex,
  playerIndex: gameState.players.findIndex(
    p => String(p.telegramId) === String(user.id)
  ),
  players: gameState.players.map((p, index) => ({
    label: String(p.telegramId) === "0"
      ? "Бот ALLCOINS"
      : (roomNames.get(String(p.telegramId)) ||
        (String(p.telegramId) === String(user.id) ? (user.first_name || user.username || "Ты") : "Игрок " + (index + 1))),
    cardsCount: Array.isArray(p.hand) ? p.hand.length : 0
  })),
  pot: visiblePot
});
  } catch (error) {
    console.error("Get Durak game error:", error);

    return res.status(500).json({
      ok: false,
      error: "Не удалось загрузить игру",
      debugMessage: String(error?.message || error || "Неизвестная ошибка").slice(0, 300)
    });
  }
});
// Игровые действия Дурак Онлайн
app.post("/api/durak/action", async (req, res) => {
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;

    const user = verifyTelegram(req.body?.initData);

    if (!user?.id) {
      return res.status(401).json({
        ok: false,
        error: "Необходимо войти через Telegram"
      });
    }

    const { roomId, action, cardId } = req.body || {};
    const requestedCardIds = Array.isArray(req.body?.cardIds)
      ? [...new Set(req.body.cardIds.map(id => String(id)))]
      : (cardId != null ? [String(cardId)] : []);

    if (!roomId || !/^\d+$/.test(String(roomId))) {
      return res.status(400).json({
        ok: false,
        error: "Неверный номер комнаты"
      });
    }

    if (!["attack", "defend", "take", "beat"].includes(action)) {
      return res.status(400).json({
        ok: false,
        error: "Неизвестное действие"
      });
    }

    // Проверяем, что игрок находится в комнате
    const membership = await client.query(
      `SELECT telegram_id
       FROM durak_room_players
       WHERE room_id = $1 AND telegram_id = $2`,
      [roomId, String(user.id)]
    );

    if (!membership.rows.length) {
      return res.status(403).json({
        ok: false,
        error: "Ты не состоишь в этой комнате"
      });
    }

    // Загружаем состояние партии
    const result = await client.query(
      `SELECT game_state
       FROM durak_games
       WHERE room_id = $1
       FOR UPDATE`,
      [roomId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Игра ещё не началась"
      });
    }

    const game = result.rows[0].game_state;
    const actionRequestId = String(req.body?.actionRequestId || "").trim();

    if (actionRequestId && actionRequestId.length > 100) {
      return res.status(400).json({
        ok: false,
        error: "Неверный идентификатор действия"
      });
    }

    // Храним небольшой список последних обработанных запросов, а не только
    // самый последний: повторная доставка может прийти уже после следующего хода.
    // FOR UPDATE выше сериализует запросы комнаты.
    const processedActionRequestIds = Array.isArray(game?.processedActionRequestIds)
      ? game.processedActionRequestIds
      : (game?.lastActionRequestId ? [game.lastActionRequestId] : []);
    if (actionRequestId && processedActionRequestIds.includes(actionRequestId)) {
      return res.json({
        ok: true,
        duplicate: true,
        message: "Это действие уже было обработано"
      });
    }

    if (
      !game ||
      game.status !== "playing" ||
      !Array.isArray(game.players) ||
      !Array.isArray(game.table) ||
      !Array.isArray(game.deck)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Игра не активна или состояние повреждено"
      });
    }

    const timeoutCheck = expireDurakTurnIfNeeded(game);
    if (timeoutCheck.timedOut) {
      await settleDurakGamePayout(client, game);
      await client.query(
        `UPDATE durak_games
         SET game_state = $1::jsonb, updated_at = NOW()
         WHERE room_id = $2`,
        [JSON.stringify(game), roomId]
      );
      await client.query(
        "UPDATE durak_rooms SET status = 'finished' WHERE id = $1 AND status = 'playing'",
        [roomId]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return res.status(409).json({
        ok: false,
        error: "Время хода истекло — игрок автоматически проиграл",
        status: "finished",
        phase: "finished",
        finishedReason: "timeout",
        loserTelegramId: game.loserTelegramId
      });
    }

    const count = game.players.length;
    const attackerIndex = game.attackerIndex;
    const defenderIndex = game.defenderIndex;

    if (
      count < 2 ||
      !Number.isInteger(attackerIndex) ||
      !Number.isInteger(defenderIndex) ||
      attackerIndex < 0 ||
      defenderIndex < 0 ||
      attackerIndex >= count ||
      defenderIndex >= count ||
      attackerIndex === defenderIndex
    ) {
      return res.status(400).json({
        ok: false,
        error: "Некорректное состояние ходов. Создай новую игру."
      });
    }

    const playerIndex = game.players.findIndex(
      p => String(p.telegramId) === String(user.id)
    );

    if (playerIndex < 0) {
      return res.status(403).json({
        ok: false,
        error: "Игрок не найден в игре"
      });
    }

    const player = game.players[playerIndex];

    if (!Array.isArray(player.hand)) {
      return res.status(500).json({
        ok: false,
        error: "Не найдены карты игрока"
      });
    }

    const canBeatCard = (defense, attack) => beatsCard(defense, attack, game.trumpSuit);

    function nextActivePlayer(startIndex, excluded = []) {
      for (let step = 1; step <= count; step++) {
        const index = (startIndex + step) % count;

        if (excluded.includes(index)) continue;

        if (
          game.deck.length > 0 ||
          game.players[index].hand.length > 0
        ) {
          return index;
        }
      }

      return startIndex;
    }

    function markGameFinished() {
      game.status = "finished";
      game.phase = "finished";
      const playersWithCards = game.players.filter(
        p => Array.isArray(p.hand) && p.hand.length > 0
      );
      game.loserTelegramId = playersWithCards.length === 1
        ? String(playersWithCards[0].telegramId)
        : null;
    }

    function finishIfNeeded() {
      if (game.deck.length > 0) return false;

      const stillPlaying = game.players.filter(
        p => p.hand.length > 0
      );

      if (stillPlaying.length <= 1) {
        markGameFinished();
        return true;
      }

      return false;
    }

    function drawCardsAfterRound() {
      const order = [];

      order.push(attackerIndex);

      for (let i = 1; i < count; i++) {
        const index = (attackerIndex + i) % count;

        if (!order.includes(index)) {
          order.push(index);
        }
      }

      for (const index of order) {
        const target = game.players[index];

        while (
          target.hand.length < 6 &&
          game.deck.length > 0
        ) {
          target.hand.push(game.deck.shift());
        }
      }
    }

    // Разрешение «Беру»: после окончательного «Бито» все карты стола
    // переходят защищающемуся, но атакующий остаётся атакующим в следующем раунде.
    function finishTakingRound() {
      const taker = game.players[game.defenderIndex];
      for (const item of game.table) {
        if (item.attack) taker.hand.push(item.attack);
        if (item.defense) taker.hand.push(item.defense);
      }

      game.table = [];
      delete game.defenderHandAtRoundStart;
      delete game.takePending;

      drawCardsAfterRound();

      game.attackerIndex = attackerIndex;
      // В дуэли один на один после «Беру» тот же защищающийся принимает
      // следующую атаку; в игре от трёх игроков очередь переходит дальше по кругу.
      game.defenderIndex = count === 2
        ? defenderIndex
        : nextActivePlayer(defenderIndex, [attackerIndex]);
      if (game.defenderIndex === game.attackerIndex) {
        markGameFinished();
      } else {
        game.phase = "attack";
        finishIfNeeded();
      }
    }

    // АТАКА: можно перенести одну карту или сразу несколько карт одного достоинства.
    if (action === "attack") {
      if (playerIndex !== game.attackerIndex) {
        return res.status(403).json({
          ok: false,
          error: "Сейчас ход атакующего игрока"
        });
      }

      if (!requestedCardIds.length) {
        return res.status(400).json({
          ok: false,
          error: "Сначала выбери карту"
        });
      }

      if (
        game.phase !== "attack" &&
        game.phase !== "defense" &&
        !(game.phase === "takePending" && game.takePending === true)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Сейчас нельзя атаковать"
        });
      }

      // По правилам «Дурака» атакующий может подкидывать карты подходящего достоинства,
      // даже если защищающийся ещё не успел побить все карты на столе.

      const defender = game.players[game.defenderIndex];
      if (!Number.isInteger(game.defenderHandAtRoundStart)) {
        game.defenderHandAtRoundStart = defender.hand.length;
      }
      const attackLimit = Math.max(0, Math.min(
        game.defenderHandAtRoundStart,
        game.players[game.defenderIndex].hand.length + game.table.length
      ));
      if (game.table.length + requestedCardIds.length > attackLimit) {
        return res.status(400).json({
          ok: false,
          error: "Нельзя подкинуть больше карт, чем было у защищающегося в начале отбивания"
        });
      }

      const selectedCards = requestedCardIds.map(id =>
        player.hand.find(card => String(card.id) === id)
      );
      if (selectedCards.some(card => !card)) {
        return res.status(400).json({
          ok: false,
          error: "Одна или несколько выбранных карт отсутствуют в твоей руке"
        });
      }

      const selectedRank = selectedCards[0]?.rank;
      if (!selectedRank || selectedCards.some(card => card.rank !== selectedRank)) {
        return res.status(400).json({
          ok: false,
          error: "Одновременно можно атаковать только картами одного достоинства"
        });
      }

      if (game.table.length > 0) {
        const tableRanks = game.table.flatMap(item => [
          item.attack?.rank,
          item.defense?.rank
        ].filter(Boolean));
        if (!tableRanks.includes(selectedRank)) {
          return res.status(400).json({
            ok: false,
            error: "Можно подкинуть только карты достоинства, уже лежащего на столе"
          });
        }
      }

      // Сохраняем выбранный порядок и убираем карты с руки одним действием.
      const selectedIds = new Set(requestedCardIds);
      const cardsToPlay = player.hand.filter(card => selectedIds.has(String(card.id)));
      player.hand = player.hand.filter(card => !selectedIds.has(String(card.id)));
      for (const card of cardsToPlay) {
        game.table.push({ attack: card, defense: null });
      }
      // Если защищающийся уже нажал «Беру», дополнительные карты всё ещё
      // можно подкидывать, пока атакующий не завершит раунд кнопкой «Бито».
      game.phase = game.takePending ? "takePending" : "defense";
    }

    // ЗАЩИТА
    if (action === "defend") {
      if (playerIndex !== game.defenderIndex) {
        return res.status(403).json({
          ok: false,
          error: "Защищаться может только отбивающийся игрок"
        });
      }

      if (!cardId) {
        return res.status(400).json({
          ok: false,
          error: "Сначала выбери карту для защиты"
        });
      }

      const tableItem = game.table.find(
        item => item.attack && !item.defense
      );

      if (!tableItem) {
        return res.status(400).json({
          ok: false,
          error: "Нет открытой карты для защиты"
        });
      }

      const cardIndex = player.hand.findIndex(
        c => String(c.id) === String(cardId)
      );

      if (cardIndex < 0) {
        return res.status(400).json({
          ok: false,
          error: "Этой карты нет в твоей руке"
        });
      }

      const card = player.hand[cardIndex];

      if (!cardRank(card) || !cardRank(tableItem.attack)) {
        return res.status(400).json({
          ok: false,
          error: "Не удалось определить достоинство карты"
        });
      }

      if (!canBeatCard(card, tableItem.attack)) {
        return res.status(400).json({
          ok: false,
          error: "Этой картой нельзя побить атакующую карту"
        });
      }

            tableItem.defense = player.hand.splice(cardIndex, 1)[0];

const hasUnbeatenCards = game.table.some(
  item => item.attack && !item.defense
);

if (hasUnbeatenCards) {
  game.phase = "defense";
} else {
  game.phase = "attack";
}
    }

    // ВЗЯТЬ КАРТЫ
    if (action === "take") {
      if (playerIndex !== game.defenderIndex) {
        return res.status(403).json({
          ok: false,
          error: "Взять карты может только защищающийся игрок"
        });
      }

      if (game.table.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "На столе нет карт"
        });
      }

      // Если все карты уже побиты, защищающийся не может задним числом взять их.
      // В этой ситуации атакующий должен завершить раунд кнопкой «Бито».
      if (game.table.every(item => item.attack && item.defense)) {
        return res.status(400).json({
          ok: false,
          error: "Все карты уже побиты. Атакующий должен нажать «Бито»."
        });
      }

      // Нажатие «Беру» фиксирует намерение, но пока не забирает карты:
      // атакующий получает последнюю возможность подкинуть карты и нажать «Бито».
      game.takePending = true;
      game.phase = "takePending";
    }

    // ЗАВЕРШИТЬ ОТБИВАНИЕ / ПЕРЕДАТЬ ВЗЯТЫЕ КАРТЫ
if (action === "beat") {
  if (playerIndex !== game.attackerIndex) {
    return res.status(403).json({
      ok: false,
      error: "Объявить «Бито» может только атакующий игрок"
    });
  }

  if (game.takePending === true) {
    // Защищающийся заранее нажал «Беру»: завершение раунда отдаёт ему
    // все атакующие и защитные карты, в том числе последние подкинутые.
    finishTakingRound();
  } else {
    if (
      game.table.length === 0 ||
      !game.table.every(item => item.attack && item.defense)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Сначала нужно побить все карты на столе"
      });
    }

    game.table = [];
    delete game.defenderHandAtRoundStart;

    drawCardsAfterRound();

    game.attackerIndex = defenderIndex;
    game.defenderIndex = nextActivePlayer(game.attackerIndex);

    if (game.defenderIndex === game.attackerIndex) {
      markGameFinished();
    } else {
      game.phase = "attack";
      finishIfNeeded();
    }
  }
}

    // Автоматический ход тестового бота (telegram_id = 0).
    const botIndex = game.players.findIndex(p => String(p.telegramId) === "0");
    if (botIndex >= 0) {
      for (let botStep = 0; botStep < 12 && game.status === "playing"; botStep++) {
        // Бот-защитник уже нажал «Беру» и ждёт решения атакующего — не отбивается снова.
        if (game.takePending === true && game.defenderIndex === botIndex) break;

        if (game.attackerIndex === botIndex) {
          const bot = game.players[botIndex];
          const defender = game.players[game.defenderIndex];
          if (!Number.isInteger(game.defenderHandAtRoundStart)) {
            game.defenderHandAtRoundStart = defender.hand.length + game.table.length;
          }
          const canAddMore = game.table.length < game.defenderHandAtRoundStart;

          // Если человек взял карты, бот подкидывает все допустимые карты,
          // затем завершает раунд и передаёт стол защищающемуся.
          if (game.takePending === true) {
            const ranksOnTable = game.table.flatMap(item =>
              [item.attack?.rank, item.defense?.rank].filter(Boolean)
            );
            const extraIndex = canAddMore && bot.hand.length
              ? chooseBotAttackIndex(bot.hand, game.trumpSuit, ranksOnTable)
              : -1;
            if (extraIndex >= 0) {
              const extraCard = bot.hand.splice(extraIndex, 1)[0];
              game.table.push({ attack: extraCard, defense: null });
              game.phase = "takePending";
              continue;
            }
            finishTakingRound();
            continue;
          }

          let candidateIndex = -1;

          if (game.table.length === 0) {
            if (!bot.hand.length) {
              finishIfNeeded();
              break;
            }
            candidateIndex = chooseBotAttackIndex(bot.hand, game.trumpSuit);
          } else if (canAddMore && bot.hand.length > 0) {
            const tableRanks = game.table.flatMap(item =>
              [item.attack?.rank, item.defense?.rank].filter(Boolean)
            );
            candidateIndex = chooseBotAttackIndex(bot.hand, game.trumpSuit, tableRanks);
          }

          if (candidateIndex >= 0) {
            const botCard = bot.hand.splice(candidateIndex, 1)[0];
            game.table.push({ attack: botCard, defense: null });
            game.phase = "defense";
            break;
          }

          // Бот завершает атаку только когда больше не может подкинуть карту.
          if (game.table.length > 0 && game.table.every(item => item.defense)) {
            game.table = [];
            delete game.defenderHandAtRoundStart;
            drawCardsAfterRound();
            game.attackerIndex = game.defenderIndex;
            game.defenderIndex = nextActivePlayer(game.attackerIndex);
            if (game.defenderIndex === game.attackerIndex) {
              markGameFinished();
            } else {
              game.phase = "attack";
              finishIfNeeded();
            }
            continue;
          }
          break;
        }

        if (game.defenderIndex === botIndex) {
          const openItem = game.table.find(item => item.attack && !item.defense);
          if (!openItem) break;
          const bot = game.players[botIndex];
          const defenseIndex = chooseBotDefenseIndex(bot.hand, openItem.attack, game.trumpSuit);
          if (defenseIndex >= 0) {
            openItem.defense = bot.hand.splice(defenseIndex, 1)[0];
            game.phase = game.table.some(item => item.attack && !item.defense)
              ? "defense"
              : "attack";
            // Продолжаем отбивать остальные открытые атаки в этом же запросе.
            continue;
          } else {
            // Бот объявляет, что берёт карты, но отдаёт их только после того,
            // как атакующий получит возможность подкинуть и нажать «Бито».
            game.takePending = true;
            game.phase = "takePending";
          }
          break;
        }
        break;
      }
    }

    if (game.status === "playing") {
      game.turnStartedAt = new Date().toISOString();
    }

    // Сохраняем последние 100 идентификаторов вместе с состоянием партии.
    // Это защищает и от повторной доставки старого запроса после новых ходов.
    if (actionRequestId) {
      game.processedActionRequestIds = [
        ...processedActionRequestIds.filter(id => id !== actionRequestId),
        actionRequestId
      ].slice(-100);
      game.lastActionRequestId = actionRequestId; // совместимость со старым состоянием партии
    }

    // Завершённая партия: сжигаем 5% банка, остаток распределяем победителям.
    if (game.status === "finished") {
      await settleDurakGamePayout(client, game);
      await client.query(
        "UPDATE durak_rooms SET status = 'finished' WHERE id = $1 AND status = 'playing'",
        [roomId]
      );
    }

    // Сохраняем состояние партии и выплаты одной транзакцией.
    await client.query(
      `UPDATE durak_games
       SET game_state = $1::jsonb,
           updated_at = NOW()
       WHERE room_id = $2`,
      [JSON.stringify(game), roomId]
    );

    await client.query("COMMIT");
    transactionOpen = false;

    return res.json({
      ok: true,
      message: "Игровое действие выполнено",
      phase: game.phase,
      attackerIndex: game.attackerIndex,
      defenderIndex: game.defenderIndex,
      status: game.status,
      table: game.table,
      cardsLeft: game.deck.length
    });
  } catch (error) {
    if (client && transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Durak action rollback error:", rollbackError.message);
      }
      transactionOpen = false;
    }
    console.error("Durak action error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Не удалось выполнить действие"
    });
  } finally {
    // Любой ранний ответ до COMMIT должен отменить транзакцию.
    if (client && transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Durak action cleanup rollback error:", rollbackError.message);
      }
    }
    if (client) client.release();
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
       // Поле готовности игрока к началу партии
    await pool.query(`
      ALTER TABLE durak_room_players
      ADD COLUMN IF NOT EXISTS is_ready BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
      ALTER TABLE durak_room_players
      ADD COLUMN IF NOT EXISTS display_name TEXT
    `);

    console.log("Durak player readiness and display-name columns are ready");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS durak_games (
        room_id BIGINT PRIMARY KEY
          REFERENCES durak_rooms(id) ON DELETE CASCADE,
        game_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      ALTER TABLE durak_rooms
      ADD COLUMN IF NOT EXISTS deck INTEGER NOT NULL DEFAULT 36
    `);

    await pool.query(`
      ALTER TABLE durak_rooms
      ADD COLUMN IF NOT EXISTS speed TEXT NOT NULL DEFAULT 'normal'
    `);

    await pool.query(`
      ALTER TABLE durak_rooms
      ADD COLUMN IF NOT EXISTS privacy TEXT NOT NULL DEFAULT 'public'
    `);
    console.log("Durak games table is ready");

    const durakRoomCleanupTimer = setInterval(() => {
      cleanupExpiredEmptyDurakRooms().catch((error) => {
        console.error("Durak room cleanup error:", error.message);
      });
    }, 15000);
    if (typeof durakRoomCleanupTimer.unref === "function") {
      durakRoomCleanupTimer.unref();
    }

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
