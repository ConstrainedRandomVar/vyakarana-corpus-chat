#!/usr/bin/env node
// ===========================================================================
// Vyākaraṇa Corpus Assistant — Render web app.
//
// Serves a chat page + runs the model's FUNCTION-CALLING loop server-side over
// the deterministic corpus tools (corpus-tools.js) against corpus.json held in
// memory. Every answer is grounded in real tool output — exact, cited, no
// hallucinated numbers. This is corpus-chat.js turned into a shareable web app.
//
// PROVIDER (LLM_PROVIDER): 'gemini' (default) or 'anthropic'. One codebase, two Render services —
//   the Claude one sets LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY (+ ANTHROPIC_MODEL, ANTHROPIC_EFFORT).
//
// GEMINI AUTH (two modes, auto-detected):
//   • GEMINI_API_KEY set  → Google AI Studio (Generative Language API) — the
//     free-tier path used on Hugging Face. Set it as a Space *secret*.
//   • else                → Vertex AI via a local `gcloud` access token (for
//     running/testing on Harsha's machine; NOT available in the HF container).
//
// ENV: LLM_PROVIDER, GEMINI_API_KEY, GEMINI_MODEL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_EFFORT, PORT,
//      ACCESS_PASSWORD (optional gate), CORPUS_PATH, TOOLS_PATH,
//      GEMINI_PROJECT/GEMINI_REGION (Vertex local mode only).
// ===========================================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const T = require(process.env.TOOLS_PATH || './corpus-tools.js');
const CORPUS_PATH = process.env.CORPUS_PATH || path.join(__dirname, 'corpus.json');
const corpus = T.loadCorpus(CORPUS_PATH);
// commentary layer (commentary.json.gz beside the corpus) loaded at boot, not mid-request; then drop the parse garbage.
// Start with `node --expose-gc --max-old-space-size=300 server.js` (package.json/render.yaml): live data ≈ 195 MB, and the
// cap + gc keep the process well under Render's 512 MB (measured 2026-10-26).
const commentary = T.commentaryOf ? T.commentaryOf(corpus) : null;
if (global.gc) global.gc();
const stats = T.corpus_stats(corpus);

const PORT = process.env.PORT || 7860;
const PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
const USE_CLAUDE = PROVIDER === 'anthropic';
const API_KEY = process.env.GEMINI_API_KEY || '';
const USE_AISTUDIO = !!API_KEY;
const MODEL = USE_CLAUDE ? (process.env.ANTHROPIC_MODEL || 'claude-opus-5-5')
  : (process.env.GEMINI_MODEL || (USE_AISTUDIO ? 'gemini-3.5-flash-lite' : 'gemini-3.7-flash'));
const EFFORT = process.env.ANTHROPIC_EFFORT || 'high';   // low | medium | high | xhigh | max
const PASSWORD = process.env.ACCESS_PASSWORD || '';
const MAX_STEPS = USE_CLAUDE ? 12 : 8;
const MAX_ROWS_TO_MODEL = 40;

// ---- Vertex (local) config -------------------------------------------------
const V_PROJ = process.env.GEMINI_PROJECT || 'devanagari-506415';
const V_REGION = process.env.GEMINI_REGION || 'global';
const V_HOST = V_REGION === 'global' ? 'aiplatform.googleapis.com' : `${V_REGION}-aiplatform.googleapis.com`;
const V_ENDPOINT = `https://${V_HOST}/v1/projects/${V_PROJ}/locations/${V_REGION}/publishers/google/models/${MODEL}:generateContent`;
let _tok = null, _tokAt = 0;
function vertexToken() {
  if (_tok && (Date.now() - _tokAt) < 25 * 60 * 1000) return _tok;
  _tok = cp.execSync('gcloud auth print-access-token',
    { env: { ...process.env, CLOUDSDK_CONFIG: require('os').homedir() + '/.config/gcloud-personal' } }).toString().trim();
  _tokAt = Date.now();
  return _tok;
}

