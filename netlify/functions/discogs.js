/*
  netlify/functions/discogs.js
  Due azioni:
  1. action:"search_versions" → cerca tutte le pressature vinile di un album, le restituisce per far scegliere l'utente
  2. action:"get_release_data" → dato un release_id specifico, restituisce prezzi completi + ultimi annunci attivi
*/

'use strict';
const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const VG_UP = new Set(['Mint (M)', 'Near Mint (NM or M-)', 'Very Good Plus (VG+)', 'Very Good (VG)']);

// ── HTTP helper ───────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'VinylScan/4.0 +netlify' } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode === 429) { reject(new Error('Rate limit Discogs (429) — riprova tra qualche secondo')); return; }
        if (res.statusCode === 401) { reject(new Error('Token Discogs non valido (401)')); return; }
        if (res.statusCode === 403) { reject(new Error('Accesso negato Discogs (403)')); return; }
        if (res.statusCode === 404) { reject(new Error('Not found (404)')); return; }
        try {
          const json = JSON.parse(raw);
          if (json.message && !json.results && !json.id && !json.listings && !json.versions && !json.pagination) {
            reject(new Error('Discogs: ' + json.message));
            return;
          }
          resolve(json);
        } catch (e) {
          reject(new Error('JSON parse error: ' + raw.slice(0, 80)));
        }
      });
    }).on('error', reject);
  });
}

function dGet(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  return httpsGet(`https://api.discogs.com${path}${sep}token=${token}`);
}

// ── Math ──────────────────────────────────────────────────────
const r2 = (v) => Math.round(v * 100) / 100;
const calcMedian = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── Scoring ricerca ───────────────────────────────────────────
function tokenSim(s1, s2) {
  const tok = (s) => new Set((s || '').toLowerCase().split(/[\s\-_,\.\/\(\)\[\]]+/).filter((t) => t.length > 1));
  const t1 = tok(s1), t2 = tok(s2);
  if (!t1.size || !t2.size) return 0;
  let n = 0; for (const t of t1) if (t2.has(t)) n++;
  return n / Math.max(t1.size, t2.size);
}

function scoreResult(r, tA, tAl, tYear) {
  let score = 0;
  const full = (r.title || '').toLowerCase();
  const a  = (tA  || '').toLowerCase().trim();
  const al = (tAl || '').toLowerCase().trim();
  const dash = full.indexOf(' - ');
  const rA  = dash >= 0 ? full.slice(0, dash).trim() : '';
  const rAl = dash >= 0 ? full.slice(dash + 3).trim() : full;

  if (a) {
    if (rA === a)                               score += 6;
    else if (rA.includes(a)||a.includes(rA))   score += 4;
    else if (tokenSim(rA, a) > 0.6)            score += 3;
    else if (tokenSim(rA, a) > 0.3)            score += 1;
  }
  if (al) {
    if (rAl === al)                             score += 6;
    else if (rAl.includes(al)||al.includes(rAl)) score += 4;
    else if (tokenSim(rAl, al) > 0.6)          score += 3;
    else if (tokenSim(rAl, al) > 0.3)          score += 1;
  }
  const fmt = (r.format || []).join(' ').toLowerCase();
  if (fmt.includes('lp')||fmt.includes('album')) score += 1;
  if (tYear && r.year) {
    const diff = Math.abs(Number(r.year) - Number(tYear));
    if (diff === 0) score += 2; else if (diff <= 2) score += 1;
  }
  return score;
}

