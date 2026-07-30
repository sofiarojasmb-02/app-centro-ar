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

// Position constants: Logo (Sign) on the right floating; Proto on the left grounded
const LOGO_POS  = new THREE.Vector3(0.32, 0.52, -0.05);
const PROTO_POS = new THREE.Vector3(-0.18, 0.0, 0.08);

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
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
          color: 0x00FFA3
        });

        // Ratio 10:3 → 0.45 m × 0.135 m (escala adecuada para letrero)
        const geometry = new THREE.PlaneGeometry(0.45, 0.135);
        resolve(new THREE.Mesh(geometry, material));
      },
      undefined,
      (err) => {
        console.warn('Fallback logo (cubo neón):', err);
        const geom = new THREE.BoxGeometry(0.12, 0.12, 0.12);
        const mat  = new THREE.MeshStandardMaterial({ color: 0x00FFA3, roughness: 0.2 });
        resolve(new THREE.Mesh(geom, mat));
      }
    );
  });

  // ── Personaje (Prioridad: PROTO.glb -> Fallback: ROBOPROTO.fbx) ──
  const loadPersonaje = new Promise((resolve) => {
    gltfLoader.load(
      '/models/PROTO.glb',
      (gltf) => resolve({ model: gltf.scene, animations: gltf.animations }),
      undefined,
      (errGLTF) => {
        console.warn('[AR] PROTO.glb no disponible o falló. Intentando ROBOPROTO.fbx...', errGLTF);
        fbxLoader.load(
          '/models/ROBOPROTO.fbx',
          (fbx) => resolve({ model: fbx, animations: fbx.animations }),
          undefined,
          (errFBX) => {
            console.warn('[AR] No se pudo cargar ROBOPROTO.fbx. Usando placeholder.', errFBX);
            const geom = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 16);
            const mat  = new THREE.MeshStandardMaterial({ color: 0x00B8FF, roughness: 0.3 });
            resolve({ model: new THREE.Mesh(geom, mat), animations: [], isPlaceholder: true });
          }
        );
      }
    );
  });

  // ── Aplicar Logo ──────────────────────────────────────
  loadLogo.then((logo) => {
    logoMesh = logo;
    // Posición: Flotando en el lado derecho arriba
    logoMesh.position.copy(LOGO_POS);
    logoMesh.rotation.x = 0;
    modelGroup.add(logoMesh);

    createHologramLights();
    console.log('[AR] Letrero holográfico cargado ✓');
  }).catch(console.error);

  // ── Aplicar Personaje Proto ───────────────────────────
  loadPersonaje.then(({ model, animations, isPlaceholder }) => {
    if (!model) return;

    // Optimización de mallas y materiales del modelo de Proto
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        if (child.material) {
          if (child.material.isMeshStandardMaterial || child.material.isMeshPhysicalMaterial) {
            child.material.roughness = Math.min(child.material.roughness, 0.5);
            child.material.metalness = Math.max(child.material.metalness, 0.25);
            child.material.needsUpdate = true;
          } else if (child.material.isMeshBasicMaterial) {
            // Convertir materiales básicos a Standard para reaccionar a luces y sombras
            const prevMat = child.material;
            child.material = new THREE.MeshStandardMaterial({
              color: prevMat.color,
              map: prevMat.map || null,
              roughness: 0.45,
              metalness: 0.3
            });
          }
        }
      }

      // Buscar nodos de articulaciones para animación manual de respaldo
      const name = child.name.toLowerCase();
      if (child.name === 'Sphere.057' || name.includes('rightarm') || name.includes('brazoderecho')) {
        robotRightArm = child;
      }
      if (child.name === 'Sphere.106' || name.includes('leftarm') || name.includes('brazoizquierdo')) {
        robotLeftArm = child;
      }
    });

    // Auto-escalado a ≈ 0.65 m de alto en espacio MindAR
    const box  = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const targetHeight = 0.65;
    const scale = size.y > 0 ? targetHeight / size.y : 0.004;
    model.scale.set(scale, scale, scale);
    model.userData.baseScale = model.scale.clone();

    // Posicionamiento: Parado en el suelo (Y = -box.min.y * scale) a la izquierda de la escena (X = -0.18)
    const groundY = -box.min.y * scale;
    model.position.set(PROTO_POS.x, groundY, PROTO_POS.z);
    model.rotation.x = 0;
    model.rotation.y = -Math.PI / 6; // Mirada frontal-diagonal ligera hacia la cámara

    if (animations && animations.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(animations[0]).play();
    } else if (isPlaceholder) {
      model.userData.animatePlaceholder = true;
    }

    modelGroup.add(model);
    createGroundShadows(PROTO_POS.x, PROTO_POS.z);

    modelsLoaded = true;
    console.log('[AR] Modelo Proto optimizado con sombras cargado ✓');
  }).catch(console.error);
}

// ─────────────────────────────────────────────────────────────
//  SOMBRAS REALISTAS Y DE CONTACTO
// ─────────────────────────────────────────────────────────────
function createGroundShadows(protoX, protoZ) {
  // 1. Plano receptor de sombras realistas WebGL (ShadowMaterial)
  const shadowGeo = new THREE.PlaneGeometry(1.6, 1.6);
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.45 });
  const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.position.set(protoX, 0.001, protoZ);
  shadowMesh.receiveShadow = true;
  modelGroup.add(shadowMesh);

  // 2. Sombra de contacto suave (Canvas Texture con gradiente radial)
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.65)');
  grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.35)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  const contactTexture = new THREE.CanvasTexture(canvas);
  const contactGeo = new THREE.PlaneGeometry(0.55, 0.55);
  const contactMat = new THREE.MeshBasicMaterial({
    map: contactTexture,
    transparent: true,
    depthWrite: false,
    opacity: 0.75
  });
  const contactMesh = new THREE.Mesh(contactGeo, contactMat);
  contactMesh.rotation.x = -Math.PI / 2;
  contactMesh.position.set(protoX, 0.002, protoZ);
  modelGroup.add(contactMesh);
}

