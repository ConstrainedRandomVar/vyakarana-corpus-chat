# Vyākaraṇa Corpus Assistant — Render deploy

A shareable web app for natural-language querying of a machine-analysed Sanskrit corpus of 15 texts
(Bhagavad-gītā, 10 principal Upaniṣads, Brahmasūtra-bhāṣya, Vivekacūḍāmaṇi, Pañcadaśī, Aparokṣānubhūti):
per-word morphology, vibhakti, kāraka roles, recursive samāsa peel, sandhi, clause structure, kāraka
relations, and Śaṅkara-bhāṣya rhetorical roles.

Ask in plain English (e.g. *"how many tṛtīyā words in the Vivekacūḍāmaṇi, show 5 examples"*). A Gemini
**function-calling** loop runs deterministic query tools over the corpus (held in memory), so every count
and example comes from a real scan with **text · ref · word** citations — nothing is guessed.

Node stdlib only (no dependencies). Loads `corpus.json` (~50 MB → ~360 MB RSS) into memory at boot; fits
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
Replace `corpus.json` + `corpus-tools.js` here, commit, push — Render auto-deploys.

## Config (env vars)
- `GEMINI_API_KEY` *(required, secret)* — AI Studio key.
- `GEMINI_MODEL` *(optional)* — default `gemini-3.6-flash`.
- `ACCESS_PASSWORD` *(optional, secret)* — if set, users must enter this code.
- `PORT` — provided by Render automatically.
