#!/usr/bin/env node
// TermSearch CLI — personal search engine
// Usage: termsearch [command] [options]

import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Constants ────────────────────────────────────────────────────────────

const DAEMON_FLAG = '--_daemon_';   // internal flag: process is the background daemon
const PKG_PATH    = path.join(__dirname, '../package.json');
const SERVER_PATH = path.join(__dirname, '../src/server.js');

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function ok(msg)   { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function err(msg)  { console.log(`  ${RED}✗${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}→${RESET} ${msg}`); }

// ─── Package version ──────────────────────────────────────────────────────

let VERSION = '0.3.1';
try { VERSION = JSON.parse(readFileSync(PKG_PATH, 'utf8')).version || VERSION; } catch { /* ignore */ }

// ─── Data dir + paths ─────────────────────────────────────────────────────

function getDataDir() {
  return process.env.TERMSEARCH_DATA_DIR || path.join(os.homedir(), '.termsearch');
}

function getPaths() {
  const d = getDataDir();
  return {
    dir:  d,
    pid:  path.join(d, 'termsearch.pid'),
    log:  path.join(d, 'termsearch.log'),
  };
}

// ─── PID helpers ──────────────────────────────────────────────────────────

function readPid(pidPath) {
  try { return parseInt(readFileSync(pidPath, 'utf8').trim(), 10); } catch { return null; }
}

function isRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getStatus() {
  const { pid: pidPath } = getPaths();
  const pid = readPid(pidPath);
  const running = isRunning(pid);
  return { pid: running ? pid : null, running };
}

// ─── Port / URL ───────────────────────────────────────────────────────────

function getPort() { return process.env.TERMSEARCH_PORT || '3000'; }
function getHost() { return process.env.TERMSEARCH_HOST || '127.0.0.1'; }
function getUrl()  { return `http://${getHost()}:${getPort()}`; }

// ─── CLI argument parsing ─────────────────────────────────────────────────

function parseArgs(argv) {
  const args  = argv.slice(2);
  const flags = {};
  const cmds  = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? true;
    } else {
      cmds.push(a);
    }
  }
  return { cmd: cmds[0] || null, sub: cmds[1] || null, flags };
}

// ─── DAEMON MODE ─────────────────────────────────────────────────────────
// When spawned with DAEMON_FLAG, just run the server (stdout → log file)

if (process.argv.includes(DAEMON_FLAG)) {
  // Apply env vars from flags
  for (const arg of process.argv.slice(2)) {
    if (arg === DAEMON_FLAG) continue;
    const [k, v] = arg.split('=');
    if (k === '--port' && v)     process.env.TERMSEARCH_PORT = v;
    if (k === '--host' && v)     process.env.TERMSEARCH_HOST = v;
    if (k === '--data-dir' && v) process.env.TERMSEARCH_DATA_DIR = v;
  }

  const { port, host } = await import(SERVER_PATH);
  const dataDir = getDataDir();
  const aiBase  = process.env.TERMSEARCH_AI_API_BASE || '';
  const aiModel = process.env.TERMSEARCH_AI_MODEL || '';

  console.log(`TermSearch v${VERSION} started`);
  console.log(`Data: ${dataDir}`);
  console.log(`URL:  http://${host}:${port}`);
  if (aiBase && aiModel) console.log(`AI:   ${aiModel} @ ${aiBase}`);
  process.exit ?? undefined; // keep running (server keeps the loop alive)
  process.exit; // unreachable
} else {
  // ─── USER-FACING CLI ───────────────────────────────────────────────────
  await runCli();
}

