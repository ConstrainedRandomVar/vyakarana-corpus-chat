# Vyākaraṇa Corpus Assistant — Render deploy

A shareable web app for natural-language querying of a machine-analysed Sanskrit corpus of 18 texts
(Bhagavad-gītā, 10 principal Upaniṣads, Brahmasūtra-bhāṣya, Vivekacūḍāmaṇi, Pañcadaśī, Ātmabodha, Upadeśa Sāram,
Saddarśanam, Vicārasāgara) plus 32 commentaries (Ānandagiri, vārttikas, Ratnaprabhā, Gītā verse-commentaries …):
per-word morphology, vibhakti, kāraka roles, recursive samāsa peel, sandhi, clause structure, kāraka
relations, and Śaṅkara-bhāṣya rhetorical roles.

Ask in plain English (e.g. *"how many tṛtīyā words in the Vivekacūḍāmaṇi, show 5 examples"*). A Gemini
**function-calling** loop runs deterministic query tools over the corpus (held in memory), so every count
and example comes from a real scan with **text · ref · word** citations — nothing is guessed.

Node, one dependency (`@anthropic-ai/sdk`, used only by the Claude service). Loads `corpus.json` (~50 MB → ~360 MB RSS) into memory at boot; fits
Render's free 512 MB web service.

## Deploy on Render (free, no credit card)
1. **Sign up** at https://render.com (GitHub sign-in, no card).
2. **New → Blueprint** → connect this repo → Render reads `render.yaml`.
   *(Or: New → Web Service → this repo → Runtime Node, Build `npm install`, Start `node server.js`, Plan Free.)*
3. When prompted, set the secret **`GEMINI_API_KEY`** — a Google AI Studio key (aistudio.google.com → Get API key; free tier).
   Optionally set `ACCESS_PASSWORD` to gate access, or change `GEMINI_MODEL`.
4. **Create** → wait for the build → open the `*.onrender.com` URL and share it.

Note: free web services **sleep after 15 min idle** and cold-start (~30–60 s) on the next visit — normal.

## Update after a corpus change
In devanagari-rescue run `searchtool/khan/corpus/hf-space/prepare.sh` — it prints the copy line: `server.js`,
`package*.json`, `corpus-tools.js`, `corpus.json.gz`, `commentary.json.gz` (the commentary layer) and
`svadhyaya-refidx.js` (ref → reading-page map for the answer links). Copy, commit, push — Render redeploys both services.
Both start with `node --expose-gc --max-old-space-size=300 server.js` (keeps memory well under the free plan's 512 MB).

## Claude edition (second service)
`render.yaml` defines a second service, **`vyakarana-corpus-chat-claude`**, from the same code: same tools, prompt and
corpus, but the loop runs on Claude (`LLM_PROVIDER=anthropic`, default model `claude-opus-5-5`). It is paid per
question, so it is gated by `ACCESS_PASSWORD` (the page asks for the code and remembers it in that browser) and
capped by the monthly spend limit set in the Anthropic console (console.anthropic.com → Settings → Limits).
Secrets: `ANTHROPIC_API_KEY`, `ACCESS_PASSWORD`. Every push redeploys both services.

## Config (env vars)
- `GEMINI_API_KEY` *(required, secret)* — AI Studio key.
- `GEMINI_MODEL` *(optional)* — default `gemini-3.6-flash`.
- `ACCESS_PASSWORD` *(optional, secret)* — if set, users must enter this code.
- `LLM_PROVIDER` *(optional)* — `gemini` (default) or `anthropic`.
- `ANTHROPIC_API_KEY` *(secret, Claude service)* — Anthropic API key.
- `ANTHROPIC_MODEL` *(optional)* — default `claude-opus-5-5`.
- `ANTHROPIC_EFFORT` *(optional)* — `low`…`max`, default `high`.
- `PORT` — provided by Render automatically.
