import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server-v2.js';

const ADMIN_PASSWORD = 'Test-admin-password-2026';
async function fixture(t, random = () => 0.37, appOptions = {}) {
  let clock = 2_000_000_000_000;
  const app = createApp({ dbPath: ':memory:', adminPassword: ADMIN_PASSWORD, now: () => clock, random, ...appOptions });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, cookies = '', status = 200, extraHeaders = {}) {
    const response = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookies ? { Cookie: cookies } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    const setCookies = response.headers.getSetCookie().map(value => value.split(';')[0]);
    return { data, cookies: setCookies.join('; '), response };
  }
  const adminCookie = (await request('/api/admin/login', 'POST', { password: ADMIN_PASSWORD })).cookies;
  const admin = async (path, method = 'GET', body, status = 200) => (await request(`/api/admin/${path}`, method, body, adminCookie, status)).data;
  const register = (station, size = station % 2 ? 1 : 2) => request('/api/register', 'POST', { name: `第 ${station} 組`, station, studentIds: Array.from({ length: size }, (_, i) => `S${String(station).padStart(2, '0')}${i}`) });
  const addQuestion = (title = '測試題', duration = 5, flag = 'flag{ok}') => admin('questions', 'POST', { title, description: `${title}內容`, duration, flag });
  return { app, request, admin, register, addQuestion, adminCookie, advance: ms => { clock += ms; }, now: () => clock };
}

test('Cloudflare Tunnel 與教室內網來源皆可操作，未知來源仍會拒絕', async t => {
  const f = await fixture(t, () => 0.37, { publicUrl: 'https://livectf.yunshiuan.com', allowedOrigins: ['http://10.77.1.1:3000'] });
  await f.request('/api/register', 'POST', { name: 'Tunnel 隊', studentIds: ['CF01'] }, '', 200, { Origin: 'https://livectf.yunshiuan.com' });
  await f.request('/api/register', 'POST', { name: '內網隊', studentIds: ['LAN01'] }, '', 200, { Origin: 'http://10.77.1.1:3000' });
  await f.request('/api/register', 'POST', { name: '惡意來源', studentIds: ['BAD01'] }, '', 403, { Origin: 'https://example.invalid' });
});

test('Host 可上傳驗證過的題目圖片，非圖片內容會被拒絕', async t => {
  const uploadDir = mkdtempSync(join(tmpdir(), 'arena-images-'));
  t.after(() => rmSync(uploadDir, { recursive: true, force: true }));
  const f = await fixture(t, () => 0.37, { uploadDir });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const uploaded = await f.admin('images', 'POST', { type: 'image/png', data: png });
  assert.match(uploaded.url, /^\/uploads\/[a-f0-9]{32}\.png$/);
  const image = await f.request(uploaded.url);
  assert.equal(image.response.headers.get('content-type'), 'image/png');
  const question = await f.admin('questions', 'POST', { title: '含圖題目', description: `![圖](${uploaded.url})`, duration: 30, flag: 'flag{image}' });
  const originalHash = f.app.db.prepare('SELECT flag_hash FROM questions WHERE id=?').get(question.id).flag_hash;
  const replacement = await f.admin('images', 'POST', { type: 'image/png', data: png });
  const updated = await f.admin(`questions/${question.id}`, 'PUT', { title: '已更換圖片題目', description: `![新圖](${replacement.url})`, duration: 45, flag: '' });
  assert.equal(updated.mode, 'updated');
  assert.deepEqual((await f.admin('state')).questions[0], { id: question.id, title: '已更換圖片題目', description: `![新圖](${replacement.url})`, duration: 45 });
  assert.equal(f.app.db.prepare('SELECT flag_hash FROM questions WHERE id=?').get(question.id).flag_hash, originalHash);
  await f.request(uploaded.url, 'GET', undefined, '', 404);
  await f.admin(`questions/${question.id}`, 'DELETE', {});
  assert.equal((await f.admin('state')).questions.length, 0);
  await f.request(replacement.url, 'GET', undefined, '', 404);
  await f.admin('images', 'POST', { type: 'image/png', data: Buffer.from('<script>alert(1)</script>').toString('base64') }, 400);
  await f.request('/api/admin/images', 'POST', { type: 'image/png', data: png }, '', 401);
});

