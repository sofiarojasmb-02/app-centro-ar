import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';

// ─────────────────────────────────────────────────────────────
//  ELEMENTOS DEL DOM
// ─────────────────────────────────────────────────────────────
const startOverlay    = document.getElementById('start-overlay');
const errorOverlay    = document.getElementById('error-overlay');
const errorMessage    = document.getElementById('error-message');
const btnStart        = document.getElementById('btn-start');
const httpWarning     = document.getElementById('http-warning');
const arUiOverlay     = document.getElementById('ar-ui-overlay');
const instructionText = document.getElementById('instruction-text');
const qrIndicator     = document.getElementById('qr-indicator');

// ─────────────────────────────────────────────────────────────
//  VARIABLES GLOBALES
// ─────────────────────────────────────────────────────────────
let mindarThree = null;
let renderer, scene, camera, clock;
let anchorGroup = null;      // Grupo anclado al target (todo se añade aquí)
let modelGroup  = null;      // Sub-grupo para animaciones de escala/aparición
let mixer       = null;      // AnimationMixer del personaje
let logoMesh    = null;
let holoLight   = null;
let hologramDots = [];
let holoBeam    = null;
let modelsLoaded = false;
let isTracking   = false;
let currentScale = 0;
let robotRightArm = null;
let robotLeftArm  = null;

// ─────────────────────────────────────────────────────────────
//  CARGA DE ASSETS AR
// ─────────────────────────────────────────────────────────────
function loadARAssets() {
  if (modelsLoaded) return;

  const gltfLoader = new GLTFLoader();
  const fbxLoader  = new FBXLoader();

  // ── Logo como holograma (SVG → textura plana aditiva) ──────
  const loadLogo = new Promise((resolve) => {
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      '/logocentro.svg',
      (texture) => {
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
          color: 0x00FFA3
        });

        // Ratio 10:3 → 0.18 m × 0.054 m (escala MindAR: 1 unidad ≈ ancho del target)
        const geometry = new THREE.PlaneGeometry(0.5, 0.15);
        resolve(new THREE.Mesh(geometry, material));
      },
      undefined,
      (err) => {
        console.warn('Fallback logo (cubo neón):', err);
        const geom = new THREE.BoxGeometry(0.1, 0.1, 0.1);
        const mat  = new THREE.MeshStandardMaterial({ color: 0x00FFA3 });
        resolve(new THREE.Mesh(geom, mat));
      }
    );
  });

  // ── Personaje FBX (ROBOPROTO) ──────────────────────────────
  const loadPersonaje = new Promise((resolve) => {
    fbxLoader.load(
      '/models/ROBOPROTO.fbx',
      (fbx) => resolve({ model: fbx, animations: fbx.animations }),
      undefined,
      (err) => {
        console.warn('No se encontró ROBOPROTO.fbx. Intentando PROTO.glb...', err);
        gltfLoader.load(
          '/models/PROTO.glb',
          (gltf) => resolve({ model: gltf.scene, animations: gltf.animations }),
          undefined,
          () => {
            console.warn('No se encontró personaje. Usando placeholder.');
            const geom = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 16);
            const mat  = new THREE.MeshStandardMaterial({ color: 0x00B8FF, roughness: 0.3 });
            resolve({ model: new THREE.Mesh(geom, mat), animations: [], isPlaceholder: true });
          }
        );
      }
    );
  });


  // ── Aplicar resultados ──────────────────────────────────────
  loadLogo.then((logo) => {
    logoMesh = logo;
    // Posición: al lado derecho del personaje, flotando a la altura de la cabeza
    // En espacio MindAR: X=0 es el centro del target, Y sube, Z profundidad
    logoMesh.position.set(0, 0.55, 0.05);   // a la derecha y arriba del target
    logoMesh.rotation.x = 0;                 // cara hacia la cámara (plano vertical)
    modelGroup.add(logoMesh);

    createHologramLights();
    modelsLoaded = true;
    console.log('[AR] Logo holográfico cargado ✓');
  }).catch(console.error);

  loadPersonaje.then(({ model, animations, isPlaceholder }) => {
    if (!model) return;

    // Auto-escalado a ≈ 0.7 m de alto en espacio MindAR
    const box  = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const targetHeight = 0.7;
    const scale = size.y > 0 ? targetHeight / size.y : 0.004;
    model.scale.set(scale, scale, scale);
    model.userData.baseScale = model.scale.clone();

    // Rotar para pararse perpendicular sobre el plano de la tarjeta AR (mirando al frente)
    model.rotation.x = Math.PI / 2;

    // Centrar justo delante del logo (Y = 0.55) y parado perpendicular al target (pies en Z = 0)
    const center = new THREE.Vector3();
    box.getCenter(center);
    model.position.set(0, 0.55, center.y * scale);

    // Buscar y referenciar los hombros del robot para animarlos
    console.log('[AR] ROBOPROTO model:', model);
    console.log('[AR] ROBOPROTO animations:', animations);
    model.traverse((child) => {
      const name = child.name.toLowerCase();
      if (name.includes('arm') || name.includes('shoulder') || name.includes('hand') || name.includes('brazo') || name.includes('hombro') || name.includes('mano') || name.includes('sphere')) {
        console.log(' - Match node:', child.name);
      }
      if (child.name === 'Sphere.057') {
        robotRightArm = child;
      }
      if (child.name === 'Sphere.106') {
        robotLeftArm = child;
      }
    });

    if (animations && animations.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(animations[0]).play();
    } else if (isPlaceholder) {
      model.userData.animatePlaceholder = true;
    }

    modelGroup.add(model);
    console.log('[AR] Personaje cargado ✓');
  }).catch(console.error);
}

