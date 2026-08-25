#!/usr/bin/env node
// ===========================================================================
// Vyākaraṇa Corpus Assistant — Hugging Face Space (Docker) web app.
//
// Serves a chat page + runs the Gemini FUNCTION-CALLING loop server-side over
// the deterministic corpus tools (corpus-tools.js) against corpus.json held in
// memory. Every answer is grounded in real tool output — exact, cited, no
// hallucinated numbers. This is corpus-chat.js turned into a shareable web app.
//
// AUTH (two modes, auto-detected):
//   • GEMINI_API_KEY set  → Google AI Studio (Generative Language API) — the
//     free-tier path used on Hugging Face. Set it as a Space *secret*.
//   • else                → Vertex AI via a local `gcloud` access token (for
//     running/testing on Harsha's machine; NOT available in the HF container).
//
// ENV: GEMINI_API_KEY, GEMINI_MODEL, PORT (HF uses 7860),
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
const stats = T.corpus_stats(corpus);

const PORT = process.env.PORT || 7860;
const API_KEY = process.env.GEMINI_API_KEY || '';
const USE_AISTUDIO = !!API_KEY;
const MODEL = process.env.GEMINI_MODEL || (USE_AISTUDIO ? 'gemini-2.5-flash' : 'gemini-3.7-flash');
const PASSWORD = process.env.ACCESS_PASSWORD || '';
const MAX_STEPS = 8;
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
You answer natural-language questions about a machine-analysed Sanskrit corpus of 15 texts (Bhagavad-gītā,
10 principal Upaniṣads, Brahmasūtra-bhāṣya, Vivekacūḍāmaṇi, Pañcadaśī, Aparokṣānubhūti) covering per-word
morphology, vibhakti, kāraka roles, recursive samāsa peel, sandhi, clause structure, kāraka relations, and
Śaṅkara-bhāṣya rhetorical roles.

HARD RULES
1. GROUND EVERYTHING IN TOOLS. Never state a count, form, sūtra, or example from memory — call a tool and use
   only what it returns. If no tool fits, say so plainly.
2. CITE every example exactly as the tool returns it: text · ref · word.
3. RESPECT COVERAGE and state the limit when relevant:
   • dhātu/kṛdanta/lemma exist for the Bhagavad-gītā ONLY; for other texts recover kṛt/taddhita from the samāsa peel.
   • sandhi exists for Gita, VC, PD, AB only. • bhāṣya exists for Gita, BS and the 10 Upaniṣads; VC/PD/AB have none.
   • BS is bhāṣya-only. • BG kāraka = UoHyd e-reader (~57% reliable); for hetau-pañcamī prefer the bhāṣya route.
   • Some Upaniṣads carry two ref schemes; word-hit vs relation-hit may cite different refs — both are true.
   • VC voice values are partly garbled in the source (e.g. "कर्तरi") — treat as noise.
4. USE DEVANĀGARĪ for all grammatical facet values (cases, roles, pratyayas, samāsa types).
5. DISCOVER first with list_values(facet) if unsure what values exist.
6. Prefer 3–8 vivid cited examples + the true total (use count_only/count_by) over dumping everything; say how many matched.

