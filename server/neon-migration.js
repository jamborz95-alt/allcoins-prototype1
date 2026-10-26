import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const SCHEMA = "public";
const BATCH_SIZE = 300;

function qi(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}
function qname(schema, name) {
  return qi(schema) + "." + qi(name);
}
function rowChecksum(rows) {
  const hashes = rows.map((row) => crypto.createHash("sha256").update(row).digest("hex")).sort();
  return crypto.createHash("sha256").update(hashes.join("\n")).digest("hex");
}
function secretMatches(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" || !received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function identityOptions(seq) {
  if (!seq) return "";
  const parts = [
    "START WITH " + seq.seqstart,
    "INCREMENT BY " + seq.seqincrement,
    "MINVALUE " + seq.seqmin,
    "MAXVALUE " + seq.seqmax,
    "CACHE " + seq.seqcache,
    seq.seqcycle ? "CYCLE" : "NO CYCLE"
  ];
  return " (" + parts.join(" ") + ")";
}
async function getTableRows(client, tableName, limit, offset) {
  const sql = `SELECT to_jsonb(t)::text AS row_json
               FROM ${qname(SCHEMA, tableName)} AS t
               ORDER BY t.ctid
               LIMIT $1 OFFSET $2`;
  const result = await client.query(sql, [limit, offset]);
  return result.rows.map((r) => r.row_json);
}
async function getChecksums(client, tableNames) {
  const summaries = {};
  for (const tableName of tableNames) {
    const hashes = [];
    let offset = 0;
    while (true) {
      const batch = await getTableRows(client, tableName, BATCH_SIZE, offset);
      if (!batch.length) break;
      for (const row of batch) hashes.push(row);
      offset += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }
    summaries[tableName] = { rows: hashes.length, checksum: rowChecksum(hashes) };
  }
  return summaries;
}
function sameSummaries(left, right) {
  const a = Object.keys(left).sort();
  const b = Object.keys(right).sort();
  if (a.length !== b.length || a.some((name, i) => name !== b[i])) return false;
  return a.every((name) =>
    left[name].rows === right[name].rows &&
    left[name].checksum === right[name].checksum
  );
}
async function getWalletSummary(client) {
  const result = await client.query(
    "SELECT count(*)::bigint AS player_count, COALESCE(sum(balance), 0)::text AS balance_sum FROM public.players"
  );
  return {
    players: Number(result.rows[0].player_count),
    balance_sum: String(result.rows[0].balance_sum)
  };
}
async function readSequenceState(client, seq) {
  const result = await client.query(
    "SELECT last_value::text AS last_value, is_called FROM " + qname(seq.schema_name, seq.sequence_name)
  );
  return { last_value: String(result.rows[0].last_value), is_called: Boolean(result.rows[0].is_called) };
}
async function currentSequenceStates(client, sequences) {
  const result = {};
  for (const seq of sequences) {
    result[seq.schema_name + "." + seq.sequence_name] = await readSequenceState(client, seq);
  }
  return result;
}
function sequenceStatesEqual(a, b) {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length &&
    keys.every((key, i) => key === other[i] &&
      a[key].last_value === b[key].last_value &&
      a[key].is_called === b[key].is_called);
}
async function collectMetadata(source) {
  const featureCheck = await source.query(`
    SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('p','v','m','f')) AS unsupported_relations,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity) AS rls_tables,
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname='public' AND t.typtype='d') AS domains,
      (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql') AS extra_extensions
  `);
  const features = featureCheck.rows[0];
  if (Number(features.unsupported_relations) || Number(features.rls_tables) ||
      Number(features.domains) || Number(features.extra_extensions)) {
    throw new Error("Source schema has unsupported PostgreSQL objects; migration stopped before copying data.");
  }

  const tableResult = await source.query(`
    SELECT c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
    ORDER BY c.relname
  `);
  const tableNames = tableResult.rows.map((r) => r.table_name);

  const columnsResult = await source.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type_sql,
           a.attnotnull AS not_null, a.attidentity AS identity_kind,
           a.attgenerated AS generated_kind,
           pg_get_expr(d.adbin, d.adrelid) AS expression_sql,
           coll_ns.nspname AS collation_schema, coll.collname AS collation_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
    LEFT JOIN pg_namespace coll_ns ON coll_ns.oid=coll.collnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `);

  const enumResult = await source.query(`
    SELECT t.typname AS type_name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid=t.typnamespace
    JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' AND t.typtype='e'
    GROUP BY t.typname ORDER BY t.typname
  `);
  const sequencesResult = await source.query(`
    SELECT ns.nspname AS schema_name, c.relname AS sequence_name,
           format_type(s.seqtypid, NULL) AS data_type,
           s.seqstart::text AS seqstart, s.seqincrement::text AS seqincrement,
           s.seqmin::text AS seqmin, s.seqmax::text AS seqmax,
           s.seqcache::text AS seqcache, s.seqcycle,
           dep.deptype AS ownership_kind,
           tn.nspname AS owned_table_schema, tc.relname AS owned_table_name,
           a.attname AS owned_column_name
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid=c.relnamespace
    JOIN pg_sequence s ON s.seqrelid=c.oid
    LEFT JOIN pg_depend dep
      ON dep.classid='pg_class'::regclass AND dep.objid=c.oid
      AND dep.refclassid='pg_class'::regclass AND dep.deptype IN ('a','i')
    LEFT JOIN pg_class tc ON tc.oid=dep.refobjid
    LEFT JOIN pg_namespace tn ON tn.oid=tc.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=tc.oid AND a.attnum=dep.refobjsubid
    WHERE ns.nspname='public'
    ORDER BY c.relname
  `);
  const constraintsResult = await source.query(`
    SELECT n.nspname AS table_schema, r.relname AS table_name,
           c.conname AS constraint_name, c.contype AS constraint_type,
           pg_get_constraintdef(c.oid, true) AS definition,
           c.convalidated AS validated
    FROM pg_constraint c
    JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public'
    ORDER BY CASE c.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 WHEN 'x' THEN 4 WHEN 'f' THEN 5 ELSE 6 END,
             r.relname, c.conname
  `);
  const indexesResult = await source.query(`
    SELECT pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    JOIN pg_class tbl ON tbl.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=tbl.relnamespace
    WHERE n.nspname='public'
      AND i.indisvalid
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid)
    ORDER BY tbl.relname, i.indexrelid
  `);
  const functionsResult = await source.query(`
    SELECT pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.prokind IN ('f','p')
      AND l.lanname IN ('plpgsql','sql')
    ORDER BY p.proname, p.oid
  `);
  const triggersResult = await source.query(`
    SELECT pg_get_triggerdef(t.oid, true) AS definition
    FROM pg_trigger t
    JOIN pg_class r ON r.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal
    ORDER BY r.relname, t.tgname
  `);
  const sequences = sequencesResult.rows;
  const sequenceStates = {};
  for (const seq of sequences) {
    sequenceStates[seq.schema_name + "." + seq.sequence_name] = await readSequenceState(source, seq);
  }

  const columnsByTable = {};
  for (const col of columnsResult.rows) {
    (columnsByTable[col.table_name] ||= []).push(col);
  }
  return {
    tableNames, columnsByTable, enums: enumResult.rows, sequences,
    sequenceStates, constraints: constraintsResult.rows,
    indexes: indexesResult.rows.map((r) => r.definition),
    functions: functionsResult.rows.map((r) => r.definition),
    triggers: triggersResult.rows.map((r) => r.definition)
  };
}
function makeTableDDL(tableName, columns, sequenceByOwner) {
  const defs = columns.map((col) => {
    let def = qi(col.column_name) + " " + col.type_sql;
    if (col.collation_name && col.collation_name !== "default" &&
        col.collation_schema && col.collation_schema !== "pg_catalog") {
      def += " COLLATE " + qname(col.collation_schema, col.collation_name);
    }
    if (col.identity_kind) {
      const seq = sequenceByOwner.get(tableName + "." + col.column_name);
      def += col.identity_kind === "a" ? " GENERATED ALWAYS AS IDENTITY" : " GENERATED BY DEFAULT AS IDENTITY";
      def += identityOptions(seq);
    } else if (col.generated_kind) {
      def += " GENERATED ALWAYS AS (" + col.expression_sql + ") " +
        (col.generated_kind === "v" ? "VIRTUAL" : "STORED");
    } else if (col.expression_sql) {
      def += " DEFAULT " + col.expression_sql;
    }
    if (col.not_null) def += " NOT NULL";
    return def;
  });
  return "CREATE TABLE " + qname(SCHEMA, tableName) + " (" + defs.join(", ") + ")";
}
async function copyTableData(source, target, tableName, columns) {
  const insertable = columns.filter((c) => !c.generated_kind);
  const names = insertable.map((c) => qi(c.column_name));
  const identity = insertable.some((c) => Boolean(c.identity_kind));
  const hashes = [];
  let rowsCopied = 0;
  let offset = 0;
  while (true) {
    const rows = await getTableRows(source, tableName, BATCH_SIZE, offset);
    if (!rows.length) break;
    const payload = "[" + rows.join(",") + "]";
    if (insertable.length) {
      const override = identity ? " OVERRIDING SYSTEM VALUE" : "";
      const sql = "INSERT INTO " + qname(SCHEMA, tableName) +
        " (" + names.join(", ") + ")" + override +
        " SELECT " + names.join(", ") +
        " FROM jsonb_populate_recordset(NULL::" + qname(SCHEMA, tableName) + ", $1::jsonb)";
      await target.query(sql, [payload]);
    } else {
      for (let i = 0; i < rows.length; i++) {
        await target.query("INSERT INTO " + qname(SCHEMA, tableName) + " DEFAULT VALUES");
      }
    }
    for (const row of rows) hashes.push(row);
    rowsCopied += rows.length;
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return { rows: rowsCopied, checksum: rowChecksum(hashes) };
}
async function getPublicObjectCounts(target) {
  const result = await target.query(`
    SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')) AS relations,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public') AS functions,
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname='public' AND t.typtype IN ('e','d')) AS custom_types
  `);
  return result.rows[0];
}
async function runMigration(sourcePool) {
  const targetPool = new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000
  });
  let source;
  let validator;
  let target;
  let targetTransaction = false;
  try {
    source = await sourcePool.connect();
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await source.query("SET LOCAL TIME ZONE 'UTC'");
    await source.query("SET LOCAL search_path TO public, pg_catalog");

    const metadata = await collectMetadata(source);
    if (!metadata.tableNames.includes("players") ||
        !metadata.tableNames.includes("allcoins_balance_audit") ||
        !metadata.tableNames.includes("allcoins_balance_recoveries")) {
      throw new Error("The source database is missing required ALLCOINS wallet protection tables.");
    }
    const sourceWallet = await getWalletSummary(source);
    const sourceSequencesAtStart = { ...metadata.sequenceStates };
    const sourceChecksums = {};

    target = await targetPool.connect();
    await target.query("BEGIN");
    targetTransaction = true;
    await target.query("SET LOCAL TIME ZONE 'UTC'");
    await target.query("SET LOCAL search_path TO public, pg_catalog");

    const objects = await getPublicObjectCounts(target);
    if (Number(objects.relations) !== 0 || Number(objects.functions) !== 0 || Number(objects.custom_types) !== 0) {
      throw new Error("The Neon target database is not empty. Nothing was written; choose an empty database.");
    }

    const sequenceByOwner = new Map();
    for (const seq of metadata.sequences) {
      if (seq.owned_table_name && seq.owned_column_name) {
        sequenceByOwner.set(seq.owned_table_name + "." + seq.owned_column_name, seq);
      }
    }

    const enumDDLs = metadata.enums.map((type) => {
      const labels = type.labels.map((value) => "'" + String(value).replace(/'/g, "''") + "'");
      return "CREATE TYPE " + qname(SCHEMA, type.type_name) + " AS ENUM (" + labels.join(", ") + ")";
    });
    if (enumDDLs.length) await target.query(enumDDLs.join(";\n") + ";");

    const sequenceDDLs = metadata.sequences
      .filter((seq) => seq.ownership_kind !== "i")
      .map((seq) => "CREATE SEQUENCE " + qname(seq.schema_name, seq.sequence_name) +
        " AS " + seq.data_type +
        " INCREMENT BY " + seq.seqincrement +
        " MINVALUE " + seq.seqmin +
        " MAXVALUE " + seq.seqmax +
        " START WITH " + seq.seqstart +
        " CACHE " + seq.seqcache +
        (seq.seqcycle ? " CYCLE" : " NO CYCLE"));
    if (sequenceDDLs.length) await target.query(sequenceDDLs.join(";\n") + ";");

    const tableDDLs = metadata.tableNames.map((name) =>
      makeTableDDL(name, metadata.columnsByTable[name], sequenceByOwner)
    );
    if (tableDDLs.length) await target.query(tableDDLs.join(";\n") + ";");

    for (const name of metadata.tableNames) {
      sourceChecksums[name] = await copyTableData(source, target, name, metadata.columnsByTable[name]);
    }

    const constraintDDLs = metadata.constraints.map((c) => {
      let ddl = "ALTER TABLE " + qname(c.table_schema, c.table_name) +
        " ADD CONSTRAINT " + qi(c.constraint_name) + " " + c.definition;
      if (!c.validated && (c.constraint_type === "f" || c.constraint_type === "c")) ddl += " NOT VALID";
      return ddl;
    });
    if (constraintDDLs.length) await target.query(constraintDDLs.join(";\n") + ";");
    if (metadata.indexes.length) await target.query(metadata.indexes.join(";\n") + ";");
    if (metadata.functions.length) await target.query(metadata.functions.join(";\n") + ";");
    if (metadata.triggers.length) await target.query(metadata.triggers.join(";\n") + ";");

    for (const seq of metadata.sequences) {
      if (seq.ownership_kind === "a" && seq.owned_table_schema && seq.owned_table_name && seq.owned_column_name) {
        await target.query("ALTER SEQUENCE " + qname(seq.schema_name, seq.sequence_name) +
          " OWNED BY " + qname(seq.owned_table_schema, seq.owned_table_name) + "." + qi(seq.owned_column_name));
      }
      const state = sourceSequencesAtStart[seq.schema_name + "." + seq.sequence_name];
      if (state) {
        await target.query("SELECT setval($1::regclass, $2::bigint, $3::boolean)",
          [seq.schema_name + "." + seq.sequence_name, state.last_value, state.is_called]);
      }
    }

    const targetChecksums = await getChecksums(target, metadata.tableNames);
    if (!sameSummaries(sourceChecksums, targetChecksums)) {
      throw new Error("Verification failed: one or more target table checksums did not match the source snapshot. The import was rolled back.");
    }
    const targetWallet = await getWalletSummary(target);
    if (sourceWallet.players !== targetWallet.players || sourceWallet.balance_sum !== targetWallet.balance_sum) {
      throw new Error("Wallet verification failed. The import was rolled back.");
    }

    validator = await sourcePool.connect();
    await validator.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await validator.query("SET LOCAL TIME ZONE 'UTC'");
    await validator.query("SET LOCAL search_path TO public, pg_catalog");
    const latestChecksums = await getChecksums(validator, metadata.tableNames);
    const latestSequences = await currentSequenceStates(validator, metadata.sequences);
    const latestWallet = await getWalletSummary(validator);
    if (!sameSummaries(sourceChecksums, latestChecksums) ||
        !sequenceStatesEqual(sourceSequencesAtStart, latestSequences) ||
        latestWallet.players !== sourceWallet.players ||
        latestWallet.balance_sum !== sourceWallet.balance_sum) {
      throw new Error("The Render database changed while copying. The Neon import was rolled back to avoid a stale cutover; retry during a quiet period.");
    }

    await target.query("COMMIT");
    targetTransaction = false;
    await source.query("COMMIT");
    return {
      status: "success",
      tables: metadata.tableNames.length,
      sequences: metadata.sequences.length,
      constraints: metadata.constraints.length,
      indexes: metadata.indexes.length,
      trigger_functions: metadata.functions.length,
      triggers: metadata.triggers.length,
      verified_tables: Object.keys(targetChecksums).length,
      wallet: sourceWallet
    };
  } catch (error) {
    if (targetTransaction && target) {
      try { await target.query("ROLLBACK"); } catch {}
    }
    if (source) {
      try { await source.query("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    if (validator) {
      try { await validator.query("ROLLBACK"); } catch {}
      validator.release();
    }
    if (source) source.release();
    if (target) target.release();
    await targetPool.end();
  }
}

export function registerNeonMigrationRoute(app, sourcePool) {
  // The route is inert unless both values are set in Render's private environment.
  if (!process.env.NEON_DATABASE_URL || !process.env.NEON_MIGRATION_SECRET) return;

  app.get("/_internal/neon-migrate", async (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Referrer-Policy", "no-referrer");
    if (!secretMatches(String(req.query.token || ""), process.env.NEON_MIGRATION_SECRET)) {
      return res.status(404).json({ error: "Not found" });
    }
    if (req.query.action !== "migrate") {
      return res.status(400).json({ error: "Missing action=migrate" });
    }
    if (globalThis.__allcoinsNeonMigrationRunning) {
      return res.status(409).json({ error: "Migration is already running" });
    }
    globalThis.__allcoinsNeonMigrationRunning = true;
    try {
      const result = await runMigration(sourcePool);
      return res.status(200).json(result);
    } catch (error) {
      // Do not return URLs, SQL text, stack traces, or player data to the caller.
      const message = String(error?.message || "Migration failed");
      console.error("[NEON-MIGRATION]", message);
      const safe = /changed while copying|not empty|rolled back|missing required|unsupported PostgreSQL|verification failed|Wallet verification failed/i.test(message)
        ? message
        : "Migration failed safely. The Neon transaction was rolled back; check Render server logs for the internal error.";
      return res.status(500).json({ status: "failed", error: safe });
    } finally {
      globalThis.__allcoinsNeonMigrationRunning = false;
    }
  });
}
