#!/usr/bin/env node
// Post-install check — runs after npm install -g termsearch
// Never throws: warnings only, install must always succeed.

import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';

function ok(msg)   { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}→${RESET} ${msg}`); }

let VERSION = '0.0.0';
try {
  const pkgPath = new URL('../package.json', import.meta.url);
  VERSION = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || VERSION;
} catch { /* ignore */ }

try {
  console.log('');
  console.log(`${BOLD}  TermSearch v${VERSION}${RESET} — post-install check`);
  console.log('');

  // ── Node.js version ──────────────────────────────────────────────────────
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) {
    ok(`Node.js ${process.versions.node}`);
  } else {
    warn(`Node.js ${process.versions.node} detected — requires ≥ 18.0.0`);
    warn('Please upgrade: https://nodejs.org');
  }

  // ── Platform ─────────────────────────────────────────────────────────────
  const isTermux = process.env.PREFIX?.includes('com.termux') ||
                   fs.existsSync('/data/data/com.termux');
  if (isTermux) {
    ok('Platform: Termux (Android) — compatible');
  } else if (process.platform === 'darwin') {
    ok('Platform: macOS — compatible');
  } else if (process.platform === 'linux') {
    ok('Platform: Linux — compatible');
  } else {
    warn(`Platform: ${process.platform} — not officially tested`);
  }

  // ── Home dir / data dir writable ─────────────────────────────────────────
  const dataDir = path.join(os.homedir(), '.termsearch');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    ok(`Data dir: ${dataDir}`);
  } catch {
    warn(`Cannot write to ${dataDir} — check permissions`);
  }

  // ── Systemd hint (Linux only, non-Termux) ─────────────────────────────────
  if (process.platform === 'linux' && !isTermux) {
    try {
      execSync('systemctl --user status > /dev/null 2>&1', { stdio: 'ignore' });
      ok('systemd --user: available (autostart supported)');
    } catch {
      warn('systemd --user: not available — autostart will use manual method');
    }
  }

  // ── Termux:Boot hint ──────────────────────────────────────────────────────
  if (isTermux) {
    const bootDir = path.join(os.homedir(), '.termux', 'boot');
    if (fs.existsSync(bootDir)) {
      ok('Termux:Boot: found — autostart supported');
    } else {
      info('Termux:Boot: install the app for autostart support');
      info('  → F-Droid: search "Termux:Boot"');
    }
  }

  console.log('');
  info(`Run ${BOLD}termsearch${RESET}${CYAN} to start v${VERSION} → http://localhost:3000`);
  console.log('');

} catch {
  // Never block the install
}
