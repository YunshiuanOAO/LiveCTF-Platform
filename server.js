import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(24).toString('base64url');
const digest = s => createHash('sha256').update(s).digest('hex');
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const str = (v, label, max = 100) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(400, `${label}不可空白，且最多 ${max} 字`);
  return v.trim();
};
const int = (v, min, max, label) => {
  if (!Number.isInteger(v) || v < min || v > max) fail(400, `${label}必須為 ${min}～${max} 的整數`);
  return v;
};
function passwordHash(value, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
function passwordMatches(value, hash) {
  const [salt, expected] = hash.split(':');
  return timingSafeEqual(Buffer.from(expected, 'hex'), scryptSync(value, salt, 64));
}

export function createApp({ dbPath = join(ROOT, 'data/arena.sqlite'), adminPassword = process.env.ADMIN_PASSWORD,
  now = () => Date.now(), secureCookie = process.env.COOKIE_SECURE === 'true', publicUrl = process.env.PUBLIC_URL } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size IN (2,3)), card_token TEXT NOT NULL UNIQUE, pin TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(student_id TEXT PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id));
    CREATE TABLE IF NOT EXISTS seats(id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, team_id INTEGER UNIQUE REFERENCES teams(id));
    CREATE TABLE IF NOT EXISTS questions(id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, flag_hash TEXT NOT NULL, duration INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rounds(id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL UNIQUE REFERENCES questions(id), duration INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', started_at INTEGER, deadline INTEGER, ended_at INTEGER);
    CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES rounds(id), team_a INTEGER NOT NULL REFERENCES teams(id), team_b INTEGER REFERENCES teams(id), winner INTEGER REFERENCES teams(id));
    CREATE TABLE IF NOT EXISTS solves(id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(id), team_id INTEGER NOT NULL REFERENCES teams(id), submitted_at INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, UNIQUE(match_id,team_id));
    CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES rounds(id), team_id INTEGER NOT NULL REFERENCES teams(id), at INTEGER NOT NULL, correct INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, team_id INTEGER REFERENCES teams(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS throttles(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
  `);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  if (!get("SELECT value FROM settings WHERE key='admin_hash'")) {
    if (!adminPassword || adminPassword.length < 12) { db.close(); throw new Error('首次啟動請設定至少 12 字元的 ADMIN_PASSWORD'); }
    run("INSERT INTO settings VALUES('admin_hash',?)", passwordHash(adminPassword));
  }
  if (!get('SELECT id FROM seats LIMIT 1')) {
    for (let row = 0; row < 4; row++) for (let col = 1; col <= 6; col++) run('INSERT INTO seats(label) VALUES(?)', `${String.fromCharCode(65 + row)}${col}`);
  }
  const audit = (action, detail = {}) => run('INSERT INTO audit(at,action,detail) VALUES(?,?,?)', now(), action, JSON.stringify(detail));
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function finishExpired() {
    for (const r of all("SELECT id FROM rounds WHERE status='running' AND deadline<=?", now())) {
      run("UPDATE rounds SET status='finished',ended_at=deadline WHERE id=? AND status='running'", r.id);
      audit('round.timeout', { roundId: r.id });
    }
  }
  function members(id) { return all('SELECT student_id FROM members WHERE team_id=? ORDER BY student_id', id).map(m => m.student_id); }
  function stats(id) {
    const rows = all(`SELECT m.*,r.status,r.id AS round_number,q.title,s.elapsed_ms,
      CASE WHEN m.team_a=? THEN tb.name ELSE ta.name END AS opponent
      FROM matches m JOIN rounds r ON r.id=m.round_id JOIN questions q ON q.id=r.question_id
      JOIN teams ta ON ta.id=m.team_a LEFT JOIN teams tb ON tb.id=m.team_b
      LEFT JOIN solves s ON s.match_id=m.id AND s.team_id=?
      WHERE (m.team_a=? OR m.team_b=?) AND r.status!='scheduled' ORDER BY r.id`, id, id, id, id);
    const results = rows.map(m => ({ roundId: m.round_number, title: m.title, opponent: m.opponent,
      elapsedMs: m.elapsed_ms, result: !m.team_b ? 'bye' : m.winner ? (m.winner === id ? 'win' : 'loss') : m.status === 'finished' ? 'draw' : 'pending' }));
    return { wins: results.filter(r => r.result === 'win').length, losses: results.filter(r => r.result === 'loss').length,
      draws: results.filter(r => r.result === 'draw').length, totalSolveMs: results.reduce((n, r) => n + (r.elapsedMs ?? 0), 0),
      solved: results.filter(r => r.elapsedMs !== null).length, results };
  }
  function nextOpponent(id) {
    return get(`SELECT r.id AS roundId,CASE WHEN m.team_a=? THEN tb.name ELSE ta.name END AS opponent,
      CASE WHEN m.team_a=? THEN sb.label ELSE sa.label END AS opponentSeat
      FROM matches m JOIN rounds r ON r.id=m.round_id JOIN teams ta ON ta.id=m.team_a LEFT JOIN teams tb ON tb.id=m.team_b
      LEFT JOIN seats sa ON sa.team_id=m.team_a LEFT JOIN seats sb ON sb.team_id=m.team_b
      WHERE r.status='scheduled' AND (m.team_a=? OR m.team_b=?) ORDER BY r.id LIMIT 1`, id, id, id, id) ?? null;
  }
  function teamView(t, privateData = false) {
    const count = get('SELECT count(*) AS n FROM members WHERE team_id=?', t.id).n;
    return { id: t.id, name: t.name, size: t.size, memberCount: count, registered: count === t.size,
      seat: get('SELECT label FROM seats WHERE team_id=?', t.id)?.label ?? null, ...stats(t.id), next: nextOpponent(t.id),
      ...(privateData ? { members: members(t.id), pin: t.pin, cardToken: t.card_token } : {}) };
  }
  function roundView(r, admin = false, teamId = null) {
    const q = get('SELECT * FROM questions WHERE id=?', r.question_id);
    const matches = all('SELECT * FROM matches WHERE round_id=? ORDER BY id', r.id).filter(m => !teamId || m.team_a === teamId || m.team_b === teamId).map(m => ({
      id: m.id, teamA: m.team_a, teamB: m.team_b, nameA: get('SELECT name FROM teams WHERE id=?', m.team_a).name,
      nameB: m.team_b ? get('SELECT name FROM teams WHERE id=?', m.team_b).name : null,
      winner: m.winner, solves: all('SELECT team_id AS teamId,elapsed_ms AS elapsedMs FROM solves WHERE match_id=?', m.id)
    }));
    return { id: r.id, questionId: r.question_id, duration: r.duration, status: r.status, startedAt: r.started_at,
      deadline: r.deadline, endedAt: r.ended_at, title: admin || r.status !== 'scheduled' ? q.title : '尚未公布',
      description: admin || r.status !== 'scheduled' ? q.description : '', matches };
  }
  function activeFor(id) {
    const r = get(`SELECT r.* FROM rounds r JOIN matches m ON m.round_id=r.id
      WHERE r.status='running' AND (m.team_a=? OR m.team_b=?)`, id, id);
    return r ? roundView(r, false, id) : null;
  }
  function throttle(key, limit, windowMs) {
    const t = get('SELECT * FROM throttles WHERE key=?', key);
    if (!t || t.until_at <= now()) run('INSERT OR REPLACE INTO throttles VALUES(?,1,?)', key, now() + windowMs);
    else { if (t.count >= limit) fail(429, '操作太頻繁，請稍後再試'); run('UPDATE throttles SET count=count+1 WHERE key=?', key); }
  }
  function session(req, role) {
    const raw = /(?:^|;\s*)arena_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const s = raw ? get('SELECT * FROM sessions WHERE token_hash=? AND expires>?', digest(raw), now()) : null;
    if (!s || (role && s.role !== role)) fail(401, '請先登入');
    return s;
  }
  function setSession(res, role, teamId = null) {
    const raw = token();
    run('INSERT INTO sessions VALUES(?,?,?,?)', digest(raw), role, teamId, now() + 12 * 3600_000);
    res.setHeader('Set-Cookie', `arena_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookie ? '; Secure' : ''}`);
  }
  const cardTeam = key => get('SELECT * FROM teams WHERE card_token=?', key) ?? fail(404, '戰鬥卡不存在或已失效');
  const requireTeam = id => get('SELECT * FROM teams WHERE id=?', id) ?? fail(404, '隊伍不存在');
  const busy = id => !!get(`SELECT m.id FROM matches m JOIN rounds r ON r.id=m.round_id WHERE r.status='running' AND (m.team_a=? OR m.team_b=?)`, id, id);
  function roster(values, size) {
    if (!Array.isArray(values) || ![2, 3].includes(size) || values.length !== size) fail(400, `請輸入全隊 2 或 3 位成員的學號`);
    const ids = values.map(v => str(v, '學號', 40).toUpperCase());
    if (ids.some(id => !/^[A-Z0-9_-]{2,40}$/.test(id)) || new Set(ids).size !== size) fail(400, '學號格式錯誤或重複（可使用英文、數字、底線與連字號）');
    return ids.sort();
  }
  function saveRoster(id, values, size) {
    const ids = roster(values, size);
    if (ids.some(s => get('SELECT team_id FROM members WHERE student_id=? AND team_id!=?', s, id))) fail(409, '有學號已加入其他隊伍');
    run('DELETE FROM members WHERE team_id=?', id);
    for (const s of ids) run('INSERT INTO members VALUES(?,?)', s, id);
  }
  async function route(req, res, url, body) {
    const path = url.pathname, method = req.method, ip = req.socket.remoteAddress;
    if (method === 'POST' && path === '/api/admin/login') {
      throttle(`admin:${ip}`, 12, 60_000);
      if (!passwordMatches(str(body.password, '密碼', 256), get("SELECT value FROM settings WHERE key='admin_hash'").value)) fail(401, '密碼錯誤');
      setSession(res, 'admin'); return { ok: true };
    }
    if (method === 'POST' && path === '/api/login') {
      throttle(`login:${ip}`, 240, 60_000);
      const ids = roster(body.studentIds, Array.isArray(body.studentIds) ? body.studentIds.length : 0);
      throttle(`login-roster:${digest(ids.join(','))}`, 12, 60_000);
      const t = get('SELECT t.* FROM teams t JOIN members m ON m.team_id=t.id WHERE m.student_id=?', ids[0]);
      if (!t || typeof body.pin !== 'string' || body.pin !== t.pin || JSON.stringify(members(t.id)) !== JSON.stringify(ids)) fail(401, '學號或組別登入碼不正確');
      setSession(res, 'team', t.id); return { ok: true };
    }
    if (method === 'POST' && path === '/api/logout') {
      const s = session(req); run('DELETE FROM sessions WHERE token_hash=?', s.token_hash);
      res.setHeader('Set-Cookie', `arena_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`); return { ok: true };
    }
    const card = /^\/api\/card\/([A-Za-z0-9_-]+)(\/register)?$/.exec(path);
    if (card) {
      throttle(`card:${ip}:${card[1]}`, 120, 60_000);
      const t = cardTeam(card[1]);
      if (method === 'GET' && !card[2]) return { team: { ...teamView(t), pin: t.pin }, active: activeFor(t.id), serverNow: now() };
      if (method === 'POST' && card[2]) {
        transaction(() => {
          if (members(t.id).length) fail(409, '此隊已完成註冊，成員變更請洽管理員');
          saveRoster(t.id, body.studentIds, t.size); audit('team.register', { teamId: t.id });
        }); return { ok: true };
      }
    }
    if (path.startsWith('/api/admin/')) {
      session(req, 'admin');
      if (method === 'GET' && path === '/api/admin/state') return {
        teams: all('SELECT * FROM teams ORDER BY id').map(t => teamView(t, true)), seats: all('SELECT id,label,enabled,team_id AS teamId FROM seats ORDER BY id'),
        questions: all('SELECT id,title,description,duration FROM questions ORDER BY id'), rounds: all('SELECT * FROM rounds ORDER BY id').map(r => roundView(r, true)),
        audit: all('SELECT * FROM audit ORDER BY id DESC LIMIT 40'), serverNow: now()
      };
      if (method === 'POST' && path === '/api/admin/teams') return transaction(() => {
        const name = str(body.name, '組別名稱', 50), size = int(body.size, 2, 3, '人數');
        if (get('SELECT id FROM teams WHERE name=?', name)) fail(409, '組別名稱已使用');
        const id = Number(run('INSERT INTO teams(name,size,card_token,pin) VALUES(?,?,?,?)', name, size, token(), String(randomInt(100000, 1000000))).lastInsertRowid);
        audit('team.create', { id, name, size }); return { id };
      });
      const teamRoute = /^\/api\/admin\/teams\/(\d+)(?:\/(rotate|qr))?$/.exec(path);
      if (teamRoute) {
        const id = Number(teamRoute[1]), t = requireTeam(id);
        if (method === 'PATCH' && !teamRoute[2]) return transaction(() => {
          if (busy(id)) fail(409, '比賽進行中不可更改成員或組別');
          const size = int(body.size, 2, 3, '人數'), name = str(body.name, '組別名稱', 50);
          if (get('SELECT id FROM teams WHERE name=? AND id!=?', name, id)) fail(409, '組別名稱已使用');
          if (body.studentIds?.length) saveRoster(id, body.studentIds, size);
          else if (members(id).length) fail(400, '已註冊隊伍請提供完整成員學號');
          run('UPDATE teams SET name=?,size=? WHERE id=?', name, size, id);
          run('DELETE FROM sessions WHERE team_id=?', id); audit('team.update', { id, name, size }); return { ok: true };
        });
        if (method === 'POST' && teamRoute[2] === 'rotate') {
          if (busy(id)) fail(409, '比賽進行中不可更換登入碼');
          let pin; do { pin = String(randomInt(100000, 1000000)); } while (pin === t.pin);
          transaction(() => { run('UPDATE teams SET pin=? WHERE id=?', pin, id); run('DELETE FROM sessions WHERE team_id=?', id); audit('team.rotate_pin', { id }); });
          return { ok: true };
        }
        if (method === 'GET' && teamRoute[2] === 'qr') {
          const base = publicUrl || `${secureCookie ? 'https' : 'http'}://${req.headers.host}`;
          const svg = await QRCode.toString(`${base.replace(/\/$/, '')}/card/${t.card_token}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(svg); return;
        }
      }
      if (method === 'PUT' && path === '/api/admin/seats') return transaction(() => {
        if (get("SELECT id FROM rounds WHERE status='running'")) fail(409, '比賽進行中不可移動座位');
        if (!Array.isArray(body.seats) || body.seats.length !== get('SELECT count(*) AS n FROM seats').n) fail(400, '請提供完整座位表');
        const seatIds = new Set(), teamIds = new Set();
        for (const s of body.seats) {
          if (!s || !Number.isInteger(s.id)) fail(400, '座位資料錯誤');
          if (!get('SELECT id FROM seats WHERE id=?', s.id) || seatIds.has(s.id) || typeof s.enabled !== 'boolean') fail(400, '座位資料錯誤');
          seatIds.add(s.id);
          if (s.teamId !== null) {
            if (!s.enabled || !Number.isInteger(s.teamId) || teamIds.has(s.teamId)) fail(400, '停用座位不可放隊伍，且隊伍不可重複入座');
            requireTeam(s.teamId); teamIds.add(s.teamId);
          }
        }
        const moved = all('SELECT team_id AS teamId,id FROM seats WHERE team_id IS NOT NULL').filter(s => body.seats.find(n => n.id === s.id)?.teamId !== s.teamId);
        run('UPDATE seats SET team_id=NULL');
        for (const s of body.seats) run('UPDATE seats SET enabled=?,team_id=? WHERE id=?', s.enabled ? 1 : 0, s.teamId, s.id);
        for (const s of moved) run('DELETE FROM sessions WHERE team_id=?', s.teamId);
        audit('seats.update', { movedTeams: moved.map(s => s.teamId) }); return { ok: true };
      });
      if (method === 'POST' && path === '/api/admin/questions') {
        const title = str(body.title, '題目名稱', 120), description = str(body.description, '題目內容', 12000), flag = str(body.flag, 'flag', 512);
        const duration = int(body.duration, 5, 10800, '限時秒數');
        const id = Number(run('INSERT INTO questions(title,description,flag_hash,duration) VALUES(?,?,?,?)', title, description, digest(flag), duration).lastInsertRowid);
        audit('question.create', { id, title }); return { id };
      }
      const questionRoute = /^\/api\/admin\/questions\/(\d+)$/.exec(path);
      if (questionRoute && method === 'PATCH') return transaction(() => {
        const id = Number(questionRoute[1]);
        const q = get('SELECT * FROM questions WHERE id=?', id);
        if (!q) fail(404, '題目不存在');
        if (get('SELECT id FROM rounds WHERE question_id=?', id)) fail(409, '已排程或已公開的題目不可編輯；未開賽者可先取消排程');
        const title = str(body.title, '題目名稱', 120), description = str(body.description, '題目內容', 12000);
        const duration = int(body.duration, 5, 10800, '限時秒數');
        const hash = body.flag ? digest(str(body.flag, 'flag', 512)) : q.flag_hash;
        run('UPDATE questions SET title=?,description=?,duration=?,flag_hash=? WHERE id=?', title, description, duration, hash, id);
        audit('question.update', { id, title }); return { ok: true };
      });
      if (method === 'POST' && path === '/api/admin/pairings/preview') {
        const available = all(`SELECT t.id FROM teams t JOIN seats s ON s.team_id=t.id WHERE s.enabled=1
          AND (SELECT count(*) FROM members WHERE team_id=t.id)=t.size`).map(t => t.id);
        if (available.length < 2) fail(400, '至少需要兩隊完成註冊並入座');
        for (let i = available.length - 1; i > 0; i--) { const j = randomInt(i + 1); [available[i], available[j]] = [available[j], available[i]]; }
        const pairs = [];
        if (available.length % 2) {
          available.sort((a, b) => get('SELECT count(*) AS n FROM matches WHERE team_a=? AND team_b IS NULL', a).n - get('SELECT count(*) AS n FROM matches WHERE team_a=? AND team_b IS NULL', b).n);
          pairs.push([available.shift(), null]);
        }
        while (available.length) {
          const a = available.shift();
          available.sort((x, y) => get('SELECT count(*) AS n FROM matches WHERE (team_a=? AND team_b=?) OR (team_a=? AND team_b=?)', a, x, x, a).n - get('SELECT count(*) AS n FROM matches WHERE (team_a=? AND team_b=?) OR (team_a=? AND team_b=?)', a, y, y, a).n);
          pairs.push([a, available.shift()]);
        }
        return { pairs };
      }
      if (method === 'POST' && path === '/api/admin/rounds') return transaction(() => {
        const q = get('SELECT * FROM questions WHERE id=?', int(body.questionId, 1, 1000000, '題目編號'));
        if (!q) fail(400, '請選擇題目');
        if (get('SELECT id FROM rounds WHERE question_id=?', q.id)) fail(409, '題目已排程或已公開，不能重複使用');
        const duration = int(body.duration ?? q.duration, 5, 10800, '限時秒數');
        if (!Array.isArray(body.pairs) || !body.pairs.length || body.pairs.length > 100) fail(400, '請設定對戰');
        const seen = new Set(); let realMatches = 0;
        for (const p of body.pairs) {
          if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || (p[1] !== null && !Number.isInteger(p[1]))) fail(400, '配對格式錯誤');
          if (p[1] !== null) realMatches++;
          for (const id of p.filter(x => x !== null)) {
            if (seen.has(id)) fail(400, '同一場次中隊伍不可重複'); seen.add(id);
            const t = requireTeam(id);
            if (members(id).length !== t.size || !get('SELECT id FROM seats WHERE team_id=? AND enabled=1', id)) fail(400, `${t.name} 尚未註冊完成或未入座`);
          }
        }
        if (!realMatches) fail(400, '至少需要一組兩隊對戰');
        const id = Number(run('INSERT INTO rounds(question_id,duration) VALUES(?,?)', q.id, duration).lastInsertRowid);
        for (const p of body.pairs) run('INSERT INTO matches(round_id,team_a,team_b) VALUES(?,?,?)', id, ...p);
        audit('round.schedule', { id, pairs: body.pairs }); return { id };
      });
      const roundRoute = /^\/api\/admin\/rounds\/(\d+)(?:\/(start|finish))?$/.exec(path);
      if (roundRoute) return transaction(() => {
        const id = Number(roundRoute[1]), r = get('SELECT * FROM rounds WHERE id=?', id);
        if (!r) fail(404, '場次不存在');
        if (method === 'DELETE' && !roundRoute[2]) {
          if (r.status !== 'scheduled') fail(409, '只可取消尚未開始的場次');
          run('DELETE FROM matches WHERE round_id=?', id); run('DELETE FROM rounds WHERE id=?', id); audit('round.cancel', { id }); return { ok: true };
        }
        if (method === 'PATCH' && !roundRoute[2]) {
          if (r.status !== 'scheduled') fail(409, '開賽後不可修改限時');
          run('UPDATE rounds SET duration=? WHERE id=?', int(body.duration, 5, 10800, '限時秒數'), id); return { ok: true };
        }
        if (method === 'POST' && roundRoute[2] === 'start') {
          if (r.status !== 'scheduled' || get("SELECT id FROM rounds WHERE status='running'")) fail(409, '已有進行中的題目，或此場次已開始');
          if (get("SELECT id FROM rounds WHERE status='scheduled' AND id<?", id)) fail(409, '請依排程順序逐題公布');
          for (const m of all('SELECT * FROM matches WHERE round_id=?', id)) for (const tid of [m.team_a, m.team_b].filter(Boolean)) {
            const t = requireTeam(tid);
            if (members(tid).length !== t.size || !get('SELECT id FROM seats WHERE enabled=1 AND team_id=?', tid)) fail(409, `${t.name} 尚未就緒，請確認成員與座位`);
          }
          const start = now(); run("UPDATE rounds SET status='running',started_at=?,deadline=? WHERE id=?", start, start + r.duration * 1000, id);
          audit('round.start', { id }); return { ok: true };
        }
        if (method === 'POST' && roundRoute[2] === 'finish') {
          if (r.status !== 'running') fail(409, '此場次未進行中');
          run("UPDATE rounds SET status='finished',ended_at=? WHERE id=?", now(), id); audit('round.finish_manual', { id }); return { ok: true };
        }
        fail(404, '操作不存在');
      });
      if (method === 'GET' && path === '/api/admin/export') {
        const rows = [['場次', '題目', '組別', '對手', '結果', '解題時間毫秒']];
        for (const t of all('SELECT * FROM teams ORDER BY id')) for (const r of stats(t.id).results) rows.push([r.roundId, r.title, t.name, r.opponent ?? '輪空', { win: '勝', loss: '敗', draw: '平', bye: '輪空', pending: '進行中' }[r.result], r.elapsedMs ?? '']);
        const csv = '\uFEFF' + rows.map(row => row.map(v => { let s = String(v); if (/^[=+@\-\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }).join(',')).join('\r\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="arena-results.csv"' }); res.end(csv); return;
      }
      fail(404, '管理功能不存在');
    }
    if (path === '/api/team/state' && method === 'GET') {
      const s = session(req, 'team'); return { team: teamView(requireTeam(s.team_id)), active: activeFor(s.team_id), serverNow: now() };
    }
    if (path === '/api/team/submit' && method === 'POST') {
      const s = session(req, 'team'); throttle(`submit:${s.team_id}`, 30, 60_000);
      const flag = str(body.flag, 'flag', 512), roundId = int(body.roundId, 1, 1000000, '場次編號');
      return transaction(() => {
        finishExpired();
        const r = get("SELECT * FROM rounds WHERE id=? AND status='running'", roundId);
        if (!r || now() >= r.deadline) fail(409, '題目尚未開始或已結束');
        const m = get('SELECT * FROM matches WHERE round_id=? AND (team_a=? OR team_b=?)', r.id, s.team_id, s.team_id);
        if (!m || !m.team_b) fail(403, '此題未安排對戰或為輪空');
        const previous = get('SELECT elapsed_ms FROM solves WHERE match_id=? AND team_id=?', m.id, s.team_id);
        if (previous) return { correct: true, duplicate: true, elapsedMs: previous.elapsed_ms, result: m.winner === s.team_id ? 'win' : 'loss' };
        const correct = digest(flag) === get('SELECT flag_hash FROM questions WHERE id=?', r.question_id).flag_hash;
        const at = now();
        if (at >= r.deadline) fail(409, '題目已結束');
        run('INSERT INTO attempts(round_id,team_id,at,correct) VALUES(?,?,?,?)', r.id, s.team_id, at, correct ? 1 : 0);
        if (!correct) return { correct: false, message: 'flag 不正確，再試一次' };
        run('INSERT INTO solves(match_id,team_id,submitted_at,elapsed_ms) VALUES(?,?,?,?)', m.id, s.team_id, at, at - r.started_at);
        if (!m.winner) run('UPDATE matches SET winner=? WHERE id=? AND winner IS NULL', s.team_id, m.id);
        audit('flag.correct', { roundId: r.id, teamId: s.team_id, elapsedMs: at - r.started_at });
        const unresolved = get(`SELECT count(*) AS n FROM matches m WHERE round_id=? AND team_b IS NOT NULL AND
          (SELECT count(*) FROM solves WHERE match_id=m.id)<2`, r.id).n;
        if (!unresolved) { run("UPDATE rounds SET status='finished',ended_at=? WHERE id=?", at, r.id); audit('round.all_solved', { id: r.id }); }
        return { correct: true, elapsedMs: at - r.started_at, result: !m.winner || m.winner === s.team_id ? 'win' : 'loss' };
      });
    }
    if (method === 'GET' && path === '/api/scoreboard') return { teams: all('SELECT * FROM teams ORDER BY id').map(t => teamView(t)).sort((a, b) => b.wins - a.wins || b.draws - a.draws || a.losses - b.losses),
      active: all("SELECT * FROM rounds WHERE status='running'").map(r => ({ id: r.id, deadline: r.deadline, title: get('SELECT title FROM questions WHERE id=?', r.question_id).title })), serverNow: now() };
    fail(404, '找不到此功能');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) fail(405, '不支援此操作');
        let body = {};
        if (req.method !== 'GET') {
          const origin = req.headers.origin;
          const allowedOrigin = publicUrl ? new URL(publicUrl).origin : `${secureCookie ? 'https' : 'http'}://${req.headers.host}`;
          if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== allowedOrigin)) fail(403, '不接受跨站操作');
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) fail(415, '請使用 JSON');
          let raw = '';
          for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 65536) fail(413, '請求內容過大'); }
          try { body = raw ? JSON.parse(raw) : {}; } catch { fail(400, 'JSON 格式錯誤'); }
          if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'JSON 必須為物件');
        }
        finishExpired();
        const result = await route(req, res, url, body);
        if (!res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); }
      } else {
        if (req.method !== 'GET') fail(405, '不支援此操作');
        const files = { '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
        const entry = files[url.pathname] ?? ((['/', '/admin', '/play'].includes(url.pathname) || /^\/card\/[A-Za-z0-9_-]+$/.test(url.pathname)) ? ['index.html', 'text/html'] : null);
        if (!entry) fail(404, '頁面不存在');
        res.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8` }); res.end(readFileSync(join(ROOT, 'public', entry[0])));
      }
    } catch (e) {
      if (!res.headersSent) { res.writeHead(e.status ?? 500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.status ? e.message : '伺服器發生錯誤，請聯絡管理員' })); }
      else res.end();
      if (!e.status) console.error(e);
    }
  });
  server.requestTimeout = 15000;
  const interval = setInterval(() => {
    try { finishExpired(); run('DELETE FROM sessions WHERE expires<=?', now()); run('DELETE FROM throttles WHERE until_at<=?', now()); } catch (e) { console.error(e); }
  }, 500);
  interval.unref();
  return { server, db, close: async () => { clearInterval(interval); await new Promise(resolve => server.close(resolve)); db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp({ dbPath: process.env.DB_PATH || join(ROOT, 'data/arena.sqlite') });
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Arena CTF 已啟動：http://localhost:${port}（管理後台 /admin）`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
