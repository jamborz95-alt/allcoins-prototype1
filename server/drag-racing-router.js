import express from "express";
import { recordGameCommission } from "./commission.js";

const MIN_STAKE = 100n;
const MAX_STAKE = 9007199254740991n;
const RACE_DISTANCE_M = 402.336;
const ROOM_CODE = "DR-";

const CARS = [
  { id: "vaz2107", name: "ВАЗ-2107", subtitle: "Классика • задний привод", price: 0, hp: 74, topSpeed: 150, accel: 1.00, style: "classic" },
  { id: "vaz2109", name: "ВАЗ-2109", subtitle: "Самара • лёгкий кузов", price: 90000, hp: 78, topSpeed: 155, accel: 1.05, style: "hatch" },
  { id: "vaz2110", name: "ВАЗ-2110", subtitle: "Десятка • седан", price: 145000, hp: 80, topSpeed: 170, accel: 1.02, style: "modern" },
  { id: "priora", name: "LADA Priora", subtitle: "Динамичный седан", price: 260000, hp: 98, topSpeed: 183, accel: 1.12, style: "priora" },
  { id: "granta", name: "LADA Granta", subtitle: "Современная LADA", price: 850000, hp: 90, topSpeed: 179, accel: 1.08, style: "granta" },
  { id: "vesta", name: "LADA Vesta", subtitle: "Более мощная база", price: 1183000, hp: 106, topSpeed: 186, accel: 1.15, style: "vesta" }
];

const PARTS = [
  { id: "intake", name: "Спортивный впуск", category: "Двигатель", description: "+3 л.с. за уровень", costs: [8500, 12500, 18500], hp: 3 },
  { id: "exhaust", name: "Прямоточный выхлоп", category: "Двигатель", description: "+4 л.с. за уровень", costs: [17500, 25500, 38000], hp: 4 },
  { id: "ecu", name: "Чип-тюнинг ECU", category: "Электроника", description: "+8 л.с. за уровень", costs: [26000, 39000, 59000], hp: 8 },
  { id: "turbo", name: "Турбокит", category: "Наддув", description: "+14 л.с. за уровень", costs: [88000, 132000, 198000], hp: 14 },
  { id: "clutch", name: "Спортивное сцепление", category: "Трансмиссия", description: "Быстрее переключение", costs: [22000, 33000, 49500], shift: 0.08 },
  { id: "gearbox", name: "Усиленная КПП", category: "Трансмиссия", description: "+10 км/ч к максималке за уровень", costs: [48000, 72000, 108000], topSpeed: 10 },
  { id: "tires", name: "Драг-шины", category: "Зацеп", description: "Лучший старт с места", costs: [25000, 37500, 56000], launch: 0.08 }
];

const TUNING = [
  { id: "paint-red", name: "Красный металлик", category: "Окрас", price: 4500, key: "paint", value: "#e94343" },
  { id: "paint-blue", name: "Синий металлик", category: "Окрас", price: 4500, key: "paint", value: "#3488ee" },
  { id: "paint-yellow", name: "Жёлтый металлик", category: "Окрас", price: 4500, key: "paint", value: "#f0c83f" },
  { id: "paint-white", name: "Жемчужный белый", category: "Окрас", price: 6500, key: "paint", value: "#eeeae0" },
  { id: "paint-black", name: "Чёрный металлик", category: "Окрас", price: 6500, key: "paint", value: "#252d39" },
  { id: "rims-sport", name: "Спортивные диски", category: "Колёса", price: 18000, key: "rims", value: "sport" },
  { id: "rims-chrome", name: "Хромированные диски", category: "Колёса", price: 28000, key: "rims", value: "chrome" },
  { id: "spoiler", name: "Задний спойлер", category: "Обвес", price: 22000, key: "spoiler", value: true },
  { id: "bodykit", name: "Аэродинамический обвес", category: "Обвес", price: 52000, key: "bodykit", value: true },
  { id: "lowering", name: "Заниженная подвеска", category: "Подвеска", price: 16000, key: "lowering", value: true }
];

class DragRacingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseStake(value) {
  const raw = String(value ?? "").trim().replace(/[\s,_]/g, "");
  if (!/^\d+$/.test(raw)) return null;
  try {
    const stake = BigInt(raw);
    return stake >= MIN_STAKE && stake <= MAX_STAKE ? stake : null;
  } catch { return null; }
}

function verifiedUser(req, verifyTelegram) {
  const user = verifyTelegram(req.body?.initData);
  if (!user?.id) throw new DragRacingError(401, "Открой Drag Racing через ALLCOINS в Telegram.");
  const label = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || "Игрок";
  return { id: String(user.id), name: String(label).slice(0, 40) };
}

function defaultGarage() {
  return {
    ownedCars: ["vaz2107"],
    selectedCar: "vaz2107",
    upgrades: {},
    ownedTuning: [],
    tuning: { paint: "#e94343", rims: "stock", spoiler: false, bodykit: false, lowering: false }
  };
}

