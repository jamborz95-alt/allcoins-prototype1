import express from "express";
import crypto from "node:crypto";

function clampPercent(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(4, Math.min(96, n)) : fallback;
}
function fuseDuration() {
  return Math.floor(8200 + Math.random() * 7200);
}
const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function makeInviteCode() {
  const bytes = crypto.randomBytes(7);
  let code = "";
  for (let i = 0; i < 7; i++) code += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  return code;
}
function validPlayerId(value) {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(String(value || ""));
}
function spawnPoint(index) {
  return [
    { xPct: 50, yPct: 66 },
    { xPct: 23, yPct: 45 },
    { xPct: 77, yPct: 45 },
    { xPct: 50, yPct: 26 }
  ][Math.max(0, Math.min(3, index))];
}
function publicPlayers(rows) {
  return rows.map((row) => ({
    playerId: String(row.player_id),
    name: String(row.display_name || "Игрок").slice(0, 18),
    lives: Number(row.lives) || 0,
    xPct: Number(row.x_pct) || 50,
    yPct: Number(row.y_pct) || 66,
    connected: row.last_seen_at ? Date.now() - new Date(row.last_seen_at).getTime() < 15000 : false
  }));
}
async function readPlayers(client, roomId) {
  const result = await client.query(
    "SELECT player_id, display_name, lives, x_pct, y_pct, joined_at, last_seen_at FROM bomb_room_players WHERE room_id = $1 ORDER BY joined_at ASC, player_id ASC",
    [roomId]
  );
  return result.rows;
}
async function advanceRoom(client, roomId, now = Date.now()) {
  const roomResult = await client.query(
    "SELECT id, status, max_players, map, game_state, created_at, invite_code FROM bomb_rooms WHERE id = $1 FOR UPDATE",
    [roomId]
  );
  if (!roomResult.rows.length) return null;
  const room = roomResult.rows[0];
  if (room.status === "waiting" && !room.invite_code) {
    const assigned = await client.query(
      "UPDATE bomb_rooms SET invite_code = $2 WHERE id = $1 AND invite_code IS NULL RETURNING invite_code",
      [roomId, makeInviteCode()]
    );
    room.invite_code = assigned.rows[0]?.invite_code || room.invite_code || null;
  }
  let status = room.status;
  let game = room.game_state && typeof room.game_state === "object" ? room.game_state : { phase: "waiting", round: 0 };
  // Avoid rewriting the same room/game JSON on every heartbeat. Polling can be
  // frequent on mobile; only persist this row when the authoritative state moves.
  const previousStatus = String(status);
  const previousGameJson = JSON.stringify(game);

  if (status === "waiting") {
    // A waiting player who disappeared should not occupy a lobby seat forever.
    await client.query(
      "DELETE FROM bomb_room_players WHERE room_id = $1 AND last_seen_at < NOW() - INTERVAL '90 seconds'",
      [roomId]
    );
  } else if (status === "playing") {
    // Give suspended mobile Mini Apps a little longer before treating a player as gone.
    await client.query(
      "UPDATE bomb_room_players SET lives = 0 WHERE room_id = $1 AND lives > 0 AND last_seen_at < NOW() - INTERVAL '90 seconds'",
      [roomId]
    );
  }

  let roster = await readPlayers(client, roomId);
  let alive = roster.filter((p) => Number(p.lives) > 0);

  if (status === "waiting") {
    const age = now - new Date(room.created_at).getTime();
    if (alive.length >= Number(room.max_players) || (alive.length >= 2 && age >= 5000)) {
      const holder = alive[Math.floor(Math.random() * alive.length)];
      game = {
        phase: "playing", round: 1, holderId: String(holder.player_id),
        fuseEndsAt: now + fuseDuration(), phaseEndsAt: null, passToId: null,
        transferEndsAt: null, lastExplosionId: null, loserId: null,
        winnerId: null, startedAt: now
      };
      status = "playing";
    }
  } else if (status === "playing") {
    if (game.phase === "playing" && !alive.some((p) => String(p.player_id) === String(game.holderId))) {
      if (alive.length <= 1) {
        status = "finished";
        game = { ...game, phase: "finished", winnerId: alive[0] ? String(alive[0].player_id) : null, finishedAt: now };
      } else {
        const nextHolder = alive[Math.floor(Math.random() * alive.length)];
        game = { ...game, holderId: String(nextHolder.player_id), fuseEndsAt: now + fuseDuration() };
      }
    }

    if (status === "playing" && game.phase === "passing" && alive.length <= 1) {
      status = "finished";
      game = {
        ...game, phase: "finished",
        winnerId: alive[0] ? String(alive[0].player_id) : null,
        passToId: null, transferEndsAt: null, finishedAt: now
      };
    } else if (status === "playing" && game.phase === "passing" && Number(game.transferEndsAt) <= now) {
      const intendedReceiver = alive.find((p) => String(p.player_id) === String(game.passToId));
      const alternatives = alive.filter((p) => String(p.player_id) !== String(game.holderId));
      const receiver = intendedReceiver || alternatives[Math.floor(Math.random() * alternatives.length)] || alive[0];
      if (receiver) {
        game = {
          ...game, phase: "playing", holderId: String(receiver.player_id),
          passToId: null, transferEndsAt: null,
          fuseEndsAt: Number(game.fuseEndsAt) || now + 1000
        };
      } else {
        status = "finished";
        game = { ...game, phase: "finished", winnerId: null, finishedAt: now };
      }
    }

    if (status === "playing" && game.phase === "playing" && Number(game.fuseEndsAt) <= now) {
      const unluckyId = String(game.holderId || "");
      if (unluckyId) {
        await client.query(
          "UPDATE bomb_room_players SET lives = GREATEST(0, lives - 1) WHERE room_id = $1 AND player_id = $2",
          [roomId, unluckyId]
        );
      }
      roster = await readPlayers(client, roomId);
      alive = roster.filter((p) => Number(p.lives) > 0);
      game = {
        ...game, phase: "boom", phaseEndsAt: now + 1250, fuseEndsAt: null,
        lastExplosionId: crypto.randomUUID(), loserId: unluckyId,
        winnerId: alive.length === 1 ? String(alive[0].player_id) : null
      };
    }

    if (status === "playing" && game.phase === "playing" && alive.length <= 1) {
      status = "finished";
      game = { ...game, phase: "finished", winnerId: alive[0] ? String(alive[0].player_id) : null, finishedAt: now };
    } else if (status === "playing" && game.phase === "boom" && Number(game.phaseEndsAt) <= now) {
      roster = await readPlayers(client, roomId);
      alive = roster.filter((p) => Number(p.lives) > 0);
      if (alive.length <= 1) {
        status = "finished";
        game = { ...game, phase: "finished", winnerId: alive[0] ? String(alive[0].player_id) : null, finishedAt: now };
      } else {
        const nextHolder = alive[Math.floor(Math.random() * alive.length)];
        game = {
          ...game, phase: "playing", round: (Number(game.round) || 0) + 1,
          holderId: String(nextHolder.player_id), fuseEndsAt: now + fuseDuration(),
          phaseEndsAt: null, passToId: null, transferEndsAt: null,
          loserId: null, winnerId: null
        };
      }
    }
  }

  if (String(status) !== previousStatus || JSON.stringify(game) !== previousGameJson) {
    await client.query(
      "UPDATE bomb_rooms SET status = $2, game_state = $3::jsonb, updated_at = NOW() WHERE id = $1",
      [roomId, status, JSON.stringify(game)]
    );
  }
  roster = await readPlayers(client, roomId);
  return {
    room: {
      id: String(room.id), status, maxPlayers: Number(room.max_players),
      map: room.map, createdAt: room.created_at, inviteCode: room.invite_code || null
    },
    game,
    players: publicPlayers(roster)
  };
}