// ===========================================================================
// System prompt — same contract as corpus-chat.js (ground, cite, respect coverage)
// ===========================================================================
const SYSTEM_PROMPT = `You are the Vyākaraṇa Corpus Assistant for the Vedāntic Vyākaraṇa Academy.
You answer natural-language questions about a machine-analysed Sanskrit corpus of 18 texts (Bhagavad-gītā,
10 principal Upaniṣads, Brahmasūtra-bhāṣya, Vivekacūḍāmaṇi, Pañcadaśī, Ātmabodha, Upadeśa Sāram, Saddarśanam,
Vicārasāgara) covering per-word
morphology, vibhakti, kāraka roles, recursive samāsa peel, sandhi, clause structure, kāraka relations, and
Śaṅkara-bhāṣya rhetorical roles.

HARD RULES
1. GROUND EVERYTHING IN TOOLS. Never state a count, form, sūtra, or example from memory — call a tool and use
   only what it returns. If no tool fits, say so plainly.
2. CITE every example exactly as the tool returns it: text · ref · word. When a tool row carries "link", make the ref a
   Markdown link to it, copied exactly — e.g. [BS 1.1.19](reading-bs-1.html#v-1.1.19) — so the reader can open the passage.
3. RESPECT COVERAGE and state the limit when relevant:
   • dhātu (verbal root) covers every text with word rows; lemma likewise except VS; kṛt pratyayas come from the Gītā
     morphology plus every text's samāsa peel / kṛt chain. • VS (Vicārasāgara, reading-only prose) has words, meaning,
     dhātu and samāsa — no case/kāraka/clauses.
   • sandhi exists for Gita, VC, PD, AB, SAD, UPS only. • bhāṣya (in get_verse / search_bhasya / find_discussions) exists for Gita,
     BS, the 10 Upaniṣads (Śaṅkara) and VC (Candraśekhara); PD/AB/SD/US commentaries are in the commentary layer; VS has none.
   • Beyond the bhāṣya, the COMMENTARY LAYER (search_commentary / get_commentary) holds Ānandagiri's ṭīkās (10 upaniṣads,
     Gītā; BS = Nyāyanirṇaya), Ratnaprabhā + Pūrṇānandī, Brahmatattvaprakāśikā, the full Vaiyāsika-nyāya-mālā, Vanamālā,
     Sureśvara's vārttikas + Śāstraprakāśikā, the Bṛhad Vārtikasāra + ṭīkā, the Gītā verse-commentaries (Śrīdharī,
     Madhusūdanī, Nīlakaṇṭhī, Bhāṣyotkarṣadīpikā, Śaṅkarānandī, Bhāṣyārka) and the PD/AB/US/SD commentaries. Name the
     commentator when you quote one; never present a ṭīkā's words as Śaṅkara's.
   • BS is bhāṣya-only. • BG kāraka = UoHyd e-reader (~57% reliable); for hetau-pañcamī prefer the bhāṣya route.
   • Some Upaniṣads carry two ref schemes; word-hit vs relation-hit may cite different refs — both are true.
   • VC voice values are partly garbled in the source (e.g. "कर्तरi") — treat as noise.
4a. SCRIPT + QUOTES. Write Sanskrit ONLY in Devanāgarī, or in IAST (Latin letters with standard diacritics) — never
   Arabic/Perso-Arabic, Hebrew, Cyrillic or any other script, and no stray combining marks. Every Sanskrit QUOTE must
   be copied character-for-character from a tool result (an excerpt / key sentence / context) — never retyped,
   reconstructed or "corrected" from memory; if you have no tool excerpt for it, paraphrase without quotation marks.
   Do not coin Sanskrit glosses or technical terms that are not in the tool output.
4. USE DEVANĀGARĪ for all grammatical facet values (cases, roles, pratyayas, samāsa types).
5. DISCOVER first with list_values(facet) if unsure what values exist.
5a. "Where does the bhāṣya DISCUSS / do a vicāra on X?" → find_discussions with the term AND its synonyms as separate
   keywords (e.g. ["आनन्द","सुख"]). It ranks merged passage-units with signals + key sentences; READ the key sentences and
   say which are real vicāras (saṃśaya / pūrvapakṣa / siddhānta on the topic itself) and which are passing mentions or
   quotations — the score alone does not decide. search_bhasya / search_moola are spelling-tolerant (आनन्द also matches
   the fused ब्रह्मानन्द, सैषानन्दस्य), so don't re-query the mātrā form.
   DISCUSSION ANSWERS (find_discussions): (i) do NOT restrict to one text unless the user asks — rank across every
   text the tool returns (e.g. for ānanda the Taittirīya 2.5–2.9 unit — ānandamaya kośa + ānanda-mīmāṃsā — belongs
   near the top, beside BS 1.1.12–19 and Bṛhad 3.9.28); (ii) before stating a unit's conclusion, READ its
   closingSentences — Śaṅkara may present a view and overturn it at the end (BS 1.1.12–18 argue ānandamaya = Brahman;
   1.1.19 rejects it: the referent is ‘ब्रह्म पुच्छं प्रतिष्ठा’, the ānandamaya is a kośa); state the FINAL position;
   (iii) do not name adhikaraṇas or their position ("the opening adhikaraṇa") from memory — only what the tool shows.
   (iv) BS units carry "adhikarana" (the Vaiyāsika-nyāya-mālā digest): adhikarana.finalPosition.sloka IS Śaṅkara's
   conclusion for that adhikaraṇa — state it, and quote that śloka verbatim. A view marked एकदेशिमत in adhikarana.views is
   NOT his conclusion, even where its own siddhānta śloka sounds final (BS 1.1.12–19: kārikā 26 'ब्रह्मानन्दमयो भवेत्' is
   the ekadeśī's; Śaṅkara's is kārikā 28 — ब्रह्म पुच्छं is the support, the ānandamaya is the jīva/kośa).
6. Prefer 3–8 vivid cited examples + the true total (use count_only/count_by) over dumping everything; say how many matched.
7. FORMAT answers in plain Markdown (headings, **bold**, bullet/numbered lists). Do NOT use LaTeX or math notation — no $...$, \\rightarrow, \\sqrt, \\text, \\ge, \\le. Use plain Unicode instead: → ⇒ ≥ ≤ × · √. Show a samāsa peel as layer → layer → layer.

Text keys: Gita, Kena, Kathaka, Isha, Mandukya, Mundaka, Prashna, Taitiriya, Aitareya, Chandogya, Brha, BS,
VC, PD, AB (Ātmabodha), UPS (Upadeśa Sāram), SAD (Saddarśanam), VS (Vicārasāgara). Map loose names to the right key. Keep prose tight and scholarly; render Sanskrit in Devanāgarī.`;