test('未使用題目可刪除，準備中或進行中的題目會保留', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const used = await f.addQuestion('保留題目'), unused = await f.addQuestion('可刪題目');
  const round = (await f.admin('state')).rounds[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: used.id, duration: 5 });
  await f.admin(`questions/${used.id}`, 'DELETE', {}, 409);
  await f.admin(`questions/${unused.id}`, 'DELETE', {});
  assert.deepEqual((await f.admin('state')).questions.map(question => question.id), [used.id]);
});

test('已完成對局的題目可恢復為可使用，不產生可見副本且保留歷史', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const original = await f.addQuestion('歷史題目', 20, 'flag{history}');
  let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: original.id, duration: 20 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  for (const teamId of [match.teamA, match.teamB]) {
    const team = state.teams.find(item => item.id === teamId);
    await f.request('/api/login', 'POST', { studentIds: team.members });
  }
  await f.admin(`rounds/${round.id}/start`, 'POST', {});
  await f.admin(`rounds/${round.id}/finish`, 'POST', {});

  const restored = await f.admin(`questions/${original.id}/reuse`, 'POST', {});
  assert.deepEqual(restored, { id: original.id, title: '歷史題目', restored: true, roundIds: [round.id] });
  state = await f.admin('state');
  assert.deepEqual(state.questions.map(question => question.id), [original.id]);
  assert.notEqual(state.rounds.find(item => item.id === round.id).questionId, original.id);
  assert.equal(state.rounds.find(item => item.id === round.id).title, '歷史題目');
  const snapshot = f.app.db.prepare('SELECT * FROM questions WHERE id=?').get(state.rounds.find(item => item.id === round.id).questionId);
  assert.equal(snapshot.archived, 1); assert.equal(snapshot.title, '歷史題目');
  const next = state.rounds.find(item => item.status === 'planned');
  await f.admin(`rounds/${next.id}/configure`, 'POST', { questionId: original.id, duration: 20 });
  assert.equal((await f.admin('state')).rounds.find(item => item.id === next.id).questionId, original.id);
  await f.admin(`questions/${original.id}/reuse`, 'POST', {}, 409);
});

test('已建立題目可修改，對局使用中會拒絕，完成後修改會保留歷史版本', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const question = await f.addQuestion('修改前題目', 20, 'flag{edit}');
  let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: question.id, duration: 20 });
  const changes = { title: '修改後題目', description: '## 新版內容\n\n![新版圖](/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)', duration: 30, flag: '' };
  await f.admin(`questions/${question.id}`, 'PUT', changes, 409);
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  for (const teamId of [match.teamA, match.teamB]) {
    const team = state.teams.find(item => item.id === teamId);
    await f.request('/api/login', 'POST', { studentIds: team.members });
  }
  await f.admin(`rounds/${round.id}/start`, 'POST', {});
  await f.admin(`rounds/${round.id}/finish`, 'POST', {});
  const updated = await f.admin(`questions/${question.id}`, 'PUT', changes);
  assert.equal(updated.mode, 'versioned'); assert.notEqual(updated.id, question.id);
  state = await f.admin('state');
  assert.deepEqual(state.questions.map(item => item.id), [updated.id]);
  assert.equal(state.questions[0].title, '修改後題目'); assert.equal(state.questions[0].duration, 30);
  assert.equal(state.rounds.find(item => item.id === round.id).title, '修改前題目');
  const next = state.rounds.find(item => item.status === 'planned');
  await f.admin(`rounds/${next.id}/configure`, 'POST', { questionId: updated.id, duration: 30 });
});

test('重設競賽會清除隊伍、局次、成績與隊伍登入，但保留題目及 Host 登入', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const question = await f.addQuestion('下梯次保留題', 30);
  let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: question.id, duration: 30 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  const team = state.teams.find(item => item.id === match.teamA);
  const teamLogin = await f.request('/api/login', 'POST', { studentIds: team.members });
  await f.admin('reset', 'POST', { confirmation: 'reset' }, 400);
  const reset = await f.admin('reset', 'POST', { confirmation: 'RESET' });
  assert.equal(reset.preservedQuestions, 1);
  state = await f.admin('state');
  assert.equal(state.registrationLocked, false); assert.equal(state.teams.length, 0); assert.equal(state.rounds.length, 0); assert.equal(state.questions.length, 1);
  assert.equal(state.audit.length, 1); assert.equal(state.audit[0].action, 'event.reset');
  await f.request('/api/team/state', 'GET', undefined, teamLogin.cookies, 401);
  const fresh = (await f.request('/api/register', 'POST', { name: '下一梯次第一組', studentIds: ['NEXT01'] })).data;
  assert.equal(fresh.id, 1); assert.equal(fresh.station, 1);
});

