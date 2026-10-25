import express from "express";
import { recordGameCommission } from "./commission.js";

const BOT_ID = "0";
const COLORS = ["blue", "red", "green"];

function amountValue(value) {
  const text = String(value ?? "").trim().replace(/[\s,]/g, "");
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 100 ? n : null;
}

function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return String(user.username ? "@" + user.username : name || "Игрок").slice(0, 40);
}

function mapRoom(row) {
  return {
    id: String(row.id),
    name: row.name || "Комната захвата башен",
    stake: String(row.stake),
    status: row.status,
    maxPlayers: Number(row.max_players),
    playersCount: Number(row.players_count || 0),
    owner: row.owner_name || "Игрок",
    createdAt: row.created_at
  };
}

function distance(a, b) {
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

function makeGame(players, stake) {
  const slots = [
    { x: 19, y: 77, ownerIndex: 0, units: 20 },
    { x: 80, y: 25, ownerIndex: 1, units: 20 },
    { x: 80, y: 77, ownerIndex: 2, units: 20 },
    { x: 28, y: 30, ownerIndex: -1, units: 7 },
    { x: 50, y: 19, ownerIndex: -1, units: 9 },
    { x: 54, y: 48, ownerIndex: -1, units: 8 },
    { x: 25, y: 53, ownerIndex: -1, units: 8 },
    { x: 70, y: 52, ownerIndex: -1, units: 8 },
    { x: 48, y: 77, ownerIndex: -1, units: 7 }
  ];
  return {
    status: "playing",
    startedAt: Date.now(),
    lastTick: Date.now(),
    nextFleetId: 1,
    nextBotAt: Date.now() + 2500,
    stake: Number(stake),
    players: players.map((p, i) => ({
      telegramId: String(p.telegram_id),
      name: p.display_name || "Игрок",
      color: COLORS[i] || "green"
    })),
    towers: slots.map((t, i) => ({
      id: i + 1,
      x: t.x,
      y: t.y,
      ownerId: t.ownerIndex >= 0 && players[t.ownerIndex] ? String(players[t.ownerIndex].telegram_id) : null,
      units: t.units,
      income: t.ownerIndex >= 0 ? 1.7 : 0.8
    })),
    fleets: [],
    winnerTelegramId: null,
    result: null,
    settled: false,
    feed: [{ text: "Башни захватываются отправкой войск: выбери свою башню, затем цель.", at: Date.now() }]
  };
}

function tickGame(game, now) {
  if (!game || game.status !== "playing") return;
  const dt = Math.max(0, Math.min(3.5, (now - Number(game.lastTick || now)) / 1000));
  game.lastTick = now;
  for (const tower of game.towers) {
    if (tower.ownerId) tower.units = Math.min(999, Number(tower.units || 0) + Number(tower.income || 1) * dt);
  }
  for (const fleet of game.fleets) {
    fleet.progress = Math.min(1, Number(fleet.progress || 0) + dt / Math.max(1.1, Number(fleet.duration || 3)));
  }
  const landed = game.fleets.filter(f => f.progress >= 1);
  game.fleets = game.fleets.filter(f => f.progress < 1);
  for (const fleet of landed) {
    const target = game.towers.find(t => t.id === fleet.toId);
    if (!target) continue;
    const troops = Math.floor(fleet.units);
    if (target.ownerId === fleet.ownerId) {
      target.units = Math.min(999, target.units + troops);
      continue;
    }
    const defenders = Math.floor(target.units);
    if (troops > defenders) {
      target.ownerId = fleet.ownerId;
      target.units = Math.max(1, troops - defenders);
      target.income = 1.7;
      game.feed.unshift({ text: "Башня захвачена!", at: now });
    } else {
      target.units = Math.max(0, defenders - troops);
      if (target.units === 0) {
        target.ownerId = fleet.ownerId;
        target.units = 1;
        target.income = 1.7;
      }
    }
  }
  game.feed = (game.feed || []).slice(0, 5);
  const alive = game.players.filter(p => game.towers.some(t => t.ownerId === p.telegramId));
  if (alive.length === 1) {
    game.status = "finished";
    game.winnerTelegramId = alive[0].telegramId;
    game.result = alive[0].name + " захватывает все башни!";
  } else if (now - Number(game.startedAt || now) > 8 * 60 * 1000) {
    const score = p => game.towers.filter(t => t.ownerId === p.telegramId).length * 100 + game.towers.filter(t => t.ownerId === p.telegramId).reduce((sum, t) => sum + Math.floor(t.units), 0);
    const winner = [...game.players].sort((a, b) => score(b) - score(a))[0];
    game.status = "finished";
    game.winnerTelegramId = winner?.telegramId || null;
    game.result = (winner?.name || "Игрок") + " выигрывает по количеству башен!";
  }
  if (game.status === "playing" && now >= Number(game.nextBotAt || 0)) {
    game.nextBotAt = now + 2600;
    // Bot ids are only used in local practice mode. Real rooms contain human Telegram ids.
    const bot = game.players.find(p => p.telegramId === BOT_ID);
    if (bot) {
      const sources = game.towers.filter(t => t.ownerId === BOT_ID && t.units >= 8);
      const targets = game.towers.filter(t => t.ownerId !== BOT_ID);
      if (sources.length && targets.length) {
        sources.sort((a, b) => b.units - a.units);
        const source = sources[0];
        targets.sort((a, b) => distance(source, a) - distance(source, b));
        const target = targets[0];
        const troops = Math.max(3, Math.floor(source.units * 0.58));
        source.units -= troops;
        game.fleets.push({
          id: game.nextFleetId++, fromId: source.id, toId: target.id,
          ownerId: BOT_ID, units: troops, progress: 0,
          duration: Math.max(1.1, distance(source, target) / 16)
        });
      }
    }
  }
}

export function createTowersRouter({ pool, verifyTelegram }) {
  const router = express.Router();
  function userFrom(req, res) {
    const user = verifyTelegram(req.body?.initData);
    if (!user?.id) {
      res.status(401).json({ ok: false, error: "Открой ALLCOINS через Telegram, чтобы создавать и входить в комнаты." });
      return null;
    }
    return user;
  }
  async function ensurePlayer(client, user) {
    const result = await client.query(
      "INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance",
      [String(user.id)]
    );
    return Number(result.rows[0]?.balance || 0);
  }
  async function readRoom(client, roomId, lock = false) {
    const result = await client.query(
      "SELECT id, name, owner_telegram_id, owner_name, stake, max_players, status FROM towers_rooms WHERE id = $1" + (lock ? " FOR UPDATE" : ""),
      [roomId]
    );
    return result.rows[0] || null;
  }
  async function isMember(client, roomId, userId) {
    const r = await client.query("SELECT 1 FROM towers_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, String(userId)]);
    return r.rows.length > 0;
  }
  async function updateAndSettle(client, room, game) {
    tickGame(game, Date.now());
    if (game.status === "finished" && !game.settled) {
      const gross = Number(room.stake) * game.players.filter(p => p.telegramId !== BOT_ID).length;
      const commission = await recordGameCommission(client, {
        game: "towers",
        eventKey: "towers:" + String(room.id) + ":" + String(game.startedAt),
        grossAmount: gross
      });
      const burned = Math.min(gross, Math.max(0, Math.floor(Number(commission.amount) || 0)));
      const prize = Math.max(0, gross - burned);
      if (game.winnerTelegramId && game.winnerTelegramId !== BOT_ID && prize > 0) {
        await client.query(
          "UPDATE players SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2",
          [prize, String(game.winnerTelegramId)]
        );
      }
      game.settled = true;
      game.settlement = { gross, burned, prize, winnerTelegramId: game.winnerTelegramId };
      await client.query("UPDATE towers_rooms SET status = 'finished' WHERE id = $1", [room.id]);
    }
    await client.query(
      "INSERT INTO towers_games (room_id, game_state, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (room_id) DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = NOW()",
      [room.id, JSON.stringify(game)]
    );
  }

  router.initialize = async function initializeTowersTables() {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS towers_rooms (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Комната захвата башен', owner_telegram_id BIGINT NOT NULL, owner_name TEXT NOT NULL DEFAULT 'Игрок', stake NUMERIC NOT NULL CHECK (stake >= 100), max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 3), status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS towers_room_players (room_id BIGINT NOT NULL REFERENCES towers_rooms(id) ON DELETE CASCADE, telegram_id BIGINT NOT NULL, display_name TEXT NOT NULL DEFAULT 'Игрок', joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS towers_games (room_id BIGINT PRIMARY KEY REFERENCES towers_rooms(id) ON DELETE CASCADE, game_state JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query("CREATE INDEX IF NOT EXISTS towers_waiting_rooms_idx ON towers_rooms (status, created_at DESC)");
  };

  router.post("/rooms/list", async (req, res) => {
    const user = userFrom(req, res); if (!user) return;
    try {
      await pool.query("DELETE FROM towers_rooms WHERE status = 'waiting' AND created_at < NOW() - INTERVAL '45 minutes'");
      const result = await pool.query(
        "SELECT r.id, r.name, r.owner_telegram_id, r.owner_name, r.stake, r.max_players, r.status, r.created_at, COUNT(rp.telegram_id)::INTEGER AS players_count FROM towers_rooms r LEFT JOIN towers_room_players rp ON rp.room_id = r.id WHERE r.status = 'waiting' GROUP BY r.id ORDER BY r.created_at DESC LIMIT 50"
      );
      return res.json({ ok: true, rooms: result.rows.map(mapRoom) });
    } catch (error) {
      console.error("List Towers rooms error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить комнаты." });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const user = userFrom(req, res); if (!user) return;
    const stake = amountValue(req.body?.stake);
    const maxPlayers = Number(req.body?.maxPlayers);
    const name = String(req.body?.name || "Захват башен").trim().slice(0, 40) || "Захват башен";
    if (stake === null) return res.status(400).json({ ok: false, error: "Ставка должна быть целым числом не меньше 100 AC." });
    if (![2, 3].includes(maxPlayers)) return res.status(400).json({ ok: false, error: "Выбери комнату на 2 или 3 игроков." });
    let client;
    try {
      client = await pool.connect(); await client.query("BEGIN");
      const balance = await ensurePlayer(client, user);
      if (balance < stake) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "На балансе недостаточно AC для этой ставки." }); }
      const created = await client.query(
        "INSERT INTO towers_rooms (name, owner_telegram_id, owner_name, stake, max_players) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [name, String(user.id), displayName(user), String(stake), maxPlayers]
      );
      const roomId = created.rows[0].id;
      await client.query(
        "INSERT INTO towers_room_players (room_id, telegram_id, display_name) VALUES ($1,$2,$3)",
        [roomId, String(user.id), displayName(user)]
      );
      await client.query("COMMIT");
      return res.json({ ok: true, roomId: String(roomId), name, stake: String(stake), maxPlayers });
    } catch (error) {
      try { await client?.query("ROLLBACK"); } catch (_) {}
      console.error("Create Towers room error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось создать комнату." });
    } finally { client?.release(); }
  });

  router.post("/rooms/join", async (req, res) => {
    const user = userFrom(req, res); if (!user) return;
    const roomId = String(req.body?.roomId || "").trim();
    if (!/^\d+$/.test(roomId)) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    let client;
    try {
      client = await pool.connect(); await client.query("BEGIN");
      const room = await readRoom(client, roomId, true);
      if (!room || room.status !== "waiting") { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, error: "Комната уже началась или не найдена." }); }
      const balance = await ensurePlayer(client, user);
      if (balance < Number(room.stake)) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "Недостаточно AC для этой ставки." }); }
      const countResult = await client.query("SELECT COUNT(*)::INTEGER AS count FROM towers_room_players WHERE room_id = $1", [roomId]);
      if (Number(countResult.rows[0].count) >= Number(room.max_players)) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "В комнате нет свободных мест." }); }
      await client.query("INSERT INTO towers_room_players (room_id, telegram_id, display_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [roomId, String(user.id), displayName(user)]);
      await client.query("COMMIT");
      return res.json({ ok: true, roomId, name: room.name });
    } catch (error) {
      try { await client?.query("ROLLBACK"); } catch (_) {}
      console.error("Join Towers room error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось войти в комнату." });
    } finally { client?.release(); }
  });

  router.post("/rooms/state", async (req, res) => {
    const user = userFrom(req, res); if (!user) return;
    const roomId = String(req.body?.roomId || "").trim();
    if (!/^\d+$/.test(roomId)) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    let client;
    try {
      client = await pool.connect(); await client.query("BEGIN");
      const room = await readRoom(client, roomId, true);
      if (!room) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, error: "Комната не найдена." }); }
      if (!(await isMember(client, roomId, user.id))) { await client.query("ROLLBACK"); return res.status(403).json({ ok: false, error: "Ты не состоишь в этой комнате." }); }
      const members = await client.query(
        "SELECT rp.telegram_id, rp.display_name, rp.joined_at FROM towers_room_players rp WHERE rp.room_id = $1 ORDER BY rp.joined_at ASC",
        [roomId]
      );
      const players = members.rows.map((p, i) => ({ telegram_id: String(p.telegram_id), display_name: p.display_name || "Игрок", color: COLORS[i] || "green" }));
      let game = null;
      if (room.status === "playing" || room.status === "finished") {
        const found = await client.query("SELECT game_state FROM towers_games WHERE room_id = $1 FOR UPDATE", [roomId]);
        if (found.rows.length) {
          game = found.rows[0].game_state;
          if (room.status === "playing") await updateAndSettle(client, room, game);
          if (game.status === "finished") room.status = "finished";
        }
      }
      const counts = await client.query(
        "SELECT rp.telegram_id, rp.display_name, rp.joined_at, p.balance FROM towers_room_players rp LEFT JOIN players p ON p.telegram_id = rp.telegram_id WHERE rp.room_id = $1 ORDER BY rp.joined_at ASC",
        [roomId]
      );
      await client.query("COMMIT");
      return res.json({
        ok: true,
        room: { id: String(room.id), name: room.name, stake: String(room.stake), maxPlayers: Number(room.max_players), status: room.status, ownerTelegramId: String(room.owner_telegram_id), players: counts.rows.map((p, i) => ({ telegramId: String(p.telegram_id), name: p.display_name, color: COLORS[i] || "green", isOwner: String(p.telegram_id) === String(room.owner_telegram_id), balance: p.balance == null ? null : Number(p.balance) })) },
        game
      });
    } catch (error) {
      try { await client?.query("ROLLBACK"); } catch (_) {}
      console.error("Read Towers room state error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось обновить состояние комнаты." });
    } finally { client?.release(); }
  });

  router.post("/rooms/start", async (req, res) => {
    const user = userFrom(req, res); if (!user) return;
    const roomId = String(req.body?.roomId || "").trim();
    if (!/^\d+$/.test(roomId)) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    let client;
    try {
      client = await pool.connect(); await client.query("BEGIN");
      const room = await readRoom(client, roomId, true);
      if (!room) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, error: "Комната не найдена." }); }
      if (String(room.owner_telegram_id) !== String(user.id)) { await client.query("ROLLBACK"); return res.status(403).json({ ok: false, error: "Начать игру может только создатель комнаты." }); }
      if (room.status !== "waiting") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "Эта партия уже началась." }); }
      const members = await client.query("SELECT telegram_id, display_name FROM towers_room_players WHERE room_id = $1 ORDER BY joined_at ASC", [roomId]);
      if (members.rows.length < 2) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "Для онлайн-партии нужен хотя бы один соперник." }); }
      if (members.rows.length > Number(room.max_players)) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "В комнате больше игроков, чем разрешено." }); }
      for (const member of members.rows) {
        const debit = await client.query("UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2 AND balance >= $1 RETURNING balance", [String(room.stake), String(member.telegram_id)]);
        if (!debit.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "У игрока не хватает AC для ставки. Комната не запущена." }); }
      }
      const game = makeGame(members.rows, Number(room.stake));
      await client.query("INSERT INTO towers_games (room_id, game_state, updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (room_id) DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = NOW()", [roomId, JSON.stringify(game)]);
      await client.query("UPDATE towers_rooms SET status = 'playing' WHERE id = $1", [roomId]);
      await client.query("COMMIT");
      return res.json({ ok: true, game });
    } catch (error) {
      try { await client?.query("ROLLBACK"); } catch (_) {}
      console.error("Start Towers game error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось начать игру." });
    } finally { client?.release(); }
  });

  router.post("/rooms/action", async (req, res) => {
    const user = userFrom(req, res); if (!user) return;
    const roomId = String(req.body?.roomId || "").trim();
    const fromId = Number(req.body?.fromId);
    const toId = Number(req.body?.toId);
    if (!/^\d+$/.test(roomId) || !Number.isInteger(fromId) || !Number.isInteger(toId) || fromId === toId) {
      return res.status(400).json({ ok: false, error: "Выбери исходную и целевую башни." });
    }
    let client;
    try {
      client = await pool.connect(); await client.query("BEGIN");
      const room = await readRoom(client, roomId, true);
      if (!room || room.status !== "playing") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "Партия не запущена." }); }
      if (!(await isMember(client, roomId, user.id))) { await client.query("ROLLBACK"); return res.status(403).json({ ok: false, error: "Ты не состоишь в этой комнате." }); }
      const found = await client.query("SELECT game_state FROM towers_games WHERE room_id = $1 FOR UPDATE", [roomId]);
      if (!found.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, error: "Состояние партии не найдено." }); }
      const game = found.rows[0].game_state;
      tickGame(game, Date.now());
      if (game.status !== "playing") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "Партия уже завершена." }); }
      const source = game.towers.find(t => t.id === fromId);
      const target = game.towers.find(t => t.id === toId);
      if (!source || !target || source.ownerId !== String(user.id)) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "Отправлять войска можно только из своей башни." }); }
      const send = Math.floor(source.units * 0.58);
      if (send < 2) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "В этой башне пока мало войск." }); }
      source.units -= send;
      game.fleets.push({ id: game.nextFleetId++, fromId, toId, ownerId: String(user.id), units: send, progress: 0, duration: Math.max(1.1, distance(source, target) / 16) });
      game.feed.unshift({ text: "Войска отправлены к башне №" + toId, at: Date.now() });
      await updateAndSettle(client, room, game);
      await client.query("COMMIT");
      return res.json({ ok: true });
    } catch (error) {
      try { await client?.query("ROLLBACK"); } catch (_) {}
      console.error("Towers action error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось отправить войска." });
    } finally { client?.release(); }
  });

  router.post("/rooms/leave", async (req, res) => {
    const user = userFrom(req, res); if (!user) return;
    const roomId = String(req.body?.roomId || "").trim();
    if (!/^\d+$/.test(roomId)) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    let client;
    try {
      client = await pool.connect(); await client.query("BEGIN");
      const room = await readRoom(client, roomId, true);
      if (!room) { await client.query("ROLLBACK"); return res.json({ ok: true }); }
      if (room.status === "playing") { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "Нельзя выйти из активной партии." }); }
      const member = await isMember(client, roomId, user.id);
      if (!member) { await client.query("ROLLBACK"); return res.status(403).json({ ok: false, error: "Ты не состоишь в этой комнате." }); }
      if (String(room.owner_telegram_id) === String(user.id)) await client.query("DELETE FROM towers_rooms WHERE id = $1", [roomId]);
      else await client.query("DELETE FROM towers_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, String(user.id)]);
      await client.query("COMMIT");
      return res.json({ ok: true });
    } catch (error) {
      try { await client?.query("ROLLBACK"); } catch (_) {}
      console.error("Leave Towers room error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось выйти из комнаты." });
    } finally { client?.release(); }
  });
  return router;
}
