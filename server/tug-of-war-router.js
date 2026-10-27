import express from "express";

const VALID_PLAYER_COUNTS = new Set([2, 4, 6]);
const MAX_STAKE = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 6));
const ROOM_PREFIX = "TW-";
// The centre flag is rendered at 3.35 units per progress point; the goal line is at 2.85.
// 0.86 therefore places the flag beyond that line before the winner is settled.
const FLAG_GOAL_PROGRESS = 0.86;

class TugError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseRoomId(value) {
  const match = String(value ?? "").trim().match(/^(?:TW-)?([1-9]\d{0,17})$/);
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
  const user = verifyTelegram(req.body?.initData);
  if (!user?.id) {
    res.status(401).json({ ok: false, error: "Открой «Перетягивание каната» через ALLCOINS в Telegram." });
    return null;
  }
  return { id: String(user.id), name: displayName(user) };
}

async function ensurePlayer(client, user) {
  const result = await client.query(
    "INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance",
    [user.id]
  );
  return BigInt(String(result.rows[0]?.balance ?? "0"));
}

async function readPlayers(client, roomId) {
  const result = await client.query(
    "SELECT p.telegram_id::TEXT AS telegram_id, p.display_name, p.team, p.joined_at, p.last_seen_at, " +
      "p.disqualified, p.warnings, (p.telegram_id = r.owner_telegram_id) AS is_owner " +
    "FROM tug_room_players p JOIN tug_rooms r ON r.id = p.room_id " +
    "WHERE p.room_id = $1 ORDER BY p.team ASC, p.joined_at ASC, p.telegram_id ASC",
    [String(roomId)]
  );
  return result.rows.map(row => ({
    id: String(row.telegram_id),
    name: String(row.display_name || "Игрок").slice(0, 40),
    team: Number(row.team),
    isOwner: Boolean(row.is_owner),
    disqualified: Boolean(row.disqualified),
    warnings: Number(row.warnings || 0),
    connected: row.last_seen_at ? Date.now() - new Date(row.last_seen_at).getTime() < 12000 : false,
    joinedAt: row.joined_at
  }));
}

function publicGame(game, userId) {
  if (!game || typeof game !== "object") return null;
  const integrity = game.integrity && typeof game.integrity === "object" ? game.integrity : {};
  const mine = integrity[String(userId)] || {};
  return {
    phase: String(game.phase || "waiting"),
    progress: Number(game.progress || 0),
    teamScores: { "1": Number(game.teamScores?.["1"] || 0), "2": Number(game.teamScores?.["2"] || 0) },
    target: Number(game.target || 24),
    winnerTeam: game.winnerTeam == null ? null : Number(game.winnerTeam),
    totalTaps: Number(game.totalTaps || 0),
    startedAt: game.startedAt || null,
    finishedAt: game.finishedAt || null,
    warningForMe: Boolean(mine.warningPending),
    disqualifiedForMe: Boolean(mine.disqualified),
    message: String(game.message || ""),
    payout: Number(game.payout || 0),
    commission: Number(game.commission || 0),
    updatedAt: game.updatedAt || null
  };
}

async function roomPayload(client, roomId, userId) {
  const result = await client.query(
    "SELECT r.id, r.owner_telegram_id::TEXT AS owner_telegram_id, r.owner_name, r.stake::TEXT AS stake, " +
      "r.max_players, r.status, r.game_state, r.created_at, r.updated_at, COUNT(p.telegram_id)::INTEGER AS players_count " +
    "FROM tug_rooms r LEFT JOIN tug_room_players p ON p.room_id = r.id " +
    "WHERE r.id = $1 GROUP BY r.id",
    [String(roomId)]
  );
  const row = result.rows[0];
  if (!row) throw new TugError(404, "Комната не найдена или уже закрыта.");
  const players = await readPlayers(client, roomId);
  const myPlayer = players.find(player => player.id === String(userId)) || null;
  return {
    room: {
      id: ROOM_PREFIX + String(row.id),
      roomId: String(row.id),
      ownerId: String(row.owner_telegram_id),
      ownerName: String(row.owner_name || "Игрок"),
      stake: Number(row.stake),
      maxPlayers: Number(row.max_players),
      playersCount: Number(row.players_count || 0),
      status: String(row.status),
      isOwner: String(row.owner_telegram_id) === String(userId),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    },
    players: players.map(player => ({
      id: player.id,
      name: player.name,
      team: player.team,
      isYou: player.id === String(userId),
      isOwner: player.isOwner,
      connected: player.connected,
      disqualified: player.disqualified,
      warnings: player.warnings
    })),
    me: myPlayer ? { id: myPlayer.id, team: myPlayer.team, isOwner: myPlayer.isOwner,
      disqualified: myPlayer.disqualified, warnings: myPlayer.warnings } : null,
    game: publicGame(row.game_state, userId)
  };
}

