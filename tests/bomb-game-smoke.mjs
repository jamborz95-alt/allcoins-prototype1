import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const bombHtml = await readFile(resolve(root, "bomb.html"), "utf8");
const indexHtml = await readFile(resolve(root, "index.html"), "utf8");

const bombTile = indexHtml.indexOf('id="bombEntry"');
assert.ok(bombTile >= 0, "The Games menu must include the Pass the Bomb tile.");
assert.ok(indexHtml.includes('href="./bomb.html?v=20261025-botsound2"'),
  "The game link should remain stable.");
assert.ok(indexHtml.indexOf('id="durakEntry"') < bombTile &&
  bombTile < indexHtml.indexOf('id="unoEntry"'),
  "Pass the Bomb should appear in the first row after Durak.");
assert.ok(bombHtml.includes("function startGame()") && bombHtml.includes("function passBombFromBot(target)"),
  "The standalone game must include its start and bot-pass logic.");
assert.ok(bombHtml.includes('<svg class="mine-scene"') &&
  bombHtml.includes('data-map="copper"') && bombHtml.includes('data-map="crystal"'),
  "The game should include original inline mine artwork and two selectable original maps.");
assert.ok(!/<img[^>]+src=["']https?:\/\//i.test(bombHtml),
  "The mine artwork should not depend on copied or remotely hosted image assets.");
assert.ok(bombHtml.includes("function playDynamiteFuseSound(left)") &&
  bombHtml.includes("function playExplosionSound()"),
  "The dynamite fuse and explosion should have original generated sound effects.");

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/" || pathname === "/bomb.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(bombHtml);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});
await new Promise((resolveListen) => server.listen(4175, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  assert.equal(await page.locator("#mapControl [data-map]").count(), 2,
    "The lobby should offer two original selectable map cards.");
  await page.locator('#mapControl [data-map="crystal"]').click();
  assert.equal(await page.locator('#mapControl [data-map="crystal"]').getAttribute("aria-pressed"), "true",
    "Selecting a map should visibly update the selected state.");

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
    assert.equal(await page.locator("#arena").getAttribute("data-map"), "crystal",
      "The selected map should be applied to the full-screen game arena.");
    await page.locator("#gameBack").click();
  }

  await page.locator('#playerCountControl button[data-count="4"]').click();
  await page.locator('#modeControl button[data-mode="local"]').click();
  await page.evaluate(() => { Math.random = () => 0; });
  await page.locator("#startGame").click();

  assert.equal(await page.locator("#playerCharacter").isVisible(), true,
    "The full-screen arena should show the custom player character.");
  const characterVisual = await page.locator("#playerCharacter").evaluate(el => {
    const s = getComputedStyle(el);
    const figure = el.querySelector(".runner-figure");
    const r = figure.getBoundingClientRect();
    return {display:s.display,visibility:s.visibility,opacity:Number(s.opacity),figureWidth:r.width,figureHeight:r.height};
  });
  assert.notEqual(characterVisual.display,"none","The player character must not be hidden by CSS.");
  assert.equal(characterVisual.visibility,"visible","The character should remain visible during play.");
  assert.ok(characterVisual.opacity > .9 && characterVisual.figureWidth >= 70 && characterVisual.figureHeight >= 90,
    "The character should be large and visible on a phone: " + JSON.stringify(characterVisual));
  assert.equal(await page.locator("#seats .seat.current").getAttribute("data-player"),"0",
    "The predictable contact test should start with the human player holding the bomb.");
  assert.equal(await page.locator("#playerCharacter .runner-figure").count(), 1,
    "The player should use the original custom SVG figure.");
  assert.equal(await page.locator("#moveJoystick").isVisible(), true,
    "A touch joystick should be available during a round.");
  const characterBefore = await page.locator("#playerCharacter").boundingBox();
  const joystickBox = await page.locator("#moveJoystick").boundingBox();
  assert.ok(characterBefore && joystickBox, "The character and joystick should have measurable positions.");
  const joystickCenterX = joystickBox.x + joystickBox.width / 2;
  const joystickCenterY = joystickBox.y + joystickBox.height / 2;
  await page.mouse.move(joystickCenterX, joystickCenterY);
  await page.mouse.down();
  await page.mouse.move(joystickCenterX, joystickCenterY - joystickBox.height * 0.31, { steps: 6 });
  await page.waitForTimeout(300);
  const characterWhileMoving = await page.locator("#playerCharacter").boundingBox();
  const walkingClassDuringMove = await page.locator("#playerCharacter").evaluate(el => el.classList.contains("walking"));
  await page.mouse.up();
  await page.waitForTimeout(70);
  const characterAfterMove = await page.locator("#playerCharacter").boundingBox();
  const walkingClassAfterRelease = await page.locator("#playerCharacter").evaluate(el => el.classList.contains("walking"));
  assert.ok(characterWhileMoving && characterAfterMove, "The character should stay rendered while moving.");
  assert.ok(Math.abs((characterAfterMove.y + characterAfterMove.height / 2) -
    (characterBefore.y + characterBefore.height / 2)) > 12,
    "Dragging the joystick should physically move the character across the arena.");
  assert.equal(walkingClassDuringMove, true, "Leg and arm running animations should activate while moving.");
  assert.equal(walkingClassAfterRelease, false, "The character should stop walking when the joystick is released.");

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

  // Hold the virtual joystick diagonally. The animated miner should physically reach the opponent.
  const stick = await page.locator("#moveJoystick").boundingBox();
  assert.ok(stick, "The movement joystick should be visible before contact.");
  const sx = stick.x + stick.width / 2;
  const sy = stick.y + stick.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + stick.width * .31, sy + stick.height * .31, {steps:8});
  await page.waitForFunction(() =>
    document.querySelector('#seats .seat.current')?.dataset.player === "3",
    undefined,
    { timeout: 3500 }
  );
  await page.waitForTimeout(560);
  await page.mouse.up();
  assert.equal(await page.locator("#seats .seat.current").getAttribute("data-player"), target,
    "Physically touching the opponent should automatically transfer the bomb to them.");
  const afterPass = await page.locator("#bomb").boundingBox();
  assert.ok(beforePass && afterPass, "The bomb should remain visible during and after a contact pass.");
  assert.ok(Math.hypot(
    (afterPass.x + afterPass.width / 2) - (beforePass.x + beforePass.width / 2),
    (afterPass.y + afterPass.height / 2) - (beforePass.y + beforePass.height / 2)
  ) > 35, "The bomb should animate from the moving character to the contacted opponent.");

  const heartsBefore = await page.locator(
    '#seats .seat[data-player="' + target + '"] .lives .heart.on'
  ).count();
  // The fuse lasts at most 15.4 seconds. Allow extra time for the result overlay.
  await page.waitForTimeout(16300);
  assert.equal(await page.locator("#resultOverlay").isVisible(), true,
    "The fuse should end with an explosion result.");
  assert.ok(["БУМ!", "ПОБЕДА!"].includes(await page.locator("#resultTitle").innerText()));
  const heartsAfter = await page.locator(
    '#seats .seat[data-player="' + target + '"] .lives .heart.on'
  ).count();
  assert.equal(heartsAfter, heartsBefore - 1,
    "The player who holds the bomb at explosion must visibly lose one heart.");
  assert.equal(await page.locator("#resultPrimary").innerText(), "Следующий раунд");
  await page.locator("#resultPrimary").click();
  assert.equal(await page.locator("#roundLabel").innerText(), "2",
    "The next round should start and be numbered correctly.");

  await page.locator("#gameBack").click();
  await page.locator('#playerCountControl button[data-count="4"]').click();
  await page.locator('#modeControl button[data-mode="bots"]').click();
  await page.evaluate(() => { Math.random = () => 0.9999; });
  await page.locator("#startGame").click();
  const botHolder = await page.locator("#seats .seat.current").getAttribute("data-player");
  assert.ok(["1", "2", "3"].includes(botHolder), "Deterministic setup should start with a bot holding the bomb.");
  assert.equal(await page.locator("#botCharacters .bot-character").count(), 3,
    "All three computer opponents should be shown as miner characters.");
  await page.waitForFunction(() => Boolean(document.querySelector("#botCharacters .bot-character.walking")),
    undefined, { timeout: 2400 });
  await page.waitForFunction((previousHolder) => {
    const current = document.querySelector("#seats .seat.current")?.dataset.player;
    return Boolean(current && current !== previousHolder);
  }, botHolder, { timeout: 4000 });
  const nextHolder = await page.locator("#seats .seat.current").getAttribute("data-player");
  assert.notEqual(nextHolder, botHolder, "A bot should walk to an opponent and pass the bomb on contact.");

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
  assert.deepEqual(pageErrors, [], "The game should not throw browser runtime errors.");
  console.log("Pass the Bomb smoke test passed: lobby/maps, visible human and bot miners, joystick movement, contact transfers, dynamite audio code, active-round back guard, explosions and 320px mobile layout.");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((err) => err ? rejectClose(err) : resolveClose()));
}