function toolFns() { return T.TOOL_SCHEMAS.map(s => ({ name: s.name, description: s.description, parameters: s.parameters })); }

// ===========================================================================
// One generateContent call WITH tools + history (fetch; both auth modes)
// ===========================================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Rate-limit / quota (429) is NOT retryable: Gemini's own retryDelay is the per-minute free-tier
// window (20–60s), far longer than any web-request backoff — retrying just fires early, fails again,
// and burns MORE of the exhausted quota. Surface a clean "busy" message instead. Only genuine
// transient overload / 5xx / timeouts are worth a quick retry.
const RATE_LIMITED = /quota|rate limit|resource exhausted|\b429\b/i;
const RETRYABLE = /high demand|overload|unavailable|try again|deadline|timeout|temporar|\b(500|502|503|504)\b/i;
const RETRIES = 3;
const BUSY_MSG = 'The assistant is briefly rate-limited (free tier, 20 req/min). Please wait ~a minute and ask again — or ask a simpler question (each answer makes several model calls).';

async function generate(contents) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    tools: [{ functionDeclarations: toolFns() }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  };
  let url, headers = { 'Content-Type': 'application/json' };
  if (USE_AISTUDIO) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  } else {
    url = V_ENDPOINT; headers.Authorization = 'Bearer ' + vertexToken();
  }
  let lastMsg = 'unknown error';
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    let d = null, transient = false;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (res.status === 429) throw new Error(BUSY_MSG);            // rate limit — surface, never retry
      if (!res.ok && res.status >= 500) { transient = true; lastMsg = 'HTTP ' + res.status; }
      else d = await res.json();
    } catch (e) {
      if (e.message === BUSY_MSG) throw e;                          // don't swallow the busy signal into a retry
      transient = true; lastMsg = e.name === 'TimeoutError' ? 'request timed out' : String(e.message || e);
    }
    if (d && d.error) {
      lastMsg = d.error.message || JSON.stringify(d.error);
      if (RATE_LIMITED.test(lastMsg)) throw new Error(BUSY_MSG);    // quota/429 — surface, never retry
      if (!(attempt < RETRIES && RETRYABLE.test(lastMsg))) throw new Error('Gemini: ' + lastMsg);
      transient = true;
    }
    if (d && !d.error) {
      const cand = (d.candidates || [])[0] || {};
      return { content: cand.content || { parts: [] }, usage: d.usageMetadata || {}, finishReason: cand.finishReason };
    }
    if (transient && attempt < RETRIES) { await sleep(attempt * 1500 + 500); continue; } // 2s,3.5s,5s
    throw new Error('Gemini: ' + lastMsg + ' (after ' + attempt + ' tries)');
  }
}

