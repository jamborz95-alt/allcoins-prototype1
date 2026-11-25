import express from "express";

const ROOM_PREFIX = "DR-";
const RACE_WINNER_REWARD = 0n;
const MIN_RACE_FINISH_MS = 7000;
const MAX_FINISH_TIME_DRIFT_MS = 2500;
const VALID_MODES = new Set(["quarter", "half", "sprint"]);
const RACE_DISTANCE_METERS = Object.freeze({ quarter: 1609.344, half: 3218.688, sprint: 4000 });
const DEFAULT_TUNE = Object.freeze({ ecu: 50, boost: 25, grip: 70, shift: 45 });
const BODY_PAINTS = Object.freeze({
  white: { price: 2000, color: "#ffffff" },
  black: { price: 2000, color: "#08090b" },
  green: { price: 2000, color: "#176b40" },
  blue: { price: 2000, color: "#174f9c" },
  sochi: { price: 2000, color: "#74887e" },
  red: { price: 2000, color: "#c62932" },
  yellow: { price: 2000, color: "#f0cf27" }
});

// Three permanent upgrade stages per part; the server owns the price list.
const RACING_PARTS = Object.freeze({
  ecu: [3000, 6000, 12000],
  turbo: [5000, 10000, 20000],
  intake: [2500, 5000, 9000],
  exhaust: [2500, 5000, 9000],
  gearbox: [6000, 12000, 24000],
  clutch: [3500, 7000, 14000],
  diff: [4500, 9000, 18000],
  tires: [3000, 6000, 12000]
});
const CARS = Object.freeze({
  "2107": { price: 50000, power: 72 },
  "2101": { price: 2500, power: 58 },
  "2105": { price: 3500, power: 64 },
  "2104": { price: 4500, power: 75 },
  "2106": { price: 6000, power: 75 },
  "2109": { price: 7500, power: 70 },
  "2110": { price: 11000, power: 78 },
  priora: { price: 18000, power: 98 },
  kalina: { price: 25000, power: 87 },
  granta: { price: 35000, power: 90 },
  niva: { price: 50000, power: 83 },
  vesta: { price: 85000, power: 106 }
});
const RIM_OPTIONS = Object.freeze({
  stock: { price: 0, name: "Заводские штампованные" },
  sport5: { price: 5000, name: "Sport 5 Spoke" },
  mesh10: { price: 7000, name: "Mesh Multi-Spoke" },
  turbine: { price: 6500, name: "Turbo Turbine" },
  classic8: { price: 4500, name: "Classic 8 Hole" }
});
const PARTS = Object.freeze({
  ecu: { price: 0, power: 8 },
  intake: { price: 18000, power: 5 },
  exhaust: { price: 32000, power: 7 },
  turbo: { price: 95000, power: 22 },
  clutch: { price: 22000, power: 2 },
  tires: { price: 28000, power: 3 },
  gearbox: { price: 48000, power: 6 },
  weight: { price: 65000, power: 10 }
});
const PAINT_OPTIONS = Object.freeze({
  factory: { color: "#dfe3e6", price: 0 }
});
const VINYL_OPTIONS = Object.freeze({
  none: { price: 0 },
  rally: { price: 0 },
  checker: { price: 0 },
  sport: { price: 0 },
  number: { price: 0 }
});
function normalizeCustomization(value) {
  const input = objectValue(value);
  return {
    paintId: "factory",
    vinylId: Object.hasOwn(VINYL_OPTIONS, String(input.vinylId || "")) ? String(input.vinylId) : "none",
    brushStrokes: []
  };
}

function isValidDragRaceFinishTime(timeMs, elapsedSinceGreen) {
  const reported = Math.round(Number(timeMs));
  const elapsed = Math.round(Number(elapsedSinceGreen));
  return Number.isSafeInteger(reported) &&
    Number.isSafeInteger(elapsed) &&
    reported >= MIN_RACE_FINISH_MS &&
    elapsed >= MIN_RACE_FINISH_MS &&
    Math.abs(reported - elapsed) <= MAX_FINISH_TIME_DRIFT_MS;
}

class DragRacingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseRoomId(value) {
  const match = String(value ?? "").trim().match(/^(?:DR-)?([1-9]\d{0,17})$/);
  return match ? match[1] : null;
}

function displayName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return String(name || user?.username || "Игрок").slice(0, 40);
}

function requireUser(req, res, verifyTelegram) {
  const verified = verifyTelegram(req.body?.initData);
  if (!verified?.id) {
    res.status(401).json({ ok: false, error: "Открой «Драг-рейсинг» через ALLCOINS в Telegram." });
    return null;
  }
  return { id: String(verified.id), name: displayName(verified) };
}

function objectValue(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch { return fallback; }
  }
  return fallback;
}

async function lockPlayerBalance(client, user) {
  await client.query(
    "INSERT INTO players (telegram_id) VALUES ($1::BIGINT) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW()",
    [user.id]
  );
  const result = await client.query(
    "SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1::BIGINT FOR UPDATE",
    [user.id]
  );
  if (!result.rows.length) throw new DragRacingError(500, "Не удалось открыть баланс игрока.");
  return BigInt(String(result.rows[0].balance || "0"));
}

async function ensureProfile(client, telegramId) {
  await client.query(
    "INSERT INTO drag_racing_player_profiles (telegram_id) VALUES ($1::BIGINT) ON CONFLICT (telegram_id) DO NOTHING",
    [String(telegramId)]
  );
  // VAZ-2110 remains the free starter car. VAZ-2107 is bought or earned via rewarded ad.
  await client.query(
    "INSERT INTO drag_racing_player_cars (telegram_id, car_id, upgrades) VALUES ($1::BIGINT, '2110', '{}'::jsonb) ON CONFLICT (telegram_id, car_id) DO NOTHING",
    [String(telegramId)]
  );
}

async function readProfile(client, telegramId) {
  await ensureProfile(client, telegramId);
  const [profileResult, carsResult] = await Promise.all([
    client.query(
      "SELECT selected_car_id, tuning FROM drag_racing_player_profiles WHERE telegram_id = $1::BIGINT",
      [String(telegramId)]
    ),
    client.query(
      "SELECT car_id, upgrades, customization FROM drag_racing_player_cars WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC, car_id ASC",
      [String(telegramId)]
    )
  ]);
  const profileRow = profileResult.rows[0] || {};
  const ownedCars = carsResult.rows.map(row => String(row.car_id));
  const upgrades = {};
  const customization = {};
  for (const row of carsResult.rows) {
    upgrades[String(row.car_id)] = objectValue(row.upgrades);
    customization[String(row.car_id)] = normalizeCustomization(row.customization);
  }
  const tuning = { ...DEFAULT_TUNE, ...objectValue(profileRow.tuning, DEFAULT_TUNE) };
  return {
    selectedCarId: ownedCars.includes(String(profileRow.selected_car_id)) ? String(profileRow.selected_car_id) : (ownedCars.includes("2107") ? "2107" : "2110"),
    ownedCars: ownedCars.length ? ownedCars : ["2107", "2110"],
    upgrades,
    customization,
    tune: Object.fromEntries(Object.entries(DEFAULT_TUNE).map(([key, fallback]) => {
      const value = Number(tuning[key]);
      return [key, Number.isInteger(value) ? Math.max(0, Math.min(100, value)) : fallback];
    }))
  };
}

async function readBalance(client, telegramId) {
  const result = await client.query(
    "SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1::BIGINT",
    [String(telegramId)]
  );
  return Number(result.rows[0]?.balance || 0);
}

async function sendProfile(res, client, telegramId) {
  const profile = await readProfile(client, telegramId);
  return res.json({ ok: true, balance: await readBalance(client, telegramId), profile });
}

async function readRacingPartsInventory(client, telegramId) {
  const result = await client.query(
    "SELECT part_id, level, is_installed FROM drag_racing_player_parts " +
    "WHERE telegram_id = $1::BIGINT ORDER BY part_id ASC",
    [String(telegramId)]
  );
  const ownedParts = {};
  const installedParts = {};
  const storedParts = {};
  for (const row of result.rows) {
    const id = String(row.part_id);
    const level = Math.max(1, Math.min(3, Number(row.level) || 1));
    ownedParts[id] = level;
    if (row.is_installed === false) storedParts[id] = level;
    else installedParts[id] = level;
  }
  return { ownedParts, installedParts, storedParts, maxLevel: 3 };
}

