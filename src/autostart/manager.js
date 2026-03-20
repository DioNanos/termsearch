// Autostart manager — enable/disable TermSearch at boot
// Supports: Termux (Termux:Boot), Linux (systemd --user), macOS (launchd)

import { execSync, execFileSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

// ── Platform detection ────────────────────────────────────────────────────

export function detectPlatform() {
  if (process.env.PREFIX?.includes('com.termux') || fs.existsSync('/data/data/com.termux')) {
    return 'termux';
  }
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'unsupported';
}

// ── Binary path ───────────────────────────────────────────────────────────

function findBin() {
  try {
    return execSync('which termsearch', { encoding: 'utf8' }).trim();
  } catch {
    return 'termsearch'; // fallback: hope it's in PATH
  }
}

// ── Termux (Termux:Boot) ──────────────────────────────────────────────────

const TERMUX_BOOT_DIR  = path.join(os.homedir(), '.termux', 'boot');
const TERMUX_BOOT_FILE = path.join(TERMUX_BOOT_DIR, 'termsearch.sh');

function termuxStatus() {
  const bootAppInstalled = fs.existsSync(TERMUX_BOOT_DIR);
  const enabled = fs.existsSync(TERMUX_BOOT_FILE);
  return {
    platform: 'termux',
    enabled,
    method: 'Termux:Boot',
    config_path: TERMUX_BOOT_FILE,
    note: bootAppInstalled
      ? null
      : 'Install Termux:Boot from F-Droid to enable autostart',
    available: bootAppInstalled,
  };
}

function termuxEnable() {
  fs.mkdirSync(TERMUX_BOOT_DIR, { recursive: true });
  const bin = findBin();
  const sh = `#!/data/data/com.termux/files/usr/bin/sh\n# TermSearch autostart\n${bin} start --fg &\n`;
  fs.writeFileSync(TERMUX_BOOT_FILE, sh, { mode: 0o755 });
}

function termuxDisable() {
  if (fs.existsSync(TERMUX_BOOT_FILE)) fs.unlinkSync(TERMUX_BOOT_FILE);
}

// ── Linux (systemd --user) ────────────────────────────────────────────────

const SYSTEMD_DIR  = path.join(os.homedir(), '.config', 'systemd', 'user');
const SYSTEMD_FILE = path.join(SYSTEMD_DIR, 'termsearch.service');

function systemdAvailable() {
  try {
    execSync('systemctl --user status > /dev/null 2>&1', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function systemdEnabled() {
  try {
    const out = execSync('systemctl --user is-enabled termsearch 2>/dev/null', { encoding: 'utf8' });
    return out.trim() === 'enabled';
  } catch {
    return false;
  }
}

function linuxStatus() {
  const available = systemdAvailable();
  return {
    platform: 'linux',
    enabled: available ? systemdEnabled() : fs.existsSync(SYSTEMD_FILE),
    method: 'systemd --user',
    config_path: SYSTEMD_FILE,
    note: available ? null : 'systemd --user not available on this system',
    available,
  };
}

function linuxEnable() {
  const bin = findBin();
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  const unit = [
    '[Unit]',
    'Description=TermSearch personal search engine',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${bin} start --fg`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n') + '\n';
  fs.writeFileSync(SYSTEMD_FILE, unit);
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', 'termsearch'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'start', 'termsearch'], { stdio: 'ignore' });
  } catch { /* daemon-reload may fail in containers — file is written */ }
}

function linuxDisable() {
  try {
    execFileSync('systemctl', ['--user', 'stop', 'termsearch'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'disable', 'termsearch'], { stdio: 'ignore' });
  } catch { /* ignore */ }
  if (fs.existsSync(SYSTEMD_FILE)) fs.unlinkSync(SYSTEMD_FILE);
}

// ── macOS (launchd) ───────────────────────────────────────────────────────

const LAUNCHD_DIR  = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_FILE = path.join(LAUNCHD_DIR, 'com.termsearch.plist');
const PLIST_LABEL  = 'com.termsearch';

function macosStatus() {
  const enabled = fs.existsSync(LAUNCHD_FILE);
  return {
    platform: 'macos',
    enabled,
    method: 'launchd (LaunchAgent)',
    config_path: LAUNCHD_FILE,
    note: null,
    available: true,
  };
}

function macosEnable() {
  const bin = findBin();
  fs.mkdirSync(LAUNCHD_DIR, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>start</string>
    <string>--fg</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${os.homedir()}/.termsearch/termsearch.log</string>
  <key>StandardErrorPath</key>
  <string>${os.homedir()}/.termsearch/termsearch.log</string>
</dict>
</plist>
`;
  fs.writeFileSync(LAUNCHD_FILE, plist);
  // Try modern bootstrap API first (macOS Ventura+), fallback to legacy load
  try {
    const uid = execSync('id -u', { encoding: 'utf8' }).trim();
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, LAUNCHD_FILE], { stdio: 'ignore' });
  } catch {
    try { execFileSync('launchctl', ['load', '-w', LAUNCHD_FILE], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

function macosDisable() {
  try {
    const uid = execSync('id -u', { encoding: 'utf8' }).trim();
    execFileSync('launchctl', ['bootout', `gui/${uid}`, LAUNCHD_FILE], { stdio: 'ignore' });
  } catch {
    try { execFileSync('launchctl', ['unload', '-w', LAUNCHD_FILE], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  if (fs.existsSync(LAUNCHD_FILE)) fs.unlinkSync(LAUNCHD_FILE);
}

// ── Public API ────────────────────────────────────────────────────────────

export function getStatus() {
  const platform = detectPlatform();
  if (platform === 'termux') return termuxStatus();
  if (platform === 'linux')  return linuxStatus();
  if (platform === 'macos')  return macosStatus();
  return { platform: 'unsupported', enabled: false, method: null, note: 'Autostart not supported on this platform', available: false };
}

export function setEnabled(enable) {
  const platform = detectPlatform();
  if (platform === 'termux') { enable ? termuxEnable() : termuxDisable(); return getStatus(); }
  if (platform === 'linux')  { enable ? linuxEnable()  : linuxDisable();  return getStatus(); }
  if (platform === 'macos')  { enable ? macosEnable()  : macosDisable();  return getStatus(); }
  throw new Error('Autostart not supported on this platform');
}
