import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../racing-game.html", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../racing-host.js", import.meta.url), "utf8");
const router = readFileSync(new URL("../server/drag-racing-router.js", import.meta.url), "utf8");
const appShell = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const rims = {
  sport5: { price: 5000, label: "OEM CLASSIC 5" },
  mesh10: { price: 7000, label: "OEM CLASSIC 10" },
  turbine: { price: 6500, label: "OEM TURBO 6" },
  classic8: { price: 4500, label: "OEM SPLIT 5" }
};

test("VAZ-2107 tuning exposes all four paid rim styles with server-matching prices", () => {
  assert.match(page, /id="garageRimSection" hidden/);
  assert.match(page, /id="garageRimOptions"/);
  for (const [id, item] of Object.entries(rims)) {
    const button = page.match(new RegExp('<button class="garage-rim-card"[^>]*data-rim-style="' + id + '"[\\s\\S]*?<\\/button>'));
    assert.ok(button, "Missing rim option " + id);
    assert.ok(button[0].includes(item.label), "Wrong label for " + id);
    const formattedPrice = String(item.price).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    assert.ok(button[0].includes(formattedPrice + " AC"), "Wrong displayed price for " + id);
    assert.match(router, new RegExp(id + ': \\{ price: ' + item.price + ','));
  }
  assert.match(page, /data-rim-style="stock"/);
});

