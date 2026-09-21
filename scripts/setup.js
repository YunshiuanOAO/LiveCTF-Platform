import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, '.env');
if (existsSync(target)) { console.log('.env 已存在，保留目前設定。'); process.exit(0); }
const ips = Object.entries(networkInterfaces()).filter(([name]) => !/docker|veth|br-/.test(name)).flatMap(([, entries]) => entries).filter(n => n.family === 'IPv4' && !n.internal);
const host = ips.find(n => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(n.address))?.address ?? ips[0]?.address ?? 'localhost';
writeFileSync(target, `ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}\nHOST=0.0.0.0\nPORT=3000\n# 使用同一個網址開啟後台，確保手機掃 QR Code 可以連線\nPUBLIC_URL=http://${host}:3000\nCOOKIE_SECURE=false\n`, { mode: 0o600 });
mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
console.log(`設定完成。管理員密碼存放在 ${target} 的 ADMIN_PASSWORD。\n現場網址：http://${host}:3000\n請執行 npm run seed 與 npm start。`);
