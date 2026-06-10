import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
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
  r2.addScaledVector(r1, -dot).normalize();
  
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

  // Iluminación suave y ambiental para tonos naturales
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  // Luz hemisférica para reflejos degradados metálicos
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
  scene.add(hemiLight);

  // Luz direccional principal desde arriba-derecha
  const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight1.position.set(2, 5, 3);
  scene.add(dirLight1);

  // Luz direccional frontal para asegurar brillos metálicos desde la cámara
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight2.position.set(-2, 2, 5);
  scene.add(dirLight2);

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

  // Generar el Logo 3D mediante código a partir de SVG (con color #4f46e5 y profundidad)
  const loadLogo = new Promise((resolve) => {
    try {
      const mySvg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="100mm"
   height="30.000002mm"
   viewBox="0 0 100 30.000002"
   version="1.1"
   id="svg1"
   xml:space="preserve">
  <g id="layer1">
    <path
       style="fill:#4f46e5;stroke:none;stroke-width:0.474709"
       d="m 23.432174,14.736751 h 2.246109 V 5.3162503 h 0.05615 l 1.079201,2.2060683 2.384926,4.7102484 0.871923,1.72908 0.414994,0.713825 0.751911,0.06128 h 1.853031 V 0.06939031 h -1.628423 l -0.559965,0.09559975 -0.05771,0.73912831 V 2.8716911 10.443865 C 29.63727,8.2479849 28.560523,5.9207945 27.489029,3.6467957 27.102283,2.8260202 26.707177,2.0048517 26.288161,1.2022355 26.12529,0.89026419 26.013659,0.47725618 25.792491,0.20758968 25.66196,0.04843629 25.466588,0.06978691 25.285212,0.06939031 24.83127,0.06839878 23.970522,-0.10790048 23.562329,0.10536671 23.340281,0.22138573 23.432174,0.74882224 23.432174,0.96374168 V 3.6467957 14.736751 M 35.392682,0.06939031 V 1.7984696 l 0.05771,0.6795046 0.953036,0.0956 h 2.807628 V 14.736751 h 2.246106 V 2.573574 H 44.4894 l 1.009191,-0.0956 0.05771,-0.6795046 V 0.06939031 H 35.392682 M 47.802407,14.736751 h 2.302252 V 2.573574 h 3.200696 c 0.438556,0 1.058532,-0.117744 1.459147,0.100662 0.856699,0.4670488 0.758206,2.4149896 0.518894,3.23825 -0.09936,0.3417859 -0.281772,0.6763154 -0.575046,0.8655518 -0.141007,0.090984 -0.401735,0.104745 -0.502995,0.2434164 -0.100377,0.13746 -0.0577,0.3984072 -0.05771,0.560487 -2.7e-5,0.5101211 -0.04017,1.0410953 0.0033,1.5490601 0.02995,0.3500135 0.39343,0.3567107 0.609143,0.5580485 0.244435,0.228147 0.378433,0.5496382 0.470107,0.8740632 0.362779,1.283886 0.152818,2.845192 0.152818,4.173638 h 2.246102 c 0,-1.691868 0.261833,-3.686884 -0.285836,-5.3064824 C 57.169063,8.9150547 56.850849,8.5553379 56.562217,8.1185517 57.181639,7.726768 57.411299,6.7983442 57.521324,6.0913563 57.795557,4.3291134 57.84545,1.7468486 56.281448,0.62743923 55.22376,-0.12958238 53.783725,0.06939031 52.575372,0.06939031 H 49.15007 c -0.296366,0 -1.018191,-0.14008082 -1.257626,0.06127919 -0.186407,0.15675884 -0.09004,0.72657687 -0.09004,0.9523191 V 3.7660422 14.736751 M 61.840555,0.0949225 c -0.969203,0.14776655 -1.640621,0.72544127 -1.852216,1.7631704 -0.187382,0.9190138 -0.05697,1.9834106 -0.05697,2.9215477 V 10.32462 c 0,1.092707 -0.203218,2.424759 0.363214,3.398534 0.377923,0.649695 1.031658,0.907496 1.714432,0.996531 1.038006,0.13536 2.154704,0.01706 3.200698,0.01706 0.891773,0 1.870185,0.119982 2.751478,-0.02617 0.898981,-0.149091 1.648617,-0.672674 1.900305,-1.643278 0.248635,-0.95883 0.121189,-2.053956 0.121189,-3.040794 V 4.4218999 c 0,-1.0630791 0.204134,-2.3933902 -0.352169,-3.3389113 C 69.225951,0.39537587 68.513291,0.15262068 67.792732,0.07951069 66.726132,-0.0287097 65.60755,0.06939034 64.53588,0.06939034 c -0.877978,0 -1.826052,-0.10699765 -2.695321,0.02553222 M 78.574024,0.06939031 V 2.573574 h 5.053736 c 0.671719,0 1.530185,-0.1461975 2.07175,0.3773845 0.524292,0.5068828 0.398965,1.3321746 0.398965,2.0075516 v 4.9487441 c 0,0.6793128 0.0949,1.5066518 -0.454467,1.9956378 -0.473067,0.421077 -1.100952,0.3893 -1.679334,0.3893 H 80.820128 V 6.1509789 h -2.246104 v 8.5857721 h 4.997584 c 1.141194,0 2.386072,0.0203 3.369156,-0.702001 2.089918,-1.535514 1.403811,-5.3265651 1.403811,-7.6452757 0,-0.8984325 0.08445,-1.8505799 -0.01604,-2.7426786 C 88.213528,2.625628 87.914792,1.5489348 87.109182,0.89813919 86.095949,0.07961999 84.788667,0.06939031 83.571612,0.06939031 H 78.574024 M 9.6186393,14.736751 V 12.292192 H 4.9579732 c -0.5910106,0 -1.4431616,0.166799 -1.9652969,-0.17855 C 2.3643111,11.698032 2.3190576,10.794349 2.3188028,10.086125 V 4.8988873 c 0,-0.7039523 -0.099396,-1.6253784 0.5076251,-2.0987341 C 3.3844555,2.3650048 4.2518891,2.5139506 4.9018211,2.5139506 H 9.6186393 V 0.12901364 H 4.5649056 c -1.1044292,0 -2.2666683,-0.03647124 -3.2006978,0.70121953 C 0.59646472,1.4365915 0.17693006,2.4663765 0.13101616,3.4679254 0.02197437,5.846585 -0.09359562,8.3679693 0.11932226,10.741983 c 0.11216584,1.250643 0.3245956,2.499082 1.35719564,3.292075 0.9588862,0.736389 2.1314647,0.702693 3.2568501,0.702693 H 9.6186435 M 11.9209,0.12901364 V 2.5139506 h 9.209026 V 0.12901364 H 11.9209 m 78.725938,0 V 2.5139506 h 9.265178 V 0.12901364 H 90.646834 M 62.682842,2.5335946 c 1.16067,-0.2228926 2.525661,-0.019644 3.706072,-0.019644 0.366749,0 0.995436,-0.1074675 1.249829,0.2520641 0.19854,0.2806055 0.09783,0.8467478 0.09783,1.178898 v 2.9811715 4.0543908 c 0,0.426393 0.114714,1.135718 -0.393328,1.28586 -0.369803,0.109287 -0.852823,0.02585 -1.235095,0.02585 h -2.583023 c -0.373729,0 -0.984803,0.124469 -1.234832,-0.251238 -0.217036,-0.326135 -0.112829,-0.920018 -0.112829,-1.298971 v -3.1004138 -3.8159 c 0,-0.5139322 -0.116402,-1.1726681 0.505375,-1.2920716 M 11.864743,14.736751 h 9.32133 V 12.292192 H 14.166999 V 8.5955397 h 4.211445 V 6.1509789 h -4.716818 c -0.381057,0 -1.404485,-0.1929994 -1.706848,0.061279 -0.141585,0.11907 -0.09002,0.4274563 -0.09003,0.5945791 V 8.3570469 14.736751 M 90.646839,6.1509789 v 8.5857721 h 9.265178 V 12.292192 H 92.892943 V 8.5955397 H 97.16054 V 6.9260848 c 0,-0.1861128 0.05872,-0.5234117 -0.05771,-0.6795067 -0.206382,-0.2766844 -1.308981,-0.095599 -1.62687,-0.095599 H 90.646834 M 0.40961295,18.075663 V 29.881099 H 2.2064966 V 25.52859 h 2.8637827 c 0.7262049,0 1.4297781,0.04035 2.0776459,-0.373062 C 8.579213,24.242226 8.5032747,21.432371 8.1374415,19.923989 8.0103219,19.399857 7.734592,18.918063 7.3163827,18.599669 6.5901089,18.04674 5.640911,18.075663 4.7895152,18.075663 H 0.40961295 m 9.77055205,0 v 11.805436 c 0.335804,0 1.523828,0.193101 1.739171,-0.09559 0.116432,-0.156093 0.05771,-0.493392 0.05771,-0.679505 v -1.84833 -7.214434 h 2.695325 c 0.373275,0 0.856898,-0.08928 1.176778,0.158168 0.885202,0.684769 0.59002,3.228802 -0.559099,3.419237 v 1.967573 c 0.548918,0.10557 0.787964,0.595054 0.89762,1.132846 0.207784,1.019076 0.113127,2.12347 0.113127,3.160039 h 1.740729 c 0,-1.50331 0.43472,-4.241275 -0.89844,-5.24686 1.332362,-1.445497 1.435506,-5.431829 -0.561528,-6.32749 -0.733236,-0.328852 -1.581992,-0.231085 -2.358408,-0.231085 h -4.042987 m 11.230519,0.02617 c -0.75004,0.125355 -1.289916,0.590221 -1.433711,1.404781 -0.372925,2.112511 -0.08241,4.531306 -0.08241,6.677824 0,0.905141 -0.133735,2.055668 0.33297,2.861049 0.36407,0.628267 0.951031,0.713866 1.576219,0.80128 1.443806,0.201879 3.339498,0.223877 4.77297,-0.05299 0.768803,-0.1485 1.276589,-0.76929 1.386958,-1.582139 0.09906,-0.729602 0.01687,-1.52877 0.01687,-2.26569 v -4.352507 c 0,-0.859904 0.183333,-1.983766 -0.279027,-2.742634 -0.321923,-0.528372 -0.896338,-0.728464 -1.461698,-0.769812 -0.927085,-0.0678 -1.878246,-0.0054 -2.807634,-0.0054 -0.657616,0 -1.371292,-0.08249 -2.02149,0.02617 M 29.88974,18.0756 v 1.967573 h 3.088394 v 9.837863 h 1.74073 v -9.837859 h 3.313002 v -1.967572 h -8.142122 m 11.511281,0.02618 c -0.77076,0.128865 -1.286371,0.645693 -1.42539,1.464403 -0.122873,0.723635 -0.03457,1.531482 -0.03457,2.26569 v 4.412134 c 0,0.853709 -0.178511,1.976699 0.251688,2.742676 0.365879,0.651455 0.951824,0.768371 1.60135,0.860031 0.750917,0.105975 1.545085,0.03432 2.302253,0.03432 0.815955,0 1.664425,0.06842 2.470714,-0.08732 0.755377,-0.145905 1.261155,-0.725365 1.387781,-1.522516 0.335513,-2.112201 0.07219,-4.476775 0.07219,-6.618199 0,-0.85098 0.163443,-1.986619 -0.288262,-2.742676 -0.326096,-0.545832 -0.870559,-0.764814 -1.452465,-0.824604 -0.901159,-0.09259 -1.846005,-0.01005 -2.75148,-0.01005 -0.693562,0 -1.448152,-0.08847 -2.1338,0.02618 m 8.535195,-0.02619 v 1.967574 h 3.03224 v 7.154809 1.848326 c 0,0.198426 -0.06598,0.5733 0.05771,0.739127 0.215346,0.288702 1.403369,0.09559 1.739175,0.09559 v -9.837863 h 3.25685 v -1.967573 h -8.085978 m 9.995164,0 V 29.88109 h 1.796881 V 18.075663 H 59.93139 m 3.649917,0 v 11.805436 h 1.796884 V 25.52859 h 2.919935 c 0.674743,0 1.358135,0.04756 1.96534,-0.325811 0.458114,-0.281701 0.76604,-0.703758 0.958707,-1.224399 0.233239,-0.63028 0.220498,-1.303536 0.220498,-1.967572 0,-1.219444 0.101726,-2.616565 -0.954592,-3.420159 -0.72194,-0.549205 -1.681531,-0.514986 -2.526867,-0.514986 h -4.379905 m 10.668995,0 -1.099389,4.114015 -2.101309,7.691421 h 1.684575 l 0.632972,-0.06127 0.241637,-0.713826 0.48155,-1.90795 1.203027,-4.710249 0.641512,-2.384937 c 0.703943,2.33755 1.384664,4.811421 1.853036,7.214434 h -1.740727 v 2.563806 h 4.716815 L 80.001519,26.840305 78.34094,20.639472 77.675601,18.075663 h -3.425307 m 7.80521,0 v 1.967573 h 4.042988 c 0.554,0 1.234725,-0.115425 1.68211,0.310861 0.446876,0.425801 0.339384,1.08111 0.339384,1.656711 v 3.99477 c 0,0.580987 0.08068,1.226454 -0.398315,1.636194 -0.382271,0.326997 -0.884116,0.271755 -1.342419,0.271755 h -2.583019 v -4.948743 h -1.740729 v 6.916315 h 3.930681 c 0.967242,0 2.044675,-0.01935 2.863784,-0.64325 0.623462,-0.47487 0.908973,-1.259909 1.010744,-2.039804 0.137402,-1.052922 0.05615,-2.157338 0.05615,-3.219665 0,-1.001076 0.08111,-2.047839 -0.04034,-3.040793 -0.100474,-0.821436 -0.314481,-1.682955 -0.971231,-2.210574 -0.808392,-0.649439 -1.839307,-0.65135 -2.806805,-0.65135 h -4.042988 m 11.230518,0.02618 c -0.774387,0.12942 -1.292964,0.634454 -1.433884,1.464404 -0.122088,0.719019 -0.02608,1.535778 -0.02608,2.265691 v 4.412133 c 0,0.856075 -0.176738,1.971336 0.245017,2.742676 0.342103,0.625672 0.929156,0.770502 1.551867,0.851704 1.474696,0.192308 3.365364,0.238052 4.829121,-0.04467 0.749234,-0.14472 1.26998,-0.7251 1.387179,-1.522516 0.312773,-2.12808 0.07279,-4.465318 0.07279,-6.618199 0,-0.89479 0.150663,-2.013853 -0.335011,-2.802256 -0.324947,-0.527484 -0.894465,-0.728319 -1.461873,-0.769812 -0.927078,-0.0678 -1.878245,-0.0054 -2.807631,-0.0054 -0.657613,0 -1.371294,-0.08249 -2.021492,0.02617 m -71.089185,1.899943 c 0.927996,-0.158979 1.979712,-0.01816 2.919936,-0.01816 0.324052,0 0.806758,-0.07433 1.025216,0.247097 0.17453,0.256798 0.09784,0.705898 0.09784,1.004995 v 2.325312 3.279288 c 0,0.349677 0.08096,0.938289 -0.337956,1.054269 -0.905599,0.250714 -2.149607,0.01896 -3.087353,0.01896 -0.301109,0 -0.814662,0.10521 -1.018721,-0.192488 C 21.619163,27.46327 21.691466,27.020776 21.691466,26.721 v -2.444561 -3.219664 c 0,-0.474211 -0.04877,-0.960115 0.505373,-1.055047 m 19.990326,0 c 0.94556,-0.162185 2.018016,-0.01816 2.976088,-0.01816 0.327598,0 0.821928,-0.06339 1.00919,0.301566 0.211526,0.412254 0.05771,1.262267 0.05771,1.725628 v 4.173642 c 0,0.441082 0.198431,1.562754 -0.337778,1.710126 -0.907305,0.249352 -2.148485,0.01896 -3.087527,0.01896 -0.303115,0 -0.802129,0.102915 -1.005728,-0.199386 -0.187547,-0.278475 -0.117326,-0.730808 -0.117326,-1.052706 v -2.384937 -3.219664 c 0,-0.467328 -0.03972,-0.961554 0.505375,-1.055046 m 51.884996,0 c 0.945552,-0.162183 2.018019,-0.01816 2.976088,-0.01816 0.327601,0 0.821928,-0.06339 1.009191,0.301564 0.211523,0.412259 0.05771,1.262263 0.05771,1.72563 v 4.17364 c 0,0.441078 0.198426,1.562754 -0.337779,1.710126 -0.907303,0.249353 -2.148487,0.01896 -3.087529,0.01896 -0.301656,0 -0.80627,0.105075 -1.010226,-0.192487 -0.181356,-0.264596 -0.112825,-0.692331 -0.112825,-0.999981 v -2.444505 -3.219664 c 0,-0.467322 -0.03972,-0.961554 0.505373,-1.055046 M 2.2064966,23.620669 v -3.577403 h 2.6953245 c 0.3641236,0 0.8546068,-0.09107 1.1783367,0.119805 0.7010263,0.45661 0.710583,2.860438 -0.00149,3.316457 -0.3524059,0.225662 -0.8387148,0.14115 -1.2329306,0.14115 H 2.2065688 m 63.1716692,0 v -3.577403 h 2.695323 c 0.364122,0 0.854614,-0.09107 1.178344,0.119805 0.722479,0.47059 0.718736,2.940107 -0.05551,3.356945 -0.352071,0.189548 -0.851818,0.100665 -1.235135,0.100665 z"
       id="path1"
       sodipodi:nodetypes="ccccccccccccccccssssssccccccccccccccccccsssssssscccscsssssscccssssssssssssscccssssssccccscsssscccsscsssccssssssccccccccccccssscsssssscsccccccccssccccccccccssscccccssssscccssccssccscccssccssssssssscscccccccccccsssssssssscscccccssccccccccccccccssssssccccccccccccccccccccssssssccccsssssssccsssssssssssccssscssssscsccsssssssscsccsssssssscscccsccscccssssc" /></g></svg>
`;

      const loader = new SVGLoader();
      const svgData = loader.parse(mySvg);
      const svgGroup = new THREE.Group();
      
      // Ajustes de extrusión
      const extrudeSettings = {
        depth: 4, // profundidad de extrusión en unidades del SVG
        bevelEnabled: true,
        bevelSegments: 4,
        steps: 1,
        bevelSize: 0.4,
        bevelThickness: 0.4
      };

      // Material standard con color azul oscuro marino metalizado brillante
      const material = new THREE.MeshStandardMaterial({
        color: 0x0A2540, // Azul oscuro marino
        roughness: 0.15, // Muy brillante
        metalness: 0.9,  // Metálico
        side: THREE.DoubleSide
      });

      svgData.paths.forEach((path) => {
        const shapes = SVGLoader.createShapes(path);
        shapes.forEach((shape) => {
          const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
          const mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          svgGroup.add(mesh);
        });
      });

      // Centrar el grupo del SVG
      const box = new THREE.Box3().setFromObject(svgGroup);
      const center = new THREE.Vector3();
      box.getCenter(center);
      svgGroup.children.forEach(child => {
        child.position.sub(center);
      });

      // Escalar el grupo para que tenga aprox 10 cm (0.10 metros)
      const size = new THREE.Vector3();
      box.getSize(size);
      const targetWidth = 0.10; // 10 cm
      const scaleFactor = targetWidth / size.x;
      
      // Invertimos el eje Y (-scaleFactor) para compensar la coordenada Y-down del SVG
      svgGroup.scale.set(scaleFactor, -scaleFactor, scaleFactor);

      resolve(svgGroup);
    } catch (err) {
      console.error("Error al extruir el SVG: ", err);
      // Fallback a cubo
      const geom = new THREE.BoxGeometry(0.04, 0.04, 0.04);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4f46e5 });
      resolve(new THREE.Mesh(geom, mat));
    }
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

  // Carga independiente y tolerante a fallos de los assets
  loadLogo.then((logo) => {
    logoMesh = logo;
    // Posicionar el logo de manera perpendicular directamente sobre el código QR
    // En el espacio del QR: Z es la normal (altura perpendicular), X e Y son el plano del QR.
    logoMesh.position.set(0, 0, 0.05);
    logoMesh.rotation.x = Math.PI / 2; // Perpendicular al plano QR (de pie)
    modelGroup.add(logoMesh);
    
    modelsLoaded = true;
    instructionText.textContent = "Apunta la cámara al código QR de Centro";
    console.log("Logo AR cargado con éxito.");
  }).catch((err) => {
    console.error("Error al cargar el logo: ", err);
    // Asegurar que modelsLoaded sea true incluso si hay error y se usa fallback
    modelsLoaded = true;
  });

  loadPersonaje.then((charData) => {
    if (!charData || !charData.model) return;
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

    // Guardar escala base para animaciones de squash & stretch
    personajeMesh.userData.baseScale = personajeMesh.scale.clone();

    // Posicionar personaje a 6 cm a la derecha del centro del QR
    // Debe estar de pie (rotación X = Math.PI / 2) y mirando al usuario (rotación Y = Math.PI)
    personajeMesh.position.set(0.06, 0, 0);
    personajeMesh.rotation.x = Math.PI / 2;
    personajeMesh.rotation.y = Math.PI;
    
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
    console.log("Personaje AR cargado de forma independiente.");
  }).catch((err) => {
    console.error("Error al cargar el personaje (no bloquea el logo): ", err);
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
    // Girar el logo 360 grados lentamente sobre el eje vertical normal (Z-axis en el espacio local del QR,
    // que corresponde a local Y después de rotar X por 90 grados en orden XYZ)
    if (logoMesh) {
      logoMesh.rotation.x = Math.PI / 2; // Asegurar orientación perpendicular
      logoMesh.rotation.y += 0.35 * delta; // Rotación lenta (360 grados en aprox 18 segundos)
      
      // Oscilación vertical suave sobre el QR (eje Z de la pose es perpendicular)
      const time = now * 0.0025;
      logoMesh.position.set(0, 0, 0.04 + Math.sin(time) * 0.012);
    }


    // Actualizar animación del personaje
    if (mixer) {
      mixer.update(delta);
    }

    // Animación del placeholder en caso de que falle la carga (Squash and Stretch)
    if (personajeMesh && personajeMesh.userData.animatePlaceholder) {
      const baseScale = personajeMesh.userData.baseScale || new THREE.Vector3(1, 1, 1);
      const time = now * 0.005;
      const squash = 1 + Math.sin(time) * 0.15;
      const stretch = 1 - Math.sin(time) * 0.08;
      personajeMesh.scale.set(baseScale.x * stretch, baseScale.y * squash, baseScale.z * stretch);
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