// READING-VIEW LINKS (Harsha 2026-10-26): every tool row naming a text + ref gets `link` = its academy reading-view anchor,
// from svadhyaya-refidx.js (the search tool's ref→page map, regenerated by sync_search on deploy — copy it in with the corpus).
// Short relative links go to the model; answers get the full URL (absLinks). Unknown sub-refs fall back to the parent ref.
const ACADEMY = 'https://constrainedrandomvar.github.io/vedantic-vyakarana-academy/';
const READING_OUT = { Gita: 'gita', Isha: 'isha', Kena: 'kena', Kathaka: 'kathaka', Prashna: 'prashna', Mundaka: 'mundaka',
  Mandukya: 'mandukya', Taitiriya: 'taitiriya', Aitareya: 'aitareya', Chandogya: 'chandogya', Brha: 'brha', BS: 'bs', VC: 'vc',
  PD: 'pd', AB: 'ab', UPS: 'ups', SAD: 'sad', VS: 'vicharasagara' };
let REFIDX = {};
try { REFIDX = JSON.parse(fs.readFileSync(path.join(__dirname, 'svadhyaya-refidx.js'), 'utf8').replace(/^window\.SVADHYAYA_REFIDX=/, '').replace(/;\s*$/, '')); }
catch (e) { console.warn('no svadhyaya-refidx.js — answers will carry no reading-view links'); }
function linkFor(text, ref) {
  const m = REFIDX[READING_OUT[text]]; if (!m || ref == null) return null;
  let r = String(ref);
  for (;;) { if (m[r]) return m[r] + '#v-' + encodeURIComponent(r); const i = r.lastIndexOf('.'); if (i < 0) return null; r = r.slice(0, i); }
}
function addLinks(x, depth = 0) {
  if (!x || typeof x !== 'object' || depth > 6) return x;
  if (Array.isArray(x)) { x.forEach(y => addLinks(y, depth + 1)); return x; }
  if (typeof x.text === 'string' && READING_OUT[x.text] && !x.link) {
    const ref = x.ref != null ? x.ref : (Array.isArray(x.refs) ? x.refs[0] : null);
    const l = linkFor(x.text, ref); if (l) x.link = l;
  }
  for (const k of Object.keys(x)) if (x[k] && typeof x[k] === 'object') addLinks(x[k], depth + 1);
  return x;
}
const absLinks = t => t.replace(/\]\((?:\.\/)?(reading-[^)\s]+)\)/g, '](' + ACADEMY + '$1)');

function trimResult(res) {
  if (res && Array.isArray(res.hits) && res.hits.length > MAX_ROWS_TO_MODEL)
    return { ...res, hits: res.hits.slice(0, MAX_ROWS_TO_MODEL), truncated: true, _cappedTo: MAX_ROWS_TO_MODEL };
  return res;
}

