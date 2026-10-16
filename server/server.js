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

       // Создание колоды для Дурака
    const suits = ["♠", "♥", "♦", "♣"];
    const ranks = [
  "6", "7", "8", "9", "10", "В", "Д", "К", "Т"
];

    const deck = [];

    for (const suit of suits) {
      for (const rank of ranks) {
        deck.push({
          suit,
          rank,
          id: `${rank}${suit}`
        });
      }
    }

    // Перемешивание колоды
    for (let i = deck.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    } 
        // Получаем игроков комнаты
    const playersResult = await pool.query(
      `SELECT telegram_id
       FROM durak_room_players
       WHERE room_id = $1
       ORDER BY joined_at ASC`,
      [roomId]
    );

    const gamePlayers = playersResult.rows.map((row) => ({
      telegramId: String(row.telegram_id),
      hand: []
    }));

    // Раздаём по 6 карт каждому игроку
    for (const player of gamePlayers) {
      for (let i = 0; i < 6; i++) {
        player.hand.push(deck.pop());
      }
    }

    // Определяем козырь
    const trumpCard = deck[deck.length - 1];
    const trumpSuit = trumpCard.suit;
        // Сохраняем состояние игры
     const gameState = {
  players: gamePlayers,
  deck,
  trumpCard,
  trumpSuit,
  table: [],
  currentPlayerIndex: 0,
  attackerIndex: 0,
  defenderIndex: 1,
  phase: "attack",
  status: "playing"
};
  players: gamePlayers,
  deck,
  trumpCard,
  trumpSuit,
  table: [],
  currentPlayerIndex: 0,
  attackerIndex: 0,
  defender

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
      return res.status(404).json({
        ok: false,
        error: "Игра ещё не подготовлена"
      });
    }

    const gameState = gameResult.rows[0].game_state;

    // Возвращаем игроку только его карты
    const me = gameState.players.find(
      (player) => player.telegramId === String(user.id)
    );

    if (!me) {
      return res.status(404).json({
        ok: false,
        error: "Карты игрока не найдены"
      });
    }

    return res.json({
      ok: true,
      roomId: String(roomId),
      hand: me.hand,
      trumpSuit: gameState.trumpSuit,
      trumpCard: gameState.trumpCard,
      table: gameState.table,
      cardsLeft: gameState.deck.length,
      status: gameState.status
    });
  } catch (error) {
    console.error("Get Durak game error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Не удалось загрузить игру"
    });
  }
});
// Игровое действие Дурак Онлайн
app.post("/api/durak/action", async (req, res) => {
  try {
    const user = verifyTelegram(req.body?.initData);

    if (!user || !user.id) {
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

    const allowedActions = ["attack", "defend", "take", "beat"];

    if (!allowedActions.includes(action)) {
      return res.status(400).json({
        ok: false,
        error: "Неизвестное действие"
      });
    }

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

        const gameResult = await pool.query(
      `SELECT game_state
       FROM durak_games
       WHERE room_id = $1`,
      [roomId]
    );

    if (gameResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Игра ещё не началась"
      });
    }

    const game = gameResult.rows[0].game_state;

    if (!game || game.status !== "playing") {
      return res.status(400).json({
        ok: false,
        error: "Игра не активна"
      });
    }

    if (!Array.isArray(game.players) ||
        !Array.isArray(game.table) ||
        !Array.isArray(game.deck)) {
      return res.status(500).json({
        ok: false,
        error: "Некорректное состояние игры"
      });
    }

    const playerIndex = game.players.findIndex(
      (player) => String(player.telegramId) === String(user.id)
    );

    if (playerIndex === -1) {
      return res.status(403).json({
        ok: false,
        error: "Игрок не найден в игре"
      });
    }

    const player = game.players[playerIndex];
    if (
  !Number.isInteger(game.attackerIndex) ||
  !Number.isInteger(game.defenderIndex) ||
  game.attackerIndex < 0 ||
  game.defenderIndex < 0 ||
  game.attackerIndex >= game.players.length ||
  game.defenderIndex >= game.players.length ||
  game.attackerIndex === game.defenderIndex
) {
  return res.status(400).json({
    ok: false,
    error: "Некорректное состояние ходов. Создай новую игру."
  });
      }
    if (!Array.isArray(player.hand)) {
      return res.status(500).json({
        ok: false,
        error: "Не найдены карты игрока"
      });
    }

    if (action === "attack") {
      if (!cardId) {
        return res.status(400).json({
          ok: false,
          error: "Сначала выбери карту"
        });
      }

      if (playerIndex !== game.attackerIndex) {
  return res.status(400).json({
    ok: false,
    error: "Сейчас ход атакующего игрока"
  });
      }

      const cardIndex = player.hand.findIndex(
        (card) => String(card.id) === String(cardId)
      );

      if (cardIndex === -1) {
        return res.status(400).json({
          ok: false,
          error: "Этой карты нет в твоей руке"
        });
      }

      if (game.table.length > 0) {
  const ranksOnTable = game.table.flatMap((item) => [
    item.attack.rank,
    ...(item.defense ? [item.defense.rank] : [])
  ]);

  const selectedCard = player.hand[cardIndex];

  if (!ranksOnTable.includes(selectedCard.rank)) {
    return res.status(400).json({
      ok: false,
      error: "Можно подкинуть только карту достоинства, которое уже есть на столе"
    });
  }
      }

      const card = player.hand.splice(cardIndex, 1)[0];

            game.table.push({
        attack: card,
        defense: null
      });
    }

    if (action === "defend") {
      if (game.table.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "На столе нет карт для защиты"
        });
      }

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

      const cardIndex = player.hand.findIndex(
        (card) => String(card.id) === String(cardId)
      );

      if (cardIndex === -1) {
        return res.status(400).json({
          ok: false,
          error: "Этой карты нет в твоей руке"
        });
      }

      const tableItem = game.table.find(
        (item) => item.attack && !item.defense
      );

      if (!tableItem) {
        return res.status(400).json({
          ok: false,
          error: "Нет карт, которые нужно побить"
        });
      }

      const card = player.hand[cardIndex];
      const attackCard = tableItem.attack;

      const ranks = [
        "6", "7", "8", "9", "10", "J", "Q", "K", "A"
      ];

      const cardRank = ranks.indexOf(String(card.rank));
      const attackRank = ranks.indexOf(String(attackCard.rank));

      const canBeat =
        (card.suit === attackCard.suit &&
          cardRank > attackRank) ||
        (card.suit === game.trumpSuit &&
          attackCard.suit !== game.trumpSuit);

      if (!canBeat) {
        return res.status(400).json({
          ok: false,
          error: "Этой картой нельзя побить атакующую карту"
        });
      }

      tableItem.defense = player.hand.splice(cardIndex, 1)[0];
    }

        if (action === "take") {
      if (game.table.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "На столе нет карт"
        });
      }

      if (playerIndex !== game.defenderIndex) {
        return res.status(403).json({
          ok: false,
          error: "Взять карты может только защищающийся игрок"
        });
      }

      const cardsToTake = [];

      for (const item of game.table) {
        if (item.attack) cardsToTake.push(item.attack);
        if (item.defense) cardsToTake.push(item.defense);
      }

      player.hand.push(...cardsToTake);
      game.table = [];
        }
      if (game.table.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "На столе нет карт"
        });
      }
     if (playerIndex !== game.defenderIndex) {
  return res.status(403).json({
    ok: false,
    error: "Объявить «Бито» может только защищающийся игрок"
  });
     }
      const allBeaten = game.table.every(
        (item) => item.attack && item.defense
      );

      if (!allBeaten) {
        return res.status(400).json({
          ok: false,
          error: "Сначала нужно побить все карты на столе"
        });
      }

      game.table = [];
    }

    await pool.query(
      `UPDATE durak_games
       SET game_state = $1
       WHERE room_id = $2`,
      [JSON.stringify(game), roomId]
    );

    return res.json({
      ok: true,
      message: "Игровое действие выполнено"
    });
  } catch (error) {
    console.error("Durak action error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Не удалось выполнить действие"
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
