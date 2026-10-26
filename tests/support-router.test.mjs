import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server/support-router.js", import.meta.url), "utf8");

function makeHarness({
  env = {
    ADMIN_TELEGRAM_ID: "999",
    BOT_TOKEN: "test-bot-token",
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MODEL: "gemini-3.5-flash-lite"
  },
  fetchImpl
} = {}) {
  const handlers = {};
  const queries = [];
  const inserted = [];
  const updates = [];
  const fetchCalls = [];
  let nextId = 15;
  const ticketRows = [];

  const pool = {
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: statement, params });

      if (statement.startsWith("INSERT INTO allcoins_support_tickets")) {
        const row = {
          id: String(nextId++),
          telegram_id: String(params[0]),
          username: params[1],
          first_name: params[2],
          category: params[3],
          description: params[4],
          status: "open",
          ai_summary: null,
          ai_severity: null,
          needs_developer: true,
          notification_status: "pending",
          created_at: new Date("2026-10-26T10:00:00.000Z").toISOString(),
          updated_at: new Date("2026-10-26T10:00:00.000Z").toISOString()
        };
        inserted.push(row);
        ticketRows.unshift(row);
        return { rows: [row], rowCount: 1 };
      }

      if (statement.includes("SET ai_summary = $1")) {
        updates.push({ type: "triage", params });
        const row = ticketRows.find(item => String(item.id) === String(params[4]));
        if (row) {
          row.ai_summary = params[0];
          row.ai_severity = params[1];
          row.needs_developer = params[2];
          row.notification_status = statement.includes("notification_status = 'not_needed'")
            ? "not_needed"
            : statement.includes("notification_status = 'sent'") ? "sent" : params[3];
        }
        return { rows: [], rowCount: 1 };
      }

      if (statement.startsWith("SELECT id, telegram_id")) {
        return { rows: ticketRows.slice(0, 50) };
      }
      if (statement.startsWith("SELECT COUNT(*)")) {
        return { rows: [{
          total: ticketRows.length,
          open: ticketRows.filter(item => item.status === "open").length,
          in_progress: ticketRows.filter(item => item.status === "in_progress").length,
          resolved: ticketRows.filter(item => item.status === "resolved").length
        }] };
      }
      if (statement.includes("SET status = $1")) {
        const row = ticketRows.find(item => String(item.id) === String(params[1]));
        if (!row) return { rows: [], rowCount: 0 };
        row.status = params[0];
        updates.push({ type: "status", params });
        return { rows: [{ id: row.id, status: row.status }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  const express = {
    Router: () => ({
      post(path, handler) { handlers[path] = handler; }
    })
  };
  const fakeFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (fetchImpl) return fetchImpl(url, options);
    if (String(url).includes("api.telegram.org")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 11 } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: "Приоритет: средний\nКратко: игрок видит зависание анимации.\nЧто проверить: повторить шаги и посмотреть ошибки консоли.\nНужен разработчик: да"
            }]
          }
        }]
      })
    };
  };
  const mockProcess = { env: { ...env } };
  const mockConsole = { error() {}, log() {}, warn() {} };
  const transformed = source
    .replace(/^import express from "express";\s*/m, "")
    .replace(/^import \{ configuredAdminTelegramId \} from "\.\/commission\.js";\s*/m, "")
    .replace("export function createSupportRouter", "function createSupportRouter");
  const wrappedSource =
    "const configuredAdminTelegramId = () => { const value = String(process.env.ADMIN_TELEGRAM_ID || '').trim(); return /^\\d{1,20}$/.test(value) && BigInt(value) > 0n ? value : null; };\n" +
    transformed +
    "\nreturn { createSupportRouter };";
  const { createSupportRouter } = new Function(
    "express", "process", "fetch", "console", wrappedSource
  )(express, mockProcess, fakeFetch, mockConsole);

  const router = createSupportRouter({
    pool,
    verifyTelegram(initData) {
      if (initData === "player-init") return { id: 123, first_name: "Tester", username: "tester" };
      if (initData === "admin-init") return { id: 999, first_name: "Owner", username: "owner" };
      return null;
    }
  });

  async function call(path, body) {
    const handler = handlers[path];
    assert.equal(typeof handler, "function", `Route ${path} is registered`);
    let statusCode = 200;
    let payload = null;
    let responseSent = false;
    const response = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; responseSent = true; return this; }
    };
    await handler({ body }, response);
    return { statusCode, payload, responseSent };
  }

  return { router, pool, queries, inserted, updates, fetchCalls, ticketRows, call };
}

async function waitFor(check, timeout = 300) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for support background task");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("initializes support tickets table and indices", async () => {
  const harness = makeHarness();
  await harness.router.initialize();
  assert.ok(harness.queries.some(item => item.sql.includes("CREATE TABLE IF NOT EXISTS allcoins_support_tickets")));
  assert.ok(harness.queries.some(item => item.sql.includes("DROP CONSTRAINT IF EXISTS allcoins_support_tickets_notification_status_check")));
  assert.ok(harness.queries.some(item => item.sql.includes("ADD CONSTRAINT allcoins_support_tickets_notification_status_check")));
  assert.ok(harness.queries.filter(item => item.sql.includes("CREATE INDEX IF NOT EXISTS allcoins_support_tickets_")).length >= 2);
});

