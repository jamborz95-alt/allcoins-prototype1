import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const html = await readFile(resolve(root, "drag-racing.html"), "utf8");
const threeJs = await readFile(resolve(root, "three.min.js"), "utf8");
const ladaPng = await readFile(resolve(root, "cars", "lada-2107.png"));
const ladaSidePng = await readFile(resolve(root, "cars", "lada-2107-side.png"));
await mkdir(resolve(root, "artifacts"), { recursive: true });
const indexHtml = await readFile(resolve(root, "index.html"), "utf8");
await readFile(resolve(root, "server/drag-racing-router.js"), "utf8");
assert.ok(indexHtml.includes('id="dragRacingEntry"'), "The game tile should be present in ALLCOINS.");
assert.ok(indexHtml.includes('href="./drag-racing-v2.html?v=20261029-physicsfinishlights2"'), "The game tile should link to the current drag racing page with performance fixes.");
assert.match(html, /nextRoadBumpAt=40/, "The first uneven-road threshold must be initialized and restored on reset.");
assert.doesNotMatch(html, /void scene\.offsetWidth/, "Road bump animations must not force synchronous layout on every trigger.");
assert.match(html, /now-lastEngineAudioUpdateAt>=50/, "Engine audio updates must be throttled to keep mobile rendering smooth.");
assert.match(html, /mode==='racing'\?250:1800/, "Online race snapshots should not overload the room endpoint.");

let balance = 10000;
let ownedCars = ["2107"];
let selectedCarId = "2107";
let upgrades = { "2107": {} };
let tune = { ecu: 50, boost: 25, grip: 70, shift: 45 };
let activeRoom = null;
let opponentTelemetryTick = 0;
let forcedOpponentProgress = null;
const apiCalls = [];
const carPrices = { "2101": 2500, "2105": 3500, "2104": 4500, "2106": 6000, "2109": 7500, "2110": 11000, priora: 18000, kalina: 25000, granta: 35000, niva: 50000, vesta: 85000 };

function profilePayload() {
  return { ok: true, balance, profile: { ownedCars: [...ownedCars], selectedCarId, upgrades: structuredClone(upgrades), tune: { ...tune } } };
}
function roomPayload() {
  return { ok: true, balance, room: activeRoom.room, players: activeRoom.players, game: activeRoom.game };
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1:4174");
  if (url.pathname === "/cars/lada-2107.png" || url.pathname === "/cars/lada-2107-side.png") {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
    res.end(url.pathname === "/cars/lada-2107-side.png" ? ladaSidePng : ladaPng);
    return;
  }
  if (url.pathname === "/three.min.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600" });
    res.end(threeJs);
    return;
  }
  if (url.pathname === "/drag-racing.html" || url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});