function normalizeGarage(value) {
  const starter = defaultGarage();
  const garage = value && typeof value === "object" ? value : {};
  const ownedCars = [...new Set(["vaz2107", ...(Array.isArray(garage.ownedCars) ? garage.ownedCars.map(String) : [])])]
    .filter(id => CARS.some(car => car.id === id));
  const selectedCar = ownedCars.includes(String(garage.selectedCar)) ? String(garage.selectedCar) : "vaz2107";
  const upgrades = {};
  for (const part of PARTS) {
    const level = Number(garage.upgrades?.[part.id] || 0);
    upgrades[part.id] = Number.isInteger(level) ? Math.max(0, Math.min(3, level)) : 0;
  }
  const ownedTuning = [...new Set(Array.isArray(garage.ownedTuning) ? garage.ownedTuning.map(String) : [])]
    .filter(id => TUNING.some(item => item.id === id));
  const tuning = { ...starter.tuning, ...(garage.tuning && typeof garage.tuning === "object" ? garage.tuning : {}) };
  for (const item of TUNING) {
    if (!ownedTuning.includes(item.id)) {
      if (item.key === "paint" && tuning.paint === item.value) tuning.paint = starter.tuning.paint;
      if (item.key === "rims" && tuning.rims === item.value) tuning.rims = "stock";
      if (item.key !== "paint" && item.key !== "rims" && tuning[item.key] === true) tuning[item.key] = false;
    }
  }
  return { ...starter, ...garage, ownedCars, selectedCar, upgrades, ownedTuning, tuning };
}

function performanceFor(carId, garageValue) {
  const car = CARS.find(item => item.id === carId) || CARS[0];
  const garage = normalizeGarage(garageValue);
  const upgrades = garage.upgrades || {};
  const hp = car.hp + PARTS.reduce((sum, part) => sum + (part.hp || 0) * Number(upgrades[part.id] || 0), 0);
  const topSpeed = car.topSpeed + PARTS.reduce((sum, part) => sum + (part.topSpeed || 0) * Number(upgrades[part.id] || 0), 0);
  const shiftBonus = Math.min(0.32, Number(upgrades.clutch || 0) * 0.08);
  const launchBonus = Math.min(0.24, Number(upgrades.tires || 0) * 0.08);
  return { hp, topSpeed, shiftBonus, launchBonus };
}

function garageSnapshot(garageValue, balanceValue) {
  const garage = normalizeGarage(garageValue);
  const selected = CARS.find(car => car.id === garage.selectedCar) || CARS[0];
  const perf = performanceFor(selected.id, garage);
  return {
    balance: Number(balanceValue || 0),
    garage,
    cars: CARS.map(car => ({ ...car, owned: garage.ownedCars.includes(car.id), selected: car.id === garage.selectedCar })),
    parts: PARTS.map(part => ({
      ...part,
      level: Number(garage.upgrades[part.id] || 0),
      nextPrice: part.costs[Number(garage.upgrades[part.id] || 0)] ?? null,
      maxLevel: part.costs.length
    })),
    tuningItems: TUNING.map(item => ({ ...item, owned: garage.ownedTuning.includes(item.id), selected: (
      item.key === "paint" ? garage.tuning.paint === item.value :
      item.key === "rims" ? garage.tuning.rims === item.value :
      Boolean(garage.tuning[item.key])
    ) })),
    performance: { hp: perf.hp, topSpeed: perf.topSpeed, shiftBonus: perf.shiftBonus, launchBonus: perf.launchBonus }
  };
}

async function ensurePlayer(client, user) {
  const result = await client.query(
    "INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance",
    [user.id]
  );
  return result.rows[0];
}

async function readGarage(client, userId, lock = false) {
  const result = await client.query(
    "SELECT garage FROM drag_racing_garages WHERE telegram_id = $1" + (lock ? " FOR UPDATE" : ""),
    [String(userId)]
  );
  if (result.rows.length) return normalizeGarage(result.rows[0].garage);
  const initial = defaultGarage();
  const saved = await client.query(
    "INSERT INTO drag_racing_garages (telegram_id, garage) VALUES ($1, $2::jsonb) ON CONFLICT (telegram_id) DO NOTHING RETURNING garage",
    [String(userId), JSON.stringify(initial)]
  );
  if (saved.rows.length) return normalizeGarage(saved.rows[0].garage);
  const retry = await client.query("SELECT garage FROM drag_racing_garages WHERE telegram_id = $1" + (lock ? " FOR UPDATE" : ""), [String(userId)]);
  return normalizeGarage(retry.rows[0]?.garage || initial);
}

async function saveGarage(client, userId, garage) {
  await client.query(
    "INSERT INTO drag_racing_garages (telegram_id, garage, updated_at) VALUES ($1, $2::jsonb, NOW()) " +
    "ON CONFLICT (telegram_id) DO UPDATE SET garage = EXCLUDED.garage, updated_at = NOW()",
    [String(userId), JSON.stringify(normalizeGarage(garage))]
  );
}

async function garageForPlayer(client, userId) {
  const [player, garage] = await Promise.all([
    client.query("SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1", [String(userId)]),
    readGarage(client, userId)
  ]);
  return garageSnapshot(garage, player.rows[0]?.balance || 0);
}

