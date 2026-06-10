import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import jsQR from 'jsqr';

// --- CONFIGURACIÓN Y CONSTANTES ---
const QR_SIZE_CM = 10; // Tamaño físico real del QR en centímetros
const QR_SIZE_M = QR_SIZE_CM / 100; // Convertido a metros (0.1m)
const MAX_FPS_DETECTION = 15; // Límite de FPS para el procesamiento de jsQR
const DETECTION_INTERVAL = 1000 / MAX_FPS_DETECTION;

// --- ELEMENTOS DEL DOM ---
const video = document.getElementById('camera-stream');
const canvas3D = document.getElementById('three-canvas');
const startOverlay = document.getElementById('start-overlay');
const errorOverlay = document.getElementById('error-overlay');
const errorMessage = document.getElementById('error-message');
const btnStart = document.getElementById('btn-start');
const httpWarning = document.getElementById('http-warning');
const arUiOverlay = document.getElementById('ar-ui-overlay');
const instructionText = document.getElementById('instruction-text');
const qrIndicator = document.getElementById('qr-indicator');
const debugPanel = document.getElementById('debug-panel');
const btnToggleDebug = document.getElementById('btn-toggle-debug');

// --- VARIABLES DE THREE.JS ---
let renderer, scene, camera, clock;
let qrAnchor; // Grupo contenedor que se alineará con el QR
let modelGroup; // Grupo interno para animaciones de aparición/desaparición
let mixer; // AnimationMixer para reproducir la animación del personaje
let logoMesh, personajeMesh; // Referencias a los modelos o placeholders

// --- ESTADOS DE LA APP ---
let modelsLoaded = false;
let isQRDetected = false;
let lastDetectedTime = 0;
let currentScale = 0; // Para animación de escala suave (0 a 1)
let lastDetectionTimestamp = 0;

// Variables de Depuración
const isDebugUrl = new URLSearchParams(window.location.search).get('debug') === 'true';
let debugCanvas = null;
let debugCtx = null;
let fpsCounter = 0;
let lastFpsTime = 0;
let currentFps = 0;

// --- PASO 3: DETECCIÓN Y RESOLVEDOR DE HOMOGRAFÍA ---
// Solucionador de sistema lineal A * h = B para una matriz 8x8 usando Eliminación Gaussiana con pivoteo parcial
function solve8x8(A, B) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    // Buscar el valor máximo en la columna actual para estabilidad numérica
    let maxEl = Math.abs(A[i][i]);
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > maxEl) {
        maxEl = Math.abs(A[k][i]);
        maxRow = k;
      }
    }
    // Intercambiar fila máxima con fila actual
    const tempRow = A[maxRow];
    A[maxRow] = A[i];
    A[i] = tempRow;
    
    const tempB = B[maxRow];
    B[maxRow] = B[i];
    B[i] = tempB;

    // Hacer 0 todas las celdas inferiores de la columna actual
    for (let k = i + 1; k < n; k++) {
      const c = -A[k][i] / A[i][i];
      for (let j = i; j < n; j++) {
        if (i === j) A[k][j] = 0;
        else A[k][j] += c * A[i][j];
      }
      B[k] += c * B[i];
    }
  }

  // Sustitución hacia atrás para obtener el vector de coeficientes
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) {
      sum += A[i][j] * x[j];
    }
    x[i] = (B[i] - sum) / A[i][i];
  }
  return x;
}

