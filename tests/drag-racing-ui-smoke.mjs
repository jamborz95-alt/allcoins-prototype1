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
assert.ok(indexHtml.includes('href="./drag-racing-v2.html?v=20261029-opponent1"'), "The game tile should link to the drag racing page with rotating VAZ-2107 wheels.");

let balance = 10000;
let ownedCars = ["2107"];
let selectedCarId = "2107";
let upgrades = { "2107": {} };
let tune = { ecu: 50, boost: 25, grip: 70, shift: 45 };
let activeRoom = null;
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
  await page.waitForFunction(() => document.querySelector("#scene")?.classList.contains("three-ready"), null, { timeout: 12000 });
  assert.equal(await page.locator("#race3dCanvas canvas").count(), 1, "A real Three.js canvas should render the racing scene.");
  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-mobile.png"), fullPage: true });
  await page.waitForFunction(() => document.querySelector("#roomStatus")?.textContent.includes("Баланс") ||
    document.querySelector("#roomStatus")?.textContent.includes("Открытых"));

  // Race mode should open the landscape cockpit, move the actual 3D canvas into the track,
  // and keep the touchscreen shifter responsive on a portrait Android-sized viewport.
  await page.locator("#startRace").click();
  await page.waitForFunction(() => {
    const cockpit = document.querySelector("#proRaceCockpit");
    return cockpit && !cockpit.classList.contains("hidden") &&
      document.querySelector("#race3dCanvas")?.parentElement?.id === "proRaceTrack";
  }, null, { timeout: 5000 });
  assert.equal(await page.locator("#race3dCanvas canvas").count(), 1, "The same live 3D canvas should render inside the full-screen drag cockpit.");
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
  assert.equal(await page.locator("#race2dOpponentCar svg").count(), 1, "The opponent must have side-view car artwork too.");
  assert.equal(await page.locator("#race2dPlayerCar svg").count(), 0, "The selected VAZ-2107 must use the PNG rather than the old vector drawing.");
  assert.equal(await page.locator("#race2dCameraWorld").count(), 1, "The complete race world must be inside the smooth follow-camera layer.");
  assert.equal(await page.locator("#race2dFinishGate").count(), 1, "The track must render an approaching FINISH gantry.");
  assert.equal(await page.locator("#race2dFinishStraight").count(), 1, "The last stretch must render a clean road-surface tint without extra stripes.");
  assert.equal(await page.locator("#race2dFinishStripe").count(), 1, "The checkered finish line must be a separate road-surface layer, not part of the gantry.");
  assert.match(html, /\.race2d-environment\{width:1280%!important;right:auto!important\}/, "The asphalt and scenery world should extend several screen widths.");
  assert.match(html, /\.race2d-finish-road-stripe\{[\s\S]*top:44%;bottom:0;width:clamp\(8px,1\.2vw,16px\)/, "The finish marking should be placed on the asphalt in the lower track area.");
  assert.match(html, /function updateRace2DCamera\(dt=1\/60\)/, "The camera should follow the moving car with frame-time smoothing.");
  assert.match(html, /const distanceByMode=\{quarter:1609\.344,half:3218\.688,sprint:4000\}/, "All race modes should be four times longer.");
  assert.match(html, /background:repeating-linear-gradient\(0deg,#111416 0 14px,#fffbed 14px 28px\)/, "The finish checkers must run vertically.");
  assert.equal(await page.locator("#race2dEnvironment").count(), 1, "The race view must contain its scrolling landscape and road layers.");
  assert.equal(await page.locator("#race2dCityLayer").evaluate(el => getComputedStyle(el).backgroundImage.startsWith("url(")), true, "The distant city artwork must be loaded before driving.");
  assert.equal(await page.locator("#proSpeedScale .pro-speed-tick").count() > 0, true, "The second analog speedometer must be built.");
  assert.equal(await page.locator("#proSpeedMeterBar").count(), 1, "The cockpit must contain a live speedometer bar.");
  assert.match(html, /race2d-wheel-spin/, "Wheel rotation animation must be defined.");
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
  const carShiftBeforeThrottle = await page.locator("#race2dPlayerCar").evaluate(el => Number(el.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1] || 0));
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
  const speedAfterThrottle = Number(await page.locator("#proSpeedDigits").textContent());
  const speedBarPercent = await page.locator("#proSpeedMeterBar").evaluate(el => parseFloat(el.style.width) || 0);
  const carShiftAfterThrottle = await page.locator("#race2dPlayerCar").evaluate(el => Number(el.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1] || 0));
  assert.ok(speedAfterThrottle > speedBeforeThrottle, "The digital speedometer must climb while the gas pedal is held.");
  assert.ok(speedBarPercent > 0, "The speedometer bar must respond to simulated km/h.");
  assert.ok(carShiftAfterThrottle > carShiftBeforeThrottle, "The selected car must visibly travel from left to right on the track.");
  const movingWorldPosition = await page.locator("#race2dRoadMarks").evaluate(el => getComputedStyle(el).backgroundPositionX);
  assert.notEqual(movingWorldPosition, "0px", "Road markings must visibly scroll with vehicle speed.");
  const sceneryAfterThrottle = await page.locator("#race2dCityLayer").evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
  assert.notEqual(sceneryAfterThrottle, sceneryBeforeThrottle, "Distant scenery must scroll smoothly using a composited transform.");
  assert.match(html, /raceWorldOffset\+=Math\.max\(0,speed\)\/3\.6\*dt\*9\.6\*scale/, "Track scenery speed must rise proportionally as the speedometer climbs.");
  assert.match(html, /const shiftPercent=18\*speedLead\+52\*progress/, "Car must visibly advance across the strip as speed and traveled distance increase.");
  const finishBeforeApproach = Number(await page.locator("#race2dFinishGate").evaluate(el => parseFloat(el.style.left) || 0));
  // Let the normal race physics carry the car into the final stretch; don't mutate gameplay state from the test.
  await page.waitForFunction(() => {
    const scene = document.querySelector(".race2d-scene");
    const road = document.querySelector("#race2dFinishStraight");
    return scene?.classList.contains("race-near-finish") &&
      road && Number.parseFloat(getComputedStyle(road).opacity) > .2;
  }, null, { timeout: 55000 });
  const cameraFinishState = await page.evaluate(() => {
    const world = document.querySelector("#race2dCameraWorld");
    const gate = document.querySelector("#race2dFinishGate");
    const scene = document.querySelector(".race2d-scene");
    return {
      cameraX: new DOMMatrixReadOnly(getComputedStyle(world).transform).m41,
      finishX: parseFloat(gate.style.left) || 0,
      stripeX: parseFloat(document.querySelector("#race2dFinishStripe")?.style.left) || 0,
      stripeY: document.querySelector("#race2dFinishStripe")?.getBoundingClientRect().top || 0,
      stripeHeight: document.querySelector("#race2dFinishStripe")?.getBoundingClientRect().height || 0,
      stripeBottom: document.querySelector("#race2dFinishStripe")?.getBoundingClientRect().bottom || 0,
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
  assert.ok(cameraFinishState.finishX < finishBeforeApproach, "The finish gantry must approach the car as the remaining distance shrinks.");
  assert.ok(Math.abs(cameraFinishState.stripeX-cameraFinishState.finishX)<1, "The finish paint must stay aligned with the gantry position.");
  assert.ok(cameraFinishState.stripeY <= cameraFinishState.sceneTop + cameraFinishState.sceneHeight*.48, "The vertical finish stripe must start at the road surface.");
  assert.ok(cameraFinishState.stripeHeight > cameraFinishState.sceneHeight*.5 && cameraFinishState.stripeBottom >= cameraFinishState.sceneTop + cameraFinishState.sceneHeight*.96, "The finish stripe must be vertical and extend down the asphalt instead of forming a horizontal bar.");
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
  assert.equal(await page.locator("#race3dCanvas").evaluate(el => el.parentElement.id), "scene",
    "Exiting single-player should return the 3D canvas to the game page.");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal((await page.locator("#balance").textContent()).replace(/\s/g, ""), "10000");
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/profile" && call.body.initData === "mock-init-data"),
    "Profile request should contain Telegram initData.");

  await page.getByRole("button", { name: "🛒 Магазин" }).click();
  const cheapCar = page.locator(".car-card").filter({ hasText: "ВАЗ-2104" });
  await cheapCar.getByRole("button", { name: "Купить" }).click();
  await page.waitForFunction(() => Number(document.querySelector("#balance")?.textContent.replace(/\D/g, "")) === 5500);
  assert.ok(ownedCars.includes("2104"), "The inexpensive VAZ-2104 should be bought through the mocked server wallet.");
  assert.ok(apiCalls.some(call => call.path === "/api/drag-racing/garage/buy" && call.body.carId === "2104"),
    "Garage purchase should be sent to the authenticated server.");

  await page.getByRole("button", { name: "🏁 Гонки" }).click();
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
    "./cars/lada-2107-side.png?v=20261029-opponent1",
    "A rival driving a VAZ-2107 must display the actual side-view PNG asset.");
  assert.match(await page.locator("#race2dOpponentCar").getAttribute("aria-label"), /ВАЗ-2107/,
    "The visible opponent model should match the rival's selected carId.");
  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-online-opponent-png.png"), fullPage: false });

  assert.ok(pageErrors.length === 0, "Browser console errors: " + pageErrors.join("; "));

  console.log("Drag Racing UI smoke test passed: mobile page, server garage purchase and online room creation.");
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
