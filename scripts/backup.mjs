import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.env.DATABASE_PATH || path.join(root, 'data/nextstep.sqlite'));
if (!fs.existsSync(source)) throw new Error('Database does not exist. Start the app first, or set DATABASE_PATH.');
const target = path.resolve(process.argv[2] || path.join(path.dirname(source), 'backups', `manual-${Date.now()}.sqlite`));
if (source === target || fs.existsSync(target)) throw new Error('Choose a new backup filename. Existing files are never overwritten.');
fs.mkdirSync(path.dirname(target), { recursive: true });
const db = new DatabaseSync(source);
try { db.prepare('VACUUM INTO ?').run(target); } finally { db.close(); }
const copy = new DatabaseSync(target, { readOnly: true });
try { if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed.'); } finally { copy.close(); }
console.log('Verified backup saved to ' + target);