await new Promise(resolveListen => server.listen(4174, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.__tgCalls=[];window.Telegram={WebApp:{initData:'mock-init-data',initDataUnsafe:{user:{id:12345,first_name:'Test Driver'}},ready(){},expand(){window.__tgCalls.push('expand')},requestFullscreen(){window.__tgCalls.push('fullscreen')},exitFullscreen(){window.__tgCalls.push('exit-fullscreen')},setHeaderColor(v){window.__tgCalls.push('header:'+v)},setBottomBarColor(v){window.__tgCalls.push('bottom:'+v)},BackButton:{isVisible:true,hide(){this.isVisible=false;window.__tgCalls.push('back-hide')}},MainButton:{hide(){window.__tgCalls.push('main-hide')}},SecondaryButton:{hide(){window.__tgCalls.push('secondary-hide')}},colorScheme:'dark'}};"
  }));
  await page.route("https://allcoins-server.onrender.com/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    apiCalls.push({ path: url.pathname, body });
    if (url.pathname === "/api/drag-racing/profile") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/rooms/list") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, currentRoom: activeRoom ? roomPayload() : null, rooms: []
      }) });
    }
    if (url.pathname === "/api/drag-racing/garage/buy") {
      const id = String(body.carId || "");
      const price = Number(carPrices[id] || 0);
      if (ownedCars.includes(id)) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Already owned" }) });
      if (balance < price) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Not enough" }) });
      balance -= price;
      ownedCars.push(id);
      selectedCarId = id;
      upgrades[id] = {};
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/garage/select") {
      selectedCarId = String(body.carId);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/garage/upgrade") {
      const id = String(body.carId), part = String(body.partId);
      upgrades[id] = upgrades[id] || {};
      upgrades[id][part] = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/garage/tune") {
      tune = { ...body.tune };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profilePayload()) });
    }
    if (url.pathname === "/api/drag-racing/rooms/create") {
      const stake = Number(body.stake);
      if (balance < stake) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Not enough balance" }) });
      balance -= stake;
      activeRoom = {
        room: { id: "DR-71", roomId: "71", ownerId: "12345", ownerName: "Test Driver",
          stake, maxPlayers: Number(body.maxPlayers), playersCount: 2, mode: body.mode,
          status: "waiting", isOwner: true },
        players: [
          { id: "12345", name: "Test Driver", carId: selectedCarId, isYou: true, isOwner: true, connected: true, finishTimeMs: null },
          { id: "67890", name: "Online Rival", carId: "2107", isYou: false, isOwner: false, connected: true, finishTimeMs: null }
        ],
        game: { phase: "waiting", startedAt: null, results: {}, winners: [], payout: 0, commission: 0, message: "" }
      };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(roomPayload()) });
    }
    if (url.pathname === "/api/drag-racing/rooms/state") {
      if (activeRoom?.room.status === "racing") {
        const ownPlayer = activeRoom.players.find(player => player.isYou);
        if (body.telemetry && ownPlayer) {
          const distanceM = Math.max(0, Number(body.telemetry.distanceM) || 0);
          ownPlayer.motion = {
            speedKmh: Number(body.telemetry.speedKmh) || 0,
            distanceM,
            progress: Math.min(1, distanceM / 1609.344),
            gear: Number(body.telemetry.gear) || 0,
            updatedAt: Date.now(),
            fresh: true
          };
        }
        const rival = activeRoom.players.find(player => !player.isYou);
        if (rival) {
          opponentTelemetryTick += 1;
          const localDistance = Math.max(0, Number(ownPlayer?.motion?.distanceM) || 0);
          const distanceM = forcedOpponentProgress === "match"
            ? localDistance
            : typeof forcedOpponentProgress === "number"
              ? Math.max(0, Math.min(1609.344, forcedOpponentProgress * 1609.344))
              : Math.min(1500, 25 + opponentTelemetryTick * 70);
          rival.motion = {
            speedKmh: forcedOpponentProgress === "match" ? Math.min(280, Number(ownPlayer?.motion?.speedKmh) || 0) : Math.min(280, 75 + opponentTelemetryTick * 22),
            distanceM,
            progress: Math.min(1, distanceM / 1609.344),
            gear: Math.min(5, 1 + Math.floor(opponentTelemetryTick / 3)),
            updatedAt: Date.now(),
            fresh: true
          };
        }
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(roomPayload()) });
    }
    if (url.pathname === "/api/drag-racing/rooms/leave") {
      if (activeRoom?.room.status === "waiting") balance += activeRoom.room.stake;
      activeRoom = null;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, balance, message: "Left room" }) });
    }
    if (url.pathname === "/api/drag-racing/rooms/start") {
      activeRoom.room.status = "racing";
      activeRoom.game = { phase: "racing", startedAt: Date.now(), results: {}, winners: [], payout: 0, commission: 0, message: "" };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(roomPayload()) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Mock route not found" }) });
  });

  await page.goto("http://127.0.0.1:4174/drag-racing.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#race2dEnvironment")?.dataset.ready === "1" && document.querySelector("#race2dPlayerCar .race-car-png")?.complete, null, { timeout: 12000 });
  assert.equal(await page.locator("#race2dPlayerCar").count(), 1, "The selected car must be present in the live 2D race scene.");
  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-mobile.png"), fullPage: true });
  await page.waitForFunction(() => document.querySelector("#roomStatus")?.textContent.includes("Баланс") ||
    document.querySelector("#roomStatus")?.textContent.includes("Открытых"));

  // Race mode opens the landscape cockpit; the 2D race world is the visible driving layer.
  // Keep the touchscreen shifter responsive on a portrait Android-sized viewport.
  await page.locator("#startRace").click();
  await page.waitForFunction(() => {
    const cockpit = document.querySelector("#proRaceCockpit");
    return cockpit && !cockpit.classList.contains("hidden") &&
      document.querySelector("#race2dCameraWorld")?.parentElement?.classList.contains("race2d-scene");
  }, null, { timeout: 5000 });
  assert.equal(await page.locator("#race2dPlayerCar").count(), 1, "The selected car must remain mounted in the full-screen track.");
  assert.equal(await page.locator("#race2dPlayerCar .race-car-headlight-glow").count(), 1, "The cockpit should contain the headlight effect.");
  assert.equal(await page.locator("#race2dPlayerCar .race-car-exhaust-puff").count(), 3, "The running vehicle should have animated exhaust particles.");
  assert.equal(await page.locator("#proRaceCockpit").getAttribute("aria-hidden"), "false");
  assert.equal((await page.locator("#proRaceDistanceLabel").textContent()).trim(), "DRAG STRIP · 1 MILE", "The quarter-mile mode should display its new four-times-longer one-mile distance.");
  assert.equal(await page.locator("#proClutchHold").count(), 0, "There must be no clutch pedal in the race cockpit.");
  assert.equal(await page.locator("#clutch").count(), 0, "There must be no clutch control on the race page.");
  assert.equal(await page.locator("#proGasHold").count(), 1, "The cockpit must show a dedicated hold-to-accelerate pedal.");

  const art = await page.locator("#carShop .car-thumb svg").count();
  assert.ok(art > 0, "The garage/shop must render detailed scalable 2D SVG car illustrations.");
  assert.equal(await page.locator("#race2dPlayerCar.png-car img.race-car-png").count(), 1, "The selected VAZ-2107 must render from the actual side-profile PNG.");
  await page.waitForFunction(() => { const image=document.querySelector("#race2dPlayerCar .race-car-png"); return image && image.complete && image.naturalWidth > 0; }, null, { timeout: 5000 });
  assert.ok(await page.locator("#race2dPlayerCar .race-car-png").evaluate(el => el.naturalWidth) > 0, "A real PNG (or its built-in fallback) must load before driving.");
  const carArtBox = await page.locator("#race2dPlayerCar").evaluate(el => { const r=el.getBoundingClientRect(); return {width:r.width,height:r.height,opacity:getComputedStyle(el).opacity,visibility:getComputedStyle(el).visibility}; });
  assert.ok(Math.max(carArtBox.width, carArtBox.height) >= 240 && Math.min(carArtBox.width, carArtBox.height) >= 80 && carArtBox.opacity !== "0" && carArtBox.visibility !== "hidden", `The car sprite must have visible, non-zero dimensions on mobile (actual ${carArtBox.width}×${carArtBox.height}; landscape cockpit may be rotated on portrait screens).`);
  assert.equal(await page.locator("#race2dPlayerCar .png-wheel-spin").count(), 2, "The PNG side-profile should have two independently rotating wheel faces.");
  assert.equal(await page.locator("#race2dOpponentCar svg").count(), 0, "Solo mode must not render a hardcoded SVG rival; online opponents are rendered from their selected PNG model.");
  assert.equal(await page.locator("#race2dPlayerCar svg").count(), 0, "The selected VAZ-2107 must use the PNG rather than the old vector drawing.");
  assert.match(await page.locator("#scene").evaluate(el => getComputedStyle(el).backgroundImage), /garage-showroom\.svg/, "The selected car preview must use the new garage showroom environment.");
  assert.match(html, /raceCameraOffset=targetX\*\.38/, "The camera should ease its follow so the player car visibly moves across the track.");
  assert.match(html, /raceCameraY=0/, "The chase camera should not bob vertically at high speed.");
  assert.match(html, /hostStyle\.display===\'none\'.*Number\(hostStyle\.opacity\)<=\.05/, "An invisible 3D preview should pause to keep mobile rendering smooth.");
  assert.match((await page.locator("#startRace").textContent()).toUpperCase(), /НАЧАТЬ ЗАЕЗД/, "The showroom must have a clear start-race action.");
  assert.equal((await page.locator("#vehicleName").textContent()).trim(), "ВАЗ-2107", "The selected car name and specifications must be visible on the race page.");
  assert.equal((await page.locator("#fuelCapacity").textContent()).trim(), "42", "The selected VAZ-2107 must show its 42-liter tank.");
  assert.equal((await page.locator("#proFuelCap").textContent()).trim(), "42", "The full-screen cockpit must also show fuel capacity.");
  assert.equal(await page.locator("#race2dCameraWorld").count(), 1, "The complete race world must be inside the smooth follow-camera layer.");
  assert.equal(await page.locator("#race2dFinishGate").count(), 0, "The overhead finish gantry must be removed; only track paint remains.");
  assert.equal(await page.locator("#race2dFinishStraight").count(), 1, "The last stretch must render a clean road-surface tint without extra stripes.");
  assert.equal(await page.locator("#race2dFinishStripe").count(), 1, "The checkered finish line must be inside the clipped asphalt surface, not part of the gantry.");
  assert.match(html, /\.race2d-environment\{width:1280%!important;right:auto!important\}/, "The asphalt and scenery world should extend several screen widths.");
  assert.match(html, /\.race2d-finish-road-stripe\{[\s\S]*top:0;bottom:clamp\(10px,2%,20px\);width:clamp\(14px,1\.45vw,20px\)/, "The painted finish line should stay inset within the asphalt.");
  assert.match(html, /background:repeating-conic-gradient\(#111416 0 25%,#fffbed 0 50%\) 50%\/8px 8px/, "The finish mark should have small, neat checkered squares.");
  assert.match(html, /function updateRace2DCamera\(dt=1\/60(?:,motion=null)?\)/, "The camera should follow the moving car with the shared frame state.");
  assert.doesNotMatch(html, /gate\.style\.left\s*=|stripe\.style\.left\s*=/, "Finish graphics should use compositor transforms rather than per-frame layout changes.");
  assert.match(html, /const distanceByMode=\{quarter:1609\.344,half:3218\.688,sprint:4000\}/, "All race modes should be four times longer.");
  assert.match(html, /background:repeating-conic-gradient\(#111416 0 25%,#fffbed 0 50%\) 50%\/8px 8px/, "The finish checkers must run vertically.");
  assert.equal(await page.locator("#race2dEnvironment").count(), 1, "The race view must contain its scrolling landscape and road layers.");
  assert.equal(await page.locator("#race2dCityLayer").evaluate(el => getComputedStyle(el).backgroundImage.startsWith("url(")), true, "The distant city artwork must be loaded before driving.");
  assert.equal(await page.locator("#proSpeedScale .pro-speed-tick").count() > 0, true, "The second analog speedometer must be built.");
  assert.equal(await page.locator("#proSpeedMeterBar").count(), 1, "The cockpit must contain a live speedometer bar.");
  assert.match(html, /race2d-wheel-spin/, "Wheel rotation animation must be defined.");
  assert.match(html, /race-car-headlight-glow/, "The running car should show headlight glow.");
  assert.match(html, /race-car-exhaust-puff/, "The running car should animate exhaust smoke.");
  assert.match(html, /requestedWheelRpm>6250/, "The gearbox should reject an unsafe high-speed downshift.");
  assert.doesNotMatch(html, /shiftCutUntil/, "Gear changes must not trigger a forced throttle cut.");
  assert.match(html, /new T\.Sprite\(material\)/, "Race-lane vehicles must be 2D sprites, not 3D mesh cars.");
  assert.doesNotMatch(html, /loadPremiumOpponent/, "A remote 3D opponent must not replace the 2D car artwork.");

  const pedalStyles = await page.locator("#proGasHold").evaluate(el => ({
    userSelect: getComputedStyle(el).userSelect,
    webkitUserSelect: getComputedStyle(el).webkitUserSelect,
    touchAction: getComputedStyle(el).touchAction,
    draggable: el.draggable
  }));
  assert.equal(pedalStyles.userSelect, "none", "Gas text must not be selectable on Android.");
  assert.equal(pedalStyles.webkitUserSelect, "none", "WebKit must not allow long-press text selection on the gas pedal.");
  assert.match(html, /-webkit-touch-callout:none!important/, "WebKit long-press Copy/Share callout must be disabled in CSS.");
  assert.equal(pedalStyles.touchAction, "none", "The gas pedal needs exclusive touch handling.");
  assert.equal(pedalStyles.draggable, false, "The gas pedal must not start a native drag operation.");
  const nativeCopyMenuPrevented = await page.locator("#proGasHold").evaluate(el => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(nativeCopyMenuPrevented, true, "Long-press context menu must be cancelled on the accelerator.");
  await page.waitForFunction(() => {
    const prompt = document.querySelector("#orientationPrompt");
    return prompt && !prompt.classList.contains("hidden");
  }, null, { timeout: 3000 });
  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-cockpit-mobile.png"), fullPage: true });

  // The player is warned in portrait mode, then the warning clears as soon as they rotate to landscape.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(() => document.querySelector("#orientationPrompt")?.classList.contains("hidden"), null, { timeout: 3000 });
  await page.waitForFunction(() => window.__tgCalls?.includes("fullscreen") && window.__tgCalls?.includes("back-hide"), null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.Telegram.WebApp.BackButton.isVisible), false,
    "Telegram's own BackButton must be hidden while racing.");
  assert.ok(await page.locator("#proRaceTrack").evaluate(el => el.clientWidth) >= 1200,
    "Landscape mode should fill the full width of the device.");
  assert.ok(await page.locator("#proRaceTrack").evaluate(el => el.clientHeight) >= 300,
    "Landscape mode should leave enough room for the race scene.");
  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-cockpit-landscape.png"), fullPage: false });

  const controlBoxes = await page.evaluate(() => {
    const box = id => { const r=document.querySelector(id).getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
    return {width:window.innerWidth,up:box("#proShiftUp"),down:box("#proShiftDown"),gas:box("#proGasHold")};
  });
  assert.ok(controlBoxes.up.left < controlBoxes.width * .2 && controlBoxes.down.left < controlBoxes.width * .2,
    "Both gear-shift controls must sit on the left side of the cockpit.");
  assert.ok(controlBoxes.down.top - controlBoxes.up.bottom >= 16,
    "The upshift and downshift controls must have a clear, comfortable gap between them.");
  assert.match(html, /clip-path:polygon\(17% 0,83% 0,100% 100%,0 100%\)!important/,
    "The accelerator should have a real pedal-like tapered face.");
  assert.ok(controlBoxes.gas.left > controlBoxes.width * .65,
    "The accelerator must sit on the right side of the cockpit.");

  await page.locator("#proShiftUp").click();
  assert.equal(await page.locator("#proGearDigits").textContent(), "2", "The left-side upshift paddle should work in the cockpit.");
  await page.locator("#proShiftDown").click();
  assert.equal(await page.locator("#proGearDigits").textContent(), "1", "The left-side downshift paddle should work in the cockpit.");
  const speedBeforeThrottle = Number(await page.locator("#proSpeedDigits").textContent());
  const fuelBeforeThrottle = Number(await page.locator("#proFuelLiters").textContent());
  const carShiftBeforeThrottle = await page.locator("#race2dPlayerCar").evaluate(el => Number.parseFloat(el.style.getPropertyValue('--race-car-x')) || 0);
  const carScreenBeforeThrottle = await page.locator("#race2dPlayerCar").evaluate(el => { const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; });
  const playerMotionStyle = await page.locator("#race2dPlayerCar").evaluate(el => ({
    transitionProperty: getComputedStyle(el).transitionProperty,
    willChange: getComputedStyle(el).willChange
  }));
  assert.equal(playerMotionStyle.transitionProperty, "none",
    "Player car position should not add a CSS transition on top of the frame-by-frame physics.");
  assert.match(playerMotionStyle.willChange, /transform/,
    "The player car position should use a compositor-friendly transform.");
  const sceneryBeforeThrottle = await page.locator("#race2dCityLayer").evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
  await page.locator("#proGasHold").dispatchEvent("pointerdown", { pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 });
  assert.equal(await page.locator("#proGasHold").evaluate(el => el.classList.contains("held")), true,
    "Holding the dedicated gas pedal should engage the throttle.");
  await page.waitForTimeout(3900);
  const speedBeforeShiftWhileHeld = Number(await page.locator("#proSpeedDigits").textContent());
  await page.locator("#proShiftUp").dispatchEvent("pointerdown", { pointerId: 10, pointerType: "touch", isPrimary: false, button: 0, buttons: 1 });
  assert.equal(await page.locator("#proGearDigits").textContent(), "2", "The player must be able to shift up while still holding gas.");
  assert.equal(await page.locator("#proGasHold").evaluate(el => el.classList.contains("held")), true,
    "Changing gears must not release the gas pedal.");
  await page.waitForTimeout(500);
  const speedAfterShiftWhileHeld = Number(await page.locator("#proSpeedDigits").textContent());
  assert.ok(speedAfterShiftWhileHeld >= speedBeforeShiftWhileHeld, "Throttle must keep driving the car through a gear shift.");

  // The earlier check ended before the Android freeze seen around 4.5 s of race time.
  // Hold gas beyond that point and verify that the live clock and speed keep updating.
  const readRaceClock = async () => Number((await page.locator("#proRaceTimer").textContent()).replace(".", "")) / 1000;
  const longRunClockBefore = await readRaceClock();
  const longRunSpeedBefore = Number(await page.locator("#proSpeedDigits").textContent());
  await page.waitForTimeout(5500);
  const longRunClockAfter = await readRaceClock();
  const longRunSpeedAfter = Number(await page.locator("#proSpeedDigits").textContent());
  const recoveredFrameError = await page.evaluate(() => window.__dragRaceLastFrameError || null);
  assert.ok(longRunClockAfter - longRunClockBefore >= 5,
    `The race loop must stay active beyond the freeze seen on Android (clock advanced ${(longRunClockAfter-longRunClockBefore).toFixed(3)} s).`);
  assert.ok(longRunSpeedAfter > longRunSpeedBefore,
    `The car must keep accelerating during an extended throttle hold (speed ${longRunSpeedBefore} → ${longRunSpeedAfter} km/h).`);
  assert.equal(recoveredFrameError, null,
    `No runtime recovery should be required during normal driving: ${JSON.stringify(recoveredFrameError)}`);
  const spinningWheels = await page.locator("#race2dPlayerCar .png-wheel-spin").evaluateAll(els => els.map(el => ({ animation: getComputedStyle(el).animationName, duration: getComputedStyle(el).animationDuration })));
  assert.deepEqual(spinningWheels.map(wheel => wheel.animation), ["race2d-wheel-spin", "race2d-wheel-spin"], "Both VAZ-2107 wheel faces must have the active spin animation while the car is moving.");
  assert.ok(spinningWheels.every(wheel => wheel.duration !== "0s"), "Wheel rotation must have a non-zero animation duration.");
  const visibleWheelSize = await page.locator("#race2dPlayerCar .png-wheel-spin").first().evaluate(el => el.getBoundingClientRect().width);
  assert.ok(visibleWheelSize >= 60, `Wheel face should be large enough to see at landscape size (actual ${visibleWheelSize}px).`);
  const wheelTransformBefore = await page.locator("#race2dPlayerCar .png-wheel-spin").first().evaluate(el => getComputedStyle(el).transform);
  await page.waitForTimeout(53);
  const wheelTransformAfter = await page.locator("#race2dPlayerCar .png-wheel-spin").first().evaluate(el => getComputedStyle(el).transform);
  assert.notEqual(wheelTransformAfter, wheelTransformBefore, "A moving VAZ-2107 wheel must visibly rotate between browser frames.");
  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-cockpit-moving.png"), fullPage: false });
  assert.match(await page.locator("#race2dPlayerCar .race-car-png").getAttribute("src"), /lada-2107-side\.png\?v=20261029-wheel2$/, "The race cockpit must use the PNG with independently rotating wheel faces.");
  const fuelAfterThrottle = Number(await page.locator("#proFuelLiters").textContent());
  assert.ok(fuelAfterThrottle < fuelBeforeThrottle, `Fuel must decrease while holding gas (before ${fuelBeforeThrottle}, after ${fuelAfterThrottle}).`);
  const speedAfterThrottle = Number(await page.locator("#proSpeedDigits").textContent());
  const speedBarPercent = await page.locator("#proSpeedMeterBar").evaluate(el => parseFloat(el.style.width) || 0);
  const carShiftAfterThrottle = await page.locator("#race2dPlayerCar").evaluate(el => Number.parseFloat(el.style.getPropertyValue('--race-car-x')) || 0);
  const carScreenAfterThrottle = await page.locator("#race2dPlayerCar").evaluate(el => { const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; });
  const visibleCarTravel = Math.hypot(carScreenAfterThrottle.x-carScreenBeforeThrottle.x, carScreenAfterThrottle.y-carScreenBeforeThrottle.y);
  assert.ok(visibleCarTravel > 3, `The car must visibly advance on screen instead of being pinned by the chase camera (moved ${visibleCarTravel.toFixed(1)} px).`);
  assert.ok(speedAfterThrottle > speedBeforeThrottle, "The digital speedometer must climb while the gas pedal is held.");
  assert.ok(speedBarPercent > 0, "The speedometer bar must respond to simulated km/h.");
  assert.ok(carShiftAfterThrottle > carShiftBeforeThrottle, "The selected car must visibly travel from left to right on the track.");
  const movingWorldPosition = await page.locator("#race2dRoadMarks").evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
  assert.ok(movingWorldPosition < -1, "Road markings must visibly scroll using a compositor transform as speed increases.");
  const sceneryAfterThrottle = await page.locator("#race2dCityLayer").evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
  assert.notEqual(sceneryAfterThrottle, sceneryBeforeThrottle, "Distant scenery must scroll smoothly using a composited transform.");
  assert.match(html, /raceWorldOffset\+=Math\.max\(0,speed\)\/3\.6\*dt\*9\.6\*scale/, "Track scenery speed must rise proportionally as the speedometer climbs.");
  assert.match(html, /const shiftPercent=18\*speedLead\+52\*progress/, "Car must visibly advance across the strip as speed and traveled distance increase.");
  // Shift through the remaining gears so the longer one-mile smoke race reaches its finish at realistic top speed.
  await page.locator("#proShiftUp").click();
  await page.locator("#proShiftUp").click();
  await page.locator("#proShiftUp").click();
  assert.equal(await page.locator("#proGearDigits").textContent(), "5", "The test driver should shift up to fifth gear before the long finish run.");
  const finishBeforeApproach = Number(await page.locator("#race2dFinishStripe").evaluate(el => el.dataset.worldX || 0));
  // Let the normal race physics carry the car into the final stretch; don't mutate gameplay state from the test.
  await page.waitForFunction(() => {
    const scene = document.querySelector(".race2d-scene");
    const road = document.querySelector("#race2dFinishStraight");
    return scene?.classList.contains("race-near-finish") &&
      road && Number.parseFloat(getComputedStyle(road).opacity) > .2;
  }, null, { timeout: 65000 });
  const cameraFinishState = await page.evaluate(() => {
    const world = document.querySelector("#race2dCameraWorld");
    const finishStripe = document.querySelector("#race2dFinishStripe");
    const scene = document.querySelector(".race2d-scene");
    return {
      cameraX: new DOMMatrixReadOnly(getComputedStyle(world).transform).m41,
      finishX: Number(finishStripe?.dataset.worldX || 0),
      stripeX: Number(finishStripe?.dataset.worldX || 0),
      stripeY: document.querySelector("#race2dFinishStripe")?.getBoundingClientRect().top || 0,
      stripeHeight: document.querySelector("#race2dFinishStripe")?.getBoundingClientRect().height || 0,
      stripeBottom: document.querySelector("#race2dFinishStripe")?.getBoundingClientRect().bottom || 0,
      stripeParentIsRoad: document.querySelector("#race2dFinishStripe")?.parentElement === document.querySelector(".race2d-road-surface"),
      roadTop: document.querySelector(".race2d-road-surface")?.getBoundingClientRect().top || 0,
      roadBottom: document.querySelector(".race2d-road-surface")?.getBoundingClientRect().bottom || 0,
      roadOverflow: getComputedStyle(document.querySelector(".race2d-road-surface")).overflow,
      sceneTop: scene.getBoundingClientRect().top,
      sceneHeight: scene.getBoundingClientRect().height,
      roadWidth: document.querySelector("#race2dEnvironment")?.getBoundingClientRect().width || 0,
      sceneWidth: scene.getBoundingClientRect().width,
      stripeOpacity: Number.parseFloat(getComputedStyle(document.querySelector("#race2dFinishStripe")).opacity),
      approaching: scene.classList.contains("race-finish-approach"),
      straightOpacity: Number.parseFloat(getComputedStyle(document.querySelector("#race2dFinishStraight")).opacity),
      straightBackground: getComputedStyle(document.querySelector("#race2dFinishStraight")).backgroundImage
    };
  });
  assert.ok(cameraFinishState.cameraX < -8, "The camera must pan smoothly to follow the car as it advances.");
  assert.ok(cameraFinishState.finishX < finishBeforeApproach, "The painted finish line must approach the car as the remaining distance shrinks.");
  assert.ok(Math.abs(cameraFinishState.stripeX-cameraFinishState.finishX)<1, "The finish paint position is derived directly from its own world coordinate.");
  assert.equal(cameraFinishState.stripeParentIsRoad, true, "The finish stripe must be nested inside the asphalt itself.");
  assert.equal(cameraFinishState.roadOverflow, "hidden", "The road must clip the stripe so it cannot extend past its edges.");
  assert.ok(cameraFinishState.stripeY >= cameraFinishState.roadTop - 1 && cameraFinishState.stripeY <= cameraFinishState.roadTop + 2, "The finish stripe must start exactly at the visible asphalt edge.");
  assert.ok(cameraFinishState.stripeHeight > cameraFinishState.sceneHeight*.5 && cameraFinishState.stripeBottom >= cameraFinishState.sceneTop + cameraFinishState.sceneHeight*.96, "The finish stripe must be vertical and extend down the asphalt instead of forming a horizontal bar.");
  assert.ok(cameraFinishState.stripeBottom < cameraFinishState.roadBottom - 2, "The stripe must stop before the lower edge of the asphalt and never overrun the track.");
  assert.ok(cameraFinishState.roadWidth > cameraFinishState.sceneWidth*2, "The asphalt world must extend to a longer straight.");
  assert.ok(cameraFinishState.stripeOpacity > .7, "The finish paint must be clearly visible near the finish.");
  assert.equal(cameraFinishState.approaching, true, "The final straight must activate in the last part of the race.");
  assert.ok(cameraFinishState.straightOpacity > .2, "The subtle finish-straight surface tint must appear near the finish.");
  assert.doesNotMatch(cameraFinishState.straightBackground, /repeating-linear-gradient/, "The finish approach must not create distracting line artifacts.");
  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-cockpit-finish-straight.png"), fullPage: false });
  await page.locator("#proGasHold").dispatchEvent("pointerup", { pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, buttons: 0 });
  assert.equal(await page.locator("#proGasHold").evaluate(el => el.classList.contains("held")), false,
    "Releasing the gas pedal should release the throttle.");
  await page.locator("#proExitRace").click();
  await page.waitForFunction(() => document.querySelector("#proRaceCockpit")?.classList.contains("hidden"));
  const restoredRaceView = await page.evaluate(() => ({
    playerCarCount: document.querySelectorAll("#race2dPlayerCar").length,
    canvasParent: document.querySelector("#race3dCanvas")?.parentElement?.id || null
  }));
  assert.equal(restoredRaceView.playerCarCount, 1, "The 2D race view should remain available after exiting the cockpit.");
  if (restoredRaceView.canvasParent !== null) {
    assert.equal(restoredRaceView.canvasParent, "scene", "If the optional 3D preview remains available, it should return to the game page.");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal((await page.locator("#balance").textContent()).replace(/\s/g, ""), "10000");
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/profile" && call.body.initData === "mock-init-data"),
    "Profile request should contain Telegram initData.");

  await page.locator('[data-tab="shop"]').evaluate(el => el.click());
  const cheapCar = page.locator(".car-card").filter({ hasText: "ВАЗ-2104" });
  await cheapCar.getByRole("button", { name: "Купить" }).click();
  await page.waitForFunction(() => Number(document.querySelector("#balance")?.textContent.replace(/\D/g, "")) === 5500);
  assert.ok(ownedCars.includes("2104"), "The inexpensive VAZ-2104 should be bought through the mocked server wallet.");
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/garage/buy" && call.body.carId === "2104"),
    "Garage purchase should be sent to the authenticated server.");

  await page.locator('[data-tab="race"]').evaluate(el => el.click());
  await page.locator("#stake").fill("1000");
  await page.locator("#createRoom").click();
  await page.waitForFunction(() => !document.querySelector("#onlineRoom")?.classList.contains("hidden"));
  assert.equal(await page.locator("#onlineRoomInfo").locator(".title").textContent(), "DR-71 · ¼ мили");
  assert.equal(activeRoom.room.status, "waiting");
  assert.equal(activeRoom.room.stake, 1000);
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/rooms/create" &&
    call.body.initData === "mock-init-data" && call.body.stake === 1000),
    "Creating a room should send Telegram identity and the requested stake.");
  assert.equal(activeRoom.players.length, 2, "The online room fixture should contain an actual rival with its own selected car.");
  await page.locator("#startOnline").click();
  await page.waitForFunction(() => {
    const cockpit = document.querySelector("#proRaceCockpit");
    const image = document.querySelector("#race2dOpponentCar .opponent-car-png");
    return cockpit && !cockpit.classList.contains("hidden") && image && image.complete && image.naturalWidth > 0;
  }, null, { timeout: 7000 });
  assert.equal(await page.locator("#race2dOpponentCar .opponent-car-png").count(), 1,
    "The network opponent should be rendered from a PNG image element.");
  assert.equal(await page.locator("#race2dOpponentCar svg").count(), 0,
    "The network opponent must not use the old inline SVG.");
  assert.equal(await page.locator("#race2dOpponentCar .opponent-car-png").getAttribute("src"),
    "./cars/lada-2107-side.png?v=20261029-opponent-entry1",
    "A rival driving a VAZ-2107 must display the actual side-view PNG asset.");
  assert.match(await page.locator("#race2dOpponentCar").getAttribute("aria-label"), /ВАЗ-2107/,
    "The visible opponent model should match the rival's selected carId.");
  const rivalDisplay = await page.locator("#race2dOpponentCar").evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      opacity: Number(getComputedStyle(el).opacity),
      visibility: getComputedStyle(el).visibility,
      width: el.offsetWidth,
      height: el.offsetHeight,
      visibleWidth: rect.width,
      visibleHeight: rect.height
    };
  });
  assert.ok(rivalDisplay.opacity >= 0.9 && rivalDisplay.visibility === "visible" &&
    rivalDisplay.width >= 220 && rivalDisplay.height >= 70 &&
    rivalDisplay.visibleWidth > 0 && rivalDisplay.visibleHeight > 0,
    "The opponent's PNG vehicle must be visibly rendered with a full-size image box when the online race opens.");
  assert.equal(await page.locator("#race2dOpponentCar .opponent-wheel-spin").count(), 2,
    "The rival PNG must have two visible wheel overlays.");
  await page.waitForFunction(() => {
    const opponent = document.querySelector("#race2dOpponentCar");
    return opponent?.classList.contains("opponent-moving") &&
      Number(opponent.dataset.opponentSpeedKmh || 0) > 10;
  }, null, { timeout: 5000 });
  const rivalPositionBefore = Number.parseFloat(await page.locator("#race2dOpponentCar").evaluate(el => el.style.getPropertyValue('--opponent-translate-x'))) || 0;
  const rivalWheelDurationBefore = await page.locator("#race2dOpponentCar").evaluate(el => getComputedStyle(el.querySelector(".opponent-wheel-spin")).animationDuration);
  const rivalWheelTransformBefore = await page.locator("#race2dOpponentCar .opponent-wheel-spin").first().evaluate(el => getComputedStyle(el).transform);
  await page.waitForTimeout(720);
  const rivalPositionAfter = Number.parseFloat(await page.locator("#race2dOpponentCar").evaluate(el => el.style.getPropertyValue('--opponent-translate-x'))) || 0;
  const rivalWheelDurationAfter = await page.locator("#race2dOpponentCar").evaluate(el => getComputedStyle(el.querySelector(".opponent-wheel-spin")).animationDuration);
  const rivalWheelTransformAfter = await page.locator("#race2dOpponentCar .opponent-wheel-spin").first().evaluate(el => getComputedStyle(el).transform);
  assert.ok(rivalPositionAfter > rivalPositionBefore + 1,
    "The opponent car must change its position when the online progress is updated.");
  assert.notEqual(rivalWheelDurationAfter, rivalWheelDurationBefore,
    "The opponent wheel animation speed must change as the rival's online speed changes.");
  assert.notEqual(rivalWheelTransformAfter, rivalWheelTransformBefore,
    "The opponent wheels must visibly rotate between browser frames.");
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/rooms/state" && call.body.telemetry &&
    typeof call.body.telemetry.speedKmh === "number" && typeof call.body.telemetry.distanceM === "number"),
    "The client must send its live race telemetry to the room so all players can see its motion.");
  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-online-opponent-png.png"), fullPage: false });

  const localCameraBeforeRivalLeaves = await page.locator("#race2dCameraWorld").evaluate(el => getComputedStyle(el).transform);
  forcedOpponentProgress = 1;
  await page.waitForFunction(() => {
    const rival = document.querySelector("#race2dOpponentCar");
    return rival && Number.parseFloat(rival.style.getPropertyValue('--opponent-translate-x')) > (document.querySelector('.race2d-scene')?.clientWidth || 390);
  }, null, { timeout: 5000 });
  const localCameraWhileRivalIsFarAhead = await page.locator("#race2dCameraWorld").evaluate(el => getComputedStyle(el).transform);
  assert.equal(localCameraWhileRivalIsFarAhead, localCameraBeforeRivalLeaves,
    "The local camera must not follow or move because the rival drives far ahead.");

  forcedOpponentProgress = "match";
  await page.waitForFunction(() => {
    const rival = document.querySelector("#race2dOpponentCar");
    const left = Number.parseFloat(rival?.style.getPropertyValue('--opponent-translate-x'));
    return Number.isFinite(left) && left >= 0 && left < (document.querySelector('.race2d-scene')?.clientWidth || 390);
  }, null, { timeout: 7000 });
  const localCameraAfterCatch = await page.locator("#race2dCameraWorld").evaluate(el => getComputedStyle(el).transform);
  assert.equal(localCameraAfterCatch, localCameraBeforeRivalLeaves,
    "Opponent motion and re-entry must not move the local camera.");



  assert.ok(pageErrors.length === 0, "Browser console errors: " + pageErrors.join("; "));

  console.log("Drag Racing UI smoke test passed: mobile page, server garage purchase and online room creation.");
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