async function readRoom(client, roomId, userId) {
  const roomResult = await client.query(
    "SELECT id, name, owner_telegram_id::TEXT AS owner_id, stake::TEXT AS stake, max_players, status, game_state, created_at, updated_at " +
    "FROM drag_racing_rooms WHERE id = $1",
    [String(roomId)]
  );
  const room = roomResult.rows[0];
  if (!room) throw new DragRacingError(404, "Комната не найдена или уже закрыта.");
  const playerResult = await client.query(
    "SELECT telegram_id::TEXT AS id, display_name, car_id, stake_locked::TEXT AS stake_locked, joined_at, last_seen_at " +
    "FROM drag_racing_room_players WHERE room_id = $1 ORDER BY joined_at ASC, telegram_id ASC",
    [String(roomId)]
  );
  const players = playerResult.rows.map(row => ({
    id: String(row.id),
    name: String(row.display_name || "Игрок").slice(0, 40),
    carId: String(row.car_id || "vaz2107"),
    isOwner: String(row.id) === String(room.owner_id),
    isYou: String(row.id) === String(userId),
    connected: row.last_seen_at ? Date.now() - new Date(row.last_seen_at).getTime() < 12000 : false,
    joinedAt: row.joined_at
  }));
  const game = room.game_state && typeof room.game_state === "object" ? room.game_state : { phase: "waiting" };
  return {
    room: {
      id: ROOM_CODE + String(room.id),
      roomId: String(room.id),
      name: String(room.name),
      ownerId: String(room.owner_id),
      stake: Number(room.stake),
      maxPlayers: Number(room.max_players),
      status: String(room.status),
      playersCount: players.length,
      isOwner: String(room.owner_id) === String(userId),
      createdAt: room.created_at,
      updatedAt: room.updated_at
    },
    players,
    game: publicGame(game, userId)
  };
}

function publicGame(gameValue, userId) {
  if (!gameValue || typeof gameValue !== "object") return { phase: "waiting" };
  const game = gameValue;
  return {
    phase: String(game.phase || "waiting"),
    raceDistance: RACE_DISTANCE_M,
    startAt: Number(game.startAt || 0) || null,
    greenAt: Number(game.greenAt || 0) || null,
    elapsed: Math.max(0, Number(game.elapsed || 0)),
    racers: (Array.isArray(game.racers) ? game.racers : []).map(racer => ({
      id: String(racer.id),
      name: String(racer.name || "Игрок"),
      carId: String(racer.carId || "vaz2107"),
      carName: String(racer.carName || "ВАЗ-2107"),
      paint: String(racer.paint || "#e94343"),
      rims: String(racer.rims || "stock"),
      spoiler: Boolean(racer.spoiler),
      bodykit: Boolean(racer.bodykit),
      lowering: Boolean(racer.lowering),
      hp: Number(racer.hp || 74),
      topSpeed: Number(racer.topSpeed || 150),
      gear: Number(racer.gear || 1),
      rpm: Math.round(Number(racer.rpm || 900)),
      speedKmh: Math.round(Number(racer.speedKmh || 0)),
      progress: Math.max(0, Math.min(RACE_DISTANCE_M, Number(racer.progress || 0))),
      finished: Boolean(racer.finished),
      elapsed: racer.finished ? Number(racer.elapsed || 0) : null,
      isYou: String(racer.id) === String(userId),
      throttle: Boolean(racer.throttle),
      clutch: Boolean(racer.clutch),
      launchBonus: Number(racer.launchBonus || 0),
      shiftBonus: Number(racer.shiftBonus || 0),
      lastShiftQuality: String(racer.lastShiftQuality || "")
    })),
    winnerId: game.winnerId == null ? null : String(game.winnerId),
    winnerName: game.winnerName == null ? null : String(game.winnerName),
    pot: Number(game.pot || 0),
    commission: Number(game.commission || 0),
    payout: Number(game.payout || 0),
    settlementApplied: Boolean(game.settlementApplied),
    message: String(game.message || ""),
    serverNow: Date.now()
  };
}

async function settleWinner(client, roomId, room, game, winnerId) {
  if (game.settlementApplied) return;
  const participantCount = Number((await client.query(
    "SELECT COUNT(*)::INTEGER AS count FROM drag_racing_room_players WHERE room_id = $1",
    [String(roomId)]
  )).rows[0]?.count || 0);
  const pot = BigInt(String(room.stake)) * BigInt(participantCount);
  const commissionResult = await recordGameCommission(client, {
    game: "drag-racing",
    eventKey: "drag-racing:" + String(roomId) + ":finished",
    grossAmount: Number(pot)
  });
  const commission = BigInt(String(Math.max(0, Math.floor(Number(commissionResult?.amount) || 0))));
  const payout = pot > commission ? pot - commission : 0n;
  const winner = game.racers.find(racer => String(racer.id) === String(winnerId));
  if (winner && payout > 0n) {
    const updated = await client.query(
      "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2 RETURNING balance",
      [payout.toString(), String(winner.id)]
    );
    if (!updated.rows.length) throw new Error("Не удалось начислить выигрыш в Drag Racing.");
  }
  game.winnerId = winner ? String(winner.id) : null;
  game.winnerName = winner ? String(winner.name) : "Нет победителя";
  game.pot = Number(pot);
  game.commission = Number(commission);
  game.payout = Number(payout);
  game.settlementApplied = true;
  game.phase = "finished";
  game.finishedAt = Date.now();
  game.message = winner
    ? winner.name + " победил в Drag Racing! Выплата: " + Number(payout).toLocaleString("ru-RU") + " AC, комиссия: " + Number(commission).toLocaleString("ru-RU") + " AC."
    : "Гонка завершена без победителя. Обратись в поддержку.";
  await client.query(
    "UPDATE drag_racing_rooms SET status = 'finished', game_state = $2::jsonb, updated_at = NOW() WHERE id = $1",
    [String(roomId), JSON.stringify(game)]
  );
}

