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
  assert.match(index, /href="\.\/drag-racing\.html\?v=20261028-png2"/);
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
  assert.match(router, /isValidDragRaceFinishTime\(timeMs, elapsedSinceGreen\)/);
});

test("finish-time validation rejects instant and forged results but tolerates small network drift", () => {
  assert.match(router, /const MIN_RACE_FINISH_MS = 7000/);
  assert.match(router, /const MAX_FINISH_TIME_DRIFT_MS = 2500/);
  const match = router.match(/function isValidDragRaceFinishTime\(timeMs, elapsedSinceGreen\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "production finish validator exists");
  const validator = new Function(
    "MIN_RACE_FINISH_MS",
    "MAX_FINISH_TIME_DRIFT_MS",
    "return function isValidDragRaceFinishTime(timeMs, elapsedSinceGreen) {" + match[1] + "\n}"
  )(7000, 2500);
  assert.equal(validator(1000, 1000), false, "instant result is rejected");
  assert.equal(validator(6900, 6900), false, "sub-minimum result is rejected");
  assert.equal(validator(9000, 5000), false, "impossibly early reported time is rejected");
  assert.equal(validator(5000, 9000), false, "inconsistent server elapsed time is rejected");
  assert.equal(validator(12000, 13000), true, "small transport delay is accepted");
  assert.equal(validator(12000, 12000), true, "matching client/server result is accepted");
  assert.equal(validator(12000, Number.NaN), false, "invalid elapsed time is rejected");
});

test("concurrent room joins serialize on the shared player balance before checking memberships", () => {
  const start = router.indexOf('router.post("/rooms/join"');
  const end = router.indexOf('router.post("/rooms/start"', start);
  assert.ok(start >= 0 && end > start, "join route exists");
  const joinRoute = router.slice(start, end);
  const balanceLock = joinRoute.indexOf("const balance = await lockPlayerBalance(client, user)");
  const activeRoomCheck = joinRoute.indexOf("const active = await client.query(");
  assert.ok(balanceLock >= 0 && activeRoomCheck > balanceLock, "the player row is locked before checking active-room membership");
});

test("car travel and track motion scale up as speed increases", () => {
  const updaterStart = page.indexOf("function updateRace2DEnvironment(dt){");
  const updaterEnd = page.indexOf("\n}", updaterStart);
  assert.ok(updaterStart >= 0 && updaterEnd > updaterStart, "race scenery update function exists");
  const updater = page.slice(updaterStart, updaterEnd);
  assert.match(updater, /raceWorldOffset\+=Math\.max\(0,speed\)\/3\.6\*dt\*4\.8\*scale/);
  const carPositionStart = page.indexOf("function getRaceCarMotion(){");
  const carPositionEnd = page.indexOf("\n}", carPositionStart);
  assert.ok(carPositionStart >= 0 && carPositionEnd > carPositionStart, "car motion calculation exists");
  const carPosition = page.slice(carPositionStart, carPositionEnd);
  assert.match(carPosition, /racePeakSpeed=Math\.max\(racePeakSpeed,currentSpeed\)/);
  assert.match(carPosition, /const shiftPercent=8\*speedLead\+36\*progress/);
  assert.match(page, /racePeakSpeed=0/ , "a new race resets the speed lead");
  assert.match(page, /Math\.max\(\.035,\.48\/\(1\+speedNow\/18\)\)/, "wheel spin keeps getting faster at high speed");
});

test("smooth car and camera tracking with a clean finish straight and clear finish gate", () => {
  assert.match(page, /id="race2dCameraWorld" class="race2d-camera-world"/);
  assert.match(page, /function updateRaceCarPosition\(dt=1\/60\)/);
  assert.match(page, /raceCarOffset\+=\(motion\.shiftPx-raceCarOffset\)\*response/);
  assert.match(page, /function updateRace2DCamera\(dt=1\/60\)/);
  assert.match(page, /const targetX=Math\.max\(0,carShift-motion\.sceneWidth\*\.08\)/);
  assert.match(page, /Math\.exp\(-Math\.max\(0,dt\)\*\(running\?42:24\)\)/);
  assert.match(page, /raceCameraOffset\+=\(targetX-raceCameraOffset\)\*follow/);
  assert.match(page, /id="race2dFinishGate"/);
  assert.match(page, /id="race2dFinishStraight"/);
  const finishSurfaceCss = page.match(/\.race2d-finish-straight\s*\{([^}]*)\}/s);
  assert.ok(finishSurfaceCss, "the finish-straight surface should be present");
  assert.doesNotMatch(finishSurfaceCss[1], /repeating-linear-gradient/, "the finish approach must not add artificial stripes");
  assert.match(page, /scene\.classList\.toggle\('race-finish-approach',progress>=\.58\)/);
  assert.match(page, /scene\.classList\.toggle\('race-near-finish',progress>=\.82\)/);
  assert.match(page, /updateRace2DEnvironment\(0\);/);
});

test("drag race motion is frame-synced and the cockpit has separated shifters and a physical-style gas pedal", () => {
  const positionFn = page.match(/function updateRaceCarPosition\(dt=1\/60\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(positionFn, "car position updater exists");
  assert.match(positionFn[1], /player\.style\.transform\s*=\s*'translate3d\('/);
  assert.doesNotMatch(positionFn[1], /player\.style\.left\s*=/, "car position avoids per-frame layout changes");

  assert.match(page, /Final handling pass: smooth car tracking, widely spaced shifters and a real pedal silhouette/);
  assert.match(page, /\.race2d-car\.player\s*\{[^}]*transition:none!important/s);
  assert.match(page, /city\.style\.transform='translate3d\('/, "Scenery should move by transforms rather than per-frame background repaints");
  assert.match(page, /will-change:transform!important;backface-visibility:hidden/);
  assert.match(page, /function drawFrame\(now\)\s*\{[\s\S]*?const dt=lastVisualFrame\?[\s\S]*?raceVisual\.update\(distance,speed,rpm,gasHeld,dt,now\)/);
  assert.match(page, /\.pro-shift-paddle\.up\s*\{top:2%!important\}/);
  assert.match(page, /\.pro-shift-paddle\.down\s*\{bottom:2%!important\}/);
  assert.match(page, /repeating-linear-gradient\(0deg,#171c1f 0 5px,#c8cece 5px 7px,#717a7d 7px 9px\)/);
  assert.match(page, /\.pro-dash-controls #proGasHold\.held\s*\{/);
});

test("VAZ-2107 uses the high-resolution orthographic side-view PNG in the race scene", () => {
  assert.ok(page.includes('src="./cars/lada-2107.png?v=20261028-png2"'), "The race scene should load the updated VAZ side-view sprite.");
  assert.match(page, /aspect-ratio:1024 \/ 364!important/, "PNG layout should keep the side-profile aspect ratio.");
  assert.match(page, /png-wheel-spin\.rear\{left:14\.5%;top:56%;width:16\.5%\}/, "Rear wheel overlay should align with the side-view PNG.");
  assert.match(page, /png-wheel-spin\.front\{left:73\.6%;top:56%;width:17\.8%\}/, "Front wheel overlay should align with the side-view PNG.");
});