function freshGame(maxPlayers) {
  return {
    phase: "playing",
    progress: 0,
    teamScores: { "1": 0, "2": 0 },
    target: maxPlayers * 12,
    winnerTeam: null,
    totalTaps: 0,
    startedAt: Date.now(),
    finishedAt: null,
    message: "Тяни канат! Побеждает команда, которая перетянет центральную метку за линию.",
    integrity: {},
    settled: false,
    payout: 0,
    commission: 0,
    updatedAt: Date.now()
  };
}

async function settleWinner(client, roomId, roomRow, players, game, winnerTeam, recordGameCommission) {
  if (game.settled) return;
  const stake = BigInt(String(roomRow.stake));
  const gross = stake * BigInt(Number(roomRow.max_players));
  const commissionRow = await recordGameCommission(client, {
    game: "tug-of-war",
    eventKey: "tug-of-war:" + String(roomId),
    grossAmount: Number(gross)
  });
  const commission = BigInt(String(Math.min(Number(gross), Math.max(0, Math.floor(Number(commissionRow?.amount) || 0)))));
  const payoutPool = gross > commission ? gross - commission : 0n;
  const recipients = players.filter(player =>
    Number(player.team) === Number(winnerTeam) &&
    !Boolean(player.disqualified) &&
    String(player.id ?? player.telegram_id) !== "0"
  );
  const winners = [];
  if (recipients.length) {
    const count = BigInt(recipients.length);
    const base = payoutPool / count;
    let remainder = payoutPool % count;
    for (const player of recipients) {
      const amount = base + (remainder > 0n ? 1n : 0n);
      if (remainder > 0n) remainder -= 1n;
      if (amount > 0n) {
        const credited = await client.query(
          "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT RETURNING balance",
          [amount.toString(), String(player.id ?? player.telegram_id)]
        );
        if (!credited.rows.length) throw new Error("Не найден профиль победителя для начисления выигрыша.");
      }
      winners.push({ telegramId: String(player.id ?? player.telegram_id), amount: Number(amount) });
    }
  }
  game.phase = "finished";
  game.winnerTeam = Number(winnerTeam);
  game.finishedAt = Date.now();
  game.commission = Number(commission);
  game.payout = Number(payoutPool);
  game.settled = true;
  game.settlement = {
    grossPot: Number(gross),
    commission: Number(commission),
    payoutPool: Number(payoutPool),
    winnerTeam: Number(winnerTeam),
    winners
  };
  game.message = "Команда " + Number(winnerTeam) + " победила! Призовой фонд распределён между участниками-победителями.";
  game.updatedAt = Date.now();
}

