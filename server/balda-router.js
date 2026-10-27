import express from "express";
import { readFileSync } from "node:fs";
import { configuredAdminTelegramId } from "./commission.js";

const ROOM_PREFIX = "BD-";
const MAX_BIGINT = 9223372036854775807n;
// No user-facing cap: the technical maximum is limited only by PostgreSQL BIGINT
// and the fact that the two-player prize pool must fit into one BIGINT balance.
const MAX_STAKE = MAX_BIGINT / 2n;
const ALPHABET = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ".split("");
const NORMALIZE = value => String(value ?? "").trim().toUpperCase().replace(/Ё/g, "Е");
const WORDS = new Set(
  readFileSync(new URL("./balda-words.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map(line => NORMALIZE(line))
    .filter(word => /^[А-Я]+$/.test(word) && word.length >= 2 && word.length <= 5)
);

class BaldaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseRoomId(value) {
  const raw = String(value ?? "").trim().replace(/^BD-/i, "");
  return /^[1-9]\d{0,17}$/.test(raw) ? raw : null;
}

function safeStake(value) {
  const raw = String(value ?? "").trim().replace(/[\s,_]/g, "");
  if (!/^\d+$/.test(raw)) return null;
  try {
    const amount = BigInt(raw);
    return amount >= 100n && amount <= MAX_STAKE ? amount.toString() : null;
  } catch { return null; }
}

function authenticatedUser(req, verifyTelegram) {
  const user = verifyTelegram(req.body?.initData);
  if (!user?.id) throw new BaldaError(401, "Открой «Балда Онлайн» через ALLCOINS в Telegram.");
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return { id: String(user.id), name: String((fullName || user.username || "Игрок")).slice(0, 40) };
}

async function ensurePlayer(client, user) {
  const result = await client.query(
    "INSERT INTO players (telegram_id) VALUES ($1::BIGINT) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance::TEXT AS balance",
    [user.id]
  );
  return BigInt(String(result.rows[0]?.balance || "0"));
}

async function assertRoomMember(client, roomId, userId) {
  const result = await client.query(
    "SELECT 1 FROM balda_room_players WHERE room_id = $1 AND telegram_id = $2::BIGINT",
    [roomId, userId]
  );
  if (!result.rows.length) throw new BaldaError(403, "Сначала войди в эту комнату.");
}

function blankBoard() {
  const board = Array(25).fill("");
  // Classic BALDA seed word sits across the middle row.
  ["Б", "А", "Л", "Д", "А"].forEach((letter, col) => { board[2 * 5 + col] = letter; });
  return board;
}

function extractAxisWord(board, cell, dx, dy) {
  const row = Math.floor(cell / 5);
  const col = cell % 5;
  let startRow = row, startCol = col;
  while (true) {
    const nextRow = startRow - dy, nextCol = startCol - dx;
    if (nextRow < 0 || nextRow >= 5 || nextCol < 0 || nextCol >= 5 || !board[nextRow * 5 + nextCol]) break;
    startRow = nextRow; startCol = nextCol;
  }
  let word = "";
  let currentRow = startRow, currentCol = startCol;
  while (currentRow >= 0 && currentRow < 5 && currentCol >= 0 && currentCol < 5) {
    const letter = board[currentRow * 5 + currentCol];
    if (!letter) break;
    word += letter;
    currentRow += dy; currentCol += dx;
  }
  return NORMALIZE(word);
}

function moveWordsFor(board, cell) {
  return [...new Set([
    extractAxisWord(board, cell, 1, 0),
    extractAxisWord(board, cell, 0, 1)
  ].filter(word => word.length >= 2))];
}

function isAdjacent(board, cell) {
  const row = Math.floor(cell / 5), col = cell % 5;
  return [
    [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]
  ].some(([r, c]) => r >= 0 && r < 5 && c >= 0 && c < 5 && board[r * 5 + c]);
}

function candidateWordsAreValid(board, cell, letter, usedWords) {
  if (board[cell] || !isAdjacent(board, cell)) return false;
  const next = board.slice();
  next[cell] = letter;
  const words = moveWordsFor(next, cell);
  return words.length > 0 && words.every(word => WORDS.has(word) && !usedWords.includes(word));
}

function hasLegalMove(board, usedWords) {
  for (let cell = 0; cell < board.length; cell++) {
    if (board[cell] || !isAdjacent(board, cell)) continue;
    for (const letter of ALPHABET) {
      if (candidateWordsAreValid(board, cell, letter, usedWords)) return true;
    }
  }
  return false;
}

function publicGame(game, userId) {
  if (!game) return null;
  return {
    status: String(game.status || "playing"),
    board: Array.isArray(game.board) ? game.board : blankBoard(),
    players: (game.players || []).map(player => ({
      id: String(player.id),
      name: String(player.name || "Игрок"),
      score: Number(player.score || 0),
      isYou: String(player.id) === String(userId)
    })),
    currentPlayerId: game.currentPlayerId ? String(game.currentPlayerId) : null,
    currentPlayerIndex: Number(game.currentPlayerIndex || 0),
    moves: Number(game.moves || 0),
    usedWords: Array.isArray(game.usedWords) ? game.usedWords : [],
    history: Array.isArray(game.history) ? game.history.slice(-20) : [],
    lastMove: game.lastMove || null,
    passStreak: Number(game.passStreak || 0),
    pot: String(game.pot || "0"),
    winnerId: game.winnerId == null ? null : String(game.winnerId),
    winnerName: game.winnerName || null,
    draw: Boolean(game.draw),
    payout: String(game.payout || "0"),
    commission: String(game.commission || "0"),
    message: String(game.message || ""),
    settled: Boolean(game.settled),
    updatedAt: game.updatedAt || null
  };
}

async function roomPayload(client, roomId, userId) {
  const result = await client.query(
    "SELECT r.id::TEXT AS id, r.name, r.owner_telegram_id::TEXT AS owner_id, r.stake::TEXT AS stake, " +
      "r.status, r.created_at, COUNT(p.telegram_id)::INTEGER AS players_count " +
    "FROM balda_rooms r LEFT JOIN balda_room_players p ON p.room_id = r.id " +
    "WHERE r.id = $1 GROUP BY r.id",
    [String(roomId)]
  );
  const row = result.rows[0];
  if (!row) throw new BaldaError(404, "Комната не найдена или уже закрыта.");
  const membersResult = await client.query(
    "SELECT telegram_id::TEXT AS id, display_name, joined_at FROM balda_room_players " +
    "WHERE room_id = $1 ORDER BY joined_at ASC, telegram_id ASC",
    [String(roomId)]
  );
  const members = membersResult.rows;
  const gameResult = await client.query("SELECT game_state FROM balda_games WHERE room_id = $1", [String(roomId)]);
  const state = gameResult.rows[0]?.game_state || null;
  return {
    room: {
      id: ROOM_PREFIX + String(row.id),
      roomId: String(row.id),
      name: String(row.name || "Комната Балды"),
      ownerId: String(row.owner_id),
      ownerName: String(members.find(player => String(player.id) === String(row.owner_id))?.display_name || "Создатель"),
      stake: String(row.stake),
      maxPlayers: 2,
      playersCount: Number(row.players_count || 0),
      status: String(row.status),
      isOwner: String(row.owner_id) === String(userId),
      createdAt: row.created_at
    },
    players: members.map(player => ({
      id: String(player.id),
      name: String(player.display_name || "Игрок"),
      isOwner: String(player.id) === String(row.owner_id),
      isYou: String(player.id) === String(userId)
    })),
    game: publicGame(state, userId)
  };
}

async function recordExactCommission(client, roomId, gross) {
  const amount = gross * 5n / 100n;
  if (amount <= 0n) return 0n;
  const eventKey = "balda-online:" + String(roomId);
  const adminId = configuredAdminTelegramId();
  const inserted = await client.query(
    "INSERT INTO allcoins_commissions (game, event_key, gross_amount, commission_amount, admin_telegram_id, credited_at) " +
    "VALUES ('balda-online', $1, $2::BIGINT, $3::BIGINT, $4, CASE WHEN $4::TEXT IS NULL THEN NULL ELSE NOW() END) " +
    "ON CONFLICT (event_key) DO NOTHING RETURNING id",
    [eventKey, gross.toString(), amount.toString(), adminId]
  );
  if (!inserted.rows.length) {
    const existing = await client.query(
      "SELECT commission_amount::TEXT AS amount FROM allcoins_commissions WHERE event_key = $1",
      [eventKey]
    );
    return BigInt(String(existing.rows[0]?.amount || "0"));
  }
  if (adminId) {
    await client.query(
      "INSERT INTO players (telegram_id) VALUES ($1::BIGINT) ON CONFLICT (telegram_id) DO NOTHING",
      [adminId]
    );
    const credited = await client.query(
      "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT RETURNING balance",
      [amount.toString(), adminId]
    );
    if (!credited.rows.length) throw new Error("Не удалось начислить комиссию администратору.");
  }
  return amount;
}

async function settleGame(client, roomId, room, game) {
  if (game.settled) return;
  const [first, second] = game.players;
  if (Number(first.score) === Number(second.score)) {
    // A tie returns the two original stakes without a commission.
    for (const player of game.players) {
      await client.query(
        "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT",
        [String(room.stake), String(player.id)]
      );
    }
    game.draw = true;
    game.winnerId = null;
    game.winnerName = null;
    game.payout = "0";
    game.commission = "0";
    game.message = "Ничья! Обе ставки возвращены игрокам.";
  } else {
    const winner = Number(first.score) > Number(second.score) ? first : second;
    const gross = BigInt(String(game.pot));
    const commission = await recordExactCommission(client, roomId, gross);
    const payout = gross - commission;
    const credited = await client.query(
      "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() WHERE telegram_id = $2::BIGINT RETURNING balance",
      [payout.toString(), String(winner.id)]
    );
    if (!credited.rows.length) throw new Error("Не найден профиль победителя для начисления выигрыша.");
    game.winnerId = String(winner.id);
    game.winnerName = String(winner.name);
    game.payout = payout.toString();
    game.commission = commission.toString();
    game.draw = false;
    game.message = winner.name + " победил! Выигрыш " + payout.toString() + " AC после комиссии.";
  }
  game.status = "finished";
  game.settled = true;
  game.finishedAt = Date.now();
  game.updatedAt = Date.now();
  await client.query("UPDATE balda_rooms SET status = 'finished', updated_at = NOW() WHERE id = $1", [String(roomId)]);
}

export function createBaldaRouter({ pool, verifyTelegram }) {
  const router = express.Router();

  router.initialize = async function initializeBaldaTables() {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS balda_rooms (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, " +
      "owner_telegram_id BIGINT NOT NULL, stake BIGINT NOT NULL CHECK (stake >= 100), " +
      "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')), " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS balda_room_players (" +
      "room_id BIGINT NOT NULL REFERENCES balda_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, display_name TEXT NOT NULL DEFAULT 'Игрок', " +
      "joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS balda_games (" +
      "room_id BIGINT PRIMARY KEY REFERENCES balda_rooms(id) ON DELETE CASCADE, " +
      "game_state JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query("CREATE INDEX IF NOT EXISTS balda_rooms_status_created_idx ON balda_rooms(status, created_at DESC)");
  };

  router.post("/rooms/list", async (req, res) => {
    let user;
    try {
      user = authenticatedUser(req, verifyTelegram);
      await ensurePlayer(pool, user);
      await pool.query("DELETE FROM balda_rooms WHERE (status = 'waiting' AND created_at < NOW() - INTERVAL '45 minutes') OR (status = 'finished' AND updated_at < NOW() - INTERVAL '3 minutes')");
      const result = await pool.query(
        "SELECT r.id::TEXT AS id, r.name, r.owner_telegram_id::TEXT AS owner_id, r.stake::TEXT AS stake, " +
        "r.status, r.created_at, COUNT(p.telegram_id)::INTEGER AS players_count, " +
        "COALESCE(MAX(p.display_name) FILTER (WHERE p.telegram_id = r.owner_telegram_id), 'Создатель') AS owner_name " +
        "FROM balda_rooms r LEFT JOIN balda_room_players p ON p.room_id = r.id " +
        "WHERE r.status = 'waiting' GROUP BY r.id HAVING COUNT(p.telegram_id) < 2 ORDER BY r.created_at DESC LIMIT 60"
      );
      return res.json({ ok: true, userId: user.id, rooms: result.rows.map(row => ({
        id: ROOM_PREFIX + String(row.id), roomId: String(row.id),
        name: String(row.name || "Комната Балды"), ownerName: String(row.owner_name || "Создатель"),
        stake: String(row.stake), maxPlayers: 2, playersCount: Number(row.players_count || 0),
        status: String(row.status), createdAt: row.created_at
      })) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось загрузить комнаты Балды." });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    let client;
    let open = false;
    try {
      const user = authenticatedUser(req, verifyTelegram);
      const name = String(req.body?.name || "").trim().slice(0, 32) || "Комната Балды";
      const stake = safeStake(req.body?.stake);
      if (stake === null) throw new BaldaError(400, "Укажи целую ставку от 100 AC. Верхнего лимита нет, кроме технического лимита баланса.");
      client = await pool.connect();
      await client.query("BEGIN"); open = true;
      const balance = await ensurePlayer(client, user);
      if (balance < BigInt(stake)) throw new BaldaError(400, "На балансе недостаточно AC для этой ставки.");
      const active = await client.query(
        "SELECT r.id FROM balda_rooms r JOIN balda_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1::BIGINT AND r.status IN ('waiting','playing') LIMIT 1",
        [user.id]
      );
      if (active.rows.length) throw new BaldaError(409, "Сначала выйди из своей текущей комнаты Балды.");
      const inserted = await client.query(
        "INSERT INTO balda_rooms (name, owner_telegram_id, stake, status) VALUES ($1, $2::BIGINT, $3::BIGINT, 'waiting') RETURNING id::TEXT AS id",
        [name, user.id, stake]
      );
      const roomId = String(inserted.rows[0].id);
      await client.query(
        "INSERT INTO balda_room_players (room_id, telegram_id, display_name) VALUES ($1, $2::BIGINT, $3)",
        [roomId, user.id, user.name]
      );
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (client && open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось создать комнату Балды." });
    } finally { client?.release(); }
  });

  router.post("/rooms/join", async (req, res) => {
    let client;
    let open = false;
    try {
      const user = authenticatedUser(req, verifyTelegram);
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new BaldaError(400, "Номер комнаты указан неверно.");
      client = await pool.connect();
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query(
        "SELECT id, owner_telegram_id::TEXT AS owner_id, stake::TEXT AS stake, status FROM balda_rooms WHERE id = $1 FOR UPDATE",
        [roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new BaldaError(404, "Комната не найдена.");
      const existing = await client.query(
        "SELECT 1 FROM balda_room_players WHERE room_id = $1 AND telegram_id = $2::BIGINT",
        [roomId, user.id]
      );
      if (existing.rows.length) {
        await client.query("COMMIT"); open = false;
        return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
      }
      if (room.status !== "waiting") throw new BaldaError(409, "Эта партия уже началась.");
      const balance = await ensurePlayer(client, user);
      if (balance < BigInt(String(room.stake))) throw new BaldaError(400, "На балансе недостаточно AC для этой ставки.");
      const active = await client.query(
        "SELECT r.id FROM balda_rooms r JOIN balda_room_players p ON p.room_id = r.id " +
        "WHERE p.telegram_id = $1::BIGINT AND r.status IN ('waiting','playing') LIMIT 1",
        [user.id]
      );
      if (active.rows.length) throw new BaldaError(409, "Сначала выйди из своей текущей комнаты Балды.");
      const count = await client.query("SELECT COUNT(*)::INTEGER AS total FROM balda_room_players WHERE room_id = $1", [roomId]);
      if (Number(count.rows[0]?.total || 0) >= 2) throw new BaldaError(409, "В комнате уже нет свободных мест.");
      await client.query(
        "INSERT INTO balda_room_players (room_id, telegram_id, display_name) VALUES ($1, $2::BIGINT, $3)",
        [roomId, user.id, user.name]
      );
      await client.query("UPDATE balda_rooms SET updated_at = NOW() WHERE id = $1", [roomId]);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (client && open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось войти в комнату Балды." });
    } finally { client?.release(); }
  });

  router.post("/rooms/state", async (req, res) => {
    try {
      const user = authenticatedUser(req, verifyTelegram);
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new BaldaError(400, "Номер комнаты указан неверно.");
      await assertRoomMember(pool, roomId, user.id);
      await pool.query("UPDATE balda_room_players SET display_name = display_name WHERE room_id = $1 AND telegram_id = $2::BIGINT", [roomId, user.id]);
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось обновить комнату." });
    }
  });

  router.post("/rooms/leave", async (req, res) => {
    let client;
    let open = false;
    try {
      const user = authenticatedUser(req, verifyTelegram);
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new BaldaError(400, "Номер комнаты указан неверно.");
      client = await pool.connect();
      await client.query("BEGIN"); open = true;
      const result = await client.query(
        "SELECT owner_telegram_id::TEXT AS owner_id, status FROM balda_rooms WHERE id = $1 FOR UPDATE",
        [roomId]
      );
      const row = result.rows[0];
      if (!row) { await client.query("COMMIT"); open = false; return res.json({ ok: true }); }
      if (String(row.status) !== "waiting") throw new BaldaError(409, "Партия уже началась. Дождись результата.");
      if (String(row.owner_id) === user.id) await client.query("DELETE FROM balda_rooms WHERE id = $1", [roomId]);
      else await client.query("DELETE FROM balda_room_players WHERE room_id = $1 AND telegram_id = $2::BIGINT", [roomId, user.id]);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true });
    } catch (error) {
      if (client && open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось выйти из комнаты." });
    } finally { client?.release(); }
  });

  router.post("/rooms/start", async (req, res) => {
    let client;
    let open = false;
    try {
      const user = authenticatedUser(req, verifyTelegram);
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new BaldaError(400, "Номер комнаты указан неверно.");
      client = await pool.connect();
      await client.query("BEGIN"); open = true;
      const result = await client.query(
        "SELECT id::TEXT AS id, owner_telegram_id::TEXT AS owner_id, stake::TEXT AS stake, status " +
        "FROM balda_rooms WHERE id = $1 FOR UPDATE",
        [roomId]
      );
      const room = result.rows[0];
      if (!room) throw new BaldaError(404, "Комната не найдена.");
      if (String(room.owner_id) !== user.id) throw new BaldaError(403, "Начать игру может только создатель комнаты.");
      if (room.status !== "waiting") throw new BaldaError(409, "Эта партия уже запущена.");
      const members = await client.query(
        "SELECT telegram_id::TEXT AS id, display_name FROM balda_room_players WHERE room_id = $1 ORDER BY joined_at ASC, telegram_id ASC FOR UPDATE",
        [roomId]
      );
      if (members.rows.length !== 2) throw new BaldaError(409, "Для начала партии нужны ровно 2 игрока.");
      const stake = BigInt(String(room.stake));
      for (const member of members.rows) {
        const charged = await client.query(
          "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() " +
          "WHERE telegram_id = $2::BIGINT AND balance >= $1::BIGINT RETURNING balance::TEXT AS balance",
          [stake.toString(), String(member.id)]
        );
        if (!charged.rows.length) throw new BaldaError(400, "У игрока «" + String(member.display_name || "Игрок") + "» недостаточно AC. Ставка не списана ни у кого.");
      }
      const players = members.rows.map(member => ({
        id: String(member.id), name: String(member.display_name || "Игрок"), score: 0
      }));
      const game = {
        status: "playing", board: blankBoard(), players,
        currentPlayerIndex: 0, currentPlayerId: players[0].id,
        moves: 0, usedWords: [], history: [], lastMove: null, passStreak: 0,
        pot: (stake * 2n).toString(), winnerId: null, winnerName: null, draw: false,
        payout: "0", commission: "0", settled: false,
        message: "Партия началась! Добавь одну букву рядом с уже заполненной клеткой и составь новое слово.",
        startedAt: Date.now(), updatedAt: Date.now()
      };
      await client.query(
        "INSERT INTO balda_games (room_id, game_state) VALUES ($1, $2::JSONB) " +
        "ON CONFLICT (room_id) DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = NOW()",
        [roomId, JSON.stringify(game)]
      );
      await client.query("UPDATE balda_rooms SET status = 'playing', updated_at = NOW() WHERE id = $1", [roomId]);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (client && open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось начать партию." });
    } finally { client?.release(); }
  });

  router.post("/game/state", async (req, res) => {
    try {
      const user = authenticatedUser(req, verifyTelegram);
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new BaldaError(400, "Номер комнаты указан неверно.");
      await assertRoomMember(pool, roomId, user.id);
      const result = await pool.query("SELECT game_state FROM balda_games WHERE room_id = $1", [roomId]);
      if (!result.rows.length) return res.json({ ok: true, game: null });
      return res.json({ ok: true, game: publicGame(result.rows[0].game_state, user.id) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось обновить игру." });
    }
  });

  router.post("/game/move", async (req, res) => {
    let client;
    let open = false;
    try {
      const user = authenticatedUser(req, verifyTelegram);
      const roomId = parseRoomId(req.body?.roomId);
      const cell = Number(req.body?.cell);
      const letter = NORMALIZE(req.body?.letter);
      if (!roomId) throw new BaldaError(400, "Номер комнаты указан неверно.");
      if (!Number.isInteger(cell) || cell < 0 || cell >= 25) throw new BaldaError(400, "Выбери клетку на поле.");
      if (letter.length !== 1 || !ALPHABET.includes(letter)) throw new BaldaError(400, "Выбери одну русскую букву.");
      client = await pool.connect();
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query("SELECT id, stake::TEXT AS stake, status FROM balda_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new BaldaError(404, "Комната не найдена.");
      if (room.status !== "playing") throw new BaldaError(409, "Партия уже завершена.");
      await assertRoomMember(client, roomId, user.id);
      const gameResult = await client.query("SELECT game_state FROM balda_games WHERE room_id = $1 FOR UPDATE", [roomId]);
      const game = gameResult.rows[0]?.game_state;
      if (!game || game.status !== "playing" || game.settled) throw new BaldaError(409, "Партия уже завершена.");
      if (String(game.currentPlayerId) !== user.id) throw new BaldaError(403, "Сейчас ход соперника.");
      if (game.board[cell]) throw new BaldaError(400, "Эта клетка уже занята.");
      if (!isAdjacent(game.board, cell)) throw new BaldaError(400, "Добавлять букву можно только рядом с уже заполненной клеткой.");

      const nextBoard = game.board.slice();
      nextBoard[cell] = letter;
      const words = moveWordsFor(nextBoard, cell);
      if (!words.length) throw new BaldaError(400, "Эта буква не образует слово. Попробуй другую клетку или букву.");
      const repeated = words.find(word => game.usedWords.includes(word));
      if (repeated) throw new BaldaError(400, "Слово «" + repeated + "» уже использовали. Составь новое слово.");
      const invalid = words.find(word => !WORDS.has(word));
      if (invalid) throw new BaldaError(400, "«" + invalid + "» нет в игровом словаре. Выбери другую букву или клетку.");
      const player = game.players.find(item => String(item.id) === user.id);
      if (!player) throw new BaldaError(403, "Игрок не найден в партии.");
      const points = words.reduce((sum, word) => sum + word.length, 0);
      player.score = Number(player.score || 0) + points;
      game.board = nextBoard;
      game.usedWords.push(...words);
      game.moves = Number(game.moves || 0) + 1;
      game.passStreak = 0;
      game.lastMove = {
        playerId: user.id, playerName: player.name, letter, cell, words, points, at: Date.now()
      };
      game.history = [...(game.history || []), game.lastMove].slice(-40);
      game.currentPlayerIndex = (Number(game.currentPlayerIndex) + 1) % 2;
      game.currentPlayerId = game.players[game.currentPlayerIndex].id;
      game.message = player.name + " составил: " + words.join(" · ") + " (+" + points + " очков).";
      game.updatedAt = Date.now();

      if (game.board.every(Boolean)) {
        await settleGame(client, roomId, room, game);
      }
      await client.query(
        "UPDATE balda_games SET game_state = $2::JSONB, updated_at = NOW() WHERE room_id = $1",
        [roomId, JSON.stringify(game)]
      );
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (client && open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось сделать ход." });
    } finally { client?.release(); }
  });

  router.post("/game/pass", async (req, res) => {
    let client;
    let open = false;
    try {
      const user = authenticatedUser(req, verifyTelegram);
      const roomId = parseRoomId(req.body?.roomId);
      if (!roomId) throw new BaldaError(400, "Номер комнаты указан неверно.");
      client = await pool.connect();
      await client.query("BEGIN"); open = true;
      const roomResult = await client.query("SELECT id, stake::TEXT AS stake, status FROM balda_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new BaldaError(404, "Комната не найдена.");
      if (room.status !== "playing") throw new BaldaError(409, "Партия уже завершена.");
      await assertRoomMember(client, roomId, user.id);
      const gameResult = await client.query("SELECT game_state FROM balda_games WHERE room_id = $1 FOR UPDATE", [roomId]);
      const game = gameResult.rows[0]?.game_state;
      if (!game || game.status !== "playing" || game.settled) throw new BaldaError(409, "Партия уже завершена.");
      if (String(game.currentPlayerId) !== user.id) throw new BaldaError(403, "Сейчас ход соперника.");
      if (hasLegalMove(game.board, game.usedWords)) throw new BaldaError(400, "У тебя ещё есть допустимый ход — составь слово, чтобы не пропускать.");
      game.passStreak = Number(game.passStreak || 0) + 1;
      const passingPlayer = game.players.find(item => String(item.id) === user.id);
      game.history = [...(game.history || []), {
        playerId: user.id, playerName: passingPlayer?.name || user.name,
        pass: true, points: 0, at: Date.now()
      }].slice(-40);
      game.currentPlayerIndex = (Number(game.currentPlayerIndex) + 1) % 2;
      game.currentPlayerId = game.players[game.currentPlayerIndex].id;
      game.message = (passingPlayer?.name || user.name) + " пропустил ход: допустимых слов не осталось.";
      game.updatedAt = Date.now();
      if (game.passStreak >= 2) await settleGame(client, roomId, room, game);
      await client.query("UPDATE balda_games SET game_state = $2::JSONB, updated_at = NOW() WHERE room_id = $1", [roomId, JSON.stringify(game)]);
      await client.query("COMMIT"); open = false;
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      if (client && open) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось пропустить ход." });
    } finally { client?.release(); }
  });

  return router;
}