// Estima la posición y rotación del QR en el espacio 3D basándose en sus 4 esquinas 2D
function estimatePoseFromCorners(corners, videoWidth, videoHeight) {
  // 1. Obtener la distancia focal aproximada basándonos en un FOV estándar de ~60 grados
  const fovRad = (60 * Math.PI) / 180;
  const f = videoHeight / (2 * Math.tan(fovRad / 2));
  
  const cx = videoWidth / 2;
  const cy = videoHeight / 2;

  // 2. Normalizar las esquinas 2D respecto al centro óptico de la cámara e invertir el eje Y
  // jsQR retorna: 0: topLeft, 1: topRight, 2: bottomRight, 3: bottomLeft
  const normCorners = corners.map(p => ({
    x: (p.x - cx) / f,
    y: (cy - p.y) / f
  }));

  // 3. Coordenadas del QR en su espacio local 3D (el centro es (0,0,0) y mide QR_SIZE_M de lado)
  const d = QR_SIZE_M / 2;
  const objPoints = [
    { x: -d, y: d },  // topLeft
    { x: d,  y: d },  // topRight
    { x: d,  y: -d }, // bottomRight
    { x: -d, y: -d }  // bottomLeft
  ];

  // 4. Construir el sistema de ecuaciones A * h = B para resolver la Homografía
  const A = [];
  const B = [];
  for (let i = 0; i < 4; i++) {
    const x = objPoints[i].x;
    const y = objPoints[i].y;
    const u = normCorners[i].x;
    const v = normCorners[i].y;

    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    B.push(u);

    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    B.push(v);
  }

  // Resolver el sistema lineal de 8x8
  const h = solve8x8(A, B);

  // Reconstruir la matriz de Homografía H (con H33 = 1)
  const H = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1]
  ];

  // 5. Descomponer la Homografía en Rotación (R) y Traslación (T)
  const h1Norm = Math.sqrt(H[0][0]**2 + H[1][0]**2 + H[2][0]**2);
  const h2Norm = Math.sqrt(H[0][1]**2 + H[1][1]**2 + H[2][1]**2);
  const lambda = 2 / (h1Norm + h2Norm); // Factor de escala promedio

  // Columnas r1 y r2 del vector de rotación
  const r1 = new THREE.Vector3(H[0][0], H[1][0], H[2][0]).multiplyScalar(lambda);
  const r2 = new THREE.Vector3(H[0][1], H[1][1], H[2][1]).multiplyScalar(lambda);
  
  // Vector de traslación (T)
  const t = new THREE.Vector3(H[0][2], H[1][2], H[2][2]).multiplyScalar(lambda);

  // Asegurar ortogonalidad de la matriz de rotación
  r1.normalize();
  const dot = r1.dot(r2);
  r2.subScaledVector(r1, dot).normalize();
  
  // Calcular r3 mediante producto cruz r1 x r2
  const r3 = new THREE.Vector3().crossVectors(r1, r2).normalize();

  // 6. Construir matriz 4x4 de Three.js alineada al sistema de la cámara (Y-up, Z-back)
  // Invertimos las componentes de profundidad Z para proyectar en frente de la cámara (-Z)
  const matrix = new THREE.Matrix4();
  matrix.set(
     r1.x,  r2.x, -r3.x,  t.x,
     r1.y,  r2.y, -r3.y,  t.y,
    -r1.z, -r2.z,  r3.z, -t.z,
     0,     0,     0,     1
  );

  return matrix;
}

// Mapea coordenadas 2D del video al tamaño de pantalla del canvas de debug (debido al object-fit: cover)
function mapVideoToScreen(x, y, videoEl, canvasEl) {
  const vW = videoEl.videoWidth;
  const vH = videoEl.videoHeight;
  const cW = canvasEl.clientWidth;
  const cH = canvasEl.clientHeight;
  const vAspect = vW / vH;
  const cAspect = cW / cH;

  let scale, offsetX = 0, offsetY = 0;
  if (cAspect > vAspect) {
    scale = cW / vW;
    offsetY = (cH - vH * scale) / 2;
  } else {
    scale = cH / vH;
    offsetX = (cW - vW * scale) / 2;
  }

  return {
    x: x * scale + offsetX,
    y: y * scale + offsetY
  };
}