// ─────────────────────────────────────────────────────────────
//  LUCES Y HAZ DEL HOLOGRAMA
// ─────────────────────────────────────────────────────────────
function createHologramLights() {
  const lx = LOGO_POS.x;
  const ly = LOGO_POS.y;
  const lz = LOGO_POS.z;

  // Luz puntual neón detrás del holograma
  holoLight = new THREE.PointLight(0x00FFA3, 2.5, 1.2);
  holoLight.position.set(lx, ly, lz + 0.1);
  modelGroup.add(holoLight);

  // 4 esferas titilantes en las esquinas del letrero
  const dotGeo = new THREE.SphereGeometry(0.012, 8, 8);
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0x00FFA3,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending
  });

  const hw = 0.23; // half-width
  const hh = 0.07; // half-height
  const dotPositions = [
    [lx - hw, ly + hh, lz + 0.01],
    [lx + hw, ly + hh, lz + 0.01],
    [lx - hw, ly - hh, lz + 0.01],
    [lx + hw, ly - hh, lz + 0.01]
  ];

  dotPositions.forEach((pos) => {
    const dot = new THREE.Mesh(dotGeo, dotMat.clone());
    dot.position.set(...pos);
    modelGroup.add(dot);
    hologramDots.push(dot);
  });

  // Haz cónico en wireframe proyectado desde la base hacia el letrero
  const beamGeo = new THREE.CylinderGeometry(0.2, 0.01, ly, 16, 1, true);
  beamGeo.translate(0, ly / 2, 0); // elevar la geometría sobre su base

  const beamMat = new THREE.MeshBasicMaterial({
    color: 0x00FFA3,
    transparent: true,
    opacity: 0.12,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    wireframe: true
  });

  holoBeam = new THREE.Mesh(beamGeo, beamMat);
  holoBeam.position.set(lx, 0, lz);
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
    // Letrero Logo: flotación + balanceo suave + titileo neón
    if (logoMesh) {
      const t = now * 0.001;
      logoMesh.position.y = LOGO_POS.y + Math.sin(t * 2.5) * 0.012;
      logoMesh.rotation.y = Math.sin(t * 0.8) * 0.06;
      if (logoMesh.material) {
        logoMesh.material.opacity =
          0.70 + Math.sin(now * 0.04) * 0.1 + (Math.random() - 0.5) * 0.03;
      }
    }

    // Luz del holograma: titileo dinámico
    if (holoLight) {
      holoLight.intensity =
        Math.max(0.5, 1.8 + Math.sin(now * 0.02) * 0.7 + (Math.random() - 0.5) * 0.4);
    }

    // Haz holográfico: rotación y pulso
    if (holoBeam) {
      holoBeam.rotation.y += 0.25 * delta;
      holoBeam.material.opacity =
        0.06 + Math.sin(now * 0.03) * 0.04 + (Math.random() - 0.5) * 0.015;
    }

    // Puntos de esquinas: titileo independiente
    hologramDots.forEach((dot, i) => {
      const blink = 0.55 + Math.sin(now * 0.015 + i * 1.5) * 0.4 + (Math.random() - 0.5) * 0.1;
      dot.material.opacity = Math.max(0.1, Math.min(1.0, blink));
      const s = 0.75 + Math.sin(now * 0.015 + i * 1.5) * 0.3;
      dot.scale.set(s, s, s);
    });

    // Animación de Proto
    if (mixer) {
      mixer.update(delta);
    } else {
      // Saludo manual si no hay clips de animación
      if (robotRightArm) {
        const t = now * 0.004;
        robotRightArm.rotation.x = -1.2 + Math.sin(t * 1.5) * 0.1;
        robotRightArm.rotation.z = Math.sin(t * 2.5) * 0.3;
        robotRightArm.rotation.y = Math.cos(t * 1.5) * 0.15;
      }
      if (robotLeftArm) {
        const t = now * 0.001;
        robotLeftArm.rotation.z = Math.sin(t) * 0.05;
        robotLeftArm.rotation.x = Math.cos(t) * 0.03;
      }
    }
  }

  // Renderizar escena Three.js sobre el video de MindAR
  renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────
//  INICIALIZAR MINDAR Y AR CAMERA
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

    // ── Transparencia y Sombras en WebGLRenderer ────────────────
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // ── Iluminación Global y Sombras Directas ───────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const hemi = new THREE.HemisphereLight(0xffffff, 0x333338, 0.45);
    scene.add(hemi);

    const mainDir = new THREE.DirectionalLight(0xffffff, 1.25);
    mainDir.position.set(1.5, 3.5, 2.5);
    mainDir.castShadow = true;
    mainDir.shadow.mapSize.width = 1024;
    mainDir.shadow.mapSize.height = 1024;
    mainDir.shadow.camera.near = 0.1;
    mainDir.shadow.camera.far = 10;
    mainDir.shadow.camera.left = -1;
    mainDir.shadow.camera.right = 1;
    mainDir.shadow.camera.top = 1.5;
    mainDir.shadow.camera.bottom = -1;
    mainDir.shadow.bias = -0.0005;
    scene.add(mainDir);

    const fillDir = new THREE.DirectionalLight(0x00B8FF, 0.5);
    fillDir.position.set(-2, 2, -1);
    scene.add(fillDir);

    // ── Ancla al target #0 ─────────────────────────────────────
    const anchor = mindarThree.addAnchor(0);
    anchorGroup  = anchor.group;

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

