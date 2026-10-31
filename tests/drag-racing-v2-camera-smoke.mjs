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
page.on("pageerror", error => pageErrors.push(error.message));
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

  await page.locator("#startRace").click();
  await page.waitForFunction(() => {
    const cockpit = document.querySelector("#proRaceCockpit");
    return cockpit && !cockpit.classList.contains("hidden") &&
      document.querySelector("#race2dPlayerCar")?.getBoundingClientRect().width > 100;
  }, null, { timeout: 8000 });

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
    const car = document.querySelector("#race2dPlayerCar");
    const carBox = car.getBoundingClientRect();
    return {
      speed: Number(document.querySelector("#proSpeedDigits")?.textContent || 0),
      cameraX,
      cityScreenX: cameraX + cityX,
      treeScreenX: cameraX + treeX,
      fenceScreenX: cameraX + fenceX,
      carWorldX: matrixX(car),
      carCenterX: carBox.left + carBox.width / 2,
      carLeft: carBox.left,
      carRight: carBox.right,
      roadLeft: document.querySelector("#race2dRoadSurface").getBoundingClientRect().left
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
  assert.ok(middle.cameraX < -40, "The camera must move forward with the car, not remain fixed.");
  assert.ok(middle.carWorldX > 80, "The car must advance through world coordinates.");
  assert.ok(middle.cityScreenX < -5 && middle.treeScreenX < -5 && middle.fenceScreenX < -5,
    "City, trees and fence must travel backwards relative to the moving car/camera.");
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