test("rejects requests without valid Telegram authentication", async () => {
  const harness = makeHarness();
  const result = await harness.call("/submit", { initData: "wrong", category: "Другое", description: "This is a test issue" });
  assert.equal(result.statusCode, 401);
  assert.equal(harness.inserted.length, 0);
});

test("validates category and minimum description length", async () => {
  const harness = makeHarness();
  const badCategory = await harness.call("/submit", { initData: "player-init", category: "Unknown", description: "Detailed problem text" });
  const shortText = await harness.call("/submit", { initData: "player-init", category: "Другое", description: "short" });
  assert.equal(badCategory.statusCode, 400);
  assert.equal(shortText.statusCode, 400);
  assert.equal(harness.inserted.length, 0);
});

test("saves a support request quickly, then asks Gemini to triage it in the support inbox", async () => {
  const harness = makeHarness();
  await harness.router.initialize();
  const result = await harness.call("/submit", {
    initData: "player-init",
    category: "Зависание / тормоза",
    description: "Игра зависает, когда противник выкладывает карту на стол."
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.ticketId, "15");
  assert.equal(harness.inserted.length, 1);
  assert.equal(harness.inserted[0].telegram_id, "123");
  assert.equal(harness.inserted[0].category, "Зависание / тормоза");

  await waitFor(() => harness.updates.some(item => item.type === "triage") &&
    harness.ticketRows[0]?.notification_status === "not_needed");
  assert.ok(harness.fetchCalls.some(item => item.url.includes("/models/gemini-3.5-flash-lite:generateContent")));
  assert.equal(harness.fetchCalls.some(item => item.url.includes("api.telegram.org/bot")), false);
  assert.equal(harness.ticketRows[0].notification_status, "not_needed");
  assert.equal(harness.ticketRows[0].needs_developer, true);
  assert.match(harness.ticketRows[0].ai_summary, /Нужен разработчик/);
});

test("does not interrupt the owner when AI decides no developer is needed", async () => {
  const noDeveloperFetch = async url => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{
          text: "Приоритет: низкий\\nКратко: игрок задаёт общий вопрос по правилам.\\nЧто проверить: отправить ссылку на правила.\\nНужен разработчик: нет"
        }] } }] })
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const harness = makeHarness({ fetchImpl: noDeveloperFetch });
  const result = await harness.call("/submit", {
    initData: "player-init",
    category: "Другое",
    description: "Как играть в эту игру и где найти правила?"
  });
  assert.equal(result.statusCode, 201);
  await waitFor(() => harness.ticketRows[0]?.notification_status === "not_needed");
  assert.equal(harness.fetchCalls.some(item => item.url.includes("api.telegram.org/bot")), false);
  assert.match(harness.ticketRows[0].ai_summary, /Нужен разработчик: нет/);
});

test("limits repeated support submissions", async () => {
  const harness = makeHarness();
  const submit = () => harness.call("/submit", {
    initData: "player-init",
    category: "Другое",
    description: "Проверочная заявка о проблеме в игре."
  });
  const first = await submit();
  const second = await submit();
  const third = await submit();
  const fourth = await submit();
  assert.deepEqual([first.statusCode, second.statusCode, third.statusCode], [201, 201, 201]);
  assert.equal(fourth.statusCode, 429);
  assert.equal(harness.inserted.length, 3);
});

test("admin-only inbox rejects players and lists tickets for owner", async () => {
  const harness = makeHarness();
  const rejected = await harness.call("/admin/list", { initData: "player-init" });
  assert.equal(rejected.statusCode, 403);

  const created = await harness.call("/submit", {
    initData: "player-init",
    category: "Ошибка или вылет",
    description: "При открытии комнаты появляется ошибка."
  });
  assert.equal(created.statusCode, 201);

  const listed = await harness.call("/admin/list", { initData: "admin-init" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.payload.admin, true);
  assert.equal(listed.payload.tickets.length, 1);
  assert.equal(listed.payload.tickets[0].telegram_id, "123");
});

test("admin can change ticket status; non-admin cannot", async () => {
  const harness = makeHarness();
  const created = await harness.call("/submit", {
    initData: "player-init",
    category: "Другое",
    description: "Проблема возникает при входе в игру."
  });
  assert.equal(created.statusCode, 201);

  const denied = await harness.call("/admin/status", { initData: "player-init", ticketId: "15", status: "resolved" });
  assert.equal(denied.statusCode, 403);

  const invalid = await harness.call("/admin/status", { initData: "admin-init", ticketId: "15", status: "invalid" });
  assert.equal(invalid.statusCode, 400);

  const accepted = await harness.call("/admin/status", { initData: "admin-init", ticketId: "15", status: "resolved" });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.payload.status, "resolved");
});