test('清除練習成績會保留隊伍、題目與裝置識別，並重新產生正式配對', async t => {
  const f = await fixture(t);
  const registrationA = await f.register(1, 1);
  await f.register(2, 1);
  await f.admin('registration/lock', 'POST', {});
  const question = await f.addQuestion('練習題', 30, 'flag{practice}');
  let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: question.id, duration: 30 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  const logins = new Map();
  for (const teamId of [match.teamA, match.teamB]) {
    const team = state.teams.find(item => item.id === teamId);
    logins.set(teamId, await f.request('/api/login', 'POST', { studentIds: team.members }));
  }
  await f.admin(`rounds/${round.id}/start`, 'POST', {});
  await f.admin('results/clear', 'POST', { confirmation: 'CLEAR' }, 409);
  f.advance(1234);
  await f.request('/api/team/submit', 'POST', { flag: 'flag{practice}' }, logins.get(match.teamA).cookies);
  await f.admin(`rounds/${round.id}/finish`, 'POST', {});
  state = await f.admin('state');
  assert.equal(state.completedRounds, 1);
  assert.equal(state.teams.find(team => team.id === match.teamA).wins, 1);

  await f.admin('results/clear', 'POST', { confirmation: 'clear' }, 400);
  const cleared = await f.admin('results/clear', 'POST', { confirmation: 'CLEAR' });
  assert.deepEqual(cleared, { ok: true, teamCount: 2, paired: true, preservedQuestions: 1 });
  state = await f.admin('state');
  assert.equal(state.registrationLocked, true);
  assert.equal(state.completedRounds, 0);
  assert.equal(state.teams.length, 2);
  assert.equal(state.questions.length, 1);
  assert.equal(state.questions[0].id, question.id);
  assert.equal(state.rounds.length, 1);
  assert.equal(state.rounds[0].status, 'planned');
  assert.equal(state.rounds[0].questionId, null);
  assert.deepEqual(state.teams.map(team => ({ wins: team.wins, losses: team.losses, draws: team.draws, solved: team.solved, totalTimeMs: team.totalTimeMs, results: team.results })), [
    { wins: 0, losses: 0, draws: 0, solved: 0, totalTimeMs: 0, results: [] },
    { wins: 0, losses: 0, draws: 0, solved: 0, totalTimeMs: 0, results: [] }
  ]);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM attempts').get().n, 0);
  assert.ok(state.audit.some(entry => entry.action === 'event.results_cleared'));

  const recovered = await f.request('/api/team/state', 'GET', undefined, logins.get(registrationA.data.id).cookies);
  assert.equal(recovered.data.team.id, registrationA.data.id);
  assert.equal(recovered.data.loggedIn, false);
  assert.ok(recovered.data.team.next);
});

test('每組只接受 1 或 2 人；學號、名稱與初始位置不可重複', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 2);
  await f.request('/api/register', 'POST', { name: '空組', station: 3, studentIds: [] }, '', 400);
  await f.request('/api/register', 'POST', { name: '三人組', station: 3, studentIds: ['A1', 'A2', 'A3'] }, '', 400);
  await f.request('/api/register', 'POST', { name: '第 1 組', station: 3, studentIds: ['X1'] }, '', 409);
  await f.request('/api/register', 'POST', { name: '不同名', station: 1, studentIds: ['X1'] }, '', 409);
  await f.request('/api/register', 'POST', { name: '學號重複', station: 3, studentIds: ['S010'] }, '', 409);
  assert.deepEqual((await f.admin('state')).teams.map(x => x.size), [1, 2]);
});

