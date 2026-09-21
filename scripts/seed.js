import { createHash } from 'node:crypto';
import { createApp } from '../server-v2.js';
const app = createApp({ dbPath: process.env.DB_PATH });
try {
  if (app.db.prepare("SELECT value FROM settings WHERE key='sample_questions_seeded'").get()) {
    console.log('入門題目已匯入，未重複建立。');
  } else {
    const examples = [
      { title: '01 / 第一封密文', flag: 'flag{first_contact}', duration: 180,
        description: '通訊中截獲一段以 Base64 編碼的訊息。\n請還原訊息，提交解出的完整 flag。\n\n' + Buffer.from('flag{first_contact}').toString('base64') },
      { title: '02 / 十六進位足跡', flag: 'flag{hex_hunter}', duration: 180,
        description: '記憶體片段留下以下十六進位位元組（ASCII / UTF-8）。\n請將它還原為文字，提交完整 flag。\n\n' + Buffer.from('flag{hex_hunter}').toString('hex').match(/../g).join(' ') },
      { title: '03 / 旋轉十三格', flag: 'flag{rotate_thirteen}', duration: 240,
        description: '這段密文使用 ROT13：英文字母在字母表中循環平移 13 格，其他符號不變。\n請還原並提交完整 flag。\n\nsynt{ebgngr_guvegrra}' },
      { title: '04 / 二進位信號', flag: 'flag{bits}', duration: 240,
        description: '每一組 8 位元代表一個 ASCII 字元。請解碼並提交完整 flag。\n\n' + [...Buffer.from('flag{bits}')].map(b => b.toString(2).padStart(8, '0')).join(' ') }
    ];
    app.db.exec('BEGIN IMMEDIATE');
    for (const q of examples) app.db.prepare('INSERT INTO questions(title,description,flag_hash,duration) VALUES(?,?,?,?)').run(q.title, q.description, createHash('sha256').update(q.flag).digest('hex'), q.duration);
    app.db.prepare("INSERT INTO settings VALUES('sample_questions_seeded','1')").run();
    app.db.exec('COMMIT');
    console.log('已匯入 4 道可直接比賽的入門題目；未建立示範隊伍或虛構成績。');
  }
} finally { await app.close(); }
