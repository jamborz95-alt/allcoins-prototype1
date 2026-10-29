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

test("online racing shares bounded per-player speed and progress telemetry", () => {
  assert.match(router, /const RACE_DISTANCE_METERS = Object\.freeze\(\{ quarter: 1609\.344, half: 3218\.688, sprint: 4000 \}\)/);
  assert.match(router, /const telemetry = req\.body\?\.telemetry/);
  assert.match(router, /speedKmh >= 0 && speedKmh <= 400/);
  assert.match(router, /distanceM <= maxDistance \+ 50/);
  assert.match(router, /motionByPlayer\[user\.id\] = \{/);
  assert.match(router, /fresh: motionAgeMs <= 1900/);
  assert.match(page, /function raceTelemetryPayload\(\)/);
  assert.match(page, /payload\.telemetry=raceTelemetryPayload\(\)/);
  assert.match(page, /function updateOnlineOpponentMotion\(dt\)/);
  assert.match(page, /opponent\.style\.left=onlineOpponentMotion\.left\.toFixed\(2\)/);
  assert.match(page, /opponent-wheel-spin/);
  assert.match(page, /--opponent-wheel-duration/);
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
  assert.match(index, /href="\.\/drag-racing-v2\.html\?v=20261029-garage3"/);
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


test("online opponent renders the actual selected model as PNG, not the hardcoded SVG", () => {
  assert.match(page, /function syncOnlineOpponentCar\(\)/);
  assert.match(page, /players\.find\(player=>!player\.isYou\)/, "Opponent art must use the other player's room record.");
  assert.match(page, /const requestedId=String\(rival\.carId\|\|'2107'\)/, "Opponent model must come from the rival's selected carId.");
  assert.match(page, /lada-2107-side\.png\?v=20261029-opponent-entry1/, "The VAZ-2107 rival must use the authored side-view PNG.");
  assert.match(page, /function carSvgToPngDataUrl\(modelId,paint\)/, "Other selected models must be delivered as PNG raster images.");
  assert.match(page, /image\.className='opponent-car-png'/, "The opponent slot must render an image element.");
  assert.match(page, /\.race2d-car\.png-opponent-car\{[\s\S]*opacity:1!important;visibility:visible!important;transform:scale\(1\)!important/, "The opponent PNG must be visible immediately instead of being hidden until a race-state toggle.");
  assert.doesNotMatch(page, /opponent\.innerHTML=carSvg\('2110'/, "The fixed old VAZ-2110 SVG must not be used for the opponent.");
});

test("car travel and track motion scale up as speed increases", () => {
  const updaterStart = page.indexOf("function updateRace2DEnvironment(dt){");
  const updaterEnd = page.indexOf("\n}", updaterStart);
  assert.ok(updaterStart >= 0 && updaterEnd > updaterStart, "race scenery update function exists");
  const updater = page.slice(updaterStart, updaterEnd);
  assert.match(updater, /raceWorldOffset\+=Math\.max\(0,speed\)\/3\.6\*dt\*9\.6\*scale/);
  const carPositionStart = page.indexOf("function getRaceCarMotion(){");
  const carPositionEnd = page.indexOf("\n}", carPositionStart);
  assert.ok(carPositionStart >= 0 && carPositionEnd > carPositionStart, "car motion calculation exists");
  const carPosition = page.slice(carPositionStart, carPositionEnd);
  assert.match(carPosition, /racePeakSpeed=Math\.max\(racePeakSpeed,currentSpeed\)/);
  assert.match(carPosition, /const shiftPercent=18\*speedLead\+52\*progress/);
  assert.match(page, /racePeakSpeed=0/ , "a new race resets the speed lead");
  assert.match(page, /Math\.max\(\.035,\.48\/\(1\+speedNow\/18\)\)/, "wheel spin keeps getting faster at high speed");
});


test("drag strip is four times longer and uses a vertical checkered finish line", () => {
  assert.match(page, /const distanceByMode=\{quarter:1609\.344,half:3218\.688,sprint:4000\}/);
  assert.match(page, /\.race2d-environment\{width:1280%!important;right:auto!important\}/, "The race environment should be four times wider than before.");
  assert.match(page, /\.race2d-road-surface\{[^}]*overflow:hidden[^}]*\}/, "The asphalt surface must clip the finish marking to the road edges.");
  assert.match(page, /\.race2d-finish-road-stripe\{[\s\S]*top:0;bottom:clamp\(10px,2%,20px\);width:clamp\(14px,1\.45vw,20px\)/, "The vertical finish stripe must stay inset from the road edges.");
  assert.match(page, /background:repeating-conic-gradient\(#111416 0 25%,#fffbed 0 50%\) 50%\/8px 8px/, "The finish stripe should use a crisp checkered pattern.");
  assert.match(page, /<div class="race2d-finish-straight" id="race2dFinishStraight" aria-hidden="true"><\/div>\s*<div class="race2d-finish-road-stripe" id="race2dFinishStripe" aria-hidden="true"><\/div>\s*<\/div>/, "The finish stripe must be a child of the asphalt surface.");
  assert.match(page, /background:repeating-conic-gradient\(#111416 0 25%,#fffbed 0 50%\) 50%\/8px 8px/, "The finish stripe should use neat checkered squares.");
  assert.match(page, /raceDistanceLabels=\{quarter:'DRAG STRIP · 1 MILE',half:'DRAG STRIP · 2 MILES',sprint:'DRAG STRIP · 4 KM'\}/);
});

test("smooth car and camera tracking with a clean finish straight and clear finish gate", () => {
  assert.match(page, /id="race2dCameraWorld" class="race2d-camera-world"/);
  assert.match(page, /function updateRaceCarPosition\(dt=1\/60\)/);
  assert.match(page, /raceCarOffset\+=\(motion\.shiftPx-raceCarOffset\)\*response/);
  assert.match(page, /function updateRace2DCamera\(dt=1\/60\)/);
  assert.match(page, /const targetX=Math\.max\(0,carShift-motion\.sceneWidth\*\.32\)/);
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

test("VAZ-2107 uses the real side-profile PNG and rotating wheel faces", () => {
  assert.match(page, /const ladaPreview='<img class="race-car-png" src="\.\/cars\/lada-2107-side\.png\?v=20261029-wheel2"/, "The selected VAZ-2107 should use the transparent side-profile PNG.");
  assert.match(page, /const ladaWheels='<span class="png-wheel-spin rear"/, "The VAZ-2107 should have a separate rear wheel rotor.");
  assert.match(page, /<span class="png-wheel-spin front"/, "The VAZ-2107 should have a separate front wheel rotor.");
  assert.match(page, /player\.innerHTML=useLadaPng\?ladaPreview\+ladaWheels:carSvg\(selectedId,paint\)/, "The rotors should be layered over the real PNG for the VAZ-2107.");
  assert.match(page, /\.race2d-car\.png-car \.png-wheel-spin\.rear\{left:18\.2%!important\}/, "The rear wheel rotor should align with the PNG rim.");
  assert.match(page, /\.race2d-car\.png-car \.png-wheel-spin\.front\{left:76\.3%!important\}/, "The front wheel rotor should align with the PNG rim.");
  assert.match(page, /\.pro-race-cockpit\.race-moving \.race2d-car\.png-car \.png-wheel-spin\{[\s\S]*?animation:race2d-wheel-spin var\(--race-wheel-duration,\.24s\) linear infinite!important/, "Both PNG wheel rotors should spin during a race.");
});