function advanceRace(game, now = Date.now()) {
  if (!game || game.phase !== "racing" || game.settlementApplied) return false;
  let changed = false;
  if (now < Number(game.greenAt || 0)) return false;
  const previous = Number(game.lastTickAt || game.greenAt || now);
  const dt = Math.max(0, Math.min(0.22, (now - previous) / 1000));
  if (dt <= 0) return false;
  game.lastTickAt = now;
  game.elapsed = Math.max(0, (now - Number(game.greenAt)) / 1000);
  for (const racer of game.racers) {
    if (racer.finished || racer.disqualified) continue;
    const gear = Math.max(1, Math.min(6, Number(racer.gear || 1)));
    const gearTop = [48, 78, 112, 145, 178, Number(racer.topSpeed || 150) + 15][gear - 1];
    const limitKmh = Math.min(Number(racer.topSpeed || 150) + 25, gearTop);
    const speed = Number(racer.speedKmh || 0);
    let rpm = Number(racer.rpm || 900);
    if (racer.clutch) {
      rpm += (racer.throttle ? 3200 : -1600) * dt;
      rpm = Math.max(850, Math.min(7600, rpm));
    } else if (racer.throttle) {
      const rpmTarget = Math.min(7400, 1500 + speed * (42 / Math.max(1, gear)));
      rpm += (rpmTarget - rpm) * Math.min(1, dt * 2.9);
    } else {
      rpm += (900 - rpm) * Math.min(1, dt * 1.6);
    }
    racer.rpm = Math.max(850, Math.min(7600, rpm));

    const rpmRatio = Number(racer.rpm) / 6500;
    const rpmPower = Math.max(0.42, 1 - Math.abs(rpmRatio - 0.86) * 0.76);
    const gearAcceleration = [1.0, 0.79, 0.64, 0.53, 0.45, 0.39][gear - 1];
    const hpFactor = Math.sqrt(Math.max(50, Number(racer.hp || 74)) / 74);
    let acceleration = racer.throttle && !racer.clutch ? (4.25 * hpFactor * gearAcceleration * rpmPower) : 0;
    if (now < Number(racer.shiftPenaltyUntil || 0)) acceleration *= 0.15;
    if (Number(racer.progress || 0) < 16) acceleration *= 1 + Number(racer.launchBonus || 0);
    let nextSpeed = speed;
    if (racer.throttle && !racer.clutch) nextSpeed += acceleration * dt * 3.6;
    else nextSpeed = Math.max(0, speed - (racer.clutch ? 3.2 : 0.7) * dt);
    nextSpeed = Math.min(limitKmh, nextSpeed);
    racer.speedKmh = Math.max(0, nextSpeed);
    racer.progress = Math.min(RACE_DISTANCE_M, Number(racer.progress || 0) + (nextSpeed / 3.6) * dt);
    if (racer.progress >= RACE_DISTANCE_M) {
      racer.progress = RACE_DISTANCE_M;
      racer.finished = true;
      racer.elapsed = Math.max(0.01, (now - Number(game.greenAt)) / 1000);
      racer.finishAt = now;
      changed = true;
    }
  }
  if (changed) {
    const finishedRacer = game.racers.filter(racer => racer.finished).sort((a, b) => Number(a.elapsed) - Number(b.elapsed))[0];
    if (finishedRacer) {
      game.phase = "settling";
      game.winnerId = String(finishedRacer.id);
      game.winnerName = String(finishedRacer.name);
    }
  }
  if (game.elapsed > 40 && game.phase === "racing") {
    const remaining = game.racers.filter(racer => !racer.disqualified);
    remaining.sort((a, b) => Number(b.progress || 0) - Number(a.progress || 0));
    const winner = remaining[0];
    if (winner) {
      winner.finished = true;
      winner.elapsed = game.elapsed;
      game.phase = "settling";
      game.winnerId = String(winner.id);
      game.winnerName = String(winner.name);
      game.message = "Лимит времени гонки: результат определён по дистанции.";
      changed = true;
    }
  }
  return true || changed;
}