// ── AZIONE 1: cerca versioni vinile ───────────────────────────
async function searchVersions(body, TOKEN) {
  const { query, artist, album, catalog_number, year } = body;
  const enc = (s) => encodeURIComponent((s || '').toString().trim());

  let bestRelease = null, bestScore = -1;

  // Strategie di ricerca
  const strategies = [];
  if (catalog_number && String(catalog_number) !== 'null' && String(catalog_number).length > 2) {
    strategies.push(`/database/search?catno=${enc(catalog_number)}&type=release&per_page=5`);
  }
  if (artist && album) {
    strategies.push(`/database/search?artist=${enc(artist)}&release_title=${enc(album)}&type=release&format=vinyl&per_page=10`);
  }
  if (query) {
    strategies.push(`/database/search?q=${enc(query)}&type=release&format=vinyl&per_page=10`);
  }
  if (artist && album) {
    strategies.push(`/database/search?q=${enc(artist + ' ' + album)}&type=release&per_page=15`);
  }

  for (const path of strategies) {
    try {
      const data = await dGet(path, TOKEN);
      for (const r of (data.results || []).slice(0, 12)) {
        const s = scoreResult(r, artist, album, year);
        if (s > bestScore) { bestScore = s; bestRelease = r; }
      }
      if (bestScore >= 8) break;
    } catch (e) { console.warn('Strategy failed:', e.message); }
  }

  if (!bestRelease) {
    return { error: 'Album non trovato su Discogs. Prova a scansionare con il testo più visibile.' };
  }

  // Ora cerchiamo TUTTE le versioni vinile:
  // Se esiste un master_id, usiamo /masters/{id}/versions (molto più completo)
  let versions = [];

  if (bestRelease.master_id) {
    try {
      // Prendi fino a 100 versioni, filtra solo vinile
      let page = 1;
      while (versions.length < 150) {
        const mv = await dGet(
          `/masters/${bestRelease.master_id}/versions?format=Vinyl&per_page=100&page=${page}`,
          TOKEN
        );
        const items = (mv.versions || []).filter(v => {
          const fmt = (v.format || '').toLowerCase();
          return fmt.includes('vinyl') || fmt.includes('lp') || fmt.includes('12') || fmt.includes('7') || fmt.includes('10');
        });
        versions = versions.concat(items);
        if (!mv.pagination || mv.pagination.page >= mv.pagination.pages) break;
        page++;
        if (page > 3) break; // max 3 pagine
      }
    } catch (e) { console.warn('Master versions failed:', e.message); }
  }

  // Fallback: ricerca database per il titolo, filtra vinile
  if (versions.length === 0) {
    try {
      const enc2 = (s) => encodeURIComponent((s || '').toString().trim());
      const q = artist && album
        ? `/database/search?artist=${enc2(artist)}&release_title=${enc2(album)}&type=release&format=vinyl&per_page=50`
        : `/database/search?q=${enc2(query)}&type=release&format=vinyl&per_page=50`;
      const data = await dGet(q, TOKEN);
      versions = (data.results || []).filter(r => {
        const fmt = (r.format || []).join(' ').toLowerCase();
        const titleMatch = scoreResult(r, artist, album, year) >= 3;
        const isVinyl = fmt.includes('vinyl') || fmt.includes('lp') || fmt.includes('12') || fmt.includes('7') || fmt.includes('10');
        return titleMatch && isVinyl;
      });
    } catch (e) { console.warn('Fallback search failed:', e.message); }
  }

  if (versions.length === 0) {
    // Usa il bestRelease direttamente
    versions = [bestRelease];
  }

  // Normalizza e arricchisci ogni versione
  const cleaned = versions.map(v => ({
    id:          v.id,
    title:       v.title  || v.catno || '—',
    year:        v.year   || null,
    country:     v.country || null,
    format:      Array.isArray(v.format) ? v.format.join(', ') : (v.format || null),
    label:       Array.isArray(v.label)  ? v.label.join(', ')  : (v.label  || null),
    catno:       v.catno  || null,
    thumb:       v.thumb  || v.cover_image || null,
    released:    v.released || null,
  }));

  // Deduplicazione per id
  const seen = new Set();
  const unique = cleaned.filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; });

  // Ordina per anno (più recente prima)
  unique.sort((a, b) => {
    if (a.year && b.year) return Number(b.year) - Number(a.year);
    if (a.year) return -1;
    if (b.year) return 1;
    return 0;
  });

  return {
    master_id:   bestRelease.master_id || null,
    best_id:     bestRelease.id,
    match_score: bestScore,
    versions:    unique.slice(0, 80), // max 80
  };
}

