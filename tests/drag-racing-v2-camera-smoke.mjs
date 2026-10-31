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
  if (response.url().includes("/cars/vaz2107-engine-arcade.wav.b64")) {
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
  assert.equal(await page.locator("#race2dCameraWorld").count(), 1, "The driving scene must be inside its chase-camera world.");
  assert.equal(await page.locator("#race2dPlayerCar .race-car-png").count(), 1, "The selected car PNG must be present.");
  await page.waitForFunction(() => window.__raceEngineAudioStatus === "ready" ||
    window.__raceEngineAudioStatus === "html-fallback-ready" ||
    window.__raceEngineAudioStatus === "playing" ||
    window.__raceEngineAudioStatus === "playing-html-fallback" ||
    window.__raceEngineAudioStatus === "procedural-fallback", null, { timeout: 8000 });
  assert.equal(engineAssetResponseStatus, 200,
    "The new locally bundled arcade VAZ-2107 engine loop must load successfully.");
  const audioAsset = await page.evaluate(async () => {
    const response = await fetch("./cars/vaz2107-engine-arcade.wav.b64");
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
  assert.equal(idleAudio.debug.sample, "vaz2107-engine-arcade.wav.b64",
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

  const initial = await page.locator("#race2dPlayerCar").evaluate(el => {
    const r = el.getBoundingClientRect();
    return { centerX: r.left + r.width / 2, cameraX: new DOMMatrixReadOnly(getComputedStyle(document.querySelector("#race2dCameraWorld")).transform).m41 };
  });
  await page.locator("#proGasHold").dispatchEvent("pointerdown", {
    pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, buttons: 1
  });
  await page.waitForTimeout(6500);
  const middle = await page.evaluate(() => {
    const matrixX = el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    const cameraX = matrixX(document.querySelector("#race2dCameraWorld"));
    const cityX = matrixX(document.querySelector("#race2dCityLayer"));
    const treeX = matrixX(document.querySelector("#race2dTreeLayer"));
    const fenceX = matrixX(document.querySelector("#race2dFenceLayer"));
    const matrixData = el => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { a: m.m11, b: m.m12, c: m.m21, d: m.m22, e: m.m41, f: m.m42 };
    };
    const roadTransform = matrixData(document.querySelector(".race2d-road-surface"));
    const fenceTransform = matrixData(document.querySelector("#race2dFenceLayer"));
    const car = document.querySelector("#race2dPlayerCar");
    const carBox = car.getBoundingClientRect();
    return {
      speed: Number(document.querySelector("#proSpeedDigits")?.textContent || 0),
      cameraX,
      cityScreenX: cameraX + cityX,
      treeScreenX: cameraX + treeX,
      fenceScreenX: cameraX + fenceX,
      roadTransform,
      fenceTransform,
      carWorldX: matrixX(car),
      carCenterX: carBox.left + carBox.width / 2,
      carLeft: carBox.left,
      carRight: carBox.right,
      roadLeft: document.querySelector(".race2d-road-surface").getBoundingClientRect().left
    };
  });
  await page.waitForTimeout(2200);
  const later = await page.evaluate(() => {
    const matrixX = el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    const cameraX = matrixX(document.querySelector("#race2dCameraWorld"));
    const cityX = matrixX(document.querySelector("#race2dCityLayer"));
    const treeX = matrixX(document.querySelector("#race2dTreeLayer"));
    const carBox = document.querySelector("#race2dPlayerCar").getBoundingClientRect();
    return {
      speed: Number(document.querySelector("#proSpeedDigits")?.textContent || 0),
      cameraX,
      cityScreenX: cameraX + cityX,
      treeScreenX: cameraX + treeX,
      carCenterX: carBox.left + carBox.width / 2,
      carLeft: carBox.left,
      carRight: carBox.right
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
  assert.ok(middle.cityScreenX < -5 && middle.treeScreenX < -5 && middle.fenceScreenX < -5,
    "City, trees and fence must travel backwards relative to the moving car/camera.");
  assert.ok(Math.abs(middle.fenceScreenX - middle.cameraX) < 2,
    "The roadside fence must stay locked to the road world and must not drift away from the asphalt.");
  for (const key of ["a", "b", "c", "d", "e", "f"]) {
    assert.ok(Math.abs(middle.roadTransform[key] - middle.fenceTransform[key]) < 0.0005,
      "The fence and asphalt must share the same transform (" + key + ").");
  }
  assert.ok(Math.abs(middle.roadTransform.b) < 0.00005 &&
    Math.abs(middle.roadTransform.c) < 0.00005 &&
    Math.abs(middle.roadTransform.e) < 0.05 &&
    Math.abs(middle.roadTransform.f) < 0.05,
    "The asphalt must remain level and must not climb, descend, or tilt during the drive.");
  assert.ok(middle.roadLeft < -30, "The asphalt world must pass backwards under the chase camera.");
  assert.ok(middle.carCenterX - initial.centerX > 3,
    "The car must keep a visible forward lead on screen while the camera follows it.");
  assert.ok(later.speed >= middle.speed, "The speedometer should continue to increase during the held throttle.");
  assert.ok(later.cameraX < middle.cameraX && later.cityScreenX < middle.cityScreenX && later.treeScreenX < middle.treeScreenX,
    "The scenery and camera must continue moving backwards/following faster as speed and distance increase.");
  assert.ok(later.carCenterX > middle.carCenterX, "The car's forward screen position should progress smoothly.");
  assert.ok(later.carLeft > -50 && later.carRight < 1330, "The car must remain inside the visible track while the camera follows.");
  assert.equal(pageErrors.length, 0, "No JavaScript runtime errors are allowed: " + pageErrors.join(" | "));

  await page.screenshot({ path: resolve(root, "artifacts", "drag-racing-v2-camera-follow.png"), fullPage: false });
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