test('自助報到只需隊名與 1～2 個學號，整組建立並自動分配第一個空位', async t => {
  const f = await fixture(t);
  await f.register(1, 1);
  const receipt = (await f.request('/api/register', 'POST', { name: '自主取名隊', studentIds: ['B002', 'B001'] })).data;
  assert.deepEqual({ ...receipt, handoffToken: '[token]' }, { id: 2, name: '自主取名隊', size: 2, station: 2, handoffToken: '[token]' });
  assert.match(receipt.handoffToken, /^[A-Za-z0-9_-]{32}$/);
  const team = (await f.admin('state')).teams.find(item => item.id === receipt.id);
  assert.equal(team.initialStation, 2);
  assert.deepEqual(team.members, ['B001', 'B002']);
  const station = (await f.request('/api/station/2')).data;
  assert.equal(station.registered.name, '自主取名隊');
  assert.equal(station.registered.size, 2);
});

test('同一瀏覽器連續報到多組時，各分頁 handoff 仍保持原隊伍', async t => {
  const f = await fixture(t);
  const first = await f.request('/api/register', 'POST', { name: 'aaa', studentIds: ['AAA1'] });
  const second = await f.request('/api/register', 'POST', { name: 'bbb', studentIds: ['BBB1'] }, first.cookies);
  const cookieIdentity = await f.request('/api/team/state', 'GET', undefined, second.cookies);
  assert.equal(cookieIdentity.data.team.name, 'bbb');
  const tabIdentity = await f.request('/api/team/state', 'GET', undefined, second.cookies, 200, { 'X-Arena-Handoff': first.data.handoffToken });
  assert.equal(tabIdentity.data.team.name, 'aaa');
  const reclaimed = await f.request('/api/identify', 'POST', { studentIds: ['AAA1'] }, second.cookies);
  assert.equal(reclaimed.data.name, 'aaa');
  const reclaimedState = await f.request('/api/team/state', 'GET', undefined, second.cookies, 200, { 'X-Arena-Handoff': reclaimed.data.handoffToken });
  assert.equal(reclaimedState.data.team.name, 'aaa');
});

test('Host 可在報到開放時刪除無對局組別，鎖定後必須先解鎖', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 2);
  let state = await f.admin('state'), removedTeam = state.teams.find(team => team.name === '第 2 組');
  const removed = await f.admin(`teams/${removedTeam.id}`, 'DELETE', {});
  assert.equal(removed.name, '第 2 組'); assert.equal(removed.teamCount, 1);
  await f.request('/api/register', 'POST', { name: '重新報到組', studentIds: removedTeam.members });
  await f.admin('registration/lock', 'POST', {});
  state = await f.admin('state'); removedTeam = state.teams.find(team => team.name === '重新報到組');
  await f.admin(`teams/${removedTeam.id}`, 'DELETE', {}, 409);
  await f.admin('registration/unlock', 'POST', {});
  await f.admin(`teams/${removedTeam.id}`, 'DELETE', {});
  assert.deepEqual((await f.admin('state')).teams.map(team => team.name), ['第 1 組']);
});

test('Host 可修改尚無對局紀錄的隊名、人數與學號，並釋放舊學號', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1);
  let state = await f.admin('state');
  const team = state.teams.find(item => item.name === '第 1 組');
  const updated = await f.admin(`teams/${team.id}`, 'PUT', { name: '藍隊', studentIds: ['BLUE01', 'BLUE02'] });
  assert.deepEqual(updated, { ok: true, id: team.id, name: '藍隊', size: 2, studentIds: ['BLUE01', 'BLUE02'] });
  state = await f.admin('state');
  const changed = state.teams.find(item => item.id === team.id);
  assert.equal(changed.name, '藍隊'); assert.equal(changed.size, 2); assert.deepEqual(changed.members, ['BLUE01', 'BLUE02']);
  await f.request('/api/register', 'POST', { name: '舊學號重新報到', studentIds: ['S010'] });
  await f.request('/api/register', 'POST', { name: '補偶數組', studentIds: ['EVEN04'] });
  await f.admin(`teams/${team.id}`, 'PUT', { name: '第 2 組', studentIds: ['BLUE01'] }, 409);
  await f.admin(`teams/${team.id}`, 'PUT', { name: '藍隊', studentIds: ['S020'] }, 409);
  await f.admin('registration/lock', 'POST', {});
  await f.admin(`teams/${team.id}`, 'PUT', { name: '鎖定中', studentIds: ['LOCK01'] }, 409);
  await f.admin('registration/unlock', 'POST', {});
  await f.admin(`teams/${team.id}`, 'PUT', { name: '解鎖後可修改', studentIds: ['OPEN01'] });
  assert.equal((await f.admin('state')).teams.find(item => item.id === team.id).members[0], 'OPEN01');
});

