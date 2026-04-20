require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ── CONFIG ──
const MT5_FILES   = path.join(process.env.HOME, 'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/');
const SIGNAL_FILE = MT5_FILES + 'apex_signal.json';
const PRICE_FILE  = MT5_FILES + 'apex_price.json';
const BACKEND_URL = 'https://algolowyx-backend-production.up.railway.app/signal';
const PRICE_URL   = 'https://algolowyx-backend-production.up.railway.app/price';
const CHECK_INTERVAL = 2000;

let lastProcessedTime = '';
let lastPriceTime = '';

console.log('🟢 APEX Watcher v2 iniciado');
console.log('📁 MT5 Files:', MT5_FILES);
console.log('📡 Backend:', BACKEND_URL);
console.log('💰 Precio cada 5s | Señales cada 2s\n');

// ── PRECIO REAL DESDE MT5 ──
async function checkAndSendPrice() {
  try {
    if (!fs.existsSync(PRICE_FILE)) return;
    const raw = fs.readFileSync(PRICE_FILE, 'utf8').trim();
    if (!raw) return;
    const price = JSON.parse(raw);
    if (!price.time || price.time === lastPriceTime) return;
    lastPriceTime = price.time;
    await fetch(PRICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(price)
    });
    process.stdout.write(`\r💰 XAUUSD: ${price.bid} | Spread: ${price.spread} pips | ${price.time}   `);
  } catch(e) {}
}

// ── SEÑALES DESDE MT5 ──
async function checkAndSend() {
  try {
    if (!fs.existsSync(SIGNAL_FILE)) return;
    const raw = fs.readFileSync(SIGNAL_FILE, 'utf8').trim();
    if (!raw || raw.length < 10) return;
    let signal;
    try { signal = JSON.parse(raw); } catch(e) { return; }
    const signalTime = signal.timestamp || '';
    if (signalTime === lastProcessedTime) return;
    if (signal.status) return; // mensaje de inicio, no señal
    lastProcessedTime = signalTime;

    console.log('\n\n🔔 NUEVA SEÑAL:', new Date().toLocaleTimeString());
    console.log('   Precio:', signal.current_price);
    console.log('   Bias D1:', signal.bias_d1);
    console.log('   CHoCH:', signal.choch_direction);
    console.log('   Entry calculado:', signal.entry_price);
    console.log('   Enviando a Claude...');

    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signal)
    });

    if (!response.ok) { console.error('❌ Backend error:', response.status); return; }
    const result = await response.json();

    console.log('\n✅ ANÁLISIS CLAUDE:');
    console.log('   Dirección:', result.direction, '| Score:', result.score + '/100', '|', result.conviction);
    console.log('   Entry:', result.entry, '| SL:', result.sl, '| TP1:', result.tp1, '| TP2:', result.tp2);
    console.log('   RR:', result.rr_tp1, '/', result.rr_tp2);
    console.log('   →', result.narrative?.substring(0, 100) + '...');
    console.log('\n📊 Visible en algolowyx.vercel.app\n');
  } catch(err) {
    if (err.code !== 'ENOENT') console.error('Error:', err.message);
  }
}

setInterval(checkAndSendPrice, 5000);
setInterval(checkAndSend, CHECK_INTERVAL);
checkAndSend();
checkAndSendPrice();
