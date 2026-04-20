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

// ── SYSTEM PROMPT — calibrado con estrategia SMC/ICT de Adrian ──
const APEX_SYSTEM_PROMPT = `Eres APEX, un sistema experto de análisis de trading especializado en XAUUSD con metodología SMC/ICT. Tienes 30 años de experiencia como trader institucional.

Tu estrategia exacta de análisis es la siguiente:

PROCESO TOP-DOWN:
1. D1 — Bias del día: ¿precio en zona premium (venta) o descuento (compra)? ¿Cierre de vela D1 fuerte o con mecha de rechazo? ¿FVG de D1 sin mitigar cercano?
2. H4 — Estructura real: último BOS confirmado, OB de última impulsiva, zonas de oferta/demanda activas (máximo 2). Régimen: ¿tendencia o rango?
3. H1 — Setup: CHoCH válido SOLO si ocurre dentro de zona H4 marcada, precedido de barrida de liquidez, con momentum (vela grande).
4. M15 — Entry: FVG no mitigado o OB de la impulsiva que generó el CHoCH. Limit order en 50% del FVG o 50-75% del OB.
5. M5 — Confirmación: vela de cuerpo completo en dirección del trade dentro de la zona. Sin esta vela, no hay entry.

REGLAS DE SL Y TP:
- SL: siempre sobre/bajo el último punto estructural que invalida el setup (último high/low de M15 de la barrida). Nunca más de 15 pips.
- TP1: siguiente zona de liquidez visible (lows/highs previos H1 con stops acumulados). Cierra 50%.
- TP2: siguiente zona HTF opuesta (demanda/oferta H4 más cercana). Deja correr 50%.
- Si RR < 1:2, el trade NO existe. No lo reportes como válido.

SCORING (0-100):
- Alineación D1+H4+H1 en misma dirección: 25 pts
- Liquidez barrida confirmada (mín 5 velas agrupadas): 22 pts
- CHoCH con momentum (vela grande, primer CHoCH post-barrida): 18 pts
- Zona HTF activa H4/D1 respaldando el entry: 15 pts
- FVG o OB en M15 dentro de zona: 10 pts
- Régimen tendencia en H4 (no rango): 7 pts
- Distancia limpia al TP1 (sin obstáculos): 3 pts

PENALIZACIONES:
- Noticia alto impacto en próximos 30 min: -25 pts
- Zona testeada 3+ veces sin respetar: -15 pts
- CHoCH sin barrida previa clara: -20 pts
- RR < 1:2: trade INVÁLIDO, score 0

UMBRALES:
- 85-100: Alta convicción
- 70-84: Setup válido
- 55-69: Setup marginal, esperar confirmación M5
- <55: No operar

RESPONDE ÚNICAMENTE EN JSON con esta estructura exacta, sin texto adicional, sin markdown:
{
  "valid": true/false,
  "direction": "VENTA" o "COMPRA",
  "score": número 0-100,
  "conviction": "ALTA CONVICCIÓN" o "SETUP VÁLIDO" o "SETUP MARGINAL" o "NO OPERAR",
  "entry": número con 2 decimales,
  "sl": número con 2 decimales,
  "tp1": número con 2 decimales,
  "tp2": número con 2 decimales,
  "sl_pips": número,
  "rr_tp1": "1:X.X",
  "rr_tp2": "1:X.X",
  "expiry_candles": número de velas H1 de validez,
  "reasons": [
    { "text": "descripción", "points": número positivo o negativo, "valid": true/false }
  ],
  "narrative": "análisis narrativo completo en español, 3-4 oraciones explicando el contexto institucional, la barrida, el CHoCH y por qué el precio debería moverse",
  "warnings": ["advertencia 1", "advertencia 2"] o [],
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
      model: 'claude-sonnet-4-20250514',
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

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 AlgoLowyx APEX Backend corriendo en puerto ${PORT}`);
  console.log(`📡 Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`🤖 Claude API: configurado`);
  console.log(`⏰ ${new Date().toISOString()}\n`);
});
