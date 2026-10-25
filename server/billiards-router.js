import express from "express";
import { recordGameCommission } from "./commission.js";

const TABLE_W = 800;
const TABLE_H = 440;
const BALL_R = 10;
const TEST_BOT_ID = "billiards-test-bot";
const MIN_X = 42;
const MAX_X = 758;
const MIN_Y = 42;
const MAX_Y = 398;
const POCKETS = [
  { x: 31, y: 31 }, { x: 400, y: 25 }, { x: 769, y: 31 },
  { x: 31, y: 409 }, { x: 400, y: 415 }, { x: 769, y: 409 }
];
const COLORS = ["#f7d51d", "#1767d8", "#d72e35", "#6c36b8", "#ef7e21", "#139e59", "#e9e8df"];

class BilliardsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeStake(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  try {
    const big = BigInt(raw);
    if (big < 100n || big > 9007199254740991n) return null;
    return Number(big);
  } catch { return null; }
}

function userFromRequest(req, verifyTelegram) {
  const verified = verifyTelegram(req.body?.initData);
  if (!verified?.id) throw new BilliardsError(401, "Открой Бильярд через ALLCOINS в Telegram.");
  return {
    id: String(verified.id),
    name: String(verified.first_name || verified.username || "Игрок").slice(0, 40)
  };
}

async function ensurePlayer(client, user) {
  const result = await client.query(
    "INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance",
    [user.id]
  );
  return Number(result.rows[0]?.balance || 0);
}

function initialBalls() {
  const balls = [{ id: "cue", number: 0, type: "cue", x: 192, y: 220, active: true }];
  const rack = [1, 9, 3, 8, 10, 11, 4, 12, 5, 6, 13, 7, 14, 15, 2];
  let index = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const number = rack[index++];
      balls.push({
        id: String(number),
        number,
        type: number === 8 ? "eight" : (number <= 7 ? "solid" : "stripe"),
        x: 518 + row * 19.5,
        y: 220 + (col - row / 2) * 20.5,
        active: true
      });
    }
  }
  return balls;
}

function cloneBalls(balls) {
  return balls.map(ball => ({
    id: String(ball.id), number: Number(ball.number), type: String(ball.type),
    x: Number(ball.x), y: Number(ball.y), active: Boolean(ball.active)
  }));
}

function simulateShot(sourceBalls, angle, power) {
  const balls = cloneBalls(sourceBalls).map(ball => ({ ...ball, vx: 0, vy: 0 }));
  const cue = balls.find(ball => ball.id === "cue" && ball.active);
  if (!cue) throw new BilliardsError(400, "Биток не найден. Начни новый раунд.");
  const strength = Math.max(4, Math.min(100, Number(power) || 0));
  const speed = 3.7 + strength * 0.16;
  cue.vx = Math.cos(angle) * speed;
  cue.vy = Math.sin(angle) * speed;

  const pocketedIds = [];
  let scratch = false;
  const stopSpeed = 0.07;

  for (let frame = 0; frame < 900; frame++) {
    let maxSpeed = 0;
    for (const ball of balls) {
      if (!ball.active) continue;
      ball.x += ball.vx;
      ball.y += ball.vy;

      const pocket = POCKETS.find(item => Math.hypot(ball.x - item.x, ball.y - item.y) < 21.5);
      if (pocket) {
        ball.active = false;
        ball.vx = 0;
        ball.vy = 0;
        pocketedIds.push(ball.id);
        if (ball.id === "cue") scratch = true;
        continue;
      }

      if (ball.x < MIN_X) { ball.x = MIN_X; ball.vx = Math.abs(ball.vx) * 0.92; }
      if (ball.x > MAX_X) { ball.x = MAX_X; ball.vx = -Math.abs(ball.vx) * 0.92; }
      if (ball.y < MIN_Y) { ball.y = MIN_Y; ball.vy = Math.abs(ball.vy) * 0.92; }
      if (ball.y > MAX_Y) { ball.y = MAX_Y; ball.vy = -Math.abs(ball.vy) * 0.92; }
    }

    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.active) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (!b.active) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance <= 0 || distance >= BALL_R * 2) continue;
        const nx = dx / distance;
        const ny = dy / distance;
        const overlap = BALL_R * 2 - distance;
        a.x -= nx * (overlap / 2 + 0.02);
        a.y -= ny * (overlap / 2 + 0.02);
        b.x += nx * (overlap / 2 + 0.02);
        b.y += ny * (overlap / 2 + 0.02);
        const relative = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (relative > 0) {
          a.vx -= relative * nx;
          a.vy -= relative * ny;
          b.vx += relative * nx;
          b.vy += relative * ny;
        }
      }
    }

    for (const ball of balls) {
      if (!ball.active) continue;
      ball.vx *= 0.9885;
      ball.vy *= 0.9885;
      const speedNow = Math.hypot(ball.vx, ball.vy);
      if (speedNow < stopSpeed) {
        ball.vx = 0;
        ball.vy = 0;
      } else {
        maxSpeed = Math.max(maxSpeed, speedNow);
      }
    }
    if (maxSpeed < stopSpeed) break;
  }

  const endBalls = balls.map(ball => {
    if (ball.id === "cue" && scratch) {
      const startX = 190, startY = 220;
      let x = startX, y = startY;
      for (let attempt = 0; attempt < 8; attempt++) {
        const occupied = balls.some(other => other.active && other.id !== "cue" &&
          Math.hypot(other.x - x, other.y - y) < BALL_R * 2 + 2);
        if (!occupied) break;
        x += 24;
        if (x > 330) { x = startX; y += 24; }
      }
      return { id: "cue", number: 0, type: "cue", x, y, active: true };
    }
    return { id: String(ball.id), number: Number(ball.number), type: String(ball.type), x: ball.x, y: ball.y, active: Boolean(ball.active) };
  });

  return { endBalls, pocketedIds, scratch };
}