async function roomPayload(client, roomId, userId) {
  const roomResult = await client.query(
    "SELECT r.id::TEXT AS id, r.owner_telegram_id::TEXT AS owner_telegram_id, r.owner_name, " +
      "r.stake::TEXT AS stake, r.max_players, r.mode, r.status, r.game_state, r.created_at, r.updated_at, " +
      "(SELECT COUNT(*)::INTEGER FROM drag_racing_room_players p WHERE p.room_id = r.id) AS players_count " +
    "FROM drag_racing_rooms r WHERE r.id = $1::BIGINT",
    [String(roomId)]
  );
  const row = roomResult.rows[0];
  if (!row) throw new DragRacingError(404, "Комната не найдена или уже закрыта.");
  const gameState = objectValue(row.game_state);
  const results = objectValue(gameState.results);
  const motionByPlayer = objectValue(gameState.motion);
  const playerRows = await client.query(
    "SELECT telegram_id::TEXT AS telegram_id, display_name, car_id, joined_at, last_seen_at " +
    "FROM drag_racing_room_players WHERE room_id = $1::BIGINT ORDER BY joined_at ASC, telegram_id ASC",
    [String(roomId)]
  );
  const players = playerRows.rows.map(player => {
    const playerId = String(player.telegram_id);
    const result = objectValue(results[playerId]);
    const motion = objectValue(motionByPlayer[playerId]);
    const motionUpdatedAt = Number(motion.updatedAt) || 0;
    const motionAgeMs = motionUpdatedAt ? Math.max(0, Date.now() - motionUpdatedAt) : Number.POSITIVE_INFINITY;
    const safeProgress = Math.max(0, Math.min(1, Number(motion.progress) || 0));
    return {
      id: playerId,
      name: String(player.display_name || "Игрок").slice(0, 40),
      carId: String(player.car_id || "2107"),
      isYou: playerId === String(userId),
      isOwner: playerId === String(row.owner_telegram_id),
      connected: player.last_seen_at ? Date.now() - new Date(player.last_seen_at).getTime() < 15000 : false,
      joinedAt: player.joined_at,
      finishTimeMs: Number.isFinite(Number(result.timeMs)) ? Number(result.timeMs) : null,
      forfeit: Boolean(result.forfeit),
      motion: motionUpdatedAt ? {
        speedKmh: Math.max(0, Math.min(400, Number(motion.speedKmh) || 0)),
        distanceM: Math.max(0, Number(motion.distanceM) || 0),
        progress: safeProgress,
        gear: Math.max(0, Math.min(5, Number(motion.gear) || 0)),
        updatedAt: motionUpdatedAt,
        fresh: motionAgeMs <= 2500
      } : null
    };
  });
  return {
    serverNow: Date.now(),
    room: {
      id: ROOM_PREFIX + String(row.id),
      roomId: String(row.id),
      ownerId: String(row.owner_telegram_id),
      ownerName: String(row.owner_name || "Игрок").slice(0, 40),
      stake: Number(row.stake),
      maxPlayers: Number(row.max_players),
      playersCount: Number(row.players_count || 0),
      mode: String(row.mode),
      status: String(row.status),
      isOwner: String(row.owner_telegram_id) === String(userId),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    },
    players,
    game: {
      phase: String(gameState.phase || row.status),
      startedAt: gameState.startedAt == null ? null : Number(gameState.startedAt),
      finishedAt: gameState.finishedAt == null ? null : Number(gameState.finishedAt),
      winnerIds: Array.isArray(gameState.winnerIds) ? gameState.winnerIds.map(String) : [],
      winners: Array.isArray(gameState.winners) ? gameState.winners : [],
      payout: Number(gameState.payout || 0),
      commission: Number(gameState.commission || 0),
      grossPot: Number(gameState.grossPot || 0),
      results,
      message: String(gameState.message || "")
    },
    balance: await readBalance(client, userId)
  };
}

async function settleRoomIfReady(client, room, players, game) {
  if (game.phase === "finished") return;
  const ids = players.map(player => String(player.telegram_id));
  if (!ids.length || !ids.every(id => game.results?.[id])) return;
  const times = ids.map(id => Number(game.results[id].timeMs));
  const bestTime = Math.min(...times);
  const winners = ids.filter(id => Number(game.results[id].timeMs) === bestTime);
  let remainder = RACE_WINNER_REWARD % BigInt(winners.length);
  const base = RACE_WINNER_REWARD / BigInt(winners.length);
  const winnerDetails = [];
  for (const id of winners) {
    const amount = base + (remainder > 0n ? 1n : 0n);
    if (remainder > 0n) remainder -= 1n;
    if (amount > 0n) {
      const credited = await client.query(
        "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT RETURNING balance",
        [amount.toString(), id]
      );
      if (!credited.rows.length) throw new Error("Не найден баланс победителя драг-рейсинга.");
    }
    winnerDetails.push({
      id,
      name: String(game.results[id].name || players.find(player => String(player.telegram_id) === id)?.display_name || "Игрок").slice(0, 40),
      amount: Number(amount)
    });
  }
  game.phase = "finished";
  game.finishedAt = Date.now();
  game.winnerIds = winners;
  game.winners = winnerDetails;
  game.grossPot = Number(RACE_WINNER_REWARD);
  game.commission = 0;
  game.payout = Number(RACE_WINNER_REWARD);
  game.message = winners.length === 1
    ? "Заезд завершён. Результат победителя сохранён."
    : "Ничья! Результаты заезда сохранены.";
  await client.query(
    "UPDATE drag_racing_rooms SET status = 'finished', game_state = $2::jsonb, updated_at = NOW() WHERE id = $1::BIGINT",
    [String(room.id), JSON.stringify(game)]
  );
}
}