// ─────────────────────────────────────────────────────────────
//  LUCES Y HAZ DEL HOLOGRAMA
// ─────────────────────────────────────────────────────────────
function createHologramLights() {
  // Luz puntual neón detrás del holograma
  holoLight = new THREE.PointLight(0x00FFA3, 2.5, 1.2);
  holoLight.position.set(0, 0.55, 0.15);
  modelGroup.add(holoLight);

  // 4 esferas titilantes en las esquinas del logo
  const dotGeo = new THREE.SphereGeometry(0.015, 8, 8);
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0x00FFA3,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending
  });

  const hw = 0.27; // half-width
  const hh = 0.08; // half-height
  const dotPositions = [
    [-hw,  hh + 0.55, 0.06],
    [ hw,  hh + 0.55, 0.06],
    [-hw, -hh + 0.55, 0.06],
    [ hw, -hh + 0.55, 0.06]
  ];

  dotPositions.forEach((pos) => {
    const dot = new THREE.Mesh(dotGeo, dotMat.clone());
    dot.position.set(...pos);
    modelGroup.add(dot);
    hologramDots.push(dot);
  });

  // Haz cónico en wireframe desde el suelo hasta el holograma
  const beamGeo = new THREE.CylinderGeometry(0.22, 0.01, 0.6, 16, 1, true);
  beamGeo.translate(0, 0.3, 0); // centrar verticalmente

  const beamMat = new THREE.MeshBasicMaterial({
    color: 0x00FFA3,
    transparent: true,
    opacity: 0.12,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    wireframe: true
  });

  holoBeam = new THREE.Mesh(beamGeo, beamMat);
  holoBeam.position.set(0, 0, 0);
  modelGroup.add(holoBeam);
}

// ─────────────────────────────────────────────────────────────
//  BUCLE DE ANIMACIÓN
// ─────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const now   = performance.now();

  // ── Suavizar aparición/desaparición con lerp de escala ─────
  const targetScale = isTracking ? 1 : 0;
  if (currentScale !== targetScale) {
    currentScale += (targetScale - currentScale) * 8 * delta;
    if (Math.abs(currentScale - targetScale) < 0.005) currentScale = targetScale;
    modelGroup.scale.set(currentScale, currentScale, currentScale);
    modelGroup.visible = currentScale > 0.01;
  }

  if (modelGroup.visible) {
    // Logo: flotación + balanceo + titileo
    if (logoMesh) {
      const t = now * 0.001;
      logoMesh.position.y = 0.55 + Math.sin(t * 2.5) * 0.012;
      logoMesh.rotation.y = Math.sin(t * 0.8)  * 0.07;
      if (logoMesh.material) {
        logoMesh.material.opacity =
          0.65 + Math.sin(now * 0.04) * 0.1 + (Math.random() - 0.5) * 0.03;
      }
    }

    // Luz del holograma: titileo
    if (holoLight) {
      holoLight.intensity =
        Math.max(0.5, 1.8 + Math.sin(now * 0.02) * 0.7 + (Math.random() - 0.5) * 0.4);
    }

    // Haz: rotación lenta + parpadeo
    if (holoBeam) {
      holoBeam.rotation.y += 0.25 * delta;
      holoBeam.material.opacity =
        0.06 + Math.sin(now * 0.03) * 0.04 + (Math.random() - 0.5) * 0.015;
    }

    // Puntos de las esquinas: titileo independiente
    hologramDots.forEach((dot, i) => {
      const blink = 0.55 + Math.sin(now * 0.015 + i * 1.5) * 0.4 + (Math.random() - 0.5) * 0.1;
      dot.material.opacity = Math.max(0.1, Math.min(1.0, blink));
      const s = 0.75 + Math.sin(now * 0.015 + i * 1.5) * 0.3;
      dot.scale.set(s, s, s);
    });

    // Animación del personaje
    if (mixer) {
      mixer.update(delta);
    } else {
      // Si el robot no tiene animación pregrabada (como PROTO.glb), lo animamos manualmente
      if (robotRightArm) {
        const t = now * 0.004;
        // Levantar el brazo hacia adelante/arriba y moverlo de lado a lado saludando
        robotRightArm.rotation.x = -1.2 + Math.sin(t * 1.5) * 0.1; // ángulo hacia el frente
        robotRightArm.rotation.z = Math.sin(t * 2.5) * 0.3;         // oscilación de saludo
        robotRightArm.rotation.y = Math.cos(t * 1.5) * 0.15;
      }
      if (robotLeftArm) {
        const t = now * 0.001;
        // Movimiento de respiración natural y sutil en el brazo izquierdo
        robotLeftArm.rotation.z = Math.sin(t) * 0.05;
        robotLeftArm.rotation.x = Math.cos(t) * 0.03;
      }
    }
  }

  // Renderizar con MindAR
  renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────
