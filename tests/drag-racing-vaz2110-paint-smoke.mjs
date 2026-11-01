import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
await mkdir(resolve(root, "artifacts"), { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 1 });
page.on("console", message => console.log("BROWSER CONSOLE [" + message.type() + "]: " + message.text()));
page.on("pageerror", error => console.log("BROWSER PAGEERROR: " + error.stack));

try {
  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Telegram={WebApp:{initData:'',initDataUnsafe:{},ready(){},expand(){},BackButton:{hide(){},show(){}},MainButton:{hide(){}},SecondaryButton:{hide(){}},requestFullscreen(){},exitFullscreen(){}}};"
  }));

  const response = await page.goto("http://127.0.0.1:4173/drag-racing-v2.html?paint-vaz2110-regression=1", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  assert.ok(response && response.status() === 200, "Drag Racing v2 must load.");
  await page.waitForFunction(() => typeof window.__allcoinsVaz2110PaintPreview === "function", null, { timeout: 15000 });

  // Diagnose the colour renderer directly before exercising the actual UI.
  const directResult = await page.evaluate(async () => {
    const url = await window.__allcoinsVaz2110PaintPreview("#0750df");
    return { prefix: String(url).slice(0, 80), length: String(url).length };
  });
  console.log("VAZ-2110 direct paint result: " + JSON.stringify(directResult));

  // Exercise the same user path as the garage: open tuning and choose blue paint.
  await page.locator('button[data-tab="tuning"]').click();
  await page.waitForFunction(() => {
    const section = document.getElementById("tuning");
    return section && !section.classList.contains("hidden");
  });
  await page.locator('#paintPicker [data-paint="blue"]').click();
  const previewState = await page.waitForFunction(() => {
    const image = document.querySelector("#stylePreview .vaz2110-preview-car-png");
    if (!image) return false;
    if (image.complete && image.naturalWidth === 360 && image.src.startsWith("data:image/png")) return true;
    if (image.complete && image.naturalWidth > 0 && !image.src.startsWith("data:image/png")) return "original-image";
    return false;
  }, null, { timeout: 15000 }).catch(async error => {
    const state = await page.locator("#stylePreview").evaluate(node => ({
      html: node.innerHTML.slice(0, 1000),
      image: node.querySelector("img") ? {
        src: node.querySelector("img").src.slice(0, 100),
        complete: node.querySelector("img").complete,
        width: node.querySelector("img").naturalWidth
      } : null
    })).catch(() => null);
    throw new Error("Paint preview wait failed: " + JSON.stringify({ directResult, state }) + "; " + error.message);
  });
  assert.equal(previewState, true, "Selected paint should replace the source image with a recoloured PNG.");

  const inspection = await page.evaluate(async () => {
    const paintedUrl = document.querySelector("#stylePreview .vaz2110-preview-car-png").src;
    const originalUrl = "./cars/vaz2110-body.png?v=20261101-vaz2110-body-v24";
    const load = url => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    const [original, painted] = await Promise.all([load(originalUrl), load(paintedUrl)]);
    const read = image => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return { ctx, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const src = read(original), out = read(painted);
    const inPoly = (x, y, poly) => {
      let inside = false;
      for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
        const [xi,yi]=poly[i], [xj,yj]=poly[j];
        if (((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi||1e-9)+xi)) inside=!inside;
      }
      return inside;
    };
    // Pixel-space cutouts corresponding to the four windows in the 360x120 PNG.
    const windows = [
      [[67,35],[84,19],[87,19],[84,37]],
      [[94,18],[145,18],[147,37],[94,38]],
      [[160,18],[197,18],[206,36],[161,37]],
      [[208,14],[218,23],[226,35],[223,36],[214,27]]
    ];
    const wheels = [[76.65,92.85,17.55,19.05],[270,91.65,17.7,19.65]];
    let candidates=0, paintedPixels=0, misses=[];
    for(let y=5;y<89;y++) for(let x=10;x<350;x++) {
      const p=(y*360+x)*4, a=src.data[p+3];
      if(a<90) continue;
      const r=src.data[p], g=src.data[p+1], b=src.data[p+2];
      const lum=(r*.2126+g*.7152+b*.0722)/255;
      if(lum<.18 || Math.max(r,g,b)-Math.min(r,g,b)>65) continue;
      if(windows.some(poly=>inPoly(x,y,poly))) continue;
      if(wheels.some(([cx,cy,rx,ry])=>((x-cx)/rx)**2+((y-cy)/ry)**2<1)) continue;
      candidates++;
      const pr=out.data[p], pg=out.data[p+1], pb=out.data[p+2];
      if(pb>pr+30 && pb>pg+22) paintedPixels++;
      else if(misses.length<25) misses.push({x,y,source:[r,g,b,a],painted:[pr,pg,pb,out.data[p+3]]});
    }
    const px=(data,x,y)=>Array.from(data.ctx.getImageData(x,y,1,1).data);
    return {
      width: painted.naturalWidth, height: painted.naturalHeight,
      originalSize: [original.naturalWidth,original.naturalHeight],
      candidateMetalPixels: candidates, bluePixels: paintedPixels,
      ratio: candidates ? paintedPixels/candidates : 0,
      misses,
      samples: {
        roof: { original:px(src,170,8), painted:px(out,170,8) },
        rearQuarter: { original:px(src,55,63), painted:px(out,55,63) },
        rearDoor: { original:px(src,120,64), painted:px(out,120,64) },
        frontDoor: { original:px(src,180,65), painted:px(out,180,65) },
        frontWing: { original:px(src,310,67), painted:px(out,310,67) },
        sill: { original:px(src,190,84), painted:px(out,190,84) },
        rearGlass: { original:px(src,75,30), painted:px(out,75,30) },
        sideGlass: { original:px(src,120,26), painted:px(out,120,26) },
        wheelOpening: { original:px(src,77,94), painted:px(out,77,94) }
      }
    };
  });

  assert.ok(inspection.candidateMetalPixels > 100,
    "Expected a meaningful sample of opaque VAZ-2110 body pixels: " + JSON.stringify(inspection));
  assert.ok(inspection.ratio > 0.90,
    "At least 90% of neutral opaque body pixels outside windows/wheel openings must take blue paint: " +
    JSON.stringify({ total: inspection.candidateMetalPixels, painted: inspection.bluePixels, ratio: inspection.ratio, misses: inspection.misses }));
  
  await page.locator("#stylePreview").screenshot({ path: resolve(root, "artifacts/vaz-2110-blue-paint-preview.png") });
  const paintedSrc = await page.locator("#stylePreview .vaz2110-preview-car-png").getAttribute("src");
  assert.ok(paintedSrc?.startsWith("data:image/png"), "Preview must show the recoloured PNG, not the untouched source.");
  console.log("VAZ-2110 full-body PNG paint test passed: " + JSON.stringify(inspection));
} finally {
  await browser.close();
}
