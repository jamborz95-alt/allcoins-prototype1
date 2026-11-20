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
function buildTestCarGlb() {
  const binaryParts = [], bufferViews = [], accessors = [], meshes = [];
  const nodes = [{ name: "ALLCOINS_Test_VAZ2107", children: [] }];
  let binaryLength = 0;

  function view(data, target) {
    const pad = (4 - binaryLength % 4) % 4;
    if (pad) { binaryParts.push(Buffer.alloc(pad)); binaryLength += pad; }
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const byteOffset = binaryLength;
    binaryParts.push(bytes); binaryLength += bytes.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target });
    return bufferViews.length - 1;
  }

  function geometryAccessors(g) {
    const p = new Float32Array(g.p), n = new Float32Array(g.n), ix = new Uint16Array(g.i);
    const pv = view(p, 34962), nv = view(n, 34962), iv = view(ix, 34963);
    const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
    for (let k=0;k<p.length;k+=3) for(let a=0;a<3;a++) {
      min[a]=Math.min(min[a],p[k+a]); max[a]=Math.max(max[a],p[k+a]);
    }
    accessors.push({bufferView:pv,componentType:5126,count:p.length/3,type:"VEC3",min,max});
    const pa=accessors.length-1;
    accessors.push({bufferView:nv,componentType:5126,count:n.length/3,type:"VEC3"});
    const na=accessors.length-1;
    accessors.push({bufferView:iv,componentType:5123,count:ix.length,type:"SCALAR",min:[Math.min(...ix)],max:[Math.max(...ix)]});
    return {pa,na,ia:accessors.length-1};
  }

  function box(w,h,d) {
    const x=w/2,y=h/2,z=d/2, p=[],n=[],i=[];
    const faces=[
      {n:[0,0,1],v:[[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]]},
      {n:[0,0,-1],v:[[x,-y,-z],[-x,-y,-z],[-x,y,-z],[x,y,-z]]},
      {n:[1,0,0],v:[[x,-y,z],[x,-y,-z],[x,y,-z],[x,y,z]]},
      {n:[-1,0,0],v:[[-x,-y,-z],[-x,-y,z],[-x,y,z],[-x,y,-z]]},
      {n:[0,1,0],v:[[-x,y,z],[x,y,z],[x,y,-z],[-x,y,-z]]},
      {n:[0,-1,0],v:[[-x,-y,-z],[x,-y,-z],[x,-y,z],[-x,-y,z]]}
    ];
    for(const face of faces){
      const b=p.length/3;
      for(const v of face.v){p.push(...v);n.push(...face.n);}
      i.push(b,b+1,b+2,b,b+2,b+3);
    }
    return {p,n,i};
  }

  function cylinder(r,depth,segments=20) {
    const p=[],n=[],i=[];
    for(let k=0;k<segments;k++){
      const a=k/segments*Math.PI*2,b=(k+1)/segments*Math.PI*2;
      const ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b);
      const base=p.length/3;
      p.push(r*ca,-depth/2,r*sa,r*cb,-depth/2,r*sb,r*cb,depth/2,r*sb,r*ca,depth/2,r*sa);
      n.push(ca,0,sa,cb,0,sb,cb,0,sb,ca,0,sa);
      i.push(base,base+2,base+1,base,base+3,base+2);
      let t=p.length/3;
      p.push(0,depth/2,0,r*ca,depth/2,r*sa,r*cb,depth/2,r*sb);
      n.push(0,1,0,0,1,0,0,1,0); i.push(t,t+1,t+2);
      t=p.length/3;
      p.push(0,-depth/2,0,r*cb,-depth/2,r*sb,r*ca,-depth/2,r*sa);
      n.push(0,-1,0,0,-1,0,0,-1,0); i.push(t,t+1,t+2);
    }
    return {p,n,i};
  }

  function subdividedBox(w,h,d,segments=8) {
    const x=w/2,y=h/2,z=d/2,p=[],n=[],i=[];
    const faces=[
      {n:[0,0,1],v:[[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]]},
      {n:[0,0,-1],v:[[x,-y,-z],[-x,-y,-z],[-x,y,-z],[x,y,-z]]},
      {n:[1,0,0],v:[[x,-y,z],[x,-y,-z],[x,y,-z],[x,y,z]]},
      {n:[-1,0,0],v:[[-x,-y,-z],[-x,-y,z],[-x,y,z],[-x,y,-z]]},
      {n:[0,1,0],v:[[-x,y,z],[x,y,z],[x,y,-z],[-x,y,-z]]},
      {n:[0,-1,0],v:[[-x,-y,-z],[x,-y,-z],[x,-y,z],[-x,-y,z]]}
    ];
    for(const face of faces){
      const [a,b,c,d]=face.v;
      const point=(u,v)=>[
        (1-u)*(1-v)*a[0]+u*(1-v)*b[0]+u*v*c[0]+(1-u)*v*d[0],
        (1-u)*(1-v)*a[1]+u*(1-v)*b[1]+u*v*c[1]+(1-u)*v*d[1],
        (1-u)*(1-v)*a[2]+u*(1-v)*b[2]+u*v*c[2]+(1-u)*v*d[2]
      ];
      for(let row=0;row<segments;row++)for(let col=0;col<segments;col++){
        const base=p.length/3;
        for(const [u,v] of [[col/segments,row/segments],[(col+1)/segments,row/segments],[(col+1)/segments,(row+1)/segments],[col/segments,(row+1)/segments]]){
          p.push(...point(u,v));n.push(...face.n);
        }
        i.push(base,base+1,base+2,base,base+2,base+3);
      }
    }
    return {p,n,i};
  }

  function cylinderSideAxis(r,depth,segments=64) {
    const p=[],n=[],i=[];
    for(let k=0;k<segments;k++){
      const a=k/segments*Math.PI*2,b=(k+1)/segments*Math.PI*2;
      const ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b);
      let base=p.length/3;
      p.push(r*ca,r*sa,-depth/2,r*cb,r*sb,-depth/2,r*cb,r*sb,depth/2,r*ca,r*sa,depth/2);
      n.push(ca,sa,0,cb,sb,0,cb,sb,0,ca,sa,0);
      i.push(base,base+1,base+2,base,base+2,base+3);
      base=p.length/3;
      p.push(0,0,depth/2,r*ca,r*sa,depth/2,r*cb,r*sb,depth/2);
      n.push(0,0,1,0,0,1,0,0,1);i.push(base,base+1,base+2);
      base=p.length/3;
      p.push(0,0,-depth/2,r*cb,r*sb,-depth/2,r*ca,r*sa,-depth/2);
      n.push(0,0,-1,0,0,-1,0,0,-1);i.push(base,base+1,base+2);
    }
    return {p,n,i};
  }

  function combine(parts) {
    const result={p:[],n:[],i:[]};
    for(const part of parts){
      const offset=result.p.length/3;
      for(let k=0;k<part.geometry.p.length;k+=3){
        result.p.push(
          part.geometry.p[k]+part.translation[0],
          part.geometry.p[k+1]+part.translation[1],
          part.geometry.p[k+2]+part.translation[2]
        );
      }
      result.n.push(...part.geometry.n);
      result.i.push(...part.geometry.i.map(index=>index+offset));
    }
    return result;
  }

  const materials=[
    {name:"metallic red body paint",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.72,.12,.15,1],metallicFactor:.58,roughnessFactor:.28}},
    {name:"dark window glass",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.035,.07,.095,1],metallicFactor:.3,roughnessFactor:.18}},
    {name:"tyre rubber",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.035,.04,.045,1],metallicFactor:0,roughnessFactor:.9}},
    {name:"machined alloy",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.68,.73,.78,1],metallicFactor:.88,roughnessFactor:.23}},
    {name:"chrome trim",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.72,.77,.82,1],metallicFactor:.9,roughnessFactor:.2}},
    {name:"headlight glass",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.96,.86,.63,1],metallicFactor:.08,roughnessFactor:.18}}
  ];

  function part(name,g,material,translation=[0,0,0],rotation=null){
    const a=geometryAccessors(g), mesh=meshes.length;
    meshes.push({name,primitives:[{attributes:{POSITION:a.pa,NORMAL:a.na},indices:a.ia,material}]});
    const node={name,mesh,translation}; if(rotation) node.rotation=rotation;
    nodes.push(node); nodes[0].children.push(nodes.length-1);
  }

  const axleRotation=[Math.SQRT1_2,0,0,Math.SQRT1_2];
  part("Car_CarBody_0",box(4.45,.68,1.46),0,[0,.78,0]);
  part("Car_Roof_0",box(2.38,.82,1.28),0,[-.12,1.48,0]);
  for(const side of [-1,1]) part("Car_Glass_Side_"+side,box(1.72,.46,.028),1,[-.12,1.52,side*.655]);
  // The production loader extracts four connected wheel islands from Car_Bottom_0.
  const underbody=[
    {geometry:subdividedBox(4.25,.30,1.18,8),translation:[0,.40,0]}
  ];
  for(const x of [-1.37,1.37]) for(const side of [-1,1]){
    underbody.push(
      {geometry:cylinderSideAxis(.39,.24,64),translation:[x,.39,side*.77]},
      {geometry:cylinderSideAxis(.235,.255,64),translation:[x,.39,side*.77]}
    );
  }
  part("Car_Bottom_0",combine(underbody),2);
  part("Car_Front_Bumper",box(.12,.15,1.55),4,[2.28,.52,0]);
  part("Car_Rear_Bumper",box(.12,.15,1.55),4,[-2.28,.52,0]);
  part("Car_Headlamp_Left",box(.035,.16,.22),5,[2.27,.78,-.47]);
  part("Car_Headlamp_Right",box(.035,.16,.22),5,[2.27,.78,.47]);

  const binary=Buffer.concat(binaryParts);
  const doc={asset:{version:"2.0",generator:"ALLCOINS browser visual fixture"},scene:0,scenes:[{nodes:[0]}],nodes,meshes,materials,accessors,bufferViews,buffers:[{byteLength:binary.length}]};
  const rawJson=Buffer.from(JSON.stringify(doc),"utf8"), jp=(4-rawJson.length%4)%4;
  const json=Buffer.concat([rawJson,Buffer.alloc(jp,0x20)]), bp=(4-binary.length%4)%4;
  const bin=Buffer.concat([binary,Buffer.alloc(bp)]);
  const total=12+8+json.length+8+bin.length, glb=Buffer.alloc(total);
  glb.writeUInt32LE(0x46546c67,0); glb.writeUInt32LE(2,4); glb.writeUInt32LE(total,8);
  glb.writeUInt32LE(json.length,12); glb.writeUInt32LE(0x4e4f534a,16); json.copy(glb,20);
  const binHeader=20+json.length; glb.writeUInt32LE(bin.length,binHeader);
  glb.writeUInt32LE(0x004e4942,binHeader+4); bin.copy(glb,binHeader+8);
  return glb;
}
const testCarGlb=buildTestCarGlb();

