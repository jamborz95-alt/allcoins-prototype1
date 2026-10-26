import express from "express";

const ENTRY_FEE = 1000;
const COMMISSION_PERCENT = 5;
const MAX_SCORE = 10000000;
const SETTLEMENT_LOCK_KEY = "4204261026";

function currentWeekStart(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function safeDisplayName(user) {
  const fullName = [user && user.first_name, user && user.last_name]
    .filter(Boolean).join(" ").trim();
  return String(fullName || (user && user.username) || "Игрок").slice(0, 64);
}

function allocationPercentages(count) {
  if (count === 1) return [100];
  if (count === 2) return [60, 40];
  return [50, 30, 20];
}

function allocationAmounts(payoutPool, count) {
  if (count < 1) return [];
  const total = Math.max(0, Math.floor(Number(payoutPool) || 0));
  const percentages = allocationPercentages(count);
  const amounts = percentages.map(percent => Math.floor(total * percent / 100));
  const paid = amounts.reduce((sum, amount) => sum + amount, 0);
  if (amounts.length) amounts[0] += total - paid;
  return amounts;
}

function prizeDistribution(count) {
  const percentages = allocationPercentages(count > 0 ? count : 3);
  return percentages.map((percent, index) => ({
    rank: index + 1,
    percent
  }));
}

function requireTelegram(req, res, verifyTelegram) {
  const user = verifyTelegram(req.body && req.body.initData);
  if (!user) {
    res.status(401).json({
      ok: false,
      error: "Не удалось проверить Telegram-профиль. Открой Block Blast через ALLCOINS."
    });
    return null;
  }
  return user;
}

async function settleExpiredTournaments(pool, recordGameCommission) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query("SELECT pg_advisory_xact_lock(" + SETTLEMENT_LOCK_KEY + "::bigint)");

    const thisWeek = currentWeekStart();
    const oldWeeks = await client.query(
      "SELECT DISTINCT e.week_start::TEXT AS week_start " +
      "FROM block_blast_tournament_entries e " +
      "LEFT JOIN block_blast_tournament_settlements s ON s.week_start = e.week_start " +
      "WHERE e.week_start < $1::DATE AND s.week_start IS NULL " +
      "ORDER BY e.week_start ASC LIMIT 100",
      [thisWeek]
    );

    for (const weekRow of oldWeeks.rows) {
      const week = String(weekRow.week_start);
      const existing = await client.query(
        "SELECT 1 FROM block_blast_tournament_settlements WHERE week_start = $1::DATE",
        [week]
      );
      if (existing.rows.length) continue;

      const potResult = await client.query(
        "SELECT COUNT(*)::INTEGER AS entry_count, " +
        "COALESCE(SUM(entry_fee), 0)::TEXT AS gross_pot " +
        "FROM block_blast_tournament_entries WHERE week_start = $1::DATE",
        [week]
      );
      const entryCount = Number(potResult.rows[0] && potResult.rows[0].entry_count || 0);
      const grossPot = Math.max(0, Number(potResult.rows[0] && potResult.rows[0].gross_pot || 0));
      const ranked = await client.query(
        "SELECT s.telegram_id::TEXT AS telegram_id, s.best_score, s.display_name, " +
        "s.username, s.updated_at " +
        "FROM block_blast_scores s " +
        "JOIN block_blast_tournament_entries e " +
        "ON e.week_start = s.week_start AND e.telegram_id = s.telegram_id " +
        "WHERE s.week_start = $1::DATE " +
        "ORDER BY s.best_score DESC, s.updated_at ASC, e.created_at ASC, s.telegram_id ASC",
        [week]
      );

      let commissionAmount = 0;
      let payoutPool = grossPot;
      const winners = [];
      if (grossPot > 0 && entryCount > 0 && ranked.rows.length > 0) {
        const commission = await recordGameCommission(client, {
          game: "block-blast",
          eventKey: "block-blast:week:" + week,
          grossAmount: grossPot
        });
        commissionAmount = Math.min(grossPot, Math.max(0, Math.floor(Number(commission.amount) || 0)));
        payoutPool = Math.max(0, grossPot - commissionAmount);
        const amounts = allocationAmounts(payoutPool, entryCount);
        const winnerCount = Math.min(amounts.length, ranked.rows.length);
        for (let index = 0; index < winnerCount; index++) {
          const row = ranked.rows[index];
          const amount = Math.max(0, Math.floor(Number(amounts[index]) || 0));
          if (amount > 0) {
            const credit = await client.query(
              "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() " +
              "WHERE telegram_id = $2::BIGINT RETURNING balance",
              [String(amount), String(row.telegram_id)]
            );
            if (!credit.rows.length) throw new Error("Не удалось начислить приз Block Blast победителю");
          }
          winners.push({
            telegramId: String(row.telegram_id),
            displayName: String(row.display_name || "Игрок"),
            score: Number(row.best_score) || 0,
            rank: index + 1,
            amount
          });
        }
      }

      await client.query(
        "INSERT INTO block_blast_tournament_settlements " +
        "(week_start, gross_pot, commission_amount, payout_pool, entry_count, winners) " +
        "VALUES ($1::DATE, $2::BIGINT, $3::BIGINT, $4::BIGINT, $5, $6::JSONB) " +
        "ON CONFLICT (week_start) DO NOTHING",
        [week, String(grossPot), String(commissionAmount), String(payoutPool), entryCount, JSON.stringify(winners)]
      );
      console.log(
        "Block Blast tournament settled",
        week,
        "entries=" + entryCount,
        "gross=" + grossPot,
        "commission=" + commissionAmount,
        "paidWinners=" + winners.length
      );
    }
    await client.query("COMMIT");
    open = false;
  } catch (error) {
    if (open) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadLeaderboard(client, week) {
  const potResult = await client.query(
    "SELECT COUNT(*)::INTEGER AS entry_count, " +
    "COALESCE(SUM(entry_fee), 0)::TEXT AS gross_pot " +
    "FROM block_blast_tournament_entries WHERE week_start = $1::DATE",
    [week]
  );
  const entryCount = Number(potResult.rows[0] && potResult.rows[0].entry_count || 0);
  const grossPot = Math.max(0, Number(potResult.rows[0] && potResult.rows[0].gross_pot || 0));
  const commissionAmount = Math.floor(grossPot * COMMISSION_PERCENT / 100);
  const payoutPool = Math.max(0, grossPot - commissionAmount);
  const scores = await client.query(
    "SELECT s.telegram_id::TEXT AS telegram_id, s.best_score, s.display_name, " +
    "s.username, s.updated_at " +
    "FROM block_blast_scores s " +
    "JOIN block_blast_tournament_entries e " +
    "ON e.week_start = s.week_start AND e.telegram_id = s.telegram_id " +
    "WHERE s.week_start = $1::DATE " +
    "ORDER BY s.best_score DESC, s.updated_at ASC, e.created_at ASC, s.telegram_id ASC " +
    "LIMIT 50",
    [week]
  );
  const amounts = allocationAmounts(payoutPool, entryCount);
  const leaderboard = scores.rows.map((row, index) => ({
    rank: index + 1,
    displayName: String(row.display_name || "Игрок").slice(0, 64),
    username: row.username ? String(row.username).slice(0, 64) : null,
    score: Number(row.best_score) || 0,
    prizeEstimate: index < amounts.length ? amounts[index] : 0,
    updatedAt: row.updated_at
  }));
  const end = new Date(week + "T00:00:00.000Z");
  end.setUTCDate(end.getUTCDate() + 7);
  return {
    weekStart: week,
    weekEndsAt: end.toISOString(),
    entriesCount: entryCount,
    grossPot,
    commissionAmount,
    payoutPool,
    distribution: prizeDistribution(entryCount),
    leaderboard
  };
}

export function createBlockBlastRouter({ pool, verifyTelegram, recordGameCommission }) {
  const router = express.Router();
  let settlementTimer = null;

  async function finalizeExpired() {
    await settleExpiredTournaments(pool, recordGameCommission);
  }

  router.post("/status", async (req, res) => {
    const user = requireTelegram(req, res, verifyTelegram);
    if (!user) return;
    try {
      await finalizeExpired();
      const week = currentWeekStart();
      const client = await pool.connect();
      try {
        const telegramId = String(user.id);
        const entry = await client.query(
          "SELECT 1 FROM block_blast_tournament_entries WHERE week_start = $1::DATE AND telegram_id = $2::BIGINT",
          [week, telegramId]
        );
        const weekly = await client.query(
          "SELECT COALESCE(best_score, 0)::INTEGER AS best_score " +
          "FROM block_blast_scores WHERE week_start = $1::DATE AND telegram_id = $2::BIGINT",
          [week, telegramId]
        );
        const personal = await client.query(
          "SELECT COALESCE(MAX(best_score), 0)::INTEGER AS best_score " +
          "FROM block_blast_scores WHERE telegram_id = $1::BIGINT",
          [telegramId]
        );
        const board = await loadLeaderboard(client, week);
        res.json({
          ok: true,
          joined: entry.rows.length > 0,
          weeklyBest: Number(weekly.rows[0] && weekly.rows[0].best_score || 0),
          personalBest: Number(personal.rows[0] && personal.rows[0].best_score || 0),
          ...board
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Block Blast status error:", error.message || error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Не удалось загрузить турнирную таблицу." });
    }
  });

  router.post("/leaderboard", async (req, res) => {
    const user = requireTelegram(req, res, verifyTelegram);
    if (!user) return;
    try {
      await finalizeExpired();
      const client = await pool.connect();
      try {
        const board = await loadLeaderboard(client, currentWeekStart());
        res.json({ ok: true, ...board });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Block Blast leaderboard error:", error.message || error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Не удалось загрузить турнирную таблицу." });
    }
  });

  router.post("/enter", async (req, res) => {
    const user = requireTelegram(req, res, verifyTelegram);
    if (!user) return;
    if (req.body && req.body.entryFee != null && Number(req.body.entryFee) !== ENTRY_FEE) {
      return res.status(400).json({ ok: false, error: "Стоимость входа в турнир фиксирована: 1 000 AC." });
    }

    let client;
    let open = false;
    try {
      await finalizeExpired();
      client = await pool.connect();
      await client.query("BEGIN");
      open = true;
      const telegramId = String(user.id);
      const week = currentWeekStart();
      const displayName = safeDisplayName(user);
      const username = user.username ? String(user.username).slice(0, 64) : null;
      await client.query(
        "INSERT INTO players (telegram_id) VALUES ($1::BIGINT) ON CONFLICT (telegram_id) DO NOTHING",
        [telegramId]
      );
      const wallet = await client.query(
        "SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1::BIGINT FOR UPDATE",
        [telegramId]
      );
      if (!wallet.rows.length) throw new Error("Профиль игрока не найден.");
      const balance = Number(wallet.rows[0].balance || 0);
      const alreadyJoined = await client.query(
        "SELECT 1 FROM block_blast_tournament_entries WHERE week_start = $1::DATE AND telegram_id = $2::BIGINT",
        [week, telegramId]
      );
      if (alreadyJoined.rows.length) {
        await client.query("COMMIT");
        open = false;
        const board = await loadLeaderboard(client, week);
        return res.json({ ok: true, joined: true, alreadyJoined: true, balance, player: { balance }, ...board });
      }
      if (balance < ENTRY_FEE) {
        await client.query("ROLLBACK");
        open = false;
        return res.status(400).json({
          ok: false,
          error: "Недостаточно AC. Для входа требуется 1 000 AC.",
          balance
        });
      }
      const charged = await client.query(
        "UPDATE players SET balance = balance - $1::BIGINT, updated_at = NOW() " +
        "WHERE telegram_id = $2::BIGINT RETURNING balance::TEXT AS balance",
        [String(ENTRY_FEE), telegramId]
      );
      await client.query(
        "INSERT INTO block_blast_tournament_entries " +
        "(week_start, telegram_id, entry_fee, display_name, username) " +
        "VALUES ($1::DATE, $2::BIGINT, $3::BIGINT, $4, $5)",
        [week, telegramId, String(ENTRY_FEE), displayName, username]
      );
      await client.query(
        "INSERT INTO block_blast_scores " +
        "(week_start, telegram_id, best_score, display_name, username, updated_at) " +
        "VALUES ($1::DATE, $2::BIGINT, 0, $3, $4, NOW()) " +
        "ON CONFLICT (week_start, telegram_id) DO UPDATE " +
        "SET display_name = EXCLUDED.display_name, username = EXCLUDED.username",
        [week, telegramId, displayName, username]
      );
      await client.query("COMMIT");
      open = false;
      const newBalance = Number(charged.rows[0] && charged.rows[0].balance || 0);
      const board = await loadLeaderboard(client, week);
      return res.json({ ok: true, joined: true, alreadyJoined: false, balance: newBalance, player: { balance: newBalance }, ...board });
    } catch (error) {
      if (client && open) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      console.error("Block Blast entry error:", error.message || error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Не удалось оформить вход в турнир. Монеты не списаны." });
    } finally {
      if (client) client.release();
    }
  });

  router.post("/score", async (req, res) => {
    const user = requireTelegram(req, res, verifyTelegram);
    if (!user) return;
    const score = Number(req.body && req.body.score);
    if (!Number.isSafeInteger(score) || score < 0 || score > MAX_SCORE) {
      return res.status(400).json({ ok: false, error: "Недопустимый результат Block Blast." });
    }

    let client;
    let open = false;
    try {
      await finalizeExpired();
      client = await pool.connect();
      await client.query("BEGIN");
      open = true;
      const telegramId = String(user.id);
      const week = currentWeekStart();
      const member = await client.query(
        "SELECT display_name FROM block_blast_tournament_entries " +
        "WHERE week_start = $1::DATE AND telegram_id = $2::BIGINT FOR SHARE",
        [week, telegramId]
      );
      if (!member.rows.length) {
        await client.query("ROLLBACK");
        open = false;
        return res.status(403).json({ ok: false, error: "Сначала оплати вход в недельный турнир." });
      }

      const displayName = safeDisplayName(user);
      const username = user.username ? String(user.username).slice(0, 64) : null;
      const saved = await client.query(
        "INSERT INTO block_blast_scores " +
        "(week_start, telegram_id, best_score, display_name, username, updated_at) " +
        "VALUES ($1::DATE, $2::BIGINT, $3, $4, $5, NOW()) " +
        "ON CONFLICT (week_start, telegram_id) DO UPDATE SET " +
        "best_score = GREATEST(block_blast_scores.best_score, EXCLUDED.best_score), " +
        "display_name = CASE WHEN EXCLUDED.best_score > block_blast_scores.best_score THEN EXCLUDED.display_name ELSE block_blast_scores.display_name END, " +
        "username = CASE WHEN EXCLUDED.best_score > block_blast_scores.best_score THEN EXCLUDED.username ELSE block_blast_scores.username END, " +
        "updated_at = CASE WHEN EXCLUDED.best_score > block_blast_scores.best_score THEN NOW() ELSE block_blast_scores.updated_at END " +
        "RETURNING best_score",
        [week, telegramId, score, displayName, username]
      );
      const personal = await client.query(
        "SELECT COALESCE(MAX(best_score), 0)::INTEGER AS best_score " +
        "FROM block_blast_scores WHERE telegram_id = $1::BIGINT",
        [telegramId]
      );
      const board = await loadLeaderboard(client, week);
      await client.query("COMMIT");
      open = false;
      res.json({
        ok: true,
        weeklyBest: Number(saved.rows[0] && saved.rows[0].best_score || 0),
        personalBest: Number(personal.rows[0] && personal.rows[0].best_score || 0),
        ...board
      });
    } catch (error) {
      if (client && open) {
        try { await client.query("ROLLBACK"); } catch (_) {}
      }
      console.error("Block Blast score error:", error.message || error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Не удалось сохранить результат в турнирный рейтинг." });
    } finally {
      if (client) client.release();
    }
  });

  router.initialize = async function initialize() {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS block_blast_tournament_entries (" +
      "week_start DATE NOT NULL, " +
      "telegram_id BIGINT NOT NULL REFERENCES players(telegram_id), " +
      "entry_fee BIGINT NOT NULL DEFAULT 1000 CHECK (entry_fee = 1000), " +
      "display_name TEXT NOT NULL DEFAULT 'Игрок', " +
      "username TEXT, " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (week_start, telegram_id))"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS block_blast_entries_week_idx " +
      "ON block_blast_tournament_entries(week_start, created_at)"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS block_blast_scores (" +
      "week_start DATE NOT NULL, " +
      "telegram_id BIGINT NOT NULL REFERENCES players(telegram_id), " +
      "best_score INTEGER NOT NULL DEFAULT 0 CHECK (best_score >= 0), " +
      "display_name TEXT NOT NULL DEFAULT 'Игрок', " +
      "username TEXT, " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (week_start, telegram_id))"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS block_blast_scores_week_ranking_idx " +
      "ON block_blast_scores(week_start, best_score DESC, updated_at ASC)"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS block_blast_scores_player_idx " +
      "ON block_blast_scores(telegram_id, best_score DESC)"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS block_blast_tournament_settlements (" +
      "week_start DATE PRIMARY KEY, " +
      "gross_pot BIGINT NOT NULL DEFAULT 0, " +
      "commission_amount BIGINT NOT NULL DEFAULT 0, " +
      "payout_pool BIGINT NOT NULL DEFAULT 0, " +
      "entry_count INTEGER NOT NULL DEFAULT 0, " +
      "winners JSONB NOT NULL DEFAULT '[]'::JSONB, " +
      "settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await finalizeExpired();
    if (!settlementTimer) {
      settlementTimer = setInterval(function () {
        finalizeExpired().catch(error => console.error("Block Blast scheduled settlement error:", error.message || error));
      }, 30 * 60 * 1000);
      if (settlementTimer && typeof settlementTimer.unref === "function") settlementTimer.unref();
    }
    console.log("Block Blast weekly tournament tables and payout scheduler are ready");
  };

  return router;
}
