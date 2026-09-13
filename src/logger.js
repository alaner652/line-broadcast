// logger.js — file + console logger for the broadcast CLI.
//
// Every run appends to logs/broadcast-YYYY-MM-DD.log (one line per event,
// human-readable, timestamped) so an operator who comes back to "it stopped
// halfway" can see exactly which recipient failed and why. Errors also go to
// stderr so they are visible in the console window.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function dateTag(d = new Date()) {
  return stamp(d).slice(0, 10);
}

export function fileTag(d = new Date()) {
  return stamp(d).replace(/[- :]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2');
}

export function createLogger({ runId, quiet = false } = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `broadcast-${dateTag()}.log`);

  function write(level, msg, extra) {
    const line =
      `${stamp()} [${level}]${runId ? ` [${runId}]` : ''} ${msg}` +
      (extra !== undefined ? ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '');
    try {
      fs.appendFileSync(file, line + '\n');
    } catch {
      // A log-write failure must never abort a send loop.
    }
    if (quiet && level === 'INFO') return;
    (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(line);
  }

  return {
    file,
    info: (m, x) => write('INFO', m, x),
    warn: (m, x) => write('WARN', m, x),
    error: (m, x) => write('ERROR', m, x),
  };
}
