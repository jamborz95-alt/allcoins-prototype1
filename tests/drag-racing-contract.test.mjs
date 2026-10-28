import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
const router = readFileSync(new URL("../server/drag-racing-router.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../drag-racing.html", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("Drag Racing API is mounted and initialized with the same server wallet", () => {
  assert.match(server, /createDragRacingRouter\(\{\s*pool,\s*verifyTelegram,\s*recordGameCommission\s*\}\)/);
  assert.match(server, /app\.use\("\/api\/drag-racing",\s*dragRacingRouter\)/);
  assert.match(server, /await dragRacingRouter\.initialize\(\)/);
});

test("online rooms enforce Telegram identity, room size, valid modes and server-side stakes", () => {
  assert.match(router, /verifyTelegram\(req\.body\?\.initData\)/);
  assert.match(router, /max_players INTEGER NOT NULL CHECK \(max_players BETWEEN 2 AND 5\)/);
  assert.match(router, /VALID_MODES/);
  assert.match(router, /UPDATE players SET balance = balance - \$1::BIGINT/);
  assert.match(router, /FOR UPDATE/);
});

test("payouts are settled once and include the shared 5 percent ALLCOINS commission ledger", () => {
  assert.match(router, /recordGameCommission\(client,\s*\{/);
  assert.match(router, /eventKey:\s*"drag-racing:" \+ String\(room\.id\)/);
  assert.match(router, /status = 'finished', game_state = \$2::jsonb/);
  assert.match(router, /Комиссию 5%|комиссии 5%|комиссия 5%/i);
});

test("cheap VAZ garage and menu link are present", () => {
  for (const model of ["ВАЗ-2101 «Копейка»", "ВАЗ-2104", "ВАЗ-2105", "ВАЗ-2106", "ВАЗ-2109"]) assert.ok(page.includes(model), model);
  assert.match(router, /"2101": \{ price: 2500, power: 58 \}/);
  assert.match(router, /"2104": \{ price: 4500/);
  assert.match(index, /id="dragRacingEntry"/);
  assert.match(index, /href="\.\/drag-racing\.html\?v=20261028-sideview11"/);
});

test("car purchases, upgrades and tuning are verified and persisted server-side", () => {
  assert.match(router, /router\.post\("\/garage\/buy"/);
  assert.match(router, /router\.post\("\/garage\/upgrade"/);
  assert.match(router, /router\.post\("\/garage\/tune"/);
  assert.match(router, /drag_racing_player_cars/);
  assert.match(router, /drag_racing_player_profiles/);
});

test("abandoned waiting rooms refund stakes before cleanup and finished rooms expire", () => {
  assert.match(router, /last_seen_at >= NOW\(\) - INTERVAL '2 minutes'/);
  assert.match(router, /UPDATE players SET balance = balance \+ \$1::BIGINT/);
  assert.match(router, /DELETE FROM drag_racing_rooms WHERE status = 'finished' AND updated_at < NOW\(\) - INTERVAL '2 minutes'/);
  assert.match(router, /timeMs \+ 2500 < elapsedSinceGreen/);
});
