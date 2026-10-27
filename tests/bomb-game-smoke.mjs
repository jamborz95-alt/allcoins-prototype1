import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const bombHtml = await readFile(resolve(root, "bomb.html"), "utf8");
const bombJs = await readFile(resolve(root, "bomb-3d.js"), "utf8");
const bombOnlineRouter = await readFile(resolve(root, "server/bomb-online-router.js"), "utf8");
const i18nExtraJs = await readFile(resolve(root, "i18n-extra.js"), "utf8");
const threeBundle = await readFile(resolve(root, "three.min.js"), "utf8");
const indexHtml = await readFile(resolve(root, "index.html"), "utf8");
await mkdir(resolve(root, "artifacts"), { recursive: true });

const bombTile = indexHtml.indexOf('id="bombEntry"');
assert.ok(bombTile >= 0, "The Games menu must include the Pass the Bomb tile.");
assert.ok(indexHtml.includes('href="./bomb.html?v=20261027-online-4"'),
  "The Games menu should open the current cache-busted Bomb page.");
assert.ok(bombHtml.includes('<script src="./three.min.js?v=20261026n"></script>') &&
  bombHtml.includes('<script src="./bomb-3d.js?v=20261027-online-1"></script>'),
  "The page must load the local Three.js library and current 3D renderer without a CDN dependency.");
assert.ok(bombJs.includes("const VIEW_H = 15.6;") &&
  bombJs.includes("new THREE.SphereGeometry(.30, 24, 16, 0, Math.PI * 2, 0, Math.PI * .62), helmetMat") &&
  !bombJs.includes("const brim = mesh(new THREE.CylinderGeometry(.43, .43, .1, 18)") &&
  !bombJs.includes("new THREE.BoxGeometry(.86, .12, .51)"),
  "The renderer should show the larger map and helmet shell that tucks its cut edge inside the head, without the deep rectangular waist slab.");
assert.ok(indexHtml.indexOf('id="durakEntry"') < bombTile &&
  bombTile < indexHtml.indexOf('id="unoEntry"'),
  "Pass the Bomb should appear in the first row after Durak.");
assert.ok(bombHtml.includes("function startGame()") && bombHtml.includes("function passBombFromBot(target)"),
  "The standalone game must include its start and bot-pass logic.");
assert.ok(bombHtml.includes('data-mode="online"') &&
  bombHtml.includes('function startOnlineMatchmaking()') &&
  bombHtml.includes('function syncOnlineRoom()') &&
  bombHtml.includes('function passBombOnline(target)') &&
  bombHtml.includes('https://allcoins-server.onrender.com/api/bomb'),
  "Bomb should expose server-backed online matchmaking, position sync and online bomb passing.");
assert.ok(bombOnlineRouter.includes('router.post("/matchmaking/join"') &&
  bombOnlineRouter.includes('router.post("/rooms/state"') &&
  bombOnlineRouter.includes('router.post("/rooms/pass"') &&
  bombOnlineRouter.includes('router.post("/rooms/leave"') &&
  bombOnlineRouter.includes('CREATE TABLE IF NOT EXISTS bomb_rooms') &&
  bombOnlineRouter.includes('CREATE TABLE IF NOT EXISTS bomb_room_players'),
  "Bomb Online backend should create persistent rooms and support matchmaking, sync, pass and leave.");
assert.ok(bombOnlineRouter.includes('router.post("/rooms/create"') &&
  bombOnlineRouter.includes('router.post("/rooms/join"') &&
  bombOnlineRouter.includes("invite_code TEXT") &&
  bombHtml.includes('id="createOnlineRoom"') &&
  bombHtml.includes('id="joinOnlineRoom"') &&
  bombHtml.includes('id="shareOnlineInvite"') &&
  bombHtml.includes('searchParams.set("room"'),
  "Bomb Online should support shareable friend rooms, invite codes and direct-join links.");

assert.ok(bombHtml.includes('<div class="obstacle-layer" id="obstacleLayer"') &&
  bombHtml.includes("const MAP_OBSTACLES =") &&
  bombHtml.includes("function slideAroundObstacles(") &&
  bombHtml.includes("function isBlockedByObstacle(x, y, radius)"),
  "The mine maps must have visible obstacles with physical collision handling.");
assert.ok(bombHtml.includes('<svg class="mine-scene"') &&
  bombHtml.includes('data-map="copper"') && bombHtml.includes('data-map="crystal"'),
  "The game should include original inline mine artwork and two selectable original maps.");