export function createTugOfWarRouter({ pool, verifyTelegram, recordGameCommission }) {
  const router = express.Router();

  router.initialize = async function initializeTugOfWarTables() {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS tug_rooms (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, " +
      "owner_telegram_id BIGINT NOT NULL, owner_name TEXT NOT NULL DEFAULT 'Игрок', " +
      "stake BIGINT NOT NULL CHECK (stake >= 100), " +
      "max_players INTEGER NOT NULL CHECK (max_players IN (2,4,6)), " +
      "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')), " +
      "game_state JSONB NOT NULL DEFAULT '{}'::jsonb, " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS tug_room_players (" +
      "room_id BIGINT NOT NULL REFERENCES tug_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, display_name TEXT NOT NULL DEFAULT 'Игрок', " +
      "team INTEGER NOT NULL CHECK (team IN (1,2)), " +
      "joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "disqualified BOOLEAN NOT NULL DEFAULT FALSE, warnings INTEGER NOT NULL DEFAULT 0, " +
      "PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query("CREATE INDEX IF NOT EXISTS tug_rooms_waiting_idx ON tug_rooms (status, created_at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS tug_room_players_presence_idx ON tug_room_players (room_id, last_seen_at DESC)");
  };

  router.post("/rooms/list", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    try {
      await pool.query("DELETE FROM tug_rooms WHERE status = 'waiting' AND created_at < NOW() - INTERVAL '45 minutes'");
      const result = await pool.query(
        "SELECT r.id, r.owner_name, r.stake::TEXT AS stake, r.max_players, r.created_at, " +
          "COUNT(p.telegram_id)::INTEGER AS players_count " +
        "FROM tug_rooms r LEFT JOIN tug_room_players p ON p.room_id = r.id " +
        "WHERE r.status = 'waiting' GROUP BY r.id " +
        "HAVING COUNT(p.telegram_id) < r.max_players ORDER BY r.created_at DESC LIMIT 40"
      );
      return res.json({ ok: true, rooms: result.rows.map(row => ({
        id: ROOM_PREFIX + String(row.id),
        roomId: String(row.id),
        ownerName: String(row.owner_name || "Игрок"),
        stake: Number(row.stake),
        maxPlayers: Number(row.max_players),
        playersCount: Number(row.players_count || 0),
        createdAt: row.created_at
      })) });
    } catch (error) {
      console.error("List tug-of-war rooms:", error.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить комнаты." });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const stake = safeStake(req.body?.stake);
    const maxPlayers = Number(req.body?.maxPlayers);
    if (stake === null) return res.status(400).json({ ok: false, error: "Ставка должна быть целым числом от 100 AC." });
    if (!VALID_PLAYER_COUNTS.has(maxPlayers)) return res.status(400).json({ ok: false, error: "Выбери комнату на 2, 4 или 6 игроков." });

    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const balance = await ensurePlayer(client, user);
      if (balance < BigInt(stake)) throw new TugError(400, "На балансе недостаточно Allcoins для этой ставки.");
      const active = await client.query(
        "SELECT r.id FROM tug_rooms r JOIN tug_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1 AND r.status IN ('waiting','playing') LIMIT 1",
        [user.id]
      );
      if (active.rows.length) throw new TugError(409, "Сначала выйди из своей текущей комнаты.");
      const inserted = await client.query(
        "INSERT INTO tug_rooms (owner_telegram_id, owner_name, stake, max_players, status) " +
        "VALUES ($1, $2, $3::BIGINT, $4, 'waiting') RETURNING id",
        [user.id, user.name, stake, maxPlayers]
      );
      const roomId = String(inserted.rows[0].id);
      await client.query(
        "INSERT INTO tug_room_players (room_id, telegram_id, display_name, team) VALUES ($1, $2, $3, 1)",
        [roomId, user.id, user.name]
      );
      await client.query("COMMIT"); open = false;
      const payload = await roomPayload(pool, roomId, user.id);
      return res.json({ ok: true, ...payload });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof TugError ? error.status : 500;
      console.error("Create tug-of-war room:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof TugError ? error.message : "Не удалось создать комнату." });
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
        "SELECT id, owner_telegram_id::TEXT AS owner_telegram_id, owner_name, stake::TEXT AS stake, max_players, status " +
        "FROM tug_rooms WHERE id = $1 FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new TugError(404, "Комната не найдена.");
      const existing = await client.query(
        "SELECT team FROM tug_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, user.id]
      );
      if (existing.rows.length) {
        await client.query("UPDATE tug_room_players SET last_seen_at = NOW() WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
        await client.query("COMMIT"); open = false;
        return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
      }
      if (room.status !== "waiting") throw new TugError(409, "Матч уже начался. Найди другую комнату.");
      const balance = await ensurePlayer(client, user);
      if (balance < BigInt(String(room.stake))) throw new TugError(400, "На балансе недостаточно Allcoins для этой ставки.");
      const active = await client.query(
        "SELECT r.id FROM tug_rooms r JOIN tug_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1 AND r.status IN ('waiting','playing') LIMIT 1",
        [user.id]
      );
      if (active.rows.length) throw new TugError(409, "Сначала выйди из своей текущей комнаты.");
      const counts = await client.query(
        "SELECT team, COUNT(*)::INTEGER AS n FROM tug_room_players WHERE room_id = $1 GROUP BY team",
        [roomId]
      );
      const teamCounts = { "1": 0, "2": 0 };
      for (const row of counts.rows) teamCounts[String(row.team)] = Number(row.n);
      if (teamCounts["1"] + teamCounts["2"] >= Number(room.max_players)) throw new TugError(409, "Комната уже заполнена.");
      const team = teamCounts["1"] <= teamCounts["2"] ? 1 : 2;
      await client.query(
        "INSERT INTO tug_room_players (room_id, telegram_id, display_name, team) VALUES ($1, $2, $3, $4)",
        [roomId, user.id, user.name, team]
      );
      await client.query("UPDATE tug_rooms SET updated_at = NOW() WHERE id = $1", [roomId]);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof TugError ? error.status : 500;
      console.error("Join tug-of-war room:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof TugError ? error.message : "Не удалось войти в комнату." });
    } finally { client.release(); }
  });

  router.post("/rooms/state", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const roomId = parseRoomId(req.body?.roomId);
    if (!roomId) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    try {
      const member = await pool.query(
        "UPDATE tug_room_players SET last_seen_at = NOW() WHERE room_id = $1 AND telegram_id = $2 RETURNING telegram_id",
        [roomId, user.id]
      );
      if (!member.rows.length) return res.status(403).json({ ok: false, error: "Ты не состоишь в этой комнате." });
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      const status = error instanceof TugError ? error.status : 500;
      return res.status(status).json({ ok: false, error: error instanceof TugError ? error.message : "Не удалось обновить состояние матча." });
    }
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
        "SELECT id, owner_telegram_id::TEXT AS owner_telegram_id, stake::TEXT AS stake, max_players, status " +
        "FROM tug_rooms WHERE id = $1 FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new TugError(404, "Комната не найдена.");
      if (String(room.owner_telegram_id) !== user.id) throw new TugError(403, "Начать матч может только создатель комнаты.");
      if (room.status !== "waiting") throw new TugError(409, "Эта комната уже запущена.");
      const playerResult = await client.query(
        "SELECT telegram_id::TEXT AS telegram_id, display_name, team, disqualified, warnings " +
        "FROM tug_room_players WHERE room_id = $1 ORDER BY joined_at ASC FOR UPDATE",
        [roomId]
      );
      if (playerResult.rows.length !== Number(room.max_players)) {
        throw new TugError(409, "Для старта нужно дождаться всех " + Number(room.max_players) + " игроков.");
      }
      for (const player of playerResult.rows) {
        const charged = await client.query(
          "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() " +
          "WHERE telegram_id = $2::BIGINT AND balance >= $1::BIGINT RETURNING balance",
          [String(room.stake), String(player.telegram_id)]
        );
        if (!charged.rows.length) {
          throw new TugError(400, "У игрока «" + String(player.display_name || "Игрок") + "» недостаточно AC. Ставка не списана ни у кого.");
        }
      }
      const game = freshGame(Number(room.max_players));
      await client.query(
        "UPDATE tug_rooms SET status = 'playing', game_state = $2::JSONB, updated_at = NOW() WHERE id = $1",
        [roomId, JSON.stringify(game)]
      );
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof TugError ? error.status : 500;
      console.error("Start tug-of-war match:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof TugError ? error.message : "Не удалось начать матч." });
    } finally { client.release(); }
  });

  router.post("/tap", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const roomId = parseRoomId(req.body?.roomId);
    const batchId = Number(req.body?.batchId);
    const rawCount = Number(req.body?.tapCount);
    if (!roomId) return res.status(400).json({ ok: false, error: "Номер комнаты указан неверно." });
    if (!Number.isSafeInteger(batchId) || batchId < 1) return res.status(400).json({ ok: false, error: "Повтори нажатие: номер пакета не принят." });
    if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 30) return res.status(400).json({ ok: false, error: "Некорректное количество нажатий." });
    const intervals = Array.isArray(req.body?.intervals) ? req.body.intervals.slice(-30).map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 2000) : [];
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query(
        "SELECT id, stake::TEXT AS stake, max_players, status, game_state " +
        "FROM tug_rooms WHERE id = $1 FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new TugError(404, "Комната не найдена.");
      if (room.status !== "playing") throw new TugError(409, "Матч сейчас не принимает нажатия.");
      const memberResult = await client.query(
        "SELECT telegram_id::TEXT AS telegram_id, team, disqualified, warnings " +
        "FROM tug_room_players WHERE room_id = $1 AND telegram_id = $2 FOR UPDATE",
        [roomId, user.id]
      );
      const member = memberResult.rows[0];
      if (!member) throw new TugError(403, "Ты не состоишь в этой комнате.");
      if (member.disqualified) throw new TugError(403, "Ты дисквалифицирован за повторное использование автокликера. Матч для тебя проигран.");
      const game = room.game_state && typeof room.game_state === "object" ? room.game_state : freshGame(Number(room.max_players));
      if (game.phase !== "playing" || game.settled) throw new TugError(409, "Матч уже завершён.");
      game.integrity = game.integrity && typeof game.integrity === "object" ? game.integrity : {};
      const id = String(user.id);
      const integrity = game.integrity[id] && typeof game.integrity[id] === "object" ? game.integrity[id] :
        { warnings: Number(member.warnings || 0), consecutiveFlags: 0, lastRequestAt: 0, lastBatchId: 0, recentIntervals: [] };
      if (batchId <= Number(integrity.lastBatchId || 0)) {
        await client.query("COMMIT"); open = false;
        return res.json({ ok: true, duplicate: true, ...(await roomPayload(pool, roomId, user.id)) });
      }
      const now = Date.now();
      const elapsed = integrity.lastRequestAt ? now - Number(integrity.lastRequestAt) : 0;
      const requestRate = elapsed > 0 && elapsed < 1600 ? rawCount / (Math.max(120, elapsed) / 1000) : 0;
      const recentIntervals = [...(Array.isArray(integrity.recentIntervals) ? integrity.recentIntervals : []), ...intervals].slice(-18);
      const mean = recentIntervals.length ? recentIntervals.reduce((sum, n) => sum + n, 0) / recentIntervals.length : 0;
      const variance = recentIntervals.length ? recentIntervals.reduce((sum, n) => sum + Math.pow(n - mean, 2), 0) / recentIntervals.length : 0;
      const coefficientOfVariation = mean > 0 ? Math.sqrt(variance) / mean : 1;
      const mechanicalPattern = recentIntervals.length >= 10 && mean >= 20 && mean <= 125 && coefficientOfVariation < 0.035;
      const excessiveRate = requestRate > 24 && rawCount >= 4;
      const oversizedBatch = rawCount > 10 || (rawCount > 6 && mean > 0 && mean < 48);
      const flagged = mechanicalPattern || excessiveRate || oversizedBatch;

      integrity.lastBatchId = batchId;
      integrity.lastRequestAt = now;
      integrity.recentIntervals = recentIntervals;
      integrity.warningPending = false;

      if (flagged) {
        integrity.consecutiveFlags = Number(integrity.consecutiveFlags || 0) + 1;
        integrity.warnings = Number(integrity.warnings || 0) + 1;
        if (integrity.warnings >= 2) {
          integrity.disqualified = true;
          await client.query(
            "UPDATE tug_room_players SET disqualified = TRUE, warnings = $3, last_seen_at = NOW() WHERE room_id = $1 AND telegram_id = $2",
            [roomId, user.id, integrity.warnings]
          );
          integrity.warningPending = false;
          game.integrity[id] = integrity;
          game.message = "Игрок " + String(user.name) + " дисквалифицирован за повторное подозрительное нажатие.";
          const roster = await readPlayers(client, roomId);
          const eligibleTeams = new Set(roster.filter(p => !p.disqualified).map(p => Number(p.team)));
          if (!eligibleTeams.has(Number(member.team))) {
            const winnerTeam = Number(member.team) === 1 ? 2 : 1;
            await settleWinner(client, roomId, room, roster, game, winnerTeam, recordGameCommission);
            await client.query("UPDATE tug_rooms SET status = 'finished', game_state = $2::JSONB, updated_at = NOW() WHERE id = $1",
              [roomId, JSON.stringify(game)]);
          } else {
            game.updatedAt = Date.now();
            await client.query("UPDATE tug_rooms SET game_state = $2::JSONB, updated_at = NOW() WHERE id = $1",
              [roomId, JSON.stringify(game)]);
          }
          await client.query("COMMIT"); open = false;
          return res.json({ ok: true, integrity: "disqualified", error: "Повторное нарушение: матч для тебя проигран, ставка остаётся в призовом фонде.", ...(await roomPayload(pool, roomId, user.id)) });
        }
        integrity.warningPending = true;
        game.message = "Предупреждение: подозрительно частые или механически ровные нажатия. Останови автокликер — повторное нарушение приведёт к дисквалификации.";
        await client.query(
          "UPDATE tug_room_players SET warnings = $3, last_seen_at = NOW() WHERE room_id = $1 AND telegram_id = $2",
          [roomId, user.id, integrity.warnings]
        );
      } else {
        integrity.consecutiveFlags = 0;
        await client.query("UPDATE tug_room_players SET last_seen_at = NOW() WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      }
      game.integrity[id] = integrity;
      if (!flagged) {
        const teamKey = String(Number(member.team));
        game.teamScores[teamKey] = Number(game.teamScores?.[teamKey] || 0) + rawCount;
        game.totalTaps = Number(game.totalTaps || 0) + rawCount;
        const net = Number(game.teamScores["2"] || 0) - Number(game.teamScores["1"] || 0);
        game.progress = Math.max(-1, Math.min(1, net / Number(game.target || Number(room.max_players) * 12)));
        game.message = "Команда " + Number(member.team) + " тянет канат!";
        if (game.progress <= -FLAG_GOAL_PROGRESS || game.progress >= FLAG_GOAL_PROGRESS) {
          const winnerTeam = game.progress <= -FLAG_GOAL_PROGRESS ? 1 : 2;
          const roster = await readPlayers(client, roomId);
          await settleWinner(client, roomId, room, roster, game, winnerTeam, recordGameCommission);
          await client.query("UPDATE tug_rooms SET status = 'finished', game_state = $2::JSONB, updated_at = NOW() WHERE id = $1",
            [roomId, JSON.stringify(game)]);
        } else {
          game.updatedAt = Date.now();
          await client.query("UPDATE tug_rooms SET game_state = $2::JSONB, updated_at = NOW() WHERE id = $1",
            [roomId, JSON.stringify(game)]);
        }
      } else {
        game.integrity[id] = integrity;
        game.updatedAt = Date.now();
        await client.query("UPDATE tug_rooms SET game_state = $2::JSONB, updated_at = NOW() WHERE id = $1",
          [roomId, JSON.stringify(game)]);
      }
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, integrity: flagged ? "warning" : "ok", ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof TugError ? error.status : 500;
      console.error("Tug-of-war tap:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof TugError ? error.message : "Не удалось обработать нажатие." });
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
        "SELECT id, owner_telegram_id::TEXT AS owner_telegram_id, stake::TEXT AS stake, max_players, status, game_state " +
        "FROM tug_rooms WHERE id = $1 FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new TugError(404, "Комната не найдена.");
      const memberResult = await client.query(
        "SELECT telegram_id::TEXT AS telegram_id, team, disqualified FROM tug_room_players WHERE room_id = $1 AND telegram_id = $2 FOR UPDATE",
        [roomId, user.id]
      );
      const member = memberResult.rows[0];
      if (!member) throw new TugError(403, "Ты не состоишь в этой комнате.");
      if (room.status === "waiting") {
        await client.query("DELETE FROM tug_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
        if (String(room.owner_telegram_id) === user.id) {
          await client.query("DELETE FROM tug_rooms WHERE id = $1", [roomId]);
          await client.query("COMMIT"); open = false;
          return res.json({ ok: true, left: true, roomClosed: true });
        }
      } else if (room.status === "playing" && !member.disqualified) {
        const game = room.game_state && typeof room.game_state === "object" ? room.game_state : freshGame(Number(room.max_players));
        game.integrity = game.integrity && typeof game.integrity === "object" ? game.integrity : {};
        game.integrity[user.id] = { ...(game.integrity[user.id] || {}), disqualified: true, warningPending: false, disqualifiedByExit: true };
        await client.query("UPDATE tug_room_players SET disqualified = TRUE WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
        const roster = await readPlayers(client, roomId);
        const eligibleTeams = new Set(roster.filter(p => !p.disqualified).map(p => Number(p.team)));
        if (!eligibleTeams.has(Number(member.team))) {
          const winnerTeam = Number(member.team) === 1 ? 2 : 1;
          await settleWinner(client, roomId, room, roster, game, winnerTeam, recordGameCommission);
          await client.query("UPDATE tug_rooms SET status = 'finished', game_state = $2::JSONB, updated_at = NOW() WHERE id = $1",
            [roomId, JSON.stringify(game)]);
        } else {
          game.message = "Игрок покинул матч и дисквалифицирован. Остальные участники продолжают.";
          game.updatedAt = Date.now();
          await client.query("UPDATE tug_rooms SET game_state = $2::JSONB, updated_at = NOW() WHERE id = $1",
            [roomId, JSON.stringify(game)]);
        }
      }
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, left: true, ...(await roomPayload(pool, roomId, user.id).catch(() => ({}))) });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch (_) {} }
      const status = error instanceof TugError ? error.status : 500;
      console.error("Leave tug-of-war room:", error.message || error);
      return res.status(status).json({ ok: false, error: error instanceof TugError ? error.message : "Не удалось выйти из комнаты." });
    } finally { client.release(); }
  });

  return router;
}