test('奇數組鎖定時強制拆分最後一個雙人組，轉為偶數組再隨機配對', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.register(3, 2);
  const locked = await f.admin('registration/lock', 'POST', {});
  assert.equal(locked.teamCount, 4); assert.ok(locked.split);
  const state = await f.admin('state');
  assert.equal(state.registrationLocked, true); assert.equal(state.teams.length, 4);
  assert.deepEqual(state.teams.map(x => x.size).sort(), [1, 1, 1, 1]);
  assert.equal(state.rounds[0].matches.length, 2);
  await f.request('/api/register', 'POST', { name: '太晚', station: 5, studentIds: ['LATE'] }, '', 409);
  const unlocked = await f.admin('registration/unlock', 'POST', {});
  assert.equal(unlocked.teamCount, 3); assert.equal(unlocked.revertedSplit, true);
  const open = await f.admin('state');
  assert.equal(open.registrationLocked, false); assert.equal(open.rounds.length, 0);
  assert.deepEqual(open.teams.map(x => x.size).sort(), [1, 1, 2]);
  assert.ok(open.teams.some(x => x.name === '第 3 組' && x.members.length === 2));
  await f.request('/api/register', 'POST', { name: '新增單人組', studentIds: ['NEW4'] });
  assert.equal((await f.admin('registration/lock', 'POST', {})).teamCount, 4);
});

test('奇數組且最後一組不是雙人時拒絕鎖定，避免產生輪空', async t => {
  const f = await fixture(t);
  await f.register(1, 2); await f.register(2, 2); await f.register(3, 1);
  await f.admin('registration/lock', 'POST', {}, 409);
  assert.equal((await f.admin('state')).registrationLocked, false);
});

test('30 組隨機配對成 15 場地，每組只有一個對戰位置', async t => {
  const f = await fixture(t, () => 0.61);
  for (let station = 1; station <= 30; station++) await f.register(station, station % 3 ? 2 : 1);
  await f.admin('registration/lock', 'POST', {});
  const round = (await f.admin('state')).rounds[0];
  assert.equal(round.matches.length, 15);
  const teamIds = round.matches.flatMap(m => [m.teamA, m.teamB]);
  assert.equal(new Set(teamIds).size, 30);
  assert.deepEqual(round.matches.map(m => m.arena), Array.from({ length: 15 }, (_, i) => i + 1));
  for (const match of round.matches) {
    assert.deepEqual(match.stationA, { arena: match.arena, groupPosition: 1 });
    assert.deepEqual(match.stationB, { arena: match.arena, groupPosition: 2 });
  }
  await f.request('/api/register', 'POST', { name: '第 31 組', station: 30, studentIds: ['X31'] }, '', 409);
});

test('舊場地網址只保留單一隊伍介面別名，不再區分奇偶電腦', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const first = (await f.request('/api/station/1')).data, second = (await f.request('/api/station/2')).data;
  assert.equal(first.mode, 'team'); assert.equal(second.mode, 'team');
  assert.equal(first.groupPosition, 1); assert.equal(second.groupPosition, 2);
  assert.deepEqual([first.assignment.groupPosition, second.assignment.groupPosition].sort(), [1, 2]);
  assert.notEqual(first.assignment.team, second.assignment.team);
  await f.request('/api/station/31', 'GET', undefined, '', 400);
});

