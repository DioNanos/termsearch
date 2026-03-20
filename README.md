# TermSearch - Personal Search Engine

[![Status](https://img.shields.io/badge/Status-0.3.0-blue.svg)](#project-status)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Target](https://img.shields.io/badge/Target-Termux%20%2F%20Linux%20%2F%20macOS-green.svg)](https://termux.dev)
[![npm](https://img.shields.io/badge/npm-termsearch-red.svg)](https://www.npmjs.com/package/termsearch)

TermSearch is a privacy-first personal search engine installable with a single command on Termux, Linux, and macOS.
Zero external dependencies, no Docker, no Python. AI is optional and configured entirely from the browser.

Core capabilities:

- Zero-config search via DuckDuckGo and Wikipedia — works immediately after install
- Progressive enhancement: add Brave/Mojeek API keys, AI endpoints, or SearXNG when needed
- Social profile scanner: GitHub, Bluesky, Reddit, Twitter/X, Instagram, YouTube, LinkedIn, TikTok, Telegram, Facebook
- Torrent search: The Pirate Bay + 1337x with direct magnet extraction
- Social search: Bluesky posts/actors + GDELT news
- AI-powered 2-phase agentic summaries via any OpenAI-compatible endpoint
- Vanilla HTML/CSS/JS frontend (~280KB, no build step, no framework)
- Boot autostart: Termux:Boot, systemd --user, or launchd (macOS)

## Project Status

- Current line: `0.3.0`
- Core is MIT — zero required API keys
- AI features are optional, configured via Settings page in browser
- Tested on: Ubuntu 24.04, Termux (Android 15/16)
- macOS: compatible (launchd autostart), untested in production

## Quickstart

1. Install globally

```bash
npm install -g termsearch
```

2. Start

```bash
termsearch
```

3. Open browser at `http://localhost:3000`

That's it. No configuration required for basic search.

## CLI

```bash
termsearch                     # start + open browser (if not running: status)
termsearch start               # start server in background
termsearch start --fg          # start in foreground (debug/logs live)
termsearch stop                # stop background server
termsearch restart             # restart
termsearch status              # show PID, URL, uptime
termsearch doctor              # check Node version, data dir, HTTP health
termsearch logs                # last 60 lines of server log
termsearch logs -n 100         # last N lines
termsearch open                # open browser
termsearch autostart enable    # start at boot (Termux:Boot / systemd / launchd)
termsearch autostart disable   # disable autostart
termsearch help                # full command reference
```

Options:

```bash
--port=<port>                  # default: 3000
--host=<host>                  # default: 127.0.0.1
--data-dir=<path>              # default: ~/.termsearch/
```

## Progressive Enhancement

| Level | Requirements | Features |
|-------|-------------|---------|
| **0** (zero-config) | None | DuckDuckGo + Wikipedia — works immediately |
| **1** (API keys) | Brave/Mojeek key via Settings | Better and more diverse results |
| **2** (AI) | Any OpenAI-compatible endpoint | Summaries, query refinement |
| **3** (power user) | Own SearXNG instance | 40+ search engines |

## AI Configuration

Configure at **Settings → AI** in the browser. Supported endpoints:

| Provider | API Base | Model | Key |
|----------|----------|-------|-----|
| **Localhost** (Ollama) | `http://localhost:11434/v1` | `qwen3.5:4b` or any | not required |
| **Localhost** (LM Studio) | `http://localhost:1234/v1` | your loaded model | not required |
| **Chutes.ai TEE** | `https://llm.chutes.ai/v1` | `deepseek-ai/DeepSeek-V3.2-TEE` | required |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` | required |
| **API custom** | any OpenAI-compatible URL | your model | optional |

All providers use the OpenAI-compatible `/chat/completions` format. Leave API key empty for local models.

## Architecture

```
~/.termsearch/
  config.json       user settings (saved via browser Settings page)
  cache/            search + document cache (L1 RAM + L2 disk)
  termsearch.pid    daemon PID
  termsearch.log    server log

src/
  config/           config manager — load/save/defaults/env overrides
  search/
    providers/      DuckDuckGo, Wikipedia, Brave, Mojeek, SearXNG
    engine.js       fan-out, merge, rank, cache
    ranking.js      source diversity ranking
    cache.js        tiered cache (L1 Map + L2 disk JSON)
  fetch/
    document.js     URL fetcher + HTML → readable text + site scan
    ssrf-guard.js   SSRF protection
  ai/
    orchestrator.js 2-phase agentic summary flow
    summary.js      prompt builder + response parser
    query.js        query refinement
    providers/
      openai-compat.js  universal OpenAI-compatible client
  profiler/
    scanner.js      social profile scanner (10 platforms)
  social/
    scrapers.js     Twitter/Nitter, Instagram, YouTube, Facebook, LinkedIn, TikTok, Telegram
    search.js       Bluesky posts/actors + GDELT news
  torrent/
    scrapers.js     TPB + 1337x scrapers + magnet extraction
  autostart/
    manager.js      boot autostart (Termux:Boot / systemd / launchd)
  api/
    routes.js       all API route handlers
    middleware.js   rate limiting, security headers
  server.js         Express app setup

frontend/dist/      vanilla HTML/CSS/JS SPA (~280KB, no build step)
```

## API

```
GET  /api/health                     service status + enabled providers
GET  /api/openapi.json               machine-readable API description
GET  /api/search?q=...               web search
GET  /api/search-stream?q=...        progressive SSE search
POST /api/fetch                      fetch readable content from URL
POST /api/ai-query                   AI query refinement
POST /api/ai-summary                 AI summary with SSE streaming
GET  /api/profiler?q=...             social profile scan (URL or @handle)
GET  /api/social-search?q=...        Bluesky + GDELT news
POST /api/torrent-search             torrent search (TPB + 1337x)
POST /api/magnet                     extract magnet from torrent page URL
POST /api/scan                       crawl site for query-matched pages
GET  /api/config                     current config (keys masked)
POST /api/config                     update and persist config
POST /api/config/test-ai             test AI connection
GET  /api/config/test-provider/:name test search provider
GET  /api/autostart                  autostart status
POST /api/autostart                  enable/disable autostart
GET  /api/stats                      usage stats
```

## Environment Variables (optional, override Settings)

```bash
TERMSEARCH_PORT=3000
TERMSEARCH_HOST=127.0.0.1
TERMSEARCH_DATA_DIR=~/.termsearch/
TERMSEARCH_AI_API_BASE=https://api.z.ai/api/coding/paas/v4
TERMSEARCH_AI_API_KEY=
TERMSEARCH_AI_MODEL=glm-4.7
TERMSEARCH_BRAVE_API_KEY=
TERMSEARCH_MOJEEK_API_KEY=
TERMSEARCH_SEARXNG_URL=
TERMSEARCH_GITHUB_TOKEN=
TERMSEARCH_INSTAGRAM_SESSION=
```

## Termux

```bash
pkg install nodejs
npm install -g termsearch
termsearch
```

Enable autostart with Termux:Boot (install from F-Droid):

```bash
termsearch autostart enable
```

## Roadmap

1. Persistent search stats counter
2. Engine health tracking and failure classification
3. Frontend profile viewer panel
4. Frontend torrent results panel with magnet copy
5. Agentic user-proxy (`/api/user-proxy`) for custom AI loops
6. Packaged release on npm registry

## License

MIT — Copyright (c) 2026 Davide A. Guglielmi
