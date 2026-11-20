import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const files = new Map([
  ["/racing-host.js", ["racing-host.js", "text/javascript; charset=utf-8"]],
  ["/racing-game.html", ["racing-game.html", "text/html; charset=utf-8"]],
  ["/vendor/three-r147.min.js", ["vendor/three-r147.min.js", "text/javascript; charset=utf-8"]],
  ["/vendor/GLTFLoader-r147.js", ["vendor/GLTFLoader-r147.js", "text/javascript; charset=utf-8"]]
]);
const pageHtml = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="allcoins-racing-amvera-api" content="">
<title>ALLCOINS Racing classic runtime test</title></head>
<body>
<a id="openDragRacing" href="#race" data-allcoins-racing-launch="true">Драг-рейсинг 3D</a>
<script>
window.__telegramFullscreenCalls = 0;
window.Telegram = { WebApp: {
  initData: "mock-telegram-init-data",
  ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
  requestFullscreen() { window.__telegramFullscreenCalls++; },
  isFullscreen: false, exitFullscreen() {}
}};
</script>
<script src="/racing-host.js"></script>
</body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(pageHtml);
    return;
  }
  const entry = files.get(pathname);
  if (entry) {
    const body = await readFile(resolve(root, entry[0]));
    response.writeHead(200, {
      "content-type": entry[1],
      "content-length": String(body.byteLength),
      "cache-control": "no-store"
    });
    response.end(body);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found: " + pathname);
});

