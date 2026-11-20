import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  calculateGameCommission,
  configuredAdminTelegramId,
  recordGameCommission
} from "../server/commission.js";

const [serverSource, checkersSource, lottoSource, sekaSource, rpsSource, clientSource] = await Promise.all([
  readFile(new URL("../server/server.js", import.meta.url), "utf8"),
  readFile(new URL("../server/checkers-router.js", import.meta.url), "utf8"),
  readFile(new URL("../server/lotto.js", import.meta.url), "utf8"),
  readFile(new URL("../server/seka-router.js", import.meta.url), "utf8"),
  readFile(new URL("../server/rps-router.js", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8")
]);

test("commission is 5 percent rounded down to whole AC", () => {
  assert.equal(calculateGameCommission(100), 5);
  assert.equal(calculateGameCommission(10_000), 500);
  assert.equal(calculateGameCommission(19), 0);
  assert.equal(calculateGameCommission(-100), 0);
  assert.equal(calculateGameCommission("invalid"), 0);
});

test("admin Telegram ID accepts only positive BIGINT values and normalizes leading zeroes", () => {
  const original = process.env.ADMIN_TELEGRAM_ID;
  try {
    process.env.ADMIN_TELEGRAM_ID = "000123456";
    assert.equal(configuredAdminTelegramId(), "123456");
    process.env.ADMIN_TELEGRAM_ID = "0";
    assert.equal(configuredAdminTelegramId(), null);
    process.env.ADMIN_TELEGRAM_ID = "123abc";
    assert.equal(configuredAdminTelegramId(), null);
    process.env.ADMIN_TELEGRAM_ID = "9223372036854775808";
    assert.equal(configuredAdminTelegramId(), null);
    delete process.env.ADMIN_TELEGRAM_ID;
    assert.equal(configuredAdminTelegramId(), null);
  } finally {
    if (original === undefined) delete process.env.ADMIN_TELEGRAM_ID;
    else process.env.ADMIN_TELEGRAM_ID = original;
  }
});

test("a winning game credits the admin once and computes the fee from the gross bank", async () => {
  const original = process.env.ADMIN_TELEGRAM_ID;
  process.env.ADMIN_TELEGRAM_ID = "123456";
  const calls = [];
  try {
    const client = {
      async query(sql, params = []) {
        calls.push({ sql: String(sql), params });
        if (String(sql).includes("INSERT INTO allcoins_commissions")) return { rows: [{ id: "8" }] };
        if (String(sql).includes("UPDATE players SET balance = balance + $1::BIGINT")) return { rows: [{ balance: "150" }] };
        if (String(sql).includes("INSERT INTO players")) return { rows: [] };
        throw new Error("Unexpected SQL in commission test: " + sql);
      }
    };
    const result = await recordGameCommission(client, {
      game: "rps",
      eventKey: "rps:77:2",
      grossAmount: 1_000
    });
    assert.equal(result.amount, 50);
    assert.equal(result.credited, true);
    const ledger = calls.find(call => call.sql.includes("INSERT INTO allcoins_commissions"));
    assert.deepEqual(ledger.params, ["rps", "rps:77:2", "1000", "50", "123456"]);
    const credit = calls.find(call => call.sql.includes("UPDATE players SET balance = balance + $1::BIGINT"));
    assert.deepEqual(credit.params, ["50", "123456"]);
  } finally {
    if (original === undefined) delete process.env.ADMIN_TELEGRAM_ID;
    else process.env.ADMIN_TELEGRAM_ID = original;
  }
});

test("practice bot games never incur a commission", async () => {
  let calls = 0;
  const result = await recordGameCommission({
    async query() { calls++; throw new Error("No ledger write expected for test mode"); }
  }, {
    game: "rps",
    eventKey: "rps:test",
    grossAmount: 1000,
    testMode: true
  });
  assert.equal(result.skipped, true);
  assert.equal(result.amount, 0);
  assert.equal(calls, 0);
});

test("all server-settled online games route commissions through one ledger", () => {
  // Checkers settles the finishing move, winner payout and 5% commission in one guarded transaction.
  assert.match(checkersSource, /game: "checkers"/);
  assert.match(checkersSource, /eventKey: "checkers:"/);
  assert.match(checkersSource, /const gross = BigInt\(String\(room\.stake\)\) \* 2n/);
  assert.match(checkersSource, /const payout = gross - commission/);
  assert.match(checkersSource, /UPDATE players SET balance = balance \+ \$1::BIGINT/);
  assert.match(checkersSource, /state\.settlementApplied = true/);
  assert.match(checkersSource, /state\.status !== "finished" \|\| state\.settlementApplied/);

  assert.match(serverSource, /initializeCommissionTables\(pool\)/);
  assert.match(serverSource, /game: "durak"/);
  assert.match(serverSource, /eventKey: "durak:"/);
  assert.match(serverSource, /grossProfit/);
  assert.match(serverSource, /game: "twentyone"/);
  assert.match(serverSource, /eventKey: "twentyone:"/);
  assert.match(lottoSource, /game: "lotto"/);
  assert.match(lottoSource, /eventKey: "lotto:"/);
  assert.match(sekaSource, /game: "seka"/);
  assert.match(sekaSource, /const payoutPool = Math\.max\(0, totalPot - commissionAmount\)/);
  assert.match(rpsSource, /game: "rps"/);
  assert.match(rpsSource, /const payoutPool = Math\.max\(0, pot - commissionAmount\)/);
});

test("admin endpoint verifies Telegram identity before showing and claiming commission", () => {
  const marker = 'app.post("/api/admin/summary", async (req, res) => {';
  const start = serverSource.indexOf(marker);
  assert.notEqual(start, -1, "Admin summary route should exist");
  const end = serverSource.indexOf("\napp.post(", start + marker.length);
  const route = serverSource.slice(start, end < 0 ? serverSource.length : end);
  assert.match(route, /verifyTelegram\(req\.body\?\.initData/);
  assert.match(route, /configuredAdminTelegramId\(\)/);
  assert.match(route, /String\(user\.id\) !== adminId/);
  assert.match(route, /claimPendingCommissions\(client, adminId\)/);
  assert.match(route, /getAdminCommissionSummary\(client, adminId\)/);
  assert.match(clientSource, /id="adminCommissionCard" class="card hidden"/);
  assert.match(clientSource, /apiRequest\("\/api\/admin\/summary"\)/);
});
