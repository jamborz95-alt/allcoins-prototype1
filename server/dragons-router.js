import express from "express";

const BREEDER_COST = 4500;
const INCUBATOR_COST = 6500;
const EGG_HATCH_MS = 20 * 60 * 1000;
const EGG_INTERVAL_MS = 60 * 1000;
const GROWTH_MS = 2 * 60 * 60 * 1000;
const MAX_BREEDERS = 5;
const INCUBATOR_SLOTS = 2;
const RAID_COOLDOWN_HOURS = 8;

function displayName(user) {
  const value = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return String(value || user?.username || "Игрок").slice(0, 40);
}

function requireUser(req, res, verifyTelegram) {
  const user = verifyTelegram(req.body?.initData);
  if (!user?.id) {
    res.status(401).json({ ok: false, error: "Открой «Драконы» через ALLCOINS в Telegram." });
    return null;
  }
  return { id: String(user.id), name: displayName(user) };
}

function createDragonRouter({ pool, verifyTelegram }) {
  const router = express.Router();
  let schemaPromise = null;

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS dragon_profiles (
          telegram_id BIGINT PRIMARY KEY,
          incubator_built BOOLEAN NOT NULL DEFAULT FALSE,
          last_raid_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS dragon_creatures (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          telegram_id BIGINT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('breeder','defender','attacker')),
          stage TEXT NOT NULL DEFAULT 'adult' CHECK (stage IN ('growing','adult')),
          born_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          matures_at TIMESTAMPTZ,
          next_egg_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS dragon_creatures_owner_idx
          ON dragon_creatures (telegram_id, kind, stage);
        CREATE TABLE IF NOT EXISTS dragon_eggs (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          telegram_id BIGINT NOT NULL,
          status TEXT NOT NULL DEFAULT 'laid' CHECK (status IN ('laid','incubating','hatched')),
          dragon_kind TEXT CHECK (dragon_kind IN ('defender','attacker')),
          laid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          hatch_at TIMESTAMPTZ,
          hatched_creature_id BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS dragon_eggs_owner_status_idx
          ON dragon_eggs (telegram_id, status, laid_at);
      `).then(async () => {
        // Apply the cadence change once, so existing breeders join the one-minute cycle
        // without having their timers reset on every server restart.
        await pool.query(`
          CREATE TABLE IF NOT EXISTS dragon_system_migrations (
            migration_key TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          WITH applied AS (
            INSERT INTO dragon_system_migrations (migration_key)
            VALUES ('breeder-egg-cycle-one-minute')
            ON CONFLICT (migration_key) DO NOTHING
            RETURNING 1
          )
          UPDATE dragon_creatures
          SET next_egg_at = NOW() + INTERVAL '1 minute'
          WHERE kind = 'breeder'
            AND stage = 'adult'
            AND next_egg_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM applied);
        `);
      });
    }
    try { await schemaPromise; } catch (error) { schemaPromise = null; throw error; }
  }

  async function ensurePlayer(client, userId) {
    await client.query(
      "INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING",
      [userId]
    );
    await client.query(
      "INSERT INTO dragon_profiles (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING",
      [userId]
    );
    const profile = await client.query(
      "SELECT telegram_id, incubator_built, last_raid_at FROM dragon_profiles WHERE telegram_id = $1 FOR UPDATE",
      [userId]
    );
    return profile.rows[0];
  }

  async function processWorld(client, userId) {
    const dueBreeders = await client.query(
      "SELECT id, next_egg_at FROM dragon_creatures WHERE telegram_id = $1 AND kind = 'breeder' AND stage = 'adult' AND next_egg_at IS NOT NULL AND next_egg_at <= NOW() ORDER BY next_egg_at FOR UPDATE",
      [userId]
    );
    for (const breeder of dueBreeders.rows) {
      // Catch up every elapsed minute, including time while the player was offline.
      const overdueMs = Math.max(0, Date.now() - new Date(breeder.next_egg_at).getTime());
      const eggsToLay = Math.floor(overdueMs / EGG_INTERVAL_MS) + 1;
      await client.query(
        "INSERT INTO dragon_eggs (telegram_id, status) SELECT $1, 'laid' FROM generate_series(1, $2)",
        [userId, eggsToLay]
      );
      await client.query(
        "UPDATE dragon_creatures SET next_egg_at = next_egg_at + ($1::TEXT || ' milliseconds')::INTERVAL WHERE id = $2 AND telegram_id = $3",
        [String(eggsToLay * EGG_INTERVAL_MS), breeder.id, userId]
      );
    }

    const dueEggs = await client.query(
      "SELECT id, dragon_kind FROM dragon_eggs WHERE telegram_id = $1 AND status = 'incubating' AND hatch_at <= NOW() ORDER BY hatch_at FOR UPDATE",
      [userId]
    );
    for (const egg of dueEggs.rows) {
      const creature = await client.query(
        "INSERT INTO dragon_creatures (telegram_id, kind, stage, born_at, matures_at) VALUES ($1, $2, 'growing', NOW(), NOW() + INTERVAL '2 hours') RETURNING id",
        [userId, egg.dragon_kind]
      );
      await client.query(
        "UPDATE dragon_eggs SET status = 'hatched', hatched_creature_id = $1 WHERE id = $2 AND telegram_id = $3 AND status = 'incubating'",
        [creature.rows[0].id, egg.id, userId]
      );
    }

    await client.query(
      "UPDATE dragon_creatures SET stage = 'adult' WHERE telegram_id = $1 AND stage = 'growing' AND matures_at <= NOW()",
      [userId]
    );
  }

  async function readState(client, userId, profile) {
    const balanceResult = await client.query("SELECT balance FROM players WHERE telegram_id = $1", [userId]);
    const creaturesResult = await client.query(
      "SELECT id, kind, stage, born_at, matures_at, next_egg_at FROM dragon_creatures WHERE telegram_id = $1 ORDER BY created_at DESC, id DESC",
      [userId]
    );
    const eggsResult = await client.query(
      "SELECT id, status, dragon_kind, laid_at, hatch_at FROM dragon_eggs WHERE telegram_id = $1 AND status IN ('laid','incubating') ORDER BY laid_at ASC",
      [userId]
    );
    const countsResult = await client.query(
      "SELECT COUNT(*) FILTER (WHERE kind = 'breeder' AND stage = 'adult')::INTEGER AS breeders, COUNT(*) FILTER (WHERE kind = 'defender' AND stage = 'adult')::INTEGER AS defenders, COUNT(*) FILTER (WHERE kind = 'attacker' AND stage = 'adult')::INTEGER AS attackers, COUNT(*) FILTER (WHERE stage = 'growing')::INTEGER AS growing FROM dragon_creatures WHERE telegram_id = $1",
      [userId]
    );
    const counts = countsResult.rows[0] || {};
    const lastRaidAt = profile.last_raid_at ? new Date(profile.last_raid_at).getTime() : null;
    return {
      balance: Number(balanceResult.rows[0]?.balance || 0),
      profile: {
        incubatorBuilt: Boolean(profile.incubator_built),
        incubatorSlots: profile.incubator_built ? INCUBATOR_SLOTS : 0,
        raidCooldownHours: RAID_COOLDOWN_HOURS,
        lastRaidAt: profile.last_raid_at,
        nextRaidAt: lastRaidAt == null ? null : lastRaidAt + RAID_COOLDOWN_HOURS * 60 * 60 * 1000
      },
      stats: {
        breeders: Number(counts.breeders || 0),
        defenders: Number(counts.defenders || 0),
        attackers: Number(counts.attackers || 0),
        growing: Number(counts.growing || 0),
        defensePower: Number(counts.defenders || 0) * 10
      },
      creatures: creaturesResult.rows.map(row => ({
        id: String(row.id), kind: row.kind, stage: row.stage,
        bornAt: row.born_at, maturesAt: row.matures_at, nextEggAt: row.next_egg_at
      })),
      eggs: eggsResult.rows.map(row => ({
        id: String(row.id), status: row.status, dragonKind: row.dragon_kind,
        laidAt: row.laid_at, hatchAt: row.hatch_at
      }))
    };
  }

  async function inTransaction(work) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const value = await work(client);
      await client.query("COMMIT");
      open = false;
      return value;
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      throw error;
    } finally { client.release(); }
  }

  router.post("/state", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    try {
      await ensureSchema();
      const state = await inTransaction(async client => {
        const profile = await ensurePlayer(client, user.id);
        await processWorld(client, user.id);
        return readState(client, user.id, profile);
      });
      return res.json({ ok: true, state });
    } catch (error) {
      console.error("Dragons state error:", error.message);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить драконье логово." });
    }
  });

  router.post("/buy-breeder", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    try {
      await ensureSchema();
      const state = await inTransaction(async client => {
        const profile = await ensurePlayer(client, user.id);
        await processWorld(client, user.id);
        const count = await client.query(
          "SELECT COUNT(*)::INTEGER AS total FROM dragon_creatures WHERE telegram_id = $1 AND kind = 'breeder'",
          [user.id]
        );
        if (Number(count.rows[0]?.total || 0) >= 5) {
          const error = new Error("Можно содержать не более пяти драконов-производителей.");
          error.status = 400; throw error;
        }
        const debit = await client.query(
          "UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2 AND balance >= $1 RETURNING balance",
          [BREEDER_COST, user.id]
        );
        if (!debit.rowCount) {
          const error = new Error("Недостаточно AC для покупки дракона.");
          error.status = 400; throw error;
        }
        await client.query(
          "INSERT INTO dragon_creatures (telegram_id, kind, stage, born_at, next_egg_at) VALUES ($1, 'breeder', 'adult', NOW(), NOW() + INTERVAL '1 minute')",
          [user.id]
        );
        return readState(client, user.id, profile);
      });
      return res.json({ ok: true, message: "Дракон-производитель куплен. Первое яйцо появится через 1 минуту.", state });
    } catch (error) {
      console.error("Dragon breeder purchase error:", error.message);
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось купить дракона." });
    }
  });

  router.post("/build-incubator", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    try {
      await ensureSchema();
      const state = await inTransaction(async client => {
        const profile = await ensurePlayer(client, user.id);
        await processWorld(client, user.id);
        if (profile.incubator_built) {
          const error = new Error("Инкубатор уже построен.");
          error.status = 400; throw error;
        }
        const debit = await client.query(
          "UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2 AND balance >= $1 RETURNING balance",
          [INCUBATOR_COST, user.id]
        );
        if (!debit.rowCount) {
          const error = new Error("Недостаточно AC для постройки инкубатора.");
          error.status = 400; throw error;
        }
        await client.query(
          "UPDATE dragon_profiles SET incubator_built = TRUE, updated_at = NOW() WHERE telegram_id = $1",
          [user.id]
        );
        return readState(client, user.id, { ...profile, incubator_built: true });
      });
      return res.json({ ok: true, message: "Инкубатор построен. Теперь можно высиживать яйца.", state });
    } catch (error) {
      console.error("Dragon incubator error:", error.message);
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось построить инкубатор." });
    }
  });

  router.post("/incubate", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    const eggId = String(req.body?.eggId || "");
    const kind = String(req.body?.kind || "");
    if (!/^\d{1,18}$/.test(eggId) || !["defender", "attacker"].includes(kind)) {
      return res.status(400).json({ ok: false, error: "Выбери яйцо и тип дракона." });
    }
    try {
      await ensureSchema();
      const state = await inTransaction(async client => {
        const profile = await ensurePlayer(client, user.id);
        await processWorld(client, user.id);
        if (!profile.incubator_built) {
          const error = new Error("Сначала построй инкубатор.");
          error.status = 400; throw error;
        }
        const active = await client.query(
          "SELECT COUNT(*)::INTEGER AS total FROM dragon_eggs WHERE telegram_id = $1 AND status = 'incubating'",
          [user.id]
        );
        if (Number(active.rows[0]?.total || 0) >= INCUBATOR_SLOTS) {
          const error = new Error("Все места в инкубаторе заняты. Дождись вылупления.");
          error.status = 400; throw error;
        }
        const egg = await client.query(
          "UPDATE dragon_eggs SET status = 'incubating', dragon_kind = $1, hatch_at = NOW() + ($2::TEXT || ' milliseconds')::INTERVAL WHERE id = $3 AND telegram_id = $4 AND status = 'laid' RETURNING id",
          [kind, String(EGG_HATCH_MS), eggId, user.id]
        );
        if (!egg.rowCount) {
          const error = new Error("Это яйцо уже отправлено в инкубатор или не найдено.");
          error.status = 400; throw error;
        }
        return readState(client, user.id, profile);
      });
      return res.json({ ok: true, message: "Яйцо помещено в инкубатор. После вылупления дракон будет расти 2 часа.", state });
    } catch (error) {
      console.error("Dragon incubation error:", error.message);
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось поместить яйцо в инкубатор." });
    }
  });

  router.post("/expedition", async (req, res) => {
    const user = requireUser(req, res, verifyTelegram);
    if (!user) return;
    try {
      await ensureSchema();
      const outcome = await inTransaction(async client => {
        const profile = await ensurePlayer(client, user.id);
        await processWorld(client, user.id);
        if (profile.last_raid_at) {
          const readyAt = new Date(profile.last_raid_at).getTime() + RAID_COOLDOWN_HOURS * 60 * 60 * 1000;
          if (Date.now() < readyAt) {
            const error = new Error("Атакующие драконы ещё отдыхают перед следующей экспедицией.");
            error.status = 400; throw error;
          }
        }
        const forces = await client.query(
          "SELECT COUNT(*) FILTER (WHERE kind = 'attacker' AND stage = 'adult')::INTEGER AS attackers, COUNT(*) FILTER (WHERE kind = 'defender' AND stage = 'adult')::INTEGER AS defenders FROM dragon_creatures WHERE telegram_id = $1",
          [user.id]
        );
        const attackers = Number(forces.rows[0]?.attackers || 0);
        const defenders = Number(forces.rows[0]?.defenders || 0);
        if (!attackers) {
          const error = new Error("Для экспедиции нужен хотя бы один взрослый дракон-атакующий.");
          error.status = 400; throw error;
        }
        const reward = 250 + Math.min(4, attackers) * 100 + Math.min(5, defenders) * 30;
        await client.query(
          "UPDATE players SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2",
          [reward, user.id]
        );
        await client.query(
          "UPDATE dragon_profiles SET last_raid_at = NOW(), updated_at = NOW() WHERE telegram_id = $1",
          [user.id]
        );
        return { reward };
      });
      const state = await inTransaction(async client => {
        const profile = await ensurePlayer(client, user.id);
        await processWorld(client, user.id);
        return readState(client, user.id, profile);
      });
      return res.json({ ok: true, message: "Экспедиция завершена! Драконы нашли сокровища в Долине.", reward: outcome.reward, state });
    } catch (error) {
      console.error("Dragon expedition error:", error.message);
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Экспедиция не удалась." });
    }
  });

  return router;
}

export { createDragonRouter };