Text keys: Gita, Kena, Kathaka, Isha, Mandukya, Mundaka, Prashna, Taitiriya, Aitareya, Chandogya, Brha, BS,
VC, PD, AB. Map loose names to the right key. Keep prose tight and scholarly; render Sanskrit in Devanāgarī.`;

function toolFns() { return T.TOOL_SCHEMAS.map(s => ({ name: s.name, description: s.description, parameters: s.parameters })); }

// ===========================================================================
// One generateContent call WITH tools + history (fetch; both auth modes)
// ===========================================================================
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
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const d = await res.json();
  if (d.error) throw new Error('Gemini: ' + (d.error.message || JSON.stringify(d.error)));
  const cand = (d.candidates || [])[0] || {};
  return { content: cand.content || { parts: [] }, usage: d.usageMetadata || {}, finishReason: cand.finishReason };
}

function trimResult(res) {
  if (res && Array.isArray(res.hits) && res.hits.length > MAX_ROWS_TO_MODEL)
    return { ...res, hits: res.hits.slice(0, MAX_ROWS_TO_MODEL), truncated: true, _cappedTo: MAX_ROWS_TO_MODEL };
  return res;
}

// ---- the agentic loop: ask → (functionCall → run tool → functionResponse)* → text
async function ask(question) {
  const contents = [{ role: 'user', parts: [{ text: question }] }];
  const trace = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const { content } = await generate(contents);
    const parts = content.parts || [];
    const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    if (!calls.length) return { answer: parts.map(p => p.text || '').join('').trim(), trace };
    contents.push({ role: 'model', parts });
    const respParts = [];
    for (const fc of calls) {
      let r;
      try { r = trimResult(T.callTool(corpus, fc.name, fc.args || {})); }
      catch (e) { r = { error: String(e.message || e) }; }
      trace.push({ tool: fc.name, args: fc.args || {}, count: r && r.count });
      respParts.push({ functionResponse: { name: fc.name, response: r } });
    }
    contents.push({ role: 'user', parts: respParts });
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
.msg{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 16px;margin:0 0 12px;white-space:pre-wrap;word-wrap:break-word}
.msg.u{background:transparent;border-style:dashed;color:var(--muted);font-size:14px}
.msg.a{font-family:"Noto Serif Devanagari","Segoe UI",serif}
.trace{color:var(--muted);font-size:11.5px;margin-top:8px;border-top:1px solid var(--line);padding-top:6px}
form{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 18px}
.row{max-width:820px;margin:0 auto;display:flex;gap:8px}
textarea{flex:1;font:inherit;font-size:15px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;resize:none;height:44px}
button.send{font:inherit;font-weight:600;color:#fff;background:var(--acc);border:0;border-radius:10px;padding:0 18px;cursor:pointer}
button.send:disabled{opacity:.5}
.pw{margin:0 0 14px}.pw input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
</style></head><body><div class="wrap">
<h1>Vyākaraṇa Corpus Assistant</h1>
<p class="sub">Ask in plain English about ${nText} analysed Sanskrit texts (${nVerses.toLocaleString()} verses · ${nWords.toLocaleString()} words). Every answer is grounded in a deterministic query with citations — no guessing.</p>
${PASSWORD ? '<div class="pw">Access code: <input id="pw" type="password" placeholder="code"></div>' : ''}
<div class="ex">
<button>How many tṛtīyā words are in the Vivekacūḍāmaṇi? Show 5 examples.</button>
<button>Compounds in the Pañcadaśī that peel to ≥4 layers — 3 with full vigraha.</button>
<button>Which text uses कर्मणि voice most?</button>
<button>Examples of hetau-pañcamī in the Bhagavad-gītā bhāṣya.</button>
<button>What kāraka roles exist, and how frequent is हेतुः?</button>
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
document.querySelectorAll('.ex button').forEach(b=>b.onclick=()=>{q.value=b.textContent;q.focus();});
f.onsubmit=async e=>{e.preventDefault();const question=q.value.trim();if(!question)return;
  add('u',question);q.value='';s.disabled=true;const pend=add('a','…thinking…');
  try{const pw=document.getElementById('pw');
    const r=await fetch('chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:question,pw:pw?pw.value:''})});
    const d=await r.json();
    if(d.error){pend.textContent='⚠ '+d.error;}
    else{pend.textContent=d.answer||'(no answer)';
      if(d.trace&&d.trace.length){const t=document.createElement('div');t.className='trace';t.textContent='tools: '+d.trace.map(x=>x.tool).join(' → ');pend.appendChild(t);}}
  }catch(err){pend.textContent='⚠ '+err.message;}
  s.disabled=false;q.focus();};
q.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit();}});
</script></body></html>`;

function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return;
  }
  if (req.method === 'GET' && req.url === '/health') { send(res, 200, { ok: true, model: MODEL, aistudio: USE_AISTUDIO, texts: nText }); return; }
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      let q;
      try { q = JSON.parse(body); } catch { return send(res, 400, { error: 'bad request' }); }
      if (PASSWORD && q.pw !== PASSWORD) return send(res, 401, { error: 'wrong access code' });
      const question = (q.q || '').toString().slice(0, 2000).trim();
      if (!question) return send(res, 400, { error: 'empty question' });
      try { const r = await ask(question); send(res, 200, r); }
      catch (e) { send(res, 500, { error: String(e.message || e) }); }
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});
server.listen(PORT, () => console.log(`Vyākaraṇa Corpus Assistant on :${PORT} | model=${MODEL} | aistudio=${USE_AISTUDIO} | ${nText} texts, ${nWords} words`));
