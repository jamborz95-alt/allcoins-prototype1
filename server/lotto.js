import express from "express";
import crypto from "node:crypto";

const STAKES = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 102400, 204800, 409600, 819200, 1000000];
const ROOM_WINDOW_SECONDS = 180;
const DRAW_INTERVAL_SECONDS = 3;
const router = express.Router();

export function createLottoRouter(options) {
  const pool = options.pool;
  const verifyTelegram = options.verifyTelegram;
  let schedulerTimer = null;
  let schedulerBusy = false;

  function fail(res, status, error) {
    return res.status(status).json({ ok: false, error: error });
  }

  function validId(value) {
    return value != null && /^\d+$/.test(String(value));
  }

  function randomInt(max) {
    return crypto.randomInt(0, max);
  }

  function shuffled(values) {
    const result = values.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function makeTicketGrid() {
    let rows = null;
    for (let attempt = 0; attempt < 300 && !rows; attempt++) {
      const candidate = [[], [], []];
      const counts = Array(9).fill(0);
      const first = shuffled(Array.from({ length: 9 }, (_, i) => i)).slice(0, 5);
      const secondCandidates = shuffled(Array.from({ length: 9 }, (_, i) => i))
        .filter(col => counts[col] < 3);
      const second = [];
      for (const col of secondCandidates) {
        if (second.length >= 5) break;
        second.push(col);
      }
      first.forEach(col => { counts[col]++; });
      second.forEach(col => { counts[col]++; });
      const missing = [];
      for (let col = 0; col < 9; col++) {
        if (counts[col] === 0) missing.push(col);
      }
      if (missing.length > 5 || missing.some(col => counts[col] >= 3)) continue;
      const third = missing.slice();
      const thirdCandidates = shuffled(Array.from({ length: 9 }, (_, i) => i))
        .filter(col => !third.includes(col) && counts[col] < 3);
      while (third.length < 5 && thirdCandidates.length) third.push(thirdCandidates.shift());
      if (third.length !== 5) continue;
      third.forEach(col => { counts[col]++; });
      if (counts.some(count => count < 1 || count > 3)) continue;
      candidate[0] = first.slice();
      candidate[1] = second.slice();
      candidate[2] = third.slice();
      if (candidate.some(row => row.length !== 5)) continue;
      rows = candidate;
    }

    if (!rows) {
      // Deterministic valid fallback: each row has five columns and every column is used.
      rows = [[0, 1, 2, 3, 4], [4, 5, 6, 7, 8], [0, 1, 2, 5, 8]];
    }

    const grid = Array.from({ length: 3 }, () => Array(9).fill(null));
    const byColumn = Array.from({ length: 9 }, () => []);
    for (let r = 0; r < 3; r++) {
      for (const col of rows[r]) byColumn[col].push(r);
    }

    for (let col = 0; col < 9; col++) {
      const low = col === 0 ? 1 : col * 10;
      const high = col === 8 ? 90 : col * 10 + 9;
      const values = shuffled(Array.from({ length: high - low + 1 }, (_, i) => low + i))
        .slice(0, byColumn[col].length)
        .sort((a, b) => a - b);
      byColumn[col].sort((a, b) => a - b);
      byColumn[col].forEach((rowIndex, index) => {
        grid[rowIndex][col] = values[index];
      });
    }
    return grid;
  }

  function flattenTicket(grid) {
    return (Array.isArray(grid) ? grid : []).flat().filter(value => Number.isInteger(value));
  }

  async function ensureLobbyRooms() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(71582931)");
      await client.query(
        "INSERT INTO lotto_rooms (stake, status, created_at, buy_until) " +
        "SELECT s.stake, 'waiting', NOW(), NOW() + ($2::integer * INTERVAL '1 second') " +
        "FROM unnest($1::bigint[]) AS s(stake) " +
        "WHERE NOT EXISTS (SELECT 1 FROM lotto_rooms r WHERE r.stake = s.stake AND r.status = 'waiting' AND r.buy_until > NOW()) " +
        "ON CONFLICT DO NOTHING",
        [STAKES.map(String), ROOM_WINDOW_SECONDS]
      );
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function settleWinner(client, room, winnerTicket) {
    const roomId = String(room.id);
    const winnerId = String(winnerTicket.telegram_id);
    const prize = Math.max(0, Number(room.pot) || 0);
    if (prize > 0) {
      const credited = await client.query(
        "UPDATE players SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING balance",
        [prize, winnerId]
      );
      if (!credited.rowCount) throw new Error("Не найден баланс победителя лото");
    }
    await client.query(
      "UPDATE lotto_rooms SET status = 'finished', winner_telegram_id = $1, winner_ticket_id = $2, prize = $3, finished_at = NOW(), result_note = $4 WHERE id = $5 AND status = 'playing'",
      [winnerId, String(winnerTicket.id), prize, "Победа: все числа билета отмечены", roomId]
    );
  }

  async function findCompletedTicket(client, roomId) {
    const result = await client.query(
      "SELECT id, telegram_id, numbers, marked_numbers FROM lotto_tickets WHERE room_id = $1 ORDER BY id ASC",
      [String(roomId)]
    );
    for (const ticket of result.rows) {
      const required = flattenTicket(ticket.numbers);
      const marked = new Set((Array.isArray(ticket.marked_numbers) ? ticket.marked_numbers : []).map(Number));
      if (required.length > 0 && required.every(number => marked.has(number))) return ticket;
    }
    return null;
  }

  async function refundRoom(client, room) {
    await client.query(
      "UPDATE players p SET balance = p.balance + refund.amount, updated_at = NOW() " +
      "FROM (SELECT telegram_id, COUNT(*)::bigint * $2::bigint AS amount FROM lotto_tickets WHERE room_id = $1 GROUP BY telegram_id) refund " +
      "WHERE p.telegram_id = refund.telegram_id",
      [String(room.id), String(room.stake)]
    );
    await client.query(
      "UPDATE lotto_rooms SET status = 'finished', prize = 0, finished_at = NOW(), result_note = $1 WHERE id = $2 AND status = 'playing'",
      ["Все 90 чисел выпали, полный билет не собран. Ставки возвращены.", String(room.id)]
    );
  }

  async function runScheduler() {
    if (schedulerBusy) return;
    schedulerBusy = true;
    let client = null;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(71582932)");

      const expired = await client.query(
        "SELECT r.* FROM lotto_rooms r WHERE r.status = 'waiting' AND r.buy_until <= NOW() ORDER BY r.stake ASC FOR UPDATE SKIP LOCKED"
      );
      for (const room of expired.rows) {
        const ticketCountResult = await client.query(
          "SELECT COUNT(*)::integer AS ticket_count FROM lotto_tickets WHERE room_id = $1",
          [String(room.id)]
        );
        const ticketCount = Number(ticketCountResult.rows[0].ticket_count) || 0;
        if (ticketCount === 0) {
          await client.query(
            "UPDATE lotto_rooms SET status = 'finished', finished_at = NOW(), result_note = $1 WHERE id = $2",
            ["В комнате никто не купил билет.", String(room.id)]
          );
        } else {
          await client.query(
            "UPDATE lotto_rooms SET status = 'playing', started_at = NOW(), next_draw_at = NOW() + ($1::integer * INTERVAL '1 second'), drawn_numbers = '[]'::jsonb WHERE id = $2 AND status = 'waiting'",
            [DRAW_INTERVAL_SECONDS, String(room.id)]
          );
          await client.query(
            "UPDATE lotto_room_players SET auto_play = (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '15 seconds') WHERE room_id = $1",
            [String(room.id)]
          );
        }
      }

      const dueRooms = await client.query(
        "SELECT r.* FROM lotto_rooms r WHERE r.status = 'playing' AND r.next_draw_at <= NOW() ORDER BY r.next_draw_at ASC LIMIT 25 FOR UPDATE SKIP LOCKED"
      );
      for (const room of dueRooms.rows) {
        const alreadyDrawn = Array.isArray(room.drawn_numbers) ? room.drawn_numbers.map(Number) : [];
        if (alreadyDrawn.length >= 90) {
          await refundRoom(client, room);
          continue;
        }
        const available = Array.from({ length: 90 }, (_, i) => i + 1).filter(number => !alreadyDrawn.includes(number));
        const drawnNumber = available[randomInt(available.length)];
        const drawn = alreadyDrawn.concat(drawnNumber);

        const tickets = await client.query(
          "SELECT t.id, t.telegram_id, t.numbers, t.marked_numbers, p.auto_play " +
          "FROM lotto_tickets t JOIN lotto_room_players p ON p.room_id = t.room_id AND p.telegram_id = t.telegram_id " +
          "WHERE t.room_id = $1 ORDER BY t.id ASC",
          [String(room.id)]
        );
        for (const ticket of tickets.rows) {
          if (ticket.auto_play) {
            const ticketNumbers = flattenTicket(ticket.numbers);
            const markedSet = new Set((Array.isArray(ticket.marked_numbers) ? ticket.marked_numbers : []).map(Number));
            for (const number of ticketNumbers) if (drawn.includes(number)) markedSet.add(number);
            await client.query(
              "UPDATE lotto_tickets SET marked_numbers = $1::jsonb WHERE id = $2",
              [JSON.stringify(Array.from(markedSet)), String(ticket.id)]
            );
          }
        }

        const updatedRoom = { ...room, drawn_numbers: drawn };
        const winner = await findCompletedTicket(client, room.id);
        if (winner) {
          await client.query("UPDATE lotto_rooms SET drawn_numbers = $1::jsonb WHERE id = $2", [JSON.stringify(drawn), String(room.id)]);
          await settleWinner(client, updatedRoom, winner);
          continue;
        }
        await client.query(
          "UPDATE lotto_rooms SET drawn_numbers = $1::jsonb, next_draw_at = NOW() + ($2::integer * INTERVAL '1 second') WHERE id = $3 AND status = 'playing'",
          [JSON.stringify(drawn), DRAW_INTERVAL_SECONDS, String(room.id)]
        );
        if (drawn.length >= 90) {
          await refundRoom(client, { ...room, drawn_numbers: drawn });
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch {} }
      console.error("Lotto scheduler error:", error.message);
    } finally {
      if (client) client.release();
      schedulerBusy = false;
    }
    try { await ensureLobbyRooms(); } catch (error) {
      console.error("Lotto lobby refresh error:", error.message);
    }
  }

  router.initialize = async function initialize() {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS lotto_rooms (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, " +
      "stake BIGINT NOT NULL CHECK (stake > 0), " +
      "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')), " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "buy_until TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ, next_draw_at TIMESTAMPTZ, " +
      "drawn_numbers JSONB NOT NULL DEFAULT '[]'::jsonb, pot BIGINT NOT NULL DEFAULT 0, " +
      "winner_telegram_id BIGINT, winner_ticket_id BIGINT, prize BIGINT NOT NULL DEFAULT 0, " +
      "finished_at TIMESTAMPTZ, result_note TEXT)"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS lotto_room_players (" +
      "room_id BIGINT NOT NULL REFERENCES lotto_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, display_name TEXT, joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "last_seen_at TIMESTAMPTZ, auto_play BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS lotto_tickets (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, " +
      "room_id BIGINT NOT NULL REFERENCES lotto_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, ticket_no INTEGER NOT NULL CHECK (ticket_no BETWEEN 1 AND 3), " +
      "numbers JSONB NOT NULL, marked_numbers JSONB NOT NULL DEFAULT '[]'::jsonb, bought_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "UNIQUE (room_id, telegram_id, ticket_no))"
    );
    await pool.query("CREATE INDEX IF NOT EXISTS lotto_rooms_status_stake_idx ON lotto_rooms(status, stake, buy_until)");
    await pool.query("CREATE INDEX IF NOT EXISTS lotto_tickets_room_idx ON lotto_tickets(room_id)");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS lotto_one_waiting_per_stake_idx ON lotto_rooms(stake) WHERE status = 'waiting'");
    await ensureLobbyRooms();
    if (!schedulerTimer) {
      schedulerTimer = setInterval(() => { runScheduler().catch(error => console.error("Lotto scheduler failed:", error.message)); }, 1000);
      if (typeof schedulerTimer.unref === "function") schedulerTimer.unref();
    }
  };

  router.post("/rooms/list", async (req, res) => {
    try {
      const user = verifyTelegram(req.body && req.body.initData);
      if (!user || !user.id) return fail(res, 401, "Открой ALLCOINS через Telegram.");
      await ensureLobbyRooms();
      const result = await pool.query(
        "SELECT r.id, r.stake, r.status, r.created_at, r.buy_until, r.started_at, r.next_draw_at, " +
        "r.drawn_numbers, r.pot, r.prize, r.winner_telegram_id, r.result_note, " +
        "(SELECT COUNT(*)::integer FROM lotto_room_players p WHERE p.room_id = r.id) AS players_count, " +
        "(SELECT COUNT(*)::integer FROM lotto_tickets t WHERE t.room_id = r.id) AS ticket_count, " +
        "(SELECT COUNT(*)::integer FROM lotto_tickets t WHERE t.room_id = r.id AND t.telegram_id = $1) AS my_tickets " +
        "FROM lotto_rooms r WHERE (r.status = 'waiting' AND r.buy_until > NOW()) " +
        "OR (r.status IN ('playing','finished') AND EXISTS (SELECT 1 FROM lotto_room_players p WHERE p.room_id = r.id AND p.telegram_id = $1)) " +
        "ORDER BY CASE r.status WHEN 'waiting' THEN 0 WHEN 'playing' THEN 1 ELSE 2 END, r.stake ASC, r.created_at DESC LIMIT 100",
        [String(user.id)]
      );
      const playerResult = await pool.query("INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance", [String(user.id)]);
      return res.json({
        ok: true,
        rooms: result.rows.map(room => ({
          id: String(room.id),
          stake: Number(room.stake),
          status: room.status,
          createdAt: room.created_at,
          buyUntil: room.buy_until,
          startedAt: room.started_at,
          nextDrawAt: room.next_draw_at,
          drawnCount: Array.isArray(room.drawn_numbers) ? room.drawn_numbers.length : 0,
          pot: Number(room.pot) || 0,
          prize: Number(room.prize) || 0,
          resultNote: room.result_note || "",
          playersCount: Number(room.players_count) || 0,
          ticketCount: Number(room.ticket_count) || 0,
          myTickets: Number(room.my_tickets) || 0
        })),
        balance: playerResult.rows.length ? Number(playerResult.rows[0].balance) : null,
        roomWindowSeconds: ROOM_WINDOW_SECONDS
      });
    } catch (error) {
      console.error("Lotto rooms list error:", error.message);
      return fail(res, 500, "Не удалось обновить комнаты лото.");
    }
  });

  router.post("/ticket/buy", async (req, res) => {
    const client = await pool.connect();
    try {
      const user = verifyTelegram(req.body && req.body.initData);
      if (!user || !user.id) return fail(res, 401, "Открой ALLCOINS через Telegram.");
      if (!validId(req.body && req.body.roomId)) return fail(res, 400, "Неверный номер комнаты.");
      await client.query("BEGIN");
      const roomResult = await client.query("SELECT * FROM lotto_rooms WHERE id = $1 FOR UPDATE", [String(req.body.roomId)]);
      if (!roomResult.rows.length) {
        await client.query("ROLLBACK");
        return fail(res, 404, "Комната лото не найдена.");
      }
      const room = roomResult.rows[0];
      if (room.status !== "waiting" || new Date(room.buy_until).getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Продажа билетов завершена. Выбери следующую комнату.");
      }
      await client.query("INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING", [String(user.id)]);
      const ownedResult = await client.query(
        "SELECT COUNT(*)::integer AS count FROM lotto_tickets WHERE room_id = $1 AND telegram_id = $2",
        [String(room.id), String(user.id)]
      );
      const owned = Number(ownedResult.rows[0].count) || 0;
      if (owned >= 3) {
        await client.query("ROLLBACK");
        return fail(res, 400, "В одной комнате можно купить не больше 3 билетов.");
      }
      const debited = await client.query(
        "UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2 AND balance >= $1 RETURNING balance",
        [String(room.stake), String(user.id)]
      );
      if (!debited.rowCount) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Недостаточно AC для покупки билета.");
      }
      const ticketNo = owned + 1;
      const grid = makeTicketGrid();
      const ticketResult = await client.query(
        "INSERT INTO lotto_tickets (room_id, telegram_id, ticket_no, numbers, marked_numbers) VALUES ($1, $2, $3, $4::jsonb, '[]'::jsonb) RETURNING id, ticket_no, numbers, marked_numbers",
        [String(room.id), String(user.id), ticketNo, JSON.stringify(grid)]
      );
      await client.query(
        "INSERT INTO lotto_room_players (room_id, telegram_id, display_name, last_seen_at, auto_play) " +
        "VALUES ($1, $2, $3, NOW(), FALSE) ON CONFLICT (room_id, telegram_id) DO UPDATE SET display_name = EXCLUDED.display_name, last_seen_at = NOW()",
        [String(room.id), String(user.id), user.first_name || user.username || "Игрок"]
      );
      await client.query("UPDATE lotto_rooms SET pot = pot + $1 WHERE id = $2", [String(room.stake), String(room.id)]);
      await client.query("COMMIT");
      return res.json({
        ok: true,
        balance: Number(debited.rows[0].balance),
        roomId: String(room.id),
        ticket: {
          id: String(ticketResult.rows[0].id),
          ticketNo: Number(ticketResult.rows[0].ticket_no),
          numbers: ticketResult.rows[0].numbers,
          markedNumbers: ticketResult.rows[0].marked_numbers
        },
        ticketsOwned: ticketNo,
        stake: Number(room.stake),
        pot: Number(room.pot) + Number(room.stake)
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("Lotto ticket purchase error:", error.message);
      return fail(res, 500, "Не удалось купить билет.");
    } finally {
      client.release();
    }
  });

  router.post("/room/state", async (req, res) => {
    try {
      const user = verifyTelegram(req.body && req.body.initData);
      if (!user || !user.id) return fail(res, 401, "Открой ALLCOINS через Telegram.");
      if (!validId(req.body && req.body.roomId)) return fail(res, 400, "Неверный номер комнаты.");
      const roomResult = await pool.query(
        "SELECT r.* FROM lotto_rooms r WHERE r.id = $1",
        [String(req.body.roomId)]
      );
      if (!roomResult.rows.length) return fail(res, 404, "Комната лото не найдена.");
      const room = roomResult.rows[0];
      const visible = req.body && req.body.visible === true;
      if (visible) {
        await pool.query(
          "UPDATE lotto_room_players SET last_seen_at = NOW() WHERE room_id = $1 AND telegram_id = $2",
          [String(room.id), String(user.id)]
        );
      }
      const playerResult = await pool.query(
        "SELECT auto_play FROM lotto_room_players WHERE room_id = $1 AND telegram_id = $2",
        [String(room.id), String(user.id)]
      );
      const ticketsResult = await pool.query(
        "SELECT id, ticket_no, numbers, marked_numbers FROM lotto_tickets WHERE room_id = $1 AND telegram_id = $2 ORDER BY ticket_no ASC",
        [String(room.id), String(user.id)]
      );
      const winnerNameResult = room.winner_telegram_id == null ? { rows: [] } : await pool.query(
        "SELECT display_name FROM lotto_room_players WHERE room_id = $1 AND telegram_id = $2",
        [String(room.id), String(room.winner_telegram_id)]
      );
      const playerResultBalance = await pool.query("INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance", [String(user.id)]);
      const countResult = await pool.query(
        "SELECT COUNT(DISTINCT telegram_id)::integer AS players_count, COUNT(*)::integer AS ticket_count FROM lotto_tickets WHERE room_id = $1",
        [String(room.id)]
      );
      return res.json({
        ok: true,
        balance: playerResultBalance.rows.length ? Number(playerResultBalance.rows[0].balance) : null,
        room: {
          id: String(room.id),
          stake: Number(room.stake),
          status: room.status,
          createdAt: room.created_at,
          buyUntil: room.buy_until,
          startedAt: room.started_at,
          nextDrawAt: room.next_draw_at,
          drawnNumbers: Array.isArray(room.drawn_numbers) ? room.drawn_numbers.map(Number) : [],
          currentNumber: Array.isArray(room.drawn_numbers) && room.drawn_numbers.length ? Number(room.drawn_numbers[room.drawn_numbers.length - 1]) : null,
          pot: Number(room.pot) || 0,
          prize: Number(room.prize) || 0,
          winnerIsMe: room.winner_telegram_id != null && String(room.winner_telegram_id) === String(user.id),
          winnerName: winnerNameResult.rows.length ? winnerNameResult.rows[0].display_name : null,
          resultNote: room.result_note || "",
          playersCount: Number(countResult.rows[0].players_count) || 0,
          ticketCount: Number(countResult.rows[0].ticket_count) || 0,
          autoPlay: playerResult.rows.length ? playerResult.rows[0].auto_play === true : false
        },
        tickets: ticketsResult.rows.map(ticket => ({
          id: String(ticket.id),
          ticketNo: Number(ticket.ticket_no),
          numbers: ticket.numbers,
          markedNumbers: Array.isArray(ticket.marked_numbers) ? ticket.marked_numbers.map(Number) : []
        }))
      });
    } catch (error) {
      console.error("Lotto room state error:", error.message);
      return fail(res, 500, "Не удалось загрузить игровое поле лото.");
    }
  });

  router.post("/number/mark", async (req, res) => {
    const client = await pool.connect();
    try {
      const user = verifyTelegram(req.body && req.body.initData);
      if (!user || !user.id) return fail(res, 401, "Открой ALLCOINS через Telegram.");
      if (!validId(req.body && req.body.roomId) || !validId(req.body && req.body.ticketId)) {
        return fail(res, 400, "Неверная комната или билет.");
      }
      const number = Number(req.body.number);
      if (!Number.isInteger(number) || number < 1 || number > 90) {
        return fail(res, 400, "Неверное число.");
      }
      await client.query("BEGIN");
      const roomResult = await client.query("SELECT * FROM lotto_rooms WHERE id = $1 FOR UPDATE", [String(req.body.roomId)]);
      if (!roomResult.rows.length) {
        await client.query("ROLLBACK");
        return fail(res, 404, "Комната лото не найдена.");
      }
      const room = roomResult.rows[0];
      if (room.status !== "playing") {
        await client.query("ROLLBACK");
        return fail(res, 400, "Сейчас билеты не принимают числа.");
      }
      const drawn = Array.isArray(room.drawn_numbers) ? room.drawn_numbers.map(Number) : [];
      if (!drawn.includes(number)) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Это число ещё не выпало.");
      }
      const ticketResult = await client.query(
        "SELECT * FROM lotto_tickets WHERE id = $1 AND room_id = $2 AND telegram_id = $3 FOR UPDATE",
        [String(req.body.ticketId), String(room.id), String(user.id)]
      );
      if (!ticketResult.rows.length) {
        await client.query("ROLLBACK");
        return fail(res, 403, "Этот билет не принадлежит тебе.");
      }
      const ticket = ticketResult.rows[0];
      const values = flattenTicket(ticket.numbers);
      if (!values.includes(number)) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Этого числа нет на выбранном билете.");
      }
      const marks = new Set((Array.isArray(ticket.marked_numbers) ? ticket.marked_numbers : []).map(Number));
      marks.add(number);
      await client.query(
        "UPDATE lotto_tickets SET marked_numbers = $1::jsonb WHERE id = $2",
        [JSON.stringify(Array.from(marks)), String(ticket.id)]
      );
      const winner = await findCompletedTicket(client, room.id);
      if (winner) await settleWinner(client, room, winner);
      await client.query("COMMIT");
      return res.json({
        ok: true,
        markedNumbers: Array.from(marks),
        won: Boolean(winner && String(winner.telegram_id) === String(user.id)),
        status: winner ? "finished" : "playing"
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("Lotto mark number error:", error.message);
      return fail(res, 500, "Не удалось отметить число.");
    } finally {
      client.release();
    }
  });

  return router;
}
