import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
if (process.argv.length !== 4) throw new Error('Usage: node scripts/restore.mjs <backup.sqlite> <new-database.sqlite>. Restore into a NEW file while the app is stopped.');
const source = path.resolve(process.argv[2]), target = path.resolve(process.argv[3]);
if (!fs.existsSync(source) || fs.existsSync(target) || fs.existsSync(target + '-wal') || fs.existsSync(target + '-shm')) throw new Error('Backup must exist and the destination must be new. Existing databases are never overwritten.');
const db = new DatabaseSync(source, { readOnly: true });
try {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup is not a valid SQLite database.');
  for (const table of ['users', 'tasks']) if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('Not a NextStep database.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  db.prepare('VACUUM INTO ?').run(target);
} finally { db.close(); }
console.log('Restored to ' + target + '. Set DATABASE_PATH to this file before starting the app.');
