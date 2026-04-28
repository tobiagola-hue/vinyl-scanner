/*
  netlify/functions/discogs.js
  Usa il modulo https nativo di Node — nessuna dipendenza esterna.
  Legge DISCOGS_TOKEN dalle env vars Netlify.
  Fallback: accetta discogs_token nel body (uso locale / override manuale).

  Endpoints usati:
  - GET /database/search         → trova release per artista+album+catno
  - GET /releases/{id}           → dettagli: label, country, year, community, num_for_sale, lowest_price
  - GET /marketplace/price_suggestions/{id} → mediane ufficiali per condizione (da vendite reali)
  - GET /marketplace/search?release_id={id} → annunci attivi per stats e chart
*/

'use strict';
const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const VG_UP = new Set(['Mint (M)', 'Near Mint (NM or M-)', 'Very Good Plus (VG+)', 'Very Good (VG)']);

// ── HTTP helpers ──────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'VinylScan/3.0 +netlify' } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode === 429) { reject(new Error('Discogs rate limit (429)')); return; }
        if (res.statusCode === 401) { reject(new Error('Discogs token non valido (401)')); return; }
        if (res.statusCode === 403) { reject(new Error('Discogs accesso negato (403)')); return; }
        try {
          const json = JSON.parse(raw);
          // Discogs a volte restituisce {message:...} con status 200 su errori
          if (json.message && !json.results && !json.id && !json.listings && !json.pagination) {
            reject(new Error('Discogs: ' + json.message));
            return;
          }
          resolve(json);
        } catch (e) {
          reject(new Error('JSON parse: ' + raw.slice(0, 80)));
        }
      });
    }).on('error', reject);
  });
}

