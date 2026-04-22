require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── CLIENTS ──
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ── SYSTEM PROMPT — Cazador de Liquidez ──
const APEX_SYSTEM_PROMPT = `Eres APEX, un sistema experto de análisis de trading con 30 años de experiencia. Analizas setups de "Cazador de Liquidez" — trampas institucionales que ocurren antes de los movimientos reales del mercado.

ESTRATEGIA QUE ANALIZAS:
El mercado se mueve para tomar liquidez (stops acumulados en highs/lows) antes del movimiento real. Los institucionales crean trampas: el precio supera un nivel de liquidez con una mecha, activa stops del retail, y luego revierte agresivamente. Tu trabajo es confirmar si la trampa detectada es real y calcular la probabilidad del movimiento.

DATOS QUE RECIBES DEL EA:
- zone_context: PREMIUM (precio arriba del rango → buscar ventas) o DESCUENTO (abajo → buscar compras)
- price_position: % de posición en el rango H1 de 20 velas
- trend_h1/h4: tendencia con EMA 20/50
- trap_direction: ALCISTA (trampa al alza → venta) o BAJISTA (trampa abajo → compra)
- trap_level: nivel de liquidez donde ocurrió la trampa
- confirmation_type: tipo de vela de confirmación (DOJI, VELA_BAJISTA, HAMMER, etc)
- volume_ok: true si trampa tuvo volumen alto y confirmación tuvo volumen bajo
- rsi_h1/m15: RSI en ambos timeframes
- entry_price, sl_price, tp1_price, tp2_price: niveles calculados por el EA

CRITERIOS DE SCORING (0-100):
Zona premium/descuento correcta:     20 pts
Tendencia H1 alineada:               18 pts
Tendencia H4 alineada:               12 pts
Trampa clara con mecha visible:      20 pts
Confirmación de vela válida:         15 pts
Volumen: alto en trampa, bajo en conf: 10 pts
RSI en zona extrema (>65 venta, <35 compra): 5 pts

PENALIZACIONES:
Tendencia H1 y H4 opuestas:         -15 pts
RSI neutro (45-55):                  -5 pts
RR menor a 1:2:                      trade INVÁLIDO

UMBRALES:
80-100: Alta convicción — entra
65-79:  Setup válido
50-64:  Marginal
<50:    No operar

Valida o ajusta los niveles del EA. Si el RR < 1:2 marca como inválido.

RESPONDE SOLO EN JSON sin markdown:
{
  "valid": true/false,
  "direction": "VENTA" o "COMPRA",
  "score": 0-100,
  "conviction": "ALTA CONVICCIÓN" o "SETUP VÁLIDO" o "SETUP MARGINAL" o "NO OPERAR",
  "entry": número,
  "sl": número,
  "tp1": número,
  "tp2": número,
  "sl_pips": número,
  "rr_tp1": "1:X.X",
  "rr_tp2": "1:X.X",
  "expiry_candles": 4,
  "reasons": [{"text": "descripción clara", "points": número, "valid": true/false}],
  "narrative": "3-4 oraciones: describe la trampa detectada, el contexto de zona premium/descuento, la confirmación, el volumen, y por qué el precio debería moverse hacia el TP",
  "warnings": [],
  "regime": "TENDENCIA" o "RANGO",
  "bias_d1": "BAJISTA" o "ALCISTA" o "NEUTRAL"
}`;