test('Host 開放準備前只能看場地，開放後全組以學號登入，全部準備前不能開賽', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 4; i++) await f.register(i, i % 2 ? 1 : 2);
  await f.admin('registration/lock', 'POST', {}); const q = await f.addQuestion();
  let state = await f.admin('state'), round = state.rounds[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: q.id, duration: 5 });
  await f.admin(`rounds/${round.id}/start`, 'POST', {}, 409);
  const firstMatch = round.matches[0];
  const firstTeam = state.teams.find(x => x.id === firstMatch.teamA);
  await f.request('/api/login', 'POST', { studentIds: firstTeam.members }, '', 409);
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  state = await f.admin('state'); round = state.rounds[0];
  assert.equal(round.missingReady.length, 4);
  assert.deepEqual(new Set(round.missingReady.map(team => team.id)), new Set(state.teams.map(team => team.id)));
  await f.request('/api/login', 'POST', { studentIds: firstTeam.members.slice(0, 1) }, '', firstTeam.size === 1 ? 200 : 401);
  state = await f.admin('state'); round = state.rounds[0];
  assert.equal(round.missingReady.length, firstTeam.size === 1 ? 3 : 4);
  if (firstTeam.size === 1) assert.ok(!round.missingReady.some(team => team.id === firstTeam.id));
  for (const match of round.matches) for (const teamId of [match.teamA, match.teamB]) {
    const team = state.teams.find(x => x.id === teamId);
    await f.request('/api/login', 'POST', { studentIds: team.members });
  }
  const fullyReady = (await f.admin('state')).rounds[0];
  assert.equal(fullyReady.ready, 4); assert.deepEqual(fullyReady.missingReady, []);
  await f.admin(`rounds/${round.id}/start`, 'POST', {});
  assert.equal((await f.admin('state')).rounds[0].status, 'running');
  await f.admin('registration/unlock', 'POST', {}, 409);
});

test('Host 可在缺組時確認後強制開始，遲到隊伍能用剩餘時間補登入', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const question = await f.addQuestion('遲到測試題', 20);
  let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: question.id, duration: 20 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  const readyTeam = state.teams.find(team => team.id === match.teamA);
  const lateTeam = state.teams.find(team => team.id === match.teamB);
  await f.request('/api/login', 'POST', { studentIds: readyTeam.members });
  await f.admin(`rounds/${round.id}/start`, 'POST', {}, 409);
  const started = await f.admin(`rounds/${round.id}/start`, 'POST', { force: true });
  assert.equal(started.forced, true); assert.deepEqual(started.missingTeamIds, [lateTeam.id]);
  assert.equal((await f.admin('state')).rounds[0].status, 'running');

  f.advance(1_000);
  const lateLogin = await f.request('/api/login', 'POST', { studentIds: lateTeam.members });
  assert.equal(lateLogin.data.late, true);
  const playable = await f.request('/api/team/state', 'GET', undefined, lateLogin.cookies);
  assert.equal(playable.data.loggedIn, true); assert.equal(playable.data.active.id, round.id);
  const solved = await f.request('/api/team/submit', 'POST', { flag: 'flag{ok}' }, lateLogin.cookies);
  assert.equal(solved.data.correct, true); assert.equal(solved.data.elapsedMs, 1_000);

  state = await f.admin('state');
  assert.ok(state.audit.some(entry => entry.action === 'team.late_ready'));
  const startAudit = state.audit.find(entry => entry.action === 'round.start');
  assert.deepEqual(JSON.parse(startAudit.detail), { id: round.id, forced: true, missingTeamIds: [lateTeam.id] });
});

test('同一瀏覽器的 Host 與隊伍登入互不覆蓋，已準備隊伍可恢復本輪 session', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const question = await f.addQuestion('Cookie 隔離題', 20);
  let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: question.id, duration: 20 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  const teamA = state.teams.find(item => item.id === match.teamA), teamB = state.teams.find(item => item.id === match.teamB);
  const loginA = await f.request('/api/login', 'POST', { studentIds: teamA.members });
  const loginB = await f.request('/api/login', 'POST', { studentIds: teamB.members });
  assert.match(loginA.cookies, /arena_team_session=/); assert.doesNotMatch(loginA.cookies, /arena_admin_session=/);

  const handoff = loginA.cookies.split('; ').find(value => value.startsWith('arena_handoff='));
  const adminLogin = await f.request('/api/admin/login', 'POST', { password: ADMIN_PASSWORD }, handoff);
  assert.match(adminLogin.cookies, /arena_admin_session=/);
  const sharedBrowser = `${handoff}; ${adminLogin.cookies}`;
  const recovered = await f.request('/api/team/state', 'GET', undefined, sharedBrowser);
  assert.equal(recovered.data.loggedIn, true); assert.match(recovered.cookies, /arena_team_session=/);
  await f.request('/api/admin/state', 'GET', undefined, sharedBrowser);

  await f.admin(`rounds/${round.id}/start`, 'POST', {});
  const playable = `${sharedBrowser}; ${recovered.cookies}`;
  const submission = await f.request('/api/team/submit', 'POST', { flag: 'flag{ok}' }, playable);
  assert.equal(submission.data.correct, true);
  await f.request('/api/team/state', 'GET', undefined, loginB.cookies);
  const runningRecovery = await f.request('/api/login', 'POST', { studentIds: teamB.members });
  assert.match(runningRecovery.cookies, /arena_team_session=/);
});

