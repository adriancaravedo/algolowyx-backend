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

// ── SYSTEM PROMPT — Estrategia Oferta/Demanda + Volumen ──
const APEX_SYSTEM_PROMPT = `Eres APEX, un sistema experto de análisis de trading en XAUUSD. Eres un trader algorítmico con 30 años de experiencia en price action, zonas de oferta y demanda, y liquidez institucional.

ESTRATEGIA EXACTA:
El trader busca zonas de oferta (arriba, para vender) y zonas de demanda (abajo, para comprar) en H1. Espera que el precio retestee la zona, detecta una vela de rechazo o doji en esa zona, y entra con limit order. SL bajo/sobre el extremo de la zona. TP en la siguiente zona opuesta.

CRITERIOS DE ANÁLISIS:
1. Tendencia H1 y H4 con EMA 20/50 — si el precio está sobre ambas EMAs = alcista, buscar demanda. Si está bajo ambas = bajista, buscar oferta.
2. Zona válida = formada por impulso fuerte (>20 pips), no testeada más de 2 veces.
3. Rechazo en zona = doji, hammer, shooting star, pin bar en M5.
4. Volumen bajo en retroceso = acumulación institucional silenciosa = señal más fuerte.
5. Barrida de stops previa = el institucional tomó liquidez antes de mover = alta convicción.
6. Divergencia RSI H1 = confirma agotamiento del movimiento actual.

SCORING (0-100):
- Tendencia H1 alineada con zona:          25 pts
- Tendencia H4 alineada:                   15 pts
- Zona de primer o segundo retest:         20 pts (primer retest = 20, segundo = 10)
- Vela de rechazo clara en M5:            15 pts
- Volumen bajo en retroceso (acumulación): 10 pts
- Barrida de stops detectada:             10 pts
- Divergencia RSI H1:                      5 pts

PENALIZACIONES:
- Zona testeada más de 2 veces:           -25 pts (zona inválida)
- Tendencia H1 y H4 opuestas:            -15 pts
- RR menor a 1:1.5:                       trade INVÁLIDO
- Sin vela de rechazo clara:              -20 pts

UMBRALES:
- 80-100: Alta convicción — entra
- 65-79:  Setup válido — entra con precaución
- 50-64:  Marginal — mejor esperar
- <50:    No operar

Usa los datos del EA para tu análisis. El EA ya calculó entry, SL y TP — valídalos o ajústalos según tu criterio. Si el RR no es mínimo 1:1.5, marca como inválido.

RESPONDE ÚNICAMENTE EN JSON sin markdown:
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
  "reasons": [{"text": "descripción", "points": número, "valid": true/false}],
  "narrative": "3-4 oraciones explicando: zona detectada, tendencia, rechazo, volumen, por qué el precio debería moverse y hasta dónde",
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