async function runCli() {
  const { cmd, sub, flags } = parseArgs(process.argv);

  // Apply flags to env
  if (flags.port)       process.env.TERMSEARCH_PORT     = flags.port;
  if (flags.host)       process.env.TERMSEARCH_HOST     = flags.host;
  if (flags['data-dir']) process.env.TERMSEARCH_DATA_DIR = flags['data-dir'];

  if (flags.help || flags.h || cmd === 'help') return printHelp();
  if (flags.version || flags.v || cmd === 'version') {
    console.log(`termsearch v${VERSION}`);
    return;
  }

  switch (cmd) {
    case 'start':    return cmdStart(flags);
    case 'stop':     return cmdStop();
    case 'restart':  return cmdRestart(flags);
    case 'status':   return cmdStatus();
    case 'open':     return cmdOpen();
    case 'logs':     return cmdLogs(flags);
    case 'doctor':   return cmdDoctor();
    case 'autostart':return cmdAutostart(sub);
    case null:       return cmdDefault(flags);
    default:
      err(`Unknown command: ${cmd}`);
      console.log(`  Run ${BOLD}termsearch help${RESET} for usage`);
      process.exit(1);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────

async function cmdStart(flags) {
  const { running, pid } = getStatus();
  if (running) {
    warn(`Already running  (PID ${pid}  ${getUrl()})`);
    return;
  }

  if (flags.fg || flags.foreground) {
    // Foreground mode — import server directly
    console.log('');
    const { port, host } = await import(SERVER_PATH);
    const dataDir = getDataDir();
    const aiBase  = process.env.TERMSEARCH_AI_API_BASE || '';
    const aiModel = process.env.TERMSEARCH_AI_MODEL || '';
    console.log(`
  ${BOLD}TermSearch v${VERSION}${RESET}
  Personal search engine — privacy-first, local-first

  ${GREEN}✓${RESET} Data: ${dataDir}
  ${GREEN}✓${RESET} Search: DuckDuckGo + Wikipedia${
    aiBase && aiModel ? `\n  ${GREEN}✓${RESET} AI: ${aiModel}` : `\n  ${DIM}○ AI: not configured (Settings → AI)${RESET}`
  }

  ${CYAN}→${RESET} ${BOLD}${getUrl()}${RESET}

  Press Ctrl+C to stop
`);
    return;
  }

  // Background daemon
  const paths = getPaths();
  mkdirSync(paths.dir, { recursive: true });

  const logFd = openSync(paths.log, 'a');
  const passArgs = [];
  if (process.env.TERMSEARCH_PORT)     passArgs.push(`--port=${process.env.TERMSEARCH_PORT}`);
  if (process.env.TERMSEARCH_HOST)     passArgs.push(`--host=${process.env.TERMSEARCH_HOST}`);
  if (process.env.TERMSEARCH_DATA_DIR) passArgs.push(`--data-dir=${process.env.TERMSEARCH_DATA_DIR}`);
  passArgs.push(DAEMON_FLAG);

  const child = spawn(process.execPath, [__filename, ...passArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();

  // Wait briefly to confirm it started
  await sleep(600);
  if (!isRunning(child.pid)) {
    err('Failed to start — check logs: termsearch logs');
    process.exit(1);
  }

  writeFileSync(paths.pid, String(child.pid));
  ok(`TermSearch v${VERSION} started  (PID ${child.pid})`);
  info(`${BOLD}${getUrl()}${RESET}`);
  info(`Logs: ${paths.log}`);
}

async function cmdStop() {
  const paths = getPaths();
  const { running, pid } = getStatus();
  if (!running) {
    warn('Not running');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    await sleep(800);
    if (isRunning(pid)) {
      process.kill(pid, 'SIGKILL');
      await sleep(300);
    }
    ok(`Stopped  (was PID ${pid})`);
    try { unlinkSync(paths.pid); } catch { /* ignore */ }
  } catch (e) {
    err(`Stop failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdRestart(flags) {
  await cmdStop();
  await sleep(400);
  await cmdStart(flags);
}

async function cmdStatus() {
  const { running, pid } = getStatus();
  const paths = getPaths();
  console.log('');
  console.log(`  ${BOLD}TermSearch v${VERSION}${RESET}`);
  if (running) {
    ok(`${BOLD}Running${RESET}  (PID ${pid})`);
    info(`${getUrl()}`);
    info(`Data: ${paths.dir}`);
    info(`Logs: ${paths.log}`);
  } else {
    warn('Stopped');
    info(`Run ${BOLD}termsearch start${RESET} to start`);
  }
  await printUpdateHint();
  console.log('');
}

function cmdOpen() {
  const url = getUrl();
  const isTermux = process.env.PREFIX?.includes('com.termux');
  const opener = isTermux
    ? ['termux-open-url', [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
    info(`Opening ${url}`);
  } catch {
    info(`Open manually: ${BOLD}${url}${RESET}`);
  }
}

function cmdLogs(flags) {
  const { log: logPath } = getPaths();
  if (!existsSync(logPath)) {
    warn('No log file yet — start termsearch first');
    return;
  }
  const lines = flags.n ? parseInt(flags.n, 10) : 60;
  const content = readFileSync(logPath, 'utf8');
  const tail = content.split('\n').slice(-lines).join('\n');
  console.log(tail);
}

async function cmdDoctor() {
  const paths = getPaths();
  const { running, pid } = getStatus();
  const port = getPort();
  let allOk = true;

  console.log('');
  console.log(`${BOLD}  TermSearch v${VERSION} — doctor${RESET}`);
  console.log('');

  // Node.js version
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) { ok(`Node.js ${process.versions.node}`); }
  else { err(`Node.js ${process.versions.node} — requires ≥ 18`); allOk = false; }

  // Platform
  const isTermux = process.env.PREFIX?.includes('com.termux') || existsSync('/data/data/com.termux');
  const platform = isTermux ? 'Termux' : process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : process.platform;
  ok(`Platform: ${platform}`);

  // Data dir
  try {
    const { mkdirSync, accessSync, constants } = await import('fs');
    mkdirSync(paths.dir, { recursive: true });
    accessSync(paths.dir, constants.W_OK);
    ok(`Data dir: ${paths.dir}`);
  } catch { err(`Data dir not writable: ${paths.dir}`); allOk = false; }

  // Server status
  if (running) { ok(`Server: running (PID ${pid})`); }
  else { warn('Server: not running'); }

  // HTTP health check (only if running)
  if (running) {
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 3000);
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ac.signal });
      if (r.ok) {
        const h = await r.json();
        ok(`HTTP: ${getUrl()} — providers: ${(h.providers || []).join(', ')}`);
        if (h.ai_enabled) ok(`AI: configured (${h.ai_model})`);
        else warn('AI: not configured (optional — Settings → AI)');
      } else { err(`HTTP: ${r.status} from /api/health`); allOk = false; }
    } catch (e) { err(`HTTP: cannot reach ${getUrl()} — ${e.message}`); allOk = false; }
  }

  // npm update check
  await printUpdateHint();

  console.log('');
  if (allOk) { ok(`${GREEN}All checks passed${RESET}`); }
  else { warn('Some checks failed — see above'); }
  console.log('');
}

async function cmdAutostart(sub) {
  const { getStatus: autostartStatus, setEnabled } = await import('../src/autostart/manager.js');
  if (sub === 'enable' || sub === 'disable') {
    try {
      const status = setEnabled(sub === 'enable');
      if (status.enabled) {
        ok(`Autostart enabled  (${status.method})`);
        info(`Config: ${status.config_path}`);
      } else {
        ok(`Autostart disabled`);
      }
      if (status.note) warn(status.note);
    } catch (e) {
      err(`Failed: ${e.message}`);
    }
    return;
  }
  // Show status
  const status = autostartStatus();
  console.log('');
  info(`Platform : ${status.platform}`);
  info(`Method   : ${status.method || 'N/A'}`);
  info(`Status   : ${status.enabled ? `${GREEN}enabled${RESET}` : `${DIM}disabled${RESET}`}`);
  if (status.config_path) info(`Config   : ${status.config_path}`);
  if (status.note) warn(status.note);
  if (!status.enabled) info(`Enable   : ${BOLD}termsearch autostart enable${RESET}`);
  console.log('');
}

async function cmdDefault(flags) {
  const { running, pid } = getStatus();
  if (running) {
    cmdStatus();
  } else {
    await cmdStart(flags);
    if (getStatus().running) {
      await sleep(300);
      cmdOpen();
    }
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${BOLD}TermSearch v${VERSION}${RESET}
Personal search engine — privacy-first, local-first

${BOLD}Usage:${RESET}
  ${CYAN}termsearch${RESET}                       Start (if stopped) or show status
  ${CYAN}termsearch${RESET} <command> [options]

${BOLD}Commands:${RESET}
  ${GREEN}start${RESET}                           Start server in background
  ${GREEN}start --fg${RESET}                      Start in foreground (shows logs live)
  ${GREEN}stop${RESET}                            Stop background server
  ${GREEN}restart${RESET}                         Restart server
  ${GREEN}status${RESET}                          Show running status + URL
  ${GREEN}open${RESET}                            Open browser to http://localhost:3000
  ${GREEN}logs${RESET} [-n <lines>]               Show server log (default: last 60 lines)
  ${GREEN}doctor${RESET}                          Check Node.js, data dir, server health
  ${GREEN}autostart${RESET}                       Show autostart (boot) status
  ${GREEN}autostart enable${RESET}                Enable autostart at boot
  ${GREEN}autostart disable${RESET}               Disable autostart at boot
  ${GREEN}version${RESET}                         Print version
  ${GREEN}help${RESET}                            Show this help

${BOLD}Options:${RESET}
  --port=<port>                   Port (default: 3000)
  --host=<host>                   Host (default: 127.0.0.1)
  --data-dir=<path>               Data dir (default: ~/.termsearch/)

${BOLD}Examples:${RESET}
  termsearch                      # start + open browser
  termsearch start                # start in background
  termsearch start --fg           # start in foreground
  termsearch stop                 # stop
  termsearch status               # check if running
  termsearch logs -n 100          # last 100 log lines
  termsearch autostart enable     # start at boot
  termsearch --port=8080 start    # custom port

${BOLD}Data:${RESET}  ~/.termsearch/config.json   (edit via Settings in browser)
${BOLD}Logs:${RESET}  ~/.termsearch/termsearch.log
${BOLD}URL:${RESET}   http://localhost:3000
`);
}

// ─── Update check ─────────────────────────────────────────────────────────

async function checkNpmUpdate() {
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 4000);
    const r = await fetch('https://registry.npmjs.org/termsearch/latest', { signal: ac.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const latest = data.version;
    if (!latest) return null;
    if (latest === VERSION) return { upToDate: true, latest };
    // Simple semver compare: split, compare numerically
    const cur = VERSION.split('.').map(Number);
    const lat = latest.split('.').map(Number);
    const newer = lat[0] > cur[0] || (lat[0] === cur[0] && lat[1] > cur[1]) || (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]);
    return { upToDate: !newer, latest };
  } catch {
    return null;
  }
}

async function printUpdateHint() {
  const update = await checkNpmUpdate();
  if (!update) return;
  if (update.upToDate) {
    ok(`Up to date (v${VERSION})`);
  } else {
    warn(`Update available: v${VERSION} → v${update.latest}`);
    info(`Run ${BOLD}npm install -g termsearch${RESET} to update`);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
