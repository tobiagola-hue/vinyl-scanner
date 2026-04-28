/*
  netlify/functions/groq.js
  Usa il modulo https nativo di Node â€” nessuna dipendenza esterna.
  Legge GROQ_API_KEY dalle env vars Netlify.
  Fallback: accetta groq_key nel body (uso locale / override manuale).
*/

'use strict';
const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function httpsPost(hostname, path, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch (e) { reject(new Error('JSON parse: ' + raw.slice(0, 120))); }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

const PROMPT = `Sei un esperto di dischi in vinile con 30 anni di esperienza nei mercatini.

Analizza questa immagine con MASSIMA attenzione. La foto e scattata a una bancarella: il disco puo essere inclinato, parzialmente coperto, sfocato o in cattiva luce.

USA TUTTI gli indizi visibili:
- SPINA DEL DISCO: testo verticale con artista, titolo, label, anno, catalog number
- ETICHETTA CENTRALE: logo label, catalog number, anno, manufactured by
- COPERTINA anche parziale: artwork, foto artista, testi visibili, colori
- Testi Made in paese, Printed in, Distributed by
- Numero catalogo: indizio fondamentale

REGOLA CRITICA ARTISTA:
- NON usare MAI Various Artists o AA.VV.: usa SEMPRE l artista principale reale
- Se il titolo e associato a un artista noto (I AM MUSIC = Playboi Carti), usa quell artista
- Se piu artisti: usa SOLO il PRIMO in ordine di menzione
- Per featuring: usa solo l artista principale
- Nome esatto come scritto sul disco

Per la PRESSATURA:
- Original press vs reissue (ristampe valgono molto meno)
- Made in Germany/UK/Japan = spesso originale di valore
- Made in EU/EEC = probabile ristampa
- Edizione limitata, numerata, colorata, picture disc = valore superiore

Rispondi SOLO con JSON valido, zero testo extra, zero markdown:
{"found":true,"confidence":"high/medium/low","confidence_reason":"max 12 parole","artist":"nome artista principale reale","album":"titolo esatto","year":"anno o null","label":"label o null","country_press":"paese o null","format":"LP/2xLP/7-inch/12-inch/etc","catalog_number":"catno o null","pressing_type":"Original/Reissue/Limited/Picture Disc/Colored/Unknown","genre":"genere","discogs_query":"artista album per Discogs","visible_clues":"cosa hai visto max 15 parole","collector_note":"nota collezionista o null"}
Se non identifichi nulla: {"found":false}`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON non valido' }) }; }

  const API_KEY = process.env.GROQ_API_KEY || body.groq_key || '';
  if (!API_KEY) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        found: false,
        error: 'GROQ_API_KEY non configurata. Aggiungila in Netlify: Site Settings > Environment Variables, poi fai Trigger deploy.',
      }),
    };
  }

  const { image_b64 } = body;
  if (!image_b64) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'image_b64 mancante' }) };

  try {
    const payload = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 800,
      temperature: 0.05,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image_b64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });

    const resp = await httpsPost(
      'api.groq.com',
      '/openai/v1/chat/completions',
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      payload
    );

    if (resp.body.error) {
      throw new Error('Groq: ' + (resp.body.error.message || JSON.stringify(resp.body.error)));
    }

    const raw = resp.body.choices[0].message.content
      .trim()
      .replace(/```(?:json)?/g, '')
      .replace(/```/g, '')
      .trim();

    JSON.parse(raw); // valida prima di restituire
    return { statusCode: 200, headers: CORS, body: raw };

  } catch (e) {
    console.error('groq.js error:', e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ found: false, error: e.message }) };
  }
};
