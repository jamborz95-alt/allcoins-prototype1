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
  await page.waitForFunction(() => typeof window.ladaPaintedPng === "function", null, { timeout: 15000 });

  const inspection = await page.evaluate(async () => {
    const paintedUrl = await window.ladaPaintedPng("#d65b2b");
    const load = url => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
    const [original, painted] = await Promise.all([
      load("./cars/lada-2107-side.png?v=20261031-png-paint6"),
      load(paintedUrl)
    ]);
    const sample = image => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const px = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
      return { body: px(400, 150), glass: px(420, 75), wheel: px(180, 194) };
    };
    return { paintedUrl, original: sample(original), painted: sample(painted) };
  });

  const [bodyBefore, bodyAfter] = [inspection.original.body, inspection.painted.body];
  assert.ok(bodyAfter[0] > bodyAfter[1] + 25 && bodyAfter[0] > bodyAfter[2] + 45,
    "The door body panel must receive the selected orange paint: " + JSON.stringify(inspection));
  assert.ok(bodyAfter[0] - bodyBefore[0] > 10,
    "The body panel must change from the factory PNG: " + JSON.stringify(inspection));

  for (const part of ["glass", "wheel"]) {
    const before = inspection.original[part];
    const after = inspection.painted[part];
    assert.ok(before.slice(0, 3).every((value, index) => Math.abs(value - after[index]) <= 2),
      part + " pixels must keep their original colour: " + JSON.stringify({ before, after }));
  }

  const pngBytes = Buffer.from(inspection.paintedUrl.split(",")[1], "base64");
  await writeFile(resolve(root, "artifacts/lada-2107-orange-paint-check.png"), pngBytes);
  console.log("VAZ-2107 PNG paint regression passed: full-body colour applied; sampled glass and wheel pixels unchanged.");
} finally {
  await browser.close();
}
