import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
await mkdir(resolve(root, "artifacts"), { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true
});
const pageErrors = [];
let engineAssetResponseStatus = null;
page.on("pageerror", error => pageErrors.push(error.message));
page.on("response", response => {
  if (response.url().includes("/cars/vaz2107-engine-continuous.wav.b64")) {
    engineAssetResponseStatus = response.status();
  }
});
await page.route("https://telegram.org/**", route => route.fulfill({
  status: 200,
  contentType: "application/javascript",
  body: "window.Telegram={WebApp:{initData:'',initDataUnsafe:{},ready(){},expand(){},BackButton:{hide(){},show(){}},MainButton:{hide(){}},SecondaryButton:{hide(){}},requestFullscreen(){},exitFullscreen(){}}};"
}));

try {
  const response = await page.goto("http://127.0.0.1:4173/drag-racing-v2.html?camera-follow-smoke=1", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  assert.ok(response && response.status() === 200, "The current drag-racing-v2 page must load with HTTP 200.");
  await page.waitForFunction(() =>
    document.querySelector("#race2dEnvironment")?.dataset.ready === "1" &&
    document.querySelector("#race2dPlayerCar .race-car-png")?.complete,
    null,
    { timeout: 15000 }
  );
  assert.equal(await page.locator("#race2dCameraWorld").count(), 1, "The driving cars must be inside their chase-camera world.");
  assert.equal(await page.locator("#race2dPlayerCar .race-car-png").count(), 1, "The selected car PNG must be present.");
  const sceneryPlacement = await page.evaluate(() => ({
    environmentParent: document.querySelector("#race2dEnvironment")?.parentElement?.className || "",
    cameraParent: document.querySelector("#race2dCameraWorld")?.parentElement?.className || "",
    sceneWidth: document.querySelector(".race2d-scene")?.clientWidth || 0,
    environmentWidth: document.querySelector("#race2dEnvironment")?.getBoundingClientRect().width || 0
  }));
  assert.equal(sceneryPlacement.environmentParent, "race2d-scene",
    "The scenery must stay outside the translating chase-camera layer.");
  assert.equal(sceneryPlacement.cameraParent, "race2d-scene",
    "The chase camera and scenery must be sibling layers.");
  assert.ok(Math.abs(sceneryPlacement.environmentWidth-sceneryPlacement.sceneWidth)<2,
    "The scenery must cover only the visible viewport and repeat its layers instead of stretching into a finite world.");
  await page.waitForFunction(() => window.__raceEngineAudioStatus === "ready" ||
    window.__raceEngineAudioStatus === "html-fallback-ready" ||
    window.__raceEngineAudioStatus === "playing" ||
    window.__raceEngineAudioStatus === "playing-html-fallback" ||
    window.__raceEngineAudioStatus === "procedural-fallback", null, { timeout: 8000 });
  assert.equal(engineAssetResponseStatus, 200,
    "The new locally bundled arcade VAZ-2107 engine loop must load successfully.");
  const audioAsset = await page.evaluate(async () => {
    const response = await fetch("./cars/vaz2107-engine-continuous.wav.b64");
    const encoded = (await response.text()).trim();
    const decoded = atob(encoded.slice(0, 16));
    return { ok: response.ok, encodedLength: encoded.length, riffHeader: decoded.slice(0, 4) };
  });
  assert.equal(audioAsset.ok, true, "The replacement engine audio asset must be reachable.");
  assert.ok(audioAsset.encodedLength > 100000 && audioAsset.riffHeader === "RIFF",
    "The replacement must be a complete, non-empty WAV loop, not the previous audio file.");

  await page.locator("#startRace").click();
  await page.waitForFunction(() => {
    const cockpit = document.querySelector("#proRaceCockpit");
    return cockpit && !cockpit.classList.contains("hidden") &&
      document.querySelector("#race2dPlayerCar")?.getBoundingClientRect().width > 100;
  }, null, { timeout: 8000 });
  await page.waitForFunction(() => window.__raceEngineAudioDebug?.enabled === true &&
    (window.__raceEngineAudioStatus === "playing" ||
     window.__raceEngineAudioDebug?.proceduralLevel > 0), null, { timeout: 5000 });
  const idleAudio = await page.evaluate(() => ({
    status: window.__raceEngineAudioStatus || null,
    debug: window.__raceEngineAudioDebug || null,
    contextState: window.__raceAudioState || null
  }));
  assert.equal(idleAudio.debug.enabled, true, "The engine audio must be enabled when the full-screen race cockpit opens.");
  assert.equal(idleAudio.debug.sample, "vaz2107-engine-continuous.wav.b64",
    "The newly generated game-style engine loop, not the previous sample, must be selected.");
  assert.ok(["webaudio-buffer-loop", "html-audio-fallback"].includes(idleAudio.debug.engineBackend),
    "The engine must use the gapless Web Audio loop or the reliable local HTMLAudio fallback.");
  assert.equal(idleAudio.debug.loopingEngineSample, true,
    "The selected engine WAV playback path must remain in continuous loop mode.");
  if (idleAudio.debug.engineBackend === "webaudio-buffer-loop") {
    assert.ok(idleAudio.debug.engineBufferDuration >= 2,
      "The decoded engine WAV must be a complete multi-second loop.");
    assert.equal(idleAudio.debug.engineSourceStarts, 1,
      "Only one engine buffer source should be started; the loop must not restart between frames.");
  } else {
    assert.equal(idleAudio.debug.mediaPlaying, true,
      "The local HTMLAudio fallback must be playing when Web Audio is unavailable.");
  }
  assert.ok(idleAudio.debug.mediaPlaying || idleAudio.debug.proceduralLevel > 0,
    "A local engine loop or live procedural fallback must be audible when the cockpit opens.");

  const exhaustVisual = await page.evaluate(() => {
    const read = selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        width: r.width, height: r.height,
        display: style.display, visibility: style.visibility,
        opacity: style.opacity, zIndex: style.zIndex,
        animationName: style.animationName,
        animationPlayState: style.animationPlayState
      };
    };
    return {
      mufflerBody: read("#race2dPlayerCar .race-car-muffler-body"),
      tailpipe: read("#race2dPlayerCar .race-car-muffler-tailpipe"),
      outlet: read("#race2dPlayerCar .race-car-muffler-outlet"),
      smoke: read("#race2dPlayerCar .race-car-exhaust-puff")
    };
  });
  assert.ok(exhaustVisual.mufflerBody?.width >= 20 && exhaustVisual.mufflerBody?.height >= 8,
    "The VAZ-2107 needs a clearly visible metal muffler under the rear of the car: " + JSON.stringify(exhaustVisual));
  assert.ok(exhaustVisual.tailpipe?.width >= 20 && exhaustVisual.tailpipe?.height >= 5,
    "The exhaust pipe must remain visible at mobile and desktop sizes.");
  assert.ok(exhaustVisual.outlet?.width >= 7 && exhaustVisual.outlet?.height >= 10,
    "The pipe outlet must be visible at the rear bumper.");
  assert.ok(Number(exhaustVisual.mufflerBody.zIndex) >= 8 &&
    Number(exhaustVisual.smoke.zIndex) >= 7,
    "The muffler and exhaust particles must render above the car PNG, not underneath it.");
  assert.equal(exhaustVisual.smoke?.animationName, "race-exhaust-idle",
    "Smoke must already be emitted on engine idle.");
  assert.equal(exhaustVisual.smoke?.animationPlayState, "running",
    "The smoke animation must be running when the engine starts.");
  await page.screenshot({
    path: resolve(root, "artifacts", "drag-racing-v2-exhaust-smoke.png"),
    fullPage: false
  });

  const initial = await page.locator("#race2dPlayerCar").evaluate(el => {
    const r = el.getBoundingClientRect();
    return { centerX: r.left + r.width / 2, cameraX: new DOMMatrixReadOnly(getComputedStyle(document.querySelector("#race2dCameraWorld")).transform).m41 };
  });
  await page.locator("#proGasHold").dispatchEvent("pointerdown", {
    pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, buttons: 1
  });
  await page.waitForTimeout(6500);

  const trackRendering = await page.evaluate(() => {
    const scene = document.querySelector(".race2d-scene");
    return {
      roadPseudoAnimation: getComputedStyle(scene, "::before").animationName,
      roadGrainAnimation: getComputedStyle(document.querySelector(".race2d-road-grain")).animationName,
      cityFilter: getComputedStyle(document.querySelector("#race2dCityLayer")).filter,
      treeFilter: getComputedStyle(document.querySelector("#race2dTreeLayer")).filter,
      cityWillChange: getComputedStyle(document.querySelector("#race2dCityLayer")).willChange,
      markingsWillChange: getComputedStyle(document.querySelector("#race2dRoadMarks")).willChange
    };
  });
  assert.equal(trackRendering.roadPseudoAnimation, "none",
    "The track should not repaint its full-width background on every animation frame.");
  assert.equal(trackRendering.roadGrainAnimation, "none", "The full-track grain texture must not animate background-position.");
  assert.equal(trackRendering.cityFilter, "none", "City scenery should stay sharp without a full-layer blur filter.");
  assert.equal(trackRendering.treeFilter, "none", "Tree scenery should stay sharp without a full-layer blur filter.");
  assert.ok(trackRendering.cityWillChange.includes("transform") &&
    trackRendering.markingsWillChange.includes("transform"),
    "Moving scenery and road markings should stay on compositor transform layers.");

  const lateRaceScenery = await page.evaluate(() => {
    const scene = document.querySelector(".race2d-scene");
    const sceneRect = scene.getBoundingClientRect();
    const width = scene.clientWidth;
    const period = width * 1.5;
    const originalWorldOffset = raceWorldOffset;
    const layers = [
      { id: "race2dCityLayer", rate: .36 },
      { id: "race2dTreeLayer", rate: .70 },
      { id: "race2dFenceLayer", rate: 1 }
    ];
    const samples = [];
    for (const layer of layers) {
      // Check each parallax strip just before and just after its repeat boundary,
      // including a long accumulated world distance like a near-finish drive.
      for (const edge of [-.25, .25]) {
        raceWorldOffset = (period * 101 + edge) / layer.rate;
        updateRace2DEnvironment(0, performance.now());
        const measurements = layers.map(item => {
          const element = document.getElementById(item.id);
          const rect = element.getBoundingClientRect();
          const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
          return {
            id: item.id,
            left: rect.left,
            right: rect.right,
            x: transform.m41,
            width: rect.width
          };
        });
        samples.push({ boundary: layer.id + (edge < 0 ? "-before" : "-after"), measurements });
      }
    }
    // Restore the real simulation position before the remainder of the
    // camera-follow test continues.
    raceWorldOffset = originalWorldOffset;
    updateRace2DEnvironment(0, performance.now());
    updateRaceCarPosition(0);
    updateRace2DCamera(0);
    return {
      sceneLeft: sceneRect.left,
      sceneRight: sceneRect.right,
      sceneWidth: width,
      period,
      samples
    };
  });
  for (const sample of lateRaceScenery.samples) {
    for (const layer of sample.measurements) {
      assert.ok(layer.left <= lateRaceScenery.sceneLeft + 1 &&
        layer.right >= lateRaceScenery.sceneRight - 1,
        "Scenery strip " + layer.id + " must cover the complete horizon near a wrap boundary: " +
        JSON.stringify({ sample: sample.boundary, layer, scene: lateRaceScenery }));
      assert.ok(layer.x <= .5 && layer.x >= -lateRaceScenery.period - .5,
        "Scenery strip " + layer.id + " must stay within its repeating tile period.");
    }
  }
  const middle = await page.evaluate(() => {
    const matrixX = el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    const cameraX = matrixX(document.querySelector("#race2dCameraWorld"));
    const cityX = matrixX(document.querySelector("#race2dCityLayer"));
    const treeX = matrixX(document.querySelector("#race2dTreeLayer"));
    const fenceX = matrixX(document.querySelector("#race2dFenceLayer"));
    const marksX = matrixX(document.querySelector("#race2dRoadMarks"));
    const matrixData = el => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { a: m.m11, b: m.m12, c: m.m21, d: m.m22, e: m.m41, f: m.m42 };
    };
    const road = document.querySelector(".race2d-road-surface");
    const car = document.querySelector("#race2dPlayerCar");
    const carBox = car.getBoundingClientRect();
    const sceneBox = document.querySelector(".race2d-scene").getBoundingClientRect();
    const envBox = document.querySelector("#race2dEnvironment").getBoundingClientRect();
    return {
      speed: Number(document.querySelector("#proSpeedDigits")?.textContent || 0),
      cameraX,
      cityScreenX: cityX,
      treeScreenX: treeX,
      fenceScreenX: fenceX,
      marksX,
      roadTransform: matrixData(road),
      carWorldX: matrixX(car),
      carCenterX: carBox.left + carBox.width / 2,
      carLeft: carBox.left,
      carRight: carBox.right,
      roadLeft: road.getBoundingClientRect().left,
      sceneLeft: sceneBox.left,
      envLeft: envBox.left,
      envWidth: envBox.width,
      sceneWidth: sceneBox.width
    };
  });
  await page.waitForTimeout(2200);
  const later = await page.evaluate(() => {
    const matrixX = el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    const cameraX = matrixX(document.querySelector("#race2dCameraWorld"));
    const cityX = matrixX(document.querySelector("#race2dCityLayer"));
    const treeX = matrixX(document.querySelector("#race2dTreeLayer"));
    const fenceX = matrixX(document.querySelector("#race2dFenceLayer"));
    const marksX = matrixX(document.querySelector("#race2dRoadMarks"));
    const carBox = document.querySelector("#race2dPlayerCar").getBoundingClientRect();
    const sceneBox = document.querySelector(".race2d-scene").getBoundingClientRect();
    const envBox = document.querySelector("#race2dEnvironment").getBoundingClientRect();
    return {
      speed: Number(document.querySelector("#proSpeedDigits")?.textContent || 0),
      cameraX,
      cityScreenX: cityX,
      treeScreenX: treeX,
      fenceScreenX: fenceX,
      marksX,
      carCenterX: carBox.left + carBox.width / 2,
      carLeft: carBox.left,
      carRight: carBox.right,
      envLeft: envBox.left,
      envWidth: envBox.width,
      sceneLeft: sceneBox.left,
      sceneWidth: sceneBox.width
    };
  });

  assert.ok(middle.speed > 0, "The car must accelerate when the gas pedal is held.");
  const movingAudio = await page.evaluate(() => window.__raceEngineAudioDebug || null);
  assert.ok(movingAudio?.enabled && movingAudio?.throttle,
    "The engine audio must remain enabled and respond while the accelerator is held.");
  assert.ok(movingAudio.rpm > idleAudio.debug.rpm &&
    movingAudio.firingHz > idleAudio.debug.firingHz &&
    movingAudio.mediaPlaybackRate > idleAudio.debug.mediaPlaybackRate,
    "The engine sample pitch and firing rate must rise as the engine revs under throttle.");
  assert.ok(movingAudio.mediaPlaying || movingAudio.proceduralLevel > 0,
    "A playable engine sample or procedural fallback must remain audible during driving.");
  assert.ok(["webaudio-buffer-loop", "html-audio-fallback"].includes(movingAudio.engineBackend),
    "The engine must keep using a playable local loop during acceleration.");
  assert.equal(movingAudio.loopingEngineSample, true,
    "Acceleration must not disable the continuous engine loop.");
  assert.equal(movingAudio.engineSourceStarts, idleAudio.debug.engineSourceStarts,
    "Changing RPM must not restart the engine audio source or create audible gaps.");
  assert.ok(middle.cameraX < -40, "The camera must move forward with the car, not remain fixed.");
  assert.ok(middle.carWorldX > 80, "The car must advance through world coordinates.");
  const phaseIsBounded = (value, period) => value <= 0.5 && value >= -period - 0.5;
  assert.ok(
    phaseIsBounded(middle.cityScreenX, middle.sceneWidth*3) &&
    phaseIsBounded(middle.treeScreenX, middle.sceneWidth*3) &&
    phaseIsBounded(middle.fenceScreenX, middle.sceneWidth*3) &&
    phaseIsBounded(middle.marksX, 96),
    "The scenery must scroll using bounded repeating phases: "+JSON.stringify({
      city:middle.cityScreenX,trees:middle.treeScreenX,fence:middle.fenceScreenX,
      roadMarks:middle.marksX,sceneWidth:middle.sceneWidth
    })
  );
  assert.ok(
    Math.abs(middle.cityScreenX)>2 || Math.abs(middle.treeScreenX)>2 ||
    Math.abs(middle.fenceScreenX)>2 || Math.abs(middle.marksX)>2,
    "At least one scenery layer must visibly advance behind the car."
  );
  assert.ok(Math.abs(middle.roadTransform.b) < 0.00005 &&
    Math.abs(middle.roadTransform.c) < 0.00005 &&
    Math.abs(middle.roadTransform.e) < 0.05 &&
    Math.abs(middle.roadTransform.f) < 0.05,
    "The asphalt must remain level and must not climb, descend, or tilt during the drive.");
  assert.ok(Math.abs(middle.roadLeft-middle.sceneLeft)<2,
    "The road surface must remain anchored to the visible scene instead of sliding out of its finite world.");
  assert.ok(Math.abs(middle.envLeft-middle.sceneLeft)<2 &&
    Math.abs(middle.envWidth-middle.sceneWidth)<2,
    "The environment must remain viewport-sized and fixed while the camera follows the car.");
  assert.ok(middle.carCenterX - initial.centerX > 3,
    "The car must keep a visible forward lead on screen while the camera follows it.");
  assert.ok(later.speed >= middle.speed, "The speedometer should continue to increase during the held throttle.");
  assert.ok(later.cameraX < middle.cameraX,
    "The chase camera must keep following the car as speed and distance increase.");
  for (const key of ["cityScreenX","treeScreenX","marksX"]) {
    assert.notEqual(later[key], middle[key],
      "The repeating "+key+" phase must keep advancing between sampled frames.");
  }
  assert.ok(
    phaseIsBounded(later.fenceScreenX, later.sceneWidth*3),
    "The fence phase must stay bounded even when its repeating tile reaches the wrap point."
  );
  assert.ok(Math.abs(later.envLeft-later.sceneLeft)<2 &&
    Math.abs(later.envWidth-later.sceneWidth)<2,
    "The background must stay locked to the viewport as the simulated race advances.");
  assert.ok(later.carCenterX > middle.carCenterX, "The car's forward screen position should progress smoothly.");
  assert.ok(later.carLeft > -50 && later.carRight < 1330, "The car must remain inside the visible track while the camera follows.");
  assert.equal(pageErrors.length, 0, "No JavaScript runtime errors are allowed: " + pageErrors.join(" | "));

  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-v2-camera-follow.png"), fullPage: false });

  await page.evaluate(() => {
    // Shorten only this automated test run so the real finish transition is exercised.
    maxDist = distance + 0.25;
  });
  await page.locator("#proGasHold").dispatchEvent("pointerdown", {
    pointerId: 10, pointerType: "touch", isPrimary: true, button: 0, buttons: 1
  });
  await page.waitForFunction(() => finished === true, null, { timeout: 5000 });
  const finishAudio = await page.evaluate(() => ({
    finished,
    running,
    gasHeld,
    rpm,
    audio: window.__raceEngineAudioDebug || null
  }));
  assert.equal(finishAudio.finished, true, "The automated short race must reach its finish line.");
  assert.equal(finishAudio.running, false, "The race simulation must stop at the finish line.");
  assert.equal(finishAudio.gasHeld, false, "The accelerator must be released at the finish line.");
  assert.equal(finishAudio.rpm, 900, "The engine RPM must settle to idle at the finish line.");
  assert.equal(finishAudio.audio?.throttle, false, "The engine audio must no longer sound under throttle.");
  assert.equal(finishAudio.audio?.moving, false, "The engine audio state must switch from driving to idle.");
  assert.equal(finishAudio.audio?.proceduralLevel, .25, "The procedural engine layer must use its idle level.");
  assert.equal(finishAudio.audio?.rpm, 900, "The audio engine must report idle RPM after the finish.");
  await page.locator("#proGasHold").dispatchEvent("pointerup", {
    pointerId: 10, pointerType: "touch", isPrimary: true, button: 0, buttons: 0
  });
  await page.locator("#proGasHold").dispatchEvent("pointerup", {
    pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, buttons: 0
  });
  const report = {
    page: "drag-racing-v2.html",
    viewport: "1280x720 landscape",
    initial,
    middle,
    later,
    pageErrors
  };
  console.log("DRAG RACING V2 CHASE-CAMERA TEST PASSED", JSON.stringify(report));
} finally {
  await browser.close();
}