// ---- the agentic loop: ask → (functionCall → run tool → functionResponse)* → text
// Scripts that must never appear in an answer: Hebrew, Arabic (+ supplements/presentation forms), Syriac, Cyrillic; and a
// combining dot-above / dot-below glued onto a Latin letter where IAST has a precomposed letter (the "tasmi̇nn" slip).
const FOREIGN = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u0400-\u04FF]|[A-Za-z]\u0307/;
function maskForeign(t) {
  return t.replace(/[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u0400-\u04FF][\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u0400-\u04FF\s]*/g, '[script error removed] ')
          .replace(/([A-Za-z])\u0307/g, '$1');
}

// QUOTE CHECK (Harsha 2026-10-26): every Devanāgarī quote in an answer must be a verbatim substring of the tool output the
// model saw this turn. Candidates = Devanāgarī inside ‘…’ “…” «…», plus lines that are mostly Devanāgarī (verses quoted on
// their own line). Each piece between ellipses (… / ...) or daṇḍas (। ॥ — verse halves are stored separately) is checked on
// its own; pieces under 6 letters are skipped.
// Normalisation only removes formatting noise (NFC, ZWJ/ZWNJ, whitespace, edge punctuation) — no spelling tolerance.
const DEVA = /[ऀ-ॿ꣠-ꣿ]/g;
const qnorm = t => String(t).normalize('NFC').replace(/[‌‍‘’“”«»]/g, '').replace(/\\n/g, ' ').replace(/\s+/g, ' ')
  .replace(/^[\s।॥,;:.!?\-—–‘’“”'"«»*_()\[\]०-९0-9]+|[\s।॥,;:.!?\-—–‘’“”'"«»*_()\[\]०-९0-9]+$/g, '');
function quoteCandidates(answer) {
  const out = [];
  for (const m of answer.matchAll(/[‘“«]([^‘’“”«»\n]{3,600})[’”»]/g)) if ((m[1].match(DEVA) || []).length >= 4) out.push(m[1]);
  for (const line of answer.split('\n')) {
    const t = line.replace(/^\s*(?:>|[-*]|\d+\.)\s*/, '').replace(/\*\*/g, '').trim();
    const deva = (t.match(DEVA) || []).length, letters = (t.match(/[\p{L}\p{M}]/gu) || []).length;
    if (deva >= 15 && deva / Math.max(1, letters) >= 0.9) out.push(t.replace(/[‘’“”«»]/g, ''));
  }
  return out;
}
function unverifiedQuotes(answer, haystack) {
  const hay = qnorm(haystack), bad = [];
  for (const q of quoteCandidates(answer)) {
    const pieces = q.split(/…|\.{3}|[।॥]/).map(qnorm).filter(p => (p.match(DEVA) || []).length >= 6);
    if (pieces.some(p => !hay.includes(p))) bad.push(qnorm(q));
  }
  return [...new Set(bad)];
}
const QUOTE_FIX = bad => 'These quotations are not verbatim substrings of the tool results above:\n' + bad.map(b => '- ' + b).join('\n') +
  '\nRewrite the SAME answer: copy each quotation character-for-character from the tool results (sandhi and spelling exactly as ' +
  'printed), or remove the quotation marks and paraphrase. Change nothing else.';
const quoteNote = bad => bad.length ? '\n\n---\n⚠ Not found verbatim in the tool output (check before citing): ' + bad.map(b => '‘' + b + '’').join(' · ') : '';

async function ask(question) {
  const contents = [{ role: 'user', parts: [{ text: question }] }];
  const trace = []; let seen = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const { content } = await generate(contents);
    const parts = content.parts || [];
    const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    if (!calls.length) {
      const answer = parts.map(p => p.text || '').join('').trim().normalize('NFC');   // NFC: decomposed ṁ/ṇ → precomposed, not flagged
      // SCRIPT GUARD (Harsha 2026-10-12: रसो वै सः came back in Arabic letters). Sanskrit must be Devanāgarī or IAST: on a
      // foreign-script run or a stray combining dot (e.g. "tasmi̇nn") ask ONCE for a rewrite; whatever survives is masked.
      if (FOREIGN.test(answer) && !trace.some(t => t.rewrite)) {
        trace.push({ rewrite: true });
        contents.push({ role: 'model', parts: [{ text: answer }] });
        contents.push({ role: 'user', parts: [{ text: 'Your answer contains text in a script other than Devanāgarī / IAST (e.g. Arabic letters or a stray combining mark). Rewrite the SAME answer: Sanskrit only in Devanāgarī or IAST, and every Sanskrit quote copied character-for-character from the tool results above.' }] });
        continue;
      }
      const bad = unverifiedQuotes(answer, seen);
      if (bad.length && !trace.some(t => t.quotefix)) {
        trace.push({ quotefix: bad.length });
        contents.push({ role: 'model', parts: [{ text: answer }] });
        contents.push({ role: 'user', parts: [{ text: QUOTE_FIX(bad) }] });
        continue;
      }
      return { answer: absLinks(maskForeign(answer)) + quoteNote(bad), trace };
    }
    contents.push({ role: 'model', parts });
    const respParts = [];
    for (const fc of calls) {
      let r;
      try { r = addLinks(trimResult(T.callTool(corpus, fc.name, fc.args || {}))); }
      catch (e) { r = { error: String(e.message || e) }; }
      trace.push({ tool: fc.name, args: fc.args || {}, count: r && r.count });
      seen += JSON.stringify(r) + '\n';
      respParts.push({ functionResponse: { name: fc.name, response: r } });
    }
    contents.push({ role: 'user', parts: respParts });
  }
  return { answer: '(stopped: exceeded tool-step limit)', trace };
}

// ===========================================================================
// Claude (LLM_PROVIDER=anthropic): same tools, same prompt, same script guard — Messages API tool-use loop.
// System prompt + tool list are cached (they are identical for every question); the growing conversation
// is cached too (top-level cache_control), so each loop step only pays full price for the new tool output.
// Refusal fallback: server-side 'default' fallbacks re-run a declined request on another model in the same call.
// ===========================================================================
let claude = null, Anthropic = null;
if (USE_CLAUDE) {
  Anthropic = require('@anthropic-ai/sdk');
  claude = new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });   // reads ANTHROPIC_API_KEY
}
const claudeTools = () => T.TOOL_SCHEMAS.map(s => ({ name: s.name, description: s.description, input_schema: s.parameters }));