//  INICIALIZAR MINDAR
// ─────────────────────────────────────────────────────────────
async function startAR() {
  try {
    mindarThree = new MindARThree({
      container: document.body,
      imageTargetSrc: '/targets.mind',
      filterMinCF:     0.0001,
      filterBeta:      0.001,
      missTolerance:   5,
      warmupTolerance: 5
    });

    renderer = mindarThree.renderer;
    scene    = mindarThree.scene;
    camera   = mindarThree.camera;
    clock    = new THREE.Clock();

    // ── Iluminación global ──────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
    scene.add(hemi);
    const dir1 = new THREE.DirectionalLight(0xffffff, 1.0);
    dir1.position.set(2, 5, 3);
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.8);
    dir2.position.set(-2, 2, 5);
    scene.add(dir2);

    // ── Ancla al target #0 ─────────────────────────────────────
    const anchor = mindarThree.addAnchor(0);
    anchorGroup  = anchor.group;

    // modelGroup es el sub-grupo animable (escala 0→1 al detectar)
    modelGroup = new THREE.Group();
    modelGroup.scale.set(0, 0, 0);
    modelGroup.visible = false;
    anchorGroup.add(modelGroup);

    // Callbacks del target
    anchor.onTargetFound = () => {
      isTracking = true;
      instructionText.textContent = '¡Realidad Aumentada Activa! 🚀';
      instructionText.parentElement.classList.add('detected');
      qrIndicator.classList.add('show');
      if (!modelsLoaded) loadARAssets();
    };
    anchor.onTargetLost = () => {
      isTracking = false;
      instructionText.textContent = 'Apunta la cámara al afiche de Centro Madera';
      instructionText.parentElement.classList.remove('detected');
      qrIndicator.classList.remove('show');
    };

    // ── Ocultar pantalla de inicio, mostrar UI AR ───────────────
    startOverlay.classList.add('hidden');
    arUiOverlay.classList.remove('hidden');

    // ── Arrancar MindAR y el bucle de render ───────────────────
    await mindarThree.start();
    animate();

  } catch (err) {
    console.error('[AR] Error al iniciar MindAR:', err);
    startOverlay.classList.add('hidden');
    errorOverlay.classList.remove('hidden');
    errorMessage.textContent =
      'Error al iniciar la cámara. Asegúrate de dar permisos y usar HTTPS. (' + err.message + ')';
  }
}

// ─────────────────────────────────────────────────────────────
//  EVENTOS DE ARRANQUE
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const isSecure = location.protocol === 'https:' ||
                   location.hostname === 'localhost' ||
                   location.hostname === '127.0.0.1';
  if (!isSecure) {
    httpWarning.classList.remove('hidden');
  }
});

btnStart.addEventListener('click', () => {
  const isSecure = location.protocol === 'https:' ||
                   location.hostname === 'localhost' ||
                   location.hostname === '127.0.0.1';
  if (!isSecure) {
    httpWarning.classList.remove('hidden');
    return;
  }
  startAR();
});
