/* ALLCOINS "Передай бомбу" — lightweight 3D arena renderer.
   Gameplay remains in bomb.html; this layer only upgrades the visuals. */
(() => {
  'use strict';
  const arena = document.getElementById('arena');
  if (!arena || !window.THREE) return;

  const THREE = window.THREE;
  const VIEW_H = 15.6;
  const ELEVATION = Math.atan2(34, 28);
  const SIN_E = Math.sin(ELEVATION);
  const COS_E = Math.cos(ELEVATION);
  const $ = (id) => document.getElementById(id);

  let renderer, scene, camera, worldRoot, playerRoot, bombRoot, bombShadow;
  let floorMesh, floorMaterial, mainCurve, sideCurve, dustPoints, dustGeometry;
  let rendererWidth = 0, rendererHeight = 0, worldMap = '';
  let frameId = 0, lastFrame = 0, lastTrailTime = 0, lastDrawAt = 0;
  let rendererFailed = false;
  let previousExplosion = false, explosionEffect = null;
  let lastBombScreen = null;
  const miners = new Map();
  const effects = [];
  const trailSprites = [];
  const disposalStack = [];
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const style = document.createElement('style');
  style.textContent = [
    '.arena.three-ready .mine-scene{opacity:0!important}',
    '.arena.three-ready .obstacle-layer{opacity:0!important}',
    '.arena.three-ready .player-character,.arena.three-ready .bot-characters,.arena.three-ready .bomb,.arena.three-ready .trail{visibility:hidden!important}',
    '.arena.three-ready .arena-glow{opacity:.38}',
    '.bomb-3d-canvas{position:absolute;inset:0;z-index:1;width:100%;height:100%;display:block;pointer-events:none}'
  ].join('');
  document.head.appendChild(style);

  function makeRadialTexture(inner, middle, outer) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
    g.addColorStop(0, inner);
    g.addColorStop(.38, middle);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function makeDirtTexture(crystal) {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 512, 512);
    if (crystal) {
      gradient.addColorStop(0, '#29264a');
      gradient.addColorStop(.48, '#45406b');
      gradient.addColorStop(1, '#211e3b');
    } else {
      gradient.addColorStop(0, '#6f4031');
      gradient.addColorStop(.48, '#a66542');
      gradient.addColorStop(1, '#74422f');
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 3000; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      const r = Math.random() * (crystal ? 2.2 : 2.8) + .25;
      const alpha = Math.random() * .28;
      ctx.fillStyle = crystal
        ? (Math.random() > .5 ? 'rgba(179,190,255,' + alpha + ')' : 'rgba(8,8,26,' + alpha + ')')
        : (Math.random() > .5 ? 'rgba(255,202,145,' + alpha + ')' : 'rgba(37,17,13,' + alpha + ')');
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.8, r, rand(-.8, .8), 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      ctx.strokeStyle = crystal ? 'rgba(171,166,255,.11)' : 'rgba(255,210,154,.10)';
      ctx.lineWidth = rand(.5, 1.4);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + rand(-22, 22), y + rand(-7, 7));
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3.5, 4.5);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  const softShadowTexture = makeRadialTexture('rgba(0,0,0,.65)', 'rgba(0,0,0,.24)', 'rgba(0,0,0,0)');
  const glowTexture = makeRadialTexture('rgba(255,248,214,1)', 'rgba(255,166,49,.62)', 'rgba(255,98,20,0)');
  const coolGlowTexture = makeRadialTexture('rgba(217,246,255,.9)', 'rgba(83,190,255,.46)', 'rgba(87,87,255,0)');

  function standard(color, roughness, metalness, extras) {
    return new THREE.MeshStandardMaterial(Object.assign({
      color, roughness: roughness == null ? .72 : roughness,
      metalness: metalness == null ? 0 : metalness
    }, extras || {}));
  }
  function glowMaterial(color, intensity) {
    return new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: intensity == null ? 1.8 : intensity,
      roughness: .25, metalness: .05
    });
  }
  function mesh(geometry, material, parent, x, y, z) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x || 0, y || 0, z || 0);
    if (parent) parent.add(m);
    return m;
  }
  function makeShadow(parent, width, depth, y) {
    const mat = new THREE.MeshBasicMaterial({
      map: softShadowTexture, color: 0x4b2c1c, transparent: true,
      opacity: .38, depthWrite: false, side: THREE.DoubleSide
    });
    const m = mesh(new THREE.PlaneGeometry(width, depth), mat, parent, 0, y || .025, 0);
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  function init() {
    try {
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1c1518);
      scene.fog = new THREE.Fog(0x1c1518, 40, 75);
      camera = new THREE.OrthographicCamera(-8, 8, VIEW_H / 2, -VIEW_H / 2, .1, 100);
      camera.position.set(0, 34, 28);
      camera.lookAt(0, 0, 0);

      renderer = new THREE.WebGLRenderer({
        antialias: true, alpha: false, powerPreference: 'high-performance',
        stencil: false, depth: true, precision: 'mediump'
      });
      // Keep the full 3D effect while limiting GPU load on mid-range Android phones.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
      renderer.setClearColor(0x1c1518, 1);
      renderer.domElement.className = 'bomb-3d-canvas';
      renderer.domElement.setAttribute('aria-hidden', 'true');
      renderer.domElement.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        fallbackTo2D(new Error('WebGL context lost'));
      }, { passive: false });
      renderer.domElement.addEventListener('webglcontextcreationerror', () => {
        fallbackTo2D(new Error('WebGL context creation failed'));
      });
      arena.insertBefore(renderer.domElement, arena.firstChild);

      scene.add(new THREE.HemisphereLight(0xcadfff, 0x4c2418, 1.65));
      const key = new THREE.DirectionalLight(0xffd3a1, 2.25);
      key.position.set(-8, 18, 9);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x8ccfff, 1.0);
      fill.position.set(9, 13, -10);
      scene.add(fill);
      const lanternA = new THREE.PointLight(0xffa54e, 22, 25, 2);
      lanternA.position.set(-3.5, 4.8, -5);
      scene.add(lanternA);
      const lanternB = new THREE.PointLight(0x65cfff, 9, 20, 2);
      lanternB.position.set(3.8, 3.2, 5);
      scene.add(lanternB);

      playerRoot = new THREE.Group();
      scene.add(playerRoot);
      bombRoot = new THREE.Group();
      scene.add(bombRoot);
      bombShadow = makeShadow(scene, 1.9, 1.25, .015);

      createBomb();
      resize(true);
      arena.classList.add('three-ready');

      const obstacleLayer = $('obstacleLayer');
      if (obstacleLayer && window.MutationObserver) {
        new MutationObserver(() => rebuildWorld(true)).observe(obstacleLayer, { childList: true, subtree: true });
      }
      new MutationObserver(() => {
        const wanted = arena.dataset.map || 'copper';
        if (wanted !== worldMap) rebuildWorld(true);
      }).observe(arena, { attributes: true, attributeFilter: ['data-map'] });
      if (window.ResizeObserver) new ResizeObserver(() => resize(false)).observe(arena);
      window.addEventListener('resize', () => resize(false), { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !frameId) {
          lastFrame = 0;
          frameId = requestAnimationFrame(loop);
        }
      });
      frameId = requestAnimationFrame(loop);
    } catch (error) {
      fallbackTo2D(error);
    }
  }

  function fallbackTo2D(error) {
    if (rendererFailed) return;
    rendererFailed = true;
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
    arena.classList.remove('three-ready');
    if (renderer && renderer.domElement) {
      try { renderer.dispose(); } catch (_) {}
      try { renderer.domElement.remove(); } catch (_) {}
    }
    renderer = null;
    console.warn('ALLCOINS 3D renderer stopped; gameplay continues in fallback mode.', error || 'Renderer stopped');
  }

  function screenToWorld(px, py, y) {
    const w = Math.max(1, rendererWidth || arena.clientWidth || 360);
    const h = Math.max(1, rendererHeight || arena.clientHeight || 500);
    const yy = y || 0;
    return new THREE.Vector3(
      (px / w - .5) * (VIEW_H * w / h),
      yy,
      (py / h - .5) * VIEW_H / SIN_E + yy * COS_E / SIN_E
    );
  }
  function screenFractionToWorld(fx, fy, y) {
    return screenToWorld(fx * rendererWidth, fy * rendererHeight, y || 0);
  }
  function screenPosition(node, fallbackY) {
    if (!node) return null;
    const left = parseFloat(node.style.left);
    const top = parseFloat(node.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { x: left, y: top + (fallbackY || 18) };
  }

  function clearWorld() {
    if (!worldRoot) return;
    if (floorMaterial && floorMaterial.map && floorMaterial.map.dispose) floorMaterial.map.dispose();
    scene.remove(worldRoot);
    worldRoot.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material) {
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach((m) => { if (m && m.dispose) m.dispose(); });
      }
    });
    worldRoot = null;
    floorMesh = null;
    floorMaterial = null;
    dustPoints = null;
    dustGeometry = null;
    mainCurve = null;
    sideCurve = null;
  }

  function rebuildWorld(force) {
    if (!renderer) return;
    const nextMap = arena.dataset.map || (document.querySelector('#mapControl .map-choice.selected') || {}).dataset?.map || 'copper';
    if (!force && nextMap === worldMap && worldRoot) return;
    worldMap = nextMap;
    clearWorld();

    const crystal = worldMap === 'crystal';
    const palette = crystal ? {
      background: 0x15172d, fog: 0x1c1c3d,
      ground: 0x8b88c8, rock: 0x48456e, rockEdge: 0x292746,
      wood: 0x514268, woodLight: 0x9b78d1,
      rail: 0xa8bfea, railGlow: 0x76e7ff,
      crystal: 0x60e7ff, crystal2: 0xb07dff,
      ore: 0xaedfff, light: 0x85bfff
    } : {
      background: 0x231611, fog: 0x382019,
      ground: 0xffffff, rock: 0x805040, rockEdge: 0x402b25,
      wood: 0x5d3828, woodLight: 0xb87943,
      rail: 0xc5b9a3, railGlow: 0xf5dba9,
      crystal: 0x62d9ff, crystal2: 0xffc45e,
      ore: 0xffcf6d, light: 0xffa34d
    };
    scene.background.setHex(palette.background);
    scene.fog.color.setHex(palette.fog);

    worldRoot = new THREE.Group();
    scene.add(worldRoot);
    const groundTexture = makeDirtTexture(crystal);
    floorMaterial = new THREE.MeshStandardMaterial({
      color: palette.ground, map: groundTexture, roughness: 1, metalness: 0
    });
    const worldWidth = VIEW_H * rendererWidth / Math.max(1, rendererHeight);
    const worldDepth = VIEW_H / SIN_E;
    floorMesh = mesh(
      new THREE.PlaneGeometry(worldWidth + 8, worldDepth + 9),
      floorMaterial, worldRoot, 0, -.18, 0
    );
    floorMesh.rotation.x = -Math.PI / 2;

    const borderMat = standard(palette.rock, .96, 0);
    const rockHighMat = standard(crystal ? 0x7774ad : 0xb17755, .94, 0);
    const rockShadowMat = standard(palette.rockEdge, 1, 0);
    const woodMat = standard(palette.wood, .87, .05);
    const woodLightMat = standard(palette.woodLight, .72, .02);
    const metalMat = standard(crystal ? 0x9fa8ca : 0x9a9fa4, .35, .83);
    const railMat = standard(palette.rail, .3, .85);
    const railHighlightMat = glowMaterial(palette.railGlow, crystal ? .75 : .4);
    const oreMat = glowMaterial(palette.ore, crystal ? 1.4 : 1.05);
    const crystalMat = new THREE.MeshPhysicalMaterial({
      color: palette.crystal, emissive: palette.crystal, emissiveIntensity: crystal ? 1.3 : .55,
      roughness: .2, metalness: .1, transparent: true, opacity: .88, transmission: .08
    });
    const crystalMat2 = new THREE.MeshPhysicalMaterial({
      color: palette.crystal2, emissive: palette.crystal2, emissiveIntensity: crystal ? 1.25 : .45,
      roughness: .23, metalness: .08, transparent: true, opacity: .92
    });

    // Rugged tunnel shoulders, kept near the sides so they do not obstruct play.
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < 11; i++) {
        const fx = side === 0 ? rand(.005, .055) : rand(.945, .995);
        const fy = -.06 + i * .105 + rand(-.025, .025);
        const p = screenFractionToWorld(fx, fy, .04);
        const rock = mesh(rockGeo, i % 3 === 0 ? rockHighMat : borderMat, worldRoot, p.x, rand(.18, .45), p.z);
        const scale = rand(.36, .95);
        rock.scale.set(scale * rand(.8, 1.35), scale * rand(.7, 1.4), scale * rand(.8, 1.25));
        rock.rotation.set(rand(-.25, .25), rand(0, Math.PI), rand(-.2, .2));
        const seam = mesh(new THREE.DodecahedronGeometry(.3, 0), rockShadowMat, worldRoot,
          p.x + rand(-.12, .12), rand(.12, .23), p.z + rand(-.12, .12));
        seam.scale.set(rand(.7, 1.6), rand(.5, .85), rand(.7, 1.4));
      }
    }

    // Mine timber arches at the far and near ends of the tunnel.
    const timberGeo = new THREE.BoxGeometry(.22, 3.55, .28);
    const beamGeo = new THREE.BoxGeometry(1, .32, .34);
    const boltGeo = new THREE.SphereGeometry(.075, 8, 6);
    [0.09, .91].forEach((fy) => {
      const left = screenFractionToWorld(.075, fy, 0);
      const right = screenFractionToWorld(.925, fy, 0);
      [left, right].forEach((p) => {
        mesh(timberGeo, woodMat, worldRoot, p.x, 1.75, p.z);
        mesh(boltGeo, metalMat, worldRoot, p.x, 3.2, p.z + .19);
        mesh(new THREE.BoxGeometry(.34, .17, .38), woodLightMat, worldRoot, p.x, .18, p.z);
      });
      const beam = mesh(beamGeo, woodLightMat, worldRoot, (left.x + right.x) / 2, 3.42, (left.z + right.z) / 2);
      beam.scale.x = Math.abs(right.x - left.x);
      mesh(boltGeo, metalMat, worldRoot, left.x + .2, 3.42, left.z + .2);
      mesh(boltGeo, metalMat, worldRoot, right.x - .2, 3.42, right.z + .2);
    });

    // Twin winding railway lines, complete with track bed, steel rails and timber sleepers.
    mainCurve = new THREE.SplineCurve([
      new THREE.Vector2(.425, -.12), new THREE.Vector2(.445, .12),
      new THREE.Vector2(.535, .265), new THREE.Vector2(.555, .39),
      new THREE.Vector2(.475, .535), new THREE.Vector2(.365, .67),
      new THREE.Vector2(.39, .805), new THREE.Vector2(.49, 1.12)
    ]);
    sideCurve = new THREE.SplineCurve([
      new THREE.Vector2(.705, -.12), new THREE.Vector2(.755, .12),
      new THREE.Vector2(.675, .285), new THREE.Vector2(.695, .425),
      new THREE.Vector2(.795, .585), new THREE.Vector2(.785, .755),
      new THREE.Vector2(.715, .9), new THREE.Vector2(.735, 1.12)
    ]);
    buildTrack(mainCurve, palette, woodMat, woodLightMat, railMat, railHighlightMat);
    buildTrack(sideCurve, palette, woodMat, woodLightMat, railMat, railHighlightMat);

    // Ore veins, lanterns and crystal clusters add depth without expensive real-time shadows.
    for (let i = 0; i < 9; i++) {
      const fx = i % 2 ? rand(.14, .29) : rand(.72, .87);
      const fy = rand(.08, .92);
      const p = screenFractionToWorld(fx, fy, .03);
      const ore = mesh(new THREE.OctahedronGeometry(rand(.1, .24), 0), oreMat, worldRoot, p.x, rand(.18, .42), p.z);
      ore.rotation.set(rand(-.3, .3), rand(0, Math.PI), rand(-.3, .3));
      if (crystal || i % 3 === 0) {
        for (let j = 0; j < 2; j++) {
          const q = mesh(new THREE.OctahedronGeometry(rand(.13, .28), 0), j ? crystalMat2 : crystalMat, worldRoot,
            p.x + rand(-.35, .35), rand(.25, .6), p.z + rand(-.3, .3));
          q.scale.y = rand(1.25, 2.3);
          q.rotation.z = rand(-.25, .25);
        }
      }
    }
    const lanternPositions = [[.16,.18], [.84,.37], [.15,.70], [.86,.82]];
    lanternPositions.forEach((q, idx) => {
      const p = screenFractionToWorld(q[0], q[1], 0);
      const post = mesh(new THREE.CylinderGeometry(.08, .12, 1.55, 8), woodMat, worldRoot, p.x, .78, p.z);
      const hood = mesh(new THREE.CylinderGeometry(.19, .15, .15, 10), metalMat, worldRoot, p.x, 1.6, p.z);
      const bulb = mesh(new THREE.SphereGeometry(.12, 12, 8), glowMaterial(crystal ? 0x8ee8ff : 0xffc466, 3), worldRoot, p.x, 1.44, p.z);
      // Glowing lantern meshes are lit by the shared scene lights to keep mobile GPU load low.
    });

    addObstacles(crystal, palette, rockGeo, borderMat, rockHighMat, woodMat, woodLightMat, metalMat, crystalMat, crystalMat2);
    addDust(worldWidth, worldDepth, crystal);
    buildDecorativeCart(woodMat, woodLightMat, metalMat, oreMat, palette);
  }

  function buildTrack(curve, palette, woodMat, woodLightMat, railMat, railHighlightMat) {
    const rectW = Math.max(1, rendererWidth), rectH = Math.max(1, rendererHeight);
    const gaugePx = clamp(rectW * .037, 10, 18);
    const railSamples = [];
    const leftRail = [], rightRail = [];
    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      const p = curve.getPoint(t);
      const prev = curve.getPoint(Math.max(0, t - .003));
      const next = curve.getPoint(Math.min(1, t + .003));
      const dx = (next.x - prev.x) * rectW;
      const dy = (next.y - prev.y) * rectH;
      const len = Math.max(1, Math.hypot(dx, dy));
      const px = -dy / len, py = dx / len;
      const sx = p.x * rectW, sy = p.y * rectH;
      const a = screenToWorld(sx + px * gaugePx, sy + py * gaugePx, .055);
      const b = screenToWorld(sx - px * gaugePx, sy - py * gaugePx, .055);
      leftRail.push(a); rightRail.push(b);
      railSamples.push({t, sx, sy, dx: dx / len, dy: dy / len, px, py, a, b});
    }
    const railCurveA = new THREE.CatmullRomCurve3(leftRail);
    const railCurveB = new THREE.CatmullRomCurve3(rightRail);
    mesh(new THREE.TubeGeometry(railCurveA, 90, .085, 8, false), railMat, worldRoot, 0, 0, 0);
    mesh(new THREE.TubeGeometry(railCurveB, 90, .085, 8, false), railMat, worldRoot, 0, 0, 0);
    const highlightA = leftRail.map((p) => p.clone().add(new THREE.Vector3(-.018, .045, 0)));
    const highlightB = rightRail.map((p) => p.clone().add(new THREE.Vector3(-.018, .045, 0)));
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(highlightA), 90, .023, 5, false), railHighlightMat, worldRoot, 0, 0, 0);
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(highlightB), 90, .023, 5, false), railHighlightMat, worldRoot, 0, 0, 0);

    const tieGeo = new THREE.BoxGeometry(1, 1, 1);
    const tieMat = standard(palette.woodLight, .95, .02);
    const tieMesh = new THREE.InstancedMesh(tieGeo, tieMat, 72);
    tieMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const dummy = new THREE.Object3D();
    let count = 0;
    for (let i = 0; i < 72; i++) {
      const t = .015 + i / 71 * .97;
      const p = curve.getPointAt(t);
      const prev = curve.getPointAt(Math.max(0, t - .002));
      const next = curve.getPointAt(Math.min(1, t + .002));
      const dx = (next.x - prev.x) * rectW, dy = (next.y - prev.y) * rectH;
      const len = Math.max(1, Math.hypot(dx, dy));
      const px = -dy / len, py = dx / len;
      const sx = p.x * rectW, sy = p.y * rectH;
      const a = screenToWorld(sx + px * gaugePx * 1.45, sy + py * gaugePx * 1.45, .025);
      const b = screenToWorld(sx - px * gaugePx * 1.45, sy - py * gaugePx * 1.45, .025);
      const tangentA = screenToWorld(sx + dx / len * 4, sy + dy / len * 4, .02);
      const tangentB = screenToWorld(sx - dx / len * 4, sy - dy / len * 4, .02);
      const axisX = b.x - a.x, axisZ = b.z - a.z;
      const tieWidth = Math.hypot(axisX, axisZ);
      const tieDepth = Math.max(.12, tangentA.distanceTo(tangentB));
      dummy.position.set((a.x + b.x) / 2, .08, (a.z + b.z) / 2);
      dummy.rotation.set(0, Math.atan2(-axisZ, axisX), 0);
      dummy.scale.set(tieWidth, .14, tieDepth);
      dummy.updateMatrix();
      tieMesh.setMatrixAt(count++, dummy.matrix);
    }
    tieMesh.count = count;
    worldRoot.add(tieMesh);

    // Dark ballast strip follows the exact same track path.
    const vertices = [], indices = [];
    const half = gaugePx * 2.25;
    for (let i = 0; i <= 80; i++) {
      const p = curve.getPoint(i / 80);
      const prev = curve.getPoint(Math.max(0, i / 80 - .003));
      const next = curve.getPoint(Math.min(1, i / 80 + .003));
      const dx = (next.x - prev.x) * rectW, dy = (next.y - prev.y) * rectH;
      const len = Math.max(1, Math.hypot(dx, dy));
      const px = -dy / len, py = dx / len;
      const sx = p.x * rectW, sy = p.y * rectH;
      const a = screenToWorld(sx + px * half, sy + py * half, .005);
      const b = screenToWorld(sx - px * half, sy - py * half, .005);
      vertices.push(a.x, .005, a.z, b.x, .005, b.z);
      if (i < 80) {
        const n = i * 2;
        indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
      }
    }
    const bedGeo = new THREE.BufferGeometry();
    bedGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    bedGeo.setIndex(indices);
    bedGeo.computeVertexNormals();
    mesh(bedGeo, standard(palette.rockEdge, 1, 0), worldRoot, 0, 0, 0);
  }

  function addObstacles(crystal, palette, rockGeo, rockMat, rockHighMat, woodMat, woodLightMat, metalMat, crystalMat, crystalMat2) {
    const layer = $('obstacleLayer');
    if (!layer) return;
    Array.from(layer.querySelectorAll('.field-obstacle')).forEach((node, idx) => {
      const left = parseFloat(node.style.left) || 0;
      const top = parseFloat(node.style.top) || 0;
      const width = parseFloat(node.style.width) || 10;
      const height = parseFloat(node.style.height) || 9;
      const p = screenFractionToWorld((left + width / 2) / 100, (top + height / 2) / 100, 0);
      const w = width / 100 * VIEW_H * rendererWidth / Math.max(1, rendererHeight);
      const d = height / 100 * VIEW_H / SIN_E;
      const group = new THREE.Group();
      group.position.set(p.x, 0, p.z);
      worldRoot.add(group);
      if (node.classList.contains('crystal')) {
        const base = mesh(new THREE.IcosahedronGeometry(.6, 0), rockMat, group, 0, .38, 0);
        base.scale.set(w * .42, .42, d * .25);
        for (let j = 0; j < 3; j++) {
          const gem = mesh(new THREE.OctahedronGeometry(.5, 0), j === 1 ? crystalMat2 : crystalMat,
            group, (j - 1) * w * .28, .64 + (j === 1 ? .35 : 0), (j - 1) * d * .11);
          gem.scale.set(w * .20, .8 + (j === 1 ? .45 : 0), d * .14);
          gem.rotation.set(rand(-.15, .15), rand(0, Math.PI), rand(-.18, .18));
        }
        // Crystal emissive material provides the glow without another per-obstacle light.
      } else if (node.classList.contains('crate')) {
        const box = mesh(new THREE.BoxGeometry(w * .78, .84, d * .62), woodMat, group, 0, .52, 0);
        box.rotation.y = rand(-.12, .12);
        for (let j = 0; j < 3; j++) {
          mesh(new THREE.BoxGeometry(w * .82, .10, d * .65), woodLightMat, group, 0, .25 + j * .27, d * .015);
        }
        mesh(new THREE.BoxGeometry(w * .83, .075, .08), metalMat, group, 0, .51, d * .33);
        const diagonal = mesh(new THREE.BoxGeometry(w * .9, .09, .08), woodLightMat, group, 0, .52, d * .34);
        diagonal.rotation.z = .5;
        [-1, 1].forEach((side) => {
          mesh(new THREE.BoxGeometry(.08, .95, .09), metalMat, group, side * w * .39, .52, d * .325);
        });
      } else {
        const rock = mesh(rockGeo, idx % 2 ? rockHighMat : rockMat, group, 0, .45, 0);
        rock.scale.set(Math.max(.48, w * .48), .58, Math.max(.55, d * .22));
        rock.rotation.set(rand(-.12, .12), rand(0, Math.PI), rand(-.08, .08));
        const cap = mesh(new THREE.DodecahedronGeometry(.35, 0), rockHighMat, group, -w * .18, .76, -d * .08);
        cap.scale.set(w * .35, .6, d * .13);
        if (crystal) {
          const shard = mesh(new THREE.OctahedronGeometry(.27, 0), crystalMat, group, w * .2, .93, .05);
          shard.scale.set(.35, .95, .33);
        }
      }
    });
  }

  function addDust(worldWidth, worldDepth, crystal) {
    const count = 90;
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = rand(-worldWidth * .48, worldWidth * .48);
      positions[i * 3 + 1] = rand(.35, 4.2);
      positions[i * 3 + 2] = rand(-worldDepth * .47, worldDepth * .47);
      phases[i] = rand(0, Math.PI * 2);
    }
    dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    dustPoints = new THREE.Points(dustGeometry, new THREE.PointsMaterial({
      color: crystal ? 0x9fc5ff : 0xffd2a0,
      size: .065, transparent: true, opacity: .54, depthWrite: false, sizeAttenuation: true
    }));
    dustPoints.userData.phases = phases;
    worldRoot.add(dustPoints);
  }

  function buildDecorativeCart(woodMat, woodLightMat, metalMat, oreMat, palette) {
    const cart = new THREE.Group();
    const base = mesh(new THREE.BoxGeometry(1.25, .18, .82), woodMat, cart, 0, .57, 0);
    const front = mesh(new THREE.BoxGeometry(1.25, .42, .12), woodLightMat, cart, 0, .82, .38);
    const back = mesh(new THREE.BoxGeometry(1.25, .42, .12), woodLightMat, cart, 0, .82, -.38);
    mesh(new THREE.BoxGeometry(.12, .42, .64), woodLightMat, cart, -.57, .82, 0);
    mesh(new THREE.BoxGeometry(.12, .42, .64), woodLightMat, cart, .57, .82, 0);
    [-.55, .55].forEach((x) => {
      const wheel = mesh(new THREE.CylinderGeometry(.22, .22, .13, 12), metalMat, cart, x, .31, 0);
      wheel.rotation.z = Math.PI / 2;
      mesh(new THREE.TorusGeometry(.17, .035, 6, 12), standard(0x3e302b, .6, .3), cart, x * 1.08, .31, 0).rotation.y = Math.PI / 2;
    });
    for (let i = 0; i < 7; i++) {
      const ore = mesh(new THREE.DodecahedronGeometry(rand(.17, .29), 0), oreMat, cart,
        rand(-.43, .43), rand(.94, 1.13), rand(-.22, .22));
      ore.scale.set(rand(.8, 1.3), rand(.7, 1.25), rand(.8, 1.2));
    }
    cart.userData.decorativeMineCart = true;
    cart.userData.pathT = .18;
    worldRoot.add(cart);
  }

  function makeNameSprite(name, accent) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 112;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(17,14,19,.92)';
    roundRect(ctx, 8, 8, 496, 96, 22);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,232,180,.45)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, 15, 15, 482, 82, 17);
    ctx.stroke();
    ctx.fillStyle = '#fff1cb';
    ctx.font = 'bold 43px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let text = String(name || 'Игрок').slice(0, 18);
    while (ctx.measureText(text).width > 448 && text.length > 3) text = text.slice(0, -1);
    ctx.fillText(text, 256, 57);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(clamp(.67 + text.length * .095, 1.55, 2.75), .52, 1);
    sprite.position.set(0, 3.56, 0);
    sprite.renderOrder = 15;
    return sprite;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function createMiner(index, name, accent) {
    const root = new THREE.Group();
    root.userData.playerIndex = index;
    const colorSet = [
      {jacket:0xe87432, trim:0xffca66, helmet:0xf8bd43, pants:0x245d65, skin:0xd99a6c},
      {jacket:0x2698c9, trim:0x77e6ff, helmet:0x42c8ef, pants:0x283d65, skin:0xe1ae85},
      {jacket:0xa45acb, trim:0xe4b2ff, helmet:0xd28af3, pants:0x424069, skin:0xd49b78},
      {jacket:0x54a845, trim:0xd8f28a, helmet:0xa5dd57, pants:0x315d43, skin:0xe2b48b}
    ];
    const p = colorSet[index % colorSet.length];
    const jacketMat = standard(p.jacket, .51, .03);
    const trimMat = standard(p.trim, .35, .08);
    const helmetMat = standard(p.helmet, .34, .16);
    const pantsMat = standard(p.pants, .68, .02);
    const skinMat = standard(p.skin, .72, 0);
    const bootMat = standard(0x302521, .82, .05);
    const metalMat = standard(0x9babb3, .34, .72);
    const lampMat = glowMaterial(0xffe9a4, 2.2);
    const shadow = makeShadow(root, 1.18, .64, .022);
    const legs = [];
    const arms = [];
    const legGeo = new THREE.CylinderGeometry(.15, .19, .65, 9);
    const armGeo = new THREE.CylinderGeometry(.12, .16, .58, 9);
    const handGeo = new THREE.SphereGeometry(.145, 10, 8);
    const bootGeo = new THREE.BoxGeometry(.4, .22, .56);

    for (let side = -1; side <= 1; side += 2) {
      const leg = new THREE.Group();
      leg.position.set(side * .23, 1.02, 0);
      root.add(leg);
      const shin = mesh(legGeo, pantsMat, leg, 0, -.32, 0);
      shin.rotation.x = .02;
      mesh(bootGeo, bootMat, leg, 0, -.70, .12);
      mesh(new THREE.BoxGeometry(.28, .035, .43), metalMat, leg, 0, -.59, .16);
      legs.push(leg);

      const arm = new THREE.Group();
      arm.position.set(side * .47, 2.13, .01);
      root.add(arm);
      mesh(armGeo, jacketMat, arm, 0, -.27, 0);
      mesh(handGeo, skinMat, arm, 0, -.58, .055);
      mesh(new THREE.SphereGeometry(.18, 8, 8), trimMat, arm, 0, -.035, 0);
      arms.push(arm);
    }

    const torso = new THREE.Group();
    torso.position.y = 1.57;
    root.add(torso);
    mesh(new THREE.CapsuleGeometry(.39, .65, 4, 10), jacketMat, torso, 0, .15, 0);
    mesh(new THREE.BoxGeometry(.55, .52, .075), trimMat, torso, 0, .19, .36);
    mesh(new THREE.BoxGeometry(.86, .12, .51), standard(0x493025, .7, .05), torso, 0, -.28, .015);
    mesh(new THREE.BoxGeometry(.2, .16, .07), metalMat, torso, 0, -.28, .29);
    // A visible leather mining satchel (warm brown with gold fittings, not a black blob).
    const satchelMat = standard(0x9c7042, .83, .02);
    mesh(new THREE.BoxGeometry(.34, .46, .16), satchelMat, torso, 0, .22, -.34);
    mesh(new THREE.BoxGeometry(.36, .055, .18), trimMat, torso, 0, .39, -.34);
    mesh(new THREE.BoxGeometry(.08, .34, .035), trimMat, torso, 0, .2, -.435);

    const neck = mesh(new THREE.CylinderGeometry(.15, .17, .25, 10), skinMat, torso, 0, .69, 0);
    const head = new THREE.Group();
    head.position.set(0, .93, .035);
    torso.add(head);
    mesh(new THREE.SphereGeometry(.34, 16, 12), skinMat, head, 0, .04, .01);
    // No dark hair-cap under the helmet: keep the forehead/helmet edge clean.
    // Simple face details remain legible even on a small phone screen.
    mesh(new THREE.SphereGeometry(.035, 8, 6), standard(0x2c211e, .55, 0), head, -.105, .045, .315);
    mesh(new THREE.SphereGeometry(.035, 8, 6), standard(0x2c211e, .55, 0), head, .105, .045, .315);
    mesh(new THREE.SphereGeometry(.055, 8, 6), skinMat, head, 0, -.045, .315);
    mesh(new THREE.TorusGeometry(.085, .012, 4, 12), standard(0x8c4839, .75, 0), head, 0, -.13, .302);

    // A smooth hard-hat dome without the dark horizontal brim that looked like a black stripe.
    const dome = mesh(new THREE.SphereGeometry(.38, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), helmetMat, head, 0, .31, 0);
    dome.scale.y = .9;
    mesh(new THREE.SphereGeometry(.105, 10, 8), lampMat, head, 0, .36, .34);
    // Helmet lamp stays emissive but does not add one expensive point light per player.
    const lamp = null;

    const nameSprite = makeNameSprite(name, accent);
    root.add(nameSprite);
    root.userData = Object.assign(root.userData, {
      index, name, accent, legs, arms, torso, head, nameSprite, lamp, shadow,
      lastX: 0, lastY: 0, positionReady: false
    });
    return root;
  }

  function createBomb() {
    bombRoot.clear();
    const cartMat = standard(0x88522d, .64, .08);
    const plankMat = standard(0xc18a4e, .49, .12);
    const blackMetal = standard(0x20242b, .32, .65);
    const darkRubber = standard(0x211d1d, .86, .02);
    const brass = standard(0xe3ad53, .28, .72);
    const flameMat = glowMaterial(0xffb338, 3.2);
    makeShadow(bombRoot, 1.8, 1.3, .025);
    mesh(new THREE.BoxGeometry(1.13, .2, .78), cartMat, bombRoot, 0, .44, 0);
    mesh(new THREE.BoxGeometry(1.18, .14, .08), plankMat, bombRoot, 0, .58, .36);
    mesh(new THREE.BoxGeometry(1.18, .14, .08), plankMat, bombRoot, 0, .58, -.36);
    [-1, 1].forEach((side) => {
      mesh(new THREE.BoxGeometry(.08, .22, .62), plankMat, bombRoot, side * .52, .48, 0);
      const wheel = mesh(new THREE.CylinderGeometry(.22, .22, .14, 14), darkRubber, bombRoot, side * .57, .28, 0);
      wheel.rotation.z = Math.PI / 2;
      const rim = mesh(new THREE.TorusGeometry(.155, .035, 6, 14), brass, bombRoot, side * .65, .28, 0);
      rim.rotation.y = Math.PI / 2;
      mesh(new THREE.SphereGeometry(.045, 8, 6), brass, bombRoot, side * .67, .28, 0);
    });
    const ball = mesh(new THREE.SphereGeometry(.43, 22, 16), blackMetal, bombRoot, 0, 1.02, 0);
    ball.scale.set(1.02, 1, 1.02);
    mesh(new THREE.TorusGeometry(.34, .035, 8, 24), brass, bombRoot, 0, 1.02, 0).rotation.x = Math.PI / 2;
    mesh(new THREE.TorusGeometry(.32, .028, 8, 24), standard(0x11151a, .35, .72), bombRoot, 0, 1.02, 0).rotation.z = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(.11, .15, .16, 10), cartMat, bombRoot, 0, 1.44, 0);
    const fuseCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(.02, 1.68, .015),
      new THREE.Vector3(.13, 1.74, .04), new THREE.Vector3(.17, 1.82, .045)
    ]);
    mesh(new THREE.TubeGeometry(fuseCurve, 12, .035, 6, false), standard(0xd9aa65, .82, 0), bombRoot, 0, 0, 0);
    const flame = mesh(new THREE.ConeGeometry(.11, .26, 8), flameMat, bombRoot, .17, 1.91, .045);
    flame.rotation.z = -.25;
    const flameCore = mesh(new THREE.SphereGeometry(.065, 8, 6), glowMaterial(0xfff5b5, 4), bombRoot, .16, 1.86, .045);
    const flameLight = new THREE.PointLight(0xff8b32, 4.5, 5, 2);
    flameLight.position.set(.16, 1.93, .05);
    bombRoot.add(flameLight);
    bombRoot.userData = { ball, flame, flameCore, flameLight, baseScale: 1 };
  }

  function ensureMiner(index, node) {
    const nameNode = node && node.querySelector('.character-name');
    const name = (nameNode ? nameNode.textContent : node.getAttribute('aria-label') || 'Игрок').trim().slice(0, 18) || 'Игрок';
    const accents = ['#ffd887', '#63dcff', '#d6a0ff', '#c5ef73'];
    let miner = miners.get(index);
    if (!miner || miner.userData.name !== name) {
      if (miner) {
        playerRoot.remove(miner);
        miners.delete(index);
      }
      miner = createMiner(index, name, accents[index % accents.length]);
      miners.set(index, miner);
      playerRoot.add(miner);
    }
    return miner;
  }

  function updateMiners(time, dt) {
    const nodes = [];
    const player = $('playerCharacter');
    if (player) nodes.push({ index: 0, node: player });
    const botLayer = $('botCharacters');
    if (botLayer) botLayer.querySelectorAll('.bot-character[data-player]').forEach((node) => {
      nodes.push({ index: Number(node.dataset.player), node });
    });
    const present = new Set();
    nodes.forEach(({ index, node }) => {
      if (!Number.isFinite(index)) return;
      present.add(index);
      const miner = ensureMiner(index, node);
      const anchor = screenPosition(node, 19);
      if (anchor) {
        const pos = screenToWorld(anchor.x, anchor.y, 0);
        const data = miner.userData;
        if (!data.positionReady || miner.position.distanceToSquared(pos) > 25) {
          miner.position.set(pos.x, 0, pos.z);
          data.positionReady = true;
        } else {
          // Smooth small screen-space movements instead of visibly stepping between frames.
          const alpha = 1 - Math.exp(-Math.max(.001, Math.min(.05, dt || .016)) * 34);
          miner.position.lerp(pos, alpha);
        }
        const deadSeat = arena.querySelector('.seat[data-player="' + index + '"].eliminated');
        miner.visible = !deadSeat;
      }
      const data = miner.userData;
      const walking = node.classList.contains('walking');
      const t = time * .009 + index * 1.7;
      const stride = walking ? Math.sin(t * 1.35) : Math.sin(t * .22) * .035;
      data.legs.forEach((leg, i) => {
        leg.rotation.x = walking ? Math.sin(t * 1.55 + i * Math.PI) * .52 : stride * .18;
      });
      data.arms.forEach((arm, i) => {
        arm.rotation.x = walking ? Math.sin(t * 1.55 + i * Math.PI + Math.PI) * .46 : -stride * .12;
        arm.rotation.z = i === 0 ? -.04 : .04;
      });
      data.torso.position.y = 1.57 + (walking ? Math.abs(Math.sin(t * 1.55)) * .055 : Math.sin(t * .45) * .025);
      data.head.rotation.z = walking ? Math.sin(t * .75) * .035 : Math.sin(t * .4) * .018;
      data.nameSprite.position.y = 3.58 + (walking ? Math.abs(Math.sin(t * 1.55)) * .055 : 0);
      const facing = node.classList.contains('facing-left');
      const targetYaw = facing ? -Math.PI / 2 : 0;
      let yawDelta = targetYaw - miner.rotation.y;
      while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
      miner.rotation.y += yawDelta * (1 - Math.exp(-Math.max(.001, dt || .016) * 20));
      const carrying = node.classList.contains('carrying');
      if (data.lamp) data.lamp.intensity = carrying ? 3.5 + Math.sin(time * .025) * .7 : 1.6;
      data.nameSprite.material.opacity = miner.visible ? 1 : .3;
    });
    miners.forEach((miner, index) => {
      if (!present.has(index)) {
        playerRoot.remove(miner);
        miners.delete(index);
      }
    });
  }

  function bombScreenPoint() {
    const bomb = $('bomb');
    if (!bomb) return null;
    const a = arena.getBoundingClientRect();
    const r = bomb.getBoundingClientRect();
    if (!a.width || !a.height) return null;
    return { x: r.left + r.width / 2 - a.left, y: r.top + r.height / 2 - a.top };
  }

  function emitTrail(position) {
    const material = new THREE.SpriteMaterial({
      map: glowTexture, color: 0xffbd5a, transparent: true, opacity: .82,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.set(.55, .55, 1);
    sprite.userData.age = 0;
    sprite.userData.life = .42;
    scene.add(sprite);
    trailSprites.push(sprite);
  }

  function updateBomb(time, dt) {
    const bomb = $('bomb');
    if (!bomb) return;
    const moving = bomb.classList.contains('moving');
    const urgent = bomb.classList.contains('urgent');
    const exploding = bomb.classList.contains('exploding');
    const flight = moving ? window.__allcoinsBombFlight : null;
    let point = null;
    let flightProgress = 0;
    if (flight) {
      flightProgress = clamp((time - flight.startedAt) / flight.duration, 0, 1);
      // Smoothstep timing plus a quadratic flight arc — no per-frame layout reads.
      const t = flightProgress * flightProgress * (3 - 2 * flightProgress);
      const u = 1 - t;
      point = {
        x: u * u * flight.startX + 2 * u * t * flight.controlX + t * t * flight.endX,
        y: u * u * flight.startY + 2 * u * t * flight.controlY + t * t * flight.endY
      };
      window.__allcoinsBombScreenPosition = point;
    } else {
      const mirrored = window.__allcoinsBombScreenPosition;
      point = mirrored && Number.isFinite(mirrored.x) && Number.isFinite(mirrored.y)
        ? mirrored : bombScreenPoint();
    }
    if (!point) return;
    const height = flight ? .45 + Math.sin(flightProgress * Math.PI) * 2.15
      : (moving ? 1.2 : .45);
    const p = screenToWorld(point.x, point.y, height);
    bombRoot.position.copy(p);
    bombRoot.visible = !exploding;
    bombShadow.position.set(p.x, .028, p.z - height * COS_E / SIN_E);
    bombShadow.visible = !exploding;
    bombRoot.scale.setScalar(urgent ? 1 + Math.sin(time * .045) * .07 : 1);
    bombRoot.rotation.y = flight ? flightProgress * Math.PI * 1.65 : 0;
    bombRoot.rotation.x = flight ? Math.sin(flightProgress * Math.PI) * .10 : 0;
    bombRoot.rotation.z = flight ? Math.sin(flightProgress * Math.PI) * .07 : 0;
    const ud = bombRoot.userData;
    if (ud.flame) {
      const flicker = .85 + Math.sin(time * .043) * .17 + Math.sin(time * .079) * .09;
      ud.flame.scale.set(1, flicker, 1);
      ud.flameCore.scale.setScalar(flicker);
      ud.flameLight.intensity = 3.7 + Math.sin(time * .04) * 1.1;
    }
    if (moving && time - lastTrailTime > 38) {
      emitTrail(p.clone().add(new THREE.Vector3(0, -.12, 0)));
      lastTrailTime = time;
    }
    lastBombScreen = point;
    trailSprites.forEach((sprite) => {
      sprite.userData.age += dt;
      const f = clamp(sprite.userData.age / sprite.userData.life, 0, 1);
      sprite.material.opacity = .78 * (1 - f);
      sprite.scale.setScalar(.42 * (1 - f) + .05);
    });
    for (let i = trailSprites.length - 1; i >= 0; i--) {
      if (trailSprites[i].userData.age >= trailSprites[i].userData.life) {
        scene.remove(trailSprites[i]);
        trailSprites[i].material.dispose();
        trailSprites.splice(i, 1);
      }
    }
  }

  function startExplosion() {
    if (explosionEffect) {
      scene.remove(explosionEffect.group);
      explosionEffect = null;
    }
    const mirrored = window.__allcoinsBombScreenPosition;
    const point = mirrored && Number.isFinite(mirrored.x) && Number.isFinite(mirrored.y)
      ? mirrored : (bombScreenPoint() || lastBombScreen || { x: rendererWidth / 2, y: rendererHeight / 2 });
    const origin = screenToWorld(point.x, point.y, .9);
    const group = new THREE.Group();
    group.position.copy(origin);
    scene.add(group);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffb53c, transparent: true, opacity: .95, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    const ring = mesh(new THREE.TorusGeometry(.5, .075, 8, 28), ringMat, group, 0, -.6, 0);
    ring.rotation.x = Math.PI / 2;
    const count = 38;
    const positions = new Float32Array(count * 3);
    const velocity = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = rand(-.15, .15);
      positions[i * 3 + 1] = rand(-.05, .25);
      positions[i * 3 + 2] = rand(-.15, .15);
      velocity[i * 3] = rand(-4.5, 4.5);
      velocity[i * 3 + 1] = rand(1.2, 5.5);
      velocity[i * 3 + 2] = rand(-4.5, 4.5);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({
      color: 0xffd078, size: .19, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }));
    group.add(points);
    const core = mesh(new THREE.SphereGeometry(.36, 12, 10), glowMaterial(0xff6a25, 3.4), group, 0, -.3, 0);
    const light = new THREE.PointLight(0xff7929, 12, 14, 2);
    light.position.set(0, .2, 0);
    group.add(light);
    explosionEffect = { group, ring, ringMat, points, geometry, velocity, core, light, age: 0 };
  }

  function updateExplosion(dt) {
    if (!explosionEffect) return;
    const e = explosionEffect;
    e.age += dt;
    const t = e.age;
    const pos = e.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const k = i * 3;
      pos.array[k] += e.velocity[k] * dt;
      pos.array[k + 1] += e.velocity[k + 1] * dt - 5.8 * dt * t;
      pos.array[k + 2] += e.velocity[k + 2] * dt;
    }
    pos.needsUpdate = true;
    const f = clamp(t / .9, 0, 1);
    e.ring.scale.setScalar(1 + t * 4.7);
    e.ringMat.opacity = 1 - f;
    e.points.material.opacity = 1 - f;
    e.core.scale.setScalar(Math.max(.001, 1.9 * (1 - t * 1.4)));
    e.light.intensity = Math.max(0, 13 * (1 - t * 2.2));
    if (t >= .9) {
      scene.remove(e.group);
      e.geometry.dispose();
      e.points.material.dispose();
      e.ring.geometry.dispose();
      e.ringMat.dispose();
      e.core.geometry.dispose();
      e.core.material.dispose();
      explosionEffect = null;
    }
  }

  function updateDecorativeCart(time) {
    if (!worldRoot || !sideCurve) return;
    const cart = worldRoot.children.find((o) => o.userData && o.userData.decorativeMineCart);
    if (!cart) return;
    const t = (time * .000025 + .17) % 1;
    const p = sideCurve.getPointAt(t);
    const screen = { x: p.x * rendererWidth, y: p.y * rendererHeight };
    const world = screenToWorld(screen.x, screen.y, 0);
    cart.position.set(world.x, .05, world.z);
    const next = sideCurve.getPointAt((t + .003) % 1);
    const dx = (next.x - p.x) * rendererWidth;
    const dy = (next.y - p.y) * rendererHeight;
    const a = screenToWorld(screen.x + dx, screen.y + dy, 0);
    cart.rotation.y = Math.atan2(-(a.z - world.z), a.x - world.x);
    cart.position.y = .05 + Math.sin(time * .004) * .025;
  }

  function resize(force) {
    if (!renderer || !arena) return;
    const rect = arena.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const changed = force || Math.abs(rect.width - rendererWidth) > 2 ||
      Math.abs(rect.height - rendererHeight) > 2;
    rendererWidth = rect.width;
    rendererHeight = rect.height;
    renderer.setSize(rendererWidth, rendererHeight, false);
    const aspect = rendererWidth / rendererHeight;
    camera.left = -VIEW_H * aspect / 2;
    camera.right = VIEW_H * aspect / 2;
    camera.top = VIEW_H / 2;
    camera.bottom = -VIEW_H / 2;
    camera.updateProjectionMatrix();
    if (changed || !worldRoot) rebuildWorld(true);
  }

  function loop(time) {
    frameId = 0;
    if (rendererFailed || !renderer || !scene || !camera) return;
    // Match the mobile display refresh more closely; capped just below 60 FPS.
    if (lastDrawAt && time - lastDrawAt < 16) {
      frameId = requestAnimationFrame(loop);
      return;
    }
    lastDrawAt = time;
    const rect = arena.getBoundingClientRect();
    if (document.hidden || rect.width < 10 || rect.height < 10) {
      setTimeout(() => { if (!frameId) frameId = requestAnimationFrame(loop); }, 160);
      return;
    }
    const dt = lastFrame ? Math.min(.045, Math.max(.001, (time - lastFrame) / 1000)) : .016;
    lastFrame = time;
    try {
      updateMiners(time, dt);
    } catch (error) {
      fallbackTo2D(error);
      return;
    }
    const bomb = $('bomb');
    const exploding = !!(bomb && bomb.classList.contains('exploding'));
    if (exploding && !previousExplosion) startExplosion();
    previousExplosion = exploding;
    updateBomb(time, dt);
    updateExplosion(dt);
    updateDecorativeCart(time);
    if (dustPoints && dustGeometry) {
      const attr = dustGeometry.attributes.position;
      const phases = dustPoints.userData.phases;
      for (let i = 0; i < attr.count; i++) {
        const k = i * 3;
        attr.array[k + 1] += Math.sin(time * .0008 + phases[i]) * .0008;
        attr.array[k] += Math.sin(time * .0004 + phases[i]) * .0007;
      }
      attr.needsUpdate = true;
    }
    try {
      renderer.render(scene, camera);
    } catch (error) {
      fallbackTo2D(error);
      return;
    }
    frameId = requestAnimationFrame(loop);
  }

  // Keep Three.js from loading if the page only has a setup panel in the background;
  // the scene wakes up automatically when the arena obtains real dimensions.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();