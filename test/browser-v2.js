import { chromium, expect, request } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createApp } from '../server-v2.js';

let clock = 2_100_000_000_000;
const uploadDir = 'test-results/browser-uploads';
rmSync(uploadDir, { recursive: true, force: true });
const app = createApp({ dbPath: ':memory:', adminPassword: 'Browser-test-password', now: () => clock, random: () => 0.53, uploadDir });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${app.server.address().port}`;
const checks = [], errors = [], clients = [];
mkdirSync('test-results', { recursive: true });
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const stationContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const context of [adminContext, stationContext]) context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const adminPage = await adminContext.newPage(), stationPage = await stationContext.newPage();
  const adminState = async () => (await adminContext.request.get(baseURL + '/api/admin/state')).json();

  await check('Host 登入並建立含 Markdown 與圖片的題目', async () => {
    await adminPage.goto(baseURL + '/admin');
    await adminPage.getByLabel('管理員密碼').fill('Browser-test-password'); await adminPage.getByRole('button', { name: '登入' }).click();
    await expect(adminPage.getByRole('heading', { name: '競賽控制中心' })).toBeVisible();
    await adminPage.getByRole('button', { name: '題目庫' }).click();
    await adminPage.getByLabel('加入圖片').setInputFiles({ name: 'packet.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    await expect(adminPage.locator('#image-upload-status')).toContainText('已上傳 1 張圖片');
    const imageMarkdown = await adminPage.getByLabel('題目內容（支援 Markdown）').inputValue();
    await adminPage.getByLabel('題目名稱').fill('第一局封包題');
    await adminPage.getByLabel('題目內容（支援 Markdown）').fill(`## 任務說明\n\n**請分析封包**\n\n${imageMarkdown}\n\n<script>window.__unsafe=true</script>`);
    await expect(adminPage.locator('#question-preview h2')).toHaveText('任務說明');
    await expect(adminPage.locator('#question-preview img')).toBeVisible();
    await expect(adminPage.locator('#question-preview script')).toHaveCount(0);
    await adminPage.getByLabel('正確 flag').fill('flag{one}'); await adminPage.getByLabel('限時（秒）').fill('5');
    await adminPage.getByRole('button', { name: '儲存題目' }).click(); await expect(adminPage.getByRole('heading', { name: '第一局封包題' })).toBeVisible();
    await adminPage.getByLabel('題目名稱').fill('第二局密碼題'); await adminPage.getByLabel('題目內容（支援 Markdown）').fill('### 第二局\n\n- 找出密碼');
    await adminPage.getByLabel('正確 flag').fill('flag{two}'); await adminPage.getByLabel('限時（秒）').fill('5');
    await adminPage.getByRole('button', { name: '儲存題目' }).click(); await expect(adminPage.getByRole('heading', { name: '第二局密碼題' })).toBeVisible();
    await adminPage.getByLabel('題目名稱').fill('暫存刪除題'); await adminPage.getByLabel('題目內容（支援 Markdown）').fill('這題應該被刪除');
    await adminPage.getByLabel('正確 flag').fill('flag{delete}'); await adminPage.getByLabel('限時（秒）').fill('5');
    await adminPage.getByRole('button', { name: '儲存題目' }).click();
    const temporary = adminPage.locator('article.round').filter({ has: adminPage.getByRole('heading', { name: '暫存刪除題' }) });
    await expect(temporary).toBeVisible(); adminPage.once('dialog', dialog => dialog.accept());
    await temporary.getByRole('button', { name: '刪除' }).click();
    await expect(adminPage.getByRole('heading', { name: '暫存刪除題' })).toHaveCount(0);
  });

  await check('自助報到將兩個學號編為同組並保留單一隊伍介面', async () => {
    await stationPage.goto(baseURL + '/register'); await expect(stationPage.getByRole('heading', { name: '隊伍報到' })).toBeVisible();
    await stationPage.getByText('1 人', { exact: true }).click();
    await stationPage.waitForTimeout(1500);
    await expect(stationPage.getByRole('radio', { name: '1 人' })).toBeChecked();
    await expect(stationPage.locator('#public-register-students input')).toHaveCount(1);
    await stationPage.getByText('2 人', { exact: true }).click();
    await stationPage.getByLabel('隊伍名稱').fill('第 1 組');
    await stationPage.getByLabel('成員 1 學號').fill('S010'); await stationPage.getByLabel('成員 2 學號').fill('S011');
    await stationPage.getByRole('button', { name: '完成報到' }).click();
    await expect(stationPage.getByRole('heading', { name: '報到完成' })).toBeVisible();
    await expect(stationPage.getByText('2 人組', { exact: true })).toBeVisible();
    await expect(stationPage.getByRole('link', { name: '隊伍報到', exact: true })).toHaveCount(0);
    await expect(stationPage.getByRole('button', { name: '報到另一組' })).toHaveCount(0);
    await stationPage.getByRole('link', { name: '開啟隊伍介面' }).click();
    await expect(stationPage).toHaveURL(baseURL + '/play');
    await expect(stationPage.getByText('已完成報到', { exact: true })).toBeVisible();
  });

  await check('補齊 30 組、同時涵蓋單人組與雙人組', async () => {
    const sameBrowserRegistration = await stationContext.request.post(baseURL + '/api/register', { data: { name: '第 2 組', station: 2, studentIds: ['S020', 'S021'] } });
    expect(sameBrowserRegistration.ok()).toBeTruthy();
    await expect(stationPage.getByRole('heading', { name: '第 1 組', level: 1 })).toBeVisible({ timeout: 5000 });
    await stationPage.evaluate(() => sessionStorage.removeItem('arena_team_handoff')); await stationPage.reload();
    await expect(stationPage.getByRole('heading', { name: '確認隊伍身分' })).toBeVisible();
    await stationPage.getByLabel('成員 1 學號').fill('S010'); await stationPage.getByLabel('成員 2 學號').fill('S011');
    await stationPage.getByRole('button', { name: '恢復 第 1 組' }).click();
    await expect(stationPage.getByRole('heading', { name: '第 1 組', level: 1 })).toBeVisible();
    for (let station = 3; station <= 30; station++) {
      const size = station % 3 === 0 ? 1 : 2;
      const response = await adminContext.request.post(baseURL + '/api/register', { data: { name: `第 ${station} 組`, station, studentIds: Array.from({ length: size }, (_, i) => `S${String(station).padStart(2, '0')}${i}`) } });
      expect(response.ok()).toBeTruthy();
    }
    await adminPage.getByRole('button', { name: '報到名單' }).click();
    await expect(adminPage.locator('table tbody tr')).toHaveCount(30);
  });

  await check('Host 可刪除錯誤組別並釋放學號重新報到', async () => {
    const row = adminPage.locator('table tbody tr').filter({ hasText: '第 30 組' });
    adminPage.once('dialog', dialog => dialog.accept()); await row.getByRole('button', { name: '刪除組別' }).click();
    await expect(adminPage.locator('table tbody tr')).toHaveCount(29);
    const restored = await adminContext.request.post(baseURL + '/api/register', { data: { name: '第 30 組', station: 30, studentIds: ['S300'] } });
    expect(restored.ok()).toBeTruthy();
    await expect(adminPage.locator('table tbody tr')).toHaveCount(30);
  });

  await check('Host 可修改隊名、人數與學號', async () => {
    const row = adminPage.locator('table tbody tr').filter({ hasText: '第 29 組' });
    await row.getByRole('button', { name: '修改' }).click();
    const editor = adminPage.locator('#team-editor');
    await expect(editor).toBeVisible();
    await editor.getByLabel('隊伍名稱').fill('第 29 組已修改');
    await editor.getByText('1 人', { exact: true }).click();
    await expect(editor.locator('input[name^="student"]')).toHaveCount(1);
    await editor.getByLabel('成員 1 學號').fill('EDIT290');
    await editor.getByRole('button', { name: '儲存組別修改' }).click();
    const changed = adminPage.locator('table tbody tr').filter({ hasText: '第 29 組已修改' });
    await expect(changed).toContainText('EDIT290');
    await expect(changed).toContainText('1');
  });

  await check('設定輪數並將偶數 30 組隨機配成 15 個場地', async () => {
    await adminPage.getByRole('button', { name: '對局管理' }).click();
    await adminPage.getByLabel('總輪數').fill('2'); await adminPage.getByRole('button', { name: '儲存輪數' }).click();
    await expect(adminPage.locator('#toast')).toContainText('競賽輪數已儲存');
    await adminPage.getByRole('button', { name: '鎖定報到並隨機配對' }).click();
    await expect(adminPage.locator('.match')).toHaveCount(15);
    const state = await adminState(), round = state.rounds[0];
    expect(state.totalRounds).toBe(2);
    expect(new Set(round.matches.flatMap(match => [match.teamA, match.teamB])).size).toBe(30);
    for (const match of round.matches) {
      expect(match.stationA.groupPosition).toBe(1);
      expect(match.stationB.groupPosition).toBe(2);
    }
    await expect(adminPage.locator('#admin-content')).not.toContainText('操作電腦');
    await expect(adminPage.locator('#admin-content')).not.toContainText('顯示電腦');
    await expect(stationPage.getByText('本輪請前往')).toBeVisible({ timeout: 5000 });
    await adminPage.screenshot({ path: 'test-results/v2-admin-pairing.png', fullPage: true });
  });

  let state = await adminState(), round = state.rounds[0], activeTeamId;
  await check('Host 設定題目後仍顯示場地，按下開始準備才切換學號登入', async () => {
    const questionChoice = adminPage.locator(`input[name="questionId"][value="${state.questions[0].id}"]`);
    await expect(questionChoice).not.toBeChecked();
    await adminPage.getByRole('button', { name: '儲存本輪題目' }).click();
    await expect(adminPage.locator('#toast')).toContainText('請先選擇本局題目');
    expect(await adminPage.evaluate(() => ({ x: scrollX, fits: document.documentElement.scrollWidth <= innerWidth }))).toEqual({ x: 0, fits: true });
    await adminPage.getByText(state.questions[0].title, { exact: true }).click();
    await adminPage.waitForTimeout(2500);
    await expect(questionChoice).toBeChecked();
    await adminPage.getByLabel('限時（秒）').fill('5');
    await adminPage.getByRole('button', { name: '儲存本輪題目' }).click();
    state = await adminState(); round = state.rounds[0];
    expect(round.status).toBe('planned');
    await expect(stationPage.getByText('本輪請前往')).toBeVisible();
    await adminPage.getByRole('button', { name: '開始對局準備' }).click();
    await expect(adminPage.locator('.missing-ready')).toContainText('還有 30 組');
    await expect(adminPage.locator('.missing-ready .badge')).toHaveCount(30);
    await expect(adminPage.getByRole('button', { name: '仍要開始（缺 30 組）' })).toBeVisible();
    await expect(stationPage.getByRole('heading', { name: '對局準備' })).toBeVisible({ timeout: 5000 });
    state = await adminState(); round = state.rounds[0];
    const actualTeam = state.teams.find(team => team.name === '第 1 組'); activeTeamId = actualTeam.id;
    const sizeChoice = stationPage.getByRole('radio', { name: `${actualTeam.size} 人` });
    await stationPage.getByText(`${actualTeam.size} 人`, { exact: true }).click();
    await stationPage.waitForTimeout(2000);
    await expect(sizeChoice).toBeChecked();
    await expect(stationPage.locator('#login-students input')).toHaveCount(actualTeam.size);
    for (let i = 0; i < actualTeam.members.length; i++) await stationPage.getByLabel(`成員 ${i + 1} 學號`).fill(actualTeam.members[i]);
    await stationPage.getByRole('button', { name: '完成驗證並準備' }).click(); await expect(stationPage.getByText('已完成學號驗證')).toBeVisible();
    await expect(adminPage.locator('.missing-ready')).toContainText('還有 29 組', { timeout: 5000 });
    for (const match of round.matches) for (const teamId of [match.teamA, match.teamB]) {
      if (teamId === actualTeam.id) continue;
      const team = state.teams.find(item => item.id === teamId), client = await request.newContext({ baseURL }); clients.push(client);
      const response = await client.post('/api/login', { data: { studentIds: team.members } }); expect(response.ok()).toBeTruthy();
      client.teamId = teamId;
    }
    await expect.poll(async () => (await adminState()).rounds[0].ready).toBe(30);
    await expect(adminPage.locator('.missing-ready')).toContainText('全部組別皆已完成', { timeout: 5000 });
    await expect(adminPage.locator('.missing-ready')).toContainText('全數完成');
    await expect(adminPage.getByRole('button', { name: '開始本輪', exact: true })).toBeVisible();
  });

  await check('Host 開始後顯示題目，15 個場地各自產生唯一首解', async () => {
    await adminPage.getByRole('button', { name: '開始本輪' }).click(); await expect(stationPage.getByRole('heading', { name: '第一局封包題' })).toBeVisible();
    const liveScoreboard = await adminContext.newPage(); await liveScoreboard.goto(baseURL + '/');
    await expect(liveScoreboard.getByText('第 1 局進行中', { exact: true })).toBeVisible();
    await liveScoreboard.screenshot({ path: 'test-results/v2-cyberpunk-scoreboard-live.png', fullPage: true }); await liveScoreboard.close();
    await expect(stationPage.locator('.challenge .markdown h2')).toHaveText('任務說明');
    await expect(stationPage.locator('.challenge .markdown img')).toBeVisible();
    await expect(stationPage.locator('.challenge .markdown script')).toHaveCount(0);
    clock += 1234;
    await stationPage.getByLabel('提交 flag').fill('flag{one}'); await stationPage.getByRole('button', { name: '提交' }).click();
    await expect(stationPage.locator('#toast')).toContainText('取得勝場');
    const actualMatch = round.matches.find(match => [match.teamA, match.teamB].includes(activeTeamId));
    for (const match of round.matches.filter(item => item.id !== actualMatch.id)) {
      const client = clients.find(item => item.teamId === match.teamA);
      const response = await client.post('/api/team/submit', { data: { flag: 'flag{one}' } }); expect(response.ok()).toBeTruthy();
    }
    expect([actualMatch.teamA, actualMatch.teamB]).toContain(activeTeamId);
  });

  await check('逾時後未完成者加完整 5 秒、全員強制登出並顯示下一場位置', async () => {
    clock += 3766; await adminContext.request.get(baseURL + '/api/admin/state');
    await expect(stationPage.getByText('上一輪已結束並登出')).toBeVisible({ timeout: 5000 });
    await expect(stationPage.getByText('本輪請前往')).toBeVisible();
    const updated = await adminState(), finished = updated.rounds.find(item => item.id === round.id);
    expect(finished.status).toBe('finished'); expect(updated.rounds.some(item => item.status === 'planned')).toBeTruthy();
    for (const match of round.matches) {
      const winnerId = [match.teamA, match.teamB].includes(activeTeamId) ? activeTeamId : match.teamA;
      const loserId = match.teamA === winnerId ? match.teamB : match.teamA;
      expect(updated.teams.find(team => team.id === winnerId).totalTimeMs).toBe(1234);
      expect(updated.teams.find(team => team.id === loserId).totalTimeMs).toBe(5000);
    }
    await stationPage.screenshot({ path: 'test-results/v2-next-location.png', fullPage: true });
  });

  await check('下一輪先顯示新場地，Host 開放後才要求重新輸入學號', async () => {
    const updated = await adminState(), next = updated.rounds.find(item => item.status === 'planned');
    const config = await adminContext.request.post(baseURL + `/api/admin/rounds/${next.id}/configure`, { data: { questionId: updated.questions[1].id, duration: 5 } }); expect(config.ok()).toBeTruthy();
    const start = await adminContext.request.post(baseURL + `/api/admin/rounds/${next.id}/start`, { data: {} }); expect(start.status()).toBe(409);
    await expect(stationPage.getByText('本輪請前往')).toBeVisible();
    const prepare = await adminContext.request.post(baseURL + `/api/admin/rounds/${next.id}/prepare`, { data: {} }); expect(prepare.ok()).toBeTruthy();
    await expect(stationPage.getByRole('heading', { name: '對局準備' })).toBeVisible({ timeout: 5000 });
    await expect(stationPage.locator('#login-students input')).toHaveCount(2);
    await stationPage.screenshot({ path: 'test-results/v2-next-login.png', fullPage: true });
  });

  await check('桌面與手機版無橫向溢出或 JavaScript 錯誤', async () => {
    const desktop = await adminContext.newPage(); await desktop.goto(baseURL + '/');
    await expect(desktop.getByRole('heading', { name: '即時戰況' })).toBeVisible();
    expect(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await desktop.screenshot({ path: 'test-results/v2-cyberpunk-scoreboard.png', fullPage: true }); await desktop.close();
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await mobile.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(baseURL + '/');
    await expect(page.getByRole('heading', { name: '即時戰況' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: 'test-results/v2-mobile-scoreboard.png', fullPage: true }); await mobile.close();
    expect(errors).toEqual([]);
  });

  await check('30 個隊伍介面同時請求皆能完成載入', async () => {
    const responses = await Promise.all(Array.from({ length: 30 }, () => adminContext.request.get(baseURL + '/play')));
    expect(responses.every(response => response.ok())).toBeTruthy();
  });

  await check('上方導覽反覆切換不被內容遮住且不會停在載入中', async () => {
    const navigationContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await navigationContext.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL + '/');
    const routes = [['隊伍報到', '/register'], ['隊伍介面', '/play'], ['Host 後台', '/admin'], ['即時戰況', '/']];
    for (let cycle = 0; cycle < 5; cycle++) for (const [label, route] of routes) {
      await page.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(baseURL + route);
      await expect(page.locator('#app')).not.toContainText('正在連線至競賽場地', { timeout: 5000 });
    }
    await navigationContext.close();
    expect(errors).toEqual([]);
  });

  await check('Host 可在非進行中狀態解鎖報到', async () => {
    await adminPage.goto(baseURL + '/admin');
    await adminPage.getByRole('button', { name: '解鎖報到' }).click();
    await expect(adminPage.getByRole('button', { name: '鎖定報到並隨機配對' })).toBeVisible();
    expect((await adminState()).registrationLocked).toBeFalsy();
  });

  await check('Host 可修改既有題目並加入新圖片', async () => {
    await adminPage.getByRole('button', { name: '題目庫' }).click();
    const card = adminPage.locator('article.round').filter({ has: adminPage.getByRole('heading', { name: '第二局密碼題', exact: true }) });
    await card.getByRole('button', { name: '修改' }).click();
    await expect(adminPage.getByRole('heading', { name: '修改題目' })).toBeVisible();
    await expect(adminPage.getByLabel('題目名稱')).toHaveValue('第二局密碼題');
    await expect(adminPage.getByLabel('題目內容（支援 Markdown）')).toContainText('第二局');
    await adminPage.getByLabel('題目名稱').fill('第二局密碼題（已修改）');
    await adminPage.getByLabel('加入或更換圖片').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    await expect(adminPage.locator('#image-upload-status')).toContainText('已上傳 1 張圖片');
    await expect(adminPage.locator('#question-preview img')).toBeVisible();
    await adminPage.getByRole('button', { name: '儲存修改' }).click();
    const updated = adminPage.locator('article.round').filter({ has: adminPage.getByRole('heading', { name: '第二局密碼題（已修改）', exact: true }) });
    await expect(updated).toBeVisible(); await expect(updated.locator('.markdown img')).toBeVisible();
  });

  await check('已使用題目恢復可用時不增加副本，刪除後仍保留歷史局次', async () => {
    await adminPage.getByRole('button', { name: '題目庫' }).click();
    let original = adminPage.locator('article.round').filter({ has: adminPage.getByRole('heading', { name: '第一局封包題', exact: true }) });
    await expect(original.getByText('已使用', { exact: true })).toBeVisible();
    await original.getByRole('button', { name: '重新使用' }).click();
    await expect(adminPage.locator('#toast')).toContainText('恢復為可使用');
    await expect(adminPage.getByRole('heading', { name: '第一局封包題', exact: true })).toHaveCount(1);
    original = adminPage.locator('article.round').filter({ has: adminPage.getByRole('heading', { name: '第一局封包題', exact: true }) });
    await expect(original.getByText('可使用', { exact: true })).toBeVisible();
    await expect(original.getByRole('button', { name: '重新使用' })).toHaveCount(0);
    adminPage.once('dialog', dialog => dialog.accept());
    await original.getByRole('button', { name: '刪除' }).click();
    await expect(adminPage.getByRole('heading', { name: '第一局封包題', exact: true })).toHaveCount(0);
    const after = await adminState();
    expect(after.questions.map(question => question.title)).toEqual(['第二局密碼題（已修改）']);
    expect(after.rounds.some(item => item.status === 'finished' && item.title === '第一局封包題')).toBeTruthy();
  });

  await check('Host 清除練習成績後保留隊伍、題目與裝置識別', async () => {
    await adminPage.getByRole('button', { name: '對局管理' }).click();
    adminPage.once('dialog', dialog => dialog.accept('CLEAR'));
    await adminPage.getByRole('button', { name: '清除練習成績' }).click();
    await expect(adminPage.locator('#toast')).toContainText('練習成績已清除');
    const cleared = await adminState();
    expect(cleared.registrationLocked).toBeFalsy();
    expect(cleared.teams).toHaveLength(30);
    expect(cleared.questions).toHaveLength(1);
    expect(cleared.rounds).toHaveLength(0);
    expect(cleared.completedRounds).toBe(0);
    expect(cleared.teams.every(team => team.wins === 0 && team.losses === 0 && team.draws === 0 && team.solved === 0 && team.totalTimeMs === 0 && team.results.length === 0)).toBeTruthy();
    await expect(stationPage.getByRole('heading', { name: '第 1 組', level: 1 })).toBeVisible({ timeout: 5000 });
    await expect(stationPage.getByText('已完成報到', { exact: true })).toBeVisible();
  });

  await check('Host 不停機重設競賽並保留題目庫', async () => {
    adminPage.once('dialog', dialog => dialog.accept('RESET'));
    await adminPage.getByRole('button', { name: '重設競賽' }).click();
    await expect(adminPage.locator('#toast')).toContainText('競賽已重設');
    const reset = await adminState();
    expect(reset.registrationLocked).toBeFalsy(); expect(reset.teams).toHaveLength(0); expect(reset.rounds).toHaveLength(0); expect(reset.questions).toHaveLength(1);
    await expect(adminPage.getByRole('button', { name: '鎖定報到並隨機配對' })).toBeDisabled();
  });

  writeFileSync('test-results/browser-v2-report.json', JSON.stringify({ passed: checks.length, checks, errors, teams: 30, arenas: 15, concurrentInterfaces: 30, navigationSwitches: 20 }, null, 2));
  console.log(`Browser v2 flow complete: ${checks.length} checks passed with 30 teams.`);
} catch (error) {
  writeFileSync('test-results/browser-v2-report.json', JSON.stringify({ passed: checks.length, checks, errors, failure: String(error) }, null, 2));
  throw error;
} finally {
  await Promise.allSettled(clients.map(client => client.dispose())); await browser?.close(); await app.close(); rmSync(uploadDir, { recursive: true, force: true });
}
