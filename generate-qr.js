import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

// Obtener la ruta del directorio actual
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// URL por defecto (se puede cambiar al dominio real de Vercel tras desplegar)
let targetUrl = 'https://app-centro-ar.vercel.app';

// Leer argumentos de la línea de comandos (ej: npm run generate-qr --url=https://mi-dominio.vercel.app)
const args = process.argv.slice(2);
const urlArg = args.find(arg => arg.startsWith('--url='));
if (urlArg) {
  targetUrl = urlArg.split('=')[1];
}

const outputPath = path.join(__dirname, 'qrcode.png');

const options = {
  errorCorrectionLevel: 'H', // Alta corrección de errores para mejor detección en AR
  type: 'image/png',
  quality: 0.95,
  margin: 4,
  scale: 10, // Generar un archivo de buena resolución (aprox 400x400px o superior)
  color: {
    dark: '#000000', // El QR debe ser oscuro sobre fondo claro para facilitar la detección de jsQR
    light: '#FFFFFF'
  }
};

console.log(`Generando código QR para la URL: \x1b[36m${targetUrl}\x1b[0m`);

QRCode.toFile(outputPath, targetUrl, options, (err) => {
  if (err) {
    console.error('Error al generar el código QR:', err);
    process.exit(1);
  }
  console.log(`\n\x1b[32m✔ Código QR generado con éxito en:\x1b[0m`);
  console.log(`  ${outputPath}\n`);
  console.log('Imprime este código QR en un tamaño aproximado de 10x10 cm o proyéctalo en otra pantalla para escanearlo con la aplicación.');
});
