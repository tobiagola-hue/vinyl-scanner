/*
  netlify/functions/discogs.js
  Smart Discogs search + raccolta dati prezzi completa.
  Legge DISCOGS_TOKEN dalle env vars Netlify.
  Fallback: accetta il token nel body (uso locale).

  Dati restituiti:
  - release info (label, country, year, genres)
  - community stats (want/have/num_for_sale)
  - mediane ufficiali Discogs per condizione (da vendite reali)
  - stats annunci attivi VG+ (min, max, media, mediana, conteggio)
  - chart_data: annunci attivi ordinati per data inserimento (proxy trend)
*/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Condizioni "VG e superiori"
const VG_UP = new Set([
  'Mint (M)',
  'Near Mint (NM or M-)',
  'Very Good Plus (VG+)',
  'Very Good (VG)',
]);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON non valido' }) };
  }

  const TOKEN = process.env.DISCOGS_TOKEN || body.discogs_token;
  if (!TOKEN) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ error: 'DISCOGS_TOKEN non configurato. Aggiungilo nelle env vars di Netlify oppure nel pannello impostazioni.' }),
    };
  }

  const { query, artist, album, catalog_number, year } = body;

  // ── helpers ──────────────────────────────────────────────────
  const enc = (s) => encodeURIComponent((s || '').trim());
  const r2 = (v) => Math.round(v * 100) / 100;

  const calcMedian = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const dGet = async (path) => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://api.discogs.com${path}${sep}token=${TOKEN}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VinylScan/3.0 +netlify' },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Discogs HTTP ${res.status} [${path.split('?')[0]}] ${txt.slice(0, 80)}`);
    }
    const json = await res.json();
    // Discogs restituisce {message:...} su errori di auth anche con status 200
    if (json.message && !json.results && !json.id && !json.listings && !json.pagination) {
      throw new Error(`Discogs: ${json.message}`);
    }
    return json;
  };

  // ── scoring ricerca ─────────────────────────────────────────
  const tokenSim = (s1, s2) => {
    const tok = (s) => new Set(s.toLowerCase().split(/[\s\-_,\.\/\(\)]+/).filter((t) => t.length > 1));
    const t1 = tok(s1), t2 = tok(s2);
    if (!t1.size || !t2.size) return 0;
    let n = 0;
    for (const t of t1) if (t2.has(t)) n++;
    return n / Math.max(t1.size, t2.size);
  };

  const scoreResult = (r, targetArtist, targetAlbum) => {
    let score = 0;
    const full = (r.title || '').toLowerCase();
    const a = (targetArtist || '').toLowerCase().trim();
    const al = (targetAlbum || '').toLowerCase().trim();

    // Discogs format: "Artist - Album Title"
    const dash = full.indexOf(' - ');
    const rA = dash >= 0 ? full.slice(0, dash).trim() : '';
    const rAl = dash >= 0 ? full.slice(dash + 3).trim() : full;

    // Artist match (peso alto)
    if (a) {
      if (rA === a) score += 6;
      else if (rA.includes(a) || a.includes(rA)) score += 4;
      else if (tokenSim(rA, a) > 0.55) score += 3;
      else if (tokenSim(rA, a) > 0.3) score += 1;
    }

    // Album match (peso alto)
    if (al) {
      if (rAl === al) score += 6;
      else if (rAl.includes(al) || al.includes(rAl)) score += 4;
      else if (tokenSim(rAl, al) > 0.55) score += 3;
      else if (tokenSim(rAl, al) > 0.3) score += 1;
    }

    // Format bonus
    const fmt = (r.format || []).join(' ').toLowerCase();
    if (fmt.includes('lp') || fmt.includes('album')) score += 1;
    if (fmt.includes('33') || fmt.includes('12')) score += 1;

    // Year proximity
    if (year && r.year) {
      const diff = Math.abs(Number(r.year) - Number(year));
      if (diff === 0) score += 2;
      else if (diff <= 2) score += 1;
    }

    return score;
  };

  // ── main ────────────────────────────────────────────────────
  try {
    // STEP 1: trova la release migliore con strategie multiple
    let bestRelease = null;
    let bestScore = -1;

    const strategies = [];

    // Catalog number è molto specifico: usalo per primo se disponibile
    if (catalog_number && catalog_number !== 'null' && catalog_number.length > 2) {
      strategies.push(`/database/search?catno=${enc(catalog_number)}&type=release&per_page=5`);
    }

    // Ricerca strutturata per artista + titolo
    if (artist && album) {
      strategies.push(
        `/database/search?artist=${enc(artist)}&release_title=${enc(album)}&type=release&format=vinyl&per_page=10`
      );
    }

    // Ricerca testuale con query da Groq
    if (query) {
      strategies.push(`/database/search?q=${enc(query)}&type=release&format=vinyl&per_page=10`);
    }

    // Ricerca testuale libera (senza filtro formato) come fallback
    if (artist && album) {
      strategies.push(`/database/search?q=${enc(artist + ' ' + album)}&type=release&per_page=15`);
    }

    for (const path of strategies) {
      try {
        const data = await dGet(path);
        const results = (data.results || []).slice(0, 12);

        for (const r of results) {
          const s = scoreResult(r, artist, album);
          if (s > bestScore) {
            bestScore = s;
            bestRelease = r;
          }
        }

        // Score >= 8 = molto alta confidenza, inutile continuare
        if (bestScore >= 8) break;
      } catch (e) {
        console.warn('Strategy failed:', path.split('?')[0], e.message);
      }
    }

    if (!bestRelease) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ error: 'Release non trovata su Discogs. Prova a scansionare con il testo più visibile.' }),
      };
    }

    const releaseId = bestRelease.id;

    // STEP 2: dettagli release (community, label, country, num_for_sale, lowest_price)
    let rd = {};
    try {
      rd = await dGet(`/releases/${releaseId}`);
    } catch (e) {
      console.warn('Release details failed:', e.message);
    }

    // STEP 3: mediane ufficiali Discogs (calcolate da vendite reali recenti)
    let medVG = null, medVGP = null, medNM = null, medM = null, medCur = 'EUR';
    try {
      const ps = await dGet(`/marketplace/price_suggestions/${releaseId}`);
      const ex = (k) => (ps[k]?.value != null ? r2(ps[k].value) : null);
      medVG  = ex('Very Good (VG)');
      medVGP = ex('Very Good Plus (VG+)');
      medNM  = ex('Near Mint (NM or M-)');
      medM   = ex('Mint (M)');
      // Prendi la currency dalla condizione più comune
      medCur =
        ps['Very Good Plus (VG+)']?.currency ||
        ps['Near Mint (NM or M-)']?.currency ||
        ps['Very Good (VG)']?.currency ||
        'EUR';
    } catch (e) {
      console.warn('Price suggestions failed:', e.message);
    }

    // STEP 4: annunci marketplace attivi VG+ per stats e chart
    let listCount = 0;
    let listMin = null, listMax = null, listMedian = null, listAvg = null, listCur = 'EUR';
    let chartData = [];

    try {
      // Fetch 100 annunci ordinati per prezzo crescente → statistiche
      const ml = await dGet(
        `/marketplace/search?release_id=${releaseId}&per_page=100&sort=price&sort_order=asc`
      );

      const good = (ml.listings || []).filter(
        (l) => VG_UP.has(l.condition) && l.price?.value != null
      );

      if (good.length > 0) {
        const prices = good.map((l) => l.price.value);
        listCount  = good.length;
        listMin    = r2(Math.min(...prices));
        listMax    = r2(Math.max(...prices));
        listMedian = r2(calcMedian(prices));
        listAvg    = r2(prices.reduce((a, b) => a + b, 0) / prices.length);
        listCur    = good[0].price.currency || 'EUR';

        // Chart: prendi gli annunci con data, ordinali per data
        // Il campo può essere "listed" o "posted" a seconda della versione API
        chartData = good
          .filter((l) => l.listed || l.posted)
          .map((l) => ({
            date: (l.listed || l.posted || '').slice(0, 10), // YYYY-MM-DD
            price: r2(l.price.value),
            condition: l.condition,
            ships_from: l.ships_from || null,
          }))
          .filter((l) => l.date.length === 10)
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-50); // ultimi 50 per data
      }
    } catch (e) {
      console.warn('Marketplace listings failed:', e.message);
      // Fallback: usa i dati dal /releases che abbiamo già
      listCount = rd.num_for_sale || 0;
      if (rd.lowest_price?.value != null) {
        listMin = r2(rd.lowest_price.value);
        listCur = rd.lowest_price.currency || 'EUR';
      }
    }

    // Se marketplace ha fallito ma abbiamo num_for_sale dal release, usalo
    if (listCount === 0 && rd.num_for_sale) listCount = rd.num_for_sale;

    // Costruisci risposta completa
    const result = {
      // Identificazione
      release_id: releaseId,
      release_url: `https://www.discogs.com${bestRelease.uri}`,
      discogs_title: bestRelease.title,
      match_score: bestScore,

      // Info release
      label: rd.labels?.map((l) => l.name).filter(Boolean).join(', ') || null,
      country: rd.country || bestRelease.country || null,
      year: rd.year || bestRelease.year || null,
      genres: rd.genres?.join(', ') || null,
      styles: rd.styles?.slice(0, 4).join(', ') || null,

      // Community
      community_want: rd.community?.want ?? null,
      community_have: rd.community?.have ?? null,
      num_for_sale: rd.num_for_sale ?? listCount,
      lowest_price_release: rd.lowest_price?.value != null ? r2(rd.lowest_price.value) : null,
      lowest_price_currency: rd.lowest_price?.currency || 'EUR',

      // Mediane Discogs (da vendite reali)
      median_vg:  medVG,
      median_vgp: medVGP,
      median_nm:  medNM,
      median_m:   medM,
      median_currency: medCur,

      // Stats annunci attivi VG+
      listings_count:  listCount,
      listings_min:    listMin,
      listings_max:    listMax,
      listings_median: listMedian,
      listings_avg:    listAvg,
      listings_currency: listCur,

      // Dati per grafico (annunci per data inserimento)
      chart_data: chartData,

      error: null,
    };

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (e) {
    console.error('Discogs function fatal error:', e);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
