import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
const PASSWORD = 'Test-admin-password-2026';
async function fixture(t, sizes = [2, 3], opts = {}) {
  let clock = 1900000000000;
  const app = createApp({ dbPath: ':memory:', adminPassword: PASSWORD, now: () => clock, ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  async function req(path, method = 'GET', body, cookie, expected = 200, headers = {}) {
    const r = await fetch(url + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    assert.equal(r.status, expected, `${method} ${path}: ${text}`);
    return { data, cookie: r.headers.get('set-cookie')?.split(';')[0], headers: r.headers };
  }
  const admin = (await req('/api/admin/login', 'POST', { password: PASSWORD })).cookie;
  const a = async (path, method = 'GET', body, code) => (await req(`/api/admin/${path}`, method, body, admin, code)).data;
  const teams = [], cookies = [];
  for (let i = 0; i < sizes.length; i++) {
    const { id } = await a('teams', 'POST', { name: `第 ${i + 1} 組`, size: sizes[i] });
    const team = (await a('state')).teams.find(t => t.id === id);
    const studentIds = Array.from({ length: sizes[i] }, (_, j) => `S${i}${j}`);
    await req(`/api/card/${team.cardToken}/register`, 'POST', { studentIds });
    cookies.push((await req('/api/login', 'POST', { studentIds, pin: team.pin })).cookie);
    teams.push({ ...team, studentIds });
  }
  if (teams.length) {
    const seats = (await a('state')).seats.map((s, i) => ({ ...s, enabled: true, teamId: teams[i]?.id ?? null }));
    await a('seats', 'PUT', { seats });
  }
  const question = async (duration = 30) => (await a('questions', 'POST', { title: `隱藏題目 ${Math.random()}`, description: 'secret challenge text', flag: 'flag{correct}', duration })).id;
  const schedule = async (pairs = [[teams[0].id, teams[1].id]], duration = 30) => (await a('rounds', 'POST', { questionId: await question(duration), pairs, duration })).id;
  const submit = async (index, roundId, flag = 'flag{correct}', code = 200) => (await req('/api/team/submit', 'POST', { roundId, flag }, cookies[index], code)).data;
  return { app, req, a, admin, teams, cookies, question, schedule, submit, url, advance: ms => clock += ms, now: () => clock };
}

test('首次啟動必須提供強度足夠的管理密碼', () => {
  assert.throws(() => createApp({ dbPath: ':memory:', adminPassword: 'short' }), /12/);
});
test('2v3: 先答對得勝，敗方補交並各自記錄毫秒，全部解出自動結束', async t => {
  const f = await fixture(t), id = await f.schedule();
  await f.submit(0, id, 'flag{correct}', 409);
  await f.a(`rounds/${id}/start`, 'POST', {});
  f.advance(1234);
  assert.equal((await f.submit(0, id, 'wrong')).correct, false);
  assert.deepEqual(await f.submit(0, id), { correct: true, elapsedMs: 1234, result: 'win' });
  f.advance(2345);
  const duplicate = await f.submit(0, id);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.elapsedMs, 1234);
  assert.deepEqual(await f.submit(1, id), { correct: true, elapsedMs: 3579, result: 'loss' });
  const state = await f.a('state');
  assert.equal(state.rounds[0].status, 'finished');
  assert.equal(state.teams[0].wins, 1); assert.equal(state.teams[1].losses, 1);
  assert.equal(state.teams[1].totalSolveMs, 3579);
  await f.submit(0, id, 'flag{correct}', 409);
});
test('2v2: 同時提交只能有一勝一敗，時間相同也保留單一勝者', async t => {
  const f = await fixture(t, [2, 2]), id = await f.schedule();
  await f.a(`rounds/${id}/start`, 'POST', {}); f.advance(10);
  const results = await Promise.all([f.submit(0, id), f.submit(1, id)]);
  assert.deepEqual(results.map(r => r.result).sort(), ['loss', 'win']);
  const state = await f.a('state');
  assert.equal(state.teams.reduce((n, t) => n + t.wins, 0), 1);
  assert.equal(state.teams.reduce((n, t) => n + t.losses, 0), 1);
});
test('3v3: 雙方未解出，截止時各記一平，邊界提交被拒絕', async t => {
  const f = await fixture(t, [3, 3]), id = await f.schedule(undefined, 5);
  await f.a(`rounds/${id}/start`, 'POST', {}); f.advance(5000);
  await f.submit(0, id, 'flag{correct}', 409);
  const state = await f.a('state');
  assert.deepEqual(state.teams.map(t => t.draws), [1, 1]);
  assert.deepEqual(state.teams.map(t => t.results[0].elapsedMs), [null, null]);
  await f.a('state'); assert.equal((await f.a('state')).teams[0].draws, 1);
});
test('只有一隊解出，截止後保留一勝一敗，不能誤判平手', async t => {
  const f = await fixture(t), id = await f.schedule(undefined, 5);
  await f.a(`rounds/${id}/start`, 'POST', {}); f.advance(4999); await f.submit(0, id);
  f.advance(1); await f.submit(1, id, 'flag{correct}', 409);
  const s = await f.a('state');
  assert.equal(s.teams[0].wins, 1); assert.equal(s.teams[1].losses, 1);
  assert.equal(s.teams[0].draws + s.teams[1].draws, 0); assert.equal(s.teams[1].results[0].elapsedMs, null);
});
test('多組對戰各自判勝、平手；部分解出不會提前關閉整場', async t => {
  const f = await fixture(t, [2, 3, 2, 3]), id = await f.schedule([[1, 2], [3, 4]], 5);
  await f.a(`rounds/${id}/start`, 'POST', {}); f.advance(100);
  await f.submit(0, id); await f.submit(1, id);
  assert.equal((await f.a('state')).rounds[0].status, 'running');
  f.advance(4900); const s = await f.a('state');
  assert.deepEqual(s.teams.map(t => [t.wins, t.losses, t.draws]), [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1]]);
});
test('依序公布、禁止重疊開賽、禁止重播公開題目', async t => {
  const f = await fixture(t), first = await f.schedule(), second = await f.schedule();
  await f.a(`rounds/${second}/start`, 'POST', {}, 409);
  await f.a(`rounds/${first}/start`, 'POST', {});
  await f.a(`rounds/${second}/start`, 'POST', {}, 409);
  await f.a(`rounds/${first}/finish`, 'POST', {});
  await f.a(`rounds/${first}/start`, 'POST', {}, 409);
  await f.a(`rounds/${second}/start`, 'POST', {});
  const s = await f.a('state');
  await f.a('rounds', 'POST', { questionId: s.questions[0].id, pairs: [[1, 2]] }, 409);
});
test('未公布题目、flag、學號、登入碼與卡片密鑰不出現在公共資料', async t => {
  const f = await fixture(t); await f.schedule();
  const board = await f.req('/api/scoreboard'), player = await f.req('/api/team/state', 'GET', undefined, f.cookies[0]);
  const card = await f.req(`/api/card/${f.teams[0].cardToken}`);
  for (const response of [board.data, player.data, card.data]) {
    const text = JSON.stringify(response);
    assert.ok(!text.includes('secret challenge text')); assert.ok(!text.includes('隱藏題目')); assert.ok(!text.includes('flag{correct}'));
    assert.ok(!text.includes('studentIds')); assert.ok(!text.includes('cardToken'));
  }
  assert.equal(board.data.teams[0].pin, undefined); assert.equal(player.data.team.pin, undefined);
  assert.equal(card.data.team.pin, f.teams[0].pin);
  assert.equal(card.data.team.members, undefined);
});
test('學號唯一、全員學號驗證、人數檢查、註冊不可覆寫', async t => {
  const f = await fixture(t);
  await f.req(`/api/card/${f.teams[0].cardToken}/register`, 'POST', { studentIds: ['XX', 'YY'] }, undefined, 409);
  await f.req('/api/login', 'POST', { studentIds: ['S00', 'FAKE'], pin: f.teams[0].pin }, undefined, 401);
  await f.req('/api/login', 'POST', { studentIds: ['S00', 'S00'], pin: f.teams[0].pin }, undefined, 400);
  await f.req('/api/login', 'POST', { studentIds: [], pin: '123456' }, undefined, 400);
  await f.a('teams/2', 'PATCH', { name: '另一隊', size: 2, studentIds: ['S00', 'AA'] }, 409);
  assert.equal((await f.a('state')).teams[1].size, 3);
  await f.req('/api/login', 'POST', { studentIds: ['s01', 's00'], pin: f.teams[0].pin });
});
test('後台可調成員與人数，舊登入立即失效', async t => {
  const f = await fixture(t);
  await f.a('teams/1', 'PATCH', { name: '新隊名', size: 3, studentIds: ['NEW1', 'NEW2', 'NEW3'] });
  await f.req('/api/team/state', 'GET', undefined, f.cookies[0], 401);
  await f.req('/api/login', 'POST', { studentIds: ['NEW3', 'NEW1', 'NEW2'], pin: f.teams[0].pin });
});
test('換位可原子交換座位，原電腦失效、學號加登入碼可重新登入', async t => {
  const f = await fixture(t);
  const seats = (await f.a('state')).seats.map(s => ({ ...s, enabled: !!s.enabled }));
  [seats[0].teamId, seats[1].teamId] = [seats[1].teamId, seats[0].teamId];
  await f.a('seats', 'PUT', { seats });
  await f.req('/api/team/state', 'GET', undefined, f.cookies[0], 401);
  const login = await f.req('/api/login', 'POST', { studentIds: f.teams[0].studentIds, pin: f.teams[0].pin });
  assert.equal((await f.req('/api/team/state', 'GET', undefined, login.cookie)).data.team.seat, 'A2');
});
test('停用座位不能有人、同隊不能多席，錯誤儲存保留原座位', async t => {
  const f = await fixture(t), original = (await f.a('state')).seats;
  const seats = original.map(s => ({ ...s, enabled: !!s.enabled }));
  seats[0].enabled = false; await f.a('seats', 'PUT', { seats }, 400);
  seats[0].enabled = true; seats[2].teamId = 1; await f.a('seats', 'PUT', { seats }, 400);
  assert.deepEqual((await f.a('state')).seats, original);
});
test('比賽中阻擋換位、改人數、換碼及更改限時', async t => {
  const f = await fixture(t), id = await f.schedule(); await f.a(`rounds/${id}/start`, 'POST', {});
  await f.a('seats', 'PUT', { seats: (await f.a('state')).seats }, 409);
  await f.a('teams/1/rotate', 'POST', {}, 409);
  await f.a('teams/1', 'PATCH', { name: '修改', size: 2, studentIds: ['A1', 'A2'] }, 409);
  await f.a(`rounds/${id}`, 'PATCH', { duration: 10 }, 409);
});
test('隨機碼更新後，手機顯示新碼，舊碼與舊登入失效', async t => {
  const f = await fixture(t); await f.a('teams/1/rotate', 'POST', {});
  const card = (await f.req(`/api/card/${f.teams[0].cardToken}`)).data;
  assert.match(card.team.pin, /^\d{6}$/); assert.notEqual(card.team.pin, f.teams[0].pin);
  await f.req('/api/team/state', 'GET', undefined, f.cookies[0], 401);
  await f.req('/api/login', 'POST', { studentIds: f.teams[0].studentIds, pin: f.teams[0].pin }, undefined, 401);
  await f.req('/api/login', 'POST', { studentIds: f.teams[0].studentIds, pin: card.team.pin });
});
test('自動配對覆蓋就緒隊伍、不重複、奇數輪空且輪空不計平手', async t => {
  const f = await fixture(t, [2, 2, 3, 3, 2]);
  const preview = await f.a('pairings/preview', 'POST', {});
  assert.equal(preview.pairs.length, 3);
  assert.deepEqual(preview.pairs.flat().filter(Boolean).sort(), [1, 2, 3, 4, 5]);
  const bye = preview.pairs.find(p => p[1] === null)[0];
  const id = await f.schedule(preview.pairs, 5); await f.a(`rounds/${id}/start`, 'POST', {});
  await f.submit(bye - 1, id, 'flag{correct}', 403);
  f.advance(5000); const team = (await f.a('state')).teams.find(t => t.id === bye);
  assert.equal(team.draws, 0); assert.equal(team.results[0].result, 'bye');
  const next = await f.a('pairings/preview', 'POST', {});
  assert.notEqual(next.pairs.find(p => p[1] === null)[0], bye);
});
test('自動配對排除未入座與未註冊者，避免前一場對手', async t => {
  const f = await fixture(t, [2, 2, 2, 2]);
  await f.schedule([[1, 2], [3, 4]]);
  const p = (await f.a('pairings/preview', 'POST', {})).pairs;
  assert.ok(p.every(([a, b]) => !([1, 2].includes(a) && [1, 2].includes(b)) && !([3, 4].includes(a) && [3, 4].includes(b))));
  await f.a('teams', 'POST', { name: '未報到', size: 2 });
  assert.equal((await f.a('pairings/preview', 'POST', {})).pairs.flat().filter(Boolean).length, 4);
});
test('手動配對拒絕自己對自己、同隊重複、全輪空與不存在隊伍', async t => {
  const f = await fixture(t), q = await f.question();
  for (const pairs of [[[1, 1]], [[1, 2], [2, 1]], [[1, null]], [[1, 999]]]) {
    await f.a('rounds', 'POST', { questionId: q, pairs }, pairs[0][1] === 999 ? 404 : 400);
  }
});
test('排程可取消重排、開賽前調整限時與下一場對手', async t => {
  const f = await fixture(t), id = await f.schedule();
  const s = await f.a('state'); assert.equal(s.teams[0].next.opponent, f.teams[1].name);
  await f.a(`rounds/${id}`, 'PATCH', { duration: 17 });
  assert.equal((await f.a('state')).rounds[0].duration, 17);
  await f.a(`rounds/${id}`, 'DELETE', {}); assert.equal((await f.a('state')).teams[0].next, null);
  await f.a('rounds', 'POST', { questionId: s.questions[0].id, pairs: [[1, 2]] });
});
test('權限、CSRF、路徑與 JSON 驗證', async t => {
  const f = await fixture(t);
  await f.req('/api/admin/state', 'GET', undefined, undefined, 401);
  await f.req('/api/admin/teams', 'POST', { name: '越權', size: 2 }, f.cookies[0], 401);
  await f.req('/api/team/state', 'GET', undefined, f.admin, 401);
  await f.req('/api/admin/teams', 'POST', { name: '跨站', size: 2 }, f.admin, 403, { Origin: 'https://evil.invalid' });
  await f.req('/api/login', 'POST', {}, undefined, 415, { 'Content-Type': 'text/plain' });
  await f.req('/api/login', 'POST', [], undefined, 400);
  await f.req('/server.js', 'GET', undefined, undefined, 404);
  await f.req('/api/card/unknown', 'GET', undefined, undefined, 404);
  const state = await f.req('/api/admin/state', 'GET', undefined, f.admin);
  assert.match(state.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(state.headers.get('cache-control'), 'no-store');
});
test('登入與提交限流、防止猜碼與爆量提交', async t => {
  const f = await fixture(t), id = await f.schedule(); await f.a(`rounds/${id}/start`, 'POST', {});
  for (let i = 0; i < 30; i++) await f.submit(0, id, 'wrong');
  await f.submit(0, id, 'wrong', 429);
  for (let i = 0; i < 11; i++) await f.req('/api/admin/login', 'POST', { password: 'bad-password' }, undefined, 401);
  await f.req('/api/admin/login', 'POST', { password: 'bad-password' }, undefined, 429);
});
test('旗標大小寫、去除前後空白、記錄不保存明文旗標', async t => {
  const f = await fixture(t), id = await f.schedule(); await f.a(`rounds/${id}/start`, 'POST', {});
  assert.equal((await f.submit(0, id, 'FLAG{correct}')).correct, false);
  assert.equal((await f.submit(0, id, ' flag{correct} \n')).correct, true);
  assert.ok(!JSON.stringify(await f.a('state')).includes('flag{correct}'));
});
test('QR 產生有效 SVG，成績可匯出且防 CSV 公式注入', async t => {
  const f = await fixture(t);
  const qr = await f.req('/api/admin/teams/1/qr', 'GET', undefined, f.admin);
  assert.match(qr.data, /^<svg/); assert.match(qr.headers.get('content-type'), /svg/);
  await f.a('teams/1', 'PATCH', { name: '=1+1', size: 2, studentIds: f.teams[0].studentIds });
  const id = await f.schedule(); await f.a(`rounds/${id}/start`, 'POST', {}); await f.a(`rounds/${id}/finish`, 'POST', {});
  const csv = await f.req('/api/admin/export', 'GET', undefined, f.admin);
  assert.match(csv.data, /"'=1\+1"/); assert.match(csv.data, /平/);
});
test('伺服器重啟保留勝負、場次、session，離線期間逾時能正確結算', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-restart-')), dbPath = join(dir, 'arena.sqlite');
  let clock = 1900000000000;
  let app = createApp({ dbPath, adminPassword: PASSWORD, now: () => clock });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const req = async (path, body, cookie) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(r.status, 200); return { data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = (await req('/api/admin/login', { password: PASSWORD })).cookie;
  app.db.exec(`INSERT INTO teams VALUES(1,'A',2,'a','123456'),(2,'B',2,'b','654321');
    INSERT INTO members VALUES('A1',1),('A2',1),('B1',2),('B2',2);
    UPDATE seats SET team_id=1 WHERE id=1; UPDATE seats SET team_id=2 WHERE id=2;`);
  const q = (await req('/api/admin/questions', { title: '重啟測試', description: 'test', flag: 'flag{x}', duration: 5 }, admin)).data.id;
  const id = (await req('/api/admin/rounds', { questionId: q, pairs: [[1, 2]] }, admin)).data.id;
  await req(`/api/admin/rounds/${id}/start`, {}, admin);
  const teamCookie = (await req('/api/login', { studentIds: ['A1', 'A2'], pin: '123456' })).cookie;
  clock += 1000; await req('/api/team/submit', { roundId: id, flag: 'flag{x}' }, teamCookie);
  await app.close(); clock += 10000;
  app = createApp({ dbPath, now: () => clock }); await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const state = (await req('/api/admin/state', undefined, admin)).data;
    assert.equal(state.rounds[0].status, 'finished'); assert.equal(state.teams[0].wins, 1); assert.equal(state.teams[1].losses, 1);
    assert.equal(state.teams[0].totalSolveMs, 1000);
  } finally { await app.close(); rmSync(dir, { recursive: true }); }
});

test('未排程題目可修正內容與 flag，排程後鎖定', async t => {
  const f = await fixture(t), q = await f.question();
  const changes = { title: '已修正題目', description: 'new content', duration: 15, flag: 'flag{new}' };
  await f.a(`questions/${q}`, 'PATCH', changes);
  const r = await f.a('rounds', 'POST', { questionId: q, pairs: [[1, 2]] });
  await f.a(`questions/${q}`, 'PATCH', changes, 409);
  await f.a(`rounds/${r.id}/start`, 'POST', {});
  assert.equal((await f.submit(0, r.id)).correct, false);
  assert.equal((await f.submit(0, r.id, 'flag{new}')).correct, true);
});
test('錯誤請求格式回傳 400，不能讓座位或成員資料損壞', async t => {
  const f = await fixture(t), seats = (await f.a('state')).seats;
  for (const invalid of [null, {}, { id: [] }, { id: 1, enabled: true, teamId: {} }]) {
    await f.a('seats', 'PUT', { seats: seats.map((s, i) => i === 0 ? invalid : { ...s, enabled: !!s.enabled }) }, 400);
  }
  await f.a('teams', 'POST', { name: ['bad'], size: 2 }, 400);
  await f.a('teams', 'POST', { name: 'bad', size: 4 }, 400);
  await f.a('rounds', 'POST', { pairs: [[1, 2]] }, 400);
  await f.req('/api/team/submit', 'POST', { flag: 'flag{x}' }, f.cookies[0], 400);
  await f.req('/api/login', 'POST', { studentIds: [null, 'S01'], pin: '123456' }, undefined, 400);
});
test('登出與 session 過期後不可使用原憑證', async t => {
  const f = await fixture(t);
  await f.req('/api/logout', 'POST', {}, f.cookies[0]);
  await f.req('/api/team/state', 'GET', undefined, f.cookies[0], 401);
  f.advance(12 * 3600000);
  await f.req('/api/team/state', 'GET', undefined, f.cookies[1], 401);
  await f.req('/api/admin/state', 'GET', undefined, f.admin, 401);
});
test('24 隊共用網路、12 場同步搶答各有唯一勝者，輪詢沒有資料遺漏', async t => {
  const f = await fixture(t, Array.from({ length: 24 }, (_, i) => i % 2 ? 3 : 2));
  const pairs = Array.from({ length: 12 }, (_, i) => [i * 2 + 1, i * 2 + 2]);
  const id = await f.schedule(pairs); await f.a(`rounds/${id}/start`, 'POST', {}); f.advance(987);
  const started = performance.now();
  const responses = await Promise.all(f.teams.map((_, i) => f.submit(i, id)));
  assert.equal(responses.filter(r => r.result === 'win').length, 12);
  assert.equal(responses.filter(r => r.result === 'loss').length, 12);
  const pages = await Promise.all(f.teams.map((t, i) => f.req('/api/team/state', 'GET', undefined, f.cookies[i])));
  assert.ok(pages.every(r => r.data.team.solved === 1 && r.data.team.totalSolveMs === 987));
  assert.equal((await f.a('state')).rounds[0].status, 'finished');
  t.diagnostic(`24 simultaneous submissions + 24 state reads: ${(performance.now() - started).toFixed(1)} ms`);
});
