import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(24).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const text = (value, label, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${label}不可空白，且最多 ${max} 字`);
  return value.trim();
};
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(400, `${label}必須為 ${min}～${max} 的整數`);
  return value;
};
const passwordHash = (value, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
function passwordMatches(value, hash) {
  const [salt, expected] = hash.split(':');
  return timingSafeEqual(Buffer.from(expected, 'hex'), scryptSync(value, salt, 64));
}

function migrateLegacy(db) {
  const old = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='teams'").get()?.sql ?? '';
  if (!old || !/CHECK\s*\(\s*size\s+IN\s*\(2,3\)/i.test(old)) return;
  const threePersonTeams = db.prepare(`SELECT t.id,t.name,
    (SELECT student_id FROM members WHERE team_id=t.id ORDER BY rowid LIMIT 1 OFFSET 2) third_student
    FROM teams t WHERE size=3`).all();
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    ALTER TABLE teams RENAME TO teams_legacy;
    ALTER TABLE members RENAME TO members_legacy;
    ALTER TABLE rounds RENAME TO rounds_legacy;
    ALTER TABLE matches RENAME TO matches_legacy;
    ALTER TABLE solves RENAME TO solves_legacy;
    ALTER TABLE attempts RENAME TO attempts_legacy;
    ALTER TABLE sessions RENAME TO sessions_legacy;
    CREATE TABLE teams(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,size INTEGER NOT NULL CHECK(size IN(1,2)),initial_station INTEGER UNIQUE,created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE members(student_id TEXT PRIMARY KEY,team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE);
    CREATE TABLE rounds(id INTEGER PRIMARY KEY,question_id INTEGER UNIQUE REFERENCES questions(id),duration INTEGER,status TEXT NOT NULL DEFAULT 'planned',started_at INTEGER,deadline INTEGER,ended_at INTEGER);
    CREATE TABLE matches(id INTEGER PRIMARY KEY,round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,team_a INTEGER NOT NULL REFERENCES teams(id),team_b INTEGER NOT NULL REFERENCES teams(id),winner INTEGER REFERENCES teams(id),arena INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE solves(id INTEGER PRIMARY KEY,match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,team_id INTEGER NOT NULL REFERENCES teams(id),submitted_at INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,UNIQUE(match_id,team_id));
    CREATE TABLE attempts(id INTEGER PRIMARY KEY,round_id INTEGER NOT NULL REFERENCES rounds(id),team_id INTEGER NOT NULL REFERENCES teams(id),at INTEGER NOT NULL,correct INTEGER NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,role TEXT NOT NULL,team_id INTEGER REFERENCES teams(id),round_id INTEGER REFERENCES rounds(id),expires INTEGER NOT NULL);
    INSERT INTO teams(id,name,size,initial_station,created_at) SELECT id,name,MIN(size,2),id,0 FROM teams_legacy;
    INSERT INTO members SELECT student_id,team_id FROM members_legacy WHERE rowid IN (SELECT rowid FROM members_legacy m WHERE (SELECT count(*) FROM members_legacy x WHERE x.team_id=m.team_id AND x.rowid<=m.rowid)<=2);
    INSERT INTO rounds SELECT id,question_id,duration,status,started_at,deadline,ended_at FROM rounds_legacy;
    INSERT INTO matches(id,round_id,team_a,team_b,winner,arena) SELECT id,round_id,team_a,team_b,winner,id FROM matches_legacy WHERE team_b IS NOT NULL;
    INSERT INTO solves SELECT * FROM solves_legacy WHERE match_id IN (SELECT id FROM matches);
    INSERT INTO attempts SELECT * FROM attempts_legacy;
    INSERT INTO sessions(token_hash,role,team_id,round_id,expires) SELECT token_hash,role,team_id,NULL,expires FROM sessions_legacy;
    DROP TABLE solves_legacy; DROP TABLE attempts_legacy; DROP TABLE sessions_legacy; DROP TABLE matches_legacy; DROP TABLE rounds_legacy; DROP TABLE members_legacy; DROP TABLE teams_legacy; DROP TABLE IF EXISTS seats;
    COMMIT; PRAGMA foreign_keys=ON;`);
  for (const team of threePersonTeams) {
    if (!team.third_student) continue;
    let name = `${team.name} B`, suffix = 2;
    while (db.prepare('SELECT id FROM teams WHERE name=?').get(name)) name = `${team.name} B${suffix++}`;
    const station = db.prepare('SELECT COALESCE(MAX(initial_station),0)+1 n FROM teams').get().n;
    const id = Number(db.prepare('INSERT INTO teams(name,size,initial_station,created_at) VALUES(?,1,?,0)').run(name, station).lastInsertRowid);
    db.prepare('INSERT INTO members VALUES(?,?)').run(team.third_student, id);
  }
}