export function createDragRacingRouter({ pool, verifyTelegram }) {
  const router = express.Router();

  router.post("/garage", async (req, res) => {
    try {
      const user = verifiedUser(req, verifyTelegram);
      await ensurePlayer(pool, user);
      const snapshot = await garageForPlayer(pool, user.id);
      return res.json({ ok: true, ...snapshot });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось открыть гараж." });
    }
  });

  router.post("/garage/select-car", async (req, res) => {
    try {
      const user = verifiedUser(req, verifyTelegram);
      const carId = String(req.body?.carId || "");
      if (!CARS.some(car => car.id === carId)) throw new DragRacingError(400, "Такого автомобиля нет в каталоге.");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await ensurePlayer(client, user);
        const garage = await readGarage(client, user.id, true);
        if (!garage.ownedCars.includes(carId)) throw new DragRacingError(403, "Сначала купи этот автомобиль в магазине.");
        garage.selectedCar = carId;
        await saveGarage(client, user.id, garage);
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
      return res.json({ ok: true, ...(await garageForPlayer(pool, user.id)) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось выбрать автомобиль." });
    }
  });

  router.post("/garage/buy-car", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const car = CARS.find(item => item.id === String(req.body?.carId || ""));
      if (!car) throw new DragRacingError(400, "Такого автомобиля нет в каталоге.");
      await client.query("BEGIN"); open = true;
      await ensurePlayer(client, user);
      const player = await client.query("SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1 FOR UPDATE", [user.id]);
      const garage = await readGarage(client, user.id, true);
      if (garage.ownedCars.includes(car.id)) throw new DragRacingError(409, "Этот автомобиль уже есть в гараже.");
      const balance = BigInt(String(player.rows[0]?.balance || "0"));
      if (balance < BigInt(car.price)) throw new DragRacingError(400, "Недостаточно AC для покупки автомобиля.");
      await client.query("UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2", [String(car.price), user.id]);
      garage.ownedCars.push(car.id);
      garage.selectedCar = car.id;
      await saveGarage(client, user.id, garage);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await garageForPlayer(pool, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось купить автомобиль." });
    } finally { client.release(); }
  });

  router.post("/garage/buy-part", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const part = PARTS.find(item => item.id === String(req.body?.partId || ""));
      if (!part) throw new DragRacingError(400, "Такой запчасти нет в каталоге.");
      await client.query("BEGIN"); open = true;
      await ensurePlayer(client, user);
      const player = await client.query("SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1 FOR UPDATE", [user.id]);
      const garage = await readGarage(client, user.id, true);
      const level = Number(garage.upgrades[part.id] || 0);
      if (level >= part.costs.length) throw new DragRacingError(409, "Эта запчасть уже улучшена до максимального уровня.");
      const price = part.costs[level];
      if (BigInt(String(player.rows[0]?.balance || "0")) < BigInt(price)) throw new DragRacingError(400, "Недостаточно AC для покупки запчасти.");
      await client.query("UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2", [String(price), user.id]);
      garage.upgrades[part.id] = level + 1;
      await saveGarage(client, user.id, garage);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await garageForPlayer(pool, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось купить запчасть." });
    } finally { client.release(); }
  });

  router.post("/garage/buy-tuning", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const item = TUNING.find(entry => entry.id === String(req.body?.itemId || ""));
      if (!item) throw new DragRacingError(400, "Такого элемента тюнинга нет в каталоге.");
      await client.query("BEGIN"); open = true;
      await ensurePlayer(client, user);
      const player = await client.query("SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1 FOR UPDATE", [user.id]);
      const garage = await readGarage(client, user.id, true);
      if (garage.ownedTuning.includes(item.id)) throw new DragRacingError(409, "Этот элемент тюнинга уже куплен.");
      if (BigInt(String(player.rows[0]?.balance || "0")) < BigInt(item.price)) throw new DragRacingError(400, "Недостаточно AC для тюнинга.");
      await client.query("UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2", [String(item.price), user.id]);
      garage.ownedTuning.push(item.id);
      garage.tuning[item.key] = item.value;
      await saveGarage(client, user.id, garage);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await garageForPlayer(pool, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось купить тюнинг." });
    } finally { client.release(); }
  });

  router.post("/rooms/list", async (req, res) => {
    try {
      const user = verifiedUser(req, verifyTelegram);
      await ensurePlayer(pool, user);
      await pool.query(
        "DELETE FROM drag_racing_room_players p USING drag_racing_rooms r WHERE p.room_id = r.id AND r.status = 'waiting' AND p.last_seen_at < NOW() - INTERVAL '120 seconds'"
      );
      await pool.query(
        "DELETE FROM drag_racing_rooms r WHERE r.status = 'waiting' AND r.created_at < NOW() - INTERVAL '30 minutes' AND NOT EXISTS (SELECT 1 FROM drag_racing_room_players p WHERE p.room_id = r.id AND p.last_seen_at > NOW() - INTERVAL '120 seconds')"
      );
      await pool.query("DELETE FROM drag_racing_rooms WHERE status = 'finished' AND updated_at < NOW() - INTERVAL '2 minutes'");
      const result = await pool.query(
        "SELECT r.id, r.name, r.owner_telegram_id::TEXT AS owner_id, r.stake::TEXT AS stake, r.max_players, " +
        "COUNT(p.telegram_id)::INTEGER AS players_count, r.created_at " +
        "FROM drag_racing_rooms r LEFT JOIN drag_racing_room_players p ON p.room_id = r.id " +
        "WHERE r.status = 'waiting' GROUP BY r.id HAVING COUNT(p.telegram_id) < r.max_players " +
        "ORDER BY r.created_at DESC LIMIT 80"
      );
      return res.json({ ok: true, rooms: result.rows.map(row => ({
        id: ROOM_CODE + String(row.id), roomId: String(row.id), name: String(row.name),
        ownerName: String(row.owner_id) === user.id ? user.name : "Гонщик",
        playersCount: Number(row.players_count), stake: Number(row.stake),
        maxPlayers: Number(row.max_players), createdAt: row.created_at
      })) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось загрузить комнаты." });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const name = String(req.body?.name || "").trim().slice(0, 36) || "Drag Racing ALLCOINS";
      const maxPlayers = Number(req.body?.maxPlayers);
      const stake = parseStake(req.body?.stake);
      if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 5) throw new DragRacingError(400, "В комнате может быть от 2 до 5 игроков.");
      if (stake === null) throw new DragRacingError(400, "Ставка должна быть целым числом от 100 AC и выше.");
      await client.query("BEGIN"); open = true;
      await ensurePlayer(client, user);
      const playerResult = await client.query("SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1 FOR UPDATE", [user.id]);
      if (BigInt(String(playerResult.rows[0]?.balance || "0")) < stake) throw new DragRacingError(400, "Недостаточно AC для ставки.");
      const garage = await readGarage(client, user.id);
      const created = await client.query(
        "INSERT INTO drag_racing_rooms (name, owner_telegram_id, stake, max_players, status, game_state) VALUES ($1, $2, $3, $4, 'waiting', $5::jsonb) RETURNING id",
        [name, user.id, stake.toString(), maxPlayers, JSON.stringify({ phase: "waiting", pot: 0, message: "Ожидание соперников" })]
      );
      const roomId = String(created.rows[0].id);
      await client.query("UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2", [stake.toString(), user.id]);
      await client.query(
        "INSERT INTO drag_racing_room_players (room_id, telegram_id, display_name, car_id, stake_locked, last_seen_at) VALUES ($1, $2, $3, $4, $5, NOW())",
        [roomId, user.id, user.name, garage.selectedCar, stake.toString()]
      );
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await readRoom(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось создать комнату." });
    } finally { client.release(); }
  });

  router.post("/rooms/join", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "").replace(/^DR-/i, "");
      if (!/^\d{1,18}$/.test(roomId)) throw new DragRacingError(400, "Неверный номер комнаты.");
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query("SELECT * FROM drag_racing_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room || room.status !== "waiting") throw new DragRacingError(404, "Комната уже закрыта.");
      await ensurePlayer(client, user);
      const already = await client.query("SELECT 1 FROM drag_racing_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      if (!already.rows.length) {
        const count = await client.query("SELECT COUNT(*)::INTEGER AS count FROM drag_racing_room_players WHERE room_id = $1", [roomId]);
        if (Number(count.rows[0]?.count || 0) >= Number(room.max_players)) throw new DragRacingError(409, "В комнате уже нет свободных мест.");
        const balanceResult = await client.query("SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1 FOR UPDATE", [user.id]);
        const stake = BigInt(String(room.stake));
        if (BigInt(String(balanceResult.rows[0]?.balance || "0")) < stake) throw new DragRacingError(400, "Недостаточно AC для ставки.");
        const garage = await readGarage(client, user.id);
        await client.query("UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2", [stake.toString(), user.id]);
        await client.query(
          "INSERT INTO drag_racing_room_players (room_id, telegram_id, display_name, car_id, stake_locked, last_seen_at) VALUES ($1, $2, $3, $4, $5, NOW())",
          [roomId, user.id, user.name, garage.selectedCar, stake.toString()]
        );
      } else {
        await client.query("UPDATE drag_racing_room_players SET last_seen_at = NOW() WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      }
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await readRoom(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось войти в комнату." });
    } finally { client.release(); }
  });

  router.post("/rooms/state", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "").replace(/^DR-/i, "");
      if (!/^\d{1,18}$/.test(roomId)) throw new DragRacingError(400, "Неверный номер комнаты.");
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query("SELECT * FROM drag_racing_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new DragRacingError(404, "Комната не найдена.");
      const member = await client.query("SELECT 1 FROM drag_racing_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      if (!member.rows.length) throw new DragRacingError(403, "Ты не состоишь в этой комнате.");
      await client.query("UPDATE drag_racing_room_players SET last_seen_at = NOW() WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      if (room.status === "playing") {
        const game = room.game_state && typeof room.game_state === "object" ? room.game_state : {};
        if (game.phase === "countdown" && Date.now() >= Number(game.startAt || 0)) {
          game.phase = "racing";
          game.greenAt = Number(game.startAt);
          game.lastTickAt = Number(game.greenAt);
          game.message = "Зелёный! Газ в пол и переключай передачи вручную.";
          await client.query("UPDATE drag_racing_rooms SET game_state = $2::jsonb, updated_at = NOW() WHERE id = $1", [roomId, JSON.stringify(game)]);
        }
        if (game.phase === "racing") {
          advanceRace(game, Date.now());
          if (game.phase === "settling") {
            await settleWinner(client, roomId, room, game, game.winnerId);
          } else {
            await client.query("UPDATE drag_racing_rooms SET game_state = $2::jsonb, updated_at = NOW() WHERE id = $1", [roomId, JSON.stringify(game)]);
          }
        }
      }
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await readRoom(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось обновить состояние гонки." });
    } finally { client.release(); }
  });

  router.post("/rooms/start", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "").replace(/^DR-/i, "");
      if (!/^\d{1,18}$/.test(roomId)) throw new DragRacingError(400, "Неверный номер комнаты.");
      await client.query("BEGIN"); open = true;
      const result = await client.query("SELECT * FROM drag_racing_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = result.rows[0];
      if (!room || room.status !== "waiting") throw new DragRacingError(409, "Эта комната уже запущена или закрыта.");
      if (String(room.owner_telegram_id) !== user.id) throw new DragRacingError(403, "Начать гонку может только создатель комнаты.");
      const resultPlayers = await client.query(
        "SELECT telegram_id::TEXT AS id, display_name, car_id FROM drag_racing_room_players WHERE room_id = $1 ORDER BY joined_at ASC, telegram_id ASC",
        [roomId]
      );
      if (resultPlayers.rows.length < 2) throw new DragRacingError(400, "Нужны минимум два игрока, чтобы начать гонку.");
      const racers = [];
      for (const row of resultPlayers.rows) {
        const garage = await readGarage(client, row.id);
        const car = CARS.find(item => item.id === String(row.car_id)) || CARS[0];
        const performance = performanceFor(car.id, garage);
        racers.push({
          id: String(row.id),
          name: String(row.display_name || "Игрок"),
          carId: car.id,
          carName: car.name,
          carStyle: car.style,
          paint: String(garage.tuning.paint || "#e94343"),
          rims: String(garage.tuning.rims || "stock"),
          spoiler: Boolean(garage.tuning.spoiler),
          bodykit: Boolean(garage.tuning.bodykit),
          lowering: Boolean(garage.tuning.lowering),
          hp: performance.hp,
          topSpeed: performance.topSpeed,
          shiftBonus: performance.shiftBonus,
          launchBonus: performance.launchBonus,
          gear: 1,
          rpm: 1000,
          speedKmh: 0,
          progress: 0,
          throttle: false,
          clutch: true,
          finished: false,
          elapsed: null,
          shiftPenaltyUntil: 0,
          disqualified: false
        });
      }
      const startAt = Date.now() + 3500;
      const game = {
        phase: "countdown",
        raceDistance: RACE_DISTANCE_M,
        startAt,
        greenAt: startAt,
        lastTickAt: startAt,
        elapsed: 0,
        pot: Number(BigInt(String(room.stake)) * BigInt(resultPlayers.rows.length)),
        racers,
        winnerId: null,
        winnerName: null,
        commission: 0,
        payout: 0,
        settlementApplied: false,
        message: "Прогрев двигателя. Старт через 3… 2… 1…"
      };
      await client.query(
        "UPDATE drag_racing_rooms SET status = 'playing', game_state = $2::jsonb, updated_at = NOW() WHERE id = $1",
        [roomId, JSON.stringify(game)]
      );
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await readRoom(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось запустить гонку." });
    } finally { client.release(); }
  });

  router.post("/game/control", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "").replace(/^DR-/i, "");
      const action = String(req.body?.action || "");
      if (!/^\d{1,18}$/.test(roomId)) throw new DragRacingError(400, "Неверный номер комнаты.");
      if (!["throttle", "clutch", "shift-up", "shift-down"].includes(action)) throw new DragRacingError(400, "Неизвестное действие гонщика.");
      await client.query("BEGIN"); open = true;
      const result = await client.query("SELECT * FROM drag_racing_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = result.rows[0];
      if (!room || room.status !== "playing") throw new DragRacingError(409, "Гонка уже не активна.");
      const member = await client.query("SELECT 1 FROM drag_racing_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      if (!member.rows.length) throw new DragRacingError(403, "Ты не состоишь в этой комнате.");
      const game = room.game_state && typeof room.game_state === "object" ? room.game_state : {};
      if (game.phase !== "racing" && game.phase !== "countdown") throw new DragRacingError(409, "Сейчас нельзя управлять машиной.");
      const racer = (game.racers || []).find(item => String(item.id) === user.id);
      if (!racer || racer.finished || racer.disqualified) throw new DragRacingError(403, "Эта машина больше не участвует в гонке.");
      const now = Date.now();
      if (game.phase === "racing") advanceRace(game, now);
      if (action === "throttle") racer.throttle = Boolean(req.body?.pressed);
      if (action === "clutch") racer.clutch = Boolean(req.body?.pressed);
      if (action === "shift-up" || action === "shift-down") {
        const nextGear = Number(racer.gear) + (action === "shift-up" ? 1 : -1);
        if (nextGear < 1 || nextGear > 6) throw new DragRacingError(400, "Эта передача уже на пределе.");
        if (!racer.clutch) throw new DragRacingError(400, "Перед переключением нажми сцепление.");
        const rpm = Number(racer.rpm || 900);
        const ideal = rpm >= 4700 && rpm <= 6900;
        racer.gear = nextGear;
        racer.rpm = Math.max(2200, Math.min(6500, Math.round(rpm * (action === "shift-up" ? 0.70 : 0.92))));
        const penalty = ideal ? Math.max(100, 260 - Math.round(Number(racer.shiftBonus || 0) * 350)) : Math.max(450, 850 - Math.round(Number(racer.shiftBonus || 0) * 550));
        racer.shiftPenaltyUntil = now + penalty;
        racer.lastShiftQuality = ideal ? "perfect" : "miss";
      }
      await client.query("UPDATE drag_racing_rooms SET game_state = $2::jsonb, updated_at = NOW() WHERE id = $1", [roomId, JSON.stringify(game)]);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, game: publicGame(game, user.id) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Управление не отправлено." });
    } finally { client.release(); }
  });

  router.post("/rooms/leave", async (req, res) => {
    const client = await pool.connect();
    let open = false;
    try {
      const user = verifiedUser(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "").replace(/^DR-/i, "");
      if (!/^\d{1,18}$/.test(roomId)) throw new DragRacingError(400, "Неверный номер комнаты.");
      await client.query("BEGIN"); open = true;
      const result = await client.query("SELECT * FROM drag_racing_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = result.rows[0];
      if (!room) { await client.query("COMMIT"); return res.json({ ok: true, roomClosed: true }); }
      const memberResult = await client.query(
        "SELECT stake_locked::TEXT AS stake_locked FROM drag_racing_room_players WHERE room_id = $1 AND telegram_id = $2 FOR UPDATE",
        [roomId, user.id]
      );
      const member = memberResult.rows[0];
      if (!member) { await client.query("COMMIT"); return res.json({ ok: true }); }
      if (room.status === "waiting") {
        const participants = await client.query(
          "SELECT telegram_id::TEXT AS id, stake_locked::TEXT AS stake_locked FROM drag_racing_room_players WHERE room_id = $1 FOR UPDATE",
          [roomId]
        );
        const closeRoom = String(room.owner_telegram_id) === user.id;
        const returnRows = closeRoom ? participants.rows : [participants.rows.find(row => String(row.id) === user.id)].filter(Boolean);
        for (const row of returnRows) {
          const refund = BigInt(String(row.stake_locked || "0"));
          if (refund > 0n) await client.query(
            "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2",
            [refund.toString(), String(row.id)]
          );
          await client.query("DELETE FROM drag_racing_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, String(row.id)]);
        }
        if (closeRoom || participants.rows.length <= 1) {
          await client.query("DELETE FROM drag_racing_rooms WHERE id = $1", [roomId]);
        } else {
          await client.query("UPDATE drag_racing_rooms SET updated_at = NOW() WHERE id = $1", [roomId]);
        }
      } else if (room.status === "playing") {
        const game = room.game_state && typeof room.game_state === "object" ? room.game_state : {};
        const racer = (game.racers || []).find(item => String(item.id) === user.id);
        if (racer && !racer.finished) {
          racer.disqualified = true;
          racer.throttle = false;
          racer.clutch = false;
          const remaining = game.racers.filter(item => !item.disqualified);
          if (remaining.length === 1) {
            game.phase = "settling";
            game.winnerId = String(remaining[0].id);
            game.winnerName = String(remaining[0].name);
            await settleWinner(client, roomId, room, game, remaining[0].id);
          } else {
            game.message = user.name + " покинул гонку.";
            await client.query("UPDATE drag_racing_rooms SET game_state = $2::jsonb, updated_at = NOW() WHERE id = $1", [roomId, JSON.stringify(game)]);
          }
        }
      } else {
        await client.query("DELETE FROM drag_racing_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      }
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось выйти из комнаты." });
    } finally { client.release(); }
  });

  router.initialize = async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_garages (" +
      "telegram_id BIGINT PRIMARY KEY, garage JSONB NOT NULL DEFAULT '{}'::jsonb, " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_rooms (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, " +
      "owner_telegram_id BIGINT NOT NULL, stake BIGINT NOT NULL CHECK (stake >= 100), " +
      "max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 5), " +
      "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished')), " +
      "game_state JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drag_racing_room_players (" +
      "room_id BIGINT NOT NULL REFERENCES drag_racing_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, display_name TEXT NOT NULL, car_id TEXT NOT NULL DEFAULT 'vaz2107', " +
      "stake_locked BIGINT NOT NULL DEFAULT 0 CHECK (stake_locked >= 0), " +
      "joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query("CREATE INDEX IF NOT EXISTS drag_racing_rooms_status_created_idx ON drag_racing_rooms(status, created_at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS drag_racing_room_players_seen_idx ON drag_racing_room_players(room_id, last_seen_at)");
    const cleanupTimer = setInterval(async () => {
      try {
        await pool.query(
          "DELETE FROM drag_racing_room_players p USING drag_racing_rooms r " +
          "WHERE p.room_id = r.id AND r.status = 'waiting' AND p.last_seen_at < NOW() - INTERVAL '120 seconds'"
        );
        await pool.query(
          "DELETE FROM drag_racing_rooms r WHERE r.status = 'waiting' AND r.created_at < NOW() - INTERVAL '30 minutes' " +
          "AND NOT EXISTS (SELECT 1 FROM drag_racing_room_players p WHERE p.room_id = r.id AND p.last_seen_at > NOW() - INTERVAL '120 seconds')"
        );
        await pool.query("DELETE FROM drag_racing_rooms WHERE status = 'finished' AND updated_at < NOW() - INTERVAL '2 minutes'");
      } catch (error) { console.error("Drag Racing room cleanup failed:", error.message); }
    }, 15000);
    if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
    console.log("Drag Racing garage and room tables are ready");
  };

  return router;
}