async function claudeStep(messages) {
  try {
    const stream = claude.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: claudeTools(),
      messages,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: EFFORT },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    return await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new Error('The assistant is busy right now. Please wait a minute and ask again.');
    if (e instanceof Anthropic.APIError) throw new Error('Claude: ' + e.message);
    throw e;
  }
}

async function askClaude(question) {
  const messages = [{ role: 'user', content: question }];
  const trace = []; let seen = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await claudeStep(messages);
    if (msg.stop_reason === 'refusal') return { answer: 'The model declined to answer this question.', trace };
    if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
    const calls = msg.content.filter(b => b.type === 'tool_use');
    if (!calls.length) {
      const answer = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim().normalize('NFC');
      if (msg.stop_reason === 'max_tokens' && !answer) return { answer: '(stopped: answer too long)', trace };
      // SCRIPT GUARD — same rule as the Gemini loop: one rewrite, then mask.
      if (FOREIGN.test(answer) && !trace.some(t => t.rewrite)) {
        trace.push({ rewrite: true });
        messages.push({ role: 'assistant', content: msg.content });
        messages.push({ role: 'user', content: 'Your answer contains text in a script other than Devanāgarī / IAST (e.g. Arabic letters or a stray combining mark). Rewrite the SAME answer: Sanskrit only in Devanāgarī or IAST, and every Sanskrit quote copied character-for-character from the tool results above.' });
        continue;
      }
      const bad = unverifiedQuotes(answer, seen);
      if (bad.length && !trace.some(t => t.quotefix)) {
        trace.push({ quotefix: bad.length });
        messages.push({ role: 'assistant', content: msg.content });
        messages.push({ role: 'user', content: QUOTE_FIX(bad) });
        continue;
      }
      return { answer: absLinks(maskForeign(answer)) + quoteNote(bad), trace };
    }
    if (msg.stop_reason === 'max_tokens') return { answer: '(stopped: a tool call was cut off — try a narrower question)', trace };
    messages.push({ role: 'assistant', content: msg.content });
    const results = calls.map(c => {
      let r, isErr = false;
      try { r = addLinks(trimResult(T.callTool(corpus, c.name, c.input || {}))); }
      catch (e) { r = { error: String(e.message || e) }; isErr = true; }
      trace.push({ tool: c.name, args: c.input || {}, count: r && r.count });
      const js = JSON.stringify(r); seen += js + '\n';
      return { type: 'tool_result', tool_use_id: c.id, content: js, ...(isErr ? { is_error: true } : {}) };
    });
    messages.push({ role: 'user', content: results });
  }
  return { answer: '(stopped: exceeded tool-step limit)', trace };
}

