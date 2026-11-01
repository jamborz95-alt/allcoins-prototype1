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
      load("./cars/lada-2107-side.png?v=20261101-png-paint15"),
      load(paintedUrl),
      load(blackPaintedUrl)
    ]);
    const sampleData = image => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const sample = image => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const px = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
      const windowZones = [
        [[.195,.095],[.286,.102],[.256,.385],[.181,.378]],
        [[.315,.095],[.478,.095],[.478,.385],[.315,.385]],
        [[.498,.095],[.662,.095],[.662,.385],[.498,.385]],
        [[.664,.118],[.686,.132],[.712,.382],[.682,.382]]
      ];
      const wheels = [[.257,.778,.064,.185],[.829,.778,.064,.185]];
      const bumpers = [
        [[0,.595],[.088,.595],[.096,.735],[.077,.785],[0,.785]],
        [[.920,.615],[1,.615],[1,.785],[.935,.785],[.915,.745]]
      ];
      const lamps = [
        [[.020,.475],[.034,.475],[.035,.620],[.020,.620]],
        [[.949,.480],[.977,.480],[.978,.535],[.949,.535]]
      ];
      const inPolygon = (x,y,poly) => {
        let inside=false;
        for(let i=0,j=poly.length-1;i<poly.length;j=i++){
          const [xi,yi]=poly[i],[xj,yj]=poly[j];
          if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi||1e-9)+xi))inside=!inside;
        }
        return inside;
      };
      const originalData=sampleData(original),paintedData=sampleData(painted);
      let whiteBodyPixels=0,recolouredWhitePixels=0;
      const whiteMisses=[];
      for(let y=0;y<original.naturalHeight;y++){
        for(let x=0;x<original.naturalWidth;x++){
          const i=(y*original.naturalWidth+x)*4;
          const alpha=originalData[i+3];
          if(alpha<=90)continue;
          const r=originalData[i]/255,g=originalData[i+1]/255,b=originalData[i+2]/255;
          const hi=Math.max(r,g,b),lo=Math.min(r,g,b),lum=.2126*r+.7152*g+.0722*b;
          if(lum<=.43||hi-lo>=.22)continue;
          const nx=x/original.naturalWidth,ny=y/original.naturalHeight;
          if(windowZones.some(poly=>inPolygon(nx,ny,poly)))continue;
          if(wheels.some(([cx,cy,rx,ry])=>Math.pow((nx-cx)/rx,2)+Math.pow((ny-cy)/ry,2)<1))continue;
          if(bumpers.some(poly=>inPolygon(nx,ny,poly)))continue;
          if(lamps.some(poly=>inPolygon(nx,ny,poly)))continue;
          whiteBodyPixels++;
          const pr=paintedData[i]/255,pg=paintedData[i+1]/255,pb=paintedData[i+2]/255;
          if(pr>pg+.08&&pr>pb+.12)recolouredWhitePixels++;
          else if(whiteMisses.length<40)whiteMisses.push({x,y,source:[originalData[i],originalData[i+1],originalData[i+2],alpha],painted:[paintedData[i],paintedData[i+1],paintedData[i+2],paintedData[i+3]]});
        }
      }
      return {
        body: {
          roof: px(340, 14),
          rearQuarter: px(120, 125),
          door: px(400, 150),
          hood: px(620, 125),
          wheelArchLip: px(535, 150),
          frontWheelArch: px(530, 160),
          rearWindowSill: px(240, 100),
          frontWindowSill: px(420, 100),
          rearPillar: px(210, 50)
        },
        glass: {
          rearQuarter: px(175, 55),
          rearSideUpper: px(260, 40),
          rearSideMiddle: px(260, 70),
          rearSideLower: px(260, 90),
          frontSideUpper: px(400, 40),
          frontSideMiddle: px(420, 75),
          frontSideLower: px(400, 90),
          frontWindscreen: px(480, 62)
        },
        whiteBodyPixels,
        recolouredWhitePixels,
        whiteMisses,
        wheel: px(180, 194),
        wheelSidewall: px(144, 194),
        frontWheelSidewall: px(608, 194),
        frontWheelHub: px(580, 194),
        rearBumper: px(38, 172),
        frontBumper: px(670, 174)
      };
    };
    return { paintedUrl, original: sample(original), painted: sample(painted), black: sample(blackPainted) };
  });

  assert.ok(inspection.painted.whiteBodyPixels > 100, "There must be white body pixels in the source PNG to validate.");
  assert.equal(inspection.painted.recolouredWhitePixels, inspection.painted.whiteBodyPixels,
    "Every bright white pixel outside glass, wheels and actual lamp lenses must be recoloured: " +
    JSON.stringify({ total: inspection.painted.whiteBodyPixels, recoloured: inspection.painted.recolouredWhitePixels, misses: inspection.painted.whiteMisses }));
  for (const [part, after] of Object.entries(inspection.painted.body)) {
    const before = inspection.original.body[part];
    assert.ok(after[0] > after[1] + 25 && after[0] > after[2] + 45,
      "The " + part + " must receive the selected orange paint: " + JSON.stringify({ before, after }));
    assert.ok(after[0] - before[0] > 10,
      "The " + part + " must visibly change from the factory PNG: " + JSON.stringify({ before, after }));
  }

  for (const [windowName, before] of Object.entries(inspection.original.glass)) {
    const after = inspection.painted.glass[windowName];
    assert.ok(before.slice(0, 3).every((value, index) => Math.abs(value - after[index]) <= 2),
      windowName + " glass pixels must keep their original colour: " + JSON.stringify({ before, after }));
  }
  for (const part of ["wheel", "wheelSidewall", "frontWheelSidewall", "frontWheelHub", "rearBumper", "frontBumper"]) {
    const before = inspection.original[part];
    const after = inspection.painted[part];
    assert.ok(before.slice(0, 3).every((value, index) => Math.abs(value - after[index]) <= 2),
      part + " pixels must keep their original colour: " + JSON.stringify({ before, after }));
  }
  for (const [part, px] of Object.entries(inspection.black.body)) {
    assert.ok(Math.max(...px.slice(0, 3)) < 85,
      "Black metallic paint should look genuinely dark on " + part + ": " + JSON.stringify(px));
  }
  for (const [windowName, before] of Object.entries(inspection.original.glass)) {
    const after = inspection.black.glass[windowName];
    assert.ok(before.slice(0, 3).every((value, index) => Math.abs(value - after[index]) <= 2),
      "Black paint must also leave " + windowName + " glass untouched: " + JSON.stringify({ before, after }));
  }
  for (const part of ["wheel", "rearBumper", "frontBumper"]) {
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