// ── AZIONE 2: dati prezzi per release specifica ───────────────
async function getReleaseData(body, TOKEN) {
  const { release_id } = body;
  if (!release_id) return { error: 'release_id mancante' };

  const results = {
    release_id,
    label: null, country: null, year: null, genres: null, styles: null,
    community_want: null, community_have: null, num_for_sale: null,
    median_vg: null, median_vgp: null, median_nm: null, median_m: null, median_currency: 'EUR',
    listings_count: 0, listings_min: null, listings_max: null,
    listings_median: null, listings_avg: null, listings_currency: 'EUR',
    last_listings: [], // ultimi 15 annunci attivi VG+ per il grafico
    error: null,
  };

  // 1. Dettagli release
  try {
    const rd = await dGet(`/releases/${release_id}`, TOKEN);
    results.label   = (rd.labels || []).map(l => l.name).filter(Boolean).join(', ') || null;
    results.country = rd.country || null;
    results.year    = rd.year    || null;
    results.genres  = (rd.genres || []).join(', ') || null;
    results.styles  = (rd.styles || []).slice(0, 4).join(', ') || null;
    results.community_want = rd.community && rd.community.want  != null ? rd.community.want  : null;
    results.community_have = rd.community && rd.community.have  != null ? rd.community.have  : null;
    results.num_for_sale   = rd.num_for_sale != null ? rd.num_for_sale : null;
  } catch (e) { console.warn('Release details failed:', e.message); }

  // 2. Mediane ufficiali Discogs (basate su vendite reali)
  try {
    const ps = await dGet(`/marketplace/price_suggestions/${release_id}`, TOKEN);
    const ex = (k) => (ps[k] && ps[k].value != null) ? r2(ps[k].value) : null;
    results.median_vg  = ex('Very Good (VG)');
    results.median_vgp = ex('Very Good Plus (VG+)');
    results.median_nm  = ex('Near Mint (NM or M-)');
    results.median_m   = ex('Mint (M)');
    results.median_currency =
      (ps['Very Good Plus (VG+)'] && ps['Very Good Plus (VG+)'].currency) ||
      (ps['Near Mint (NM or M-)'] && ps['Near Mint (NM or M-)'].currency) ||
      (ps['Very Good (VG)']       && ps['Very Good (VG)'].currency) || 'EUR';
  } catch (e) { console.warn('Price suggestions failed:', e.message); }

  // 3. Annunci marketplace attivi — prendi 100, filtra VG+
  try {
    const ml = await dGet(
      `/marketplace/search?release_id=${release_id}&per_page=100&sort=price&sort_order=asc`,
      TOKEN
    );

    const good = (ml.listings || []).filter(
      l => VG_UP.has(l.condition) && l.price && l.price.value != null
    );

    if (good.length > 0) {
      const prices = good.map(l => l.price.value);
      results.listings_count    = good.length;
      results.listings_min      = r2(Math.min.apply(null, prices));
      results.listings_max      = r2(Math.max.apply(null, prices));
      results.listings_median   = r2(calcMedian(prices));
      results.listings_avg      = r2(prices.reduce((a, b) => a + b, 0) / prices.length);
      results.listings_currency = good[0].price.currency || 'EUR';

      // Ultimi 15 annunci per il grafico
      // Prova prima con data, fallback su tutti gli annunci ordinati per prezzo
      const withDate = good
        .filter(l => l.listed || l.posted)
        .map(l => ({
          date:      (l.listed || l.posted || '').slice(0, 10),
          price:     r2(l.price.value),
          condition: l.condition,
          has_date:  true,
        }))
        .filter(l => l.date.length === 10)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 15)
        .reverse();

      if (withDate.length >= 2) {
        results.last_listings = withDate;
      } else {
        // Fallback: usa tutti gli annunci VG+ ordinati per prezzo crescente
        // Il grafico li mostra come "annuncio 1..N" sull'asse Y
        results.last_listings = good.slice(0, 15).map((l, i) => ({
          date:      null,
          index:     i + 1,
          price:     r2(l.price.value),
          condition: l.condition,
          has_date:  false,
        }));
      }
    }

    // Fallback num_for_sale
    if (!results.num_for_sale) results.num_for_sale = good.length;

  } catch (e) {
    console.warn('Marketplace failed:', e.message);
    if (!results.num_for_sale && results.num_for_sale !== 0) results.num_for_sale = 0;
  }

  return results;
}

// ── Handler principale ────────────────────────────────────────
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
      body: JSON.stringify({ error: 'DISCOGS_TOKEN non configurato. Aggiungilo in Netlify: Site Settings > Environment Variables, poi Trigger deploy.' }),
    };
  }

  try {
    let result;
    if (body.action === 'get_release_data') {
      result = await getReleaseData(body, TOKEN);
    } else {
      // default: search_versions
      result = await searchVersions(body, TOKEN);
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (e) {
    console.error('discogs.js fatal:', e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'Errore: ' + e.message }) };
  }
};