// --- CONFIGURACIÓN DE LA ESCENA 3D ---
function initThree() {
  // Crear escena con fondo transparente
  scene = new THREE.Scene();

  // Cámara perspectiva inicial (ajustada en el bucle principal según el tamaño del viewport)
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 0, 0); // La cámara física permanece en el origen
  
  // Renderizador WebGL
  renderer = new THREE.WebGLRenderer({
    canvas: canvas3D,
    alpha: true,
    antialias: true,
    precision: 'mediump'
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Iluminación suave
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(0, 5, 2);
  scene.add(dirLight);

  // Crear anclaje para el QR y el grupo animado
  qrAnchor = new THREE.Group();
  scene.add(qrAnchor);

  modelGroup = new THREE.Group();
  modelGroup.scale.set(0, 0, 0); // Inicia invisible/escalado a 0
  modelGroup.visible = false;
  qrAnchor.add(modelGroup);

  clock = new THREE.Clock();

  // Iniciar bucle de renderizado 3D a 60 FPS
  animate();
}

// --- CARGA DIFERIDA DE MODELOS (LAZY LOADING) ---
function loadARAssets() {
  if (modelsLoaded) return;
  
  instructionText.textContent = "Cargando modelos 3D...";
  
  const gltfLoader = new GLTFLoader();
  const fbxLoader = new FBXLoader();

  // Promesa para cargar el Logo GLB
  const loadLogo = new Promise((resolve) => {
    gltfLoader.load(
      '/models/logo.glb',
      (gltf) => {
        resolve(gltf.scene);
      },
      undefined,
      () => {
        console.warn("Fallo al cargar logo.glb. Creando placeholder.");
        // Crear un cubo rotatorio neon como placeholder premium
        const geom = new THREE.BoxGeometry(0.04, 0.04, 0.04);
        const mat = new THREE.MeshStandardMaterial({
          color: 0x00FFA3,
          roughness: 0.1,
          metalness: 0.8,
          transparent: true,
          opacity: 0.85
        });
        const mesh = new THREE.Mesh(geom, mat);
        
        // Agregar bordes wireframe brillantes
        const edges = new THREE.EdgesGeometry(geom);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x00ffcc, linewidth: 2 }));
        mesh.add(line);
        resolve(mesh);
      }
    );
  });

  // Promesa para cargar el Personaje (Intenta GLB primero, luego FBX de forma híbrida)
  const loadPersonaje = new Promise((resolve) => {
    gltfLoader.load(
      '/models/personaje.glb',
      (gltf) => {
        resolve({ model: gltf.scene, animations: gltf.animations });
      },
      undefined,
      () => {
        console.warn("No se encontró personaje.glb, intentando cargar Snatch.fbx...");
        fbxLoader.load(
          '/models/Snatch.fbx',
          (fbx) => {
            resolve({ model: fbx, animations: fbx.animations });
          },
          undefined,
          () => {
            console.error("Fallo al cargar personaje.glb y Snatch.fbx. Creando placeholder.");
            // Crear cilindro placeholder para simular crossfit
            const geom = new THREE.CylinderGeometry(0.015, 0.015, 0.09, 16);
            const mat = new THREE.MeshStandardMaterial({ color: 0x00B8FF, roughness: 0.3 });
            const mesh = new THREE.Mesh(geom, mat);
            resolve({ model: mesh, animations: [], isPlaceholder: true });
          }
        );
      }
    );
  });

  Promise.all([loadLogo, loadPersonaje]).then(([logo, charData]) => {
    logoMesh = logo;
    // Posicionar logo a 15 cm por encima del centro del QR
    logoMesh.position.set(0, 0.15, 0);
    modelGroup.add(logoMesh);

    personajeMesh = charData.model;
    
    // Auto-escalado del personaje a 12 cm de alto para que encaje correctamente
    const box = new THREE.Box3().setFromObject(personajeMesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const targetHeight = 0.12; // 12 cm
    
    if (size.y > 0) {
      const scale = targetHeight / size.y;
      personajeMesh.scale.set(scale, scale, scale);
    } else {
      personajeMesh.scale.set(0.001, 0.001, 0.001);
    }

    // Posicionar personaje a 5 cm a la derecha del centro del QR (en el plano Y=0)
    personajeMesh.position.set(0.05, 0, 0);
    
    // Configurar e iniciar animaciones si existen
    if (charData.animations && charData.animations.length > 0) {
      mixer = new THREE.AnimationMixer(personajeMesh);
      const action = mixer.clipAction(charData.animations[0]);
      action.play();
    } else if (charData.isPlaceholder) {
      // Si es un placeholder, le damos una animación de Squash & Stretch en el bucle principal
      personajeMesh.userData.animatePlaceholder = true;
    }

    modelGroup.add(personajeMesh);
    
    modelsLoaded = true;
    instructionText.textContent = "Apunta la cámara al código QR de Centro";
    console.log("Modelos AR cargados con éxito.");
  });
}

// --- PASO 1: INICIALIZACIÓN DE LA CÁMARA TRASERA ---
async function startCamera() {
  try {
    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    
    // Esperar a que el video comience a reproducirse para arrancar Three.js y jsQR
    video.onloadedmetadata = () => {
      video.play();
      initThree();
      requestAnimationFrame(detectionLoop);
      
      startOverlay.classList.add('hidden');
      arUiOverlay.classList.remove('hidden');
      
      // Iniciar carga de modelos en segundo plano al abrir la cámara
      loadARAssets();
    };

  } catch (err) {
    console.error("Error al iniciar cámara: ", err);
    startOverlay.classList.add('hidden');
    errorOverlay.classList.remove('hidden');
    errorMessage.textContent = "No se pudo acceder a la cámara. Asegúrate de dar los permisos y de estar navegando mediante HTTPS.";
  }
}

