# TermSearch

[![Version](https://img.shields.io/npm/v/termsearch.svg)](https://www.npmjs.com/package/termsearch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Termux%20%7C%20Linux%20%7C%20macOS-green.svg)](#)
[![npm](https://img.shields.io/badge/npm-termsearch-red.svg)](https://www.npmjs.com/package/termsearch)

**Personal search engine.** One command install, zero config, privacy-first.

No Docker, no Python, no API keys required. AI is optional. Everything runs from a single `npm install`.

## Install & Run

```bash
npm install -g termsearch
termsearch
```

Opens `http://localhost:3000`. That's it.

## What You Get

**Search** — DuckDuckGo, Wikipedia, Startpage, Qwant, Ecosia, GitHub, Yandex, Marginalia, Ahmia out of the box. Add Brave, Mojeek, or your own SearXNG for more coverage. Engine picker lets you mix and match per-search, and the new web scrapers can be toggled in Settings.

**AI Summaries** — Connect any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, Chutes.ai, OpenRoute.ai, Anthropic, OpenAI). 2-phase agentic flow: AI picks sources, reads pages, synthesizes an answer. Session memory carries context across queries.

**Social Profiler** — Paste a GitHub/Bluesky/Reddit/Twitter URL or @handle, get a profile card with stats, top repos, similar accounts.

**Torrent Search** — The Pirate Bay, 1337x, YTS, Nyaa, EZTV, and Torrent Galaxy with magnet links, seeders, file sizes.

**Social & News** — Bluesky posts + GDELT articles inline.

## Progressive Enhancement

| Level | Config | What works |
|-------|--------|------------|
| **0** | None | DuckDuckGo + Wikipedia + Startpage + Qwant + Ecosia + GitHub + Yandex + Marginalia + Ahmia |
| **1** | API keys (Settings) | + Brave, Mojeek |
| **2** | AI endpoint (Settings) | + AI summaries, query refinement, session memory |
| **3** | SearXNG URL | + 40 engines via your SearXNG instance |

## CLI

```
termsearch                     start + open browser
termsearch start               background daemon
termsearch start --fg          foreground (live logs)
termsearch stop / restart      manage daemon
termsearch status              version, PID, URL, update check
termsearch doctor              full health check + npm update check
termsearch logs [-n 100]       server log tail
termsearch open                open browser
termsearch autostart enable    boot start (Termux:Boot / systemd / launchd)
termsearch help                full reference
```

Options: `--port=3000` `--host=127.0.0.1` `--data-dir=~/.termsearch/`

## AI Presets

Configure in **Settings > AI** from the browser. Presets auto-fill endpoint and model:

| Preset | Endpoint | Key | Default Model |
|--------|----------|-----|---------------|
| Ollama | `localhost:11434/v1` | no | `qwen3.5:4b` |
| LM Studio | `localhost:1234/v1` | no | — |
| llama.cpp | `localhost:8080/v1` | no | — |
| Chutes.ai TEE | `llm.chutes.ai/v1` | yes | `DeepSeek-V3.2-TEE` |
| OpenRoute.ai | `openroute.ai/api/v1` | yes | `deepseek/deepseek-chat` |
| Anthropic | `api.anthropic.com/v1` | yes | `claude-3-5-haiku-latest` |
| OpenAI | `api.openai.com/v1` | yes | `gpt-4o-mini` |
| Custom | any OpenAI-compatible | optional | — |

Load Models button auto-discovers available models from the endpoint.

## Search Engines

**Zero-config** (no API key): DuckDuckGo, Wikipedia, Startpage, Qwant, Ecosia, GitHub, Yandex, Ahmia, Marginalia

**Toggles in Settings**: Startpage, Qwant, Ecosia, Yandex, Ahmia, Marginalia

**API key** (toggle in Settings): Brave Search, Mojeek

**Self-hosted**: SearXNG (proxy to 40+ engines)

**Selectable per-search**: Engine picker icon in the header lets you toggle individual engines, use presets (All / Web / Uncensored / GitHub / Torrent / Social / Research), or pick from groups (Web Core, Uncensored, Code & Dev, Media, Research, Federated, Torrent).

## Frontend

Vanilla HTML/CSS/JS — ~350KB total, no build step, no framework, no WASM.

- Dark/light theme toggle
- Mobile-first responsive layout with bottom bar
- PWA manifest + OpenSearch integration
- AI panel with progress bar, steps, source pills, session memory, retry
- Engine picker as compact icon with dropdown

## Architecture

```
~/.termsearch/
  config.json          settings (saved via browser UI)
  cache/               L1 RAM + L2 disk cache
  termsearch.pid       daemon PID
  termsearch.log       server log

src/
  server.js            Express app (~70 lines)
  config/              manager + defaults + env overrides
  search/
    engine.js          fan-out, merge, rank, health tracking
    providers/         ddg, wikipedia, startpage, qwant, ecosia, brave, mojeek, searxng, github, yandex, ahmia, marginalia
    ranking.js         source diversity ranking
    cache.js           tiered L1+L2 cache
  ai/
    orchestrator.js    2-phase agentic summary
    summary.js         prompt builder + parser
    query.js           query refinement
    providers/         openai-compat universal client
  fetch/               document fetcher + SSRF guard
  profiler/            social profile scanner (10 platforms)
  social/              Bluesky + GDELT + scrapers
  torrent/             TPB + 1337x + YTS + Nyaa + EZTV + TGx + magnet extraction
  autostart/           Termux:Boot / systemd / launchd
  api/                 routes + middleware

frontend/dist/         vanilla SPA
```

## API

```
GET  /api/health                    status + providers
GET  /api/search?q=...              search (JSON)
GET  /api/search-stream?q=...       progressive search (SSE)
POST /api/ai-summary                AI summary (SSE streaming)
POST /api/ai-query                  AI query refinement
POST /api/fetch                     fetch readable content
GET  /api/profiler?q=...            social profile scan
GET  /api/social-search?q=...       Bluesky + GDELT
POST /api/torrent-search            torrent scrape
POST /api/magnet                    magnet extraction
POST /api/scan                      site crawl
GET  /api/config                    config (keys masked)
POST /api/config                    update config
POST /api/config/test-ai            test AI connection
POST /api/config/models             list provider models
GET  /api/config/test-provider/:id  test search provider
GET  /api/autostart                 autostart status
POST /api/autostart                 toggle autostart
GET  /api/openapi.json              OpenAPI spec
```

## Env Vars (optional)

```bash
TERMSEARCH_PORT=3000
TERMSEARCH_HOST=127.0.0.1
TERMSEARCH_DATA_DIR=~/.termsearch/
TERMSEARCH_AI_API_BASE=http://localhost:11434/v1
TERMSEARCH_AI_API_KEY=
TERMSEARCH_AI_MODEL=qwen3.5:4b
TERMSEARCH_BRAVE_API_KEY=
TERMSEARCH_MOJEEK_API_KEY=
TERMSEARCH_MARGINALIA_API_KEY=public
TERMSEARCH_SEARXNG_URL=
```

## Termux

```bash
pkg install nodejs
npm install -g termsearch
termsearch
termsearch autostart enable   # optional: start on boot
```

## License

MIT — Copyright (c) 2026 Davide A. Guglielmi