export function createApp({ dbPath = join(ROOT, 'data/arena.sqlite'), adminPassword = process.env.ADMIN_PASSWORD,
  now = () => Date.now(), secureCookie = process.env.COOKIE_SECURE === 'true', publicUrl = process.env.PUBLIC_URL,
  allowedOrigins = process.env.ALLOWED_ORIGINS, uploadDir = process.env.UPLOAD_DIR || join(ROOT, 'data/uploads'), random = Math.random } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  const trustedOrigins = new Set([publicUrl, ...(Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins ?? '').split(','))]
    .map(value => String(value ?? '').trim()).filter(Boolean).map(value => new URL(value).origin));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  migrateLegacy(db);
  db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,size INTEGER NOT NULL CHECK(size IN(1,2)),initial_station INTEGER UNIQUE,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS members(student_id TEXT PRIMARY KEY,team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS questions(id INTEGER PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,flag_hash TEXT NOT NULL,duration INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS rounds(id INTEGER PRIMARY KEY,question_id INTEGER UNIQUE REFERENCES questions(id),duration INTEGER,status TEXT NOT NULL DEFAULT 'planned',started_at INTEGER,deadline INTEGER,ended_at INTEGER);
    CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY,round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,team_a INTEGER NOT NULL REFERENCES teams(id),team_b INTEGER NOT NULL REFERENCES teams(id),winner INTEGER REFERENCES teams(id),arena INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS solves(id INTEGER PRIMARY KEY,match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,team_id INTEGER NOT NULL REFERENCES teams(id),submitted_at INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,UNIQUE(match_id,team_id));
    CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY,round_id INTEGER NOT NULL REFERENCES rounds(id),team_id INTEGER NOT NULL REFERENCES teams(id),at INTEGER NOT NULL,correct INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS readiness(round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,team_id INTEGER NOT NULL REFERENCES teams(id),computer_no INTEGER NOT NULL,ready_at INTEGER NOT NULL,PRIMARY KEY(round_id,team_id),UNIQUE(round_id,computer_no));
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,role TEXT NOT NULL,team_id INTEGER REFERENCES teams(id),round_id INTEGER REFERENCES rounds(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS handoffs(token_hash TEXT PRIMARY KEY,team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS throttles(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_at INTEGER NOT NULL);`);
  const columns = db.prepare('PRAGMA table_info(rounds)').all().map(row => row.name);
  if (!columns.includes('question_id')) db.exec('ALTER TABLE rounds ADD COLUMN question_id INTEGER REFERENCES questions(id)');
  const questionColumns = db.prepare('PRAGMA table_info(questions)').all().map(row => row.name);
  if (!questionColumns.includes('archived')) db.exec('ALTER TABLE questions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  if (!get("SELECT value FROM settings WHERE key='admin_hash'")) {
    if (!adminPassword || adminPassword.length < 12) { db.close(); throw new Error('首次啟動請設定至少 12 字元的 ADMIN_PASSWORD'); }
    run("INSERT INTO settings VALUES('admin_hash',?)", passwordHash(adminPassword));
  }
  if (!get("SELECT value FROM settings WHERE key='registration_locked'")) run("INSERT INTO settings VALUES('registration_locked','0')");
  if (!get("SELECT value FROM settings WHERE key='total_rounds'")) run("INSERT INTO settings VALUES('total_rounds','3')");
  const setting = key => get('SELECT value FROM settings WHERE key=?', key)?.value;
  const setSetting = (key, value) => run('INSERT OR REPLACE INTO settings VALUES(?,?)', key, String(value));
  const audit = (action, detail = {}) => run('INSERT INTO audit(at,action,detail) VALUES(?,?,?)', now(), action, JSON.stringify(detail));
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const members = id => all('SELECT student_id FROM members WHERE team_id=? ORDER BY student_id', id).map(row => row.student_id);
  const requireTeam = id => get('SELECT * FROM teams WHERE id=?', id) ?? fail(404, '隊伍不存在');
  function roster(values) {
    if (!Array.isArray(values) || ![1, 2].includes(values.length)) fail(400, '請輸入全組 1 或 2 位成員的學號');
    const ids = values.map(value => text(value, '學號', 40).toUpperCase());
    if (ids.some(id => !/^[A-Z0-9_-]{2,40}$/.test(id)) || new Set(ids).size !== ids.length) fail(400, '學號格式錯誤或重複');
    return ids.sort();
  }
  function throttle(key, limit, windowMs) {
    const row = get('SELECT * FROM throttles WHERE key=?', key);
    if (!row || row.until_at <= now()) run('INSERT OR REPLACE INTO throttles VALUES(?,1,?)', key, now() + windowMs);
    else { if (row.count >= limit) fail(429, '操作太頻繁，請稍後再試'); run('UPDATE throttles SET count=count+1 WHERE key=?', key); }
  }
  function cookies(req) {
    return Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map(item => item.trim().split('=')));
  }
  const sessionCookie = role => role === 'admin' ? 'arena_admin_session' : role === 'team' ? 'arena_team_session' : null;
  function session(req, role, optional = false) {
    const values = cookies(req);
    const names = role ? [sessionCookie(role), 'arena_session'] : ['arena_admin_session', 'arena_team_session', 'arena_session'];
    for (const name of names) {
      const raw = values[name];
      const row = raw ? get('SELECT * FROM sessions WHERE token_hash=? AND expires>?', digest(raw), now()) : null;
      if (row && (!role || row.role === role)) return row;
    }
    if (optional) return null;
    fail(401, '請先登入');
  }
  function setCookie(res, name, raw, maxAge = 43200) {
    const value = `${name}=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
    const old = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', old ? [...(Array.isArray(old) ? old : [old]), value] : value);
  }
  function createSession(res, role, teamId = null, roundId = null) {
    const raw = token();
    run('INSERT INTO sessions VALUES(?,?,?,?,?)', digest(raw), role, teamId, roundId, now() + 12 * 3600_000);
    setCookie(res, sessionCookie(role), raw);
  }
  function createHandoff(res, teamId) {
    run('DELETE FROM handoffs WHERE team_id=?', teamId);
    const raw = token(); run('INSERT INTO handoffs VALUES(?,?,?)', digest(raw), teamId, now() + 12 * 3600_000);
    setCookie(res, 'arena_handoff', raw);
    return raw;
  }
  function handoffTeam(req) {
    const header = req.headers['x-arena-handoff'];
    const values = [typeof header === 'string' ? header : null, cookies(req).arena_handoff].filter(Boolean);
    for (const raw of values) {
      const row = get('SELECT team_id FROM handoffs WHERE token_hash=? AND expires>?', digest(raw), now());
      if (row) return row.team_id;
    }
    return null;
  }
  const stationFor = (match, teamId) => {
    const slot = match.team_a === teamId ? 0 : 1;
    return { arena: match.arena, groupPosition: slot + 1 };
  };
  function nextAssignment(teamId) {
    const match = get(`SELECT m.*,r.id round_number,r.status FROM matches m JOIN rounds r ON r.id=m.round_id
      WHERE r.status IN('planned','preparing') AND (m.team_a=? OR m.team_b=?) ORDER BY r.id LIMIT 1`, teamId, teamId);
    if (!match) return null;
    const opponentId = match.team_a === teamId ? match.team_b : match.team_a;
    return { roundId: match.round_number, status: match.status, opponent: requireTeam(opponentId).name, ...stationFor(match, teamId) };
  }
  function stats(teamId) {
    const rows = all(`SELECT r.id round_id,r.status,r.duration,q.title,m.team_a,m.team_b,m.winner,s.elapsed_ms,
      CASE WHEN m.team_a=? THEN tb.name ELSE ta.name END opponent
      FROM matches m JOIN rounds r ON r.id=m.round_id LEFT JOIN questions q ON q.id=r.question_id
      JOIN teams ta ON ta.id=m.team_a JOIN teams tb ON tb.id=m.team_b
      LEFT JOIN solves s ON s.match_id=m.id AND s.team_id=?
      WHERE (m.team_a=? OR m.team_b=?) AND r.status IN('running','finished') ORDER BY r.id`, teamId, teamId, teamId, teamId);
    const results = rows.map(row => {
      const finished = row.status === 'finished';
      const chargedMs = row.elapsed_ms ?? (finished ? row.duration * 1000 : null);
      return { roundId: row.round_id, title: row.title ?? '尚未設定題目', opponent: row.opponent, elapsedMs: row.elapsed_ms,
        chargedMs, completed: row.elapsed_ms !== null, result: row.winner ? (row.winner === teamId ? 'win' : 'loss') : finished ? 'draw' : 'pending' };
    });
    return { wins: results.filter(x => x.result === 'win').length, losses: results.filter(x => x.result === 'loss').length,
      draws: results.filter(x => x.result === 'draw').length, solved: results.filter(x => x.completed).length,
      totalTimeMs: results.reduce((sum, x) => sum + (x.chargedMs ?? 0), 0), results };
  }
  function teamView(team, privateData = false) {
    return { id: team.id, name: team.name, size: team.size, initialStation: team.initial_station, members: privateData ? members(team.id) : undefined,
      ...stats(team.id), next: nextAssignment(team.id) };
  }
  function roundView(round, admin = false, teamId = null) {
    const question = round.question_id ? get('SELECT * FROM questions WHERE id=?', round.question_id) : null;
    const matches = all('SELECT * FROM matches WHERE round_id=? ORDER BY arena', round.id).filter(m => !teamId || m.team_a === teamId || m.team_b === teamId).map(match => ({
      id: match.id, teamA: match.team_a, teamB: match.team_b, nameA: requireTeam(match.team_a).name, nameB: requireTeam(match.team_b).name,
      winner: match.winner, arena: match.arena, stationA: stationFor(match, match.team_a), stationB: stationFor(match, match.team_b),
      solves: all('SELECT team_id teamId,elapsed_ms elapsedMs FROM solves WHERE match_id=?', match.id)
    }));
    const ready = get('SELECT count(*) n FROM readiness WHERE round_id=?', round.id).n;
    const readyTeams = new Set(all('SELECT team_id FROM readiness WHERE round_id=?', round.id).map(row => row.team_id));
    const missingReady = admin && round.status === 'preparing' ? matches.flatMap(match => [
      { id: match.teamA, name: match.nameA, station: match.stationA },
      { id: match.teamB, name: match.nameB, station: match.stationB }
    ]).filter(team => !readyTeams.has(team.id)) : [];
    return { id: round.id, number: get('SELECT count(*) n FROM rounds WHERE id<=?', round.id).n, questionId: round.question_id, duration: round.duration, status: round.status, startedAt: round.started_at,
      deadline: round.deadline, endedAt: round.ended_at, title: question ? question.title : '尚未設定題目',
      description: question && (admin || round.status === 'running') ? question.description : '', ready, required: matches.length * 2, missingReady, matches };
  }
  function shuffle(values) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  }
  function createPairing() {
    if (get("SELECT id FROM rounds WHERE status IN('planned','preparing','running')")) return null;
    const teams = all('SELECT id FROM teams ORDER BY id').map(row => row.id);
    if (teams.length < 2 || teams.length % 2) fail(409, '隊伍必須是大於零的偶數');
    const previous = new Set(all(`SELECT team_a,team_b FROM matches WHERE round_id=(SELECT MAX(id) FROM rounds WHERE status='finished')`).flatMap(m => [`${m.team_a}:${m.team_b}`, `${m.team_b}:${m.team_a}`]));
    const pool = shuffle(teams);
    function pairWithoutRepeat(remaining) {
      if (!remaining.length) return [];
      const [a, ...others] = remaining;
      for (const b of shuffle(others.filter(teamId => !previous.has(`${a}:${teamId}`)))) {
        const rest = others.filter(teamId => teamId !== b), tail = pairWithoutRepeat(rest);
        if (tail) return [[a, b], ...tail];
      }
      return null;
    }
    const pairs = pairWithoutRepeat(pool) ?? Array.from({ length: pool.length / 2 }, (_, index) => [pool[index * 2], pool[index * 2 + 1]]);
    const roundId = Number(run("INSERT INTO rounds(question_id,duration,status) VALUES(NULL,NULL,'planned')").lastInsertRowid);
    pairs.forEach(([a, b], index) => run('INSERT INTO matches(round_id,team_a,team_b,arena) VALUES(?,?,?,?)', roundId, a, b, index + 1));
    audit('round.paired', { roundId, pairs }); return roundId;
  }
  function completeRound(roundId, reason, endedAt = now()) {
    const round = get("SELECT * FROM rounds WHERE id=? AND status='running'", roundId);
    if (!round) return false;
    run("UPDATE rounds SET status='finished',ended_at=? WHERE id=?", endedAt, roundId);
    run("DELETE FROM sessions WHERE role='team' AND round_id=?", roundId);
    audit(`round.${reason}`, { roundId });
    const completed = get("SELECT count(*) n FROM rounds WHERE status='finished'").n;
    if (setting('registration_locked') === '1' && completed < Number(setting('total_rounds'))) createPairing();
    else if (completed >= Number(setting('total_rounds'))) audit('event.complete', { rounds: completed });
    return true;
  }
  function finishExpired() {
    for (const round of all("SELECT id,deadline FROM rounds WHERE status='running' AND deadline<=?", now())) {
      transaction(() => completeRound(round.id, 'timeout', round.deadline));
    }
  }
  function currentRoundFor(teamId) {
    const row = get(`SELECT r.* FROM rounds r JOIN matches m ON m.round_id=r.id WHERE r.status='running' AND (m.team_a=? OR m.team_b=?)`, teamId, teamId);
    return row ? roundView(row, false, teamId) : null;
  }

  async function route(req, res, url, body) {
    const path = url.pathname, method = req.method, ip = req.socket.remoteAddress;
    if (method === 'GET' && path === '/api/event') {
      const current = get("SELECT id,status FROM rounds WHERE status IN('planned','preparing','running') ORDER BY id LIMIT 1");
      return { registrationLocked: setting('registration_locked') === '1', teamCount: get('SELECT count(*) n FROM teams').n, maxTeams: 30,
        totalRounds: Number(setting('total_rounds')), completedRounds: get("SELECT count(*) n FROM rounds WHERE status='finished'").n,
        roundStatus: current?.status ?? null, roundId: current?.id ?? null, serverNow: now() };
    }
    if (method === 'POST' && path === '/api/register') return transaction(() => {
      if (setting('registration_locked') === '1') fail(409, '報到已鎖定，請洽 Host');
      throttle(`register:${ip}`, 40, 60_000);
      if (get('SELECT count(*) n FROM teams').n >= 30) fail(409, '已達 30 組上限');
      const name = text(body.name, '隊伍名稱', 50), ids = roster(body.studentIds);
      let station;
      if (body.station === undefined || body.station === null || body.station === '') {
        station = Array.from({ length: 30 }, (_, index) => index + 1)
          .find(candidate => !get('SELECT id FROM teams WHERE initial_station=?', candidate));
        if (!station) fail(409, '沒有可用的組別位置');
      } else station = integer(body.station, 1, 30, '組別位置');
      if (get('SELECT id FROM teams WHERE name=?', name)) fail(409, '隊伍名稱已使用');
      if (get('SELECT id FROM teams WHERE initial_station=?', station)) fail(409, '此組別位置已完成報到');
      if (ids.some(id => get('SELECT team_id FROM members WHERE student_id=?', id))) fail(409, '有學號已加入其他隊伍');
      const id = Number(run('INSERT INTO teams(name,size,initial_station,created_at) VALUES(?,?,?,?)', name, ids.length, station, now()).lastInsertRowid);
      ids.forEach(student => run('INSERT INTO members VALUES(?,?)', student, id));
      const handoffToken = createHandoff(res, id);
      audit('team.register', { teamId: id, station });
      return { id, name, size: ids.length, station, handoffToken };
    });
    if (method === 'POST' && path === '/api/identify') {
      const ids = roster(body.studentIds); throttle(`team-identify:${digest(ids.join(','))}`, 12, 60_000);
      const team = get('SELECT t.* FROM teams t JOIN members m ON m.team_id=t.id WHERE m.student_id=?', ids[0]);
      if (!team || JSON.stringify(members(team.id)) !== JSON.stringify(ids)) fail(401, '全組學號不正確');
      const handoffToken = createHandoff(res, team.id);
      audit('team.identify', { teamId: team.id });
      return { id: team.id, name: team.name, size: team.size, station: team.initial_station, handoffToken };
    }
    if (method === 'POST' && path === '/api/admin/login') {
      throttle(`admin:${ip}`, 12, 60_000);
      if (!passwordMatches(text(body.password, '密碼', 256), setting('admin_hash'))) fail(401, '密碼錯誤');
      createSession(res, 'admin'); return { ok: true };
    }
    if (method === 'POST' && path === '/api/login') {
      if (setting('registration_locked') !== '1') fail(409, 'Host 尚未鎖定報到');
      const ids = roster(body.studentIds); throttle(`team-login:${digest(ids.join(','))}`, 12, 60_000);
      const team = get('SELECT t.* FROM teams t JOIN members m ON m.team_id=t.id WHERE m.student_id=?', ids[0]);
      if (!team || JSON.stringify(members(team.id)) !== JSON.stringify(ids)) fail(401, '全組學號不正確');
      const round = get("SELECT * FROM rounds WHERE status IN('preparing','running') ORDER BY id LIMIT 1");
      if (!round) fail(409, 'Host 尚未開放本輪登入');
      const match = get('SELECT * FROM matches WHERE round_id=? AND (team_a=? OR team_b=?)', round.id, team.id, team.id);
      if (!match) fail(403, '本局沒有安排此組');
      const wasReady = get('SELECT team_id FROM readiness WHERE round_id=? AND team_id=?', round.id, team.id);
      const expected = stationFor(match, team.id);
      const late = round.status === 'running' && !wasReady;
      let handoffToken;
      transaction(() => {
        if (!wasReady) run('INSERT INTO readiness VALUES(?,?,?,?)', round.id, team.id, team.id, now());
        run("DELETE FROM sessions WHERE role='team' AND team_id=?", team.id);
        createSession(res, 'team', team.id, round.id); handoffToken = createHandoff(res, team.id);
        audit(late ? 'team.late_ready' : round.status === 'running' ? 'team.session_recovered' : 'team.ready', { roundId: round.id, teamId: team.id });
      });
      return { ok: true, late, team: teamView(team), roundId: round.id, station: expected, handoffToken };
    }
    if (method === 'POST' && path === '/api/logout') {
      const values = cookies(req);
      for (const name of ['arena_admin_session', 'arena_team_session', 'arena_session']) {
        const raw = values[name];
        if (raw) run('DELETE FROM sessions WHERE token_hash=?', digest(raw));
        setCookie(res, name, '', 0);
      }
      return { ok: true };
    }
    if (method === 'GET' && path === '/api/team/state') {
      let current = session(req, 'team', true);
      const handedTeamId = handoffTeam(req), teamId = handedTeamId ?? current?.team_id;
      if (!teamId) fail(401, '請輸入全組學號進入對局準備');
      const team = requireTeam(teamId);
      if (current?.team_id !== teamId) current = null;
      let validSession = current && get("SELECT id FROM rounds WHERE id=? AND status IN('preparing','running')", current.round_id) ? current : null;
      if (!validSession) {
        const recoverable = get(`SELECT r.id round_id FROM readiness x JOIN rounds r ON r.id=x.round_id
          WHERE x.team_id=? AND r.status IN('preparing','running') ORDER BY r.id LIMIT 1`, team.id);
        if (recoverable) {
          validSession = { team_id: team.id, round_id: recoverable.round_id };
          if (!req.headers['x-arena-handoff']) {
            run("DELETE FROM sessions WHERE role='team' AND team_id=? AND round_id=?", team.id, recoverable.round_id);
            createSession(res, 'team', team.id, recoverable.round_id);
            audit('team.session_recovered', { teamId: team.id, roundId: recoverable.round_id });
          }
        }
      }
      const activeRound = get("SELECT id,status FROM rounds WHERE status IN('planned','preparing','running') ORDER BY id LIMIT 1");
      return { loggedIn: !!validSession, readyRoundId: validSession?.round_id ?? null, roundStatus: activeRound?.status ?? null,
        totalRounds: Number(setting('total_rounds')), completedRounds: get("SELECT count(*) n FROM rounds WHERE status='finished'").n,
        team: teamView(team), active: validSession ? currentRoundFor(team.id) : null, serverNow: now() };
    }
    const stationRoute = /^\/api\/station\/(\d+)$/.exec(path);
    if (method === 'GET' && stationRoute) {
      const computerNo = integer(Number(stationRoute[1]), 1, 30, '舊介面編號'), groupPosition = computerNo;
      const round = get("SELECT * FROM rounds WHERE status IN('planned','preparing','running') ORDER BY id LIMIT 1");
      let assignment = null;
      const registered = get('SELECT id,name,size FROM teams WHERE initial_station=?', groupPosition) ?? null;
      if (round && registered) {
        const match = get('SELECT * FROM matches WHERE round_id=? AND (team_a=? OR team_b=?)', round.id, registered.id, registered.id);
        if (match) assignment = { roundId: round.id, status: round.status, team: registered.name, opponent: requireTeam(match.team_a === registered.id ? match.team_b : match.team_a).name, ...stationFor(match, registered.id) };
      }
      return { computerNo, mode: 'team', groupPosition, registrationLocked: setting('registration_locked') === '1', registered, assignment, serverNow: now() };
    }
    if (path.startsWith('/api/admin/')) {
      session(req, 'admin');
      if (method === 'GET' && path === '/api/admin/state') return {
        registrationLocked: setting('registration_locked') === '1', teams: all('SELECT * FROM teams ORDER BY initial_station,id').map(t => teamView(t, true)),
        questions: all('SELECT id,title,description,duration FROM questions WHERE archived=0 ORDER BY id'), rounds: all('SELECT * FROM rounds ORDER BY id').map(r => roundView(r, true)),
        totalRounds: Number(setting('total_rounds')), completedRounds: get("SELECT count(*) n FROM rounds WHERE status='finished'").n,
        audit: all('SELECT * FROM audit ORDER BY id DESC LIMIT 50'), serverNow: now()
      };
      if (method === 'POST' && path === '/api/admin/settings') return transaction(() => {
        if (get("SELECT id FROM rounds WHERE status IN('running','finished') LIMIT 1")) fail(409, '競賽開始後不能修改總輪數');
        const totalRounds = integer(body.totalRounds, 1, 30, '總輪數');
        setSetting('total_rounds', totalRounds); audit('event.settings', { totalRounds }); return { ok: true, totalRounds };
      });
      if (method === 'POST' && path === '/api/admin/reset') return transaction(() => {
        if (body.confirmation !== 'RESET') fail(400, '請輸入 RESET 確認重設競賽');
        const summary = { teams: get('SELECT count(*) n FROM teams').n, rounds: get('SELECT count(*) n FROM rounds').n };
        run('DELETE FROM attempts');
        run("DELETE FROM sessions WHERE role='team'");
        run('DELETE FROM handoffs');
        run('DELETE FROM rounds');
        run('DELETE FROM members');
        run('DELETE FROM teams');
        run('DELETE FROM throttles');
        run('DELETE FROM audit');
        setSetting('registration_locked', 0);
        audit('event.reset', summary);
        return { ok: true, preservedQuestions: get('SELECT count(*) n FROM questions WHERE archived=0').n };
      });
      if (method === 'POST' && path === '/api/admin/results/clear') return transaction(() => {
        if (body.confirmation !== 'CLEAR') fail(400, '請輸入 CLEAR 確認清除練習成績');
        if (get("SELECT id FROM rounds WHERE status='running' LIMIT 1")) fail(409, '對局進行中，請先結束本輪');
        const summary = {
          rounds: get('SELECT count(*) n FROM rounds').n,
          attempts: get('SELECT count(*) n FROM attempts').n,
          solves: get('SELECT count(*) n FROM solves').n,
          teams: get('SELECT count(*) n FROM teams').n
        };
        run('DELETE FROM attempts');
        run("DELETE FROM sessions WHERE role='team'");
        run('DELETE FROM rounds');
        const paired = setting('registration_locked') === '1' && summary.teams >= 2 && summary.teams % 2 === 0 ? !!createPairing() : false;
        audit('event.results_cleared', { ...summary, paired });
        return { ok: true, teamCount: summary.teams, paired, preservedQuestions: get('SELECT count(*) n FROM questions WHERE archived=0').n };
      });
      if (method === 'POST' && path === '/api/admin/registration/lock') return transaction(() => {
        if (setting('registration_locked') === '1') fail(409, '報到已鎖定');
        let teams = all('SELECT * FROM teams ORDER BY created_at,id');
        if (teams.length < 2) fail(409, '至少需要 2 組');
        let split = null;
        if (teams.length % 2) {
          const last = teams.at(-1), ids = members(last.id);
          if (ids.length !== 2) fail(409, '目前是奇數組，最後一組必須有兩人才能自動拆組');
          let secondName = `${last.name} B`, n = 2;
          while (get('SELECT id FROM teams WHERE name=?', secondName)) secondName = `${last.name} B${n++}`;
          const firstName = `${last.name} A`;
          if (get('SELECT id FROM teams WHERE name=? AND id!=?', firstName, last.id)) fail(409, '自動拆組名稱衝突，請先修改最後一組名稱');
          run('UPDATE teams SET name=?,size=1 WHERE id=?', firstName, last.id);
          run('DELETE FROM members WHERE team_id=? AND student_id=?', last.id, ids[1]);
          const occupied = new Set(all('SELECT initial_station FROM teams').map(row => row.initial_station));
          let station = 1; while (occupied.has(station)) station++;
          if (station > 30) fail(409, '沒有可供拆組使用的組別位置');
          const newId = Number(run('INSERT INTO teams(name,size,initial_station,created_at) VALUES(?,1,?,?)', secondName, station, now()).lastInsertRowid);
          run('INSERT INTO members VALUES(?,?)', ids[1], newId); split = { originalId: last.id, newId, originalName: last.name, names: [firstName, secondName] };
          teams = all('SELECT * FROM teams ORDER BY id');
        }
        if (teams.length > 30 || teams.length % 2) fail(409, '鎖定後必須為 2～30 的偶數組');
        setSetting('registration_locked', 1); const roundId = createPairing(); audit('registration.lock', { teams: teams.length, split });
        return { ok: true, teamCount: teams.length, split, roundId };
      });
      if (method === 'POST' && path === '/api/admin/registration/unlock') return transaction(() => {
        if (setting('registration_locked') !== '1') fail(409, '報到目前已是解鎖狀態');
        if (get("SELECT id FROM rounds WHERE status='running'")) fail(409, '對局進行中，請先結束本局再解鎖報到');
        const pendingRounds = all("SELECT id FROM rounds WHERE status IN('planned','preparing')");
        for (const round of pendingRounds) {
          run('DELETE FROM sessions WHERE round_id=?', round.id);
          run('DELETE FROM rounds WHERE id=?', round.id);
        }
        let revertedSplit = false;
        const lastLock = get("SELECT detail FROM audit WHERE action='registration.lock' ORDER BY id DESC LIMIT 1");
        if (lastLock) {
          try {
            const split = JSON.parse(lastLock.detail).split;
            const original = split && get('SELECT * FROM teams WHERE id=?', split.originalId);
            const added = split && get('SELECT * FROM teams WHERE id=?', split.newId);
            const addedHasHistory = split && get('SELECT id FROM matches WHERE team_a=? OR team_b=? LIMIT 1', split.newId, split.newId);
            if (original?.size === 1 && added?.size === 1 && !addedHasHistory) {
              const originalName = split.originalName ?? String(split.names?.[0] ?? original.name).replace(/ A$/, '');
              run('UPDATE members SET team_id=? WHERE team_id=?', original.id, added.id);
              run('DELETE FROM teams WHERE id=?', added.id);
              run('UPDATE teams SET name=?,size=2 WHERE id=?', originalName, original.id);
              revertedSplit = true;
            }
          } catch { /* 舊操作紀錄不影響解鎖 */ }
        }
        setSetting('registration_locked', 0);
        run("DELETE FROM sessions WHERE role='team'");
        audit('registration.unlock', { removedRounds: pendingRounds.map(round => round.id), revertedSplit });
        return { ok: true, teamCount: get('SELECT count(*) n FROM teams').n, revertedSplit };
      });
      const teamRoute = /^\/api\/admin\/teams\/(\d+)$/.exec(path);
      if (method === 'PUT' && teamRoute) return transaction(() => {
        if (setting('registration_locked') === '1') fail(409, '請先解鎖報到，再修改組別');
        const id = Number(teamRoute[1]), team = get('SELECT * FROM teams WHERE id=?', id);
        if (!team) fail(404, '組別不存在');
        if (get('SELECT id FROM matches WHERE team_a=? OR team_b=? LIMIT 1', id, id)) fail(409, '此組已有對局紀錄，不能修改');
        const name = text(body.name, '隊伍名稱', 50), ids = roster(body.studentIds);
        if (get('SELECT id FROM teams WHERE name=? AND id!=?', name, id)) fail(409, '隊伍名稱已使用');
        if (ids.some(studentId => get('SELECT team_id FROM members WHERE student_id=? AND team_id!=?', studentId, id))) fail(409, '有學號已加入其他隊伍');
        const before = { name: team.name, studentIds: members(id) };
        run('DELETE FROM sessions WHERE team_id=?', id);
        run('DELETE FROM readiness WHERE team_id=?', id);
        run('DELETE FROM handoffs WHERE team_id=?', id);
        run('DELETE FROM members WHERE team_id=?', id);
        run('UPDATE teams SET name=?,size=? WHERE id=?', name, ids.length, id);
        ids.forEach(studentId => run('INSERT INTO members VALUES(?,?)', studentId, id));
        audit('team.update', { teamId: id, before, after: { name, studentIds: ids } });
        return { ok: true, id, name, size: ids.length, studentIds: ids };
      });
      if (method === 'DELETE' && teamRoute) return transaction(() => {
        if (setting('registration_locked') === '1') fail(409, '請先解鎖報到，再刪除組別');
        const id = Number(teamRoute[1]), team = get('SELECT * FROM teams WHERE id=?', id);
        if (!team) fail(404, '組別不存在');
        if (get('SELECT id FROM matches WHERE team_a=? OR team_b=? LIMIT 1', id, id)) fail(409, '此組已有對局紀錄，不能刪除');
        const studentIds = members(id);
        run('DELETE FROM sessions WHERE team_id=?', id);
        run('DELETE FROM readiness WHERE team_id=?', id);
        run('DELETE FROM handoffs WHERE team_id=?', id);
        run('DELETE FROM members WHERE team_id=?', id);
        run('DELETE FROM teams WHERE id=?', id);
        audit('team.delete', { teamId: id, name: team.name, studentIds });
        return { ok: true, id, name: team.name, teamCount: get('SELECT count(*) n FROM teams').n };
      });
      if (method === 'POST' && path === '/api/admin/images') {
        const mime = text(body.type, '圖片格式', 40);
        const formats = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
        const extension = formats[mime];
        if (!extension || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) fail(400, '只接受 PNG、JPEG、GIF 或 WebP 圖片');
        const image = Buffer.from(body.data, 'base64');
        if (!image.length || image.length > 5 * 1024 * 1024) fail(413, '圖片不可超過 5 MB');
        const valid = mime === 'image/png' ? image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
          : mime === 'image/jpeg' ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
          : mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('ascii'))
          : image.subarray(0, 4).toString('ascii') === 'RIFF' && image.subarray(8, 12).toString('ascii') === 'WEBP';
        if (!valid) fail(400, '圖片內容與格式不符');
        const filename = `${randomBytes(16).toString('hex')}.${extension}`;
        writeFileSync(join(uploadDir, filename), image, { mode: 0o600, flag: 'wx' });
        audit('image.upload', { filename, mime, bytes: image.length });
        return { url: `/uploads/${filename}`, type: mime, size: image.length };
      }
      if (method === 'POST' && path === '/api/admin/questions') {
        const title = text(body.title, '題目名稱', 120), description = text(body.description, '題目內容', 12000), flag = text(body.flag, 'flag', 512);
        const duration = integer(body.duration, 5, 10800, '限時秒數');
        const id = Number(run('INSERT INTO questions(title,description,flag_hash,duration) VALUES(?,?,?,?)', title, description, digest(flag), duration).lastInsertRowid);
        audit('question.create', { id, title }); return { id };
      }
      const reuseQuestion = /^\/api\/admin\/questions\/(\d+)\/reuse$/.exec(path);
      if (method === 'POST' && reuseQuestion) return transaction(() => {
        const source = get('SELECT * FROM questions WHERE id=? AND archived=0', Number(reuseQuestion[1]));
        if (!source) fail(404, '題目不存在');
        if (get("SELECT id FROM rounds WHERE question_id=? AND status!='finished' LIMIT 1", source.id)) fail(409, '題目正在準備或進行中，不能重新使用');
        const roundIds = all("SELECT id FROM rounds WHERE question_id=? AND status='finished'", source.id).map(round => round.id);
        if (!roundIds.length) fail(409, '題目目前已可使用');
        const snapshotId = Number(run('INSERT INTO questions(title,description,flag_hash,duration,archived) VALUES(?,?,?,?,1)', source.title, source.description, source.flag_hash, source.duration).lastInsertRowid);
        run('UPDATE rounds SET question_id=? WHERE question_id=?', snapshotId, source.id);
        audit('question.reuse', { id: source.id, snapshotId, roundIds });
        return { id: source.id, title: source.title, restored: true, roundIds };
      });
      const updateQuestion = /^\/api\/admin\/questions\/(\d+)$/.exec(path);
      if (method === 'PUT' && updateQuestion) return transaction(() => {
        const source = get('SELECT * FROM questions WHERE id=? AND archived=0', Number(updateQuestion[1]));
        if (!source) fail(404, '題目不存在');
        if (get("SELECT id FROM rounds WHERE question_id=? AND status!='finished' LIMIT 1", source.id)) fail(409, '題目正在準備或進行中，不能修改');
        const title = text(body.title, '題目名稱', 120), description = text(body.description, '題目內容', 12000);
        const duration = integer(body.duration, 5, 10800, '限時秒數');
        const flagHash = body.flag === undefined || body.flag === '' ? source.flag_hash : digest(text(body.flag, 'flag', 512));
        if (get('SELECT id FROM rounds WHERE question_id=? LIMIT 1', source.id)) {
          const id = Number(run('INSERT INTO questions(title,description,flag_hash,duration) VALUES(?,?,?,?)', title, description, flagHash, duration).lastInsertRowid);
          run('UPDATE questions SET archived=1 WHERE id=?', source.id);
          audit('question.update', { sourceId: source.id, id, title, mode: 'versioned' });
          return { ok: true, id, mode: 'versioned' };
        }
        const oldImages = [...source.description.matchAll(/\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))/gi)].map(match => match[1]);
        run('UPDATE questions SET title=?,description=?,flag_hash=?,duration=? WHERE id=?', title, description, flagHash, duration, source.id);
        for (const filename of new Set(oldImages)) {
          const url = `/uploads/${filename}`;
          if (!description.includes(url) && !get('SELECT id FROM questions WHERE description LIKE ? LIMIT 1', `%${url}%`)) {
            const imagePath = join(uploadDir, filename); if (existsSync(imagePath)) unlinkSync(imagePath);
          }
        }
        audit('question.update', { id: source.id, title, mode: 'updated' });
        return { ok: true, id: source.id, mode: 'updated' };
      });
      const deleteQuestion = /^\/api\/admin\/questions\/(\d+)$/.exec(path);
      if (method === 'DELETE' && deleteQuestion) return transaction(() => {
        const id = Number(deleteQuestion[1]), question = get('SELECT * FROM questions WHERE id=?', id);
        if (!question) fail(404, '題目不存在');
        if (get("SELECT id FROM rounds WHERE question_id=? AND status!='finished' LIMIT 1", id)) fail(409, '題目正在準備或進行中，不能刪除');
        if (get('SELECT id FROM rounds WHERE question_id=? LIMIT 1', id)) {
          run('UPDATE questions SET archived=1 WHERE id=?', id);
          audit('question.archive', { id, title: question.title });
          return { ok: true, id, mode: 'archived' };
        }
        const images = [...question.description.matchAll(/\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))/gi)].map(match => match[1]);
        run('DELETE FROM questions WHERE id=?', id);
        for (const filename of new Set(images)) {
          const url = `/uploads/${filename}`;
          if (!get('SELECT id FROM questions WHERE description LIKE ? LIMIT 1', `%${url}%`)) {
            const imagePath = join(uploadDir, filename); if (existsSync(imagePath)) unlinkSync(imagePath);
          }
        }
        audit('question.delete', { id, title: question.title, removedImages: images.length });
        return { ok: true, id, mode: 'deleted' };
      });
      const configure = /^\/api\/admin\/rounds\/(\d+)\/configure$/.exec(path);
      if (method === 'POST' && configure) return transaction(() => {
        const id = Number(configure[1]), round = get("SELECT * FROM rounds WHERE id=? AND status='planned'", id);
        if (!round) fail(409, '只能在開放登入前設定題目');
        const question = get('SELECT * FROM questions WHERE id=? AND archived=0', integer(body.questionId, 1, 1000000, '題目'));
        if (!question) fail(404, '題目不存在');
        if (get('SELECT id FROM rounds WHERE question_id=? AND id!=?', question.id, id)) fail(409, '題目已使用');
        const duration = integer(body.duration ?? question.duration, 5, 10800, '限時秒數');
        run('UPDATE rounds SET question_id=?,duration=? WHERE id=?', question.id, duration, id);
        audit('round.configure', { id, questionId: question.id, duration }); return { ok: true };
      });
      const roundAction = /^\/api\/admin\/rounds\/(\d+)\/(prepare|start|finish)$/.exec(path);
      if (method === 'POST' && roundAction) return transaction(() => {
        const id = Number(roundAction[1]), action = roundAction[2], round = get('SELECT * FROM rounds WHERE id=?', id);
        if (!round) fail(404, '對局不存在');
        if (action === 'prepare') {
          if (round.status !== 'planned' || !round.question_id) fail(409, '請先設定本輪題目');
          run('DELETE FROM readiness WHERE round_id=?', id); run("DELETE FROM sessions WHERE role='team'");
          run("UPDATE rounds SET status='preparing' WHERE id=?", id); audit('round.prepare', { id }); return { ok: true };
        }
        if (action === 'start') {
          if (round.status !== 'preparing' || !round.question_id) fail(409, '請先設定本局題目');
          const assigned = all('SELECT team_a,team_b FROM matches WHERE round_id=? ORDER BY arena', id).flatMap(match => [match.team_a, match.team_b]);
          const readyTeams = new Set(all('SELECT team_id FROM readiness WHERE round_id=?', id).map(row => row.team_id));
          const missingTeamIds = assigned.filter(teamId => !readyTeams.has(teamId));
          if (missingTeamIds.length && body.force !== true) fail(409, `尚有 ${missingTeamIds.length} 組未完成學號登入`);
          const start = now(); run("UPDATE rounds SET status='running',started_at=?,deadline=? WHERE id=?", start, start + round.duration * 1000, id);
          audit('round.start', { id, forced: missingTeamIds.length > 0, missingTeamIds });
          return { ok: true, forced: missingTeamIds.length > 0, missingTeamIds };
        }
        if (round.status !== 'running') fail(409, '此局未進行中');
        completeRound(id, 'finish_manual'); return { ok: true };
      });
      if (method === 'GET' && path === '/api/admin/export') {
        const rows = [['場次','題目','組別','對手','結果','實際解題毫秒','計入累計毫秒']];
        for (const team of all('SELECT * FROM teams ORDER BY id')) for (const result of stats(team.id).results) rows.push([result.roundId,result.title,team.name,result.opponent,{ win:'勝',loss:'敗',draw:'平',pending:'進行中' }[result.result],result.elapsedMs ?? '',result.chargedMs ?? '']);
        const csv = '\uFEFF' + rows.map(row => row.map(value => { let s = String(value); if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"','""')}"`; }).join(',')).join('\r\n');
        res.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="arena-results.csv"' }); res.end(csv); return;
      }
      fail(404, '管理功能不存在');
    }
    if (method === 'POST' && path === '/api/team/submit') {
      let current = session(req, 'team', true);
      const handedTeamId = handoffTeam(req);
      if (handedTeamId) {
        const recoverable = get(`SELECT r.id round_id FROM readiness x JOIN rounds r ON r.id=x.round_id
          WHERE x.team_id=? AND r.status='running' ORDER BY r.id LIMIT 1`, handedTeamId);
        if (recoverable) current = { team_id: handedTeamId, round_id: recoverable.round_id };
      }
      if (!current) fail(401, '請先登入');
      throttle(`submit:${current.team_id}`, 30, 60_000);
      const flag = text(body.flag, 'flag', 512);
      return transaction(() => {
        finishExpired();
        const round = get("SELECT * FROM rounds WHERE id=? AND status='running'", current.round_id);
        if (!round || now() >= round.deadline) fail(409, '題目尚未開始或已結束');
        const match = get('SELECT * FROM matches WHERE round_id=? AND (team_a=? OR team_b=?)', round.id, current.team_id, current.team_id);
        const previous = get('SELECT elapsed_ms FROM solves WHERE match_id=? AND team_id=?', match.id, current.team_id);
        if (previous) return { correct:true,duplicate:true,elapsedMs:previous.elapsed_ms,result:match.winner===current.team_id?'win':'loss' };
        const correct = digest(flag) === get('SELECT flag_hash FROM questions WHERE id=?', round.question_id).flag_hash;
        const at = now(); if (at >= round.deadline) fail(409, '題目已結束');
        run('INSERT INTO attempts(round_id,team_id,at,correct) VALUES(?,?,?,?)', round.id, current.team_id, at, correct ? 1 : 0);
        if (!correct) return { correct:false,message:'flag 不正確，再試一次' };
        const elapsed = at - round.started_at;
        run('INSERT INTO solves(match_id,team_id,submitted_at,elapsed_ms) VALUES(?,?,?,?)', match.id, current.team_id, at, elapsed);
        if (!match.winner) run('UPDATE matches SET winner=? WHERE id=? AND winner IS NULL', current.team_id, match.id);
        audit('flag.correct', { roundId:round.id,teamId:current.team_id,elapsedMs:elapsed });
        if (!get(`SELECT m.id FROM matches m WHERE m.round_id=? AND (SELECT count(*) FROM solves s WHERE s.match_id=m.id)<2 LIMIT 1`, round.id)) completeRound(round.id, 'all_solved', at);
        return { correct:true,elapsedMs:elapsed,result:match.winner && match.winner!==current.team_id?'loss':'win' };
      });
    }
    if (method === 'GET' && path === '/api/scoreboard') return { teams: all('SELECT * FROM teams').map(t => teamView(t)).sort((a,b) => b.wins-a.wins || a.totalTimeMs-b.totalTimeMs || b.draws-a.draws),
      active: all("SELECT * FROM rounds WHERE status='running'").map(r => roundView(r)), serverNow: now() };
    fail(404, '找不到此功能');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url,'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body = {};
        if (req.method !== 'GET') {
          const origin = req.headers.origin;
          const allowed = trustedOrigins.size ? trustedOrigins : new Set([`${secureCookie?'https':'http'}://${req.headers.host}`]);
          if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !allowed.has(origin))) fail(403,'不接受跨站操作');
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) fail(415,'請使用 JSON');
          if (url.pathname === '/api/admin/images') session(req, 'admin');
          const bodyLimit = url.pathname === '/api/admin/images' ? 7 * 1024 * 1024 : 65536;
          let raw=''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw)>bodyLimit) fail(413,'請求內容過大'); }
          try { body=raw?JSON.parse(raw):{}; } catch { fail(400,'JSON 格式錯誤'); }
          if (!body || Array.isArray(body) || typeof body !== 'object') fail(400,'JSON 必須為物件');
        }
        finishExpired(); const result = await route(req,res,url,body);
        if (!res.writableEnded) { res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(result)); }
      } else {
        if (req.method !== 'GET') fail(405,'不支援此操作');
        const upload = /^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/.exec(url.pathname);
        if (upload) {
          const extension = upload[1].split('.').pop(), types = { png:'image/png',jpg:'image/jpeg',gif:'image/gif',webp:'image/webp' };
          if (!existsSync(join(uploadDir, upload[1]))) fail(404, '圖片不存在');
          res.writeHead(200, { 'Content-Type':types[extension], 'Cache-Control':'public, max-age=31536000, immutable' });
          res.end(readFileSync(join(uploadDir, upload[1]))); return;
        }
        const files={'/app-v2.js':['app-v2.js','text/javascript'],'/style.css':['style.css','text/css']};
        const entry=files[url.pathname] ?? ((['/','/admin','/play','/register'].includes(url.pathname)||/^\/station\/\d+$/.test(url.pathname))?['index.html','text/html']:null);
        if (!entry) fail(404,'頁面不存在');
        res.writeHead(200,{'Content-Type':`${entry[1]}; charset=utf-8`, 'Cache-Control':files[url.pathname]?'public, max-age=0, must-revalidate':'no-store'});
        res.end(readFileSync(join(ROOT,'public',entry[0])));
      }
    } catch(error) {
      if (!res.headersSent) { res.writeHead(error.status??500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:error.status?error.message:'伺服器發生錯誤，請聯絡管理員'})); }
      else res.end(); if (!error.status) console.error(error);
    }
  });
  const interval=setInterval(()=>{ try { finishExpired(); run('DELETE FROM sessions WHERE expires<=?',now()); run('DELETE FROM handoffs WHERE expires<=?',now()); run('DELETE FROM throttles WHERE until_at<=?',now()); } catch(error){ console.error(error); } },30_000);
  interval.unref();
  return { server,db,close:async()=>{ clearInterval(interval); await new Promise(resolve=>server.close(resolve)); db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app=createApp({dbPath:process.env.DB_PATH||join(ROOT,'data/arena.sqlite')});
  const port=Number(process.env.PORT||3000); app.server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`NCKUCTF 已啟動：http://localhost:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();process.exit(0);});
}