test('30 組完整開賽：每場首解唯一，未完成者加上完整題目時間', async t => {
  const f = await fixture(t, () => 0.42);
  for (let i = 1; i <= 30; i++) await f.register(i, i % 2 ? 1 : 2);
  await f.admin('registration/lock', 'POST', {}); const question = await f.addQuestion('30 組壓力題', 5);
  let state = await f.admin('state'), round = state.rounds[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: question.id, duration: 5 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  const clients = new Map();
  for (const match of round.matches) for (const teamId of [match.teamA, match.teamB]) {
    const team = state.teams.find(x => x.id === teamId);
    const login = await f.request('/api/login', 'POST', { studentIds: team.members });
    clients.set(teamId, login.cookies);
  }
  await f.admin(`rounds/${round.id}/start`, 'POST', {}); f.advance(1234);
  const winners = round.matches.map(match => match.teamA);
  const responses = await Promise.all(winners.map(id => f.request('/api/team/submit', 'POST', { flag: 'flag{ok}' }, clients.get(id))));
  assert.ok(responses.every(response => response.data.result === 'win'));
  f.advance(3766); state = await f.admin('state');
  const finished = state.rounds.find(x => x.id === round.id);
  const next = state.rounds.find(x => x.status === 'planned');
  assert.equal(finished.status, 'finished'); assert.ok(next);
  const previousPairs = new Set(round.matches.map(match => [match.teamA, match.teamB].sort((a, b) => a - b).join(':')));
  assert.ok(next.matches.every(match => !previousPairs.has([match.teamA, match.teamB].sort((a, b) => a - b).join(':'))));
  for (const match of round.matches) {
    const winner = state.teams.find(x => x.id === match.teamA), loser = state.teams.find(x => x.id === match.teamB);
    assert.equal(winner.wins, 1); assert.equal(winner.totalTimeMs, 1234);
    assert.equal(loser.losses, 1); assert.equal(loser.totalTimeMs, 5000);
    assert.equal(loser.results[0].completed, false); assert.equal(loser.results[0].chargedMs, 5000);
  }
});

test('局末強制登出但保留唯讀下一場位置，下一局必須再次輸入學號', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const q1 = await f.addQuestion('第一題', 5), q2 = await f.addQuestion('第二題', 5, 'flag{two}');
  let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: q1.id, duration: 5 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  const cookies = new Map();
  for (const id of [match.teamA, match.teamB]) {
    const team = state.teams.find(x => x.id === id);
    cookies.set(id, (await f.request('/api/login', 'POST', { studentIds: team.members })).cookies);
  }
  await f.admin(`rounds/${round.id}/start`, 'POST', {}); f.advance(1000);
  await f.request('/api/team/submit', 'POST', { flag: 'flag{ok}' }, cookies.get(match.teamA));
  await f.admin(`rounds/${round.id}/finish`, 'POST', {});
  const handoff = (await f.request('/api/team/state', 'GET', undefined, cookies.get(match.teamA))).data;
  assert.equal(handoff.loggedIn, false); assert.ok(handoff.team.next);
  await f.request('/api/team/submit', 'POST', { flag: 'flag{ok}' }, cookies.get(match.teamA), 401);
  const next = (await f.admin('state')).rounds.find(x => x.status === 'planned');
  await f.admin(`rounds/${next.id}/configure`, 'POST', { questionId: q2.id, duration: 5 });
  await f.admin(`rounds/${next.id}/start`, 'POST', {}, 409);
  await f.admin(`rounds/${next.id}/prepare`, 'POST', {});
  const team = state.teams.find(x => x.id === match.teamA);
  await f.request('/api/login', 'POST', { studentIds: team.members });
  assert.equal((await f.admin('state')).rounds.find(x => x.id === next.id).ready, 1);
});

