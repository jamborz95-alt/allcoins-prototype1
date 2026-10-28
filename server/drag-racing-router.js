import express from "express";

const ROOM_PREFIX = "DR-";
const MAX_STAKE = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 5));
const VALID_MODES = new Set(["quarter", "half", "sprint"]);
const DEFAULT_TUNE = Object.freeze({ ecu: 50, boost: 25, grip: 70, shift: 45 });
const CARS = Object.freeze({
  "2107": { price: 0, power: 72 },
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
const PARTS = Object.freeze({
  ecu: { price: 25000, power: 8 },
  intake: { price: 18000, power: 5 },
  exhaust: { price: 32000, power: 7 },
  turbo: { price: 95000, power: 22 },
  clutch: { price: 22000, power: 2 },
  tires: { price: 28000, power: 3 },
  gearbox: { price: 48000, power: 6 },
  weight: { price: 65000, power: 10 }
});

class DragRacingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseRoomId(value) {
  const match = String(value ?? "").trim().match(/^(?:DR-)?([1-9]\d{0,17})$/);
  return match ? match[1] : null;
}

function safeStake(value) {
  const raw = String(value ?? "").trim().replace(/[\s,_]/g, "");
  if (!/^\d+$/.test(raw)) return null;
  try {
    const amount = BigInt(raw);
    if (amount < 100n || amount > MAX_STAKE) return null;
    return amount.toString();
  } catch { return null; }
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
  await client.query(
    "INSERT INTO drag_racing_player_cars (telegram_id, car_id, upgrades) VALUES ($1::BIGINT, '2107', '{}'::jsonb) ON CONFLICT (telegram_id, car_id) DO NOTHING",
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
      "SELECT car_id, upgrades FROM drag_racing_player_cars WHERE telegram_id = $1::BIGINT ORDER BY purchased_at ASC, car_id ASC",
      [String(telegramId)]
    )
  ]);
  const profileRow = profileResult.rows[0] || {};
  const ownedCars = carsResult.rows.map(row => String(row.car_id));
  const upgrades = {};
  for (const row of carsResult.rows) upgrades[String(row.car_id)] = objectValue(row.upgrades);
  const tuning = { ...DEFAULT_TUNE, ...objectValue(profileRow.tuning, DEFAULT_TUNE) };
  return {
    selectedCarId: ownedCars.includes(String(profileRow.selected_car_id)) ? String(profileRow.selected_car_id) : "2107",
    ownedCars: ownedCars.length ? ownedCars : ["2107"],
    upgrades,
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
  const playerRows = await client.query(
    "SELECT telegram_id::TEXT AS telegram_id, display_name, car_id, joined_at, last_seen_at " +
    "FROM drag_racing_room_players WHERE room_id = $1::BIGINT ORDER BY joined_at ASC, telegram_id ASC",
    [String(roomId)]
  );
  const players = playerRows.rows.map(player => {
    const result = objectValue(results[String(player.telegram_id)]);
    return {
      id: String(player.telegram_id),
      name: String(player.display_name || "Игрок").slice(0, 40),
      carId: String(player.car_id || "2107"),
      isYou: String(player.telegram_id) === String(userId),
      isOwner: String(player.telegram_id) === String(row.owner_telegram_id),
      connected: player.last_seen_at ? Date.now() - new Date(player.last_seen_at).getTime() < 15000 : false,
      joinedAt: player.joined_at,
      finishTimeMs: Number.isFinite(Number(result.timeMs)) ? Number(result.timeMs) : null,
      forfeit: Boolean(result.forfeit)
    };
  });
  return {
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

async function settleRoomIfReady(client, room, players, game, recordGameCommission) {
  if (game.phase === "finished") return;
  const ids = players.map(player => String(player.telegram_id));
  if (!ids.length || !ids.every(id => game.results?.[id])) return;
  const times = ids.map(id => Number(game.results[id].timeMs));
  const bestTime = Math.min(...times);
  const winners = ids.filter(id => Number(game.results[id].timeMs) === bestTime);
  const grossBig = BigInt(String(room.stake)) * BigInt(ids.length);
  const commissionRow = await recordGameCommission(client, {
    game: "drag-racing",
    eventKey: "drag-racing:" + String(room.id),
    grossAmount: Number(grossBig)
  });
  const commission = Math.min(Number(grossBig), Math.max(0, Math.floor(Number(commissionRow?.amount) || 0)));
  const payoutBig = grossBig - BigInt(commission);
  let remainder = payoutBig % BigInt(winners.length);
  const base = payoutBig / BigInt(winners.length);
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
  game.grossPot = Number(grossBig);
  game.commission = commission;
  game.payout = Number(payoutBig);
  game.message = winners.length === 1
    ? "Заезд завершён. Победитель получил призовой фонд за вычетом комиссии 5%."
    : "Финиш почти одновременно! Призовой фонд разделён между победителями за вычетом комиссии 5%.";
  await client.query(
    "UPDATE drag_racing_rooms SET status = 'finished', game_state = $2::jsonb, updated_at = NOW() WHERE id = $1::BIGINT",
    [String(room.id), JSON.stringify(game)]
  );
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
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_player_cars (" +
      "telegram_id BIGINT NOT NULL, car_id TEXT NOT NULL, upgrades JSONB NOT NULL DEFAULT '{}'::jsonb, " +
      "purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (telegram_id, car_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_rooms (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_telegram_id BIGINT NOT NULL, " +
      "owner_name TEXT NOT NULL DEFAULT 'Игрок', stake BIGINT NOT NULL CHECK (stake >= 100), " +
      "max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 5), " +
      "mode TEXT NOT NULL CHECK (mode IN ('quarter','half','sprint')), " +
      "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','racing','finished')), " +
      "game_state JSONB NOT NULL DEFAULT '{\"phase\":\"waiting\",\"results\":{}}'::jsonb, " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_room_players (" +
      "room_id BIGINT NOT NULL REFERENCES drag_racing_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, display_name TEXT NOT NULL DEFAULT 'Игрок', " +
      "car_id TEXT NOT NULL DEFAULT '2107', joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query("CREATE INDEX IF NOT EXISTS drag_racing_rooms_status_idx ON drag_racing_rooms (status, created_at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS drag_racing_room_players_presence_idx ON drag_racing_room_players (room_id, last_seen_at DESC)");
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
      // Clean up abandoned waiting rooms only when no member has sent a heartbeat
      // for two minutes. Refund each paid stake in the same transaction before deletion.
      maintenanceClient = await pool.connect();
      await maintenanceClient.query("BEGIN"); maintenanceOpen = true;
      const staleRooms = await maintenanceClient.query(
        "SELECT r.id::TEXT AS id, r.stake::TEXT AS stake FROM drag_racing_rooms r " +
        "WHERE r.status = 'waiting' AND NOT EXISTS (" +
          "SELECT 1 FROM drag_racing_room_players p WHERE p.room_id = r.id " +
          "AND p.last_seen_at >= NOW() - INTERVAL '2 minutes') " +
        "FOR UPDATE SKIP LOCKED"
      );
      for (const staleRoom of staleRooms.rows) {
        const members = await maintenanceClient.query(
          "SELECT telegram_id::TEXT AS telegram_id FROM drag_racing_room_players WHERE room_id = $1::BIGINT",
          [String(staleRoom.id)]
        );
        for (const member of members.rows) {
          await maintenanceClient.query(
            "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
            [String(staleRoom.stake), String(member.telegram_id)]
          );
        }
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
    const stake = safeStake(req.body?.stake);
    const maxPlayers = Number(req.body?.maxPlayers ?? req.body?.players);
    const mode = String(req.body?.mode || "quarter");
    if (stake === null) return res.status(400).json({ ok: false, error: "Ставка должна быть целым числом не меньше 100 AC." });
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 5) return res.status(400).json({ ok: false, error: "В комнате должно быть от 2 до 5 игроков." });
    if (!VALID_MODES.has(mode)) return res.status(400).json({ ok: false, error: "Выбран неизвестный режим гонки." });
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await lockPlayerBalance(client, user);
      await ensureProfile(client, user.id);
      const active = await client.query(
        "SELECT r.id FROM drag_racing_rooms r JOIN drag_racing_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1::BIGINT AND r.status IN ('waiting','racing') LIMIT 1",
        [user.id]
      );
      if (active.rows.length) throw new DragRacingError(409, "Сначала выйди из своей текущей комнаты.");
      if (balance < BigInt(stake)) throw new DragRacingError(400, "На балансе недостаточно Allcoins для этой ставки.");
      const profile = await readProfile(client, user.id);
      const requestedCar = String(req.body?.carId || profile.selectedCarId);
      const carId = profile.ownedCars.includes(requestedCar) ? requestedCar : profile.selectedCarId;
      await client.query(
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
        [stake, user.id]
      );
      const roomResult = await client.query(
        "INSERT INTO drag_racing_rooms (owner_telegram_id, owner_name, stake, max_players, mode, status, game_state) " +
        "VALUES ($1::BIGINT, $2, $3::BIGINT, $4, $5, 'waiting', '{\"phase\":\"waiting\",\"results\":{}}'::jsonb) RETURNING id::TEXT AS id",
        [user.id, user.name, stake, maxPlayers, mode]
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
      const active = await client.query(
        "SELECT r.id FROM drag_racing_rooms r JOIN drag_racing_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1::BIGINT AND r.status IN ('waiting','racing') LIMIT 1",
        [user.id]
      );
      if (active.rows.length) throw new DragRacingError(409, "Сначала выйди из своей текущей комнаты.");
      const balance = await lockPlayerBalance(client, user);
      if (balance < BigInt(String(room.stake))) throw new DragRacingError(400, "На балансе недостаточно Allcoins для этой ставки.");
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
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
        [String(room.stake), user.id]
      );
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
      if (timeMs + 2500 < elapsedSinceGreen) throw new DragRacingError(400, "Время финиша не прошло серверную проверку.");
      game.results[user.id] = {
        timeMs: Math.round(timeMs),
        carId: String(player.car_id || "2107"),
        name: String(player.display_name || user.name).slice(0, 40),
        submittedAt: Date.now()
      };
      await settleRoomIfReady(client, { ...room, id: roomId }, playerResult.rows, game, recordGameCommission);
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
        "SELECT id::TEXT AS id, stake::TEXT AS stake, status, game_state FROM drag_racing_rooms WHERE id = $1::BIGINT FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new DragRacingError(404, "Комната не найдена.");
      const member = await client.query(
        "SELECT 1 FROM drag_racing_room_players WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      if (!member.rows.length) throw new DragRacingError(403, "Ты не состоишь в этой комнате.");
      if (room.status === "racing") {
        const game = objectValue(room.game_state);
        if (Date.now() - Number(game.startedAt || Date.now()) > 120000) {
          const players = await client.query(
            "SELECT telegram_id::TEXT AS telegram_id, display_name, car_id FROM drag_racing_room_players WHERE room_id = $1::BIGINT ORDER BY joined_at ASC",
            [roomId]
          );
          game.results = objectValue(game.results);
          const previousFinishes = Object.keys(game.results).length;
          if (!previousFinishes) {
            for (const participant of players.rows) {
              await client.query(
                "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
                [String(room.stake), String(participant.telegram_id)]
              );
            }
            game.phase = "finished";
            game.finishedAt = Date.now();
            game.payout = 0;
            game.commission = 0;
            game.message = "Заезд отменён из-за отсутствия результатов. Ставки возвращены всем игрокам.";
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
            await settleRoomIfReady(client, { ...room, id: roomId }, players.rows, game, recordGameCommission);
            if (game.phase !== "finished") {
              await client.query(
                "UPDATE drag_racing_rooms SET game_state = $2::jsonb WHERE id = $1::BIGINT",
                [roomId, JSON.stringify(game)]
              );
            }
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
      if (room.status === "racing") throw new DragRacingError(409, "Заезд уже идёт. Дождись результата; ставки защищены сервером.");
      const membership = await client.query(
        "SELECT 1 FROM drag_racing_room_players WHERE room_id = $1::BIGINT AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      if (!membership.rows.length) throw new DragRacingError(403, "Ты не состоишь в этой комнате.");
      if (room.status === "waiting") {
        await client.query(
          "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
          [String(room.stake), user.id]
        );
      }
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
      return res.json({ ok: true, balance, message: room.status === "waiting" ? "Ты вышел из комнаты. Ставка возвращена." : "Ты вышел из комнаты." });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof DragRacingError ? error.status : 500;
      console.error("Leave Drag Racing room:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof DragRacingError ? error.message : "Не удалось выйти из комнаты." });
    } finally { client.release(); }
  });

  return router;
}
