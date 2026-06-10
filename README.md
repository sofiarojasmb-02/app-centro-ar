# 🌌 Realidad Aumentada sobre Marcador QR (Three.js + jsQR)

Esta aplicación web de Realidad Aumentada (WebAR) proyecta un logo 3D giratorio y un personaje animado que realiza ejercicio, anclados sobre un código QR físico en tiempo real. 

La app corre directamente en el navegador móvil sin necesidad de instalar aplicaciones nativas. Está libre de librerías de pago (sin 8thWall, sin Zappar, sin Onirix) y utiliza tecnologías 100% de código abierto.

---

## 🛠️ Stack Tecnológico
- **Three.js (r158):** Para el motor gráfico 3D, luces y animación del personaje.
- **jsQR:** Para decodificar el frame de la cámara y obtener las coordenadas de las 4 esquinas del QR en tiempo real.
- **Homografía 3D (Descomposición en JS):** Resolvedor algebraico personalizado que calcula la traslación y rotación (Pose 3D) en base a las esquinas 2D sin requerir OpenCV.js.
- **Vite:** Como bundler y servidor de desarrollo.
- **Vercel:** Plataforma de despliegue estático HTTPS.

---

## 🚀 Cómo Probar Localmente en 5 Pasos

### Paso 1: Requisitos Previos
Asegúrate de tener instalado **Node.js (versión 18 o superior)**.

### Paso 2: Instalar Dependencias
Abre la consola en el directorio de la aplicación y ejecuta:
```bash
npm install
```

### Paso 3: Generar el Código QR de Prueba
Para generar el código QR de prueba local (que redirige al servidor de desarrollo local):
```bash
npm run generate-qr --url=https://localhost:3000
```
Esto creará un archivo `qrcode.png` en la raíz de la aplicación. Puedes imprimirlo o abrirlo en tu computadora para apuntar a él desde el móvil.

### Paso 4: Iniciar el Servidor de Desarrollo
Inicia Vite exponiendo el servidor en tu red local:
```bash
npm run dev
```
Esto levantará el servidor en un puerto (por ejemplo, `http://localhost:3000`) y también te mostrará tu IP local (por ejemplo, `http://192.168.1.15:3000`).

### Paso 5: Escanear en tu Celular
1. Conecta tu celular a la **misma red Wi-Fi** que tu computadora.
2. Abre el navegador móvil (Chrome en Android o Safari en iOS) e ingresa a la URL con tu IP local (`https://192.168.x.x:3000` o la que indique la terminal).
   * **Nota:** iOS requiere HTTPS para usar `getUserMedia`. Para hacer pruebas locales, puedes usar servicios como `ngrok` o configurar una redirección segura en tu navegador. Consulta la sección de *Troubleshooting* para más detalles.
3. Haz clic en **Iniciar Experiencia AR**, dale permiso a la cámara y apunta al código QR generado.

---

## 📦 Gestión de Modelos 3D

Los modelos 3D se ubican en la carpeta `public/models/`.

1. **Logo de la Empresa (`logo.glb`):**
   - El archivo original `Logo Centro 3D.glb` ya ha sido copiado automáticamente como `public/models/logo.glb`.
   - Se renderiza suspendido a **15 cm por encima del centro del QR** y gira a 1 RPM de forma continua.
   
2. **Personaje Ejercitándose (`personaje.glb` o `Snatch.fbx`):**
   - La aplicación implementa un cargador híbrido en `main.js`.
   - Si colocas un archivo `personaje.glb` en `public/models/`, el cargador lo cargará prioritariamente y reproducirá su primera animación en loop.
   - Si no existe `personaje.glb`, la aplicación cargará automáticamente el archivo original **`Snatch.fbx`** provisto en la misma carpeta, y reproducirá su animación en loop de manera interactiva.
   - El personaje se coloca **5 cm a la derecha del centro del QR** y se auto-escala a una altura de **12 cm** de forma dinámica, sin importar la escala original con la que se guardó el modelado.

---

## ⚡ Despliegue en Vercel con un Solo Clic

1. Sube tu carpeta del proyecto a un repositorio privado o público en **GitHub**.
2. Entra a tu panel de **Vercel** (https://vercel.com) y crea un nuevo proyecto haciendo clic en **Import**.
3. Selecciona tu repositorio recién subido.
4. En la configuración de construcción, Vercel detectará **Vite** automáticamente. Deja las configuraciones por defecto.
5. Haz clic en **Deploy**.
6. ¡Listo! Vercel te dará un dominio HTTPS automático (ej. `https://mi-proyecto-ar.vercel.app`).

### Regenerar el QR con tu Dominio de Vercel
Una vez desplegado en Vercel, ejecuta este comando en tu terminal local reemplazando con tu URL real para crear el código QR definitivo:
```bash
npm run generate-qr --url=https://tu-dominio.vercel.app
```

---

## 🔍 Depuración Visual (Debug Mode)

Puedes activar un panel detallado de telemetría y un recuadro verde brillante trazado en tiempo real sobre el QR.
- Simplemente abre la URL agregando el parámetro `?debug=true` al final:
  `https://tu-dominio.vercel.app/?debug=true`
- O presiona el botón de engranaje (⚙️) flotante en la esquina inferior derecha para abrir el panel de texto con lecturas de coordenadas y FPS de la CPU.

---

## 🛠️ Resolución de Problemas (Troubleshooting)

### 1. La cámara no se abre o da error "Acceso Denegado"
* **HTTPS Obligatorio:** Los navegadores modernos bloquean el acceso a la cámara mediante `getUserMedia` si no estás en un sitio HTTPS seguro. La única excepción es `localhost`. Si estás probando localmente desde el móvil con la IP local de tu computadora (ej: `192.168.1.15`), el navegador móvil bloqueará la cámara.
* **Solución para pruebas móviles en red local:**
  - **Android (Chrome):** Abre Chrome en el celular, ve a `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, añade la dirección IP de tu computadora (ej: `http://192.168.1.15:3000`), marca "Enabled" y reinicia Chrome.
  - **iOS / Safari:** Safari requiere HTTPS real. Lo más fácil es desplegar en Vercel (que provee HTTPS de forma automática) o usar un túnel seguro local como **ngrok** (`ngrok http 3000`).

### 2. El QR no se detecta
* **Calidad de Impresión:** Asegúrate de que el código QR esté nítido, plano (sin arrugas) y con buen contraste.
* **Margen Blanco:** El QR requiere un pequeño margen de fondo claro a su alrededor (ya incluido en el archivo generado por el script).
* **Condiciones de Luz:** Evita reflejos excesivos directamente sobre el papel o pantalla donde se proyecte el QR.

### 3. Los modelos no aparecen en pantalla tras detectar el QR
* **Fallas de Carga:** Si por alguna razón el archivo `.glb` o `.fbx` está corrupto, la app mostrará cubos interactivos de color verde neón (para el logo) y azul cian (para el personaje) para evitar que la experiencia falle silenciosamente.
* **Tamaño del Logo:** El logo original pesa 128 MB. En conexiones móviles puede tardar un tiempo en descargarse. Mientras tanto, se mostrará el mensaje "Cargando modelos 3D..." en la UI superior. Se recomienda optimizar el archivo mediante compresión Draco en producción.