// ===========================================================================
// HTTP server
// ===========================================================================
const nText = Object.values(stats.texts).length;
const nVerses = Object.values(stats.texts).reduce((a, t) => a + (t.verses || 0), 0);
const nWords = Object.values(stats.texts).reduce((a, t) => a + (t.words || 0), 0);

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vyākaraṇa Corpus Assistant</title>
<style>
:root{--bg:#fbfaf7;--card:#fff;--ink:#20242c;--muted:#6b7280;--line:#e6e2da;--acc:#7c5a1e}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--card:#1c1f26;--ink:#e6e8ec;--muted:#9aa1ac;--line:#2b2f38;--acc:#d9b877}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.55}
.wrap{max-width:820px;margin:0 auto;padding:22px 18px 120px}
h1{font-size:20px;margin:0 0 2px}.sub{color:var(--muted);font-size:13px;margin:0 0 14px}
.ex{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 16px}
.ex button{font:inherit;font-size:12.5px;color:var(--acc);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 11px;cursor:pointer}
.msg{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 16px;margin:0 0 12px;word-wrap:break-word;overflow-wrap:anywhere}
.msg.u{background:transparent;border-style:dashed;color:var(--muted);font-size:14px;white-space:pre-wrap}
.msg.a{font-family:"Noto Serif Devanagari","Segoe UI",serif}
.msg.a h3,.msg.a h4,.msg.a h5,.msg.a h6{margin:.7em 0 .3em;font-size:15px;font-weight:700;line-height:1.3}
.msg.a p{margin:.45em 0}
.msg.a ul,.msg.a ol{margin:.35em 0 .35em 1.3em;padding:0}
.msg.a li{margin:.18em 0}
.msg.a code{background:rgba(120,120,120,.16);padding:1px 5px;border-radius:5px;font-size:13.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.msg.a strong{font-weight:700}.msg.a em{font-style:italic}
.msg.a hr{border:0;border-top:1px solid var(--line);margin:.8em 0}
.trace{color:var(--muted);font-size:11.5px;margin-top:8px;border-top:1px solid var(--line);padding-top:6px}
form{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 18px}
.row{max-width:820px;margin:0 auto;display:flex;gap:8px}
textarea{flex:1;font:inherit;font-size:15px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;resize:none;height:44px}
button.send{font:inherit;font-weight:600;color:#fff;background:var(--acc);border:0;border-radius:10px;padding:0 18px;cursor:pointer}
button.send:disabled{opacity:.5}
.pw{margin:0 0 14px}.pw input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
</style>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
</head><body><div class="wrap">
<h1>Vyākaraṇa Corpus Assistant</h1>
<p class="sub">Ask in plain English about ${nText} analysed Sanskrit texts (${nVerses.toLocaleString()} verses · ${nWords.toLocaleString()} words). Every answer is grounded in a deterministic query with citations — no guessing.</p>
${PASSWORD ? '<div class="pw">Access code: <input id="pw" type="password" placeholder="code"></div>' : ''}
<div class="ex">
<button>How many tṛtīyā words are in the Vivekacūḍāmaṇi? Show 5 examples.</button>
<button>Compounds in the Pañcadaśī that peel to ≥4 layers — 3 with full vigraha.</button>
<button>Which text uses कर्मणि voice most?</button>
<button>Examples of hetau-pañcamī in the Bhagavad-gītā bhāṣya.</button>
<button>What kāraka roles exist, and how frequent is हेतुः?</button>
<button>Where does the bhāṣya carry out a vicāra on ānanda? Name the top discussions, with their conclusions.</button>
<button>Outside the Brahmasūtra, where does Śaṅkara discuss karma vs jñāna? Top 5, with key sentences.</button>
</div>
<div id="log"></div>
</div>
<form id="f"><div class="row">
<textarea id="q" placeholder="Ask a question…" autofocus></textarea>
<button class="send" id="s" type="submit">Ask</button>
</div></form>
<script>
const log=document.getElementById('log'),q=document.getElementById('q'),s=document.getElementById('s'),f=document.getElementById('f');
function add(cls,txt){const d=document.createElement('div');d.className='msg '+cls;d.textContent=txt;log.appendChild(d);d.scrollIntoView({behavior:'smooth',block:'end'});return d;}
function renderMd(el,text){ if(window.marked&&window.DOMPurify){ el.innerHTML=DOMPurify.sanitize(marked.parse(String(text))); el.querySelectorAll('a[href]').forEach(a=>{a.target='_blank';a.rel='noopener';}); } else { el.textContent=text; } el.scrollIntoView({behavior:'smooth',block:'end'}); }
document.querySelectorAll('.ex button').forEach(b=>b.onclick=()=>{q.value=b.textContent;q.focus();});
const pwEl=document.getElementById('pw');if(pwEl){try{pwEl.value=localStorage.getItem('cc_pw')||'';}catch(e){}}
f.onsubmit=async e=>{e.preventDefault();const question=q.value.trim();if(!question)return;
  add('u',question);q.value='';s.disabled=true;const pend=add('a','…thinking…');
  try{const pw=document.getElementById('pw');
    const r=await fetch('chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:question,pw:pw?pw.value:''})});
    const d=await r.json();
    if(pw){try{if(r.status===401)localStorage.removeItem('cc_pw');else localStorage.setItem('cc_pw',pw.value);}catch(e){}}
    if(d.error){pend.textContent='⚠ '+d.error;}
    else{renderMd(pend,d.answer||'(no answer)');
      if(d.trace&&d.trace.length){const t=document.createElement('div');t.className='trace';t.textContent='tools: '+d.trace.filter(x=>x.tool).map(x=>x.tool).join(' → ');pend.appendChild(t);}}
  }catch(err){pend.textContent='⚠ '+err.message;}
  s.disabled=false;q.focus();};
q.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit();}});
</script></body></html>`;

function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return;
  }
  if (req.method === 'GET' && req.url === '/health') { send(res, 200, { ok: true, provider: PROVIDER, model: MODEL, aistudio: USE_AISTUDIO, texts: nText, commentaryBlocks: commentary ? commentary.rows.length : 0, rssMB: Math.round(process.memoryUsage().rss / 1e6) }); return; }
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      let q;
      try { q = JSON.parse(body); } catch { return send(res, 400, { error: 'bad request' }); }
      if (PASSWORD && q.pw !== PASSWORD) return send(res, 401, { error: 'wrong access code' });
      const question = (q.q || '').toString().slice(0, 2000).trim();
      if (!question) return send(res, 400, { error: 'empty question' });
      try { const r = await (USE_CLAUDE ? askClaude(question) : ask(question)); send(res, 200, r); }
      catch (e) { send(res, 500, { error: String(e.message || e) }); }
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});
server.listen(PORT, () => console.log(`Vyākaraṇa Corpus Assistant on :${PORT} | provider=${PROVIDER} | model=${MODEL} | aistudio=${USE_AISTUDIO} | ${nText} texts, ${nWords} words | commentary: ${commentary ? commentary.rows.length + ' blocks' : 'none'} | rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`));
