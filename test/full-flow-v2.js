import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server-v2.js';

const sourcePath = resolve(process.env.DB_PATH || 'data/arena.sqlite');
const testRoot = mkdtempSync(join(tmpdir(), 'arena-full-flow-'));
const dbPath = join(testRoot, 'arena.sqlite');
const source = new DatabaseSync(sourcePath, { readOnly: true });
source.prepare('VACUUM INTO ?').run(dbPath);
source.close();

let clock = 2_200_000_000_000;
const app = createApp({ dbPath, uploadDir: join(testRoot, 'uploads'), adminPassword: process.env.ADMIN_PASSWORD, now: () => clock, random: () => 0.47 });
await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
const base = `http://127.0.0.1:${app.server.address().port}`;
const checks = [];
const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };

async function request(path, { method = 'GET', body, cookie = '', status = 200, json = true } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${raw}`);
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return { data: json ? (raw ? JSON.parse(raw) : null) : raw, cookies, response };
}

let report;
try {
  const login = await request('/api/admin/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } });
  const adminCookie = login.cookies;
  const admin = async (path, method = 'GET', body, status = 200) => (await request(`/api/admin/${path}`, { method, body, cookie: adminCookie, status })).data;

  let state = await admin('state');
  const sourceTeams = state.teams.length, sourceMembers = state.teams.reduce((sum, team) => sum + team.size, 0);
  await admin('reset', 'POST', { confirmation: 'RESET' });
  for (let station = 1; station <= 30; station++) {
    const size = station <= 19 ? 2 : 1;
    await request('/api/register', { method: 'POST', body: { name: `完整測試第 ${station} 組`, studentIds: Array.from({ length: size }, (_, index) => `FULL${String(station).padStart(2, '0')}${index}`) } });
  }
  state = await admin('state');
  assert.equal(state.teams.length, 30); assert.equal(state.teams.reduce((sum, team) => sum + team.size, 0), 49);
  pass('隔離副本建立 30 組與 49 位成員，不修改正式資料');

  await admin('settings', 'POST', { totalRounds: 2 });
  const locked = await admin('registration/lock', 'POST', {});
  assert.equal(locked.teamCount, 30);
  state = await admin('state');
  let round = state.rounds.find(item => item.status === 'planned');
  assert.equal(round.matches.length, 15);
  assert.equal(new Set(round.matches.flatMap(match => [match.teamA, match.teamB])).size, 30);
  pass('重新鎖定後產生 15 個場地，30 組各出現一次');

  const q1 = await admin('questions', 'POST', { title: '完整流程測試第一題', description: '排名與計分測試', duration: 20, flag: 'flag{full-flow}' });
  const q2 = await admin('questions', 'POST', { title: '完整流程測試第二題', description: '重新登入測試', duration: 20, flag: 'flag{round-two}' });
  await admin(`rounds/${round.id}/configure`, 'POST', { questionId: q1.id, duration: 20 });
  state = await admin('state'); round = state.rounds.find(item => item.id === round.id);
  assert.equal(round.status, 'planned'); assert.equal(round.ready, 0);
  await request('/api/login', { method: 'POST', body: { studentIds: state.teams[0].members }, status: 409 });
  await admin(`rounds/${round.id}/prepare`, 'POST', {});
  state = await admin('state'); round = state.rounds.find(item => item.id === round.id);
  assert.equal(round.status, 'preparing');
  pass('Host 設定題目後仍顯示場地，按下準備才開放登入');

  const cookies = new Map();
  const assignments = round.matches.flatMap(match => [match.teamA, match.teamB]);
  for (const teamId of assignments.slice(0, -1)) {
    const team = state.teams.find(item => item.id === teamId);
    const loggedIn = await request('/api/login', { method: 'POST', body: { studentIds: team.members } });
    cookies.set(teamId, loggedIn.cookies);
  }
  await admin(`rounds/${round.id}/start`, 'POST', {}, 409);
  assert.equal((await admin('state')).rounds.find(item => item.id === round.id).ready, 29);
  pass('29 組準備時拒絕開始');

  const lastTeamId = assignments.at(-1), lastTeam = state.teams.find(item => item.id === lastTeamId);
  const lastLogin = await request('/api/login', { method: 'POST', body: { studentIds: lastTeam.members } });
  cookies.set(lastTeamId, lastLogin.cookies);
  assert.equal((await admin('state')).rounds.find(item => item.id === round.id).ready, 30);
  await admin(`rounds/${round.id}/start`, 'POST', {});
  const startedAt = clock;
  pass('30 組全部重新輸入學號後 Host 成功開始');

  clock = startedAt + 500;
  const wrong = await Promise.all(assignments.map(teamId => request('/api/team/submit', { method: 'POST', body: { flag: 'flag{wrong}' }, cookie: cookies.get(teamId) })));
  assert.ok(wrong.every(item => item.data.correct === false));
  assert.equal((await admin('state')).rounds.find(item => item.id === round.id).status, 'running');
  pass('30 組錯誤 Flag 全部被拒絕且不會提前結束');

  clock = startedAt + 1000;
  for (const match of round.matches.slice(0, 5)) await request('/api/team/submit', { method: 'POST', body: { flag: 'flag{full-flow}' }, cookie: cookies.get(match.teamA) });
  clock = startedAt + 2500;
  for (const match of round.matches.slice(0, 5)) {
    const submitted = await request('/api/team/submit', { method: 'POST', body: { flag: 'flag{full-flow}' }, cookie: cookies.get(match.teamB) });
    assert.equal(submitted.data.result, 'loss');
  }
  clock = startedAt + 3000;
  for (const match of round.matches.slice(5, 10)) await request('/api/team/submit', { method: 'POST', body: { flag: 'flag{full-flow}' }, cookie: cookies.get(match.teamB) });
  clock = startedAt + 4000;
  for (const match of round.matches.slice(13, 15)) await request('/api/team/submit', { method: 'POST', body: { flag: 'flag{full-flow}' }, cookie: cookies.get(match.teamA) });
  clock = startedAt + 4500;
  for (const match of round.matches.slice(13, 15)) await request('/api/team/submit', { method: 'POST', body: { flag: 'flag{full-flow}' }, cookie: cookies.get(match.teamB) });
  pass('首解、後送與不同解題時間均成功記錄');

  clock = startedAt + 20_000;
  state = await admin('state');
  const finished = state.rounds.find(item => item.id === round.id);
  assert.equal(finished.status, 'finished');
  const teams = new Map(state.teams.map(team => [team.id, team]));
  for (const match of round.matches.slice(0, 5)) {
    assert.deepEqual([teams.get(match.teamA).wins, teams.get(match.teamA).totalTimeMs], [1, 1000]);
    assert.deepEqual([teams.get(match.teamB).losses, teams.get(match.teamB).totalTimeMs], [1, 2500]);
  }
  for (const match of round.matches.slice(5, 10)) {
    assert.deepEqual([teams.get(match.teamB).wins, teams.get(match.teamB).totalTimeMs], [1, 3000]);
    assert.deepEqual([teams.get(match.teamA).losses, teams.get(match.teamA).totalTimeMs], [1, 20_000]);
  }
  for (const match of round.matches.slice(10, 13)) for (const teamId of [match.teamA, match.teamB]) {
    assert.deepEqual([teams.get(teamId).draws, teams.get(teamId).totalTimeMs], [1, 20_000]);
  }
  for (const match of round.matches.slice(13, 15)) {
    assert.deepEqual([teams.get(match.teamA).wins, teams.get(match.teamA).totalTimeMs], [1, 4000]);
    assert.deepEqual([teams.get(match.teamB).losses, teams.get(match.teamB).totalTimeMs], [1, 4500]);
  }
  assert.deepEqual({
    wins: state.teams.reduce((sum, team) => sum + team.wins, 0),
    losses: state.teams.reduce((sum, team) => sum + team.losses, 0),
    draws: state.teams.reduce((sum, team) => sum + team.draws, 0),
    solved: state.teams.reduce((sum, team) => sum + team.solved, 0)
  }, { wins: 12, losses: 12, draws: 6, solved: 19 });
  pass('逾時正確結算 12 勝、12 敗、6 平與 19 次完成');

  const scoreboard = (await request('/api/scoreboard')).data;
  assert.equal(scoreboard.teams.length, 30);
  for (let index = 1; index < scoreboard.teams.length; index++) {
    const before = scoreboard.teams[index - 1], after = scoreboard.teams[index];
    assert.ok(before.wins > after.wins || before.wins === after.wins && (before.totalTimeMs < after.totalTimeMs || before.totalTimeMs === after.totalTimeMs && before.draws >= after.draws));
  }
  assert.deepEqual(scoreboard.teams.slice(0, 12).map(team => team.totalTimeMs), [1000,1000,1000,1000,1000,3000,3000,3000,3000,3000,4000,4000]);
  assert.ok(scoreboard.teams.every(team => team.next?.arena && team.next?.groupPosition));
  pass('排名依勝場、累計時間、平手數排序並顯示下一場地');

  const handoff = (await request('/api/team/state', { cookie: cookies.get(round.matches[0].teamA) })).data;
  assert.equal(handoff.loggedIn, false); assert.ok(handoff.team.next);
  await request('/api/team/submit', { method: 'POST', body: { flag: 'flag{full-flow}' }, cookie: cookies.get(round.matches[0].teamA), status: 401 });
  pass('第一局結束後全部強制登出，舊登入不能再送 Flag');

  const next = state.rounds.find(item => item.status === 'planned');
  const priorPairs = new Set(round.matches.map(match => [match.teamA, match.teamB].sort((a, b) => a - b).join(':')));
  assert.ok(next.matches.every(match => !priorPairs.has([match.teamA, match.teamB].sort((a, b) => a - b).join(':'))));
  await admin(`rounds/${next.id}/configure`, 'POST', { questionId: q2.id, duration: 20 });
  await admin(`rounds/${next.id}/start`, 'POST', {}, 409);
  await admin(`rounds/${next.id}/prepare`, 'POST', {});
  const nextMatch = next.matches[0], nextTeam = state.teams.find(item => item.id === nextMatch.teamA);
  await request('/api/login', { method: 'POST', body: { studentIds: nextTeam.members } });
  await admin(`rounds/${next.id}/start`, 'POST', {}, 409);
  assert.equal((await admin('state')).rounds.find(item => item.id === next.id).ready, 1);
  pass('下一局避開上一局對手，且所有隊伍必須重新登入');

  const exported = await request('/api/admin/export', { cookie: adminCookie, json: false });
  assert.equal(exported.data.trim().split(/\r?\n/).length, 31);
  assert.match(exported.response.headers.get('content-type'), /text\/csv/);
  pass('CSV 匯出包含標題與 30 組結果');

  report = {
    source: sourcePath,
    sourceTeams,
    sourceMembers,
    isolated: true,
    teams: 30,
    members: 49,
    arenas: 15,
    roundOne: { wins: 12, losses: 12, draws: 6, solved: 19, wrongFlagsRejected: 30 },
    rankingTop12TimesMs: scoreboard.teams.slice(0, 12).map(team => team.totalTimeMs),
    checks,
    passed: checks.length
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/full-flow-v2-report.json', JSON.stringify(report, null, 2));
  console.log(`Full flow complete: ${checks.length} checks passed on an isolated copy.`);
} finally {
  await app.close();
  rmSync(testRoot, { recursive: true, force: true });
}
