import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const router = await readFile(new URL("../server/drag-racing-router.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server/server.js", import.meta.url), "utf8");
const page = await readFile(new URL("../drag-racing.html", import.meta.url), "utf8");
const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const scene3d = await readFile(new URL("../drag-racing-3d.js", import.meta.url), "utf8");

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
  assert.match(router, /recordDragRacingCommission\(client,\{eventKey:"drag-racing:"\+id/);
  assert.match(router, /settled:true/);
});


test("Drag Racing commission uses exact BIGINT arithmetic and credits the configured admin once", () => {
  assert.match(router, /async function recordDragRacingCommission\(client,\{eventKey,grossAmount\}\)/);
  assert.match(router, /const amount=gross\*5n\/100n/);
  assert.match(router, /INSERT INTO allcoins_commissions/);
  assert.match(router, /ON CONFLICT\(event_key\) DO NOTHING RETURNING id/);
  assert.match(router, /configuredAdminTelegramId\(\)/);
  assert.match(router, /balance=balance\+\$1::BIGINT/);
});

test("A racer cannot change the car, buy performance parts, or enter a second active room mid-race", () => {
  assert.match(router, /async function ensureNotInActiveRace\(client,userId\)/);
  assert.match(router, /r\.status IN \('waiting','playing'\)/);
  assert.equal((router.match(/ensureNotInActiveRace\(client,user\.id\)/g)||[]).length,6);
});

test("Drag Racing garage purchases are persisted and server-priced", () => {
  assert.match(router, /drag_racing_garage/);
  assert.match(router, /"2104":95000,"2105":75000,"2106":85000,"2109":125000,"2110":165000,"2112":205000,"2114":220000/);
  assert.match(router, /"priora":329000,"granta":850000,"niva":1099000,"vesta":1558000/);
  for (const model of ["2104", "2105", "2106", "2109", "2110", "2112", "2114"]) assert.ok(page.includes("id:'" + model + "'"));
  assert.match(router, /ecu:25000,intake:18000,exhaust:32000,turbo:95000/);
  assert.match(router, /router\.post\("\/shop\/buy-car"/);
  assert.match(router, /router\.post\("\/shop\/buy-part"/);
  assert.match(router, /router\.post\("\/tuning\/save"/);
});


test("Drag Racing uses a realtime 3D scene and vehicle upgrades affect authoritative race physics", () => {
  assert.match(page, /id="race3dCanvas"/);
  assert.match(page, /drag-racing-3d\.js\?v=/);
  assert.match(scene3d, /three\.module\.js/);
  assert.match(scene3d, /new THREE\.WebGLRenderer/);
  assert.match(scene3d, /new THREE\.PerspectiveCamera/);
  assert.match(scene3d, /new THREE\.BoxGeometry/);
  assert.match(router, /const carSpecs=/);
  assert.match(router, /engineFactor=/);
  assert.match(router, /gripFactor=/);
  assert.match(router, /const accel=1\.05\*ratio/);
  assert.match(router, /p\.upgrades/);
  assert.match(router, /p\.tuning/);
  assert.match(router, /ADD COLUMN IF NOT EXISTS gear_changed_at/);
  assert.match(router, /gear_changed_at=CASE WHEN gear<>\$3 THEN NOW\(\)/);
  assert.match(router, /const shiftFactor=sinceShift < shiftWindow \? 0\.15 : 1/);
  assert.match(router, /const upgradePower=\{ecu:8,intake:5,exhaust:7,turbo:22\}/);
  assert.match(page, /upg\(\)\.tires\?0\.12:0/);
  assert.match(page, /car\(\)\.weight\*\(upg\(\)\.weight\?0\.9:1\)/);
});



test("Online countdown lights, race animation class and winner status follow server phase", () => {
  assert.match(page, /classList\.toggle\('racing',isRacing\)/);
  assert.match(page, /room\.game\?\.phase==='countdown'/);
  assert.match(page, /room\.game\?\.phase==='race'/);
  assert.match(page, /room\.game\.startAt/);
});

test("Online gear shifts are sent immediately and disconnected throttle input times out", () => {
  assert.match(page, /queueOnlineAction\(\)\}/);
  assert.match(router, /p\.last_seen_at,p\.gear_changed_at,g\.upgrades,g\.tuning/);
  assert.match(router, /const activeInput=Date\.now\(\)-new Date\(p\.last_seen_at\|\|0\)\.getTime\(\)<4000/);
  assert.match(router, /if\(!throttleInput\)speed=Math\.max\(0,speed-dt\*0\.65\)/);
});



test("A guest whose waiting room is cancelled stops polling the deleted room", () => {
  assert.match(page, /catch\(error\)\{if\(\/Комната не найдена\|Ты не участник этой комнаты\//);
  assert.match(page, /stopOnlineRoom\(\);\$\('roomStatus'\)\.textContent='Комната закрыта/);
  assert.match(page, /await syncAccount\(\);await loadRooms\(\);return\}throw error/);
});

test("Online race polling does not overlap and 3D race view receives every participant", () => {
  assert.match(page, /onlinePollBusy=false/);
  assert.match(page, /if\(!activeOnlineRoomId\|\|onlinePollBusy\)return/);
  assert.match(page, /window\.__allcoinsRaceState=\{room,players\}/);
  assert.match(scene3d, /const opponentCars=new Map\(\)/);
  assert.match(scene3d, /allcoins:race-state/);
  assert.match(scene3d, /player\.distance/);
  assert.match(router, /bestFinishFraction=Infinity/);
});

test("Abandoned waiting rooms refund each reserved stake before cleanup", () => {
  assert.match(router, /async function cleanupDormantRooms\(\)/);
  assert.match(router, /r\.status='waiting'.*last_seen_at>NOW\(\)-INTERVAL '2 minutes'/);
  assert.match(router, /for\(const player of players\)await credit\(client,player\.id,room\.stake\)/);
  assert.match(router, /await client\.query\("DELETE FROM drag_racing_rooms WHERE id=\$1",\[item\.id\]\)/);
});

test("A finished racer may close the result screen without refunding or altering the pot", () => {
  assert.match(router, /if\(room\.status==="finished"\)\{const finishedMember=/);
  assert.match(router, /finished:true,refunded:false/);
});

test("Completed Drag Racing rooms disappear after the result grace period without changing balances", () => {
  assert.match(router, /DELETE FROM drag_racing_rooms WHERE status='finished' AND updated_at < NOW\(\)-INTERVAL '2 minutes'/);
  assert.match(router, /if\(typeof cleanupTimer\.unref==="function"\)cleanupTimer\.unref\(\)/);
  assert.match(router, /Object\.hasOwn\(carPrices,car\)/);
  assert.match(router, /Object\.hasOwn\(partPrices,part\)/);
});


test("Large AC balances and stakes retain integer precision in the browser", () => {
  assert.match(page, /inputmode="numeric"/);
  assert.match(page, /stakeText=\$\('stake'\)\.value\.trim\(\)\.replace/);
  assert.match(page, /BigInt\(stakeText\)/);
  assert.match(page, /BigInt\(room\.stake\)\*BigInt\(players\.length\)/);
  assert.match(page, /state\.balance=String\(data\.balance\)/);
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
