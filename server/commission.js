const COMMISSION_PERCENT = 5;
const MAX_BIGINT = 9223372036854775807n;

export function configuredAdminTelegramId() {
  const value = String(process.env.ADMIN_TELEGRAM_ID || "").trim();
  return /^\d{1,20}$/.test(value) && BigInt(value) > 0n && BigInt(value) <= MAX_BIGINT
    ? value
    : null;
}

export function calculateGameCommission(grossAmount) {
  const gross = Math.max(0, Math.floor(Number(grossAmount) || 0));
  return Math.floor(gross * COMMISSION_PERCENT / 100);
}

export async function initializeCommissionTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS allcoins_commissions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      game TEXT NOT NULL,
      event_key TEXT NOT NULL UNIQUE,
      gross_amount BIGINT NOT NULL CHECK (gross_amount >= 0),
      commission_amount BIGINT NOT NULL CHECK (commission_amount >= 0),
      admin_telegram_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      credited_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS allcoins_commissions_admin_created_idx " +
    "ON allcoins_commissions(admin_telegram_id, created_at DESC)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS allcoins_commissions_pending_idx " +
    "ON allcoins_commissions(credited_at, created_at) WHERE credited_at IS NULL"
  );
}

/**
 * Store the 5% commission once per completed payout. If ADMIN_TELEGRAM_ID is
 * configured, credit it to the admin's AC balance in this same game transaction.
 * Otherwise keep it in the ledger as pending so it is not lost.
 */
export async function recordGameCommission(client, {
  game,
  eventKey,
  grossAmount,
  testMode = false
}) {
  if (testMode) return { amount: 0, credited: false, skipped: true };

  const gross = Math.max(0, Math.floor(Number(grossAmount) || 0));
  const amount = calculateGameCommission(gross);
  if (amount <= 0) return { amount: 0, credited: false, skipped: true };
  if (!String(eventKey || "").trim()) throw new Error("Missing commission event key");

  const adminId = configuredAdminTelegramId();
  const inserted = await client.query(
    `INSERT INTO allcoins_commissions
       (game, event_key, gross_amount, commission_amount, admin_telegram_id, credited_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::TEXT IS NULL THEN NULL ELSE NOW() END)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [String(game), String(eventKey), String(gross), String(amount), adminId]
  );

  if (!inserted.rows.length) {
    const existing = await client.query(
      "SELECT commission_amount, credited_at FROM allcoins_commissions WHERE event_key = $1",
      [String(eventKey)]
    );
    return {
      amount: Number(existing.rows[0]?.commission_amount || 0),
      credited: Boolean(existing.rows[0]?.credited_at),
      alreadyRecorded: true
    };
  }

  if (adminId) {
    await client.query(
      "INSERT INTO players (telegram_id) VALUES ($1::BIGINT) ON CONFLICT (telegram_id) DO NOTHING",
      [adminId]
    );
    const credited = await client.query(
      "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() " +
      "WHERE telegram_id = $2::BIGINT RETURNING balance",
      [String(amount), adminId]
    );
    if (!credited.rows.length) throw new Error("Не удалось начислить комиссию администратору");
  }

  return { amount, credited: Boolean(adminId), alreadyRecorded: false };
}

/** Move commissions accumulated before ADMIN_TELEGRAM_ID was configured to the admin. */
export async function claimPendingCommissions(client, adminId) {
  const pending = await client.query(
    "SELECT id, commission_amount::TEXT AS commission_amount FROM allcoins_commissions " +
    "WHERE credited_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED"
  );
  if (!pending.rows.length) return 0;

  const ids = pending.rows.map(row => String(row.id));
  const total = pending.rows.reduce((sum, row) => sum + BigInt(row.commission_amount || "0"), 0n);
  if (total > 0n) {
    await client.query(
      "INSERT INTO players (telegram_id) VALUES ($1::BIGINT) ON CONFLICT (telegram_id) DO NOTHING",
      [adminId]
    );
    const credited = await client.query(
      "UPDATE players SET balance = balance + $1::BIGINT, updated_at = NOW() " +
      "WHERE telegram_id = $2::BIGINT RETURNING balance",
      [String(total), adminId]
    );
    if (!credited.rows.length) throw new Error("Не удалось начислить накопленные комиссии администратору");
  }

  await client.query(
    "UPDATE allcoins_commissions SET admin_telegram_id = $2, credited_at = NOW() WHERE id = ANY($1::BIGINT[]) AND credited_at IS NULL",
    [ids, adminId]
  );
  return Number(total);
}

export async function getAdminCommissionSummary(client, adminId) {
  const totals = await client.query(
    `SELECT
       COALESCE(SUM(commission_amount), 0)::TEXT AS total_commission,
       COALESCE(SUM(gross_amount), 0)::TEXT AS total_gross,
       COUNT(*)::INTEGER AS games_count
     FROM allcoins_commissions
     WHERE admin_telegram_id = $1 AND credited_at IS NOT NULL`,
    [adminId]
  );
  const recent = await client.query(
    `SELECT game, gross_amount::TEXT AS gross_amount,
            commission_amount::TEXT AS commission_amount, created_at
     FROM allcoins_commissions
     WHERE admin_telegram_id = $1 AND credited_at IS NOT NULL
     ORDER BY created_at DESC LIMIT 20`,
    [adminId]
  );
  const wallet = await client.query(
    "SELECT balance::TEXT AS balance FROM players WHERE telegram_id = $1::BIGINT",
    [adminId]
  );
  const row = totals.rows[0] || {};
  return {
    totalCommission: Number(row.total_commission || 0),
    totalGross: Number(row.total_gross || 0),
    gamesCount: Number(row.games_count || 0),
    adminBalance: Number(wallet.rows[0]?.balance || 0),
    recent: recent.rows.map(item => ({
      game: String(item.game),
      grossAmount: Number(item.gross_amount || 0),
      commissionAmount: Number(item.commission_amount || 0),
      createdAt: item.created_at
    }))
  };
}

export const GAME_COMMISSION_PERCENT = COMMISSION_PERCENT;