// --- PASO 2: BUCLE DE DETECCIÓN QR OPTIMIZADO (15 FPS MAX) ---
let detectionCanvas = null;
let detectionCtx = null;

function detectionLoop(timestamp) {
  requestAnimationFrame(detectionLoop);

  if (!video.videoWidth || video.paused) return;

  // Limitar el análisis de jsQR a 15 FPS para reducir la carga de CPU
  if (timestamp - lastDetectionTimestamp < DETECTION_INTERVAL) {
    return;
  }
  lastDetectionTimestamp = timestamp;

  // Inicializar canvas oculto para lectura de pixeles
  if (!detectionCanvas) {
    detectionCanvas = document.createElement('canvas');
    detectionCtx = detectionCanvas.getContext('2d', { willReadFrequently: true });
  }

  detectionCanvas.width = video.videoWidth;
  detectionCanvas.height = video.videoHeight;
  detectionCtx.drawImage(video, 0, 0, detectionCanvas.width, detectionCanvas.height);

  const imgData = detectionCtx.getImageData(0, 0, detectionCanvas.width, detectionCanvas.height);
  const code = jsQR(imgData.data, imgData.width, imgData.height, {
    inversionAttempts: "dontInvert"
  });

  // Cálculo de FPS del jsQR para depuración
  fpsCounter++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    currentFps = fpsCounter;
    fpsCounter = 0;
    lastFpsTime = now;
  }

  if (code) {
    isQRDetected = true;
    lastDetectedTime = now;

    // Calcular posición y orientación mediante homografía
    try {
      const corners = [
        code.location.topLeftCorner,
        code.location.topRightCorner,
        code.location.bottomRightCorner,
        code.location.bottomLeftCorner
      ];
      
      const poseMatrix = estimatePoseFromCorners(corners, imgData.width, imgData.height);
      
      // Aplicar matriz de transformación al anclaje
      qrAnchor.matrix.copy(poseMatrix);
      qrAnchor.matrix.decompose(qrAnchor.position, qrAnchor.quaternion, qrAnchor.scale);
    } catch (e) {
      console.warn("Error al calcular homografía: ", e);
    }

    // Dibujar recuadro de depuración si corresponde
    if (isDebugUrl && debugCtx && debugCanvas) {
      // Limpiar y redimensionar canvas debug
      debugCanvas.width = window.innerWidth;
      debugCanvas.height = window.innerHeight;
      debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);

      // Mapear coordenadas y dibujar líneas verdes
      const pts = [
        code.location.topLeftCorner,
        code.location.topRightCorner,
        code.location.bottomRightCorner,
        code.location.bottomLeftCorner
      ].map(p => mapVideoToScreen(p.x, p.y, video, debugCanvas));

      debugCtx.strokeStyle = "#00FFA3";
      debugCtx.lineWidth = 4;
      debugCtx.shadowBlur = 10;
      debugCtx.shadowColor = "#00FFA3";
      
      debugCtx.beginPath();
      debugCtx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        debugCtx.lineTo(pts[i].x, pts[i].y);
      }
      debugCtx.closePath();
      debugCtx.stroke();
    }
  } else {
    isQRDetected = false;
  }

  // Actualizar UI del panel de depuración
  if (isDebugUrl) {
    document.getElementById('debug-fps').textContent = currentFps;
    document.getElementById('debug-detected').textContent = (now - lastDetectedTime < 1000) ? 'Sí' : 'No';
    document.getElementById('debug-resolution').textContent = `${video.videoWidth} x ${video.videoHeight}`;
    if (now - lastDetectedTime < 1000) {
      document.getElementById('debug-pos').textContent = `X:${qrAnchor.position.x.toFixed(2)} Y:${qrAnchor.position.y.toFixed(2)} Z:${qrAnchor.position.z.toFixed(2)}`;
    } else {
      document.getElementById('debug-pos').textContent = "Fuera de rango";
    }
  }
}

