import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "node:crypto";
import { createDurakDeck, shuffleDurakDeck, cardRank, beatsCard, dealInitialHands, chooseBotAttackIndex, chooseBotDefenseIndex, chooseStartingPlayerIndex } from "./durak-rules.js";

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
});// Начало игры Дурак Онлайн
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
    ? "🤖 Бот ALLCOINS"
    : player.is_owner
      ? "Создатель комнаты"
      : "Игрок " + (index + 1),
  isOwner: player.is_owner,
  isReady: player.is_owner || player.is_ready,
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

    if (room.status !== "waiting") {
      return res.status(400).json({
        ok: false,
        error: "Комната уже не ожидает игроков"
      });
    }

    if (String(room.owner_telegram_id) === String(user.id)) {
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
      [roomId, user.id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(403).json({
        ok: false,
        error: "Сначала войдите в комнату"
      });
    }

    return res.json({
      ok: true,
      message: "Вы готовы к игре!"
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
    const readyResult = await pool.query(
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
    const playersResult = await pool.query(
      `SELECT telegram_id
       FROM durak_room_players
       WHERE room_id = $1
       ORDER BY joined_at ASC`,
      [roomId]
    );

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
      status: "playing"
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

    await pool.query(
      `INSERT INTO durak_games (room_id, game_state, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (room_id)
       DO UPDATE SET
         game_state = EXCLUDED.game_state,
         updated_at = NOW()`,
      [roomId, JSON.stringify(gameState)]
    );
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
  const roomCheck = await pool.query(
    `SELECT id, status
     FROM durak_rooms
     WHERE id = $1`,
    [roomId]
  );

  const allGames = await pool.query(
    `SELECT room_id
     FROM durak_games
     ORDER BY updated_at DESC
     LIMIT 10`
  );

  console.error("DURAK GAME NOT FOUND:", {
    requestedRoomId: String(roomId),
    roomExists: roomCheck.rows.length > 0,
    roomStatus: roomCheck.rows[0]?.status || null,
    savedGameRoomIds: allGames.rows.map(
      row => String(row.room_id)
    )
  });

  return res.status(404).json({
    ok: false,
    error: "Игра ещё не подготовлена",
    roomId: String(roomId)
  });
    }

    const gameState = gameResult.rows[0].game_state;
console.log("DURAK DEBUG:", {
  roomId: String(roomId),
  currentTelegramId: String(user.id),
  playersInGame: Array.isArray(gameState.players)
    ? gameState.players.map(player => ({
        telegramId: String(player.telegramId),
        cards: Array.isArray(player.hand) ? player.hand.length : "нет массива карт"
      }))
    : "список игроков отсутствует"
});
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

    return res.json({
  ok: true,
  roomId: String(roomId),
  hand: me.hand,
  trumpSuit: gameState.trumpSuit,
  trumpCard: gameState.trumpCard,
  table: gameState.table,
  cardsLeft: gameState.deck.length,
  status: gameState.status,
  phase: gameState.phase,
  attackerIndex: gameState.attackerIndex,
  defenderIndex: gameState.defenderIndex,
  playerIndex: gameState.players.findIndex(
    p => String(p.telegramId) === String(user.id)
  ),
  players: gameState.players.map((p, index) => ({
    telegramId: String(p.telegramId),
    label: String(p.telegramId) === "0"
      ? "🤖 Бот ALLCOINS"
      : String(p.telegramId) === String(user.id)
        ? "👤 " + (user.first_name || user.username || "Ты")
        : "👤 " + (roomNames.get(String(p.telegramId)) || "Игрок " + (index + 1)),
    cardsCount: Array.isArray(p.hand) ? p.hand.length : 0
  }))
});
  } catch (error) {
    console.error("Get Durak game error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Не удалось загрузить игру"
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

    function finishIfNeeded() {
      if (game.deck.length > 0) return false;

      const stillPlaying = game.players.filter(
        p => p.hand.length > 0
      );

      if (stillPlaying.length <= 1) {
        game.status = "finished";
        game.phase = "finished";
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

    // АТАКА
    if (action === "attack") {
      if (playerIndex !== game.attackerIndex) {
        return res.status(403).json({
          ok: false,
          error: "Сейчас ход атакующего игрока"
        });
      }

      if (!cardId) {
        return res.status(400).json({
          ok: false,
          error: "Сначала выбери карту"
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

      if (game.phase !== "attack" && game.phase !== "defense") {
        return res.status(400).json({
          ok: false,
          error: "Сейчас нельзя атаковать"
        });
      }

      if (game.table.some(item => !item.defense)) {
        return res.status(400).json({
          ok: false,
          error: "Сначала защищающийся должен побить открытую карту или взять карты"
        });
      }

      const defender = game.players[game.defenderIndex];

      if (game.table.length >= defender.hand.length &&
          game.table.length > 0) {
        return res.status(400).json({
          ok: false,
          error: "Нельзя подкинуть больше карт, чем у защищающегося игрока"
        });
      }

      const selectedCard = player.hand[cardIndex];

      if (game.table.length > 0) {
        const tableRanks = game.table.flatMap(item => [
          item.attack?.rank,
          item.defense?.rank
        ].filter(Boolean));

        if (!tableRanks.includes(selectedCard.rank)) {
          return res.status(400).json({
            ok: false,
            error: "Можно подкинуть только карту достоинства, уже лежащего на столе"
          });
        }
      }

      const card = player.hand.splice(cardIndex, 1)[0];

      game.table.push({
        attack: card,
        defense: null
      });

      game.phase = "defense";
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

      for (const item of game.table) {
        if (item.attack) player.hand.push(item.attack);
        if (item.defense) player.hand.push(item.defense);
      }

      game.table = [];

      drawCardsAfterRound();

      game.attackerIndex = attackerIndex;
      game.defenderIndex = nextActivePlayer(
        defenderIndex,
        [attackerIndex]
      );

      if (game.defenderIndex === game.attackerIndex) {
        game.status = "finished";
        game.phase = "finished";
      } else {
        game.phase = "attack";
        finishIfNeeded();
      }
    }

    // ЗАВЕРШИТЬ ОТБИВАНИЕ
if (action === "beat") {
  if (playerIndex !== game.attackerIndex) {
    return res.status(403).json({
      ok: false,
      error: "Объявить «Бито» может только атакующий игрок"
    });
  }

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

      drawCardsAfterRound();

      game.attackerIndex = defenderIndex;
      game.defenderIndex = nextActivePlayer(
        game.attackerIndex
      );

      if (game.defenderIndex === game.attackerIndex) {
        game.status = "finished";
        game.phase = "finished";
      } else {
        game.phase = "attack";
        finishIfNeeded();
      }
    }

    // Автоматический ход тестового бота (telegram_id = 0).
    const botIndex = game.players.findIndex(p => String(p.telegramId) === "0");
    if (botIndex >= 0) {
      for (let botStep = 0; botStep < 3 && game.status === "playing"; botStep++) {
        if (game.attackerIndex === botIndex) {
          if (game.table.some(item => !item.defense)) break;
          const bot = game.players[botIndex];
          const defender = game.players[game.defenderIndex];
          const canAddMore = game.table.length < defender.hand.length;
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
            drawCardsAfterRound();
            game.attackerIndex = game.defenderIndex;
            game.defenderIndex = nextActivePlayer(game.attackerIndex);
            if (game.defenderIndex === game.attackerIndex) {
              game.status = "finished";
              game.phase = "finished";
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
              ? "defend"
              : "attack";
          } else {
            for (const item of game.table) {
              if (item.attack) bot.hand.push(item.attack);
              if (item.defense) bot.hand.push(item.defense);
            }
            game.table = [];
            drawCardsAfterRound();
            game.attackerIndex = attackerIndex;
            game.defenderIndex = nextActivePlayer(defenderIndex, [attackerIndex]);
            if (game.defenderIndex === game.attackerIndex) {
              game.status = "finished";
              game.phase = "finished";
            } else {
              game.phase = "attack";
              finishIfNeeded();
            }
          }
          break;
        }
        break;
      }
    }

    // Сохраняем состояние партии внутри транзакции.
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
