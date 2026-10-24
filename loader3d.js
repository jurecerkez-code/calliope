// Calliope loading screen: 4 chrome-glass sponsor logos (Jamie, Reson8, {Tech: Europe},
// Lyceum) rendered from the Blender studio scene (logos.blend), on glass tiles.
// Upgrades the CSS splash to real 3D when WebGL is available.
import * as THREE from 'three';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// recolor any logo to white, keeping alpha (works for dark or colored marks)
function whiteTexture(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  if (source instanceof HTMLCanvasElement) {
    x.drawImage(source, 0, 0, w, h);
  } else {
    x.drawImage(source, 0, 0, w, h);
  }
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function techeuropeCanvas() {
  const c = document.createElement('canvas');
  c.width = 1400; c.height = 360;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.font = "bold 148px 'Cascadia Mono','SF Mono',Consolas,monospace";
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('{Tech: Europe}', c.width / 2, c.height / 2);
  return c;
}

// keep the real chrome-glass render as-is (transparent background in the PNG)
function plainTexture(img) {
  const tex = new THREE.Texture(img);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}

export function start(canvas, finish) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    return; // CSS splash stays, the failsafe dismisses it
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
  camera.position.set(0, 0, 7.2);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;

  const key = new THREE.DirectionalLight(0xd9fff0, 1.3);
  key.position.set(-3, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x37ff8b, 1.0); // brand green rim
  rim.position.set(4, 2, -3);
  scene.add(rim);
  const spark = new THREE.PointLight(0xffffff, 20, 16, 2);
  spark.position.set(2, 3, 4);
  scene.add(spark);
  scene.add(new THREE.HemisphereLight(0xbfffe0, 0x04120a, 0.5));

  const tileGeo = new THREE.ExtrudeGeometry(roundedRect(2.15, 2.55, 0.32), {
    depth: 0.22,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 3,
    curveSegments: 14
  });
  const tileMat = new THREE.MeshPhysicalMaterial({
    color: 0x0e1614,
    metalness: 0.92,
    roughness: 0.12,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.6
  });

  Promise.all([
    loadImage('assets/render-jamiej.png'),
    loadImage('assets/render-reson8.png'),
    loadImage('assets/render-techeurope.png'),
    loadImage('assets/render-lyceum.png')
  ]).then(([jamieImg, reson8Img, techeuropeImg, lyceumImg]) => {
    const logos = [
      { tex: plainTexture(jamieImg), w: 1.15, h: 1.15 },
      { tex: plainTexture(reson8Img), w: 1.72, h: 1.72 * 304 / 1024 },
      { tex: plainTexture(techeuropeImg), w: 1.72, h: 1.72 * 225 / 1400 },
      { tex: plainTexture(lyceumImg), w: 1.72, h: 1.72 * 656 / 4352 }
    ];
    const groups = [];
    logos.forEach((L, i) => {
      const g = new THREE.Group();
      const tile = new THREE.Mesh(tileGeo, tileMat);
      g.add(tile);
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(L.w, L.h),
        new THREE.MeshBasicMaterial({ map: L.tex, transparent: true, toneMapped: false })
      );
      face.position.z = 0.185;
      g.add(face);
      g.position.x = (i - 1.5) * 2.35;
      scene.add(g);
      groups.push(g);
    });

    const loaderEl = document.getElementById('vd-loader');
    if (loaderEl) loaderEl.classList.add('vd-3d');
    const prog = document.getElementById('vdProg');
    if (prog) prog.style.width = '100%';

    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    resize();

    const clock = new THREE.Clock();
    const minTime = 5.5;
    function tick() {
      const t = clock.getElapsedTime();
      groups.forEach((g, i) => {
        const ph = i * 1.05;
        g.rotation.y = t * 2.2 + ph;
        g.rotation.x = Math.sin(t * 0.55 + ph) * 0.22;
        g.position.y = Math.sin(t * 1.1 + ph * 1.7) * 0.12;
        g.rotation.z = Math.sin(t * 0.4 + ph) * 0.06;
      });
      renderer.render(scene, camera);
      if (t >= minTime) {
        finish();
        return; // stop the loop once the app is revealed
      }
      requestAnimationFrame(tick);
    }
    tick();
  }).catch(() => { /* CSS splash stays, failsafe dismisses */ });
}
