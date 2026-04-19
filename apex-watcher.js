require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ── CONFIG ──
const SIGNAL_FILE = path.join(
  process.env.HOME,
  'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/apex_signal.json'
);
const BACKEND_URL = 'https://algolowyx-backend-production.up.railway.app/signal';
const CHECK_INTERVAL = 2000; // Revisar cada 2 segundos

let lastProcessedTime = '';

console.log('🟢 APEX Watcher iniciado');
console.log('📁 Vigilando:', SIGNAL_FILE);
console.log('📡 Backend:', BACKEND_URL);
console.log('⏳ Intervalo:', CHECK_INTERVAL / 1000, 'segundos\n');

async function checkAndSend() {
  try {
    // Verificar que el archivo existe
    if (!fs.existsSync(SIGNAL_FILE)) return;

    // Leer el archivo
    const raw = fs.readFileSync(SIGNAL_FILE, 'utf8').trim();
    if (!raw || raw.length < 10) return;

    // Parsear JSON
    let signal;
    try {
      signal = JSON.parse(raw);
    } catch(e) {
      return; // JSON inválido, esperar
    }

    // Verificar si es una señal nueva (por timestamp)
    const signalTime = signal.timestamp || '';
    if (signalTime === lastProcessedTime) return;
    if (signal.status) return; // Es el mensaje de inicio, no una señal

    // Es una señal nueva
    lastProcessedTime = signalTime;
    console.log('\n🔔 NUEVA SEÑAL DETECTADA:', new Date().toLocaleTimeString());
    console.log('   Precio:', signal.current_price);
    console.log('   Bias D1:', signal.bias_d1);
    console.log('   CHoCH:', signal.choch_direction);
    console.log('   Enviando al backend...');

    // Enviar al backend
    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signal)
    });

    if (!response.ok) {
      console.error('❌ Error del backend:', response.status);
      return;
    }

    const result = await response.json();
    console.log('\n✅ ANÁLISIS RECIBIDO:');
    console.log('   Dirección:', result.direction);
    console.log('   Score:', result.score + '/100');
    console.log('   Convicción:', result.conviction);
    console.log('   Entry:', result.entry);
    console.log('   SL:', result.sl);
    console.log('   TP1:', result.tp1);
    console.log('   TP2:', result.tp2);
    console.log('   RR TP1:', result.rr_tp1);
    console.log('   Narrativa:', result.narrative?.substring(0, 100) + '...');
    console.log('\n📊 Señal guardada en Supabase y visible en algolowyx.vercel.app\n');

  } catch(err) {
    if (err.code !== 'ENOENT') {
      console.error('Error en watcher:', err.message);
    }
  }
}

// Revisar cada 2 segundos
setInterval(checkAndSend, CHECK_INTERVAL);

// También verificar al inicio
checkAndSend();