// --- PASO 4 Y 5: RENDERIZADO 3D, ANIMACIÓN Y EFECTOS UX (60 FPS) ---
function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const now = performance.now();

  // Comprobar si el código se detectó en el último segundo (filtro de pérdida)
  const isCurrentlyTracking = (now - lastDetectedTime < 1000);

  if (isCurrentlyTracking && modelsLoaded) {
    instructionText.textContent = "Realidad Aumentada Activa";
    if (!instructionText.parentElement.classList.contains('detected')) {
      instructionText.parentElement.classList.add('detected');
      qrIndicator.classList.add('show');
    }
  } else if (modelsLoaded) {
    instructionText.textContent = "Apunta la cámara al código QR de Centro";
    if (instructionText.parentElement.classList.contains('detected')) {
      instructionText.parentElement.classList.remove('detected');
      qrIndicator.classList.remove('show');
    }
  }

  // Suavizado de la aparición/desaparición de los modelos (escala de 0 a 1)
  const targetScale = (isCurrentlyTracking && modelsLoaded) ? 1 : 0;
  
  if (currentScale !== targetScale) {
    // Interpolación lineal (lerp) para transición de escala en 0.5s
    currentScale += (targetScale - currentScale) * 8 * delta;
    if (Math.abs(currentScale - targetScale) < 0.005) {
      currentScale = targetScale;
    }
    modelGroup.scale.set(currentScale, currentScale, currentScale);
    modelGroup.visible = (currentScale > 0);
  }

  // Si los modelos son visibles, aplicar rotaciones y animaciones
  if (modelGroup.visible) {
    // Rotar logo a 1 RPM (360° en 60 segundos -> 0.1047 rad/s)
    if (logoMesh) {
      logoMesh.rotation.y += 0.1047 * delta;
    }

    // Actualizar animación del personaje
    if (mixer) {
      mixer.update(delta);
    }

    // Animación del placeholder en caso de que falle la carga (Squash and Stretch)
    if (personajeMesh && personajeMesh.userData.animatePlaceholder) {
      const time = now * 0.005;
      const squash = 1 + Math.sin(time) * 0.15;
      const stretch = 1 - Math.sin(time) * 0.08;
      personajeMesh.scale.set(0.001 * stretch, 0.001 * squash, 0.001 * stretch);
    }
  }

  // Ajustar cámara para que el FOV coincida perfectamente con el corte del video
  if (renderer && video.videoWidth) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    const aspectScr = width / height;
    const aspectVid = video.videoWidth / video.videoHeight;
    let computedFov = 60; // FOV vertical base del lente móvil

    if (aspectScr > aspectVid) {
      // El video se recorta en la parte superior e inferior por object-fit: cover
      const vFOVRad = (60 * Math.PI) / 180;
      const visibleHeightRatio = (height / video.videoHeight) / (width / video.videoWidth);
      computedFov = 2 * Math.atan(Math.tan(vFOVRad / 2) * visibleHeightRatio) * (180 / Math.PI);
    }

    if (camera.fov !== computedFov || camera.aspect !== aspectScr) {
      camera.fov = computedFov;
      camera.aspect = aspectScr;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }
  }

  if (renderer) {
    renderer.render(scene, camera);
  }
}

// --- CONFIGURACIÓN DE EVENTOS ---
window.addEventListener('resize', () => {
  if (renderer) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }
});

// Inicialización con validación HTTPS
btnStart.addEventListener('click', () => {
  // Comprobar HTTPS
  const isSecure = window.location.protocol === 'https:' || 
                   window.location.hostname === 'localhost' || 
                   window.location.hostname === '127.0.0.1';
  
  if (!isSecure) {
    httpWarning.classList.remove('hidden');
    return;
  }
  startCamera();
});

// Activar/desactivar panel de debug manual con botón flotante
btnToggleDebug.addEventListener('click', () => {
  debugPanel.classList.toggle('hidden');
});

// Comprobar HTTPS de antemano y mostrar advertencia no-bloqueante en local pero bloqueante en web
window.addEventListener('DOMContentLoaded', () => {
  const isSecure = window.location.protocol === 'https:' || 
                   window.location.hostname === 'localhost' || 
                   window.location.hostname === '127.0.0.1';
  if (!isSecure) {
    httpWarning.classList.remove('hidden');
  }
  
  // Si tiene debug=true en URL de entrada, activarlo por defecto
  if (isDebugUrl) {
    debugCanvas = document.createElement('canvas');
    debugCanvas.id = 'debug-canvas';
    debugCanvas.style.position = 'absolute';
    debugCanvas.style.top = '0';
    debugCanvas.style.left = '0';
    debugCanvas.style.width = '100%';
    debugCanvas.style.height = '100%';
    debugCanvas.style.zIndex = '3';
    debugCanvas.style.pointerEvents = 'none';
    document.body.appendChild(debugCanvas);
    debugCtx = debugCanvas.getContext('2d');
    
    debugPanel.classList.remove('hidden');
  }
});
