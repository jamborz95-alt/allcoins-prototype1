import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
await mkdir(resolve(root, "artifacts"), { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });

try {
  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Telegram={WebApp:{initData:'',initDataUnsafe:{},ready(){},expand(){},BackButton:{hide(){},show(){}},MainButton:{hide(){}},SecondaryButton:{hide(){}},requestFullscreen(){},exitFullscreen(){}}};"
  }));
  const response = await page.goto("http://127.0.0.1:4173/drag-racing-v2.html?paint-regression=1", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  assert.ok(response && response.status() === 200, "Drag Racing v2 page must load.");
  await page.waitForFunction(() => typeof window.__allcoinsPaintPreview === "function", null, { timeout: 15000 });

  const inspection = await page.evaluate(async () => {
    const paintedUrl = await window.__allcoinsPaintPreview("#d65b2b");
    const blackPaintedUrl = await window.__allcoinsPaintPreview("#171c23");
    const load = url => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
    const [original, painted, blackPainted] = await Promise.all([
      load("./cars/lada-2107-side.png?v=20261101-png-paint8"),
      load(paintedUrl),
      load(blackPaintedUrl)
    ]);
    const sample = image => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const px = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
      return {
        body: {
          roof: px(340, 14),
          rearQuarter: px(120, 125),
          door: px(400, 150),
          hood: px(620, 125),
          wheelArchLip: px(520, 155),
          rearWindowSill: px(240, 100),
          frontWindowSill: px(420, 100),
          rearPillar: px(210, 50)
        },
        glass: px(420, 75),
        wheel: px(180, 194),
        wheelSidewall: px(132, 194),
        frontWheelSidewall: px(608, 194),
        rearBumper: px(38, 172),
        frontBumper: px(670, 174)
      };
    };
    return { paintedUrl, original: sample(original), painted: sample(painted), black: sample(blackPainted) };
  });

  for (const [part, after] of Object.entries(inspection.painted.body)) {
    const before = inspection.original.body[part];
    assert.ok(after[0] > after[1] + 25 && after[0] > after[2] + 45,
      "The " + part + " must receive the selected orange paint: " + JSON.stringify({ before, after }));
    assert.ok(after[0] - before[0] > 10,
      "The " + part + " must visibly change from the factory PNG: " + JSON.stringify({ before, after }));
  }

  for (const part of ["glass", "wheel", "wheelSidewall", "frontWheelSidewall", "rearBumper", "frontBumper"]) {
    const before = inspection.original[part];
    const after = inspection.painted[part];
    assert.ok(before.slice(0, 3).every((value, index) => Math.abs(value - after[index]) <= 2),
      part + " pixels must keep their original colour: " + JSON.stringify({ before, after }));
  }
  for (const [part, px] of Object.entries(inspection.black.body)) {
    assert.ok(Math.max(...px.slice(0, 3)) < 85,
      "Black metallic paint should look genuinely dark on " + part + ": " + JSON.stringify(px));
  }
  for (const part of ["glass", "wheel", "rearBumper", "frontBumper"]) {
    const before = inspection.original[part], after = inspection.black[part];
    assert.ok(before.slice(0, 3).every((value, index) => Math.abs(value - after[index]) <= 2),
      "Black paint must also leave " + part + " untouched: " + JSON.stringify({ before, after }));
  }

  const pngBytes = Buffer.from(inspection.paintedUrl.split(",")[1], "base64");
  await writeFile(resolve(root, "artifacts/lada-2107-orange-paint-check.png"), pngBytes);

  // The car shop must display the same real transparent PNG, not a vector redraw.
  await page.locator('button[data-tab="shop"]').click();
  await page.waitForFunction(() => {
    const shop = document.getElementById("shop");
    const image = document.querySelector("#carShop .shop-car-png");
    return shop && !shop.classList.contains("hidden") && image && image.complete && image.naturalWidth > 0;
  }, null, { timeout: 10000 });
  const shopPng = await page.locator("#carShop .shop-car-png").evaluate(image => ({
    src: image.currentSrc || image.src,
    width: image.naturalWidth,
    height: image.naturalHeight,
    alt: image.alt
  }));
  assert.ok(shopPng.width >= 600 && shopPng.height >= 200,
    "The car shop should use the original high-resolution VAZ-2107 PNG: " + JSON.stringify(shopPng));
  assert.match(shopPng.alt, /ВАЗ-2107/i, "The shop PNG must be labelled as the VAZ-2107.");
  await page.locator("#carShop").screenshot({ path: resolve(root, "artifacts/lada-2107-shop-png.png") });
  console.log("VAZ-2107 shop PNG regression passed: high-resolution PNG is visible in the car shop.");

} finally {
  await browser.close();
}
