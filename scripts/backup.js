import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = resolve(process.env.DB_PATH || join(root, 'data/arena.sqlite'));
const folder = join(root, 'data/backups');
mkdirSync(folder, { recursive: true, mode: 0o700 });
const destination = join(folder, `arena-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
const uploads = join(root, 'data/uploads');
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.prepare('VACUUM INTO ?').run(destination);
  const imageBackup = destination.replace(/\.sqlite$/, '-uploads');
  if (existsSync(uploads)) cpSync(uploads, imageBackup, { recursive: true });
  console.log(`完整資料庫備份：${destination}`);
  if (existsSync(uploads)) console.log(`題目圖片備份：${imageBackup}`);
}
finally { db.close(); }
