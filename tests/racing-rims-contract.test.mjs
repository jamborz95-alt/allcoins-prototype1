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
  assert.match(page, /wheel\.originalRimMesh\.visible = true/);
  assert.match(page, /AC_RACING_FACTORY_RIM_DETAIL_STYLE/);
  assert.match(page, /rimId === "stock" \? AC_RACING_FACTORY_RIM_DETAIL_STYLE : style/);
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
  assert.match(page, /material\.map = neutralTexture \|\| originalMap/);
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
  assert.ok(page.includes("At the rear"));
  assert.ok(page.includes("protect only the narrow bottom bumper lip; paint the rear body."));
  assert.ok(page.includes("Protect only the physical bumper/grille edge polygons by position."));
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
  assert.match(page, /const scroll=\(signedSpeed\/3\.6\)\*worldUnitsPerRealMeter\*dt/);
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

test("racing parts can be removed to persistent storage and reinstalled without losing their level", () => {
  assert.match(router, /ALTER TABLE drag_racing_player_parts ADD COLUMN IF NOT EXISTS is_installed BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(router, /SELECT part_id, level, is_installed FROM drag_racing_player_parts/);
  assert.match(router, /router\.post\("\/garage\/parts\/remove"/);
  assert.match(router, /router\.post\("\/garage\/parts\/install"/);
  assert.match(router, /SET is_installed = FALSE/);
  assert.match(router, /SET is_installed = TRUE/);
  assert.match(router, /is_installed === false/);
  assert.match(router, /Эта деталь находится на складе/);
  assert.match(page, /НА СКЛАДЕ · УРОВЕНЬ /);
  assert.match(page, /СНЯТЬ С АВТО/);
  assert.match(page, /УСТАНОВИТЬ СО СКЛАДА/);
  assert.match(page, /БОНУС ВРЕМЕННО НЕ ДЕЙСТВУЕТ/);
  assert.match(page, /racingInstalledParts = racingNormalizeParts\(installed \|\| \{\}\)/);
  assert.match(page, /onlineHostRequest\(action === "remove" \? "parts:remove" : "parts:install", \{partId\}\)/);
  assert.match(bridge, /action === "parts:remove"/);
  assert.match(bridge, /action === "parts:install"/);
  assert.match(appShell, /"\/api\/drag-racing\/garage\/parts\/remove"/);
  assert.match(appShell, /"\/api\/drag-racing\/garage\/parts\/install"/);
});

test("removing a racing part stores it without losing its level, and reinstalling restores its effect", () => {
  assert.match(router, /is_installed BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(router, /async function readRacingPartsInventory\([\s\S]*?installedParts[\s\S]*?storedParts/);
  assert.match(router, /router\.post\("\/garage\/parts\/remove"/);
  assert.match(router, /router\.post\("\/garage\/parts\/install"/);
  assert.match(router, /SET is_installed = FALSE/);
  assert.match(router, /SET is_installed = TRUE/);
  assert.match(router, /Эта деталь находится на складе/);
  assert.match(page, /function racingOwnedPartLevel\(partId\)/);
  assert.match(page, /СНЯТЬ С АВТО/);
  assert.match(page, /НА СКЛАДЕ · УРОВЕНЬ /);
  assert.match(page, /УСТАНОВИТЬ СО СКЛАДА/);
  assert.match(page, /racingInstalledParts = racingNormalizeParts\(installed \|\| \{\}\)/);
  assert.match(bridge, /action === "parts:remove"/);
  assert.match(bridge, /action === "parts:install"/);
  assert.match(appShell, /"\/api\/drag-racing\/garage\/parts\/remove"/);
  assert.match(appShell, /"\/api\/drag-racing\/garage\/parts\/install"/);
});

test("landscape cockpit keeps the VAZ visible and leaves only + / − gear controls", () => {
  assert.match(page, /root\.visible = true/);
  assert.match(page, /root\.traverse\(object => \{ object\.visible = true; \}\)/);
  assert.match(page, /const focusZ = vehicle \? vehicle\.position\.z : AC_PLAYER_LANE_Z/);
  assert.match(page, /camera\.lookAt\(focusX, focusY \+ frameLift, focusZ\)/);
  assert.match(page, /acOnlineCameraMode = ""/);
  assert.match(page, /window\.__allcoinsRacingVehicleDiagnostics = Object\.freeze\(/);
  assert.match(page, /allcoins-racing-landscape-compact-v1/);
  assert.match(page, /#gearPattern\{display:none!important\}/);
  assert.match(page, /#gearUp,#gearDown\{[\s\S]*?display:flex!important/);
  assert.match(page, /#gearUp,#gearDown\s*\{[\s\S]*?width:36px!important/);
  assert.match(page, /function selectGearFromPattern\(target\)/);
  assert.match(page, /document\.querySelectorAll\('\[data-gear-target\]'\)\.forEach\(button => \{\s*button\.addEventListener\('click', \(\) => \{\s*selectGearFromPattern\(button\.dataset\.gearTarget\)/);
});


test("mobile racing quality is sharper and idle rendering is throttled to reduce frame-time pressure", () => {
  assert.match(page, /antialias: true/);
  assert.match(page, /const acMobilePixelRatioCap = 1\.28/);
  assert.match(page, /const anisotropy = Math\.min\(acRacingMobileDevice \? 4 : 8/);
  assert.match(page, /carTextureAnisotropy=Math\.min\(acRacingMobileDevice\?8:12/);
  assert.match(page, /adaptiveResolution:true,[\s\S]*?renderCalls:renderer\.info\.render\.calls/);
  assert.match(page, /acNextRaceProgressUpdateAt=now\+100/);
  assert.match(page, /acWheelSpinScratchQuaternion\.setFromAxisAngle/);
  assert.match(page, /acOnlineCameraMode === targetCameraMode && !acOnlineLaneLayoutActive/);
  assert.match(page, /const staticScene=document\.body\.classList\.contains\('garage-mode'\)\|\|paused/);
});


test("camera is recalculated after the VAZ loads and after phone rotation", () => {
  assert.match(page, /function acOnlineSetCameraMode\(mode, force = false\)/);
  assert.match(page, /if \(!force && acOnlineCameraMode === mode\) return/);
  assert.match(page, /acOnlineSetCameraMode\(cameraMode, true\)/);
  assert.match(page, /acOnlineSetCameraMode\(document\.body\.classList\.contains\("garage-mode"\)[\s\S]*?true\)/);
});

test("mobile rendering reduces resolution quickly under load and restores it gradually", () => {
  assert.match(page, /const acMobilePixelRatioInitial = 1\.05/);
  assert.match(page, /if\(measuredFps<43\)/);
  assert.match(page, /if\(acPerfLowFpsSamples>=1&&currentPixelRatio>\.82\)/);
  assert.match(page, /Math\.max\(\.82,currentPixelRatio-\.12\)/);
  assert.match(page, /Math\.min\(acMobilePixelRatioCap,currentPixelRatio\+\.04\)/);
  assert.match(page, /const dt=Math\.min\(\.06,rawFrameMs\/1000\|\|0\)/);
});

test("landscape dashboard and touch controls use the compact phone layout", () => {
  assert.match(page, /style id="allcoins-racing-landscape-compact-v2"/);
  assert.match(page, /width:76px!important/);
  assert.match(page, /height:46px!important/);
  assert.match(page, /width:27px!important/);
});


test("racing scene adds lightweight cinematic lighting and contact shadows", () => {
  assert.match(page, /function acCreateSoftContactShadowTexture\(\)/);
  assert.match(page, /ALLCOINS · мягкая контактная тень ВАЗ-2107/);
  assert.match(page, /streetLampReflectionsInstanced: Boolean\(acLampPools && acLampPools\.isInstancedMesh\)/);
  assert.match(page, /acSetLampPoolMatrix\(index,lamp\.x\)/);
  assert.match(page, /acLampPools\.instanceMatrix\.needsUpdate=true/);
  assert.match(page, /const acRainCount=acRacingMobileDevice \? 72 : 180/);
  assert.match(page, /acVehicleShadow\.visible\s*=\s*trackVisible && Boolean\(vehicle\)/);
});


test("distant city skyline is visible in race mode", () => {
  assert.match(page, /distantHills\.visible = trackVisible/);
  assert.match(page, /skylineTowerCount: farCityTowerCount/);
});



test("headlight toggle is mounted on the dashboard and reports on/off state", () => {
  const actions = page.match(/<div class="actions">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.doesNotMatch(actions, /id="headlights"/);
  assert.match(page, /id="dashboardBackplate"[^>]*><\/div>\s*<button class="small-btn dashboard-light-switch" id="headlights"/);
  assert.match(page, /aria-pressed="false">ФАРЫ ВЫКЛ<\/button>/);
  assert.match(page, /button\.textContent=headlightEnabled\?'ФАРЫ ВКЛ':'ФАРЫ ВЫКЛ'/);
  assert.match(page, /button\.setAttribute\('aria-pressed',String\(headlightEnabled\)\)/);
  assert.match(page, /allcoins-racing-dashboard-light-switch-v154/);
  assert.match(page, /@media\(max-height:520px\) and \(orientation:landscape\)/);
});

  
test("gearbox uses one visible sequential selector with plus above and minus below", () => {
  assert.match(page, /id="gearSelector" class="gear-selector" role="group"/);
  assert.match(page, /gear-selector-mark gear-selector-plus"[^>]*>\+<\/span>/);
  assert.match(page, /gear-selector-mark gear-selector-minus"[^>]*>−<\/span>/);
  assert.match(page, /function acGearSelectorShift\(delta\)[\s\S]*?shift\(delta\)/);
  assert.match(page, /acGearSelectorShift\(deltaY < 0 \? 1 : -1\)/);
  assert.match(page, /if \(localY < \.36\) acGearSelectorShift\(1\)/);
  assert.match(page, /else if \(localY > \.64\) acGearSelectorShift\(-1\)/);
  assert.match(page, /allcoins-racing-single-sequential-shifter-v159/);
  assert.match(page, /#gearSelector \{[\s\S]*?z-index:2147483001!important/);
  assert.match(page, /body\.race-mode #gearUp,[\s\S]*?body\.garage-mode #gearDown/);
  assert.match(page, /bindGearShift\('gearUp',1\)/);
  assert.match(page, /bindGearShift\('gearDown',-1\)/);
});


test("V160 improves VAZ body paint, glass, rubber and chrome without changing car geometry or physics", () => {
  assert.match(page, /function acRacingCreateCarReflectionTexture\(\)/);
  assert.match(page, /THREE\.EquirectangularReflectionMapping/);
  assert.match(page, /function acRacingEnhanceCarSurface\(root\)/);
  assert.match(page, /material\.clearcoat = \.82/);
  assert.match(page, /material\.clearcoatRoughness = \.19/);
  assert.match(page, /material\.envMapIntensity = \.58/);
  assert.match(page, /material\.roughness = Math\.max\(originalRoughness, \.84\)/);
  assert.match(page, /acRacingEnhanceCarSurface\(vehicle\)/);
  assert.match(page, /Math\.min\(acRacingMobileDevice\?8:12,renderer\.capabilities\.getMaxAnisotropy\(\)\)/);
  assert.match(page, /sourceGeometryPreserved: true/);
  assert.match(page, /ALLCOINS RACING V160/);
});


test("V162 enlarges the race car and makes the rotating factory wheels more detailed", () => {
  assert.match(page, /acRacingMobileDevice \? 5\.8 : 6\.2/);
  assert.match(page, /function acRacingEnhanceWheelRubber\(wheel\)/);
  assert.match(page, /material\.roughness = Math\.max\(\.88/);
  assert.match(page, /function acGarageBuildWheelRimOverlay\(wheel, style, rimId\)/);
  assert.match(page, /AC_RACING_FACTORY_RIM_DETAIL_STYLE/);
  assert.match(page, /rimId === "stock" \? AC_RACING_FACTORY_RIM_DETAIL_STYLE : style/);
  assert.match(page, /wheel\.node\.add\(overlay\)/);
  assert.match(page, /spinWheelSet\(frontWheelNodes,wheelSpinAngle\)/);
  assert.match(page, /spinWheelSet\(rearWheelNodes,rearWheelSpinAngle\)/);
  assert.match(page, /carTextureAnisotropy=Math\.min\(acRacingMobileDevice\?8:12/);
});

test("V164 frames the car prominently on the road above the dashboard", () => {
  assert.match(page, /const frameLift = window\.matchMedia\("\(max-width: 900px\), \(pointer: coarse\)"\)\.matches \? \.35 : \.28/);
  assert.match(page, /camera\.position\.set\(focusX, focusY \+ 3\.6 \+ frameLift, focusZ \+ 18\)/);
  assert.match(page, /camera\.lookAt\(focusX, focusY \+ frameLift, focusZ\)/);
  assert.match(page, /acRacingMobileDevice \? 5\.8 : 6\.2/);
});