let browser;
try {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  browser = await chromium.launch({
    headless: true,
    args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader", "--disable-gpu-sandbox"]
  });
  const page = await browser.newPage({
    viewport: { width: 1365, height: 768 },
    isMobile: true,
    hasTouch: true
  });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  const apiCalls = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    apiCalls.push({ path: url.pathname, method: request.method() });

    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "Authorization,Content-Type,Range",
          "access-control-max-age": "600"
        }
      });
    }

    if (url.pathname === "/api/auth/telegram" && request.method() === "POST") {
      const body = request.postDataJSON();
      assert.equal(body.initData, "mock-telegram-init-data");
      return route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify({ token: "mock-engine-session-token", user: { id: "test-user" } })
      });
    }

    if (url.pathname === "/api/racing/shared-model-asset" && request.method() === "GET") {
      assert.equal(request.headers().authorization, "Bearer mock-engine-session-token");
      assert.match(request.headers().range || "", /^bytes=0-/);
      return route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "X-File-Name, Content-Length, Content-Range, Accept-Ranges",
          "content-type": "model/gltf-binary",
          "content-length": "4",
          "x-file-name": "test-vaz-2107.glb"
        },
        body: Buffer.from("glTF", "ascii")
      });
    }

    return route.fulfill({
      status: 404,
      headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
      body: JSON.stringify({ error: "Unexpected Racing API request: " + url.pathname })
    });
  });

  await page.goto("http://127.0.0.1:" + address.port + "/", { waitUntil: "domcontentloaded" });
  await page.locator("#openDragRacing").click();
  assert.equal(await page.evaluate(() => window.__telegramFullscreenCalls), 1);

  const frameLocator = page.locator("#allcoinsRacingV24Overlay iframe");
  await frameLocator.waitFor({ state: "attached", timeout: 10000 });
  await page.waitForFunction(() => {
    const frame = document.querySelector("#allcoinsRacingV24Overlay iframe");
    return frame && frame.src.includes("/racing-game.html") && !frame.srcdoc;
  }, null, { timeout: 10000 });

  let gameFrame;
  for (let attempt = 0; attempt < 50 && !gameFrame; attempt++) {
    gameFrame = page.frames().find(frame => frame.url().includes("racing-game.html"));
    if (!gameFrame) await page.waitForTimeout(100);
  }
  assert.ok(gameFrame, "The game must load as a normal same-origin iframe document.");

  try {
    await gameFrame.waitForFunction(() => {
      const state = window.__allcoinsRacingBoot;
      return state && state.moduleStarted && state.webglReady && state.modelRequestSent && state.modelAckReceived;
    }, null, { timeout: 20000 });
  } catch (error) {
    const diagnostic = await gameFrame.evaluate(() => ({
      href: location.href,
      readyState: document.readyState,
      boot: window.__allcoinsRacingBoot || null,
      threeLoaded: Boolean(window.THREE),
      gltfLoaderLoaded: Boolean(window.THREE && window.THREE.GLTFLoader),
      messageTitle: document.querySelector("#message strong")?.textContent || null,
      messageText: document.querySelector("#messageText")?.textContent || null,
      rendererCanvas: Boolean(document.querySelector("#view")),
      scripts: [...document.scripts].map(s => ({ src: s.src || "inline", type: s.type || "classic", loaded: !s.src || s.dataset.loaded || true }))
    }));
    console.error("RACING BOOT DIAGNOSTIC:", JSON.stringify(diagnostic));
    await page.screenshot({ path: resolve(root, "artifacts", "racing-boot-failure.png"), fullPage: true });
    throw new Error("Racing scene did not complete startup handshake: " + JSON.stringify(diagnostic) + "; " + error.message);
  }

  const graphicsProfile = await gameFrame.evaluate(() => window.__allcoinsRacingGraphicsProfile || null);
  assert.ok(graphicsProfile, "The game must expose its mobile graphics profile.");
  if (graphicsProfile.mobileOptimized) {
    assert.equal(graphicsProfile.realTimeShadows, false, "Mobile rendering must skip expensive real-time shadows.");
    assert.ok(graphicsProfile.pixelRatio <= 1.28, "Mobile render resolution must stay within the sharper adaptive cap.");
    assert.equal(graphicsProfile.asphaltBumpMap, false, "Mobile asphalt must use the lighter shader.");
    assert.equal(graphicsProfile.rainSegments, 55, "Mobile rain particle count must be reduced.");
  }

  const visibilityResume = await gameFrame.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    const wasPausedInBackground = document.getElementById("pause").textContent === "ПРОДОЛЖИТЬ";
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    return {
      wasPausedInBackground,
      resumed: document.getElementById("pause").textContent === "ПАУЗА"
    };
  });
  assert.deepEqual(visibilityResume, { wasPausedInBackground: true, resumed: true },
    "An Android WebView background/rotation pause must resume when the scene becomes visible again.");

  const dashboardDiagnostics = await gameFrame.evaluate(() => window.__allcoinsRacingDashboardDiagnostics || null);
  assert.ok(dashboardDiagnostics, "The V26 live dashboard must be initialized.");
  assert.equal(dashboardDiagnostics.speedometerUsesLiveSpeed, true);
  assert.equal(dashboardDiagnostics.tachometerUsesLiveRpm, true);
  assert.equal(dashboardDiagnostics.speedometerScaleTicks, 41);
  assert.equal(dashboardDiagnostics.tachometerScaleTicks, 45);
  assert.equal(dashboardDiagnostics.acceleratorButton, true);
  assert.equal(dashboardDiagnostics.brakeButton, true);
  assert.equal(dashboardDiagnostics.gearPlusButton, true);
  assert.equal(dashboardDiagnostics.gearMinusButton, true);
  assert.ok(await gameFrame.locator("#speedometer-ticks svg line, .speedometer-ticks svg line").count() >= 41,
    "The speedometer must show a graduated 0–400 km/h scale.");
  assert.ok(await gameFrame.locator(".tachometer-ticks svg line").count() >= 45,
    "The tachometer must show a graduated 0–11,000 RPM scale.");
  assert.notEqual(await gameFrame.locator("#gearUp").evaluate(el => getComputedStyle(el).display), "none",
    "The upshift (+) control must be visible.");
  assert.notEqual(await gameFrame.locator("#gearDown").evaluate(el => getComputedStyle(el).display), "none",
    "The downshift (−) control must be visible.");
  await gameFrame.locator("#gearUp").dispatchEvent("pointerdown", { pointerId: 40, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true });
  assert.equal((await gameFrame.locator("#gearNow").textContent()).trim(), "2",
    "The + control must raise the selected gear.");
  await gameFrame.locator("#gearUp").dispatchEvent("pointerup", { pointerId: 40, pointerType: "touch", isPrimary: true, bubbles: true });
  await gameFrame.locator("#gearDown").dispatchEvent("pointerdown", { pointerId: 41, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true });
  assert.equal((await gameFrame.locator("#gearNow").textContent()).trim(), "1",
    "The − control must lower the selected gear.");
  await gameFrame.locator("#gearDown").dispatchEvent("pointerup", { pointerId: 41, pointerType: "touch", isPrimary: true, bubbles: true });

  assert.equal(await gameFrame.locator("#gearPattern").evaluate(el => getComputedStyle(el).display), "none",
    "The large numbered gear selector must be hidden; only + / − remain visible.");
  assert.notEqual(await gameFrame.locator("#gearUp").evaluate(el => getComputedStyle(el).display), "none");
  assert.notEqual(await gameFrame.locator("#gearDown").evaluate(el => getComputedStyle(el).display), "none");
  assert.equal(await gameFrame.locator("#gas").isDisabled(), false,
    "The gas pedal must remain usable while the fuel profile is loading or unavailable.");
  await gameFrame.locator("#gas").dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true });
  assert.ok(await gameFrame.locator("#gas").evaluate(el => el.classList.contains("active")),
    "The gas pedal must activate while pressed.");
  await gameFrame.locator("#gearUp").dispatchEvent("pointerdown", { pointerId: 8, pointerType: "touch", isPrimary: false, bubbles: true, cancelable: true });
  assert.equal((await gameFrame.locator("#gearNow").textContent()).trim(), "2",
    "A second touch must upshift while the first touch keeps the accelerator pressed.");
  assert.ok(await gameFrame.locator("#gas").evaluate(el => el.classList.contains("active")),
    "Upshifting must keep the accelerator held.");
  assert.deepEqual(await gameFrame.evaluate(() => window.__allcoinsRacingShiftDiagnostics), {
    shiftCount: 3,
    lastShiftWithThrottle: true,
    throttlePreserved: true
  }, "The gear handler must preserve the live throttle state during a second-finger shift.");
  assert.doesNotMatch(await gameFrame.locator("#gearHint").textContent(), /ОТПУСТИ ГАЗ/,
    "The dashboard must not ask the driver to release the accelerator before shifting.");
  await gameFrame.locator("#gearUp").dispatchEvent("pointerup", { pointerId: 8, pointerType: "touch", isPrimary: false, bubbles: true });
  await gameFrame.locator("#gearDown").dispatchEvent("pointerdown", { pointerId: 9, pointerType: "touch", isPrimary: false, bubbles: true, cancelable: true });
  assert.equal((await gameFrame.locator("#gearNow").textContent()).trim(), "1",
    "A second touch must downshift while the first touch keeps the accelerator pressed.");
  assert.ok(await gameFrame.locator("#gas").evaluate(el => el.classList.contains("active")),
    "Downshifting must keep the accelerator held.");
  assert.equal(await gameFrame.evaluate(() => window.__allcoinsRacingShiftDiagnostics.lastShiftWithThrottle), true,
    "Downshifting must register that the accelerator is still held.");
  assert.equal(await gameFrame.evaluate(() => window.__allcoinsRacingShiftDiagnostics.throttlePreserved), true,
    "Downshifting must not release the accelerator.");
  await gameFrame.locator("#gas").dispatchEvent("pointerup", { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true });
  assert.ok(!(await gameFrame.locator("#gas").evaluate(el => el.classList.contains("active"))),
    "The gas pedal must release cleanly.");
  await gameFrame.locator("#brake").dispatchEvent("pointerdown", { pointerId: 8, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true });
  assert.ok(await gameFrame.locator("#brake").evaluate(el => el.classList.contains("active")),
    "The brake pedal must activate while pressed.");
  await gameFrame.locator("#brake").dispatchEvent("pointerup", { pointerId: 8, pointerType: "touch", isPrimary: true, bubbles: true });
  assert.ok(!(await gameFrame.locator("#brake").evaluate(el => el.classList.contains("active"))),
    "The brake pedal must release cleanly.");

  const visualDiagnostics = await gameFrame.evaluate(() => window.__allcoinsRacingVisualDiagnostics || null);
  assert.ok(visualDiagnostics, "The V25 road and city diagnostics must be available.");
  assert.equal(visualDiagnostics.asphaltTexture, true, "The road must use color, roughness, and bump textures.");
  assert.ok(visualDiagnostics.asphaltRepeatX >= 90, "The asphalt grain must repeat at road scale.");
  assert.equal(visualDiagnostics.asphaltTone, "graphite-road-asphalt", "The asphalt must match the neutral gray city-street reference.");
  assert.equal(visualDiagnostics.asphaltWetGloss, false, "The asphalt must have a dry, matte city-road finish.");
  assert.equal(visualDiagnostics.asphaltSkidArcs, 0, "The center of the road must not contain backward-curving skid arcs.");
  assert.equal(visualDiagnostics.asphaltLongitudinalWear, true, "Rubber wear marks must run along the track.");
  assert.equal(visualDiagnostics.asphaltRoadDirection, "forward-x", "The road markings must follow the racing direction.");
  assert.equal(visualDiagnostics.asphaltFollowsTrackDirection, true, "The asphalt texture must scroll with signed vehicle travel.");
  assert.equal(visualDiagnostics.centralMarkingsLoopBothDirections, true, "The central road markings must loop in forward and reverse.");
  assert.equal(visualDiagnostics.centralMarkingsTravelSign, 1, "The center markings must move in the corrected forward screen direction.");
  assert.equal(visualDiagnostics.centralMarkingsForwardDelta, -0.5, "Forward travel must move the center dashes backward across the screen.");
  assert.equal(visualDiagnostics.centralMarkingsReverseDelta, 0.5, "Reverse travel must move the center dashes in the opposite screen direction.");
  assert.equal(visualDiagnostics.skidMarksFollowTrackDirection, true, "Rubber wear marks must stay aligned with road travel.");
  assert.equal(visualDiagnostics.cityBuildings, 33, "The foreground street must contain 33 detailed buildings.");
  assert.ok(visualDiagnostics.cityWindows >= 650, "The mid-rise apartment facades must contain dense repeated windows.");
  assert.equal(visualDiagnostics.cityBuildingFloorsMin, 4, "The city must use four-floor minimum European apartment blocks.");
  assert.equal(visualDiagnostics.cityBuildingFloorsMax, 6, "The city must use varied 4–6 floor apartment blocks.");
  assert.equal(visualDiagnostics.cityLightingStyle, "balanced-daylight", "The city must avoid blown-out white daylight.");
  assert.equal(visualDiagnostics.cityLightingExposure, 0.98, "The scene must use balanced exposure.");
  assert.equal(visualDiagnostics.cityFacadeTexture, "warm-beige-plaster", "Apartment facades must use warm plaster texture.");
  assert.equal(visualDiagnostics.speedometerDigitalLayerAboveNeedle, true, "The digital speed readout must remain visible above the needle hub.");
  assert.equal(visualDiagnostics.cityBuildingOffsetZ, -22.2, "The foreground buildings must be set farther back from the road.");
  assert.equal(visualDiagnostics.cityFence, true, "A roadside fence must separate the street from the buildings.");
  assert.equal(visualDiagnostics.cityFenceType, "cross-braced-metal-panels", "The roadside fence must use silver cross-braced metal panels.");
  assert.equal(visualDiagnostics.cityFenceZ, -16.4, "The fence must stay behind the sidewalk and outside the asphalt.");
  assert.equal(visualDiagnostics.cityFenceRoadClearanceFromEdge, 7.4, "The city fence must remain outside the road with a clear margin.");
  assert.equal(visualDiagnostics.centralMarkingsZ, 0, "The dashed lane marking must sit on the far side of the visible road, as in the reference.");
  assert.equal(visualDiagnostics.cityFenceBraceCount, 138, "The metal fence must contain paired diagonal braces in every section.");
  assert.equal(visualDiagnostics.citySidewalkSlabs, 72, "The city sidewalk must have visible concrete slab joints.");
  assert.equal(visualDiagnostics.cityGroundFloorWindowRows, 33, "All apartment buildings must have ground-floor window rows.");
  assert.equal(visualDiagnostics.cityResidentialEntrances, 17, "Apartment blocks must have residential entrance doors instead of shop signage.");
  assert.equal(visualDiagnostics.cityShrubs, 180, "The apartment-side green strip must be dense and continuous behind the fence.");
  assert.equal(visualDiagnostics.cityShrubOffsetZ, -18.25, "The shrub strip must sit between the fence and apartments.");
  assert.equal(visualDiagnostics.skylineOffsetZ, -48, "The skyline must sit behind the foreground buildings.");
  assert.equal(visualDiagnostics.cameraViewHeight, 8.25, "The mobile race camera must frame the player's car larger.");

  // Check the slightly reduced lower dashboard on a typical landscape Android viewport.
  await page.setViewportSize({ width: 844, height: 390 });
  const mobilePanelHeight = await gameFrame.locator("#dashboardBackplate").evaluate(
    element => Math.round(element.getBoundingClientRect().height)
  );
  assert.ok(mobilePanelHeight >= 92 && mobilePanelHeight <= 116,
    "The compact landscape dashboard panel must be slightly shorter on a phone.");
  await page.setViewportSize({ width: 1365, height: 768 });
  assert.equal(visualDiagnostics.skylineTowers, 16, "The distant skyline must contain high-rise buildings.");
  assert.ok(visualDiagnostics.skylineWindows >= 100, "The distant skyline must contain illuminated windows.");

  await gameFrame.locator("#pause").click();
  assert.equal(await gameFrame.locator("#pause").textContent(), "ПРОДОЛЖИТЬ",
    "The pause control must respond to taps/clicks.");
  await gameFrame.locator("#pause").click();
  assert.equal(await gameFrame.locator("#pause").textContent(), "ПАУЗА");

  const suspensionBefore = await gameFrame.locator("#suspension").textContent();
  await gameFrame.locator("#suspension").click();
  const suspensionAfter = await gameFrame.locator("#suspension").textContent();
  assert.notEqual(suspensionAfter, suspensionBefore,
    "The suspension control must respond to taps/clicks.");

  await gameFrame.locator("#headlights").click();
  assert.equal(await gameFrame.locator("#headlights").textContent(), "ФАРЫ · ВКЛ",
    "The headlight control must respond to taps/clicks.");

  await page.waitForFunction(() =>
    document.querySelector("#allcoinsRacingV24Overlay")?.textContent.includes("3D-модель передана в игровую сцену"),
    null,
    { timeout: 10000 }
  );
  await gameFrame.waitForFunction(() => {
    const state = window.__allcoinsRacingVehicleDiagnostics;
    return state && state.loaded === true;
  }, null, { timeout: 10000 });
  const vehicleDiagnostics = await gameFrame.evaluate(
    () => window.__allcoinsRacingVehicleDiagnostics
  );
  assert.equal(vehicleDiagnostics.rootVisible, true,
    "The loaded VAZ root must remain visible in the race scene.");
  assert.ok(vehicleDiagnostics.visibleMeshCount > 0 && vehicleDiagnostics.meshCount > 0,
    "At least one visible 3D mesh must be attached to the car.");

  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await gameFrame.locator(".gear-pattern").evaluate(element => getComputedStyle(element).display),
    "grid",
    "The compact H-pattern gear selector must be visible in landscape phone mode."
  );
  const compactDashboardHeight = await gameFrame.locator("#dashboardBackplate").evaluate(
    element => Math.round(element.getBoundingClientRect().height)
  );
  assert.ok(compactDashboardHeight >= 92 && compactDashboardHeight <= 116,
    "The landscape dashboard must remain compact and leave the car visible above it.");
  assert.ok(apiCalls.some(call => call.path === "/api/auth/telegram"));
  assert.ok(apiCalls.some(call => call.path === "/api/racing/shared-model-asset"));
  assert.deepEqual(pageErrors, [],
    "Classic Three.js startup and UI control binding must not raise uncaught browser errors.");

  console.log("Racing smoke test passed: same-origin scene, local classic Three.js/GLTFLoader, WebGL startup, model request handshake, and interactive pause/suspension/headlight controls.");
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
}
