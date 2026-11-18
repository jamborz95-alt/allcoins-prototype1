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


test("VAZ-2107 has a dedicated factory paint palette with server-matching codes", () => {
  const factoryPaints = {
    vaz106: { code: "106", color: "#7b3f32", finish: "СОЛИД" },
    vaz107: { code: "107", color: "#38243f", finish: "СОЛИД" },
    vaz110: { code: "110", color: "#9c2032", finish: "СОЛИД" },
    vaz118: { code: "118", color: "#ce2736", finish: "СОЛИД" },
    vaz127: { code: "127", color: "#5b1c2b", finish: "СОЛИД" },
    vaz128: { code: "128", color: "#b92a3c", finish: "МЕТАЛЛИК" },
    vaz140: { code: "140", color: "#702537", finish: "СОЛИД" },
    vaz182: { code: "182", color: "#7d2331", finish: "СОЛИД" },
    vaz223: { code: "223", color: "#e4c32d", finish: "СОЛИД" },
    vaz228: { code: "228", color: "#d7bd9d", finish: "СОЛИД" },
    vaz304: { code: "304", color: "#1e4936", finish: "СОЛИД" },
    vaz377: { code: "377", color: "#24535a", finish: "СОЛИД" },
    vaz404: { code: "404", color: "#718078", finish: "СОЛИД" },
    vaz420: { code: "420", color: "#1d4852", finish: "СОЛИД" },
    vaz441: { code: "441", color: "#172d59", finish: "СОЛИД" },
    vaz449: { code: "449", color: "#1b4267", finish: "СОЛИД" },
    vaz605: { code: "605", color: "#4e627b", finish: "МЕТАЛЛИК" },
    vaz791: { code: "791", color: "#52402f", finish: "МЕТАЛЛИК" }
  };
  for (const [id, paint] of Object.entries(factoryPaints)) {
    const button = page.match(new RegExp('<button class="garage-paint-swatch garage-paint-oem"[^>]*data-paint-id="' + id + '"[^>]*>[\\s\\S]*?<\\/button>'));
    assert.ok(button, "Missing VAZ-2107 factory paint " + id);
    assert.ok(button[0].includes('data-car-paint="' + paint.color + '"'));
    assert.ok(button[0].includes('data-paint-code="' + paint.code + '"'));
    assert.ok(button[0].includes('data-paint-finish="' + paint.finish + '"'));
    assert.match(router, new RegExp(id + ': \\{ price: 2000, color: "' + paint.color + '" \\}'));
  }
  const paletteStart = page.indexOf('<div class="garage-paint-options" id="garagePaintOptions" hidden>');
  const paletteEnd = page.indexOf('<div class="garage-paint-selected"', paletteStart);
  const paletteMarkup = paletteStart >= 0 && paletteEnd > paletteStart ? page.slice(paletteStart, paletteEnd) : "";
  assert.equal((paletteMarkup.match(/class="garage-paint-swatch/g) || []).length, 18,
    "Only the eighteen VAZ-2107 factory colours should be visible.");
  for (const oldId of ["white","black","silver","graphite","red","blue","green","burgundy","yellow","orange","skyblue","turquoise","violet","bronze"]) {
    assert.doesNotMatch(paletteMarkup, new RegExp('data-paint-id="' + oldId + '"'));
    assert.doesNotMatch(router, new RegExp('^\\s*' + oldId + ':', 'm'));
  }
  assert.match(page, /metallicFactoryPaints = new Set/);
  assert.match(page, /hasMetallicFinish \? 0\.32 : 0\.08/);
});

test("VAZ-2107 body paint uses the original material tint without a PNG paint shader", () => {
  assert.match(page, /function acGarageSetBodyPaintMaterial\(material, paint\)/);
  assert.match(page, /material\.color\.set\(paint\)/);
  assert.match(page, /acGarageSetBodyPaintMaterial\(material, paint\)/);
  assert.doesNotMatch(page, /acGaragePreparePaintMaterial|acGaragePaintSourceLuma|allcoins-vaz2107-body-paint-v3/);
  assert.doesNotMatch(page, /material\.map\s*=\s*null/);
  assert.match(page, /function acGarageSeparateBumpersFromBody\(root\)/);
  assert.match(page, /ALLCOINS_VAZ2107_UnpaintedBumpers/);
  assert.match(page, /steelNamePattern = \/chrome\|steel\|stainless\|metal/);
  assert.match(page, /metalness >= \.45 && neutralSilver/);
  assert.match(page, /steelMaterialIndexes\.has\(materialIndex\)/);
  assert.match(page, /steelMaterialIndexes\.size\s*\?\s*isSteelMaterial\s*:/);
  assert.match(page, /isFrontOrRearEnd && belowBumperLine/);
  assert.match(page, /keep every face[\s\S]*steel material slot/);
  assert.match(page, /Only steel\/chrome material faces are kept factory-coloured/);

  assert.match(page, /const endZone = Math\.max\(size\.x \* \.04, \.05\)/);
  assert.match(page, /const bumperTop = bounds\.min\.y \+ size\.y \* \.34/);
  assert.match(page, /withinFrontCap = \[pointA, pointB, pointC\]\.every/);
  assert.match(page, /withinRearCap = \[pointA, pointB, pointC\]\.every/);
  assert.match(page, /belowBumperLine = \[pointA, pointB, pointC\]\.every/);

});