test('雙方都完成時保留各自實際時間，所有場地完成會自動結束並登出', async t => {
  const f = await fixture(t);
  await f.register(1, 2); await f.register(2, 2); await f.admin('registration/lock', 'POST', {});
  const q = await f.addQuestion('補交題', 20); let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: q.id, duration: 20 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  const loginA = await f.request('/api/login', 'POST', { studentIds: state.teams.find(x => x.id === match.teamA).members });
  const loginB = await f.request('/api/login', 'POST', { studentIds: state.teams.find(x => x.id === match.teamB).members });
  await f.admin(`rounds/${round.id}/start`, 'POST', {}); f.advance(1000);
  await f.request('/api/team/submit', 'POST', { flag: 'flag{ok}' }, loginA.cookies); f.advance(2000);
  const second = await f.request('/api/team/submit', 'POST', { flag: 'flag{ok}' }, loginB.cookies);
  assert.equal(second.data.result, 'loss');
  state = await f.admin('state'); assert.equal(state.rounds.find(x => x.id === round.id).status, 'finished');
  assert.equal(state.teams.find(x => x.id === match.teamA).totalTimeMs, 1000);
  assert.equal(state.teams.find(x => x.id === match.teamB).totalTimeMs, 3000);
  await f.request('/api/team/submit', 'POST', { flag: 'flag{ok}' }, loginA.cookies, 401);
});

test('Host 設定總輪數後，最後一輪結束不再產生新配對', async t => {
  const f = await fixture(t);
  await f.admin('settings', 'POST', { totalRounds: 1 });
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {});
  const question = await f.addQuestion('決賽題', 10);
  let state = await f.admin('state'), round = state.rounds[0], match = round.matches[0];
  await f.admin(`rounds/${round.id}/configure`, 'POST', { questionId: question.id, duration: 10 });
  await f.admin(`rounds/${round.id}/prepare`, 'POST', {});
  for (const teamId of [match.teamA, match.teamB]) {
    const team = state.teams.find(item => item.id === teamId);
    await f.request('/api/login', 'POST', { studentIds: team.members });
  }
  await f.admin(`rounds/${round.id}/start`, 'POST', {});
  await f.admin(`rounds/${round.id}/finish`, 'POST', {});
  state = await f.admin('state');
  assert.equal(state.totalRounds, 1); assert.equal(state.completedRounds, 1);
  assert.equal(state.rounds.length, 1); assert.equal(state.rounds[0].status, 'finished');
  const event = (await f.request('/api/event')).data;
  assert.equal(event.roundStatus, null); assert.equal(event.completedRounds, 1);
  await f.admin('settings', 'POST', { totalRounds: 2 }, 409);
});

test('學生流程不需要登入碼，公共資料不包含 flag、學號或管理密碼', async t => {
  const f = await fixture(t);
  await f.register(1, 1); await f.register(2, 1); await f.admin('registration/lock', 'POST', {}); await f.addQuestion('隱藏題', 5, 'flag{secret}');
  for (const endpoint of ['/api/event', '/api/scoreboard', '/api/station/1', '/api/station/2']) {
    const raw = JSON.stringify((await f.request(endpoint)).data);
    assert.ok(!raw.includes('flag{secret}')); assert.ok(!raw.includes('S010')); assert.ok(!raw.includes(ADMIN_PASSWORD)); assert.ok(!raw.includes('pin'));
  }
  const state = await f.admin('state'), match = state.rounds[0].matches[0];
  await f.admin(`rounds/${state.rounds[0].id}/configure`, 'POST', { questionId: state.questions[0].id, duration: 5 });
  await f.admin(`rounds/${state.rounds[0].id}/prepare`, 'POST', {});
  await f.request('/api/login', 'POST', { studentIds: ['S010'], pin: '123456' }, '', 200);
});
