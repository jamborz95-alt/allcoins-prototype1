import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const router = await readFile(new URL("../server/drag-racing-router.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server/server.js", import.meta.url), "utf8");
const page = await readFile(new URL("../drag-racing.html", import.meta.url), "utf8");
const index = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("Drag Racing API is registered and validates Telegram identity", () => {
  assert.match(server, /createDragRacingRouter/);
  assert.match(server, /app\.use\("\/api\/drag-racing", dragRacingRouter\)/);
  assert.match(router, /verifyTelegram\(req\.body\?\.initData\)/);
  assert.match(router, /count<2\|\|count>5/);
  assert.match(router, /Ставка должна быть не меньше 100 AC/);
});

test("Drag Racing room stake is debited transactionally and room cancellation refunds entrants", () => {
  assert.match(router, /await client\.query\("BEGIN"\)/);
  assert.match(router, /UPDATE players SET balance=balance-\$1::BIGINT/);
  assert.match(router, /UPDATE players SET balance=balance\+\$1::BIGINT/);
  assert.match(router, /for\(const p of all\.rows\)await credit\(client,p\.id,stake\)/);
  assert.match(router, /recordGameCommission\(client,\{game:"drag-racing",eventKey:"drag-racing:"\+id/);
  assert.match(router, /game\.settled=true/);
});

test("Drag Racing garage purchases are persisted and server-priced", () => {
  assert.match(router, /drag_racing_garage/);
  assert.match(router, /priora:329000,granta:850000,niva:1099000,vesta:1558000/);
  assert.match(router, /ecu:25000,intake:18000,exhaust:32000,turbo:95000/);
  assert.match(router, /router\.post\("\/shop\/buy-car"/);
  assert.match(router, /router\.post\("\/shop\/buy-part"/);
  assert.match(router, /router\.post\("\/tuning\/save"/);
});

test("Drag Racing screen is linked from Games and uses real online room APIs", () => {
  assert.match(index, /id="dragRacingEntry"/);
  assert.match(index, /\.\/drag-racing\.html\?v=/);
  assert.match(page, /data-gear/);
  assert.match(page, /СЦЕПЛЕНИЕ/);
  assert.match(page, /ГАЗ/);
  assert.match(page, /apiPost\('\/rooms\/state'/);
  assert.match(page, /apiPost\('\/rooms\/action'/);
  assert.match(page, /apiPost\('\/shop\/buy-car'/);
});