// ── ENDPOINT PRINCIPAL: ANALIZAR SETUP ──
app.post('/signal', async (req, res) => {
  try {
    const {
      pair = 'XAUUSD',
      timeframe = 'H1',
      current_price,
      bias_d1,
      structure_h4,
      structure_h1,
      liquidity_swept,
      liquidity_level,
      choch_confirmed,
      choch_direction,
      fvg_present,
      fvg_high,
      fvg_low,
      ob_level,
      zone_h4_high,
      zone_h4_low,
      zone_type,
      regime_h4,
      nearest_liquidity_above,
      nearest_liquidity_below,
      news_in_30min = false,
      news_description = '',
      session = 'LONDON-NY OVERLAP',
      candles_at_level = 0,
      previous_choch_count = 0
    } = req.body;

    // Validación básica
    if (!current_price) {
      return res.status(400).json({ error: 'current_price es requerido' });
    }

    // Construir contexto para Claude
    const userMessage = `Analiza este setup de trading en XAUUSD:

PAR: ${pair}
PRECIO ACTUAL: ${current_price}
SESIÓN: ${session}
TIMESTAMP: ${new Date().toISOString()}

CONTEXTO D1:
- Bias D1: ${bias_d1 || 'No especificado'}

CONTEXTO H4:
- Estructura H4: ${structure_h4 || 'No especificado'}
- Régimen H4: ${regime_h4 || 'No especificado'}
- Zona H4: ${zone_h4_high && zone_h4_low ? `${zone_type} entre ${zone_h4_low} y ${zone_h4_high}` : 'No especificada'}

CONTEXTO H1:
- Estructura H1: ${structure_h1 || 'No especificado'}
- Liquidez barrida: ${liquidity_swept ? `SÍ en ${liquidity_level}` : 'NO'}
- Número de velas en nivel: ${candles_at_level}
- CHoCH confirmado: ${choch_confirmed ? `SÍ — dirección ${choch_direction}` : 'NO'}
- CHoCHs previos post-barrida: ${previous_choch_count} (solo el primero es válido)

CONTEXTO M15:
- FVG presente: ${fvg_present ? `SÍ entre ${fvg_low} y ${fvg_high}` : 'NO'}
- OB level: ${ob_level || 'No identificado'}

LIQUIDEZ VISIBLE:
- Liquidez por encima: ${nearest_liquidity_above || 'No identificada'}
- Liquidez por debajo: ${nearest_liquidity_below || 'No identificada'}

NOTICIAS:
- Noticia alto impacto próximos 30min: ${news_in_30min ? `SÍ — ${news_description}` : 'NO'}

Analiza este setup según tu estrategia SMC/ICT y devuelve el JSON completo.`;

    // Llamar a Claude
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: APEX_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    // Parsear respuesta
    const rawText = message.content[0].text.trim();
    let analysis;
    try {
      analysis = JSON.parse(rawText);
    } catch (e) {
      // Limpiar si viene con backticks
      const clean = rawText.replace(/```json|```/g, '').trim();
      analysis = JSON.parse(clean);
    }

    // Construir respuesta final
    const signal = {
      id: `${pair}_${Date.now()}`,
      created_at: new Date().toISOString(),
      pair,
      timeframe,
      current_price,
      session,
      ...analysis
    };

    // Guardar en Supabase
    if (analysis.valid && analysis.score >= 55) {
      const { error: dbError } = await supabase
        .from('signals')
        .insert([{
          pair: signal.pair,
          direction: signal.direction,
          score: signal.score,
          conviction: signal.conviction,
          entry: signal.entry,
          sl: signal.sl,
          tp1: signal.tp1,
          tp2: signal.tp2,
          sl_pips: signal.sl_pips,
          rr_tp1: signal.rr_tp1,
          rr_tp2: signal.rr_tp2,
          narrative: signal.narrative,
          reasons: signal.reasons,
          warnings: signal.warnings,
          regime: signal.regime,
          bias_d1: signal.bias_d1,
          session,
          current_price,
          status: 'ACTIVE',
          action: null,
          created_at: signal.created_at
        }]);

      if (dbError) console.error('Supabase error:', dbError);
    }

    res.json(signal);

  } catch (err) {
    console.error('Error en /signal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ENDPOINT: ACTUALIZAR RESULTADO DE TRADE ──
app.patch('/signal/:id/action', async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'entered', 'skipped', 'tp1', 'tp2', 'sl'

    const { data, error } = await supabase
      .from('signals')
      .update({
        action,
        status: action === 'entered' ? 'ACTIVE' :
                action === 'skipped' ? 'SKIPPED' :
                action === 'tp1' ? 'TP1_HIT' :
                action === 'tp2' ? 'TP2_HIT' :
                action === 'sl' ? 'SL_HIT' : 'EXPIRED',
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ENDPOINT: OBTENER SEÑALES DEL DÍA ──
app.get('/signals/today', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .gte('created_at', today.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ENDPOINT: HISTORIAL COMPLETO ──
app.get('/signals/history', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    system: 'AlgoLowyx APEX',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ── PRECIO EN TIEMPO REAL DESDE EA ──
let currentPrice = { bid: 0, ask: 0, spread: 0, updated_at: null };

app.post('/price', (req, res) => {
  const { bid, ask, spread } = req.body;
  if (bid) {
    currentPrice = { bid: parseFloat(bid), ask: parseFloat(ask || bid), spread: parseFloat(spread || 0), updated_at: new Date().toISOString() };
  }
  res.json({ ok: true });
});

app.get('/price', (req, res) => {
  res.json(currentPrice);
});

// ── NOTICIAS — proxy ForexFactory para evitar CORS ──
let cachedNews = [];
let lastNewsFetch = 0;

app.get('/news', async (req, res) => {
  try {
    // Cache de 30 minutos
    if (Date.now() - lastNewsFetch < 1800000 && cachedNews.length > 0) {
      return res.json(cachedNews);
    }
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!r.ok) throw new Error('FF error');
    const all = await r.json();
    const now = new Date();
    cachedNews = all
      .filter(ev => ev.currency === 'USD' && ev.impact === 'High' && ev.date)
      .map(ev => ({
        title: ev.title,
        currency: ev.currency,
        impact: ev.impact,
        date: ev.date,
        forecast: ev.forecast || '—',
        previous: ev.previous || '—'
      }))
      .filter(ev => new Date(ev.date) > new Date(Date.now() - 3600000))
      .sort((a,b) => new Date(a.date) - new Date(b.date));
    lastNewsFetch = Date.now();
    res.json(cachedNews);
  } catch(e) {
    res.json(cachedNews.length ? cachedNews : []);
  }
});

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 AlgoLowyx APEX Backend corriendo en puerto ${PORT}`);
  console.log(`📡 Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`🤖 Claude API: configurado`);
  console.log(`⏰ ${new Date().toISOString()}\n`);
});

// Mantener vivo ante SIGTERM de Railway
process.on('SIGTERM', () => {
  console.log('SIGTERM recibido — manteniéndose vivo');
});

process.on('SIGINT', () => {
  console.log('SIGINT recibido — cerrando');
  process.exit(0);
});