test("all tuning rims use high quality OEM-style cast alloy geometry", () => {
  assert.match(page, /function acGarageBuildRimFace\(style, radius, depth, side\)/);
  assert.match(page, /kind:"cast"/);
  assert.match(page, /function makeSpokeShape/);
  assert.match(page, /addSpokeMesh\(makeSpokeShape\(1\), alloyMaterial/);
  assert.match(page, /new THREE\.ExtrudeGeometry\(shape/);
  assert.match(page, /bevelEnabled: true/);
  assert.match(page, /bevelSegments: 4/);
  assert.match(page, /Narrow polished ridge follows the cast spoke/);
  assert.match(page, /OEM split-spoke casting/);
  assert.match(page, /new THREE\.TorusGeometry\(radial, tube, 12, 96\)/);
  assert.match(page, /Four lug seats and four bright hexagonal wheel bolts/);
  assert.match(page, /const spokeCount = Math\.max\(5, Math\.min\(12, style\.count \|\| 5\)\)/);
  assert.match(page, /metalness: \.88, roughness: \.235/);
  assert.match(page, /const radius = Math\.max\(\.\.\.radialDimensions\)\*\.5\*\.828/);
  assert.match(page, /addMachinedRing\(radius \* \.905/);
  assert.match(page, /outerFactor = \.875/);
  assert.doesNotMatch(page, /openingShadowMaterial|openingBacking|recessMaterial/);
  assert.match(page, /const originalRimGeometries=\[\]/);
  assert.match(page, /ALLCOINS_OriginalRimGeometry_/);
  assert.match(page, /wheel\.originalRimMesh\.visible = rimId === "stock"/);
  assert.doesNotMatch(page, /makeStampRibShape|kind:"stamped"/);
});

test("rim selection previews on the loaded 3D car without charging before confirmation", () => {
  assert.match(page, /const acGarageRimOverlayByNode = new WeakMap\(\)/);
  assert.match(page, /function acGarageApplyRimStyle\(rimId/);
  assert.match(page, /wheel\.node\.add\(overlay\)/);
  assert.match(page, /const previewCar = vehicle\.clone\(true\)/);
  assert.match(page, /acGarageApplyRimStyle\(id\)/);
  assert.match(page, /Предпросмотр:[\s\S]{0,140}AC пока не списаны/);
  assert.match(page, /acGarageRestoreSelectedRims\(\)/);
});

test("rim inventory and selected fitment are persisted per Telegram player", () => {
  assert.match(router, /CREATE TABLE IF NOT EXISTS drag_racing_player_rims/);
  assert.match(router, /CREATE TABLE IF NOT EXISTS drag_racing_player_rim_preferences/);
  for (const route of ["/garage/rims/profile", "/garage/rims/select", "/garage/rims/buy"]) {
    assert.ok(router.includes('router.post("' + route + '"'), "Missing server route " + route);
  }
  assert.match(router, /requireUser\(req, res, verifyTelegram\)/);
  assert.match(router, /UPDATE players SET balance = balance - \$1::BIGINT/);
  assert.match(router, /INSERT INTO drag_racing_player_rims/);
  assert.match(router, /INSERT INTO drag_racing_player_rim_preferences/);
});

test("ALLCOINS Racing host bridge forwards profile, selection and purchase actions", () => {
  assert.match(bridge, /action === "rims:profile"/);
  assert.match(bridge, /allcoinsRacingRimsApi\.profile\(\)/);
  assert.match(bridge, /action === "rims:select"/);
  assert.match(bridge, /allcoinsRacingRimsApi\.select\(data\.rimId\)/);
  assert.match(bridge, /action === "rims:buy"/);
  assert.match(bridge, /allcoinsRacingRimsApi\.buy\(data\.rimId\)/);
});


test("VAZ-2107 air suspension is a persistent 3000 AC tuning unlock", () => {
  assert.match(page, /id="garageSuspensionSection" hidden/);
  assert.match(page, /id="garageSuspensionStatus"/);
  assert.match(page, /id="garageSuspensionBuy"/);
  assert.match(page, /ПНЕВМОПОДВЕСКА/);
  assert.match(page, /3 000 AC/);
  assert.match(page, /const rideModes=\[/);
  assert.match(page, /label:'НИЗКАЯ'/);
  assert.match(page, /label:'СРЕДНЯЯ'/);
  assert.match(page, /label:'ВЫСОКАЯ'/);
  assert.match(page, /if\(acGarageAirSuspensionProfileReady&&acGarageAirSuspensionOwned\)setSuspension\(suspensionMode\+1\)/);
  assert.match(page, /async function acGarageLoadAirSuspensionProfile/);
  assert.match(page, /onlineHostRequest\("suspension:profile"\)/);
  assert.match(page, /onlineHostRequest\("suspension:buy"\)/);
  assert.match(router, /CREATE TABLE IF NOT EXISTS drag_racing_player_air_suspensions/);
  assert.match(router, /router\.post\("\/garage\/suspension\/profile"/);
  assert.match(router, /router\.post\("\/garage\/suspension\/buy"/);
  assert.match(router, /const price = 3000n/);
  assert.match(router, /UPDATE players SET balance = balance - \$1::BIGINT/);
  assert.match(bridge, /action === "suspension:profile"/);
  assert.match(bridge, /allcoinsRacingSuspensionApi\.profile\(\)/);
  assert.match(bridge, /action === "suspension:buy"/);
  assert.match(bridge, /allcoinsRacingSuspensionApi\.buy\(\)/);
  assert.match(appShell, /window\.allcoinsRacingSuspensionApi = Object\.freeze/);
  assert.match(appShell, /\/api\/drag-racing\/garage\/suspension\/profile/);
  assert.match(appShell, /\/api\/drag-racing\/garage\/suspension\/buy/);
});


test("VAZ-2107 exposes exactly seven requested body colours with matching server catalogue", () => {
  const paints = {
    white: { color: "#ffffff", finish: "СОЛИД" },
    black: { color: "#08090b", finish: "СОЛИД" },
    green: { color: "#176b40", finish: "СОЛИД" },
    blue: { color: "#174f9c", finish: "СОЛИД" },
    sochi: { color: "#74887e", finish: "МЕТАЛЛИК", code: "360" },
    red: { color: "#c62932", finish: "СОЛИД" },
    yellow: { color: "#f0cf27", finish: "СОЛИД" }
  };
  for (const [id, paint] of Object.entries(paints)) {
    const button = page.match(new RegExp('<button class="garage-paint-swatch garage-paint-oem"[^>]*data-paint-id="' + id + '"[^>]*>[\\s\\S]*?<\\/button>'));
    assert.ok(button, "Missing requested paint " + id);
    assert.ok(button[0].includes('data-car-paint="' + paint.color + '"'));
    assert.ok(button[0].includes('data-paint-finish="' + paint.finish + '"'));
    if (paint.code) assert.ok(button[0].includes('data-paint-code="' + paint.code + '"'));
    assert.match(router, new RegExp(id + ': \\{ price: 2000, color: "' + paint.color + '" \\}'));
  }
  const paletteStart = page.indexOf('<div class="garage-paint-options" id="garagePaintOptions" hidden>');
  const paletteEnd = page.indexOf('<div class="garage-paint-selected"', paletteStart);
  const paletteMarkup = paletteStart >= 0 && paletteEnd > paletteStart ? page.slice(paletteStart, paletteEnd) : "";
  assert.equal((paletteMarkup.match(/class="garage-paint-swatch/g) || []).length, 7,
    "Only the seven requested colours should be visible.");
  for (const oldId of ["vaz106","vaz107","vaz110","vaz118","vaz127","vaz128","vaz140","vaz182","vaz223","vaz228","vaz304","vaz377","vaz404","vaz420","vaz441","vaz449","vaz605","vaz791"]) {
    assert.doesNotMatch(paletteMarkup, new RegExp('data-paint-id="' + oldId + '"'));
    assert.doesNotMatch(router, new RegExp('^\\s*' + oldId + ':', 'm'));
  }
  assert.match(page, /metallicFactoryPaints = new Set\(\["#74887e"\]\)/);
});
  
test("VAZ-2107 paint colours neutralize factory texture and black uses a solid base", () => {
  assert.match(page, /const acGaragePaintOriginalMaps = new WeakMap\(\)/);
  assert.match(page, /const acGarageWhitePaintTextureCache = new WeakMap\(\)/);
  assert.match(page, /const acGaragePaintOriginalVertexColors = new WeakMap\(\)/);
  assert.match(page, /const isBlackPaint = selectedPaint === "#08090b"/);
  assert.match(page, /if \(isBlackPaint\) \{[\s\S]*?material\.map = null;[\s\S]*?material\.vertexColors = false;/);
  assert.match(page, /material\.color\.set\(paint\)/);
  assert.match(page, /isBlackPaint \? 0\.48 : 0\.42/);
  assert.match(page, /function acGarageGetNeutralBodyPaintTexture\(sourceTexture\)/);
  assert.match(page, /const acGarageNeutralBodyPaintTextureCache = new WeakMap\(\)/);
  assert.match(page, /const neutral = Math\.round\(190 \+ 65 \* luminance\)/);
  assert.match(page, /acGarageGetNeutralBodyPaintTexture\(originalMap\)/);
  assert.match(page, /material\.vertexColors = false/);
  assert.match(page, /function acGarageGetWhitePaintTexture\(sourceTexture\)/);
  assert.match(page, /context\.getImageData\(0, 0, width, height\)/);
  assert.match(page, /const neutral = Math\.round\(188 \+ 67 \* luminance\)/);
  assert.match(page, /const isWhitePaint = selectedPaint === "#ffffff"/);
  assert.match(page, /material\.map = neutralTexture/);
  assert.match(page, /material\.map = originalMap/);
  assert.match(page, /data-car-paint="#ffffff"[^>]*data-paint-id="white"/);
});

test("VAZ-2107 body paint covers rear panels and protects only narrow bumper edges", () => {
  assert.ok(page.includes("function acGarageSetBodyPaintMaterial(material, paint)"));
  assert.ok(page.includes("material.color.set(paint)"));
  assert.ok(page.includes("acGarageSetBodyPaintMaterial(material, paint)"));
  assert.doesNotMatch(page, /acGaragePreparePaintMaterial|acGaragePaintSourceLuma|allcoins-vaz2107-body-paint-v3/);
  assert.ok(page.includes("material.map = null"));
  assert.ok(page.includes("function acGarageSeparateBumpersFromBody(root)"));
  assert.ok(page.includes("ALLCOINS_VAZ2107_UnpaintedBumpers"));
  assert.ok(page.includes("const rearEndZone = Math.max(size.x * .012, .02)"));
  assert.ok(page.includes("const rearSteelTrimTop = bounds.min.y + size.y * .055"));
  assert.ok(page.includes("const isFrontSteelTrim = withinFrontCap && withinFrontSteelTrimBand"));
  assert.ok(page.includes("const isRearSteelTrim = withinRearCap && withinRearSteelTrimBand"));
  assert.ok(page.includes("const keepFactorySteel = isFrontSteelTrim || isRearSteelTrim"));
  assert.ok(page.includes("the rear valance, tail panel and all"));
  assert.ok(page.includes("surrounding bodywork stay in the paintable geometry"));
  assert.ok(page.includes("const frontEndZone = Math.max(size.x * .055, .08)"));
  assert.ok(page.includes("const frontSteelTrimTop = bounds.min.y + size.y * .38"));
  assert.ok(page.includes("const withinRearCap = points.every"));
  assert.ok(page.includes("const withinRearSteelTrimBand = points.every"));
  assert.ok(page.includes("const withinFrontCap = points.every(point => point.x >= bounds.max.x - frontEndZone)"));
  assert.ok(page.includes("const withinRearCap = points.every(point => point.x <= bounds.min.x + rearEndZone)"));
  assert.ok(page.includes("min.x is the REAR"))
  assert.doesNotMatch(page, /steelMaterialIndexes|steelNamePattern|metalness >=/);
});


test("VAZ-2107 acceleration uses progressive launch, gear torque and road resistance", () => {
  assert.match(page, /const accelerationByGear=\[0,12,8\.8,6\.2,4\.8,3\.9\]/);
  assert.match(page, /function raceRoadLoadDeceleration\(speedKmh\)/);
  assert.match(page, /return \.18\+v\*\.003\+v\*v\*\.00003/);
  assert.match(page, /const launchFactor=Math\.min\(1,\.80\+speed\*\.02\)/);
  assert.match(page, /const engineForce=.*launchFactor/);
  assert.match(page, /const accel=Math\.max\(0,engineForce-roadLoad\)/);
  assert.match(page, /const coast=braking\?34\*tireBrakeFactor:raceRoadLoadDeceleration\(speed\)/);
  assert.match(page, /if\(braking\)speed=Math\.max\(0,speed-dt\*14\*/);
  assert.match(page, /gear===-1\?accelerationByGear\[1\]\*\.52:accelerationByGear\[gear\]/);
});


test("VAZ-2107 first gear has a stronger RPM pickup while other gears retain clutch coupling", () => {
  assert.match(page, /if\(throttle&&gear===1\)/);
  assert.match(page, /firstGearLaunchRpm=3900\+Math\.min\(1300,speed\*31\)/);
  assert.match(page, /targetRpm=Math\.max\(coupledEngineRpm,Math\.min\(6800,firstGearLaunchRpm\)\)/);
  assert.match(page, /const launchClutchBlend=throttle\?Math\.max\(0,1-Math\.min\(1,speed\/30\)\):0/);
  assert.match(page, /throttle&&gear===1\?32:throttle\?11\.5/);
  assert.match(page, /const torque=torqueCurve\(rpm\)/);
  assert.match(page, /engineForce=.*torque.*launchFactor/);
});

test("asphalt texture and its relief move left in proportion to speed and distance", () => {
  assert.match(page, /function acAdvanceRoadSurface\(scroll\)/);
  assert.match(page, /const textureDelta = scroll \* repeatX \/ roadWidth/);
  assert.match(page, /texture\.offset\.x = \(\(texture\.offset\.x \+ textureDelta\) % 1 \+ 1\) % 1/);
  assert.match(page, /road\.userData\.lastLeftwardScroll = scroll > 0 \? scroll : 0/);
  assert.match(page, /const scroll=\(signedSpeed\/3\.6\)\*WORLD_UNITS_PER_METER\*dt/);
  assert.match(page, /acAdvanceRoadSurface\(scroll\)/);
  assert.match(page, /acAdvanceCentralMarkings\(scroll\)/);
});


test("VAZ-2107 road speed, wheel rotation and finish distance share one world scale", () => {
  assert.match(page, /let WORLD_UNITS_PER_METER = 1/);
  assert.match(page, /worldUnitsPerRealMeter=vehicleLength\/4\.57/);
  assert.match(page, /WORLD_UNITS_PER_METER=worldUnitsPerRealMeter/);
  assert.match(page, /const scroll=\(signedSpeed\/3\.6\)\*worldUnitsPerRealMeter\*dt/);
  assert.match(page, /const roadWheelRate=\(signedSpeed\/3\.6\)\*worldUnitsPerRealMeter\/Math\.max/);
  assert.match(page, /finishLine\.position\.x=finishStartX-distance\*WORLD_UNITS_PER_METER/);
  assert.match(page, /PlaneGeometry\(2400, 25\.6\)/);
  assert.match(page, /BoxGeometry\(2400, \.026, \.13\)/);
  assert.match(page, /colorMap\.repeat\.set\(266\.6666667, 2\.13\)/);
  assert.match(page, /roadWorldUnitsMatchWheelTravel: true/);
});

test("VAZ-2107 first-gear RPM curve rises strongly with vehicle speed", () => {
  assert.match(page, /firstGearLaunchRpm=3900\+Math\.min\(1300,speed\*31\)/);
  assert.match(page, /throttle&&gear===1\?32:throttle\?11\.5/);
  assert.match(page, /const coupledEngineRpm=Math\.max\(850,Math\.min\(6800,coupledRpm\|\|900\)\)/);
});