function dGet(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.discogs.com${path}${sep}token=${token}`;
  return httpsGet(url);
}

// ── Math ──────────────────────────────────────────────────────
const r2 = (v) => Math.round(v * 100) / 100;
const calcMedian = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── Release scoring ───────────────────────────────────────────
function tokenSim(s1, s2) {
  const tok = (s) => new Set(
    (s || '').toLowerCase().split(/[\s\-_,\.\/\(\)\[\]]+/).filter((t) => t.length > 1)
  );
  const t1 = tok(s1), t2 = tok(s2);
  if (!t1.size || !t2.size) return 0;
  let n = 0;
  for (const t of t1) if (t2.has(t)) n++;
  return n / Math.max(t1.size, t2.size);
}

function scoreResult(r, targetArtist, targetAlbum, targetYear) {
  let score = 0;
  const full  = (r.title || '').toLowerCase();
  const tA    = (targetArtist || '').toLowerCase().trim();
  const tAl   = (targetAlbum  || '').toLowerCase().trim();

  // Discogs title format: "Artist - Album"
  const dash = full.indexOf(' - ');
  const rArtist = dash >= 0 ? full.slice(0, dash).trim() : '';
  const rAlbum  = dash >= 0 ? full.slice(dash + 3).trim() : full;

  // Artist match
  if (tA) {
    if (rArtist === tA)                        score += 6;
    else if (rArtist.includes(tA) || tA.includes(rArtist)) score += 4;
    else if (tokenSim(rArtist, tA) > 0.6)     score += 3;
    else if (tokenSim(rArtist, tA) > 0.3)     score += 1;
  }

  // Album match
  if (tAl) {
    if (rAlbum === tAl)                        score += 6;
    else if (rAlbum.includes(tAl) || tAl.includes(rAlbum)) score += 4;
    else if (tokenSim(rAlbum, tAl) > 0.6)     score += 3;
    else if (tokenSim(rAlbum, tAl) > 0.3)     score += 1;
  }

  // Format bonus
  const fmt = (r.format || []).join(' ').toLowerCase();
  if (fmt.includes('lp') || fmt.includes('album')) score += 1;
  if (fmt.includes('33') || fmt.includes('12'))     score += 1;

  // Year bonus
  if (targetYear && r.year) {
    const diff = Math.abs(Number(r.year) - Number(targetYear));
    if (diff === 0)  score += 2;
    else if (diff <= 2) score += 1;
  }

  return score;
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON non valido' }) }; }

  const TOKEN = process.env.DISCOGS_TOKEN || body.discogs_token || '';
  if (!TOKEN) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        error: 'DISCOGS_TOKEN non configurato. Aggiungilo in Netlify: Site Settings > Environment Variables, poi fai Trigger deploy.',
      }),
    };
  }

  const { query, artist, album, catalog_number, year } = body;
  const enc = (s) => encodeURIComponent((s || '').toString().trim());

  try {
    // ══ STEP 1: trova la release migliore ═════════════════════
    let bestRelease = null;
    let bestScore   = -1;

    const strategies = [];

    // Catalog number è il più preciso → priorità assoluta
    if (catalog_number && String(catalog_number) !== 'null' && String(catalog_number).length > 2) {
      strategies.push(`/database/search?catno=${enc(catalog_number)}&type=release&per_page=5`);
    }

    // Ricerca strutturata artista + titolo
    if (artist && album) {
      strategies.push(
        `/database/search?artist=${enc(artist)}&release_title=${enc(album)}&type=release&format=vinyl&per_page=10`
      );
    }

    // Query libera da Groq
    if (query) {
      strategies.push(`/database/search?q=${enc(query)}&type=release&format=vinyl&per_page=10`);
    }

    // Fallback: testo libero senza filtro formato
    if (artist && album) {
      strategies.push(`/database/search?q=${enc(artist + ' ' + album)}&type=release&per_page=15`);
    }

    for (const path of strategies) {
      try {
        const data    = await dGet(path, TOKEN);
        const results = (data.results || []).slice(0, 12);

        for (const r of results) {
          const s = scoreResult(r, artist, album, year);
          if (s > bestScore) { bestScore = s; bestRelease = r; }
        }

        if (bestScore >= 8) break; // trovato con alta confidenza
      } catch (e) {
        console.warn('Strategy failed:', path.split('?')[0], e.message);
      }
    }

    if (!bestRelease) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ error: 'Release non trovata su Discogs. Prova a scansionare con il testo del disco più visibile.' }),
      };
    }

    const releaseId = bestRelease.id;

    // ══ STEP 2: dettagli release ══════════════════════════════
    let rd = {};
    try {
      rd = await dGet(`/releases/${releaseId}`, TOKEN);
    } catch (e) {
      console.warn('Release details failed:', e.message);
    }

    // ══ STEP 3: mediane ufficiali Discogs (da vendite reali) ══
    let medVG = null, medVGP = null, medNM = null, medM = null, medCur = 'EUR';
    try {
      const ps = await dGet(`/marketplace/price_suggestions/${releaseId}`, TOKEN);
      const ex = (k) => (ps[k] && ps[k].value != null ? r2(ps[k].value) : null);
      medVG  = ex('Very Good (VG)');
      medVGP = ex('Very Good Plus (VG+)');
      medNM  = ex('Near Mint (NM or M-)');
      medM   = ex('Mint (M)');
      medCur =
        (ps['Very Good Plus (VG+)'] && ps['Very Good Plus (VG+)'].currency) ||
        (ps['Near Mint (NM or M-)'] && ps['Near Mint (NM or M-)'].currency) ||
        (ps['Very Good (VG)']       && ps['Very Good (VG)'].currency) ||
        'EUR';
    } catch (e) {
      console.warn('Price suggestions failed:', e.message);
    }

    // ══ STEP 4: annunci marketplace attivi ════════════════════
    let listCount = 0, listMin = null, listMax = null, listMedian = null, listAvg = null, listCur = 'EUR';
    let chartData = [];

    try {
      // Prendi 100 annunci ordinati per prezzo → statistiche
      const ml = await dGet(
        `/marketplace/search?release_id=${releaseId}&per_page=100&sort=price&sort_order=asc`,
        TOKEN
      );

      const good = (ml.listings || []).filter(
        (l) => VG_UP.has(l.condition) && l.price && l.price.value != null
      );

      if (good.length > 0) {
        const prices = good.map((l) => l.price.value);
        listCount  = good.length;
        listMin    = r2(Math.min.apply(null, prices));
        listMax    = r2(Math.max.apply(null, prices));
        listMedian = r2(calcMedian(prices));
        listAvg    = r2(prices.reduce((a, b) => a + b, 0) / prices.length);
        listCur    = good[0].price.currency || 'EUR';

        // Per il grafico: usa data inserimento annuncio (campo "listed" o "posted")
        chartData = good
          .filter((l) => l.listed || l.posted)
          .map((l) => ({
            date:      (l.listed || l.posted || '').slice(0, 10),
            price:     r2(l.price.value),
            condition: l.condition,
            ships_from: l.ships_from || null,
          }))
          .filter((l) => l.date && l.date.length === 10)
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-50);
      }
    } catch (e) {
      console.warn('Marketplace listings failed:', e.message);
      // Fallback dai dati del /releases
      listCount = rd.num_for_sale || 0;
      if (rd.lowest_price && rd.lowest_price.value != null) {
        listMin = r2(rd.lowest_price.value);
        listCur = rd.lowest_price.currency || 'EUR';
      }
    }

    // Fallback num_for_sale
    if (listCount === 0 && rd.num_for_sale) listCount = rd.num_for_sale;

    // ══ Risposta finale ════════════════════════════════════════
    const result = {
      release_id:   releaseId,
      release_url:  'https://www.discogs.com' + (bestRelease.uri || ''),
      discogs_title: bestRelease.title || null,
      match_score:  bestScore,

      // Info release
      label:   (rd.labels || []).map((l) => l.name).filter(Boolean).join(', ') || null,
      country: rd.country || bestRelease.country || null,
      year:    rd.year    || bestRelease.year     || null,
      genres:  (rd.genres || []).join(', ') || null,
      styles:  (rd.styles || []).slice(0, 4).join(', ') || null,

      // Community
      community_want:  (rd.community && rd.community.want  != null) ? rd.community.want  : null,
      community_have:  (rd.community && rd.community.have  != null) ? rd.community.have  : null,
      num_for_sale:    rd.num_for_sale != null ? rd.num_for_sale : listCount,
      lowest_price_release:  (rd.lowest_price && rd.lowest_price.value != null) ? r2(rd.lowest_price.value) : null,
      lowest_price_currency: (rd.lowest_price && rd.lowest_price.currency) || 'EUR',

      // Mediane ufficiali Discogs (da vendite reali)
      median_vg:       medVG,
      median_vgp:      medVGP,
      median_nm:       medNM,
      median_m:        medM,
      median_currency: medCur,

      // Stats annunci attivi VG+
      listings_count:    listCount,
      listings_min:      listMin,
      listings_max:      listMax,
      listings_median:   listMedian,
      listings_avg:      listAvg,
      listings_currency: listCur,

      // Dati grafico
      chart_data: chartData,

      error: null,
    };

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };

  } catch (e) {
    console.error('discogs.js fatal:', e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'Errore Discogs: ' + e.message }) };
  }
};