export function createBombOnlineRouter({ pool }) {
  const router = express.Router();

  router.initialize = async () => {
    await pool.query("CREATE TABLE IF NOT EXISTS bomb_rooms (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')), max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 4), map TEXT NOT NULL DEFAULT 'copper' CHECK (map IN ('copper','crystal')), game_state JSONB NOT NULL DEFAULT '{}'::jsonb, invite_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await pool.query("ALTER TABLE bomb_rooms ADD COLUMN IF NOT EXISTS invite_code TEXT");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS bomb_rooms_invite_code_idx ON bomb_rooms (invite_code) WHERE invite_code IS NOT NULL");
    await pool.query("CREATE TABLE IF NOT EXISTS bomb_room_players (room_id BIGINT NOT NULL REFERENCES bomb_rooms(id) ON DELETE CASCADE, player_id TEXT NOT NULL, display_name TEXT NOT NULL, lives INTEGER NOT NULL DEFAULT 3 CHECK (lives BETWEEN 0 AND 3), x_pct REAL NOT NULL DEFAULT 50, y_pct REAL NOT NULL DEFAULT 66, joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (room_id, player_id))");
    await pool.query("CREATE INDEX IF NOT EXISTS bomb_rooms_waiting_idx ON bomb_rooms (status, max_players, map, created_at)");
    await pool.query("CREATE INDEX IF NOT EXISTS bomb_room_players_presence_idx ON bomb_room_players (room_id, last_seen_at DESC)");
  };

  router.post("/matchmaking/join", async (req, res) => {
    let client;
    try {
      const playerId = String(req.body?.playerId || "").trim().slice(0, 80);
      const name = String(req.body?.name || "Игрок").trim().slice(0, 18) || "Игрок";
      const maxPlayers = Math.max(2, Math.min(4, Math.floor(Number(req.body?.maxPlayers) || 2)));
      const map = req.body?.map === "crystal" ? "crystal" : "copper";
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(playerId)) {
        return res.status(400).json({ ok: false, error: "Некорректная сетевая сессия. Перезагрузи игру." });
      }
      client = await pool.connect();
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT r.id FROM bomb_rooms r JOIN bomb_room_players p ON p.room_id = r.id WHERE p.player_id = $1 AND r.status IN ('waiting','playing') ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE OF r",
        [playerId]
      );
      let roomId = existing.rows[0] ? String(existing.rows[0].id) : null;

      if (roomId) {
        await client.query("UPDATE bomb_room_players SET display_name = $2, last_seen_at = NOW() WHERE room_id = $1 AND player_id = $3", [roomId, name, playerId]);
      } else {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["bomb:" + maxPlayers + ":" + map]);
        // Expire lobbies by inactivity, not by their creation time: a lone player may
        // keep searching longer than two minutes while still sending heartbeats.
        await client.query("DELETE FROM bomb_rooms WHERE status = 'waiting' AND updated_at < NOW() - INTERVAL '2 minutes'");
        await client.query("DELETE FROM bomb_rooms WHERE status = 'finished' AND updated_at < NOW() - INTERVAL '1 day'");
        const candidates = await client.query(
          "SELECT id, max_players FROM bomb_rooms WHERE status = 'waiting' AND max_players = $1 AND map = $2 AND updated_at > NOW() - INTERVAL '2 minutes' ORDER BY created_at ASC LIMIT 20",
          [maxPlayers, map]
        );
        for (const candidate of candidates.rows) {
          await client.query("SELECT id FROM bomb_rooms WHERE id = $1 FOR UPDATE", [candidate.id]);
          await client.query(
            "DELETE FROM bomb_room_players WHERE room_id = $1 AND last_seen_at < NOW() - INTERVAL '90 seconds'",
            [candidate.id]
          );
          const count = await client.query(
            "SELECT COUNT(*)::int AS count FROM bomb_room_players WHERE room_id = $1 AND lives > 0 AND last_seen_at > NOW() - INTERVAL '90 seconds'",
            [candidate.id]
          );
          if (Number(count.rows[0]?.count || 0) < Number(candidate.max_players)) {
            roomId = String(candidate.id);
            break;
          }
        }
        if (!roomId) {
          const created = await client.query(
            "INSERT INTO bomb_rooms (status, max_players, map, game_state, invite_code) VALUES ('waiting', $1, $2, $3::jsonb, $4) RETURNING id",
            [maxPlayers, map, JSON.stringify({ phase: "waiting", round: 0 }), makeInviteCode()]
          );
          roomId = String(created.rows[0].id);
        }
        const count = await client.query("SELECT COUNT(*)::int AS count FROM bomb_room_players WHERE room_id = $1", [roomId]);
        const spawn = spawnPoint(Number(count.rows[0]?.count || 0));
        await client.query(
          "INSERT INTO bomb_room_players (room_id, player_id, display_name, lives, x_pct, y_pct, last_seen_at) VALUES ($1, $2, $3, 3, $4, $5, NOW()) ON CONFLICT (room_id, player_id) DO UPDATE SET display_name = EXCLUDED.display_name, last_seen_at = NOW()",
          [roomId, playerId, name, spawn.xPct, spawn.yPct]
        );
      }
      const snapshot = await advanceRoom(client, roomId);
      await client.query("COMMIT");
      res.json({ ok: true, ...snapshot, playerId });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Bomb online matchmaking error:", error.message);
      res.status(500).json({ ok: false, error: "Не удалось подключиться к онлайн-игре. Повтори попытку." });
    } finally {
      if (client) client.release();
    }
  });

  // Open-room browser: waiting rooms are discoverable by every online player.
  // Stale rooms are pruned here as a safety net when no player is polling them.
  router.post("/rooms/list", async (_req, res) => {
    try {
      await pool.query(
        "DELETE FROM bomb_rooms WHERE status = 'waiting' AND updated_at < NOW() - INTERVAL '2 minutes'"
      );
      const result = await pool.query(`
        SELECT
          r.id::text AS id,
          r.max_players,
          r.map,
          r.invite_code,
          r.created_at,
          COUNT(p.player_id)::int AS player_count,
          COALESCE(
            jsonb_agg(jsonb_build_object('name', p.display_name) ORDER BY p.joined_at)
              FILTER (WHERE p.player_id IS NOT NULL),
            '[]'::jsonb
          ) AS players
        FROM bomb_rooms r
        LEFT JOIN bomb_room_players p
          ON p.room_id = r.id
          AND p.lives > 0
          AND p.last_seen_at > NOW() - INTERVAL '90 seconds'
        WHERE r.status = 'waiting'
          AND r.updated_at > NOW() - INTERVAL '2 minutes'
        GROUP BY r.id, r.max_players, r.map, r.invite_code, r.created_at
        ORDER BY r.created_at ASC
        LIMIT 30
      `);
      return res.json({
        ok: true,
        rooms: result.rows.map((row) => ({
          id: String(row.id),
          maxPlayers: Number(row.max_players),
          map: row.map,
          inviteCode: row.invite_code || null,
          createdAt: row.created_at,
          playerCount: Number(row.player_count) || 0,
          players: Array.isArray(row.players) ? row.players : []
        }))
      });
    } catch (error) {
      console.error("Bomb open-room list error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить открытые комнаты." });
    }
  });

  // Join a listed public room by its database room ID.
  router.post("/rooms/join-open", async (req, res) => {
    let client;
    try {
      const roomId = String(req.body?.roomId || "").trim();
      const playerId = String(req.body?.playerId || "").trim().slice(0, 80);
      const name = String(req.body?.name || "Игрок").trim().slice(0, 18) || "Игрок";
      if (!/^\d{1,20}$/.test(roomId) || !validPlayerId(playerId)) {
        return res.status(400).json({ ok: false, error: "Некорректная открытая комната." });
      }

      client = await pool.connect();
      await client.query("BEGIN");
      const roomResult = await client.query(
        "SELECT id, status, max_players, updated_at FROM bomb_rooms WHERE id = $1 FOR UPDATE",
        [roomId]
      );
      if (
        !roomResult.rows.length ||
        roomResult.rows[0].status !== "waiting" ||
        new Date(roomResult.rows[0].updated_at).getTime() < Date.now() - 120000
      ) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "Открытая комната уже закрыта. Обнови список." });
      }

      await client.query(
        "DELETE FROM bomb_room_players WHERE room_id = $1 AND last_seen_at < NOW() - INTERVAL '90 seconds'",
        [roomId]
      );
      // A player can only occupy one waiting room at a time.
      await client.query(
        "DELETE FROM bomb_room_players WHERE player_id = $1 AND room_id <> $2 AND room_id IN (SELECT id FROM bomb_rooms WHERE status = 'waiting')",
        [playerId, roomId]
      );
      const current = await client.query(
        "SELECT COUNT(*)::int AS count FROM bomb_room_players WHERE room_id = $1 AND lives > 0 AND last_seen_at > NOW() - INTERVAL '90 seconds'",
        [roomId]
      );
      const alreadyJoined = await client.query(
        "SELECT 1 FROM bomb_room_players WHERE room_id = $1 AND player_id = $2",
        [roomId, playerId]
      );
      if (!alreadyJoined.rows.length && Number(current.rows[0]?.count || 0) >= Number(roomResult.rows[0].max_players)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "Комната уже заполнена. Обнови список открытых комнат." });
      }

      if (alreadyJoined.rows.length) {
        await client.query(
          "UPDATE bomb_room_players SET display_name = $3, last_seen_at = NOW() WHERE room_id = $1 AND player_id = $2",
          [roomId, playerId, name]
        );
      } else {
        const spawn = spawnPoint(Number(current.rows[0]?.count || 0));
        await client.query(
          "INSERT INTO bomb_room_players (room_id, player_id, display_name, lives, x_pct, y_pct, last_seen_at) VALUES ($1, $2, $3, 3, $4, $5, NOW())",
          [roomId, playerId, name, spawn.xPct, spawn.yPct]
        );
      }

      const snapshot = await advanceRoom(client, roomId);
      await client.query("COMMIT");
      return res.json({ ok: true, ...snapshot, playerId });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Bomb open-room join error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось войти в открытую комнату." });
    } finally {
      if (client) client.release();
    }
  });

  router.post("/rooms/create", async (req, res) => {
    let client;
    try {
      const playerId = String(req.body?.playerId || "").trim().slice(0, 80);
      const name = String(req.body?.name || "Игрок").trim().slice(0, 18) || "Игрок";
      const maxPlayers = Math.max(2, Math.min(4, Math.floor(Number(req.body?.maxPlayers) || 2)));
      const map = req.body?.map === "crystal" ? "crystal" : "copper";
      if (!validPlayerId(playerId)) return res.status(400).json({ ok: false, error: "Некорректный идентификатор игрока." });

      client = await pool.connect();
      await client.query("BEGIN");
      // A player may create a friend room from the setup screen after cancelling public matchmaking.
      await client.query(
        "DELETE FROM bomb_room_players WHERE player_id = $1 AND room_id IN (SELECT id FROM bomb_rooms WHERE status = 'waiting')",
        [playerId]
      );
      const created = await client.query(
        "INSERT INTO bomb_rooms (status, max_players, map, game_state, invite_code) VALUES ('waiting', $1, $2, $3::jsonb, $4) RETURNING id",
        [maxPlayers, map, JSON.stringify({ phase: "waiting", round: 0 }), makeInviteCode()]
      );
      const roomId = String(created.rows[0].id);
      const spawn = spawnPoint(0);
      await client.query(
        "INSERT INTO bomb_room_players (room_id, player_id, display_name, lives, x_pct, y_pct, last_seen_at) VALUES ($1, $2, $3, 3, $4, $5, NOW())",
        [roomId, playerId, name, spawn.xPct, spawn.yPct]
      );
      const snapshot = await advanceRoom(client, roomId);
      await client.query("COMMIT");
      res.json({ ok: true, ...snapshot, playerId });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Bomb online room creation error:", error.message);
      res.status(500).json({ ok: false, error: "Не удалось создать комнату для друзей. Повтори попытку." });
    } finally {
      if (client) client.release();
    }
  });

  router.post("/rooms/join", async (req, res) => {
    let client;
    try {
      const inviteCode = String(req.body?.inviteCode || "").trim().toUpperCase().replace(/\s+/g, "");
      const playerId = String(req.body?.playerId || "").trim().slice(0, 80);
      const name = String(req.body?.name || "Игрок").trim().slice(0, 18) || "Игрок";
      if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{7}$/.test(inviteCode) || !validPlayerId(playerId)) {
        return res.status(400).json({ ok: false, error: "Проверь код комнаты и попробуй ещё раз." });
      }

      client = await pool.connect();
      await client.query("BEGIN");
      const roomResult = await client.query(
        "SELECT id, status, max_players FROM bomb_rooms WHERE invite_code = $1 FOR UPDATE",
        [inviteCode]
      );
      if (!roomResult.rows.length || roomResult.rows[0].status !== "waiting") {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "Комната не найдена или игра уже началась. Попроси друга создать новую." });
      }
      const roomId = String(roomResult.rows[0].id);
      await client.query(
        "DELETE FROM bomb_room_players WHERE room_id = $1 AND last_seen_at < NOW() - INTERVAL '90 seconds'",
        [roomId]
      );
      // Don't leave a duplicate stale lobby membership behind when switching from random matchmaking.
      await client.query(
        "DELETE FROM bomb_room_players WHERE player_id = $1 AND room_id <> $2 AND room_id IN (SELECT id FROM bomb_rooms WHERE status = 'waiting')",
        [playerId, roomId]
      );

      const current = await client.query(
        "SELECT COUNT(*)::int AS count FROM bomb_room_players WHERE room_id = $1 AND lives > 0",
        [roomId]
      );
      const alreadyJoined = await client.query(
        "SELECT 1 FROM bomb_room_players WHERE room_id = $1 AND player_id = $2",
        [roomId, playerId]
      );
      if (!alreadyJoined.rows.length && Number(current.rows[0]?.count || 0) >= Number(roomResult.rows[0].max_players)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "Комната уже заполнена. Попроси друга создать новую." });
      }
      if (alreadyJoined.rows.length) {
        await client.query(
          "UPDATE bomb_room_players SET display_name = $3, last_seen_at = NOW() WHERE room_id = $1 AND player_id = $2",
          [roomId, playerId, name]
        );
      } else {
        const spawn = spawnPoint(Number(current.rows[0]?.count || 0));
        await client.query(
          "INSERT INTO bomb_room_players (room_id, player_id, display_name, lives, x_pct, y_pct, last_seen_at) VALUES ($1, $2, $3, 3, $4, $5, NOW())",
          [roomId, playerId, name, spawn.xPct, spawn.yPct]
        );
      }
      const snapshot = await advanceRoom(client, roomId);
      await client.query("COMMIT");
      res.json({ ok: true, ...snapshot, playerId });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Bomb online room join error:", error.message);
      res.status(500).json({ ok: false, error: "Не удалось войти в комнату по коду." });
    } finally {
      if (client) client.release();
    }
  });

  router.post("/rooms/state", async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
      const roomId = String(req.body?.roomId || "").trim();
      const playerId = String(req.body?.playerId || "").trim().slice(0, 80);
      if (!/^\d{1,20}$/.test(roomId) || !/^[a-zA-Z0-9_-]{8,80}$/.test(playerId)) {
        return res.status(400).json({ ok: false, error: "Некорректный идентификатор комнаты." });
      }
      client = await pool.connect();

      // Update the player's position before locking the shared room row. Previously
      // every heartbeat held the room lock during several player/state queries, so
      // all clients queued behind one another. Only the authoritative game advance
      // below needs the room lock.
      const membership = await client.query(
        "SELECT 1 FROM bomb_room_players WHERE room_id = $1 AND player_id = $2",
        [roomId, playerId]
      );
      if (!membership.rows.length) {
        return res.status(403).json({ ok: false, error: "Ты больше не находишься в этой комнате." });
      }
      const xPct = clampPercent(req.body?.xPct, 50);
      const yPct = clampPercent(req.body?.yPct, 66);
      await client.query(
        "UPDATE bomb_room_players SET " +
        "x_pct = CASE WHEN ABS(COALESCE(x_pct, 50) - $3) > 0.35 THEN $3 ELSE x_pct END, " +
        "y_pct = CASE WHEN ABS(COALESCE(y_pct, 66) - $4) > 0.35 THEN $4 ELSE y_pct END, " +
        "last_seen_at = CASE WHEN last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '2 seconds' THEN NOW() ELSE last_seen_at END " +
        "WHERE room_id = $1 AND player_id = $2 AND (" +
        "ABS(COALESCE(x_pct, 50) - $3) > 0.35 OR ABS(COALESCE(y_pct, 66) - $4) > 0.35 OR " +
        "last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '2 seconds')",
        [roomId, playerId, xPct, yPct]
      );

      await client.query("BEGIN");
      transactionOpen = true;
      const snapshot = await advanceRoom(client, roomId);
      if (!snapshot) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return res.status(404).json({ ok: false, error: "Комната уже закрыта." });
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return res.json({ ok: true, ...snapshot, playerId });
    } catch (error) {
      if (client && transactionOpen) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Bomb online state error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось обновить состояние онлайн-игры." });
    } finally {
      if (client) client.release();
    }
  });
  router.post("/rooms/pass", async (req, res) => {
    let client;
    try {
      const roomId = String(req.body?.roomId || "").trim();
      const playerId = String(req.body?.playerId || "").trim().slice(0, 80);
      const targetPlayerId = String(req.body?.targetPlayerId || "").trim().slice(0, 80);
      if (!/^\d{1,20}$/.test(roomId) || !/^[a-zA-Z0-9_-]{8,80}$/.test(playerId) || !/^[a-zA-Z0-9_-]{8,80}$/.test(targetPlayerId)) {
        return res.status(400).json({ ok: false, error: "Некорректная передача бомбы." });
      }
      client = await pool.connect();
      await client.query("BEGIN");
      const roomResult = await client.query("SELECT id, status, game_state FROM bomb_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      if (!roomResult.rows.length || roomResult.rows[0].status !== "playing") {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "Раунд уже завершён." });
      }
      const game = roomResult.rows[0].game_state || {};
      const roster = await readPlayers(client, roomId);
      const owner = roster.find((p) => String(p.player_id) === playerId && Number(p.lives) > 0);
      const target = roster.find((p) => String(p.player_id) === targetPlayerId && Number(p.lives) > 0);
      if (!owner || !target || playerId === targetPlayerId || String(game.holderId) !== playerId || game.phase !== "playing") {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "Бомбу уже передал другой игрок или цель недоступна." });
      }
      game.phase = "passing";
      game.passToId = targetPlayerId;
      game.transferEndsAt = Date.now() + 700;
      await client.query("UPDATE bomb_rooms SET game_state = $2::jsonb, updated_at = NOW() WHERE id = $1", [roomId, JSON.stringify(game)]);
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Bomb online pass error:", error.message);
      res.status(500).json({ ok: false, error: "Не удалось передать бомбу." });
    } finally {
      if (client) client.release();
    }
  });

  router.post("/rooms/leave", async (req, res) => {
    let client;
    try {
      const roomId = String(req.body?.roomId || "").trim();
      const playerId = String(req.body?.playerId || "").trim().slice(0, 80);
      if (!/^\d{1,20}$/.test(roomId) || !/^[a-zA-Z0-9_-]{8,80}$/.test(playerId)) {
        return res.status(400).json({ ok: false, error: "Некорректная комната." });
      }
      client = await pool.connect();
      await client.query("BEGIN");
      const roomResult = await client.query("SELECT id, status, game_state FROM bomb_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      if (!roomResult.rows.length) {
        await client.query("COMMIT");
        return res.json({ ok: true });
      }
      const room = roomResult.rows[0];
      if (room.status === "waiting") {
        await client.query("DELETE FROM bomb_room_players WHERE room_id = $1 AND player_id = $2", [roomId, playerId]);
        const remaining = await client.query("SELECT COUNT(*)::int AS count FROM bomb_room_players WHERE room_id = $1", [roomId]);
        if (Number(remaining.rows[0]?.count || 0) === 0) await client.query("DELETE FROM bomb_rooms WHERE id = $1", [roomId]);
      } else if (room.status === "playing") {
        await client.query("UPDATE bomb_room_players SET lives = 0 WHERE room_id = $1 AND player_id = $2", [roomId, playerId]);
        let game = room.game_state || {};
        const roster = await readPlayers(client, roomId);
        const alive = roster.filter((p) => Number(p.lives) > 0);
        if (alive.length <= 1) {
          await client.query(
            "UPDATE bomb_rooms SET status = 'finished', game_state = $2::jsonb, updated_at = NOW() WHERE id = $1",
            [roomId, JSON.stringify({ ...game, phase: "finished", winnerId: alive[0] ? String(alive[0].player_id) : null, finishedAt: Date.now() })]
          );
        } else if (String(game.holderId) === playerId) {
          const holder = alive[Math.floor(Math.random() * alive.length)];
          game = { ...game, phase: "playing", holderId: String(holder.player_id), passToId: null, transferEndsAt: null, fuseEndsAt: Date.now() + fuseDuration() };
          await client.query("UPDATE bomb_rooms SET game_state = $2::jsonb, updated_at = NOW() WHERE id = $1", [roomId, JSON.stringify(game)]);
        }
      } else {
        await client.query("DELETE FROM bomb_room_players WHERE room_id = $1 AND player_id = $2", [roomId, playerId]);
      }
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
      console.error("Bomb online leave error:", error.message);
      res.status(500).json({ ok: false, error: "Не удалось выйти из комнаты." });
    } finally {
      if (client) client.release();
    }
  });

  return router;
}