assert.ok(!/<img[^>]+src=["']https?:\/\//i.test(bombHtml),
  "The mine artwork should not depend on copied or remotely hosted image assets.");
assert.ok(bombHtml.includes("function playDynamiteFuseSound(left)") &&
  bombHtml.includes("function playExplosionSound()"),
  "The dynamite fuse and explosion should have original generated sound effects.");
assert.ok(bombHtml.includes("function pauseJoystickMotion()") &&
  bombHtml.includes("function resumeJoystickMotion()") &&
  bombHtml.includes("movePointerId !== null && lastJoystickClientX !== null"),
  "A bomb hand-off must preserve an active joystick gesture and resume movement afterward.");
assert.ok(bombHtml.includes("width:108px;height:108px") &&
  bombHtml.includes("width:100px;height:100px") &&
  bombHtml.includes("rect.width * .24") &&
  bombHtml.includes("const MOVE_SPEED = 225;"),
  "The joystick must be bigger and respond to shorter finger movement.");
assert.ok(bombHtml.includes("setGradient('minerHelmet', outfit.helmet)") &&
  bombHtml.includes("setGradient('minerJacket', outfit.jacket)") &&
  bombHtml.includes("setGradient('minerPants', outfit.pants)"),
  "Bot miners must receive distinct outfit colors.");
assert.ok(bombHtml.includes("const PLAYER_ACCELERATION = 13.5;") &&
  bombHtml.includes("const PLAYER_DRAG = 18;") &&
  bombHtml.includes("playerVelocityX += (targetVX - playerVelocityX) * blend;"),
  "Player movement should use smooth acceleration, velocity and drag instead of instant speed changes.");
assert.ok(bombHtml.includes("const blend = 1 - Math.exp(-10 * dt);") &&
  bombHtml.includes("botVelocityX += (desiredVX - botVelocityX) * blend;"),
  "Bot movement should accelerate smoothly instead of snapping to full speed.");
assert.ok(bombHtml.includes("pointOnArc(.25)") && bombHtml.includes("pointOnArc(.5)") &&
  bombHtml.includes("pointOnArc(.75)") && bombHtml.includes("const duration = 640;") &&
  bombHtml.includes("window.__allcoinsBombFlight = { startX, startY, controlX, controlY, endX, endY, startedAt: performance.now(), duration };") &&
  bombHtml.includes("cubic-bezier(.22,.72,.22,1)"),
  "Bomb transfers should follow a smooth 640ms sampled curved flight path.");
assert.ok(bombHtml.includes(".bomb.following{transition:none!important}") &&
  !bombHtml.slice(bombHtml.indexOf("function syncBombToCarrier()"), bombHtml.indexOf("function setMoveVector")).includes("offsetWidth"),
  "Following the carrier should not force a layout reflow on every animation frame.");
assert.ok(bombHtml.includes('<div class="joystick-panel arena-joystick-panel">') &&
  bombHtml.includes(".arena-joystick-panel{position:absolute;left:50%;") &&
  bombHtml.indexOf('id="moveJoystick" type="button"') < bombHtml.indexOf('<div class="bottom-area">'),
  "The movement joystick must be a floating control inside the actual playfield, not in the footer.");
assert.ok(bombHtml.includes("min-height:62px") &&
  bombHtml.includes("grid-template-columns:minmax(0,1fr) auto"),
  "The footer should be shorter so more of the screen is available for the game arena.");
assert.ok(bombHtml.includes("body.game-active{overflow:hidden;position:fixed") &&
  bombHtml.includes("html.bomb-active,html.bomb-active body{touch-action:none") &&
  bombHtml.includes("window.addEventListener('touchmove'") &&
  bombHtml.includes("touch-action:none;user-select:none;-webkit-user-select:none") &&
  !bombHtml.includes("document.addEventListener('touchstart'"),
  "The active game must block page/edge gestures without cancelling joystick touch events.");

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/" || pathname === "/bomb.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(bombHtml);
    return;
  }
  if (pathname === "/bomb-3d.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end(bombJs);
    return;
  }
  if (pathname === "/three.min.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end(threeBundle);
    return;
  }
  if (pathname === "/i18n-extra.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end(i18nExtraJs);
    return;
  }
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});
await new Promise((resolveListen) => server.listen(4175, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"]
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("https://telegram.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Telegram = { WebApp: { ready(){}, expand(){}, BackButton: { show(){}, hide(){}, onClick(fn){ window.__allcoinsBackHandler = fn; } } } };"
  }));
  await page.goto("http://127.0.0.1:4175/bomb.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  assert.equal(await page.title(), "Передай бомбу — ALLCOINS");
  assert.equal(await page.locator("#setupView").isVisible(), true);
  assert.equal(await page.locator("#startGame").isVisible(), true);
  await page.screenshot({ path: resolve(root, "artifacts/bomb-lobby-mobile.png"), fullPage: true });
  assert.equal(await page.locator("#mapControl [data-map]").count(), 2,
    "The lobby should offer two original selectable map cards.");
  await page.locator('#mapControl [data-map="crystal"]').click();
  assert.equal(await page.locator('#mapControl [data-map="crystal"]').getAttribute("aria-pressed"), "true",
    "Selecting a map should visibly update the selected state.");

  // Verify the online lobby and authoritative server snapshot in a second-client simulation.
  await page.locator('#playerCountControl button[data-count="2"]').click();
  await page.locator('#modeControl button[data-mode="online"]').click();
  await page.locator("#playerName").fill("Test Player");
  let onlineJoinRequests = 0;
  let onlineStateRequests = 0;
  let onlineLeaveRequests = 0;
  let friendRoomCreateRequests = 0;
  let friendRoomJoinRequests = 0;
  const friendInviteCode = "ABC2345";
  let onlinePlayerId = "";
  let onlineRoster = [];
  let onlineGameState = {};
  const onlineRoom = { id: "901234", status: "playing", maxPlayers: 2, map: "copper", inviteCode: friendInviteCode, createdAt: new Date().toISOString() };
  await page.route("https://allcoins-server.onrender.com/api/bomb/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type"
        },
        body: ""
      });
      return;
    }
    const url = new URL(request.url());
    const body = request.postDataJSON() || {};
    if (url.pathname.endsWith("/rooms/create")) {
      friendRoomCreateRequests++;
      onlinePlayerId = String(body.playerId);
      onlineRoom.status = "waiting";
      onlineRoom.maxPlayers = Number(body.maxPlayers) || 2;
      onlineRoom.map = body.map === "crystal" ? "crystal" : "copper";
      onlineRoom.inviteCode = friendInviteCode;
      onlineRoster = [
        { playerId: onlinePlayerId, name: String(body.name || "Test Player"), lives: 3, xPct: 50, yPct: 66, connected: true }
      ];
      onlineGameState = {
        phase: "waiting", round: 0, holderId: null, fuseEndsAt: null,
        phaseEndsAt: null, passToId: null, transferEndsAt: null,
        lastExplosionId: null, loserId: null, winnerId: null
      };
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, room: onlineRoom, game: onlineGameState, players: onlineRoster, playerId: onlinePlayerId })
      });
      return;
    }
    if (url.pathname.endsWith("/rooms/join")) {
      friendRoomJoinRequests++;
      onlinePlayerId = String(body.playerId);
      onlineRoom.status = "waiting";
      onlineRoom.inviteCode = friendInviteCode;
      onlineRoster = [
        { playerId: "friend_room_host_01", name: "Friend Host", lives: 3, xPct: 50, yPct: 66, connected: true },
        { playerId: onlinePlayerId, name: String(body.name || "Test Player"), lives: 3, xPct: 28, yPct: 46, connected: true }
      ];
      onlineGameState = {
        phase: "waiting", round: 0, holderId: null, fuseEndsAt: null,
        phaseEndsAt: null, passToId: null, transferEndsAt: null,
        lastExplosionId: null, loserId: null, winnerId: null
      };
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, room: onlineRoom, game: onlineGameState, players: onlineRoster, playerId: onlinePlayerId })
      });
      return;
    }
    if (url.pathname.endsWith("/matchmaking/join")) {
      onlineJoinRequests++;
      onlinePlayerId = String(body.playerId);
      onlineRoom.maxPlayers = Number(body.maxPlayers) || 2;
      onlineRoom.map = body.map === "crystal" ? "crystal" : "copper";
      onlineRoster = [
        { playerId: onlinePlayerId, name: String(body.name || "Test Player"), lives: 3, xPct: 50, yPct: 66, connected: true },
        { playerId: "opponent_online_01", name: "Live Opponent", lives: 3, xPct: 78, yPct: 52, connected: true }
      ];
      onlineGameState = {
        phase: "playing", round: 1, holderId: onlinePlayerId, fuseEndsAt: Date.now() + 12000,
        phaseEndsAt: null, passToId: null, transferEndsAt: null,
        lastExplosionId: null, loserId: null, winnerId: null
      };
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, room: onlineRoom, game: onlineGameState, players: onlineRoster, playerId: onlinePlayerId })
      });
      return;
    }
    if (url.pathname.endsWith("/rooms/state")) {
      onlineStateRequests++;
      onlineRoster = onlineRoster.map(player => player.playerId === String(body.playerId)
        ? { ...player, xPct: Number(body.xPct) || player.xPct, yPct: Number(body.yPct) || player.yPct }
        : player);
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, room: onlineRoom, game: onlineGameState, players: onlineRoster, playerId: onlinePlayerId })
      });
      return;
    }
    if (url.pathname.endsWith("/rooms/leave")) onlineLeaveRequests++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.locator("#createOnlineRoom").click();
  await page.waitForFunction(() =>
    document.querySelector("#onlineInviteCode")?.textContent === "ABC2345" &&
    !document.querySelector("#onlineRoomCodeRow")?.classList.contains("hidden"),
    undefined, { timeout: 8000 }
  );
  assert.equal(friendRoomCreateRequests, 1, "The friend-room button should create a server room.");
  assert.ok((await page.locator("#onlineStatusText").innerText()).includes("В комнате") &&
    (await page.locator("#onlineStatusText").innerText()).includes("ABC2345"),
    "The creator should see room occupancy and the invite code while waiting.");
  await page.locator("#cancelOnlineSearch").click();
  await page.locator("#joinRoomCode").fill(friendInviteCode);
  await page.locator("#joinOnlineRoom").click();
  await page.waitForFunction(() =>
    document.querySelector("#onlineInviteCode")?.textContent === "ABC2345" &&
    !document.querySelector("#onlinePanel")?.classList.contains("hidden"),
    undefined, { timeout: 8000 }
  );
  assert.equal(friendRoomJoinRequests, 1, "The invite-code action should join the friend room.");
  assert.ok((await page.locator("#onlineStatusText").innerText()).includes("В комнате"),
    "A player joining by code should see the room occupancy.");
  await page.locator("#cancelOnlineSearch").click();

  onlineRoom.status = "playing";
  await page.locator("#startGame").click();
  await page.waitForFunction(() =>
    !document.querySelector("#gameView")?.classList.contains("hidden") &&
    document.querySelector("#modeCaption")?.textContent.includes("Онлайн"),
    undefined, { timeout: 8000 }
  );
  assert.equal(onlineJoinRequests, 1, "Online mode should request a public matchmaking room.");
  assert.ok(onlineStateRequests > 0, "Online mode should poll shared server state after matchmaking.");
  assert.equal(await page.locator("#botCharacters .bot-character").count(), 1,
    "A remote human opponent should be rendered in the arena.");
  assert.ok((await page.locator("#seats").innerText()).includes("Live Opponent"),
    "The remote player's nickname should appear in the online seats.");
  await page.locator("#gameBack").click();
  await page.waitForTimeout(120);
  assert.equal(onlineLeaveRequests, 1, "Leaving an online game should notify the server and release the room.");

  console.log("Bomb Online mocked multiplayer flow passed: matchmaking, remote player render, sync and clean leave.");

  for (const count of [2, 3, 4]) {
    await page.locator('#playerCountControl button[data-count="' + count + '"]').click();
    await page.locator('#modeControl button[data-mode="local"]').click();
    await page.locator("#startGame").click();
    await page.locator("#gameView").waitFor({ state: "visible" });
    assert.equal(await page.locator("#seats .seat").count(), count,
      "Selecting " + count + " players should create exactly " + count + " seats.");
    assert.equal(await page.locator("#botCharacters .bot-character").count(), count - 1,
      "Every non-human player should have a visible human-shaped character.");
    const arena = await page.locator("#arena").boundingBox();
    assert.ok(arena && arena.width >= 300, "The game arena should fit a mobile viewport.");
    assert.ok(arena && arena.height >= 500,
      "The expanded playfield should use most of the phone's vertical space.");
    const joystickBoxOnField = await page.locator("#moveJoystick").boundingBox();
    assert.ok(joystickBoxOnField && arena &&
      joystickBoxOnField.x >= arena.x &&
      joystickBoxOnField.x + joystickBoxOnField.width <= arena.x + arena.width &&
      joystickBoxOnField.y >= arena.y &&
      joystickBoxOnField.y + joystickBoxOnField.height <= arena.y + arena.height,
      "The large joystick must be visibly positioned inside the field boundaries.");
    assert.equal(await page.locator("#arena").locator("#moveJoystick").count(), 1,
      "The joystick should belong to the arena, not the footer.");
    assert.equal(await page.locator("#arena").getAttribute("data-map"), "crystal",
      "The selected map should be applied to the full-screen game arena.");
    if (count === 4) {
      await page.waitForFunction(() => {
        const arena = document.querySelector("#arena");
        const canvas = arena?.querySelector("canvas.bomb-3d-canvas");
        return Boolean(arena?.classList.contains("three-ready") && canvas &&
          canvas.width >= 300 && canvas.height >= 300);
      }, undefined, { timeout: 10000 });
      await page.waitForTimeout(500);
      const rendererState = await page.locator("#arena").evaluate((arena) => {
        const canvas = arena.querySelector("canvas.bomb-3d-canvas");
        return {
          threeReady: arena.classList.contains("three-ready"),
          canvasWidth: canvas?.width || 0,
          canvasHeight: canvas?.height || 0,
          gameWidth: Math.round(arena.getBoundingClientRect().width),
          gameHeight: Math.round(arena.getBoundingClientRect().height),
          visibleCharacterFallbacks: [...arena.querySelectorAll(".player-character,.bot-character")]
            .filter((el) => getComputedStyle(el).visibility !== "hidden").length
        };
      });
      console.log("Bomb mobile visual renderer check: " + JSON.stringify(rendererState));
      await page.screenshot({ path: resolve(root, "artifacts/bomb-game-mobile.png"), fullPage: true });
      assert.equal(rendererState.threeReady, true, "The visible game must actually render with the 3D layer.");
      assert.ok(rendererState.canvasWidth >= 300 && rendererState.canvasHeight >= 300,
        "The 3D renderer should draw to a mobile-sized canvas.");
    }
    await page.locator("#gameBack").click();
  }

  await page.locator('#playerCountControl button[data-count="4"]').click();
  await page.locator('#modeControl button[data-mode="local"]').click();
  // Keep player 0 as the first holder, and give the fuse the full 15.4-second test window.
  await page.evaluate(() => {
    let randomCall = 0;
    Math.random = () => (++randomCall === 1 ? 0 : 0.9999);
  });
  await page.locator("#startGame").click();

  const outfitColors = await page.evaluate(() => [1,2,3].map(index =>
    document.querySelector('#botCharacters .bot-character[data-player="' + index + '"] svg linearGradient[id^="minerJacket-bot-' + index + '"] stop')
      ?.getAttribute("stop-color")));
  assert.deepEqual(outfitColors, ["#a6f1ff", "#f7b6ff", "#ddff9d"],
    "The three visible bot miners must have different blue, purple and green jackets.");

  const visibleRendererState = await page.locator("#arena").evaluate(arena => {
    const canvas = arena.querySelector("canvas.bomb-3d-canvas");
    const style = canvas ? getComputedStyle(canvas) : null;
    return {
      threeReady: arena.classList.contains("three-ready"),
      canvasPresent: Boolean(canvas),
      canvasVisibility: style?.visibility || "missing",
      canvasDisplay: style?.display || "missing",
      canvasWidth: canvas?.width || 0,
      canvasHeight: canvas?.height || 0
    };
  });
  assert.equal(visibleRendererState.threeReady, true,
    "The full-screen arena must run the 3D renderer in the visual test.");
  assert.equal(visibleRendererState.canvasPresent, true,
    "The 3D renderer canvas must be present for the visible miner models.");
  assert.equal(visibleRendererState.canvasVisibility, "visible");
  assert.equal(visibleRendererState.canvasDisplay, "block");
  assert.ok(visibleRendererState.canvasWidth >= 300 && visibleRendererState.canvasHeight >= 500,
    "The 3D canvas must cover the mobile playfield: " + JSON.stringify(visibleRendererState));
  const characterVisual = await page.locator("#playerCharacter").evaluate(el => {
    const s = getComputedStyle(el);
    const figure = el.querySelector(".runner-figure");
    const r = figure.getBoundingClientRect();
    return {display:s.display,visibility:s.visibility,opacity:Number(s.opacity),figureWidth:r.width,figureHeight:r.height};
  });
  assert.notEqual(characterVisual.display,"none","The fallback character DOM must remain mounted.");
  assert.equal(characterVisual.visibility,"hidden",
    "The fallback SVG miner should be hidden when the fully rendered 3D miner is active.");
  assert.ok(characterVisual.figureWidth >= 70 && characterVisual.figureHeight >= 90,
    "The fallback figure must retain its mobile layout dimensions: " + JSON.stringify(characterVisual));
  assert.equal(await page.locator("#seats .seat.current").getAttribute("data-player"),"0",
    "The predictable contact test should start with the human player holding the bomb.");
  assert.equal(await page.locator("#playerCharacter .runner-figure").count(), 1,
    "The player should use the original custom SVG figure.");
  assert.equal(await page.locator("#moveJoystick").isVisible(), true,
    "A touch joystick should be available during a round.");
  const joystickBox = await page.locator("#moveJoystick").boundingBox();
  assert.ok(joystickBox, "The joystick should have a measurable position.");
  assert.ok(joystickBox.width >= 98 && joystickBox.height >= 98,
    "On a portrait phone the movement joystick should be at least 98 by 98 pixels.");
  const joystickCenterX = joystickBox.x + joystickBox.width / 2;
  const joystickCenterY = joystickBox.y + joystickBox.height / 2;

  // A small six-pixel deflection should now start movement instead of being lost in a dead zone.
  const beforeSensitiveMove = await page.locator("#playerCharacter").boundingBox();
  assert.ok(beforeSensitiveMove, "The player transform should exist before the joystick sensitivity test.");
  const knobBeforeSensitiveMove = await page.locator("#joystickKnob").evaluate(el => el.style.transform);
  await page.mouse.move(joystickCenterX, joystickCenterY);
  await page.mouse.down();
  await page.mouse.move(joystickCenterX, joystickCenterY - 6, { steps: 2 });
  await page.waitForTimeout(300);
  const afterSensitiveMove = await page.locator("#playerCharacter").boundingBox();
  const knobAfterSensitiveMove = await page.locator("#joystickKnob").evaluate(el => el.style.transform);
  await page.mouse.up();
  console.log("Bomb joystick micro-input check: " + JSON.stringify({
    beforeY: beforeSensitiveMove?.y,
    afterY: afterSensitiveMove?.y,
    knobBefore: knobBeforeSensitiveMove,
    knobAfter: knobAfterSensitiveMove
  }));
  assert.ok(afterSensitiveMove, "The player transform should remain measurable during joystick input.");
  assert.notEqual(knobAfterSensitiveMove, knobBeforeSensitiveMove,
    "A six-pixel joystick movement should visibly move the on-screen joystick knob.");

  const characterBefore = await page.locator("#playerCharacter").boundingBox();
  assert.ok(characterBefore, "The character should remain visible before full joystick travel.");
  await page.mouse.move(joystickCenterX, joystickCenterY);
  await page.mouse.down();
  await page.mouse.move(joystickCenterX, joystickCenterY - joystickBox.height * 0.31, { steps: 6 });
  await page.waitForTimeout(300);
  const characterWhileMoving = await page.locator("#playerCharacter").boundingBox();
  const walkingClassDuringMove = await page.locator("#playerCharacter").evaluate(el => el.classList.contains("walking"));
  await page.mouse.up();
  // Let momentum settle briefly; the movement layer intentionally has a smooth coast-down.
  await page.waitForTimeout(350);
  const characterAfterMove = await page.locator("#playerCharacter").boundingBox();
  const joystickAfterRelease = await page.locator("#joystickKnob").evaluate(el => el.style.transform);
  assert.ok(characterWhileMoving && characterAfterMove, "The character should stay rendered while moving.");
  assert.ok(Math.abs((characterAfterMove.y + characterAfterMove.height / 2) -
    (characterBefore.y + characterBefore.height / 2)) > 12,
    "Dragging the joystick should physically move the character across the arena.");
  assert.equal(walkingClassDuringMove, true, "Leg and arm running animations should activate while moving.");
  assert.match(joystickAfterRelease, /-50%/,
    "The joystick knob should spring back to its resting position after finger release.");

  assert.equal(await page.evaluate(() => typeof window.__allcoinsBackHandler), "function",
    "The Telegram back-button handler should be registered.");
  await page.evaluate(() => window.__allcoinsBackHandler());
  assert.equal(await page.locator("#gameView").isVisible(), true,
    "Using Telegram's back button must not eject the user from an active round.");
  assert.match(await page.locator("#instruction").innerText(), /Матч продолжается/i,
    "The game should explain that the active match is being kept open.");
  const activeUrl = page.url();
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")));
  assert.equal(await page.locator("#gameView").isVisible(), true,
    "A browser back navigation should not eject the player from an active round.");
  assert.equal(page.url(), activeUrl, "The active game should remain on its current URL.");

  const previousHolder = await page.locator("#seats .seat.current").getAttribute("data-player");
  const target = "3"; // Bottom-right opponent, reachable by moving down and right.
  const beforePass = await page.locator("#bomb").boundingBox();

  // Tapping an opponent chooses/highlights them, but must not pass the bomb from across the arena.
  await page.locator('#seats .seat[data-player="' + target + '"]').click();
  assert.equal(await page.locator("#seats .seat.current").getAttribute("data-player"), "0",
    "A remote tap should not pass the bomb before the character reaches the opponent.");
  assert.match(await page.locator("#instruction").innerText(), /физическом касании/i,
    "The game should tell the player that contact transfers the bomb.");

  // Steer toward the actual opponent position instead of assuming a fixed diagonal
  // reaches them on every viewport/map layout. Keep one pointer held to test real joystick input.
  const stick = await page.locator("#moveJoystick").boundingBox();
  assert.ok(stick, "The movement joystick should be visible before contact.");
  const sx = stick.x + stick.width / 2;
  const sy = stick.y + stick.height / 2;
  const targetCharacter = page.locator('#botCharacters .bot-character[data-player="3"]');
  assert.equal(await targetCharacter.count(), 1, "The target opponent should have a visible character.");
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  let contactReached = false;
  const contactDeadline = Date.now() + 7000;
  try {
    while (Date.now() < contactDeadline) {
      if (await page.locator('#seats .seat.current').getAttribute("data-player") === "3") {
        contactReached = true;
        break;
      }
      const positions = await page.evaluate(() => {
        const player = document.querySelector("#playerCharacter");
        const target = document.querySelector('#botCharacters .bot-character[data-player="3"]');
        if (!player || !target) return null;
        return {
          playerX: Number.parseFloat(player.style.left),
          playerY: Number.parseFloat(player.style.top),
          targetX: Number.parseFloat(target.style.left),
          targetY: Number.parseFloat(target.style.top)
        };
      });
      if (!positions || !Object.values(positions).every(Number.isFinite)) break;
      const dx = positions.targetX - positions.playerX;
      const dy = positions.targetY - positions.playerY;
      const distance = Math.hypot(dx, dy);
      if (distance < 1) break;
      const joystickTravel = stick.width * .32;
      await page.mouse.move(
        sx + dx / distance * joystickTravel,
        sy + dy / distance * joystickTravel,
        { steps: 2 }
      );
      await page.waitForTimeout(90);
    }
  } finally {
    await page.mouse.up();
  }
  if (!contactReached) {
    contactReached = await page.locator('#seats .seat.current').getAttribute("data-player") === "3";
  }
  assert.equal(contactReached, true,
    "Joystick movement should physically reach the selected opponent and transfer the bomb.");
  await page.waitForTimeout(560);
  assert.equal(await page.locator("#seats .seat.current").getAttribute("data-player"), target,
    "Physically touching the opponent should automatically transfer the bomb to them.");
  const afterPass = await page.locator("#bomb").boundingBox();
  assert.ok(beforePass && afterPass, "The bomb should remain visible during and after a contact pass.");
  assert.ok(Math.hypot(
    (afterPass.x + afterPass.width / 2) - (beforePass.x + beforePass.width / 2),
    (afterPass.y + afterPass.height / 2) - (beforePass.y + beforePass.height / 2)
  ) > 35, "The bomb should animate from the moving character to the contacted opponent.");

  const livesBefore = await page.locator("#seats .seat").evaluateAll(seats =>
    Object.fromEntries(seats.map(seat => [
      seat.dataset.player,
      seat.querySelectorAll(".lives .heart.on").length
    ]))
  );
  // Wait for the first explosion, then verify the game automatically starts round 2 without a button.
  await page.waitForFunction(() =>
    (document.querySelector("#fuseLabel")?.textContent || "").includes("Взрыв") ||
    Number(document.querySelector("#roundLabel")?.textContent || "0") >= 2,
    undefined,
    { timeout: 18000 }
  );
  try {
    await page.waitForFunction(() => {
      const round = Number(document.querySelector("#roundLabel")?.textContent || "0");
      const fuse = document.querySelector("#fuseLabel")?.textContent || "";
      const overlay = document.querySelector("#resultOverlay");
      const continueButton = document.querySelector("#continueRound");
      // "Скоро" is also an active second-round state when a slow CI frame is delayed.
      return round >= 2 && /Горит|Скоро/.test(fuse) &&
        overlay?.classList.contains("hidden") && continueButton?.hidden === true;
    }, undefined, { timeout: 12000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      round: document.querySelector("#roundLabel")?.textContent || "",
      fuse: document.querySelector("#fuseLabel")?.textContent || "",
      message: document.querySelector("#centerMessage")?.textContent || "",
      instruction: document.querySelector("#instruction")?.innerText || "",
      overlayClass: document.querySelector("#resultOverlay")?.className || "",
      continueHidden: document.querySelector("#continueRound")?.hidden ?? null,
      alive: document.querySelector("#aliveLabel")?.textContent || ""
    }));
    console.error("Bomb automatic next-round diagnostic: " + JSON.stringify(state));
    throw error;
  }
  const livesAfter = await page.locator("#seats .seat").evaluateAll(seats =>
    Object.fromEntries(seats.map(seat => [
      seat.dataset.player,
      seat.querySelectorAll(".lives .heart.on").length
    ]))
  );
  const playersWhoLostLife = Object.keys(livesBefore).filter(playerId =>
    livesAfter[playerId] === livesBefore[playerId] - 1
  );
  assert.equal(playersWhoLostLife.length, 1,
    "Exactly the player holding the bomb at explosion must visibly lose one heart.");
  for (const [playerId, lives] of Object.entries(livesBefore)) {
    if (playersWhoLostLife.includes(playerId)) continue;
    assert.equal(livesAfter[playerId], lives,
      "Players who were not holding the bomb at explosion must keep their lives.");
  }
  assert.equal(await page.locator("#resultOverlay").isVisible(), false,
    "A regular explosion must not open a result dialog.");
  assert.equal(await page.locator("#continueRound").isVisible(), false,
    "There must be no manual Next Round button after an ordinary explosion.");
  assert.equal(await page.locator("#roundLabel").innerText(), "2",
    "The next round should begin automatically and be numbered correctly.");
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(root, "artifacts/bomb-next-round-mobile.png"), fullPage: true });

  await page.locator("#gameBack").click();
  await page.locator('#playerCountControl button[data-count="4"]').click();
  await page.locator('#modeControl button[data-mode="bots"]').click();
  await page.evaluate(() => {
    window.__allcoinsOriginalMathRandom = Math.random;
    Math.random = () => 0.9999;
  });
  await page.locator("#startGame").click();
  const botHolder = await page.locator("#seats .seat.current").getAttribute("data-player");
  assert.ok(["1", "2", "3"].includes(botHolder), "Deterministic setup should start with a bot holding the bomb.");
  assert.equal(await page.locator("#botCharacters .bot-character").count(), 3,
    "All three computer opponents should be shown as miner characters.");
  // Keep the bot start deterministic, then target the first player across the arena.
  // The fixed random value could otherwise select an adjacent bot and skip walking.
  await page.evaluate(() => { Math.random = () => 0; });
  await page.waitForFunction((previousHolder) => {
    const current = document.querySelector("#seats .seat.current")?.dataset.player;
    const botIsWalking = Boolean(document.querySelector("#botCharacters .bot-character.walking"));
    // A very fast bot can finish a short transfer between browser polling frames.
    return Boolean((current && current !== previousHolder) || botIsWalking);
  }, botHolder, { timeout: 8000 });
  await page.waitForFunction((previousHolder) => {
    const current = document.querySelector("#seats .seat.current")?.dataset.player;
    return Boolean(current && current !== previousHolder);
  }, botHolder, { timeout: 8000 });
  const nextHolder = await page.locator("#seats .seat.current").getAttribute("data-player");
  assert.notEqual(nextHolder, botHolder, "A bot should walk to an opponent and pass the bomb on contact.");
  await page.evaluate(() => {
    if (window.__allcoinsOriginalMathRandom) {
      Math.random = window.__allcoinsOriginalMathRandom;
      delete window.__allcoinsOriginalMathRandom;
    }
  });

  await page.setViewportSize({ width: 320, height: 700 });
  const dimensions = await page.locator("#gameView").evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 2,
    "The game should not create horizontal overflow on a narrow phone.");
  await page.locator("#gameBack").click();
  assert.equal(await page.locator("#setupView").isVisible(), true,
    "The game should return to setup without leaving the app page.");

  // Regression: retain the same active finger gesture when a bot passes the bomb to us.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#playerCountControl button[data-count="2"]').click();
  await page.locator('#modeControl button[data-mode="bots"]').click();
  await page.evaluate(() => { Math.random = () => 0.9999; });
  await page.locator("#startGame").click();
  assert.equal(await page.locator("#seats .seat.current").getAttribute("data-player"), "1",
    "The deterministic two-player round should start with the bot holding the bomb.");
  const handoffStick = await page.locator("#moveJoystick").boundingBox();
  assert.ok(handoffStick, "The joystick must be available during a bot hand-off.");
  const handoffX = handoffStick.x + handoffStick.width / 2;
  const handoffY = handoffStick.y + handoffStick.height / 2;
  await page.mouse.move(handoffX, handoffY);
  await page.mouse.down();
  await page.waitForFunction(() =>
    document.querySelector('#seats .seat.current')?.dataset.player === "0",
    undefined,
    { timeout: 5000 }
  );
  await page.waitForTimeout(520);
  const humanBeforeContinuedDrag = await page.locator("#playerCharacter").boundingBox();
  assert.ok(humanBeforeContinuedDrag, "The player character should remain visible after the bot hand-off.");
  // Move the already-held pointer left; no second pointerdown is allowed in this regression.
  await page.mouse.move(handoffX - handoffStick.width * .31, handoffY, { steps: 5 });
  await page.waitForTimeout(260);
  const humanAfterContinuedDrag = await page.locator("#playerCharacter").boundingBox();
  assert.ok(humanAfterContinuedDrag &&
    humanAfterContinuedDrag.x + humanAfterContinuedDrag.width / 2 <
      humanBeforeContinuedDrag.x + humanBeforeContinuedDrag.width / 2 - 10,
    "Movement must resume after a bot passes the bomb while the same pointer remains held.");
  await page.mouse.up();
  assert.equal(await page.locator("#gameView").isVisible(), true,
    "The current round must stay open after the bot hand-off and joystick recovery.");

  assert.deepEqual(pageErrors, [], "The game should not throw browser runtime errors.");
  assert.deepEqual(consoleErrors, [], "The browser should not report console errors during the visual test.");
  console.log("Pass the Bomb browser and visual test passed: 3D canvas, lobby/maps, miner models, joystick movement, contact transfers, automatic next round, active-round back guard, explosions and 320px mobile layout.");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((err) => err ? rejectClose(err) : resolveClose()));
}
