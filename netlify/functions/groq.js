/*
  netlify/functions/groq.js
  Proxy per Groq Vision API.
  Legge GROQ_API_KEY dalle env vars Netlify.
  Fallback: accetta la chiave nel body della richiesta (per uso locale).
*/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const PROMPT = `Sei un esperto di dischi in vinile con 30 anni di esperienza nei mercatini di tutto il mondo.

Analizza questa immagine con MASSIMA attenzione. La foto è scattata a una bancarella: il disco può essere inclinato, parzialmente coperto, sfocato o in cattiva luce.

USA TUTTI gli indizi visibili:
• SPINA DEL DISCO: testo verticale con artista, titolo, label, anno, catalog number
• ETICHETTA CENTRALE: logo label, catalog number, "℗ anno", "manufactured by"
• COPERTINA anche parziale: artwork, foto artista, testi visibili, colori
• Testi "Made in [paese]", "Printed in", "Distributed by", "A product of"
• Numero catalogo (es. "AT 50001", "MOT 123") — indizio fondamentale

REGOLA CRITICA — ARTISTA:
• NON usare MAI "Various Artists" o "AA.VV." come artista: cerca SEMPRE l'artista principale reale
• Se il titolo è associato a un artista noto, usa quell'artista (es. "I AM MUSIC" → Playboi Carti)
• Se è una compilation curata da qualcuno, usa il curatore o il nome della serie
• Se ci sono più artisti collaboratori, usa SOLO il PRIMO in ordine di menzione
• Per featuring, usa solo l'artista principale (no "feat.", no featuring)
• Nome esatto come scritto sul disco, senza abbreviazioni inventate

Per la PRESSATURA (cambia molto il valore):
• Original press vs reissue (ristampe valgono molto meno)
• "Made in Germany/UK/Japan" spesso = originale di valore
• "Made in EU/EEC" = probabile ristampa
• Edizione limitata, numerata, colorata, picture disc → valore superiore

Rispondi SOLO con JSON valido, zero testo extra, zero markdown:
{
  "found": true,
  "confidence": "high/medium/low",
  "confidence_reason": "perché sei sicuro o incerto (max 12 parole)",
  "artist": "nome artista principale reale (MAI Various Artists)",
  "album": "titolo esatto",
  "year": "anno o null",
  "label": "label discografica o null",
  "country_press": "paese fabbricazione o null",
  "format": "LP/2xLP/7-inch/12-inch/etc",
  "catalog_number": "numero catalogo o null",
  "pressing_type": "Original/Reissue/Limited/Picture Disc/Colored/Unknown",
  "genre": "genere musicale",
  "discogs_query": "artista + album per ricerca Discogs — usa il nome artista principale reale, mai Various Artists",
  "visible_clues": "cosa hai visto (max 15 parole)",
  "collector_note": "nota importante per collezionista o null"
}
Se non riesci a identificare nulla di specifico: {"found": false}`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON non valido' }) };
  }

  // Env var ha priorità; fallback al valore passato dal client (uso locale/sviluppo)
  const API_KEY = process.env.GROQ_API_KEY || body.groq_key;
  if (!API_KEY) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ found: false, error: 'GROQ_API_KEY non configurata. Aggiungila nelle env vars di Netlify oppure nel pannello impostazioni.' }),
    };
  }

  const { image_b64 } = body;
  if (!image_b64) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'image_b64 mancante' }) };
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + API_KEY,
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 800,
        temperature: 0.05,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image_b64 } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error('Groq: ' + data.error.message);

    const raw = data.choices[0].message.content
      .trim()
      .replace(/```(?:json)?/g, '')
      .replace(/```/g, '')
      .trim();

    // Validate it's parseable JSON before returning
    JSON.parse(raw);
    return { statusCode: 200, headers: CORS, body: raw };
  } catch (e) {
    console.error('Groq function error:', e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ found: false, error: e.message }) };
  }
};
