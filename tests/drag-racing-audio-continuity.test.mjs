import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const game = await readFile(resolve(root, "drag-racing-v2.html"), "utf8");
const launcher = await readFile(resolve(root, "index.html"), "utf8");
const encoded = (await readFile(resolve(root, "cars/vaz2107-engine-continuous.wav.b64"), "utf8")).trim();
const wav = Buffer.from(encoded, "base64");

function readWav(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF", "Engine asset must be a RIFF WAV file.");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE", "Engine asset must use WAV encoding.");
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      format = {
        code: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        blockAlign: buffer.readUInt16LE(offset + 20),
        bits: buffer.readUInt16LE(offset + 22)
      };
    }
    if (id === "data") {
      data = { offset: offset + 8, size };
      break;
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(format && data, "Engine WAV must contain fmt and data chunks.");
  assert.equal(format.code, 1, "Engine WAV must be PCM.");
  assert.equal(format.channels, 1, "Engine WAV must be mono for mobile playback.");
  assert.equal(format.bits, 16, "Engine WAV must use 16-bit PCM.");
  assert.equal(data.size % format.blockAlign, 0, "Audio data must align to full PCM frames.");
  return { format, data, duration: data.size / format.blockAlign / format.sampleRate };
}

test("the active launcher points to the versioned v2 racing game", () => {
  assert.match(launcher, /href="\.\/drag-racing-v2\.html\?v=20261031-engine-audio-continuous\d+"/);
});

test("the engine loop is long enough to avoid repeated short mobile restarts", () => {
  const parsed = readWav(wav);
  assert.ok(parsed.duration >= 29, `Expected at least 29 seconds; got ${parsed.duration.toFixed(3)}s.`);
  assert.ok(parsed.duration <= 31, `Unexpected engine loop duration: ${parsed.duration.toFixed(3)}s.`);
});

test("the engine loop has no silent 50ms windows and a smooth circular boundary", () => {
  const { format, data } = readWav(wav);
  const sampleCount = data.size / 2;
  const sampleAt = index => wav.readInt16LE(data.offset + index * 2);
  const windowSamples = Math.floor(format.sampleRate * 0.05);
  let minimumRms = Infinity;
  for (let start = 0; start + windowSamples <= sampleCount; start += windowSamples) {
    let sumSquares = 0;
    for (let i = start; i < start + windowSamples; i++) {
      const sample = sampleAt(i) / 32768;
      sumSquares += sample * sample;
    }
    minimumRms = Math.min(minimumRms, Math.sqrt(sumSquares / windowSamples));
  }
  assert.ok(minimumRms > 0.1, `Found a low-energy window in the loop: RMS ${minimumRms.toFixed(4)}.`);
  const boundaryJump = Math.abs(sampleAt(0) - sampleAt(sampleCount - 1));
  assert.ok(boundaryJump < 4096, `Loop boundary is not sufficiently smooth: ${boundaryJump}.`);
});

test("both WebAudio and HTMLAudio use the long engine asset, with a procedural safety layer", () => {
  assert.ok(game.includes("./cars/vaz2107-engine-continuous.wav.b64?v=20261031-engine-continuous2"));
  assert.ok(game.includes("return {audio,url,buffer:decoded};"));
  assert.ok(game.includes("raceEngineMedia.loop=true;"));
  assert.ok(game.includes("const proceduralLevel=throttle?.36:(moving?.29:.25)"));
  assert.ok(game.includes("const safetyVolume=webAudioLive?.14:targetVolume"), "Keep an audible native media safety stream active under WebAudio.");
  assert.ok(game.includes("raceEngineMedia.volume=safetyVolume;"), "Take over immediately when WebAudio drops.");
  assert.ok(game.includes("if(now-lastEngineAudioUpdateAt>=50)"), "Throttle audio parameter updates to 20 Hz to reduce render-thread contention.");
  assert.ok(game.includes("function startRaceAudioWatchdog()"), "Recover the audio graph if Android suspends it.");
  assert.ok(game.includes("raceAudioWatchdogTimer=setInterval"), "Run the recovery watchdog while the cockpit is active.");
  assert.ok(game.includes("window.addEventListener('pageshow'"), "Resume sound when the app returns to the foreground.");
  assert.ok(!game.includes("vaz2107-engine-arcade.wav.b64"));
});

test("the moving 2D track avoids expensive full-surface repaint effects", () => {
  assert.doesNotMatch(game, /\\.pro-race-cockpit\\.race-moving \\.race2d-scene:before\\{animation:/,
    "The large track pseudo-element must not animate background-position on every frame.");
  assert.doesNotMatch(game, /@keyframes race2d-road\\{to\\{background-position:/,
    "Track motion should use the existing compositor-transformed road markings.");
  assert.doesNotMatch(game, /\\.race2d-scene\\.race-fast \\.race2d-(?:city|tree)-layer\\{filter:blur/,
    "High speed must not add costly blur filters to full-width scenery layers.");
  assert.match(game, /frameNow-lastFuelHudSyncAt>=250/,
    "Fuel labels and meters should refresh at a lower rate than the live driving animation.");
});

test("the active v2 racing script parses", () => {
  const scripts = [...game.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const inline = scripts.find(match => !/\bsrc\s*=|\btype\s*=\s*["']importmap/i.test(match[1]));
  assert.ok(inline, "Expected an inline racing-game script.");
  assert.doesNotThrow(() => new Function(inline[2]), "Racing-game script must be syntactically valid.");
});
