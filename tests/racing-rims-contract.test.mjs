import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../racing-game.html", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../racing-host.js", import.meta.url), "utf8");
const router = readFileSync(new URL("../server/drag-racing-router.js", import.meta.url), "utf8");

const rims = {
  sport5: { price: 5000, label: "SPORT 5" },
  mesh10: { price: 7000, label: "MESH 10" },
  turbine: { price: 6500, label: "TURBINE" },
  classic8: { price: 4500, label: "CLASSIC 8" }
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

test("alloy wheel faces use detailed beveled metal geometry", () => {
  assert.match(page, /function acGarageBuildRimFace\\(style, radius, depth, side\\)/);
  assert.match(page, /new THREE\\.ExtrudeGeometry\\(makeSpokeShape\\(1\\)/);
  assert.match(page, /bevelEnabled: true/);
  assert.match(page, /bevelSegments: 3/);
  assert.match(page, /new THREE\\.TorusGeometry\\(radial, tube, 12, 72\\)/);
  assert.match(page, /Five recessed lug seats and bright lug nuts/);
  assert.match(page, /style.kind === "holes"/);
  assert.match(page, /sweep:\\.15/);
});

test("rim selection previews on the loaded 3D car without charging before confirmation", () => {
  assert.match(page, /const acGarageRimOverlayByNode = new WeakMap\\(\\)/);
  assert.match(page, /function acGarageApplyRimStyle\\(rimId/);
  assert.match(page, /wheel\\.node\\.add\\(overlay\\)/);
  assert.match(page, /const previewCar = vehicle\\.clone\\(true\\)/);
  assert.match(page, /acGarageApplyRimStyle\\(id\\)/);
  assert.match(page, /Предпросмотр:[\\s\\S]{0,140}AC пока не списаны/);
  assert.match(page, /acGarageRestoreSelectedRims\\(\\)/);
});

test("rim inventory and selected fitment are persisted per Telegram player", () => {
  assert.match(router, /CREATE TABLE IF NOT EXISTS drag_racing_player_rims/);
  assert.match(router, /CREATE TABLE IF NOT EXISTS drag_racing_player_rim_preferences/);
  for (const route of ["/garage/rims/profile", "/garage/rims/select", "/garage/rims/buy"]) {
    assert.ok(router.includes('router.post("' + route + '"'), "Missing server route " + route);
  }
  assert.match(router, /requireUser\\(req, res, verifyTelegram\\)/);
  assert.match(router, /UPDATE players SET balance = balance - \\$1::BIGINT/);
  assert.match(router, /INSERT INTO drag_racing_player_rims/);
  assert.match(router, /INSERT INTO drag_racing_player_rim_preferences/);
});

test("ALLCOINS Racing host bridge forwards profile, selection and purchase actions", () => {
  assert.match(bridge, /action === "rims:profile"/);
  assert.match(bridge, /allcoinsRacingRimsApi\\.profile\\(\\)/);
  assert.match(bridge, /action === "rims:select"/);
  assert.match(bridge, /allcoinsRacingRimsApi\\.select\\(data\\.rimId\\)/);
  assert.match(bridge, /action === "rims:buy"/);
  assert.match(bridge, /allcoinsRacingRimsApi\\.buy\\(data\\.rimId\\)/);
});
