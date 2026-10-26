import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../blockblast.html", import.meta.url), "utf8");
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/i);
assert.ok(inline, "Block Blast inline script should exist");
new vm.Script(inline[1], { filename: "blockblast.inline.js" });

assert.match(html, /id="soundToggle"/, "in-game sound toggle should exist");
assert.match(inline[1], /AudioContext\|\|window\.webkitAudioContext/, "sound should use browser Web Audio API");
assert.match(inline[1], /function playGameSound\(kind\)/, "game sound effects should exist");
assert.match(inline[1], /localStorage\.setItem\("allcoins_blockblast_sound"/, "sound preference should persist");
assert.match(inline[1], /function animateDropGhostToBoard\(row,col,anchorRow,anchorCol\)/, "release animation should move the dragged piece to the target cell");
assert.match(inline[1], /animateDropGhostToBoard\(row,col,state\.anchorRow,state\.anchorCol\)/, "pointer release should use the smooth drop animation");
assert.match(inline[1], /playGameSound\(lines\?"clear":"place"\)/, "placing blocks and clearing lines should play different sounds");
assert.match(html, /blockBlastLand 230ms/, "placed blocks should land with a smooth animation");

console.log("Block Blast sound and smooth-drop smoke checks passed.");