export function createDragRacingRouter({ pool, verifyTelegram, recordGameCommission }) {
  const router = express.Router();

  router.initialize = async function initializeDragRacingTables() {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_profiles (" +
      "telegram_id BIGINT PRIMARY KEY, selected_car_id TEXT NOT NULL DEFAULT '2107', " +
      "tuning JSONB NOT NULL DEFAULT '{\"ecu\":50,\"boost\":25,\"grip\":70,\"shift\":45}'::jsonb, " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    // Persist the fuel tank across sessions; existing profiles receive 40 L once.
    await pool.query(
      "ALTER TABLE drag_racing_player_profiles ADD COLUMN IF NOT EXISTS fuel_liters NUMERIC(6,2) NOT NULL DEFAULT 40.00"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_cars (" +
      "telegram_id BIGINT NOT NULL, car_id TEXT NOT NULL, upgrades JSONB NOT NULL DEFAULT '{}'::jsonb, " +
      "purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (telegram_id, car_id))"
    );
    await pool.query(
      "ALTER TABLE drag_racing_player_cars ADD COLUMN IF NOT EXISTS customization JSONB NOT NULL DEFAULT '{}'::jsonb"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_rooms (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_telegram_id BIGINT NOT NULL, " +
      "owner_name TEXT NOT NULL DEFAULT 'Игрок', stake BIGINT NOT NULL DEFAULT 0 CHECK (stake >= 0), " +
      "max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 5), " +
      "mode TEXT NOT NULL CHECK (mode IN ('quarter','half','sprint')), " +
      "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','racing','finished')), " +
      "game_state JSONB NOT NULL DEFAULT '{\"phase\":\"waiting\",\"results\":{}}'::jsonb, " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query("ALTER TABLE drag_racing_rooms DROP CONSTRAINT IF EXISTS drag_racing_rooms_stake_check");
    await pool.query("ALTER TABLE drag_racing_rooms DROP CONSTRAINT IF EXISTS drag_racing_rooms_stake_nonnegative_check");
    await pool.query("ALTER TABLE drag_racing_rooms ALTER COLUMN stake SET DEFAULT 0");
    await pool.query("ALTER TABLE drag_racing_rooms ADD CONSTRAINT drag_racing_rooms_stake_nonnegative_check CHECK (stake >= 0)");
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_room_players (" +
      "room_id BIGINT NOT NULL REFERENCES drag_racing_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, display_name TEXT NOT NULL DEFAULT 'Игрок', " +
      "car_id TEXT NOT NULL DEFAULT '2107', joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query("CREATE INDEX IF NOT EXISTS drag_racing_rooms_status_idx ON drag_racing_rooms (status, created_at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS drag_racing_room_players_presence_idx ON drag_racing_room_players (room_id, last_seen_at DESC)");
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_paints (" +
      "telegram_id BIGINT NOT NULL, paint_id TEXT NOT NULL, " +
      "purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (telegram_id, paint_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_rims (" +
      "telegram_id BIGINT NOT NULL, rim_id TEXT NOT NULL, " +
      "purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (telegram_id, rim_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_rim_preferences (" +
      "telegram_id BIGINT PRIMARY KEY, rim_id TEXT NOT NULL DEFAULT 'stock', " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_air_suspensions (" +
      "telegram_id BIGINT PRIMARY KEY, purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_parts (" +
      "telegram_id BIGINT NOT NULL, part_id TEXT NOT NULL, " +
      "level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1 AND level <= 3), " +
      "purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (telegram_id, part_id))"
    );
    // Existing owned parts stay installed; newly removed parts remain in the player's inventory.
    await pool.query(
      "ALTER TABLE drag_racing_player_parts ADD COLUMN IF NOT EXISTS is_installed BOOLEAN NOT NULL DEFAULT TRUE"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_car_rewards (" +
      "telegram_id BIGINT NOT NULL, car_id TEXT NOT NULL, source TEXT NOT NULL, " +
      "granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (telegram_id, car_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_migrations (" +
      "migration_key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query("ALTER TABLE drag_racing_player_profiles ALTER COLUMN selected_car_id SET DEFAULT '2110'");

    // VAZ-2107 was previously inserted as a free starter car for every account.
    // Apply this conversion once: keep the free VAZ-2110 and move players off 2107.
    const migrationClient = await pool.connect();
    try {
      await migrationClient.query("BEGIN");
      const migration = await migrationClient.query(
        "INSERT INTO drag_racing_migrations (migration_key) VALUES ('2107-paid-shop-v1') " +
        "ON CONFLICT DO NOTHING RETURNING migration_key"
      );
      if (migration.rowCount > 0) {
        await migrationClient.query(
          "UPDATE drag_racing_player_profiles SET selected_car_id = '2110', updated_at = NOW() " +
          "WHERE selected_car_id = '2107'"
        );
        await migrationClient.query(
          "DELETE FROM drag_racing_player_cars WHERE car_id = '2107'"
        );
      }
      await migrationClient.query("COMMIT");
    } catch (error) {
      try { await migrationClient.query("ROLLBACK"); } catch (_) {}
      throw error;
    } finally {
      migrationClient.release();
    }

    // One-time conversion of legacy paid rooms: refund old entry amounts and close those rooms.
    const freeEntryClient = await pool.connect();
    try {
      await freeEntryClient.query("BEGIN");
      const migration = await freeEntryClient.query(
        "INSERT INTO drag_racing_migrations (migration_key) VALUES ('racing-free-entry-fixed-prize-v1') " +
        "ON CONFLICT DO NOTHING RETURNING migration_key"
      );
      if (migration.rowCount > 0) {
        const legacyRooms = await freeEntryClient.query(
          "SELECT id::TEXT AS id, stake::TEXT AS stake FROM drag_racing_rooms " +
          "WHERE status IN ('waiting','racing') FOR UPDATE"
        );
        for (const legacyRoom of legacyRooms.rows) {
          const members = await freeEntryClient.query(
            "SELECT telegram_id::TEXT AS telegram_id FROM drag_racing_room_players WHERE room_id = $1::BIGINT",
            [String(legacyRoom.id)]
          );
          const oldStake = BigInt(String(legacyRoom.stake || "0"));
          if (oldStake > 0n) {
            for (const member of members.rows) {
              await freeEntryClient.query(
                "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
                [oldStake.toString(), String(member.telegram_id)]
              );
            }
          }
          await freeEntryClient.query(
            "UPDATE drag_racing_rooms SET status = 'finished', stake = 0, " +
            "game_state = jsonb_build_object('phase','finished','results','{}'::jsonb," +
            "'message','Старый заезд отменён при переходе на бесплатные комнаты; взносы возвращены.'), updated_at = NOW() " +
            "WHERE id = $1::BIGINT",
            [String(legacyRoom.id)]
          );
        }
        await freeEntryClient.query("UPDATE drag_racing_rooms SET stake = 0");
      }
      await freeEntryClient.query("COMMIT");
    } catch (error) {
      try { await freeEntryClient.query("ROLLBACK"); } catch (_) {}
      throw error;
    } finally {
      freeEntryClient.release();
    }
  };

  router.post("/profile", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      await lockPlayerBalance(client, user);
      const profile = await readProfile(client, user.id);
      const balance = await readBalance(client, user.id);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, balance, profile });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Load Drag Racing profile:", error.message || error);
      return res.status(error instanceof DragRacingError ? error.status : 500).json({
        ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось загрузить гараж."
      });
    } finally { client.release(); }
  });

  router.post("/fuel/profile", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      await ensureProfile(client, user.id);
      const tank = await client.query(
        "SELECT fuel_liters::TEXT AS fuel_liters FROM drag_racing_player_profiles WHERE telegram_id = $1::BIGINT",
        [user.id]
      );
      const fuelLiters = Math.max(0, Math.min(50, Number(tank.rows[0]?.fuel_liters ?? 40)));
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true, balance: Number(balance), fuelLiters,
        tankCapacityLiters: 50, pricePerLiter: 100
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Load Drag Racing fuel profile:", error.message || error);
      return res.status(error instanceof DragRacingError ? error.status : 500).json({
        ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось проверить запас бензина."
      });
    } finally { client.release(); }
  });

  router.post("/fuel/buy", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const liters = Number(req.body?.liters);
    if (!Number.isInteger(liters) || liters < 1 || liters > 50) {
      return res.status(400).json({ ok: false, error: "Укажи целое количество от 1 до 50 литров." });
    }
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      await ensureProfile(client, user.id);
      const tank = await client.query(
        "SELECT fuel_liters::TEXT AS fuel_liters FROM drag_racing_player_profiles WHERE telegram_id = $1::BIGINT FOR UPDATE",
        [user.id]
      );
      const currentFuel = Math.max(0, Math.min(50, Number(tank.rows[0]?.fuel_liters ?? 40)));
      const remaining = Math.max(0, 50 - currentFuel);
      if (liters > remaining + 0.001) {
        throw new DragRacingError(400, "В бак помещается ещё " + remaining.toFixed(1) + " л.");
      }
      const price = BigInt(liters) * 100n;
      if (balance < price) {
        throw new DragRacingError(400, "Недостаточно AC. " + liters + " л бензина стоят " + price.toString() + " AC.");
      }
      const debit = await client.query(
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() " +
        "WHERE telegram_id = $2::BIGINT AND balance >= $1::BIGINT RETURNING balance::TEXT AS balance",
        [price.toString(), user.id]
      );
      if (!debit.rows.length) throw new DragRacingError(400, "Недостаточно AC для покупки бензина.");
      const updated = await client.query(
        "UPDATE drag_racing_player_profiles SET fuel_liters = LEAST(50::NUMERIC, fuel_liters + $1::NUMERIC), updated_at = NOW() " +
        "WHERE telegram_id = $2::BIGINT RETURNING fuel_liters::TEXT AS fuel_liters",
        [String(liters), user.id]
      );
      const fuelLiters = Number(updated.rows[0]?.fuel_liters ?? currentFuel);
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true, purchasedLiters: liters, price: Number(price),
        fuelLiters, tankCapacityLiters: 50, pricePerLiter: 100,
        balance: Number(debit.rows[0].balance)
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Buy Drag Racing fuel:", error.message || error);
      return res.status(status).json({
        ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось купить бензин."
      });
    } finally { client.release(); }
  });

  router.post("/fuel/use", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const used = Number(req.body?.usedLiters);
    if (!Number.isFinite(used) || used < 0.01 || used > 1.00) {
      return res.status(400).json({ ok: false, error: "Некорректный объём израсходованного бензина." });
    }
    const roundedUse = Math.round(used * 100) / 100;
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      await ensureProfile(client, user.id);
      const updated = await client.query(
        "UPDATE drag_racing_player_profiles SET fuel_liters = GREATEST(0::NUMERIC, fuel_liters - $1::NUMERIC), updated_at = NOW() " +
        "WHERE telegram_id = $2::BIGINT RETURNING fuel_liters::TEXT AS fuel_liters",
        [roundedUse.toFixed(2), user.id]
      );
      const fuelLiters = Math.max(0, Number(updated.rows[0]?.fuel_liters ?? 0));
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, usedLiters: roundedUse, fuelLiters, tankCapacityLiters: 50 });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Save Drag Racing fuel consumption:", error.message || error);
      return res.status(error instanceof DragRacingError ? error.status : 500).json({
        ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось сохранить расход бензина."
      });
    } finally { client.release(); }
  });

  router.post("/garage/paint/profile", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const owned = await client.query(
        "SELECT paint_id FROM drag_racing_player_paints WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC",
        [user.id]
      );
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true,
        balance: Number(balance),
        paintPrice: 2000,
        ownedPaints: owned.rows.map(row => String(row.paint_id))
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Load Drag Racing paint profile:", error.message || error);
      return res.status(error instanceof DragRacingError ? error.status : 500).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось загрузить краски гаража."
      });
    } finally { client.release(); }
  });

  router.post("/garage/paint/buy", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const paintId = String(req.body?.paintId || "");
    if (!Object.hasOwn(BODY_PAINTS, paintId)) {
      return res.status(400).json({ ok: false, error: "Такого цвета нет в каталоге." });
    }
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const alreadyOwned = await client.query(
        "SELECT 1 FROM drag_racing_player_paints WHERE telegram_id = $1::BIGINT AND paint_id = $2",
        [user.id, paintId]
      );
      if (alreadyOwned.rowCount > 0) {
        const owned = await client.query(
          "SELECT paint_id FROM drag_racing_player_paints WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC",
          [user.id]
        );
        await client.query("COMMIT"); open = false;
        return res.json({
          ok: true,
          purchased: false,
          alreadyOwned: true,
          paintId,
          balance: Number(balance),
          ownedPaints: owned.rows.map(row => String(row.paint_id))
        });
      }

      const price = BigInt(BODY_PAINTS[paintId].price);
      if (balance < price) {
        throw new DragRacingError(400, "Недостаточно AC. Для покупки краски нужно 2 000 AC.");
      }
      const debit = await client.query(
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() " +
        "WHERE telegram_id = $2::BIGINT AND balance >= $1::BIGINT RETURNING balance::TEXT AS balance",
        [price.toString(), user.id]
      );
      if (!debit.rows.length) {
        throw new DragRacingError(400, "Недостаточно AC. Для покупки краски нужно 2 000 AC.");
      }
      await client.query(
        "INSERT INTO drag_racing_player_paints (telegram_id, paint_id) VALUES ($1::BIGINT, $2) ON CONFLICT DO NOTHING",
        [user.id, paintId]
      );
      const owned = await client.query(
        "SELECT paint_id FROM drag_racing_player_paints WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC",
        [user.id]
      );
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true,
        purchased: true,
        alreadyOwned: false,
        paintId,
        price: Number(price),
        balance: Number(debit.rows[0].balance),
        ownedPaints: owned.rows.map(row => String(row.paint_id))
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Buy Drag Racing body paint:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось купить краску."
      });
    } finally { client.release(); }
  });

  router.post("/garage/rims/profile", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const [ownedResult, preferenceResult] = await Promise.all([
        client.query(
          "SELECT rim_id FROM drag_racing_player_rims WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC",
          [user.id]
        ),
        client.query(
          "SELECT rim_id FROM drag_racing_player_rim_preferences WHERE telegram_id = $1::BIGINT",
          [user.id]
        )
      ]);
      const ownedRims = ["stock", ...ownedResult.rows.map(row => String(row.rim_id))];
      const requested = String(preferenceResult.rows[0]?.rim_id || "stock");
      const selectedRimId = ownedRims.includes(requested) ? requested : "stock";
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true,
        balance: Number(balance),
        selectedRimId,
        ownedRims,
        rimCatalog: RIM_OPTIONS
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Load Drag Racing rims:", error.message || error);
      return res.status(error instanceof DragRacingError ? error.status : 500).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось загрузить диски гаража."
      });
    } finally { client.release(); }
  });

  router.post("/garage/rims/select", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const rimId = String(req.body?.rimId || "stock");
    if (!Object.hasOwn(RIM_OPTIONS, rimId)) {
      return res.status(400).json({ ok: false, error: "Такого дизайна дисков нет в каталоге." });
    }
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      await lockPlayerBalance(client, user);
      if (rimId !== "stock") {
        const owned = await client.query(
          "SELECT 1 FROM drag_racing_player_rims WHERE telegram_id = $1::BIGINT AND rim_id = $2",
          [user.id, rimId]
        );
        if (!owned.rowCount) throw new DragRacingError(403, "Сначала купи этот комплект дисков.");
      }
      await client.query(
        "INSERT INTO drag_racing_player_rim_preferences (telegram_id, rim_id) VALUES ($1::BIGINT, $2) " +
        "ON CONFLICT (telegram_id) DO UPDATE SET rim_id = EXCLUDED.rim_id, updated_at = NOW()",
        [user.id, rimId]
      );
      const [balance, ownedResult] = await Promise.all([
        readBalance(client, user.id),
        client.query(
          "SELECT rim_id FROM drag_racing_player_rims WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC",
          [user.id]
        )
      ]);
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true,
        selectedRimId: rimId,
        ownedRims: ["stock", ...ownedResult.rows.map(row => String(row.rim_id))],
        balance
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Select Drag Racing rims:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось установить диски."
      });
    } finally { client.release(); }
  });

  router.post("/garage/rims/buy", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const rimId = String(req.body?.rimId || "");
    if (!Object.hasOwn(RIM_OPTIONS, rimId) || rimId === "stock") {
      return res.status(400).json({ ok: false, error: "Выбери комплект дисков из каталога." });
    }
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const alreadyOwned = await client.query(
        "SELECT 1 FROM drag_racing_player_rims WHERE telegram_id = $1::BIGINT AND rim_id = $2",
        [user.id, rimId]
      );
      if (alreadyOwned.rowCount) {
        await client.query(
          "INSERT INTO drag_racing_player_rim_preferences (telegram_id, rim_id) VALUES ($1::BIGINT, $2) " +
          "ON CONFLICT (telegram_id) DO UPDATE SET rim_id = EXCLUDED.rim_id, updated_at = NOW()",
          [user.id, rimId]
        );
        const owned = await client.query(
          "SELECT rim_id FROM drag_racing_player_rims WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC",
          [user.id]
        );
        await client.query("COMMIT"); open = false;
        return res.json({
          ok: true, purchased: false, alreadyOwned: true, rimId,
          selectedRimId: rimId, balance: Number(balance),
          ownedRims: ["stock", ...owned.rows.map(row => String(row.rim_id))]
        });
      }

      const price = BigInt(RIM_OPTIONS[rimId].price);
      if (balance < price) {
        throw new DragRacingError(400, "Недостаточно AC для покупки этого комплекта дисков.");
      }
      const debit = await client.query(
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() " +
        "WHERE telegram_id = $2::BIGINT AND balance >= $1::BIGINT RETURNING balance::TEXT AS balance",
        [price.toString(), user.id]
      );
      if (!debit.rows.length) {
        throw new DragRacingError(400, "Недостаточно AC для покупки этого комплекта дисков.");
      }
      await client.query(
        "INSERT INTO drag_racing_player_rims (telegram_id, rim_id) VALUES ($1::BIGINT, $2) ON CONFLICT DO NOTHING",
        [user.id, rimId]
      );
      await client.query(
        "INSERT INTO drag_racing_player_rim_preferences (telegram_id, rim_id) VALUES ($1::BIGINT, $2) " +
        "ON CONFLICT (telegram_id) DO UPDATE SET rim_id = EXCLUDED.rim_id, updated_at = NOW()",
        [user.id, rimId]
      );
      const owned = await client.query(
        "SELECT rim_id FROM drag_racing_player_rims WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC",
        [user.id]
      );
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true, purchased: true, alreadyOwned: false, rimId,
        price: Number(price), selectedRimId: rimId,
        balance: Number(debit.rows[0].balance),
        ownedRims: ["stock", ...owned.rows.map(row => String(row.rim_id))]
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Buy Drag Racing rims:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось купить диски."
      });
    } finally { client.release(); }
  });

  router.post("/garage/suspension/profile", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const owned = await client.query(
        "SELECT 1 FROM drag_racing_player_air_suspensions WHERE telegram_id = $1::BIGINT",
        [user.id]
      );
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true,
        balance: Number(balance),
        hasAirSuspension: owned.rowCount > 0,
        price: 3000
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Load Drag Racing air suspension:", error.message || error);
      return res.status(error instanceof DragRacingError ? error.status : 500).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось проверить пневмоподвеску."
      });
    } finally { client.release(); }
  });

  router.post("/garage/suspension/buy", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      // Lock the wallet so two simultaneous taps cannot charge twice.
      const balance = await lockPlayerBalance(client, user);
      const existing = await client.query(
        "SELECT 1 FROM drag_racing_player_air_suspensions WHERE telegram_id = $1::BIGINT FOR UPDATE",
        [user.id]
      );
      if (existing.rowCount) {
        await client.query("COMMIT"); open = false;
        return res.json({
          ok: true, purchased: false, alreadyOwned: true,
          hasAirSuspension: true, price: 3000, balance: Number(balance)
        });
      }

      const price = 3000n;
      if (balance < price) {
        throw new DragRacingError(400, "Недостаточно AC. Для покупки пневмоподвески нужно 3 000 AC.");
      }
      const debit = await client.query(
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() " +
        "WHERE telegram_id = $2::BIGINT AND balance >= $1::BIGINT RETURNING balance::TEXT AS balance",
        [price.toString(), user.id]
      );
      if (!debit.rows.length) {
        throw new DragRacingError(400, "Недостаточно AC для покупки пневмоподвески.");
      }
      await client.query(
        "INSERT INTO drag_racing_player_air_suspensions (telegram_id) VALUES ($1::BIGINT) ON CONFLICT DO NOTHING",
        [user.id]
      );
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true, purchased: true, alreadyOwned: false,
        hasAirSuspension: true, price: Number(price),
        balance: Number(debit.rows[0].balance)
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Buy Drag Racing air suspension:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось купить пневмоподвеску."
      });
    } finally { client.release(); }
  });

  router.post("/garage/parts/profile", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const inventory = await readRacingPartsInventory(client, user.id);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, balance: Number(balance), ...inventory });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Load Drag Racing parts:", error.message || error);
      return res.status(error instanceof DragRacingError ? error.status : 500).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось загрузить запчасти гаража."
      });
    } finally { client.release(); }
  });

  router.post("/garage/parts/buy", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const partId = String(req.body?.partId || "");
    if (!Object.hasOwn(RACING_PARTS, partId)) {
      return res.status(400).json({ ok: false, error: "Такой детали нет в каталоге." });
    }
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const currentResult = await client.query(
        "SELECT level, is_installed FROM drag_racing_player_parts WHERE telegram_id = $1::BIGINT AND part_id = $2 FOR UPDATE",
        [user.id, partId]
      );
      if (currentResult.rows.length && currentResult.rows[0].is_installed === false) {
        throw new DragRacingError(409, "Эта деталь находится на складе. Сначала установи её на автомобиль.");
      }
      const currentLevel = Math.max(0, Math.min(3, Number(currentResult.rows[0]?.level) || 0));
      if (currentLevel >= 3) {
        const inventory = await readRacingPartsInventory(client, user.id);
        await client.query("COMMIT"); open = false;
        return res.json({ ok: true, purchased: false, alreadyMax: true, partId, level: 3, balance: Number(balance), ...inventory });
      }

      const nextLevel = currentLevel + 1;
      const price = BigInt(RACING_PARTS[partId][currentLevel]);
      if (balance < price) {
        throw new DragRacingError(400, "Недостаточно AC. Для следующего уровня детали нужно " + price.toString() + " AC.");
      }
      const debit = await client.query(
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() " +
        "WHERE telegram_id = $2::BIGINT AND balance >= $1::BIGINT RETURNING balance::TEXT AS balance",
        [price.toString(), user.id]
      );
      if (!debit.rows.length) throw new DragRacingError(400, "Недостаточно AC для покупки этой детали.");

      if (currentLevel > 0) {
        await client.query(
          "UPDATE drag_racing_player_parts SET level = $3, is_installed = TRUE, purchased_at = NOW(), updated_at = NOW() " +
          "WHERE telegram_id = $1::BIGINT AND part_id = $2",
          [user.id, partId, nextLevel]
        );
      } else {
        await client.query(
          "INSERT INTO drag_racing_player_parts (telegram_id, part_id, level, is_installed) VALUES ($1::BIGINT, $2, $3, TRUE)",
          [user.id, partId, nextLevel]
        );
      }

      const inventory = await readRacingPartsInventory(client, user.id);
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true, purchased: true, partId, level: nextLevel,
        price: Number(price), balance: Number(debit.rows[0].balance), ...inventory
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Buy Drag Racing part:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось купить запчасть."
      });
    } finally { client.release(); }
  });

  router.post("/garage/parts/remove", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const partId = String(req.body?.partId || "");
    if (!Object.hasOwn(RACING_PARTS, partId)) {
      return res.status(400).json({ ok: false, error: "Такой запчасти нет в каталоге." });
    }
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      await lockPlayerBalance(client, user);
      const current = await client.query(
        "SELECT level, is_installed FROM drag_racing_player_parts WHERE telegram_id = $1::BIGINT AND part_id = $2 FOR UPDATE",
        [user.id, partId]
      );
      if (!current.rows.length) throw new DragRacingError(404, "Эта запчасть не найдена в гараже.");
      if (current.rows[0].is_installed === false) throw new DragRacingError(409, "Эта запчасть уже лежит на складе.");
      await client.query(
        "UPDATE drag_racing_player_parts SET is_installed = FALSE, updated_at = NOW() WHERE telegram_id = $1::BIGINT AND part_id = $2",
        [user.id, partId]
      );
      const inventory = await readRacingPartsInventory(client, user.id);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, removed: true, partId, level: Number(current.rows[0].level), ...inventory });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Remove Drag Racing part:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось снять запчасть с автомобиля."
      });
    } finally { client.release(); }
  });

  router.post("/garage/parts/install", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const partId = String(req.body?.partId || "");
    if (!Object.hasOwn(RACING_PARTS, partId)) {
      return res.status(400).json({ ok: false, error: "Такой запчасти нет в каталоге." });
    }
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      await lockPlayerBalance(client, user);
      const current = await client.query(
        "SELECT level, is_installed FROM drag_racing_player_parts WHERE telegram_id = $1::BIGINT AND part_id = $2 FOR UPDATE",
        [user.id, partId]
      );
      if (!current.rows.length) throw new DragRacingError(404, "Эта запчасть не найдена на складе.");
      if (current.rows[0].is_installed !== false) throw new DragRacingError(409, "Эта запчасть уже установлена.");
      await client.query(
        "UPDATE drag_racing_player_parts SET is_installed = TRUE, updated_at = NOW() WHERE telegram_id = $1::BIGINT AND part_id = $2",
        [user.id, partId]
      );
      const inventory = await readRacingPartsInventory(client, user.id);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, installed: true, partId, level: Number(current.rows[0].level), ...inventory });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Install Drag Racing part:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось установить запчасть."
      });
    } finally { client.release(); }
  });

  router.post("/garage/buy", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const carId = String(req.body?.carId || "");
    if (!Object.hasOwn(CARS, carId)) return res.status(400).json({ ok: false, error: "Такого автомобиля нет в автосалоне." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const profile = await readProfile(client, user.id);
      if (profile.ownedCars.includes(carId)) throw new DragRacingError(409, "Этот автомобиль уже есть в гараже.");
      const price = BigInt(CARS[carId].price);
      if (balance < price) throw new DragRacingError(400, "Недостаточно AC для покупки этого автомобиля.");
      if (price > 0n) {
        await client.query(
          "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
          [price.toString(), user.id]
        );
      }
      await client.query(
        "INSERT INTO drag_racing_player_cars (telegram_id, car_id, upgrades) VALUES ($1::BIGINT, $2, '{}'::jsonb)",
        [user.id, carId]
      );
      await client.query(
        "UPDATE drag_racing_player_profiles SET selected_car_id = $2, updated_at = NOW() WHERE telegram_id = $1::BIGINT",
        [user.id, carId]
      );
      await client.query("COMMIT"); open = false;
      return await sendProfile(res, pool, user.id);
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Buy Drag Racing car:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось купить автомобиль." });
    } finally { client.release(); }
  });


  router.post("/garage/rewarded-car/claim", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;

    // This endpoint only grants the single VAZ-2107 rewarded placement.
    const carId = String(req.body?.carId || "");
    if (carId !== "2107") {
      return res.status(400).json({ ok: false, error: "Эту машину нельзя получить через рекламную награду." });
    }

    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      await lockPlayerBalance(client, user);
      const profile = await readProfile(client, user.id);
      const balance = await readBalance(client, user.id);

      if (profile.ownedCars.includes("2107")) {
        await client.query("COMMIT"); open = false;
        return res.json({ ok: true, alreadyOwned: true, balance, profile });
      }

      const reward = await client.query(
        "INSERT INTO drag_racing_player_car_rewards (telegram_id, car_id, source) " +
        "VALUES ($1::BIGINT, '2107', 'adsgram') ON CONFLICT DO NOTHING RETURNING car_id",
        [user.id]
      );
      if (!reward.rows.length) {
        throw new DragRacingError(409, "Награда за рекламный просмотр уже использована для этой машины.");
      }

      await client.query(
        "INSERT INTO drag_racing_player_cars (telegram_id, car_id, upgrades) " +
        "VALUES ($1::BIGINT, '2107', '{}'::jsonb) ON CONFLICT DO NOTHING",
        [user.id]
      );
      await client.query(
        "UPDATE drag_racing_player_profiles SET selected_car_id = '2107', updated_at = NOW() WHERE telegram_id = $1::BIGINT",
        [user.id]
      );
      const updatedProfile = await readProfile(client, user.id);
      const updatedBalance = await readBalance(client, user.id);
      await client.query("COMMIT"); open = false;
      return res.json({
        ok: true,
        granted: true,
        rewardSource: "adsgram",
        carId: "2107",
        balance: updatedBalance,
        profile: updatedProfile
      });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Claim rewarded VAZ-2107:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось выдать награду за просмотр."
      });
    } finally { client.release(); }
  });

  router.post("/garage/select", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const carId = String(req.body?.carId || "");
    const result = await pool.query(
      "SELECT 1 FROM drag_racing_player_cars WHERE telegram_id = $1::BIGINT AND car_id = $2",
      [user.id, carId]
    );
    if (!result.rows.length) return res.status(400).json({ ok: false, error: "Сначала купи этот автомобиль." });
    await pool.query(
      "UPDATE drag_racing_player_profiles SET selected_car_id = $2, updated_at = NOW() WHERE telegram_id = $1::BIGINT",
      [user.id, carId]
    );
    return await sendProfile(res, pool, user.id);
  });

  router.post("/garage/upgrade", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const partId = String(req.body?.partId || "");
    const carId = String(req.body?.carId || "");
    if (!Object.hasOwn(PARTS, partId)) return res.status(400).json({ ok: false, error: "Неизвестная запчасть." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      const carResult = await client.query(
        "SELECT upgrades FROM drag_racing_player_cars WHERE telegram_id = $1::BIGINT AND car_id = $2 FOR UPDATE",
        [user.id, carId]
      );
      if (!carResult.rows.length) throw new DragRacingError(400, "Сначала купи автомобиль.");
      const installed = objectValue(carResult.rows[0].upgrades);
      if (installed[partId]) throw new DragRacingError(409, "Эта запчасть уже установлена на автомобиль.");
      const price = BigInt(PARTS[partId].price);
      if (balance < price) throw new DragRacingError(400, "Недостаточно AC для покупки запчасти.");
      await client.query(
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
        [price.toString(), user.id]
      );
      await client.query(
        "UPDATE drag_racing_player_cars SET upgrades = COALESCE(upgrades, '{}'::jsonb) || jsonb_build_object($3::TEXT, TRUE) WHERE telegram_id = $1::BIGINT AND car_id = $2",
        [user.id, carId, partId]
      );
      await client.query("COMMIT"); open = false;
      return await sendProfile(res, pool, user.id);
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Buy Drag Racing upgrade:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось установить запчасть." });
    } finally { client.release(); }
  });

  router.post("/garage/customize", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const carId = String(req.body?.carId || "");
    const paintId = String(req.body?.paintId || "");
    const vinylId = String(req.body?.vinylId || "");
    if (!Object.hasOwn(CARS, carId)) {
      return res.status(400).json({ ok: false, error: "Неизвестный автомобиль." });
    }
    if (!Object.hasOwn(PAINT_OPTIONS, paintId) || !Object.hasOwn(VINYL_OPTIONS, vinylId)) {
      return res.status(400).json({ ok: false, error: "Выбери цвет и виниловую плёнку из списка." });
    }

    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const carResult = await client.query(
        "SELECT customization FROM drag_racing_player_cars WHERE telegram_id = $1::BIGINT AND car_id = $2 FOR UPDATE",
        [user.id, carId]
      );
      if (!carResult.rows.length) throw new DragRacingError(400, "Сначала купи этот автомобиль.");

      const existing = objectValue(carResult.rows[0].customization);
      const next = normalizeCustomization({
        ...existing,
        paintId,
        vinylId,
        brushStrokes: Array.isArray(req.body?.brushStrokes) ? req.body.brushStrokes : existing.brushStrokes
      });
      await client.query(
        "UPDATE drag_racing_player_cars SET customization = $3::jsonb WHERE telegram_id = $1::BIGINT AND car_id = $2",
        [user.id, carId, JSON.stringify(next)]
      );
      await client.query("COMMIT"); open = false;
      return await sendProfile(res, pool, user.id);
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Customize Drag Racing car:", error.message || error);
      return res.status(status).json({
        ok: false,
        error: error instanceof DragRacingError ? error.message : "Не удалось сохранить внешний вид автомобиля."
      });
    } finally { client.release(); }
  });

  router.post("/garage/tune", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const input = objectValue(req.body?.tune);
    const tuning = {};
    for (const key of Object.keys(DEFAULT_TUNE)) {
      const value = Number(input[key]);
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        return res.status(400).json({ ok: false, error: "Все настройки должны быть в диапазоне от 0 до 100." });
      }
      tuning[key] = value;
    }
    await pool.query(
      "INSERT INTO drag_racing_player_profiles (telegram_id, tuning) VALUES ($1::BIGINT, $2::jsonb) " +
      "ON CONFLICT (telegram_id) DO UPDATE SET tuning = EXCLUDED.tuning, updated_at = NOW()",
      [user.id, JSON.stringify(tuning)]
    );
    return await sendProfile(res, pool, user.id);
  });

  router.post("/rooms/list", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    let maintenanceClient;
    let maintenanceOpen = false;
    try {
      // Remove abandoned free rooms after two minutes without player activity.
      maintenanceClient = await pool.connect();
      await maintenanceClient.query("BEGIN"); maintenanceOpen = true;
      const staleRooms = await maintenanceClient.query(
        "SELECT r.id::TEXT AS id FROM drag_racing_rooms r " +
        "WHERE r.status = 'waiting' AND NOT EXISTS (" +
          "SELECT 1 FROM drag_racing_room_players p WHERE p.room_id = r.id " +
          "AND p.last_seen_at >= NOW() - INTERVAL '2 minutes') " +
        "FOR UPDATE SKIP LOCKED"
      );
      for (const staleRoom of staleRooms.rows) {
        await maintenanceClient.query("DELETE FROM drag_racing_rooms WHERE id = $1::BIGINT AND status = 'waiting'", [String(staleRoom.id)]);
      }
      // Finished-room payout was committed already; remove only its old room record and result.
      await maintenanceClient.query(
        "DELETE FROM drag_racing_rooms WHERE status = 'finished' AND updated_at < NOW() - INTERVAL '2 minutes'"
      );
      await maintenanceClient.query("COMMIT"); maintenanceOpen = false;
      maintenanceClient.release(); maintenanceClient = null;
      const activeResult = await pool.query(
        "SELECT r.id::TEXT AS id FROM drag_racing_rooms r JOIN drag_racing_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1::BIGINT AND r.status IN ('waiting','racing') ORDER BY r.created_at DESC LIMIT 1",
        [user.id]
      );
      const currentRoom = activeResult.rows.length ? await roomPayload(pool, activeResult.rows[0].id, user.id) : null;
      const roomRows = await pool.query(
        "SELECT r.id::TEXT AS id, r.owner_name, r.stake::TEXT AS stake, r.max_players, r.mode, r.created_at, " +
          "COUNT(p.telegram_id)::INTEGER AS players_count " +
        "FROM drag_racing_rooms r LEFT JOIN drag_racing_room_players p ON p.room_id = r.id " +
        "WHERE r.status = 'waiting' GROUP BY r.id HAVING COUNT(p.telegram_id) < r.max_players " +
        "ORDER BY r.created_at DESC LIMIT 40"
      );
      return res.json({ ok: true, currentRoom, rooms: roomRows.rows.map(row => ({
        id: ROOM_PREFIX + String(row.id),
        roomId: String(row.id),
        ownerName: String(row.owner_name || "Игрок"),
        stake: Number(row.stake),
        maxPlayers: Number(row.max_players),
        playersCount: Number(row.players_count || 0),
        mode: String(row.mode),
        createdAt: row.created_at
      })) });
    } catch (error) {
      if (maintenanceOpen && maintenanceClient) {
        try { await maintenanceClient.query("ROLLBACK"); } catch (_) {}
      }
      console.error("List Drag Racing rooms:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить онлайн-комнаты." });
    } finally {
      if (maintenanceClient) maintenanceClient.release();
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const maxPlayers = Number(req.body?.maxPlayers ?? req.body?.players);
    const mode = String(req.body?.mode || "quarter");
    if (maxPlayers !== 2) return res.status(400).json({ ok: false, error: "В ALLCOINS Racing доступны комнаты строго на 2 игроков." });
    if (!VALID_MODES.has(mode)) return res.status(400).json({ ok: false, error: "Выбран неизвестный режим гонки." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      await lockPlayerBalance(client, user);
      await ensureProfile(client, user.id);
      const active = await client.query(
        "SELECT r.id FROM drag_racing_rooms r JOIN drag_racing_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1::BIGINT AND r.status IN ('waiting','racing') LIMIT 1",
        [user.id]
      );
      if (active.rows.length) throw new DragRacingError(409, "Сначала выйди из своей текущей комнаты.");
      const profile = await readProfile(client, user.id);
      const requestedCar = String(req.body?.carId || profile.selectedCarId);
      const carId = profile.ownedCars.includes(requestedCar) ? requestedCar : profile.selectedCarId;
      const roomResult = await client.query(
        "INSERT INTO drag_racing_rooms (owner_telegram_id, owner_name, stake, max_players, mode, status, game_state) " +
        "VALUES ($1::BIGINT, $2, $3::BIGINT, $4, $5, 'waiting', '{\"phase\":\"waiting\",\"results\":{}}'::jsonb) RETURNING id::TEXT AS id",
        [user.id, user.name, 0n, maxPlayers, mode]
      );
      const roomId = String(roomResult.rows[0].id);
      await client.query(
        "INSERT INTO drag_racing_room_players (room_id, telegram_id, display_name, car_id) VALUES ($1::BIGINT, $2::BIGINT, $3, $4)",
        [roomId, user.id, user.name, carId]
      );
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Create Drag Racing room:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось создать онлайн-комнату." });
    } finally { client.release(); }
  });

  router.post("/rooms/join", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const roomId = parseRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query(
        "SELECT id::TEXT AS id, owner_telegram_id::TEXT AS owner_telegram_id, owner_name, stake::TEXT AS stake, max_players, mode, status " +
        "FROM drag_racing_rooms WHERE id = $1::BIGINT FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new DragRacingError(404, "Комната не найдена.");
      const existing = await client.query(
        "SELECT 1 FROM drag_racing_room_players WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      if (existing.rows.length) {
        await client.query("UPDATE drag_racing_room_players SET last_seen_at = NOW() WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT", [roomId, user.id]);
        await client.query("COMMIT"); open = false;
        return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
      }
      if (room.status !== "waiting") throw new DragRacingError(409, "Заезд уже начался. Найди другую комнату.");
      // Lock the shared player balance before checking active rooms. Concurrent joins
      // then serialize on this row and the second transaction sees the first room membership.
      await lockPlayerBalance(client, user);
      const active = await client.query(
        "SELECT r.id FROM drag_racing_rooms r JOIN drag_racing_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1::BIGINT AND r.status IN ('waiting','racing') LIMIT 1",
        [user.id]
      );
      if (active.rows.length) throw new DragRacingError(409, "Сначала выйди из своей текущей комнаты.");
      await ensureProfile(client, user.id);
      const profile = await readProfile(client, user.id);
      const requestedCar = String(req.body?.carId || profile.selectedCarId);
      const carId = profile.ownedCars.includes(requestedCar) ? requestedCar : profile.selectedCarId;
      const countResult = await client.query(
        "SELECT COUNT(*)::INTEGER AS n FROM drag_racing_room_players WHERE room_id = $1::BIGINT",
        [roomId]
      );
      if (Number(countResult.rows[0]?.n || 0) >= Number(room.max_players)) throw new DragRacingError(409, "Комната уже заполнена.");
      await client.query(
        "INSERT INTO drag_racing_room_players (room_id, telegram_id, display_name, car_id) VALUES ($1::BIGINT, $2::BIGINT, $3, $4)",
        [roomId, user.id, user.name, carId]
      );
      await client.query("UPDATE drag_racing_rooms SET updated_at = NOW() WHERE id = $1::BIGINT", [roomId]);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Join Drag Racing room:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось войти в комнату." });
    } finally { client.release(); }
  });

  router.post("/rooms/start", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const roomId = parseRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query(
        "SELECT id::TEXT AS id, owner_telegram_id::TEXT AS owner_telegram_id, stake::TEXT AS stake, status, game_state " +
        "FROM drag_racing_rooms WHERE id = $1::BIGINT FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new DragRacingError(404, "Комната не найдена.");
      if (String(room.owner_telegram_id) !== user.id) throw new DragRacingError(403, "Начать заезд может только создатель комнаты.");
      if (room.status !== "waiting") throw new DragRacingError(409, "Эта комната уже запущена.");
      const players = await client.query(
        "SELECT telegram_id::TEXT AS telegram_id FROM drag_racing_room_players WHERE room_id = $1::BIGINT ORDER BY joined_at ASC",
        [roomId]
      );
      if (players.rows.length < 2) throw new DragRacingError(400, "Для старта нужны минимум два игрока.");
      const startedAt = Date.now();
      const game = {
        phase: "racing",
        startedAt,
        results: {},
        participants: players.rows.map(row => String(row.telegram_id)),
        winnerIds: [],
        winners: [],
        payout: 0,
        commission: 0,
        grossPot: 0,
        message: "Заезд начался. Переключай передачи вручную."
      };
      await client.query(
        "UPDATE drag_racing_rooms SET status = 'racing', game_state = $2::jsonb, updated_at = NOW() WHERE id = $1::BIGINT",
        [roomId, JSON.stringify(game)]
      );
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Start Drag Racing race:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось начать заезд." });
    } finally { client.release(); }
  });

  router.post("/rooms/finish", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const roomId = parseRoomId(req.body?.roomId);
    const timeMs = Number(req.body?.timeMs);
    if (!roomId) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    if (!Number.isFinite(timeMs) || timeMs < 1000 || timeMs > 180000) return res.status(400).json({ ok: false, error: "Некорректное время финиша." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query(
        "SELECT id::TEXT AS id, stake::TEXT AS stake, status, game_state FROM drag_racing_rooms WHERE id = $1::BIGINT FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new DragRacingError(404, "Комната не найдена.");
      const membershipCheck = await client.query(
        "SELECT 1 FROM drag_racing_room_players WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      if (!membershipCheck.rows.length) throw new DragRacingError(403, "Ты не состоишь в этой комнате.");
      if (room.status === "finished") {
        await client.query("COMMIT"); open = false;
        return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
      }
      if (room.status !== "racing") throw new DragRacingError(409, "Создатель комнаты ещё не запустил заезд.");
      const playerResult = await client.query(
        "SELECT telegram_id::TEXT AS telegram_id, display_name, car_id FROM drag_racing_room_players WHERE room_id = $1::BIGINT ORDER BY joined_at ASC",
        [roomId]
      );
      const player = playerResult.rows.find(item => String(item.telegram_id) === user.id);
      if (!player) throw new DragRacingError(403, "Ты не состоишь в этой комнате.");
      const game = objectValue(room.game_state);
      game.results = objectValue(game.results);
      if (game.results[user.id]) {
        await client.query("COMMIT"); open = false;
        return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
      }
      const elapsedSinceGreen = Math.max(0, Date.now() - (Number(game.startedAt || Date.now()) + 3000));
      if (!isValidDragRaceFinishTime(timeMs, elapsedSinceGreen)) throw new DragRacingError(400, "Время финиша не совпало с серверным временем заезда. Заверши дистанцию и отправь результат ещё раз.");
      game.results[user.id] = {
        timeMs: Math.round(timeMs),
        carId: String(player.car_id || "2107"),
        name: String(player.display_name || user.name).slice(0, 40),
        submittedAt: Date.now()
      };
      await settleRoomIfReady(client, { ...room, id: roomId }, playerResult.rows, game);
      if (game.phase !== "finished") {
        await client.query(
          "UPDATE drag_racing_rooms SET game_state = $2::jsonb, updated_at = NOW() WHERE id = $1::BIGINT",
          [roomId, JSON.stringify(game)]
        );
      }
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Finish Drag Racing race:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось сохранить результат заезда." });
    } finally { client.release(); }
  });

  router.post("/rooms/state", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const roomId = parseRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query(
        "SELECT id::TEXT AS id, stake::TEXT AS stake, mode, status, game_state FROM drag_racing_rooms WHERE id = $1::BIGINT FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new DragRacingError(404, "Комната не найдена.");
      const member = await client.query(
        "SELECT 1 FROM drag_racing_room_players WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      if (!member.rows.length) throw new DragRacingError(403, "Ты не состоишь в этой комнате.");
      const game = objectValue(room.game_state);
      if (room.status === "racing") {
        if (Date.now() - Number(game.startedAt || Date.now()) > 120000) {
          const players = await client.query(
            "SELECT telegram_id::TEXT AS telegram_id, display_name, car_id FROM drag_racing_room_players WHERE room_id = $1::BIGINT ORDER BY joined_at ASC",
            [roomId]
          );
          game.results = objectValue(game.results);
          const previousFinishes = Object.keys(game.results).length;
          if (!previousFinishes) {
            game.phase = "finished";
            game.finishedAt = Date.now();
            game.payout = 0;
            game.commission = 0;
            game.message = "Заезд отменён из-за отсутствия результатов. Награда не начислена.";
            await client.query(
              "UPDATE drag_racing_rooms SET status = 'finished', game_state = $2::jsonb, updated_at = NOW() WHERE id = $1::BIGINT",
              [roomId, JSON.stringify(game)]
            );
          } else {
            for (const participant of players.rows) {
              const id = String(participant.telegram_id);
              if (!game.results[id]) {
                game.results[id] = {
                  timeMs: 180000,
                  carId: String(participant.car_id || "2107"),
                  name: String(participant.display_name || "Игрок").slice(0, 40),
                  forfeit: true,
                  submittedAt: Date.now()
                };
              }
            }
            await settleRoomIfReady(client, { ...room, id: roomId }, players.rows, game);
            if (game.phase !== "finished") {
              await client.query(
                "UPDATE drag_racing_rooms SET game_state = $2::jsonb WHERE id = $1::BIGINT",
                [roomId, JSON.stringify(game)]
              );
            }
          }
        }
      }

      const telemetry = req.body?.telemetry;
      if (room.status === "racing" && game.phase !== "finished" && telemetry && typeof telemetry === "object") {
        const speedKmh = Number(telemetry.speedKmh);
        const distanceM = Number(telemetry.distanceM);
        const gear = Number(telemetry.gear);
        const maxDistance = RACE_DISTANCE_METERS[String(room.mode)] || RACE_DISTANCE_METERS.quarter;
        if (Number.isFinite(speedKmh) && speedKmh >= 0 && speedKmh <= 400 &&
            Number.isFinite(distanceM) && distanceM >= 0 && distanceM <= maxDistance + 50 &&
            Number.isInteger(gear) && gear >= 0 && gear <= 5) {
          const motionByPlayer = objectValue(game.motion);
          const previousMotion = objectValue(motionByPlayer[user.id]);
          const now = Date.now();
          if (now - (Number(previousMotion.updatedAt) || 0) >= 100) {
            const safeDistance = Math.min(maxDistance, distanceM);
            motionByPlayer[user.id] = {
              speedKmh: Math.round(speedKmh * 10) / 10,
              distanceM: Math.round(safeDistance * 10) / 10,
              progress: Math.max(0, Math.min(1, safeDistance / maxDistance)),
              gear,
              updatedAt: now
            };
            game.motion = motionByPlayer;
            await client.query(
              "UPDATE drag_racing_rooms SET game_state = $2::jsonb, updated_at = NOW() WHERE id = $1::BIGINT",
              [roomId, JSON.stringify(game)]
            );
          }
        }
      }
      await client.query(
        "UPDATE drag_racing_room_players SET last_seen_at = NOW() WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Read Drag Racing room state:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось обновить состояние комнаты." });
    } finally { client.release(); }
  });

  router.post("/rooms/leave", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const roomId = parseRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query(
        "SELECT id::TEXT AS id, owner_telegram_id::TEXT AS owner_telegram_id, stake::TEXT AS stake, status " +
        "FROM drag_racing_rooms WHERE id = $1::BIGINT FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new DragRacingError(404, "Комната уже закрыта.");
      if (room.status === "racing") throw new DragRacingError(409, "Заезд уже идёт. Дождись результата.");
      const membership = await client.query(
        "SELECT 1 FROM drag_racing_room_players WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      if (!membership.rows.length) throw new DragRacingError(403, "Ты не состоишь в этой комнате.");
      await client.query(
        "DELETE FROM drag_racing_room_players WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      const remaining = await client.query(
        "SELECT telegram_id::TEXT AS telegram_id, display_name FROM drag_racing_room_players WHERE room_id = $1::BIGINT ORDER BY joined_at ASC LIMIT 1",
        [roomId]
      );
      if (!remaining.rows.length) {
        await client.query("DELETE FROM drag_racing_rooms WHERE id = $1::BIGINT", [roomId]);
      } else if (String(room.owner_telegram_id) === user.id && room.status === "waiting") {
        await client.query(
          "UPDATE drag_racing_rooms SET owner_telegram_id = $2::BIGINT, owner_name = $3, updated_at = NOW() WHERE id = $1::BIGINT",
          [roomId, String(remaining.rows[0].telegram_id), String(remaining.rows[0].display_name || "Игрок")]
        );
      }
      const balance = await readBalance(client, user.id);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, balance, message: "Ты вышел из комнаты. Вход бесплатный." });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Leave Drag Racing room:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось выйти из комнаты." });
    } finally { client.release(); }
  });

  return router;
}