function countRemaining(balls, group) {
  return balls.filter(ball => ball.active && ball.type === group).length;
}

function makePublicGame(game, userId) {
  return {
    status: game.status,
    stake: Number(game.stake),
    pot: Number(game.pot),
    players: game.players.map((player, index) => ({
      id: String(player.id), name: String(player.name), group: player.group || null,
      isYou: String(player.id) === String(userId), isCurrent: index === game.currentPlayerIndex,
      isBot: Boolean(player.isBot)
    })),
    testMode: Boolean(game.testMode),
    balls: cloneBalls(game.balls),
    currentPlayerId: String(game.players[game.currentPlayerIndex]?.id || ""),
    turnNo: Number(game.turnNo || 0),
    lastShot: game.lastShot || null,
    winnerId: game.winnerId || null,
    winnerName: game.winnerName || null,
    payout: Number(game.payout || 0),
    commission: Number(game.commission || 0),
    message: String(game.message || ""),
    updatedAt: game.updatedAt || Date.now()
  };
}

export function createBilliardsRouter({ pool, verifyTelegram }) {
  const router = express.Router();

  async function roomPayload(db, roomId, userId) {
    const result = await db.query(
      "SELECT r.id, r.name, r.owner_telegram_id, r.stake, r.status, r.bot_mode, r.created_at, " +
      "COUNT(p.telegram_id)::INTEGER AS players_count, " +
      "COALESCE(MAX(p.display_name) FILTER (WHERE p.telegram_id = r.owner_telegram_id), 'Создатель') AS owner_name " +
      "FROM billiards_rooms r LEFT JOIN billiards_room_players p ON p.room_id = r.id " +
      "WHERE r.id = $1 GROUP BY r.id",
      [String(roomId)]
    );
    const row = result.rows[0];
    if (!row) throw new BilliardsError(404, "Комната не найдена.");
    const playersResult = await db.query(
      "SELECT telegram_id, display_name, joined_at FROM billiards_room_players WHERE room_id = $1 ORDER BY joined_at ASC, telegram_id ASC",
      [String(roomId)]
    );
    return {
      room: {
        id: String(row.id), name: String(row.name), ownerId: String(row.owner_telegram_id),
        ownerName: String(row.owner_name), stake: Number(row.stake), status: String(row.status),
        playersCount: Number(row.players_count), isOwner: String(row.owner_telegram_id) === String(userId),
        botMode: Boolean(row.bot_mode), createdAt: row.created_at
      },
      players: [
        ...playersResult.rows.map(player => ({
          id: String(player.telegram_id),
          name: String(player.display_name || "Игрок"),
          isYou: String(player.telegram_id) === String(userId),
          isOwner: String(player.telegram_id) === String(row.owner_telegram_id),
          isBot: false
        })),
        ...(row.bot_mode ? [{ id: TEST_BOT_ID, name: "Бот (тест)", isYou: false, isOwner: false, isBot: true }] : [])
      ]
    };
  }

  async function assertMember(db, roomId, userId) {
    const result = await db.query(
      "SELECT 1 FROM billiards_room_players WHERE room_id = $1 AND telegram_id = $2",
      [String(roomId), String(userId)]
    );
    if (!result.rows.length) throw new BilliardsError(403, "Сначала войди в эту комнату.");
  }

  async function settleGame(client, roomId, game) {
    if (game.status !== "finished" || game.settlementApplied) return;
    if (game.testMode) {
      game.commission = 0;
      game.payout = 0;
      game.settlementApplied = true;
      game.message = (game.winnerName || "Игрок") + " выиграл тестовую партию. Баланс AC не менялся.";
      await client.query("UPDATE billiards_rooms SET status = 'finished' WHERE id = $1", [String(roomId)]);
      return;
    }
    const commissionResult = await recordGameCommission(client, {
      game: "billiards",
      eventKey: "billiards:" + String(roomId) + ":finished",
      grossAmount: Number(game.pot || 0)
    });
    const commission = Math.max(0, Math.min(Number(game.pot || 0), Math.floor(Number(commissionResult?.amount) || 0)));
    const payout = Math.max(0, Number(game.pot || 0) - commission);
    const winner = game.players.find(player => String(player.id) === String(game.winnerId));
    if (winner && payout > 0) {
      const credited = await client.query(
        "UPDATE players SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING balance",
        [String(payout), String(winner.id)]
      );
      if (!credited.rows.length) throw new Error("Не удалось зачислить выигрыш в бильярде.");
    }
    game.commission = commission;
    game.payout = winner ? payout : 0;
    game.settlementApplied = true;
    game.message = (game.winnerName || "Игрок") + " выиграл! Приз: " + payout.toLocaleString("ru-RU") + " AC.";
    await client.query("UPDATE billiards_rooms SET status = 'finished' WHERE id = $1", [String(roomId)]);
  }


  function chooseTestBotShot(game) {
    const balls = cloneBalls(game.balls);
    const cue = balls.find(ball => ball.id === "cue" && ball.active);
    if (!cue) return { angle: 0, power: 45 };
    const bot = game.players[game.currentPlayerIndex];
    let targets = balls.filter(ball => ball.active && ball.type !== "cue" && ball.type !== "eight");
    if (bot?.group) {
      const own = targets.filter(ball => ball.type === bot.group);
      targets = own.length ? own : balls.filter(ball => ball.active && ball.type === "eight");
    }
    if (!targets.length) targets = balls.filter(ball => ball.active && ball.type !== "cue");
    let best = null;
    for (const target of targets) {
      for (const pocket of POCKETS) {
        const pdx = pocket.x - target.x, pdy = pocket.y - target.y;
        const pd = Math.hypot(pdx, pdy) || 1;
        const contactX = target.x - (pdx / pd) * (BALL_R * 2 + 1);
        const contactY = target.y - (pdy / pd) * (BALL_R * 2 + 1);
        const dx = contactX - cue.x, dy = contactY - cue.y;
        const distance = Math.hypot(dx, dy);
        const score = distance + pd * 0.08 + Math.random() * 7;
        if (!best || score < best.score) best = { score, angle: Math.atan2(dy, dx), distance };
      }
    }
    const distance = best?.distance || 220;
    return {
      angle: best?.angle ?? (Math.random() * Math.PI * 2),
      power: Math.max(30, Math.min(82, Math.round(32 + distance * 0.12)))
    };
  }

  async function runTestBotTurn(roomId) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN"); transactionOpen = true;
      const result = await client.query("SELECT game_state FROM billiards_games WHERE room_id = $1 FOR UPDATE", [String(roomId)]);
      if (!result.rows.length) {
        await client.query("COMMIT"); transactionOpen = false;
        return;
      }
      const game = result.rows[0].game_state;
      const shooter = game.players?.[game.currentPlayerIndex];
      if (!game.testMode || game.status !== "playing" || !shooter?.isBot ||
          Number(game.botNextAt || 0) > Date.now()) {
        await client.query("COMMIT"); transactionOpen = false;
        return;
      }

      const startBalls = cloneBalls(game.balls);
      const ownGroupBefore = shooter.group;
      const remainingOwnBefore = ownGroupBefore ? countRemaining(startBalls, ownGroupBefore) : null;
      const { angle, power } = chooseTestBotShot(game);
      const sim = simulateShot(startBalls, angle, power);
      const ids = sim.pocketedIds;
      const sunkEight = ids.includes("8");
      const sunkCue = sim.scratch;
      const objectPotted = ids.map(id => startBalls.find(ball => ball.id === id))
        .filter(ball => ball && ball.type !== "cue" && ball.type !== "eight");

      if (!shooter.group && objectPotted.length) {
        const first = objectPotted[0];
        shooter.group = first.type;
        game.players.forEach(player => {
          if (String(player.id) !== String(shooter.id)) player.group = first.type === "solid" ? "stripe" : "solid";
        });
      }
      game.balls = sim.endBalls;
      game.turnNo = Number(game.turnNo || 0) + 1;
      game.lastShot = {
        seq: game.turnNo, shooterId: String(shooter.id), angle, power,
        startBalls, endBalls: cloneBalls(sim.endBalls), pocketedIds: ids, scratch: sunkCue
      };
      game.botNextAt = Date.now() + 1200;

      if (sunkEight) {
        const wins = Boolean(ownGroupBefore && remainingOwnBefore === 0 && !sunkCue);
        const winner = wins ? shooter : game.players.find(player => String(player.id) !== String(shooter.id));
        game.status = "finished";
        game.winnerId = String(winner?.id || "");
        game.winnerName = String(winner?.name || "Игрок");
        await settleGame(client, roomId, game);
      } else {
        const shotGroup = shooter.group;
        const ownPocketed = !sunkCue && shotGroup && ids.some(id => {
          const ball = startBalls.find(item => item.id === id);
          return ball && ball.type === shotGroup;
        });
        if (!ownPocketed || sunkCue) {
          game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
        }
        game.message = sunkCue
          ? shooter.name + " забил биток. Ход соперника."
          : ownPocketed
            ? shooter.name + " забил свой шар. Продолжает."
            : "Бот завершил удар. Твой ход.";
      }
      game.updatedAt = Date.now();
      await client.query(
        "UPDATE billiards_games SET game_state = $2::jsonb, updated_at = NOW() WHERE room_id = $1",
        [String(roomId), JSON.stringify(game)]
      );
      await client.query("COMMIT"); transactionOpen = false;
    } catch (error) {
      if (transactionOpen) { try { await client.query("ROLLBACK"); } catch {} }
      console.error("Billiards test bot turn error:", error.message || error);
    } finally {
      client.release();
    }
  }

  router.post("/rooms/list", async (req, res) => {
    try {
      const user = userFromRequest(req, verifyTelegram);
      await ensurePlayer(pool, user);
      const result = await pool.query(
        "SELECT r.id, r.name, r.owner_telegram_id, r.stake, r.status, r.created_at, " +
        "COUNT(p.telegram_id)::INTEGER AS players_count, " +
        "COALESCE(MAX(p.display_name) FILTER (WHERE p.telegram_id = r.owner_telegram_id), 'Создатель') AS owner_name " +
        "FROM billiards_rooms r LEFT JOIN billiards_room_players p ON p.room_id = r.id " +
        "WHERE r.status = 'waiting' AND r.bot_mode = FALSE GROUP BY r.id HAVING COUNT(p.telegram_id) < 2 " +
        "ORDER BY r.created_at DESC LIMIT 80"
      );
      return res.json({ ok: true, rooms: result.rows.map(row => ({
        id: String(row.id), name: String(row.name), ownerName: String(row.owner_name),
        playersCount: Number(row.players_count), stake: Number(row.stake), status: String(row.status),
        isOwner: String(row.owner_telegram_id) === String(user.id)
      })) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось загрузить комнаты бильярда." });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      const user = userFromRequest(req, verifyTelegram);
      const name = String(req.body?.name || "").trim().slice(0, 30) || "Бильярд ALLCOINS";
      const stake = safeStake(req.body?.stake);
      if (stake === null) throw new BilliardsError(400, "Укажи целую ставку от 100 AC. Верхний лимит не задан.");
      await client.query("BEGIN"); transactionOpen = true;
      await ensurePlayer(client, user);
      const created = await client.query(
        "INSERT INTO billiards_rooms (name, owner_telegram_id, stake, status, bot_mode) VALUES ($1, $2, $3, 'waiting', $4) RETURNING id",
        [name, user.id, String(stake), Boolean(req.body?.botMode)]
      );
      const roomId = String(created.rows[0].id);
      await client.query(
        "INSERT INTO billiards_room_players (room_id, telegram_id, display_name) VALUES ($1, $2, $3)",
        [roomId, user.id, user.name]
      );
      await client.query("COMMIT"); transactionOpen = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (transactionOpen) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось создать комнату бильярда." });
    } finally { client.release(); }
  });

  router.post("/rooms/join", async (req, res) => {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      const user = userFromRequest(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new BilliardsError(400, "Неверный номер комнаты.");
      await client.query("BEGIN"); transactionOpen = true;
      await ensurePlayer(client, user);
      const roomResult = await client.query("SELECT id, status, bot_mode FROM billiards_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new BilliardsError(404, "Комната уже не существует.");
      if (room.status !== "waiting") throw new BilliardsError(400, "Эта партия уже началась.");
      const member = await client.query(
        "SELECT 1 FROM billiards_room_players WHERE room_id = $1 AND telegram_id = $2",
        [roomId, user.id]
      );
      if (!member.rows.length && room.bot_mode) {
        throw new BilliardsError(400, "Это тестовая комната с ботом. Создай собственную тестовую партию.");
      }
      if (!member.rows.length) {
        const count = await client.query("SELECT COUNT(*)::INTEGER AS total FROM billiards_room_players WHERE room_id = $1", [roomId]);
        if (Number(count.rows[0]?.total || 0) >= 2) throw new BilliardsError(400, "В комнате уже два игрока.");
        await client.query(
          "INSERT INTO billiards_room_players (room_id, telegram_id, display_name) VALUES ($1, $2, $3)",
          [roomId, user.id, user.name]
        );
      }
      await client.query("COMMIT"); transactionOpen = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (transactionOpen) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: error.status === 403 ? false : false, error: error.message || "Не удалось войти в комнату бильярда." });
    } finally { client.release(); }
  });

  router.post("/rooms/state", async (req, res) => {
    try {
      const user = userFromRequest(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new BilliardsError(400, "Неверный номер комнаты.");
      await assertMember(pool, roomId, user.id);
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось обновить комнату." });
    }
  });

  router.post("/rooms/leave", async (req, res) => {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      const user = userFromRequest(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new BilliardsError(400, "Неверный номер комнаты.");
      await client.query("BEGIN"); transactionOpen = true;
      const result = await client.query("SELECT owner_telegram_id, status FROM billiards_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const row = result.rows[0];
      if (!row) { await client.query("COMMIT"); transactionOpen = false; return res.json({ ok: true }); }
      if (row.status !== "waiting") throw new BilliardsError(400, "Партия уже началась.");
      if (String(row.owner_telegram_id) === String(user.id)) await client.query("DELETE FROM billiards_rooms WHERE id = $1", [roomId]);
      else await client.query("DELETE FROM billiards_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      await client.query("COMMIT"); transactionOpen = false;
      return res.json({ ok: true });
    } catch (error) {
      if (transactionOpen) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось выйти из комнаты." });
    } finally { client.release(); }
  });

  router.post("/rooms/start", async (req, res) => {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      const user = userFromRequest(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new BilliardsError(400, "Неверный номер комнаты.");
      await client.query("BEGIN"); transactionOpen = true;
      const roomResult = await client.query(
        "SELECT id, name, owner_telegram_id, stake, status, bot_mode FROM billiards_rooms WHERE id = $1 FOR UPDATE", [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new BilliardsError(404, "Комната не найдена.");
      if (String(room.owner_telegram_id) !== user.id) throw new BilliardsError(403, "Начать игру может только создатель комнаты.");
      if (room.status !== "waiting") throw new BilliardsError(400, "Партия уже началась.");
      const membersResult = await client.query(
        "SELECT telegram_id, display_name FROM billiards_room_players WHERE room_id = $1 ORDER BY joined_at ASC, telegram_id ASC FOR UPDATE",
        [roomId]
      );
      const members = membersResult.rows;
      const botMode = Boolean(room.bot_mode);
      if (members.length !== (botMode ? 1 : 2)) {
        throw new BilliardsError(400, botMode ? "Для тестовой партии нужен один игрок." : "Для игры нужны ровно два игрока.");
      }
      if (!botMode) {
        for (const member of members) {
          const balanceResult = await client.query("SELECT balance FROM players WHERE telegram_id = $1 FOR UPDATE", [String(member.telegram_id)]);
          if (!balanceResult.rows.length || BigInt(balanceResult.rows[0].balance) < BigInt(room.stake)) {
            throw new BilliardsError(400, "У игрока «" + String(member.display_name || "Игрок") + "» недостаточно AC для ставки.");
          }
        }
        for (const member of members) {
          const charged = await client.query(
            "UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2 AND balance >= $1 RETURNING balance",
            [String(room.stake), String(member.telegram_id)]
          );
          if (!charged.rows.length) throw new BilliardsError(400, "Не удалось списать ставку. Проверьте баланс.");
        }
      }
      const game = {
        status: "playing",
        testMode: botMode,
        stake: Number(room.stake),
        pot: botMode ? 0 : Number(BigInt(room.stake) * 2n),
        players: members.map(member => ({ id: String(member.telegram_id), name: String(member.display_name || "Игрок"), group: null })).concat(
          botMode ? [{ id: TEST_BOT_ID, name: "Бот (тест)", group: null, isBot: true }] : []
        ),
        balls: initialBalls(),
        currentPlayerIndex: 0,
        turnNo: 0,
        lastShot: null,
        winnerId: null,
        winnerName: null,
        payout: 0,
        commission: 0,
        settlementApplied: false,
        message: botMode
          ? "Тестовый режим: играй против бота. AC не списываются и не выплачиваются."
          : "Разбой! Прицелься и потяни в направлении удара.",
        updatedAt: Date.now()
      };
      await client.query("INSERT INTO billiards_games (room_id, game_state) VALUES ($1, $2::jsonb)", [roomId, JSON.stringify(game)]);
      await client.query("UPDATE billiards_rooms SET status = 'playing' WHERE id = $1", [roomId]);
      await client.query("COMMIT"); transactionOpen = false;
      return res.json({
        ok: true, game: makePublicGame(game, user.id),
        message: botMode ? "Тестовая партия началась. Баланс AC не меняется." : "Игра началась. Ставка списана с обоих игроков."
      });
    } catch (error) {
      if (transactionOpen) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось начать бильярд." });
    } finally { client.release(); }
  });

  router.post("/game/state", async (req, res) => {
    try {
      const user = userFromRequest(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new BilliardsError(400, "Неверный номер комнаты.");
      await assertMember(pool, roomId, user.id);
      await runTestBotTurn(roomId);
      const result = await pool.query("SELECT game_state FROM billiards_games WHERE room_id = $1", [roomId]);
      if (!result.rows.length) throw new BilliardsError(404, "Партия ещё не подготовлена.");
      return res.json({ ok: true, game: makePublicGame(result.rows[0].game_state, user.id) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось обновить бильярд." });
    }
  });

  router.post("/game/shot", async (req, res) => {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      const user = userFromRequest(req, verifyTelegram);
      const roomId = String(req.body?.roomId || "");
      const angle = Number(req.body?.angle);
      const power = Number(req.body?.power);
      if (!/^\d+$/.test(roomId)) throw new BilliardsError(400, "Неверный номер комнаты.");
      if (!Number.isFinite(angle) || !Number.isFinite(power) || power < 4 || power > 100) {
        throw new BilliardsError(400, "Неверная сила удара.");
      }
      await client.query("BEGIN"); transactionOpen = true;
      await assertMember(client, roomId, user.id);
      const result = await client.query("SELECT game_state FROM billiards_games WHERE room_id = $1 FOR UPDATE", [roomId]);
      if (!result.rows.length) throw new BilliardsError(404, "Партия ещё не подготовлена.");
      const game = result.rows[0].game_state;
      if (game.status !== "playing") throw new BilliardsError(400, "Партия уже завершена.");
      const shooter = game.players[game.currentPlayerIndex];
      if (!shooter || String(shooter.id) !== user.id) throw new BilliardsError(403, "Сейчас ход соперника.");
      const startBalls = cloneBalls(game.balls);
      const ownGroupBefore = shooter.group;
      const remainingOwnBefore = ownGroupBefore ? countRemaining(startBalls, ownGroupBefore) : null;
      const sim = simulateShot(startBalls, angle, power);
      const ids = sim.pocketedIds;
      const sunkEight = ids.includes("8");
      const sunkCue = sim.scratch;
      const objectPotted = ids.map(id => startBalls.find(ball => ball.id === id)).filter(ball => ball && ball.type !== "cue" && ball.type !== "eight");
      let assignedGroup = false;
      if (!shooter.group && objectPotted.length) {
        const first = objectPotted[0];
        shooter.group = first.type;
        game.players.forEach(player => {
          if (String(player.id) !== String(shooter.id)) player.group = first.type === "solid" ? "stripe" : "solid";
        });
        assignedGroup = true;
      }
      game.balls = sim.endBalls;
      game.turnNo = Number(game.turnNo || 0) + 1;
      game.lastShot = {
        seq: game.turnNo,
        shooterId: String(shooter.id),
        angle,
        power,
        startBalls,
        endBalls: cloneBalls(sim.endBalls),
        pocketedIds: ids,
        scratch: sunkCue
      };
      if (sunkEight) {
        const wins = Boolean(ownGroupBefore && remainingOwnBefore === 0 && !sunkCue);
        const winner = wins ? shooter : game.players.find(player => String(player.id) !== String(shooter.id));
        game.status = "finished";
        game.winnerId = String(winner?.id || "");
        game.winnerName = String(winner?.name || "Игрок");
        await settleGame(client, roomId, game);
      } else {
        const shotGroup = shooter.group;
        const ownPocketed = !sunkCue && shotGroup && ids.some(id => {
          const ball = startBalls.find(item => item.id === id);
          return ball && ball.type === shotGroup;
        });
        const nextIdx = (game.currentPlayerIndex + 1) % game.players.length;
        if (!ownPocketed || sunkCue) game.currentPlayerIndex = nextIdx;
        game.message = sunkCue
          ? shooter.name + " забил биток. Ход соперника."
          : ownPocketed
            ? shooter.name + " забил свой шар. Продолжает."
            : "Удар завершён. Ход соперника.";
      }
      game.updatedAt = Date.now();
      await client.query(
        "UPDATE billiards_games SET game_state = $2::jsonb, updated_at = NOW() WHERE room_id = $1",
        [roomId, JSON.stringify(game)]
      );
      await client.query("COMMIT"); transactionOpen = false;
      return res.json({ ok: true, game: makePublicGame(game, user.id) });
    } catch (error) {
      if (transactionOpen) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось выполнить удар." });
    } finally { client.release(); }
  });

  router.initialize = async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS billiards_rooms (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, " +
      "name TEXT NOT NULL, owner_telegram_id BIGINT NOT NULL, " +
      "stake BIGINT NOT NULL CHECK (stake >= 100), " +
      "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished')), " +
      "bot_mode BOOLEAN NOT NULL DEFAULT FALSE, " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query("ALTER TABLE billiards_rooms ADD COLUMN IF NOT EXISTS bot_mode BOOLEAN NOT NULL DEFAULT FALSE");
    await pool.query(
      "CREATE TABLE IF NOT EXISTS billiards_room_players (" +
      "room_id BIGINT NOT NULL REFERENCES billiards_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, display_name TEXT, " +
      "joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS billiards_games (" +
      "room_id BIGINT PRIMARY KEY REFERENCES billiards_rooms(id) ON DELETE CASCADE, " +
      "game_state JSONB NOT NULL DEFAULT '{}'::jsonb, " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    console.log("Billiards Online tables are ready");
  };

  return router;
}
