#!/usr/bin/env node
/*
 * corpus-tools.js — deterministic, offline query toolbox over corpus/corpus.json.
 *
 * Every tool is a pure function of (corpus, args); each is paired with a JSON Schema
 * (name / description / parameters) in TOOL_SCHEMAS so it can be registered as a
 * Gemini / LLM function-calling tool. No network, no randomness.
 *
 * Standard return shape:
 *   { count, hits: [ { text, ref, word?/…, context } ], truncated? }
 * Options honoured by most tools:
 *   limit       (default 50)   max hits returned
 *   count_only  (default false) return only { count }
 *
 * Usage:
 *   const T = require('./corpus-tools');
 *   const c = T.loadCorpus();               // or T.loadCorpus('/path/to/corpus.json')
 *   T.query_words(c, { text:'VC', case:'तृतीया' });
 *   T.TOOL_SCHEMAS  // array of registerable JSON schemas
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------
function loadCorpus(file) {
  const p = file || path.join(__dirname, 'corpus.json');
  // corpus.json is committed as a gzip (corpus.json.gz, ~10x smaller — keeps it under GitHub's 100MB
  // limit). Prefer the raw .json when present (local dev / the drift gate keep it, gitignored); otherwise
  // load the committed .gz (corpus-chat/hf-space ship only the .gz). Both yield the same object.
  const gz = p.endsWith('.gz') ? p : p + '.gz';
  const c = fs.existsSync(p) && !p.endsWith('.gz') ? JSON.parse(fs.readFileSync(p, 'utf8'))
    : fs.existsSync(gz) ? JSON.parse(require('zlib').gunzipSync(fs.readFileSync(gz)))
    : JSON.parse(fs.readFileSync(p, 'utf8'));   // no file → original ENOENT error
  Object.defineProperty(c, '_dir', { value: path.dirname(p), enumerable: false });
  return c;
}
// COMMENTARY LAYER (build_commentary.js → commentary.json.gz beside corpus.json): every commentary on the site that
// corpus.json's `bhasya` does not carry (Ānandagiri ṭīkās, vārttikas, Ratnaprabhā, Gītā verse-commentaries, prakaraṇa
// commentaries…), placed on base text + reading-view ref. Loaded on first use; null when the file is absent.
function commentaryOf(c) {
  if (c._commentary !== undefined) return c._commentary;
  let doc = null;
  const base = path.join(c._dir || __dirname, 'commentary.json');
  try {
    if (fs.existsSync(base)) doc = JSON.parse(fs.readFileSync(base, 'utf8'));
    else if (fs.existsSync(base + '.gz')) doc = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(base + '.gz')));
  } catch (e) { doc = null; }
  Object.defineProperty(c, '_commentary', { value: doc, enumerable: false, writable: true });
  return doc;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------
const DEFAULT_LIMIT = 50;
function contains(hay, needle) {
  if (hay == null || needle == null) return false;
  return String(hay).indexOf(String(needle)) !== -1;
}
// ---------------------------------------------------------------------------
// SPELLING-TOLERANT keyword matching (search_bhasya, search_moola tier 4, find_discussions).
// The bhāṣya is running sandhi'd prose, so a word's initial vowel is often FUSED onto the preceding consonant:
// आनन्द appears as ब्रह्मानन्द / परमानन्द / सैषानन्दस्य — spelled with the mātrā ा, which a plain substring
// search for "आनन्द" misses (2026-10-11: 90 of the 174 ānanda passages). So a query is compiled into a regex:
//   • a word-initial independent vowel also matches its mātrā (आ↔ा, इ↔ि, ई↔ी, उ↔ु, ऊ↔ू, ऋ↔ृ, ए↔े, ऐ↔ै, ओ↔ो, औ↔ौ)
//     — ONLY when ≥3 characters follow it in that word, so short particles stay exact (इति must not match स्थिति);
//   • anusvāra ≡ candrabindu ≡ a nasal+virāma before a consonant (संशय ≡ सँशय, सम्शय);
//   • avagraha ऽ is ignored on both sides (folded out of the text before matching).
// अ has no mātrā, so it stays literal. Deterministic; no sandhi engine.
// ---------------------------------------------------------------------------
const VOWEL_MATRA = { 'आ': 'ा', 'इ': 'ि', 'ई': 'ी', 'उ': 'ु', 'ऊ': 'ू', 'ऋ': 'ृ', 'ए': 'े', 'ऐ': 'ै', 'ओ': 'ो', 'औ': 'ौ' };
const NASAL_ALT = '(?:[ंँ]|[ङञणनम]्)';
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spellFold = s => String(s == null ? '' : s).replace(/ऽ/g, '');
const _spellCache = new Map();
function spellRegex(query) {
  const q = spellFold(query).trim();
  if (_spellCache.has(q)) return _spellCache.get(q);
  const chars = Array.from(q);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], prev = chars[i - 1], next = chars[i + 1];
    const wordStart = i === 0 || /\s/.test(prev);
    if (wordStart && VOWEL_MATRA[ch]) {
      let rest = 0; for (let j = i + 1; j < chars.length && !/\s/.test(chars[j]); j++) rest++;
      out += rest >= 3 ? '[' + ch + VOWEL_MATRA[ch] + ']' : ch;
    } else if (ch === 'ं' || ch === 'ँ') out += NASAL_ALT;
    else if (/[ङञणनम]/.test(ch) && next === '्' && chars[i + 2] && /[क-ह]/.test(chars[i + 2])) { out += NASAL_ALT; i++; }
    else if (/\s/.test(ch)) { if (!/\\s\+$/.test(out)) out += '\\s+'; }
    else out += reEsc(ch);
  }
  const re = new RegExp(out, 'g');
  _spellCache.set(q, re);
  return re;
}
function spellCount(hay, query) {
  if (hay == null || query == null || !String(query).trim()) return 0;
  const m = spellFold(hay).match(spellRegex(query));
  return m ? m.length : 0;
}
const spellContains = (hay, query) => spellCount(hay, query) > 0;
// DHĀTU KEYS: roots are stored bare for Gītā/VS ("कृ") but in the gloss-card form elsewhere ("√कृ डुकृञ् करणे 08USA",
// "प्र-√नम् णमँ प्रह्वत्वे शब्दे च 01PSA + क्त → प्रणत"). Match on the bare root ("कृ"), the upasarga form ("प्र-नम्"), the
// dhātupāṭha form ("डुकृञ्") or the facet label; a leading √ in the query is ignored. (2026-10-26)
// HOMONYMS (corpus-chat eval 2026-10-26): one spelling can be several dhātupāṭha roots — √अस् = असँ भुवि ("be") and असुँ क्षेपणे
// ("throw"); √विद् = विदँ ज्ञाने / विदँ सत्तायाम् / विदॢँ लाभे. The ENTRY (dhātupāṭha form + meaning, up to the gaṇa code) tells them
// apart, so the facet label is "अस् (असँ भुवि)" wherever a bare root has ≥2 entries in the corpus; a word stored with the bare
// root only (Gītā/VS) cannot be resolved and keeps the plain "अस्". Querying the bare root still matches every sense.
const GANA = /^\d\d[A-Z]{3}$/;
function dhatuParse(root, dp2bare) {
  const r = String(root || '').trim(); const i = r.indexOf('√');
  if (i < 0) {
    // some entries carry only the dhātupāṭha form ("डुकृञ् करणे 08USA + क्त → उपाकृत"): recover the bare root from the
    // pairs seen elsewhere in the corpus ("√कृ डुकृञ् …"); a plain bare root ("कृ", Gītā/VS) passes through
    const toks = r.split(/\s+/), t0 = toks[0], g = toks.findIndex(t => GANA.test(t));
    if (g > 0 && dp2bare && dp2bare.has(t0)) return { bare: dp2bare.get(t0), upa: '', dp: t0, entry: toks.slice(0, g).join(' ') };
    return { bare: t0, upa: '', dp: '', entry: '' };
  }
  const upa = r.slice(0, i).replace(/-+$/, '').trim(); const toks = r.slice(i + 1).trim().split(/\s+/);
  const g = toks.findIndex(t => GANA.test(t));
  const ent = g > 1 ? toks.slice(1, g).filter(t => !/^\(/.test(t)) : [];
  return { bare: toks[0] || '', upa, dp: ent[0] || '', entry: ent.join(' ') };
}
// per corpus, once: dhātupāṭha form → bare root (majority), and the bare roots that have ≥2 distinct entries
function dhatuIndex(c) {
  if (c && c._dhatuIdx) return c._dhatuIdx;
  const votes = new Map(), entries = new Map();
  for (const v of (c ? c.verses : [])) for (const w of v.words || []) {
    const d = w.dhatu && w.dhatu.root && String(w.dhatu.root).includes('√') ? dhatuParse(w.dhatu.root) : null;
    if (!d || !d.bare) continue;
    if (d.dp) { const m = votes.get(d.dp) || new Map(); m.set(d.bare, (m.get(d.bare) || 0) + 1); votes.set(d.dp, m); }
    if (d.entry) { const s = entries.get(d.bare) || new Set(); s.add(d.entry); entries.set(d.bare, s); }
  }
  const idx = { dp2bare: new Map([...votes].map(([dp, m]) => [dp, [...m].sort((x, y) => y[1] - x[1])[0][0]])),
    homonyms: new Set([...entries].filter(([, s]) => s.size > 1).map(([b]) => b)) };
  if (c) Object.defineProperty(c, '_dhatuIdx', { value: idx, enumerable: false });
  return idx;
}
function dhatuLabel(root, c) {
  const X = dhatuIndex(c), d = dhatuParse(root, X.dp2bare);
  return X.homonyms.has(d.bare) && d.entry ? d.bare + ' (' + d.entry + ')' : d.bare;
}
const dhatuBare = (root, c) => dhatuLabel(root, c);   // facet value
function dhatuMatch(root, filter, c) {
  const X = dhatuIndex(c), d = dhatuParse(root, X.dp2bare);
  const keys = [d.bare, d.upa ? d.upa + '-' + d.bare : '', d.dp, d.entry, d.entry ? d.bare + ' (' + d.entry + ')' : ''].filter(Boolean);
  const qs = (Array.isArray(filter) ? filter : [filter]).map(q => String(q).replace(/√/g, '').trim());
  return qs.some(q => keys.includes(q));
}
function eqOrIn(val, filter) {
  // filter may be a string (exact) or array (any-of)
  if (Array.isArray(filter)) return filter.includes(val);
  return val === filter;
}
// finalize a hit list into the standard envelope
function envelope(hits, opts) {
  const o = opts || {};
  const count = hits.length;
  if (o.count_only) return { count };
  const limit = o.limit == null ? DEFAULT_LIMIT : o.limit;
  const out = limit >= 0 ? hits.slice(0, limit) : hits;
  const res = { count, hits: out };
  if (out.length < count) res.truncated = true;
  return res;
}
// iterate verses (optionally filtered to one text or a list, and/or a ref-prefix). ref_prefix scopes
// to a chapter/division: "6" matches ref "6.317" (Vicārasāgara taraṅga 6), "1.2" matches "1.2.x".
function verses(c, textFilter, refPrefix) {
  let vs = c.verses;
  if (textFilter) {
    const set = Array.isArray(textFilter) ? new Set(textFilter) : new Set([textFilter]);
    vs = vs.filter(v => set.has(v.text));
  }
  if (refPrefix != null && refPrefix !== '') {
    const rp = String(refPrefix);
    vs = vs.filter(v => v.ref === rp || String(v.ref).startsWith(rp + '.'));
  }
  return vs;
}
// peel layers for a word record (deref shared dict), or null
function peelOf(c, wordRec) {
  if (!wordRec || !wordRec.compound) return null;
  return c.peel[wordRec.compound] || null;
}
function citeVerse(v) { return { text: v.text, ref: v.ref }; }

// ===========================================================================
// TOOL: query_words — ANDs all supplied per-word morphological/role filters
// ===========================================================================
function query_words(c, a) {
  a = a || {};
  const hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) {
    // build a governor->cluster map for voice/transitivity filters
    let govMap = null;
    if (a.voice || a.transitivity) {
      govMap = new Map();
      for (const cl of (v.clusters || [])) if (cl.governorWord) govMap.set(cl.governorWord, cl);
    }
    for (const w of v.words) {
      if (a.case && !eqOrIn(w.vibhakti, a.case)) continue;
      if (a.vacana && !eqOrIn(w.vacana, a.vacana)) continue;
      if (a.linga && !eqOrIn(w.linga, a.linga)) continue;
      if (a.lemma != null && w.lemma !== a.lemma) continue;
      if (a.isSarvanama != null && !!w.isSarvanama !== !!a.isSarvanama) continue;
      if (a.karaka_role && !((w.karakaRoles || []).some(r => eqOrIn(r, a.karaka_role)))) continue;
      if (a.dhatu && !(w.dhatu && dhatuMatch(w.dhatu.root, a.dhatu, c))) continue;
      if (a.meaning_contains && !contains(w.meaning, a.meaning_contains)) continue;
      // kṛt pratyaya: from walk krdanta OR from any कृत् peel layer
      if (a.krt_pratyaya) {
        const fromKrt = w.krt && w.krt.pratyaya === a.krt_pratyaya;
        const L = peelOf(c, w);
        const fromPeel = L && L.some(x => /कृत्/.test(x.type || '') && x.pratyaya === a.krt_pratyaya);
        if (!fromKrt && !fromPeel) continue;
      }
      // taddhita pratyaya: from any तद्धित peel layer
      if (a.taddhita_pratyaya) {
        const L = peelOf(c, w);
        if (!(L && L.some(x => /तद्धित/.test(x.type || '') && x.pratyaya === a.taddhita_pratyaya))) continue;
      }
      if (a.voice || a.transitivity) {
        const cl = govMap.get(w.word);
        if (a.voice && !(cl && eqOrIn(cl.voice, a.voice))) continue;
        if (a.transitivity && !(cl && eqOrIn(cl.transitivity, a.transitivity))) continue;
      }
      hits.push(Object.assign(citeVerse(v), {
        word: w.word, lemma: w.lemma, case: w.vibhakti, vacana: w.vacana, linga: w.linga,
        isSarvanama: w.isSarvanama, karakaRoles: w.karakaRoles, dhatu: w.dhatu,
        krt: w.krt, meaning: w.meaning, samasaType: w.samasaType, context: v.moola,
      }));
    }
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: find_compounds — query the recursive samāsa peel
// ===========================================================================
function find_compounds(c, a) {
  a = a || {};
  const hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) {
    for (const w of v.words) {
      const L = peelOf(c, w);
      if (!L) continue;
      const depth = L.length;
      if (a.min_layers != null && depth < a.min_layers) continue;
      if (a.max_layers != null && depth > a.max_layers) continue;
      if (a.type && !L.some(x => contains(x.type, a.type))) continue;
      if (a.sutra_num && !L.some(x => x.sutra && x.sutra.num === a.sutra_num)) continue;
      if (a.member_contains && !L.some(x => contains(x.c, a.member_contains) ||
          contains(x.vigraha, a.member_contains))) continue;
      if (a.final_pratyaya) {
        const finals = L.filter(x => x.pratyaya).map(x => x.pratyaya);
        if (!finals.includes(a.final_pratyaya)) continue;
      }
      hits.push(Object.assign(citeVerse(v), {
        word: w.word, samasaType: L[0] && L[0].type, peelDepth: depth,
        layers: L.map(x => ({ member: x.c, vigraha: x.vigraha, type: x.type,
          pratyaya: x.pratyaya || null, sutra: x.sutra || null })),
        context: v.moola,
      }));
    }
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: find_sandhi — query sandhi junctions (rule / sūtra / surface)
// ===========================================================================
function find_sandhi(c, a) {
  a = a || {};
  const hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) {
    for (const s of (v.sandhi || [])) {
      if (a.sutra_num && s.sutra !== a.sutra_num) continue;
      if (a.rule && s.rule !== a.rule) continue;
      if (a.before && !((s.before || []).some(b => contains(b, a.before)))) continue;
      if (a.after && !contains(s.after, a.after)) continue;
      hits.push(Object.assign(citeVerse(v), {
        rule: s.rule, sutra: s.sutra, before: s.before, after: s.after,
        subtype: s.subtype, context: v.moola,
      }));
    }
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: find_relational — query the kāraka / relational web
// ===========================================================================
// friendly relation name -> underlying edge relation(s)
const RELATION_ALIAS = {
  qualifierOf: ['qualifierKarta', 'qualifierKarma', 'peripheralQualifiers'],
  genitiveOf: ['genitives'],
  'uddeshya-vidheya': ['uddeshya-vidheya'],
  samuccaya: ['samuccaya', 'samuccayaKarta', 'samuccayaKarma'],
  karta: ['karta', 'agreementKarta'],
  karma: ['karma', 'agreementKarma'],
  hetu: ['hetu'], upamana: ['upamana'], upameya: ['upameya'], karana: ['karana'],
  sampradana: ['sampradana'], apadana: ['apadana'], adhikarana: ['adhikarana'],
  satisaptami: ['satisaptami'], nirdharana: ['nirdharana'], sambodhana: ['sambodhana'],
  pratishedha: ['pratishedha'], sequence: ['sequence'], itthambhuta: ['itthambhuta'],
  impliedKaraka: ['impliedKaraka'], modifiers: ['modifiers'], nipata: ['nipata'],
  remaining: ['remaining'],
};
function find_relational(c, a) {
  a = a || {};
  const wanted = RELATION_ALIAS[a.relation] || [a.relation];
  const set = new Set(wanted);
  const hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) {
    for (const e of (v.relations || [])) {
      if (!set.has(e.relation)) continue;
      hits.push(Object.assign(citeVerse(v), {
        relation: e.relation, word: e.word, role: e.role || null,
        targetWord: e.targetWord || null, targetRole: e.targetRole || null,
        governorWord: e.governorWord || null, clauseType: e.clauseType || null,
        upapada: e.upapada || null, upapadaCase: e.upapadaCase || null, context: v.moola,
      }));
    }
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: find_clauses — query clause structure (type / subordination / elision)
// ===========================================================================
function find_clauses(c, a) {
  a = a || {};
  const hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) {
    const nClauses = (v.clauses || []).length;   // vākya-vibhāga: how many clauses the sentence decomposes into
    if (a.min_clauses != null && nClauses < a.min_clauses) continue;
    if (a.max_clauses != null && nClauses > a.max_clauses) continue;
    for (const cl of (v.clauses || [])) {
      if (a.type && cl.type !== a.type) continue;
      if (a.subordinate != null) {
        const isSub = cl.subordinateTo != null && cl.subordinateTo !== 0 && cl.subordinateTo !== cl.id;
        if (!!a.subordinate !== isSub) continue;
      }
      if (a.elided != null) {
        const hasElided = (cl.elided || []).length > 0 || (cl.anuktaKarta || '') !== '';
        if (!!a.elided !== hasElided) continue;
      }
      hits.push(Object.assign(citeVerse(v), {
        type: cl.type, subordinateTo: cl.subordinateTo, headWord: cl.headWord,
        elided: cl.elided, anuktaKarta: cl.anuktaKarta, gloss: cl.gloss,
        words: cl.words, clauseCount: nClauses, context: v.moola,
      }));
    }
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: find_mahavakya — verses that ARE mahāvākyas / identity equations (jīva=brahman),
// from the human-verified śāstric catalog. Filter by sub-type: mukhya (direct aikya identity —
// tat tvam asi, ahaṃ brahmāsmi, so'ham asmi) vs badhayam (sublation, world/witness = brahman).
// ===========================================================================
function find_mahavakya(c, a) {
  a = a || {};
  const hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) {
    const m = v.mahavakya;
    if (!m) continue;
    if (a.subtype && m.subtype !== a.subtype) continue;
    hits.push(Object.assign(citeVerse(v), {
      subtype: m.subtype, classification: m.label, context: v.moola,
    }));
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: find_virodha — curated विरोधपरिहारः units: an APPARENT contradiction (one subject, opposed predicates)
// that the text resolves. Composed only from the mūla, Śaṅkara's bhāṣya and Ānandagiri's ṭīkā (attributed). One hit
// per unit (deduped across the verses it spans). Filters: theme, side mode, parihāra source, text, keyword.
// ===========================================================================
function find_virodha(c, a) {
  a = a || {}; const seen = new Set(), hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) for (const u of (v.virodha || [])) {
    if (seen.has(u.unit)) continue;
    if (a.theme && u.theme !== a.theme) continue;
    if (a.mode && !u.pairs.some(p => p.sideA.mode === a.mode || p.sideB.mode === a.mode)) continue;
    if (a.parihara_source && !u.pairs.some(p => p.parihara.source === a.parihara_source)) continue;
    if (a.keyword && !u.pairs.some(p => contains(p.desc, a.keyword) || contains(p.sideA.label, a.keyword) || contains(p.sideB.label, a.keyword) || contains(p.parihara.quote, a.keyword))) continue;
    seen.add(u.unit);
    hits.push({ text: v.text, ref: v.ref, unit: u.unit, title: u.title, theme: u.theme, voice: u.voice, verses: u.verses, status: u.status,
      pairs: u.pairs.map(p => ({ paradox: p.desc, side_A: p.sideA.label, side_B: p.sideB.label, modes: [p.sideA.mode, p.sideB.mode].filter(Boolean),
        parihara: p.parihara.quote, parihara_source: p.parihara.source, parihara_ref: p.parihara.ref })),
      same_paradox: u.same });
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: search_bhasya — keyword + rhetorical-role search over Śaṅkara-bhāṣya
// ===========================================================================
function search_bhasya(c, a) {
  a = a || {};
  const hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) {
    for (const b of (v.bhasya || [])) {
      // role filter: keep spans of that role; keyword filter within (or whole text)
      let spans = b.spans || [];
      if (a.role) spans = spans.filter(s => s.role === a.role);
      if (a.role && !spans.length) continue;
      if (a.keyword) {
        const inSpans = spans.filter(s => spellContains(s.text, a.keyword));
        const inFull = spellContains(b.text, a.keyword);
        if (a.role) { if (!inSpans.length) continue; spans = inSpans; }
        else if (!inFull) continue;
      }
      hits.push(Object.assign(citeVerse(v), {
        variant: b.variant || null,
        matchedSpans: (a.role || a.keyword)
          ? spans.filter(s => !a.keyword || spellContains(s.text, a.keyword))
                 .map(s => ({ role: s.role, text: s.text })).slice(0, 20)
          : undefined,
        roleCounts: b.spans.reduce((m, s) => (m[s.role] = (m[s.role] || 0) + 1, m), {}),
        context: b.text.slice(0, 300),
      }));
    }
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: find_discussions — "where does the bhāṣya DISCUSS X?" (a vicāra, not a passing mention)
// ===========================================================================
// Deterministic candidate finder; the chat model makes the final vicāra-vs-mention call from the key sentences.
//   1. per bhāṣya passage: spelling-tolerant occurrences of ANY keyword (pass synonyms: आनन्द + सुख);
//   2. MERGE consecutive bhāṣya passages of the same text (+variant) that each have hits into one discussion
//      (BS 1.1.12–19 = one ānandamaya-adhikaraṇa unit). `bridge` (default 0) lets a chain jump that many hit-less
//      passages — bridging chains passing mentions together (VC 407–429, Taitt 2.1–2.9), so it is off by default.
//      The corpus carries no adhikaraṇa boundaries, so BS merges by consecutive sūtras too;
//   3. signals: occurrences, density per 1000 chars, pūrvapakṣa/siddhānta/ekadeśī spans containing a keyword, and
//      INQUIRY MARKERS (संशय, विचार्यते/विचारणा, मीमांसा, ननु, इति चेत्/चेन्न, उच्यते, किम्…उत) counted only inside the
//      keyword's own excerpt windows (a marker elsewhere in a long passage is about something else);
//   4. score = 2·log2(1+occurrences) + 0.3·min(density,15) + 1.5·min(roleSpans,10) + 2·min(markerWindows,6).
const INQUIRY_MARKERS = [
  ['saṃśaya', /संशय/g], ['vicāra', /विचार(?:्यते|णा|्य|ः)/g], ['mīmāṃsā', /मीमांस/g],
  ['nanu', /(?:^|[\s—‘'"(])(?:ननु|नन्व)/g], ['iti-cet', /इति\s*चे(?:त्|न्न|द्|च्छ)/g], ['ucyate', /उच्यते/g],
  ['kim…uta', /कि(?:म्|मि|मु|ं)[^।॥?]{0,160}\sउत\s/g],
];
const DISC_ROLES = ['purvapaksha', 'siddhanta', 'ekadeshi'];
// PAIRED OPPOSITES: a keyword hit inside a pair-of-opposites word (सुखदुःख, दुःखसुखे, शीतोष्ण, रागद्वेष) is about the PAIR,
// not the keyword's own topic — सुख as a synonym of आनन्द pulled Gītā 13.19–22 / BS 3.1.24–27 (66–100% paired hits) above
// real ānanda vicāras (0–3% paired). A unit's score is scaled by (1 − 0.7 × paired share). (Harsha 2026-10-26.)
const OPPOSITES = [['सुख', 'दुःख'], ['शीत', 'उष्ण'], ['राग', 'द्वेष']];
const PAIR_PENALTY = 0.7;
function pairedCount(text, kws) {
  const opp = kws.map(k => { const f = spellFold(k).trim(); const o = [];
    for (const [x, y] of OPPOSITES) { if (f.includes(x)) o.push(y); if (f.includes(y)) o.push(x); } return o; });
  if (!opp.some(o => o.length)) return 0;
  let n = 0;
  for (const tok of text.split(/[\s।॥,;:‘’'"()\[\]—-]+/)) {
    kws.forEach((k, i) => { if (!opp[i].length) return; const m = spellCount(tok, k); if (m && opp[i].some(o => tok.includes(o))) n += m; });
  }
  return n;
}
function excerptWindows(text, kws) {
  // one window per keyword hit: its sentence (split on । ॥ ?) when ≤300 chars, else ±150 chars snapped to spaces;
  // a hit inside an earlier window doesn't open a new one
  const wins = [];
  for (const kw of kws) {
    const re = new RegExp(spellRegex(kw).source, 'g'); let m;
    while ((m = re.exec(text))) {
      const at = m.index;
      if (wins.some(w => at >= w.s && at < w.e)) continue;
      let s = Math.max(text.lastIndexOf('।', at), text.lastIndexOf('॥', at), text.lastIndexOf('?', at)) + 1;
      let e = text.slice(at).search(/[।॥?]/); e = e < 0 ? text.length : at + e + 1;
      if (e - s > 300) {
        s = Math.max(0, at - 150); e = Math.min(text.length, at + 150);
        const sp = text.indexOf(' ', s); if (sp > 0 && sp < at) s = sp + 1;
        const ep = text.lastIndexOf(' ', e); if (ep > at + m[0].length) e = ep;
      }
      wins.push({ s, e, kw });
    }
  }
  return wins.sort((x, y) => x.s - y.s).map(w => Object.assign(w, { text: text.slice(w.s, w.e).trim() }));
}
// BS adhikaraṇa lookup (corpus.adhikaranas = VNM digests, verbatim). Cached per corpus object.
const _adhCache = new WeakMap();
function adhikaranaOf(c, text, ref) {
  if (text !== 'BS' || !Array.isArray(c.adhikaranas)) return null;
  let m = _adhCache.get(c);
  if (!m) { m = new Map(); for (const a of c.adhikaranas) for (const r of a.refs || []) m.set(r, a); _adhCache.set(c, m); }
  return m.get(String(ref)) || null;
}
// VNM convention (verified: 183/191 adhikaraṇas = 2 ślokas, 7 = 4, 1 = 1): each VIEW is set out in two ślokas — the
// first states the saṃśaya + pūrvapakṣa, the second the siddhānta of that view. A view VNM introduces as एकदेशि-मत is
// a one-sided reading, NOT the bhāṣyakāra's; "इदानीं स्वमतानुसारेण…" opens Śaṅkara's own. So the explicit
// structure below is a mechanical reading of VNM's own layout + labels, and `finalPosition` = the siddhānta śloka of the
// last non-एकदेशि view (Harsha 2026-10-12: flash-lite took the ekadeśī's answer, VNM kārikā 26, for Śaṅkara's).
function vnmStructure(vnm) {
  const groups = [{ label: null, kind: 'main', slokas: [] }];
  let buf = [];
  for (const l of vnm) {
    if (l.k === 'label' && /[एे]कदेशि/.test(l.t)) { groups.push({ label: l.t, kind: 'ekadeshi', slokas: [] }); continue; }
    if (l.k === 'label' && /स्वमत/.test(l.t)) { groups.push({ label: l.t, kind: 'svamata', slokas: [] }); continue; }
    if (l.k !== 'karika') continue;
    buf.push(l.t);
    if (l.end || /॥\s*[०-९0-9]+\s*॥\s*$/.test(l.t)) { groups[groups.length - 1].slokas.push(buf.join(' ')); buf = []; }
  }
  if (buf.length) groups[groups.length - 1].slokas.push(buf.join(' '));
  const views = groups.filter(g => g.slokas.length).map(g => ({
    view: g.kind === 'ekadeshi' ? 'एकदेशिमत — a one-sided view VNM records; NOT Śaṅkara\'s conclusion'
        : g.kind === 'svamata' ? 'स्वमत — Śaṅkara\'s own view (the bhāṣyakāra\'s siddhānta)' : 'the adhikaraṇa (pūrvapakṣa → siddhānta)',
    vnmLabel: g.label, purvapakshaSloka: g.slokas.length > 1 ? g.slokas[0] : null, siddhantaSloka: g.slokas[g.slokas.length - 1],
    ...(g.slokas.length > 2 ? { allSlokas: g.slokas } : {}),
  }));
  const fin = views.filter(v => !/^एकदेशि/.test(v.view)).pop() || null;
  return { views, finalPosition: fin ? { sloka: fin.siddhantaSloka, note: 'VNM: the concluding (siddhānta) śloka of Śaṅkara\'s own view for this adhikaraṇa — state THIS as the conclusion' } : null };
}
function adhikaranaView(a) {
  if (!a) return null;
  const st = vnmStructure(a.vnm || []);
  return { name: a.name, pada: a.pada, ordinalInPada: a.k, refRange: a.first === a.last ? a.first : a.first + '–' + a.last,
    finalPosition: st.finalPosition, views: st.views, vnm: a.vnm };
}

function find_discussions(c, a) {
  a = a || {};
  const kws = (Array.isArray(a.keywords) ? a.keywords : [a.keywords || a.keyword]).filter(k => k && String(k).trim()).map(String);
  if (!kws.length) return { error: 'find_discussions needs keywords: ["आनन्द", …]' };
  // 1. per-passage stats, grouped by text+variant in corpus order
  const seqs = new Map();
  for (const v of verses(c, a.text, a.ref_prefix)) {
    for (const b of (v.bhasya || [])) {
      const key = v.text + '|' + (b.variant || '');
      if (!seqs.has(key)) seqs.set(key, []);
      const text = spellFold(b.text || '');
      const occ = kws.reduce((n, k) => n + spellCount(text, k), 0);
      seqs.get(key).push({ v, b, text, occ });
    }
  }
  // 2. merge consecutive hit passages (bridge ≤ a.bridge hit-less passages; default 0)
  const bridge = Math.max(0, a.bridge == null ? 0 : +a.bridge || 0);
  const discs = [];
  for (const [key, seq] of seqs) {
    // BS: a discussion = an ADHIKARAṆA (VNM boundaries) — hit passages in the same adhikaraṇa merge even across
    // hit-less sūtras, and never across an adhikaraṇa boundary. Passages outside any known adhikaraṇa fall through.
    if (key.startsWith('BS|') && Array.isArray(c.adhikaranas)) {
      const byAdh = new Map(), rest = [];
      for (const p of seq) { if (!p.occ) continue; const ad = adhikaranaOf(c, 'BS', p.v.ref); if (ad) { const k = ad.pada + '#' + ad.k; if (!byAdh.has(k)) { const d = { key, parts: [], pending: [], adh: ad }; byAdh.set(k, d); discs.push(d); } byAdh.get(k).parts.push(p); } else rest.push(p); }
      for (const p of rest) discs.push({ key, parts: [p], pending: [] });
      continue;
    }
    let cur = null, gap = 0;
    for (const p of seq) {
      if (p.occ > 0) {
        if (cur && gap <= bridge) { cur.parts.push(...cur.pending, p); cur.pending = []; }
        else { cur = { key, parts: [p], pending: [] }; discs.push(cur); }
        gap = 0;
      } else if (cur) { gap++; if (gap <= bridge) cur.pending.push(p); else { cur.pending = []; cur = null; } }
    }
  }
  // 3. signals + score + key sentences
  const out = discs.map(d => {
    const parts = d.parts, first = parts[0], last = parts[parts.length - 1];
    let occ = 0, chars = 0, paired = 0; const roles = {}, markers = {}; let markerWindows = 0; const cands = [];
    for (const p of parts) {
      occ += p.occ; chars += p.text.length; if (p.occ) paired += pairedCount(p.text, kws);
      const roleSpans = (p.b.spans || []).filter(s => DISC_ROLES.includes(s.role) && kws.some(k => spellContains(s.text, k)));
      for (const s of roleSpans) roles[s.role] = (roles[s.role] || 0) + 1;
      if (!p.occ) continue;
      for (const w of excerptWindows(p.text, kws)) {
        let mk = 0;
        for (const [name, re] of INQUIRY_MARKERS) { const n = (w.text.match(re) || []).length; if (n) { markers[name] = (markers[name] || 0) + n; mk++; } }
        if (mk) markerWindows++;
        const inRole = roleSpans.some(s => w.text.includes(spellFold(s.text).slice(0, 24)) || spellFold(s.text).includes(w.text.slice(0, 24)));
        const hits = kws.reduce((n, k) => n + spellCount(w.text, k), 0);
        cands.push({ ref: p.v.ref, text: w.text, rank: mk * 3 + (inRole ? 2 : 0) + hits, marker: mk > 0, role: inRole });
      }
    }
    const roleSpans = Object.values(roles).reduce((x, y) => x + y, 0);
    const density = chars ? occ * 1000 / chars : 0;
    const pairedShare = occ ? Math.min(1, paired / occ) : 0;
    const score = (2 * Math.log2(1 + occ) + 0.3 * Math.min(density, 15) + 1.5 * Math.min(roleSpans, 10) + 2 * Math.min(markerWindows, 6))
      * (1 - PAIR_PENALTY * pairedShare);
    const fmt = k => ({ ref: k.ref, text: k.text.length > 320 ? k.text.slice(0, 320) + '…' : k.text, inquiryMarker: k.marker, inRoleSpan: k.role });
    const keySentences = cands.slice().sort((x, y) => y.rank - x.rank).slice(0, 3).map(fmt);
    // CLOSING sentences: the best key sentences of the unit's LAST passage. A multi-passage discussion may present a view
    // and overturn it at the end (BS 1.1.12–18 argue ānandamaya = Brahman; 1.1.19 rejects that for 'ब्रह्म पुच्छं
    // प्रतिष्ठा'), so the model must see where the unit ENDS before stating its conclusion (Harsha 2026-10-12).
    const closingSentences = parts.length > 1
      ? cands.filter(k => k.ref === last.v.ref).sort((x, y) => y.rank - x.rank).slice(0, 2).map(fmt) : [];
    const refs = parts.map(p => p.v.ref);
    return {
      text: first.v.text, variant: first.b.variant || null,
      refRange: refs.length > 1 ? first.v.ref + '–' + last.v.ref : first.v.ref, refs,
      score: Math.round(score * 10) / 10,
      signals: { occurrences: occ, passages: parts.length, chars, densityPer1k: Math.round(density * 10) / 10, roleSpans: roles, inquiryMarkers: markers, markerWindows,
        ...(paired ? { pairedOpposites: paired, pairedShare: Math.round(pairedShare * 100) / 100 } : {}) },
      keySentences,
      closingSentences,
      ...(d.adh ? { adhikarana: adhikaranaView(d.adh) } : {}),
    };
  }).filter(d => a.min_score == null || d.score >= a.min_score)
    .sort((x, y) => y.score - x.score);
  const lim = a.limit == null ? 15 : a.limit;
  const res = { keywords: kws, count: out.length, discussions: lim >= 0 ? out.slice(0, lim) : out };
  if (lim >= 0 && out.length > lim) res.truncated = true;
  return res;
}

// ===========================================================================
// TOOLS: search_commentary / get_commentary — the commentary layer (see commentaryOf)
// ===========================================================================
function commentaryRows(c, a) {
  const C = commentaryOf(c); if (!C) return null;
  const works = a.work == null ? null : new Set(Array.isArray(a.work) ? a.work : [a.work]);
  const texts = a.text == null ? null : new Set(Array.isArray(a.text) ? a.text : [a.text]);
  const rp = a.ref_prefix == null || a.ref_prefix === '' ? null : String(a.ref_prefix);
  return { C, rows: C.rows.filter(([w, x, r]) => (!works || works.has(w)) && (!texts || texts.has(x)) &&
    (!rp || (r != null && (r === rp || r.startsWith(rp + '.'))))) };
}
const NO_COMMENTARY = { error: 'commentary layer not loaded (commentary.json.gz missing beside corpus.json)' };
function search_commentary(c, a) {
  a = a || {};
  if (!a.keyword || !String(a.keyword).trim()) return { error: 'search_commentary needs keyword' };
  const R = commentaryRows(c, a); if (!R) return NO_COMMENTARY;
  const hits = [];
  for (const [w, x, r, layer, t] of R.rows) {
    const text = spellFold(t); const n = spellCount(text, a.keyword); if (!n) continue;
    const wk = R.C.works[w] || {};
    const win = excerptWindows(text, [a.keyword]).slice(0, 2).map(e => e.text.length > 320 ? e.text.slice(0, 320) + '…' : e.text);
    hits.push({ work: w, title: wk.title, layer, text: x, ref: r, occurrences: n, excerpts: win,
      ...(wk.side ? { side: wk.side, hl: String(a.keyword).trim() } : {}) });
  }
  if (a.count_by_work) {
    const m = {}; for (const h of hits) m[h.work] = (m[h.work] || 0) + h.occurrences;
    return { count: hits.length, byWork: Object.entries(m).sort((x, y) => y[1] - x[1]).map(([work, occurrences]) => ({ work, title: (R.C.works[work] || {}).title, occurrences })) };
  }
  return envelope(hits, a);
}
function get_commentary(c, a) {
  a = a || {};
  if (!a.text || a.ref == null) return { error: 'get_commentary needs text and ref' };
  const C = commentaryOf(c); if (!C) return NO_COMMENTARY;
  const ref = String(a.ref), max = a.max_chars == null ? 4000 : a.max_chars;
  const works = a.work == null ? null : new Set(Array.isArray(a.work) ? a.work : [a.work]);
  const by = new Map();
  for (const [w, x, r, layer, t] of C.rows) {
    if (x !== a.text || r !== ref || (works && !works.has(w))) continue;
    const e = by.get(w) || { work: w, title: (C.works[w] || {}).title, layer, text: x, ref, passages: [], chars: 0 };
    e.passages.push(t); e.chars += t.length; by.set(w, e);
  }
  const out = [...by.values()].map(e => {
    let full = e.passages.join(' ¶ '); const cut = full.length > max;
    if (cut) full = full.slice(0, max) + '…';
    return { work: e.work, title: e.title, layer: e.layer, text: e.text, ref: e.ref, commentary: full, ...(cut ? { truncated: true, totalChars: e.chars } : {}) };
  });
  return { text: a.text, ref, count: out.length, commentaries: out,
    ...(out.length ? {} : { note: 'no commentary block at this exact ref — try search_commentary with ref_prefix, or the chapter ref' }) };
}

// ===========================================================================
// TOOL: find_by_sutra — every citation of an Aṣṭādhyāyī sūtra (sandhi + samāsa)
// ===========================================================================
function find_by_sutra(c, a) {
  a = a || {};
  const num = a.num;
  const hits = [];
  for (const v of verses(c, a.text, a.ref_prefix)) {
    for (const s of (v.sandhi || [])) {
      if (s.sutra === num) hits.push(Object.assign(citeVerse(v),
        { kind: 'sandhi', rule: s.rule, before: s.before, after: s.after, context: v.moola }));
    }
    for (const w of v.words) {
      // two-layer vibhakti-vidhāna: the sūtra that ordains this word's CASE (e.g. 2.3.29 anya-yoge)
      if (w.vibhaktiSutra && w.vibhaktiSutra.num === num) {
        hits.push(Object.assign(citeVerse(v), { kind: 'vibhakti', word: w.word,
          role: w.overlayRole || null, vibhaktiType: w.vibhaktiType || null,
          sutraText: w.vibhaktiSutra.text, context: v.moola }));
      }
      const L = peelOf(c, w);
      if (!L) continue;
      for (const layer of L) {
        if (layer.sutra && layer.sutra.num === num) {
          hits.push(Object.assign(citeVerse(v), { kind: 'samasa', word: w.word,
            member: layer.c, type: layer.type, vigraha: layer.vigraha,
            sutraText: layer.sutra.text, context: v.moola }));
        }
      }
    }
  }
  return envelope(hits, a);
}

// ===========================================================================
// facet plumbing (shared by list_values + count_by)
// ===========================================================================
// facet -> function(verse) -> array of {value, cite?} contributions
const FACETS = {
  case:            v => v.words.filter(w => w.vibhakti).map(w => w.vibhakti),
  vibhakti_sutra:  v => v.words.filter(w => w.vibhaktiSutra && w.vibhaktiSutra.num).map(w => w.vibhaktiSutra.num),   // सूत्र ordaining the CASE (two-layer)
  vibhakti_type:   v => v.words.filter(w => w.vibhaktiType).map(w => w.vibhaktiType),   // कारक|उपपद|शेष|विशेष|कर्मप्रवचनीय
  vacana:          v => v.words.filter(w => w.vacana).map(w => w.vacana),
  linga:           v => v.words.filter(w => w.linga).map(w => w.linga),
  lemma:           v => v.words.filter(w => w.lemma != null).map(w => w.lemma),
  karaka_role:     v => v.words.flatMap(w => w.karakaRoles || []),
  dhatu:           (v, c) => v.words.filter(w => w.dhatu && w.dhatu.root).map(w => dhatuBare(w.dhatu.root, c)),
  voice:           v => (v.clusters || []).filter(cl => cl.voice).map(cl => cl.voice),
  transitivity:    v => (v.clusters || []).filter(cl => cl.transitivity).map(cl => cl.transitivity),
  clause_type:     v => (v.clauses || []).filter(cl => cl.type).map(cl => cl.type),
  clause_count:    v => Array.isArray(v.clauses) && v.clauses.length ? [String(v.clauses.length)] : [],   // vākya-vibhāga: sentence-decomposition complexity (clauses per verse)
  krt_pratyaya:    v => v.words.filter(w => w.krt && w.krt.pratyaya).map(w => w.krt.pratyaya),
  samasa_category: v => v.words.filter(w => w.samasaCategory).map(w => w.samasaCategory),
  samasa_type:     (v, c) => v.words.flatMap(w => { const L = c.peel[w.compound]; return L ? L.map(x => x.type).filter(Boolean) : []; }),
  taddhita_pratyaya: (v, c) => v.words.flatMap(w => { const L = c.peel[w.compound]; return L ? L.filter(x => /तद्धित/.test(x.type || '') && x.pratyaya).map(x => x.pratyaya) : []; }),
  sutra:           (v, c) => {
    const out = (v.sandhi || []).filter(s => s.sutra).map(s => s.sutra);
    for (const w of v.words) { const L = c.peel[w.compound]; if (L) for (const x of L) if (x.sutra && x.sutra.num) out.push(x.sutra.num); }
    return out;
  },
  sandhi_rule:     v => (v.sandhi || []).filter(s => s.rule).map(s => s.rule),
  relation:        v => (v.relations || []).map(e => e.relation),
  bhasya_role:     v => (v.bhasya || []).flatMap(b => (b.spans || []).map(s => s.role)),
  mahavakya:       v => v.mahavakya ? [v.mahavakya.subtype] : [],   // mukhya | badhayam (identity-equation sub-type)
  virodha_theme:   v => (v.virodha || []).map(u => u.theme),   // विरोधपरिहारः paradox theme (motion_space, scale, knowing, agency, …)
  virodha_mode:    v => (v.virodha || []).flatMap(u => u.pairs.flatMap(p => [p.sideA.mode, p.sideB.mode])).filter(Boolean),   // how each side is grounded (upAdhikRta, iva, svena_rUpeNa, …)
  virodha_source:  v => (v.virodha || []).flatMap(u => u.pairs.map(p => p.parihara.source)).filter(Boolean),   // who states the reconciliation: bhashya | mula | tika | implicit
  text:            v => [v.text],
  chapter:         v => [String(v.ref).split('.')[0]],   // top ref division (Vicārasāgara taraṅga, upaniṣad adhyāya, …); pair with text= for meaning
};

// ===========================================================================
// TOOL: list_values — distinct values + counts for any facet
// ===========================================================================
function list_values(c, a) {
  a = a || {};
  if (a.facet === 'commentary_work') {   // the commentary layer's works (not a per-verse facet)
    const C = commentaryOf(c); if (!C) return NO_COMMENTARY;
    const n = {}; for (const [w, x] of C.rows) if (!a.text || x === a.text) n[w] = (n[w] || 0) + 1;
    const rows = Object.keys(n).map(w => ({ value: w, title: C.works[w].title, base: C.works[w].base, count: n[w] })).sort((x, y) => y.count - x.count);
    return { facet: a.facet, distinct: rows.length, values: rows };
  }
  const fn = FACETS[a.facet];
  if (!fn) return { error: 'unknown facet: ' + a.facet, facets: Object.keys(FACETS) };
  const counts = {};
  for (const v of verses(c, a.text, a.ref_prefix)) {
    for (const val of fn(v, c)) counts[val] = (counts[val] || 0) + 1;
  }
  const rows = Object.keys(counts).map(k => ({ value: k, count: counts[k] }))
    .sort((x, y) => y.count - x.count);
  const limit = a.limit == null ? -1 : a.limit;
  return { facet: a.facet, distinct: rows.length,
    values: (limit >= 0 ? rows.slice(0, limit) : rows) };
}

// ===========================================================================
// TOOL: count_by — distribution of a facet, optionally split per text
// ===========================================================================
function count_by(c, a) {
  a = a || {};
  const fn = FACETS[a.facet];
  if (!fn) return { error: 'unknown facet: ' + a.facet, facets: Object.keys(FACETS) };
  if (!a.by_text) return list_values(c, a);
  const perText = {};
  for (const v of verses(c, a.text, a.ref_prefix)) {
    perText[v.text] = perText[v.text] || {};
    for (const val of fn(v, c)) perText[v.text][val] = (perText[v.text][val] || 0) + 1;
  }
  return { facet: a.facet, by_text: perText };
}

// ===========================================================================
// TOOL: get_verse — full consolidated record for one (text, ref)
// ===========================================================================
function get_verse(c, a) {
  a = a || {};
  const ref = String(a.ref);
  const v = c.verses.find(x => x.text === a.text && (x.ref === ref || x.ref === normalizeRef(ref)));
  if (!v) return { found: false, text: a.text, ref: a.ref };
  const ad = adhikaranaOf(c, v.text, v.ref);
  return ad ? { found: true, verse: v, adhikarana: adhikaranaView(ad) } : { found: true, verse: v };
}
function normalizeRef(ref) {
  return String(ref).split('.').map(s => /^\d+$/.test(s.trim()) ? String(parseInt(s, 10)) : s.trim()).join('.');
}

// ===========================================================================
// TOOL: search_moola — free-text phrase search over the mūla verse text
// ===========================================================================
// The stored mūla (v.moola) is in PADACCHEDA form (words split, samāsa members hyphenated),
// e.g. "आत्मा एव इदम् अग्रे आसीत्". A query typed in either padaccheda ("आत्मा एव इदम्") or a
// space-collapsed / sandhi'd-spacing form should hit the same verse — so we compare on three
// tiers and report which one matched:
//   exact       — substring of the raw mūla (query already in padaccheda spacing)
//   normalized  — substring after folding away whitespace, daṇḍas, samāsa hyphens & avagraha
//                 (bridges "इदं सर्वम्" ⇄ "इदंसर्वम्" and hyphenated compounds)
//   tokens      — every whitespace-token of the query occurs (each as a normalized substring)
// NOTE: this does NOT bridge VOWEL sandhi across a word-split — a single sandhi'd word like
// "आत्मैवेदं" (= आत्मा एव इदम्) will not be found in the padaccheda store; query it split, or in
// padaccheda form. (No sandhi engine here — kept deterministic & fidelity-safe.)
function moolaNorm(s) {
  return String(s == null ? '' : s)
    .replace(/[।॥]+/g, '')       // daṇḍas
    .replace(/[-–—]/g, '')        // samāsa hyphens
    .replace(/ऽ/g, '')           // avagraha
    .replace(/म्/g, 'ं')         // final/labial म् ≡ anusvāra (इदम् ≡ इदं, सर्वम् ≡ सर्वं)
    .replace(/[ँ]/g, 'ं')        // candrabindu → anusvāra (light fold)
    .replace(/\s+/g, '');        // all whitespace
}
function search_moola(c, a) {
  a = a || {};
  const phrase = a.phrase == null ? '' : String(a.phrase);
  const hits = [];
  if (!phrase.trim()) return envelope(hits, a);
  const nPhrase = moolaNorm(phrase);
  const tokens = phrase.trim().split(/\s+/).map(moolaNorm).filter(Boolean);
  for (const v of verses(c, a.text, a.ref_prefix)) {
    const raw = v.moola || '';
    let mode = null, at = -1;
    if ((at = raw.indexOf(phrase)) !== -1) mode = 'exact';
    else if (nPhrase && moolaNorm(raw).indexOf(nPhrase) !== -1) mode = 'normalized';
    else if (tokens.length > 1) {
      const nraw = moolaNorm(raw);
      if (tokens.every(t => nraw.indexOf(t) !== -1)) mode = 'tokens';
    }
    // tier 4 — spelling-tolerant (initial vowel ≡ its mātrā, anusvāra ≡ nasal+virāma, avagraha ignored) on the raw mūla
    if (!mode && spellContains(raw, phrase)) mode = 'spelling';
    if (!mode) continue;
    // snippet: ±50 chars around the exact match when we have an offset, else the mūla head
    const snippet = at >= 0
      ? (at > 50 ? '…' : '') + raw.slice(Math.max(0, at - 50), at + phrase.length + 50) + (at + phrase.length + 50 < raw.length ? '…' : '')
      : raw.slice(0, 200) + (raw.length > 200 ? '…' : '');
    hits.push(Object.assign(citeVerse(v), { matchMode: mode, snippet, moola: raw }));
  }
  return envelope(hits, a);
}

// ===========================================================================
// TOOL: corpus_stats — top-level coverage snapshot
// ===========================================================================
function corpus_stats(c) {
  return { meta: c.meta, texts: c.texts };
}

// ===========================================================================
// JSON SCHEMAS (Gemini/LLM-registerable)
// ===========================================================================
const TOOL_SCHEMAS = [
  {
    name: 'query_words',
    description: 'Find individual words matching morphological / kāraka / derivation filters. ' +
      'All supplied filters are ANDed. Returns cited word occurrences (text·ref·word). ' +
      'Coverage note: dhatu (verbal root) and lemma cover every mūla text (lemma not VS); krt_pratyaya comes from ' +
      'the Gītā morphology plus every text\'s samāsa peel / kṛt chain; meaning/case/vacana/linga/karaka_role/samasa cover ' +
      'all analysed texts. BS is bhāṣya-only (no word rows). ' +
      'VS (reading-only prose) contributes word, meaning, dhātu-root and samāsa — no case/kāraka.',
    parameters: { type: 'object', properties: {
      text: { type: 'string', description: 'Restrict to one text key (e.g. VC, PD, Gita, Chandogya, Brha, VS).' },
      ref_prefix: { type: 'string', description: 'Restrict to a chapter/division by ref prefix, e.g. "6" = Vicārasāgara taraṅga 6 (matches ref 6.317), "1.2" = refs under 1.2.' },
      case: { type: 'string', description: 'vibhakti in Devanāgarī, e.g. तृतीया, षष्ठी, सप्तमी.' },
      vacana: { type: 'string', description: 'एकवचन / द्विवचन / बहुवचन.' },
      linga: { type: 'string', description: 'पुंलिङ्ग / स्त्रीलिङ्ग / नपुंसकलिङ्ग.' },
      lemma: { type: 'string', description: 'Exact stem/prātipadika (Gita only).' },
      isSarvanama: { type: 'boolean', description: 'Restrict to pronouns (सर्वनाम).' },
      karaka_role: { type: 'string', description: 'kāraka role, e.g. कर्ता, कर्म, करणम्, सम्प्रदानम्, अपादानम्, अधिकरणम्, विशेषणम्.' },
      dhatu: { type: 'string', description: 'verbal root — every text except BS (bhāṣya-only). Give the bare root (कृ, गम्, दृश्, रूप्) to match every sense; for ONE sense of a homonymous root give the facet label from list_values(dhatu), e.g. "अस् (असुँ क्षेपणे)" (throw) vs "अस् (असँ भुवि)" (be), or the dhātupāṭha form (असुँ). Also accepts the upasarga form (प्र-नम्). Result rows show the full root entry (gaṇa code, kṛt chain).' },
      krt_pratyaya: { type: 'string', description: 'kṛt suffix, e.g. क्त, क्तिन्, शतृ, ल्युट् (from morphology or कृत् peel layer).' },
      taddhita_pratyaya: { type: 'string', description: 'taddhita suffix, e.g. मतुप्, तसिल्, वति (from तद्धित peel layer).' },
      voice: { type: 'string', description: 'clause voice of the governing verb, e.g. कर्तरि, कर्मणि, भावे.' },
      transitivity: { type: 'string', description: 'सकर्मकः / अकर्मकः.' },
      meaning_contains: { type: 'string', description: 'substring of the English gloss.' },
      limit: { type: 'integer', description: 'max hits (default 50; -1 = all).' },
      count_only: { type: 'boolean', description: 'return only the count.' },
    } },
  },
  {
    name: 'find_compounds',
    description: 'Query the recursive samāsa peel: filter by samāsa type, peel depth (layers), ' +
      'final-member pratyaya, a member/vigraha substring, or a governing sūtra number. Returns each ' +
      'compound occurrence with its full layer-by-layer peel and per-layer sūtra, cited (text·ref·word). ' +
      'Covers all analysed texts INCLUDING Vicārasāgara (VS); use ref_prefix to scope to a chapter/taraṅga.',
    parameters: { type: 'object', properties: {
      text: { type: 'string' },
      ref_prefix: { type: 'string', description: 'chapter/division ref prefix, e.g. "6" = VS taraṅga 6 (matches 6.317).' },
      type: { type: 'string', description: 'samāsa type substring, e.g. षष्ठी-तत्पुरुष, बहुव्रीहि, द्वन्द्व, कर्मधारय, अव्ययीभाव, तद्धित.' },
      min_layers: { type: 'integer', description: 'minimum peel depth (e.g. 4 for deeply nested).' },
      max_layers: { type: 'integer' },
      final_pratyaya: { type: 'string', description: 'final-member kṛt/taddhita suffix, e.g. अण्, क्त, घञ्.' },
      member_contains: { type: 'string', description: 'substring occurring in any member or its vigraha.' },
      sutra_num: { type: 'string', description: 'Aṣṭādhyāyī sūtra number, e.g. 2.2.8.' },
      limit: { type: 'integer' }, count_only: { type: 'boolean' },
    } },
  },
  {
    name: 'find_sandhi',
    description: 'Find sandhi junctions by sūtra number, rule code, or the surface before/after strings. ' +
      'Coverage note: sandhi is present for Gita, VC, PD, AB only.',
    parameters: { type: 'object', properties: {
      text: { type: 'string' },
      sutra_num: { type: 'string', description: 'e.g. 6.1.101, 6.1.109.' },
      rule: { type: 'string', description: 'internal rule code, e.g. SVD, PVR, ABT.' },
      before: { type: 'string', description: 'substring of a pre-sandhi word.' },
      after: { type: 'string', description: 'substring of the fused surface.' },
      limit: { type: 'integer' }, count_only: { type: 'boolean' },
    } },
  },
  {
    name: 'find_relational',
    description: 'Query the kāraka / relational web extracted from clause clusters. Returns edges ' +
      '(word → governor) for the requested relation, cited per verse.',
    parameters: { type: 'object', properties: {
      relation: { type: 'string', description: 'one of: qualifierOf, genitiveOf, uddeshya-vidheya, ' +
        'samuccaya, karta, karma, hetu, upamana, upameya, karana, sampradana, apadana, adhikarana, ' +
        'satisaptami, nirdharana, sambodhana, pratishedha, sequence, itthambhuta, impliedKaraka, modifiers, nipata.' },
      text: { type: 'string' },
      limit: { type: 'integer' }, count_only: { type: 'boolean' },
    }, required: ['relation'] },
  },
  {
    name: 'find_clauses',
    description: 'Query clause structure / vākya-vibhāga (sentence decomposition): filter by clause type ' +
      '(main/relative/correlative/subordinate/nominal/quotation), whether it is subordinate, whether it has ' +
      'an elided/unstated word (elision, anukta-kartā / adhyāhāra), or by how many clauses the whole sentence ' +
      'decomposes into (min_clauses/max_clauses — use to find complex multi-clause sentences for decomposition ' +
      'practice). Each hit reports clauseCount (total clauses in the verse). Clause structure is richest for ' +
      'the Gemini-analysed texts. To see a sentence\'s FULL decomposition (all clauses + kāraka trace), use get_verse.',
    parameters: { type: 'object', properties: {
      type: { type: 'string' }, subordinate: { type: 'boolean' }, elided: { type: 'boolean' },
      min_clauses: { type: 'integer', description: 'verse decomposes into at least this many clauses' },
      max_clauses: { type: 'integer', description: 'verse decomposes into at most this many clauses' },
      text: { type: 'string' }, limit: { type: 'integer' }, count_only: { type: 'boolean' },
    } },
  },
  {
    name: 'find_virodha',
    description: 'Find the विरोधपरिहारः passages — places where an APPARENT contradiction (one subject given opposed ' +
      'predicates: moves/unmoving, far/near, minute/vast, acts/does not act, unborn/born, knowable/unknowable …) is ' +
      'resolved by the text. Curated from the mūla, Śaṅkara\'s bhāṣya and Ānandagiri\'s ṭīkā (a reconciliation stated ' +
      'only by Ānandagiri is marked parihara_source=tika); 31 units across Īśa, Kena, Kaṭha, Muṇḍaka, Māṇḍūkya-kārikā, ' +
      'Bṛhad, Gītā and the Brahmasūtra — a candidate set under expert review. Each hit gives the paradox pairs, the two ' +
      'sides in Śaṅkara\'s own words, how each side is grounded (mode), the reconciling statement and who states it, and ' +
      'other passages with the same paradox. Filter by theme (motion_space, scale, knowing, agency, attributes, ' +
      'one_many, birth, being_nonbeing, deep_sleep, identity_difference, other), mode (upAdhikRta, avidyAkalpita, ' +
      'upAsanArtha, iva, dRShTi, svena_rUpeNa, niSedha, viduSAm_aviduSAm, different_respects, cause_effect, other), ' +
      'parihara_source (bhashya | mula | tika | implicit), text, ref_prefix or keyword.',
    parameters: { type: 'object', properties: {
      theme: { type: 'string', description: 'paradox theme, e.g. motion_space, scale, knowing, agency, attributes, birth, deep_sleep.' },
      mode: { type: 'string', description: 'how a side is grounded, e.g. upAdhikRta, iva, upAsanArtha, dRShTi, svena_rUpeNa.' },
      parihara_source: { type: 'string', description: 'who states the reconciliation: bhashya | mula | tika | implicit' },
      text: { type: 'string', description: 'restrict to one text key, e.g. Isha, Brha, Gita, BS, Kathaka.' },
      ref_prefix: { type: 'string', description: 'restrict to a chapter/division ref prefix, e.g. "13".' },
      keyword: { type: 'string', description: 'Devanāgarī or English substring searched in the paradox line, side labels and parihāra.' },
      limit: { type: 'integer' }, count_only: { type: 'boolean' },
    } },
  },
  {
    name: 'find_mahavakya',
    description: 'Find the mahāvākyas / identity equations (jīva = brahman) in the corpus — a ' +
      'human-verified śāstric catalog (188 verses across 16 texts + VS). Each hit reports its sub-type and a ' +
      'classification label. Sub-types: mukhya (direct aikya identity — tat tvam asi, ahaṃ brahmāsmi, ayam ' +
      'ātmā brahma, so\'ham asmi) and badhayam (identity via sublation — the world/witness resolved into ' +
      'brahman, often with a dṛṣṭānta like clay-pot or rope-snake). Filter by subtype and/or text; omit ' +
      'both to list them all. (This is curated identity-statement data, distinct from search_moola\'s raw ' +
      'phrase search.)',
    parameters: { type: 'object', properties: {
      subtype: { type: 'string', description: 'mukhya | badhayam' },
      text: { type: 'string', description: 'restrict to one text key, e.g. Chandogya, Brha, VC, Gita, VS.' },
      ref_prefix: { type: 'string', description: 'restrict to a chapter/division ref prefix, e.g. "6.8".' },
      limit: { type: 'integer' }, count_only: { type: 'boolean' },
    } },
  },
  {
    name: 'search_bhasya',
    description: 'Keyword and/or rhetorical-role search over the commentary reading annotation (Śaṅkara-bhāṣya ' +
      'on śruti; Candraśekhara-bhāṣya on the Vivekacūḍāmaṇi). Roles: mula (quoted pratīka), gloss, import ' +
      '(tātparya/purport), vyakarana (grammatical note), purvapaksha, siddhanta, quote (citation), sangraha, ' +
      'ekadeshi. Coverage: Gita, BS, 10 upaniṣads (Kena has pada- & vākya-bhāṣya variants), and VC ' +
      '(Candraśekhara-bhāṣya, 477 verses). PD/AB have none.',
    parameters: { type: 'object', properties: {
      keyword: { type: 'string', description: 'Devanāgarī keyword to find in the bhāṣya. Spelling-tolerant: a word-initial vowel also matches its fused mātrā form (आनन्द finds ब्रह्मानन्द, सैषानन्दस्य; only when ≥3 letters follow, so इति stays exact), anusvāra ≡ nasal+virāma, avagraha ignored. To find DISCUSSIONS of a topic use find_discussions.' },
      role: { type: 'string', description: 'restrict to spans of this rhetorical role.' },
      text: { type: 'string' }, limit: { type: 'integer' }, count_only: { type: 'boolean' },
    } },
  },
  {
    name: 'find_discussions',
    description: 'WHERE DOES THE BHĀṢYA DISCUSS a topic (a vicāra), as opposed to merely mentioning a word? Use for ' +
      '"which places in the bhāṣya do a vicāra on ānanda / on karma / …". Ranks candidate DISCUSSIONS: consecutive ' +
      'bhāṣya passages (same text) that contain any keyword are merged into one unit (e.g. BS 1.1.12–1.1.19 comes back ' +
      'as one), then scored = 2·log2(1+occurrences) + 0.3·min(density per 1000 chars, 15) + 1.5·min(pūrvapakṣa/' +
      'siddhānta/ekadeśī spans containing a keyword, 10) + 2·min(excerpts containing an inquiry marker, 6). Inquiry ' +
      'markers: संशय, विचार्यते/विचारणा, मीमांसा, ननु, इति चेत्/चेन्न, उच्यते, किम्…उत — counted only inside the ' +
      'keyword\'s own excerpt. Each discussion returns its signals, up to 3 KEY SENTENCES, and — for a multi-passage ' +
      'unit — CLOSING SENTENCES from its last passage. READ THE CLOSING SENTENCES BEFORE STATING A CONCLUSION: Śaṅkara ' +
      'may set out a view and overturn it at the end of the same unit (BS 1.1.12–18 argue ānandamaya = Brahman; 1.1.19 ' +
      'rejects that — the referent is ‘ब्रह्म पुच्छं प्रतिष्ठा’). For BS, a unit = one ADHIKARAṆA and carries `adhikarana` ' +
      '= the Vaiyāsika-nyāya-mālā digest VERBATIM (name, pāda, ordinal, kārikās, and VNM\'s own view labels such as ' +
      '“…एकदेशिमतेन आह” / “इदानीं स्वमतानुसारेण…”): state as Śaṅkara\'s conclusion ONLY the view VNM gives as the ' +
      'siddhānta / स्वमत — NEVER a view VNM labels एकदेशि (one-sided) or pūrvapakṣa; take adhikaraṇa names/positions ' +
      'from this field, not from memory. Matching is ' +
      'spelling-tolerant (आनन्द also finds ब्रह्मानन्द / सैषानन्दस्य). PASS SYNONYMS as separate keywords (e.g. ' +
      '["आनन्द","सुख"] — the bhūmā-vidyā Chāndogya 7.23 says सुख, not आनन्द). A hit inside a pair-of-opposites word ' +
      '(सुखदुःख, शीतोष्ण, रागद्वेष) is about the pair, not the topic: such units are scaled down by (1 − 0.7 × pairedShare) ' +
      'and report signals.pairedOpposites / pairedShare — a unit with a high pairedShare is usually NOT a discussion of the ' +
      'keyword itself. Read past the first few results: real discussions can rank 15th–25th. The score only ranks candidates: YOU must read the key sentences and decide which are real ' +
      'vicāras (saṃśaya → pūrvapakṣa → siddhānta on the topic itself) vs. passing mentions or quotations, and say so. ' +
      'Coverage = the bhāṣya in this corpus (Śaṅkara on BS, Gītā, 10 upaniṣads; Candraśekhara on VC). For what the ' +
      'ṭīkās / vārttikas / Gītā verse-commentaries / prakaraṇa commentaries say, use search_commentary / get_commentary.',
    parameters: { type: 'object', properties: {
      keywords: { type: 'array', items: { type: 'string' }, description: 'Devanāgarī keyword(s) / synonyms, e.g. ["आनन्द","सुख"].' },
      text: { type: 'string', description: 'restrict to one text key, e.g. BS, Brha, Taitiriya, Gita, VC.' },
      ref_prefix: { type: 'string', description: 'restrict to a chapter/division ref prefix, e.g. "1.1".' },
      limit: { type: 'integer', description: 'max discussions (default 15; -1 = all).' },
      min_score: { type: 'number', description: 'drop discussions scoring below this.' },
      bridge: { type: 'integer', description: 'let a discussion jump this many hit-less passages (default 0; >0 merges passing mentions).' },
    }, required: ['keywords'] },
  },
  {
    name: 'search_commentary',
    description: 'Search the COMMENTARY LAYER — every commentary beyond the bhāṣya: Ānandagiri\'s ṭīkās (all 10 upaniṣads + ' +
      'Gītā; on BS = Nyāyanirṇaya), Ratnaprabhā + Pūrṇānandī and Brahmatattvaprakāśikā and the full Vaiyāsika-nyāya-mālā (BS), ' +
      'Vanamālā (Taittirīya), Sureśvara\'s vārttikas (Bṛhad, Taittirīya) + Śāstraprakāśikā, the Bṛhad Vārtikasāra + ṭīkā, the ' +
      'Gītā verse-commentaries (Śrīdharī, Madhusūdanī, Nīlakaṇṭhī, Bhāṣyotkarṣadīpikā, Śaṅkarānandī, Bhāṣyārka), and the ' +
      'prakaraṇa commentaries (PD Pada-dīpikā, AB Padmapāda, US Gaṇapati Muni, SD Kapālī Śāstrī). Use for "what does ' +
      'Ānandagiri / Madhusūdana / the vārttika say about X". Keyword matching is spelling-tolerant like search_bhasya. ' +
      'Each hit = one commentary block on base text + ref, with title, layer and excerpts. list_values(facet="commentary_work") ' +
      'lists the work ids. count_by_work=true returns occurrences per work instead of hits.',
    parameters: { type: 'object', properties: {
      keyword: { type: 'string', description: 'Devanāgarī keyword (spelling-tolerant).' },
      work: { type: 'string', description: 'restrict to a work id, e.g. anandagiri-brihad, nyayanirnaya, ratnaprabha, madhusudani-gita, brihad-vartika (see list_values commentary_work).' },
      text: { type: 'string', description: 'restrict to commentaries on one base text key, e.g. BS, Gita, Brha, Taitiriya.' },
      ref_prefix: { type: 'string', description: 'restrict to a chapter/division ref prefix of the base text, e.g. "1.1".' },
      limit: { type: 'integer', description: 'max hits (default 50; -1 = all).' },
      count_only: { type: 'boolean', description: 'return only the number of matching blocks.' },
      count_by_work: { type: 'boolean', description: 'return occurrences per work (which commentaries discuss this most).' },
    }, required: ['keyword'] },
  },
  {
    name: 'get_commentary',
    description: 'Read what the commentaries say on ONE verse/sūtra/mantra of a base text: every commentary-layer work with a ' +
      'block at exactly that ref (e.g. BS 1.1.19 → Nyāyanirṇaya, Ratnaprabhā, Brahmatattvaprakāśikā; Gita 2.47 → Ānandagiri, ' +
      'Śrīdharī, Madhusūdanī, …). Text per work is capped at max_chars (default 4000; truncated=true when cut). The bhāṣya itself ' +
      'comes from get_verse.',
    parameters: { type: 'object', properties: {
      text: { type: 'string', description: 'base text key, e.g. BS, Gita, Brha, Taitiriya, PD, AB, UPS, SAD.' },
      ref: { type: 'string', description: 'exact ref, e.g. "1.1.19", "2.47", "3.9.28".' },
      work: { type: 'string', description: 'optional: only this work id.' },
      max_chars: { type: 'integer', description: 'cap per work (default 4000).' },
    }, required: ['text', 'ref'] },
  },
  {
    name: 'search_moola',
    description: 'Free-text phrase search over the mūla (verse text itself) — "which verse says X?". ' +
      'The mūla is stored in PADACCHEDA form (words split, samāsa members hyphenated), so a query in ' +
      'either padaccheda ("आत्मा एव इदम्") or space-collapsed form ("इदंसर्वम्") hits the same verse; ' +
      'each hit reports matchMode (exact | normalized | tokens) plus a snippet and the full mūla. ' +
      'Covers ALL 14 texts + VS. NOTE: does not bridge vowel-sandhi across a word split — a single ' +
      'sandhi\'d word like आत्मैवेदं (=आत्मा एव इदम्) must be queried split or in padaccheda form. ' +
      'A 4th tier, matchMode "spelling", tolerates a word-initial vowel written as a fused mātrā (आ≡ा …), anusvāra ≡ nasal+virāma and avagraha. ' +
      'For an exact (text, ref) lookup use get_verse; for grammatical word filters use query_words.',
    parameters: { type: 'object', properties: {
      phrase: { type: 'string', description: 'Devanāgarī phrase to find in the mūla, e.g. "इदं सर्वं यदयमात्मा" or "आत्मा एव इदम्".' },
      text: { type: 'string', description: 'Restrict to one text key (e.g. Brha, Chandogya, VC, Gita, VS).' },
      ref_prefix: { type: 'string', description: 'Restrict to a chapter/division by ref prefix, e.g. "2.4".' },
      limit: { type: 'integer', description: 'max hits (default 50; -1 = all).' },
      count_only: { type: 'boolean', description: 'return only the count.' },
    }, required: ['phrase'] },
  },
  {
    name: 'find_by_sutra',
    description: 'Find every place an Aṣṭādhyāyī sūtra is cited in the corpus — sandhi operations, samāsa ' +
      'peel layers, AND the two-layer vibhakti-vidhāna (the sūtra ordaining a word’s CASE, e.g. 2.3.29 ' +
      'anya-yoge, 2.3.52 kāraka-ṣaṣṭhī) — cited per verse (kind: sandhi | samasa | vibhakti).',
    parameters: { type: 'object', properties: {
      num: { type: 'string', description: 'sūtra number, e.g. 2.2.8, 6.1.101.' },
      text: { type: 'string' }, limit: { type: 'integer' }, count_only: { type: 'boolean' },
    }, required: ['num'] },
  },
  {
    name: 'list_values',
    description: 'List the distinct values (with occurrence counts) for a facet across the corpus (or one text). ' +
      'Great for discovery ("what kāraka roles / samāsa types / pratyayas exist?").',
    parameters: { type: 'object', properties: {
      facet: { type: 'string', description: 'one of: case, vibhakti_sutra, vibhakti_type, vacana, linga, lemma, karaka_role, dhatu, voice, ' +
        'transitivity, clause_type, clause_count, krt_pratyaya, taddhita_pratyaya, samasa_category, samasa_type, sutra, ' +
        'sandhi_rule, relation, bhasya_role, mahavakya, virodha_theme, virodha_mode, virodha_source, text, chapter, ' +
        'commentary_work (the ṭīkās/vārttikas/verse-commentaries searchable with search_commentary, with title + base text). ' +
        '(vibhakti_sutra/vibhakti_type = the two-layer rule ordaining a word’s CASE, e.g. 2.3.29 anya-yoge; VC+AB only so far.)' },
      text: { type: 'string' },
      ref_prefix: { type: 'string', description: 'restrict to a chapter/division ref prefix, e.g. "6" = VS taraṅga 6.' },
      limit: { type: 'integer', description: 'top-N by count (default all).' },
    }, required: ['facet'] },
  },
  {
    name: 'count_by',
    description: 'Distribution of a facet; set by_text:true to break the counts down per text. ' +
      'Same facets as list_values.',
    parameters: { type: 'object', properties: {
      facet: { type: 'string' }, by_text: { type: 'boolean' }, text: { type: 'string' },
      ref_prefix: { type: 'string', description: 'restrict to a chapter/division ref prefix, e.g. "6" = VS taraṅga 6.' },
      limit: { type: 'integer' },
    }, required: ['facet'] },
  },
  {
    name: 'get_verse',
    description: 'Return the full consolidated record for one (text, ref): mūla, every word with its ' +
      'morphology/kāraka/meaning/peel, sandhi, clause clusters, relations, and bhāṣya spans.',
    parameters: { type: 'object', properties: {
      text: { type: 'string' }, ref: { type: 'string' },
    }, required: ['text', 'ref'] },
  },
  {
    name: 'corpus_stats',
    description: 'Top-level coverage snapshot: per-text verse/word/relation/bhāṣya counts, sources, and ' +
      'provenance (kāraka source, gloss source).',
    parameters: { type: 'object', properties: {} },
  },
];

// map name -> fn for a generic dispatcher (handy for a function-calling loop)
const TOOLS = { query_words, find_compounds, find_sandhi, find_relational, find_clauses,
  find_mahavakya, find_virodha, search_bhasya, find_discussions, search_moola, find_by_sutra, list_values, count_by, get_verse, corpus_stats,
  search_commentary, get_commentary };
function callTool(c, name, args) {
  const fn = TOOLS[name];
  if (!fn) throw new Error('unknown tool: ' + name);
  return fn(c, args || {});
}

module.exports = { loadCorpus, commentaryOf, TOOL_SCHEMAS, TOOLS, callTool,
  query_words, find_compounds, find_sandhi, find_relational, find_clauses,
  find_mahavakya, find_virodha, search_bhasya, find_discussions, search_moola, find_by_sutra, list_values, count_by, get_verse, corpus_stats,
  search_commentary, get_commentary };