const pageHtml = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="allcoins-racing-amvera-api" content="https://allcoins-engine-a-allcoins95.msk1.amvera.tech">
<title>ALLCOINS Racing classic runtime test</title></head>
<body>
<a id="openDragRacing" href="#race" data-allcoins-racing-launch="true">Драг-рейсинг 3D</a>
<script>
window.__telegramFullscreenCalls = 0;
// Exercise a fresh Amvera download in this smoke test rather than an old local model cache.
Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
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
  // Exercise the network-download fallback deterministically; IndexedDB persistence is covered by the live browser itself.
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
    window.__allcoinsTestHostMessages = [];
    window.addEventListener("message", event => {
      const data = event.data || {};
      if (typeof data.type === "string" && data.type.startsWith("allcoins:car-model")) {
        window.__allcoinsTestHostMessages.push({
          type: data.type,
          fileName: data.fileName || null,
          byteLength: data.buffer instanceof ArrayBuffer ? data.buffer.byteLength : null,
          message: data.message || null
        });
      }
    });
  });

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

    if (["/api/racing/vaz-2107.glb", "/api/racing/shared-model-asset"].includes(url.pathname) && request.method() === "GET") {
      // Both the current public Amvera asset path and the legacy authenticated PC tunnel are supported.
      assert.match(request.headers().range || "", /^bytes=0-/);
      return route.fulfill({
        status: 206,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "X-File-Name, Content-Length, Content-Range, Accept-Ranges",
          "content-type": "model/gltf-binary",
          "content-length": String(testCarGlb.length),
          "content-range": "bytes 0-" + (testCarGlb.length - 1) + "/" + testCarGlb.length,
          "accept-ranges": "bytes",
          "x-file-name": "test-vaz-2107.glb"
        },
        body: testCarGlb
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

  try {
    await gameFrame.waitForFunction(() =>
      window.__allcoinsTestHostMessages?.some(entry =>
        entry.type === "allcoins:car-model" || entry.type === "allcoins:car-model-error"
      ), null, { timeout: 10000 });
  } catch (error) {
    const transferDiagnostic = {
      apiCalls: [...apiCalls],
      hostMessages: await gameFrame.evaluate(() => window.__allcoinsTestHostMessages || [])
    };
    const gameDiagnostic = await gameFrame.evaluate(() => ({
      messageTitle: document.querySelector("#message strong")?.textContent || null,
      message: document.querySelector("#messageText")?.textContent || null,
      garageStatus: document.querySelector("#garageCarStatus")?.textContent || null,
      modelLoadError: window.__allcoinsRacingModelLoadError || null,
      boot: window.__allcoinsRacingBoot || null
    }));
    throw new Error("GLB transfer diagnostic: " + JSON.stringify({ transferDiagnostic, gameDiagnostic }) + "; " + error.message);
  }
  const hostMessages = await gameFrame.evaluate(() => window.__allcoinsTestHostMessages || []);
  const hostError = hostMessages.find(entry => entry.type === "allcoins:car-model-error");
  if (hostError) throw new Error("GLB host transfer failed: " + JSON.stringify({ hostError, apiCalls }));
  try {
    await gameFrame.waitForFunction(() => window.__allcoinsRacingVehicleDiagnostics?.loaded === true, null, { timeout: 10000 });
  } catch (error) {
    const modelDiagnostic = await gameFrame.evaluate(() => ({
      vehicle: window.__allcoinsRacingVehicleDiagnostics || null,
      modelLoadError: window.__allcoinsRacingModelLoadError || null,
      boot: window.__allcoinsRacingBoot || null,
      messageTitle: document.querySelector("#message strong")?.textContent || null,
      message: document.querySelector("#messageText")?.textContent || null,
      garageStatus: document.querySelector("#garageCarStatus")?.textContent || null,
      hostMessages: window.__allcoinsTestHostMessages || [],
      threeLoaded: Boolean(window.THREE && window.THREE.GLTFLoader)
    }));
    await gameFrame.locator("body").screenshot({ path: resolve(root, "artifacts", "racing-model-load-failure.png") });
    throw new Error("GLB parse/attach diagnostic: " + JSON.stringify(modelDiagnostic) + "; " + error.message);
  }
  await gameFrame.evaluate(() => setGarageMode(false));

  // Capture the attached 3D vehicle in the actual landscape race view.
  await page.setViewportSize({ width: 844, height: 390 });
  await gameFrame.waitForTimeout(250);
  await gameFrame.locator("body").screenshot({ path: resolve(root, "artifacts", "racing-scene-landscape.png") });
  await page.setViewportSize({ width: 1365, height: 768 });

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
  const gearSelector = gameFrame.locator("#gearSelector");
  assert.equal(await gearSelector.count(), 1, "Exactly one sequential gear selector must be present.");
  assert.notEqual(await gearSelector.evaluate(el => getComputedStyle(el).display), "none",
    "The single sequential shifter must be visible in race mode.");
  assert.equal((await gearSelector.locator(".gear-selector-plus").textContent()).trim(), "+",
    "The top of the single selector must be marked plus.");
  assert.equal((await gearSelector.locator(".gear-selector-minus").textContent()).trim(), "−",
    "The bottom of the single selector must be marked minus.");
  const shiftAt = async (fraction, pointerId, type = "touch") => gearSelector.evaluate((el, args) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height * args.fraction;
    const base = { bubbles: true, cancelable: true, pointerId: args.pointerId, pointerType: args.type, isPrimary: true, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent("pointerdown", base));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
  }, { fraction, pointerId, type });
  await shiftAt(.12, 40);
  assert.equal((await gameFrame.locator("#gearNow").textContent()).trim(), "2",
    "Touching the top + area must upshift.");
  await shiftAt(.88, 41);
  assert.equal((await gameFrame.locator("#gearNow").textContent()).trim(), "1",
    "Touching the bottom − area must downshift.");

  assert.equal(await gameFrame.locator("#gearPattern").evaluate(el => getComputedStyle(el).display), "none",
    "The numbered H-pattern must be hidden in favour of one sequential shifter.");
  assert.equal(await gameFrame.locator("#gearUp").evaluate(el => getComputedStyle(el).display), "none",
    "The old standalone plus button must stay hidden.");
  assert.equal(await gameFrame.locator("#gearDown").evaluate(el => getComputedStyle(el).display), "none",
    "The old standalone minus button must stay hidden.");
  assert.equal(await gameFrame.locator("#gas").isDisabled(), false,
    "The gas pedal must remain usable while the fuel profile is loading or unavailable.");
  await gameFrame.locator("#gas").dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true });
  assert.ok(await gameFrame.locator("#gas").evaluate(el => el.classList.contains("active")),
    "The gas pedal must activate while pressed.");
  await shiftAt(.12, 8, "touch");
  assert.equal((await gameFrame.locator("#gearNow").textContent()).trim(), "2",
    "A second touch on the upper + area must upshift while the first touch keeps the accelerator pressed.");
  assert.ok(await gameFrame.locator("#gas").evaluate(el => el.classList.contains("active")),
    "Upshifting must keep the accelerator held.");
  assert.deepEqual(await gameFrame.evaluate(() => window.__allcoinsRacingShiftDiagnostics), {
    shiftCount: 3,
    lastShiftWithThrottle: true,
    throttlePreserved: true
  }, "The gear handler must preserve the live throttle state during a second-finger shift.");
  assert.doesNotMatch(await gameFrame.locator("#gearHint").textContent(), /ОТПУСТИ ГАЗ/,
    "The dashboard must not ask the driver to release the accelerator before shifting.");
  await shiftAt(.88, 9, "touch");
  assert.equal((await gameFrame.locator("#gearNow").textContent()).trim(), "1",
    "A second touch on the lower − area must downshift while the first touch keeps the accelerator pressed.");
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
  assert.equal(visualDiagnostics.cityBuildingOffsetZ, -20.8, "The foreground buildings must remain behind the far-side fence while visible in the side-on phone camera.");
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
  assert.equal(visualDiagnostics.skylineOffsetZ, -38, "The skyline must remain behind the foreground apartment row.");
  assert.equal(visualDiagnostics.cameraViewHeight, 8.25, "The mobile race camera must frame the player's car larger.");

  // Check the slightly reduced lower dashboard on a typical landscape Android viewport.
  await page.setViewportSize({ width: 844, height: 390 });
  const mobilePanelHeight = await gameFrame.locator("#dashboardBackplate").evaluate(
    element => Math.round(element.getBoundingClientRect().height)
  );
  assert.ok(mobilePanelHeight >= 76 && mobilePanelHeight <= 90,
    "The single-shifter landscape dashboard must stay at its compact 82px phone height.");
  await page.setViewportSize({ width: 1365, height: 768 });
  assert.equal(visualDiagnostics.skylineTowers, 16, "The distant skyline must contain high-rise buildings.");
  assert.ok(visualDiagnostics.skylineWindows >= 100, "The distant skyline must contain illuminated windows.");

  await gameFrame.locator("#pause").click();
  assert.equal(await gameFrame.locator("#pause").textContent(), "ПРОДОЛЖИТЬ",
    "The pause control must respond to taps/clicks.");
  await gameFrame.locator("#pause").click();
  assert.equal(await gameFrame.locator("#pause").textContent(), "ПАУЗА");

  const suspensionControl = gameFrame.locator("#suspension");
  assert.equal(await suspensionControl.isDisabled(), true,
    "The pneumatic suspension must stay locked until it is purchased in the garage tuning section.");
  assert.match(await suspensionControl.getAttribute("title"), /Купить пневмоподвеску/,
    "The locked suspension button must explain where it can be unlocked.");

  await gameFrame.locator("#headlights").click();
  assert.equal(await gameFrame.locator("#headlights").textContent(), "ФАРЫ ВКЛ",
    "The headlight control must respond to taps/clicks.");

  const vehicleDiagnostics = await gameFrame.evaluate(
    () => window.__allcoinsRacingVehicleDiagnostics
  );
  assert.equal(vehicleDiagnostics.rootVisible, true,
    "The loaded VAZ root must remain visible in the race scene.");
  assert.ok(vehicleDiagnostics.visibleMeshCount > 0 && vehicleDiagnostics.meshCount > 0,
    "At least one visible 3D mesh must be attached to the car.");
  assert.equal(vehicleDiagnostics.wheelCount, 4, "The GLB must produce four independently extracted wheel assemblies.");
  assert.equal(vehicleDiagnostics.frontWheelCount, 2, "Both front wheels must be assigned to the front axle.");
  assert.equal(vehicleDiagnostics.rearWheelCount, 2, "Both rear wheels must be assigned to the rear axle.");

  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await gameFrame.locator("#gearPattern").evaluate(element => getComputedStyle(element).display),
    "none",
    "The old H-pattern must stay hidden; the single sequential +/− selector is used in landscape phone mode."
  );
  assert.notEqual(
    await gameFrame.locator("#gearSelector").evaluate(element => getComputedStyle(element).display),
    "none",
    "The single sequential +/− selector must remain visible in landscape phone mode."
  );
  const compactDashboardHeight = await gameFrame.locator("#dashboardBackplate").evaluate(
    element => Math.round(element.getBoundingClientRect().height)
  );
  assert.ok(compactDashboardHeight >= 76 && compactDashboardHeight <= 90,
    "The landscape dashboard must remain at its compact 82px height and leave the car visible above it.");
  assert.ok(apiCalls.some(call =>
    call.path === "/api/racing/vaz-2107.glb" || call.path === "/api/racing/shared-model-asset"
  ), "The VAZ-2107 model must load through one of the supported asset endpoints.");
  assert.deepEqual(pageErrors, [],
    "Classic Three.js startup and UI control binding must not raise uncaught browser errors.");

  console.log("Racing smoke test passed: same-origin 3D scene, classic Three.js/GLTFLoader, VAZ model attachment, four independently extracted wheels, pause/headlight controls, and locked suspension state.");
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
}
