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
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------
const DEFAULT_LIMIT = 50;
function contains(hay, needle) {
  if (hay == null || needle == null) return false;
  return String(hay).indexOf(String(needle)) !== -1;
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
// iterate verses (optionally filtered to one text or a list)
function verses(c, textFilter) {
  if (!textFilter) return c.verses;
  const set = Array.isArray(textFilter) ? new Set(textFilter) : new Set([textFilter]);
  return c.verses.filter(v => set.has(v.text));
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
  for (const v of verses(c, a.text)) {
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
      if (a.dhatu && !(w.dhatu && eqOrIn(w.dhatu.root, a.dhatu))) continue;
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
  for (const v of verses(c, a.text)) {
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
  for (const v of verses(c, a.text)) {
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
  for (const v of verses(c, a.text)) {
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
  for (const v of verses(c, a.text)) {
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
// TOOL: search_bhasya — keyword + rhetorical-role search over Śaṅkara-bhāṣya
// ===========================================================================
function search_bhasya(c, a) {
  a = a || {};
  const hits = [];
  for (const v of verses(c, a.text)) {
    for (const b of (v.bhasya || [])) {
      // role filter: keep spans of that role; keyword filter within (or whole text)
      let spans = b.spans || [];
      if (a.role) spans = spans.filter(s => s.role === a.role);
      if (a.role && !spans.length) continue;
      if (a.keyword) {
        const inSpans = spans.filter(s => contains(s.text, a.keyword));
        const inFull = contains(b.text, a.keyword);
        if (a.role) { if (!inSpans.length) continue; spans = inSpans; }
        else if (!inFull) continue;
      }
      hits.push(Object.assign(citeVerse(v), {
        variant: b.variant || null,
        matchedSpans: (a.role || a.keyword)
          ? spans.filter(s => !a.keyword || contains(s.text, a.keyword))
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
// TOOL: find_by_sutra — every citation of an Aṣṭādhyāyī sūtra (sandhi + samāsa)
// ===========================================================================
function find_by_sutra(c, a) {
  a = a || {};
  const num = a.num;
  const hits = [];
  for (const v of verses(c, a.text)) {
    for (const s of (v.sandhi || [])) {
      if (s.sutra === num) hits.push(Object.assign(citeVerse(v),
        { kind: 'sandhi', rule: s.rule, before: s.before, after: s.after, context: v.moola }));
    }
    for (const w of v.words) {
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
  vacana:          v => v.words.filter(w => w.vacana).map(w => w.vacana),
  linga:           v => v.words.filter(w => w.linga).map(w => w.linga),
  lemma:           v => v.words.filter(w => w.lemma != null).map(w => w.lemma),
  karaka_role:     v => v.words.flatMap(w => w.karakaRoles || []),
  dhatu:           v => v.words.filter(w => w.dhatu && w.dhatu.root).map(w => w.dhatu.root),
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
  text:            v => [v.text],
};

// ===========================================================================
// TOOL: list_values — distinct values + counts for any facet
// ===========================================================================
function list_values(c, a) {
  a = a || {};
  const fn = FACETS[a.facet];
  if (!fn) return { error: 'unknown facet: ' + a.facet, facets: Object.keys(FACETS) };
  const counts = {};
  for (const v of verses(c, a.text)) {
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
  for (const v of verses(c, a.text)) {
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
  return { found: true, verse: v };
}
function normalizeRef(ref) {
  return String(ref).split('.').map(s => /^\d+$/.test(s.trim()) ? String(parseInt(s, 10)) : s.trim()).join('.');
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
      'Coverage note: dhatu/krt/lemma are only populated for the Bhagavad-gītā; meaning/case/' +
      'vacana/linga/karaka_role/samasa cover all analysed texts.',
    parameters: { type: 'object', properties: {
      text: { type: 'string', description: 'Restrict to one text key (e.g. VC, PD, Gita, Chandogya, Brha).' },
      case: { type: 'string', description: 'vibhakti in Devanāgarī, e.g. तृतीया, षष्ठी, सप्तमी.' },
      vacana: { type: 'string', description: 'एकवचन / द्विवचन / बहुवचन.' },
      linga: { type: 'string', description: 'पुंलिङ्ग / स्त्रीलिङ्ग / नपुंसकलिङ्ग.' },
      lemma: { type: 'string', description: 'Exact stem/prātipadika (Gita only).' },
      isSarvanama: { type: 'boolean', description: 'Restrict to pronouns (सर्वनाम).' },
      karaka_role: { type: 'string', description: 'kāraka role, e.g. कर्ता, कर्म, करणम्, सम्प्रदानम्, अपादानम्, अधिकरणम्, विशेषणम्.' },
      dhatu: { type: 'string', description: 'verbal root (Gita only), e.g. कृ, गम्.' },
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
      'compound occurrence with its full layer-by-layer peel and per-layer sūtra, cited (text·ref·word).',
    parameters: { type: 'object', properties: {
      text: { type: 'string' },
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
    name: 'search_bhasya',
    description: 'Keyword and/or rhetorical-role search over the Śaṅkara-bhāṣya (reading annotation). ' +
      'Roles: mula, gloss, import, vyakarana (grammatical note), purvapaksha, siddhanta, quote, sangraha, ' +
      'ekadeshi. Coverage: Gita, BS, 10 upaniṣads (Kena has pada- & vākya-bhāṣya variants). VC/PD/AB have none.',
    parameters: { type: 'object', properties: {
      keyword: { type: 'string', description: 'Devanāgarī substring to find in the bhāṣya.' },
      role: { type: 'string', description: 'restrict to spans of this rhetorical role.' },
      text: { type: 'string' }, limit: { type: 'integer' }, count_only: { type: 'boolean' },
    } },
  },
  {
    name: 'find_by_sutra',
    description: 'Find every place an Aṣṭādhyāyī sūtra is cited in the corpus — both sandhi operations ' +
      'and samāsa peel layers — cited per verse.',
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
      facet: { type: 'string', description: 'one of: case, vacana, linga, lemma, karaka_role, dhatu, voice, ' +
        'transitivity, clause_type, clause_count, krt_pratyaya, taddhita_pratyaya, samasa_category, samasa_type, sutra, ' +
        'sandhi_rule, relation, bhasya_role, text.' },
      text: { type: 'string' }, limit: { type: 'integer', description: 'top-N by count (default all).' },
    }, required: ['facet'] },
  },
  {
    name: 'count_by',
    description: 'Distribution of a facet; set by_text:true to break the counts down per text. ' +
      'Same facets as list_values.',
    parameters: { type: 'object', properties: {
      facet: { type: 'string' }, by_text: { type: 'boolean' }, text: { type: 'string' },
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
  search_bhasya, find_by_sutra, list_values, count_by, get_verse, corpus_stats };
function callTool(c, name, args) {
  const fn = TOOLS[name];
  if (!fn) throw new Error('unknown tool: ' + name);
  return fn(c, args || {});
}

module.exports = { loadCorpus, TOOL_SCHEMAS, TOOLS, callTool,
  query_words, find_compounds, find_sandhi, find_relational, find_clauses,
  search_bhasya, find_by_sutra, list_values, count_by, get_verse, corpus_stats };
