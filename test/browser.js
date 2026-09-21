import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.js';
import { mkdirSync, writeFileSync } from 'node:fs';
const password = 'Browser-test-password';
const app = createApp({ dbPath: ':memory:', adminPassword: password });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const errors = [], checks = [];
let browser;
mkdirSync('test-results', { recursive: true });
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
try {
  browser = await chromium.launch({ headless: true });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const teamContextA = await browser.newContext(), teamContextB = await browser.newContext();
  for (const c of [adminContext, mobileContext, teamContextA, teamContextB]) c.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  const admin = await adminContext.newPage(), mobile = await mobileContext.newPage(), a = await teamContextA.newPage(), b = await teamContextB.newPage();
  const state = async () => (await adminContext.request.get(base + '/api/admin/state')).json();
  await check('管理員登入與初始空資料頁面', async () => {
    await admin.goto(base + '/admin'); await admin.getByLabel('管理員密碼').fill(password); await admin.getByRole('button', { name: '進入控制中心' }).click();
    await expect(admin.getByRole('heading', { name: '競賽控制中心' })).toBeVisible();
  });
  await check('使用後台建立 2 人、3 人隊伍', async () => {
    await admin.getByRole('tab', { name: '隊伍與戰鬥卡' }).click();
    for (const [name, size] of [['紫電小隊', '2'], ['綠光小隊', '3']]) {
      await admin.getByLabel('組別名稱', { exact: true }).fill(name);
      await admin.getByLabel('隊伍人數').selectOption(size); await admin.getByRole('button', { name: '建立隊伍' }).click();
      await expect(admin.getByRole('heading', { name })).toBeVisible();
    }
  });
  let s = await state();
  await check('QR 卡片開啟、手機首次報到與 6 位登入碼', async () => {
    await admin.getByRole('button', { name: 'QR 戰鬥卡' }).first().click();
    await expect(admin.getByAltText('紫電小隊 專屬 QR Code')).toBeVisible();
    await expect.poll(() => admin.getByAltText('紫電小隊 專屬 QR Code').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await admin.getByRole('button', { name: '關閉', exact: true }).click();
    for (const [i, team] of s.teams.entries()) {
      await mobile.goto(base + '/card/' + team.cardToken);
      for (let j = 0; j < team.size; j++) await mobile.getByLabel(`成員 ${j + 1} 學號`).fill(`E${i}${j}`);
      await mobile.getByRole('button', { name: '完成隊伍註冊' }).click();
      await expect(mobile.getByText('已報到', { exact: true })).toBeVisible();
      await expect(mobile.locator('.pin-block strong')).toHaveText(/^\d{6}$/);
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
  });
  await check('指定座位、停用空位、儲存後顯示組別', async () => {
    await admin.getByRole('tab', { name: '場地座位' }).click();
    await admin.locator('.seat').filter({ hasText: 'A1' }).click(); await admin.getByLabel('安排組別').selectOption('1');
    await admin.locator('.seat').filter({ hasText: 'A2' }).click(); await admin.getByLabel('安排組別').selectOption('2');
    await admin.locator('.seat').filter({ hasText: 'D6' }).click(); await admin.getByLabel('開放此座位').uncheck();
    await admin.getByRole('button', { name: '儲存座位表' }).click();
    await expect(admin.locator('.seat').filter({ hasText: 'A1' })).toContainText('紫電小隊');
    await expect(admin.locator('.seat').filter({ hasText: 'D6' })).toContainText('停用');
    await expect(admin.locator('#toast')).not.toHaveClass(/visible/, { timeout: 6000 });
    await admin.screenshot({ path: 'test-results/admin-seats.png', fullPage: true });
  });
  await check('手機後台座位保持原本六欄，可橫向查看且頁面不溢出', async () => {
    await admin.setViewportSize({ width: 390, height: 844 });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    const firstRow = await admin.locator('.seat').evaluateAll(seats => seats.slice(0, 6).map(s => s.getBoundingClientRect().top));
    expect(new Set(firstRow).size).toBe(1);
    await admin.locator('.seat-map-scroll').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await admin.locator('.seat').filter({ hasText: 'D6' }).scrollIntoViewIfNeeded();
    await expect(admin.locator('.seat').filter({ hasText: 'D6' })).toBeInViewport();
    await admin.screenshot({ path: 'test-results/mobile-seats.png', fullPage: true });
    await admin.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('建立兩道題目與可調整限時', async () => {
    await admin.getByRole('tab', { name: '題目庫' }).click();
    for (const [title, flag] of [['01 / 解開封包訊息', 'flag{packet}'], ['02 / 古典密碼', 'flag{cipher}']]) {
      await admin.getByLabel('題目名稱').fill(title);
      await admin.getByLabel('題目內容 / 題目資源網址').fill('請還原訊息，找出 flag。\n測試資源：https://example.org/challenge\n<script>window.injected=true</script>');
      await admin.getByLabel('正確 flag（區分大小寫）').fill(flag);
      await admin.getByLabel('預設限時（秒）').fill('180');
      await admin.getByRole('button', { name: '儲存題目' }).click();
      await expect(admin.getByRole('heading', { name: title })).toBeVisible();
    }
    expect(await admin.evaluate(() => window.injected)).toBeUndefined();
  });
  await check('自動配對、手動指定並排程，戰鬥卡顯示下一場對手', async () => {
    await admin.getByRole('tab', { name: '對戰管理' }).click();
    await admin.getByLabel('選擇未公布題目').selectOption('1');
    await admin.getByRole('button', { name: '自動配對' }).click();
    await expect(admin.getByLabel('對戰 1 左方')).toBeVisible();
    await admin.getByLabel('對戰 1 左方').selectOption('1'); await admin.getByLabel('對戰 1 右方').selectOption('2');
    await admin.getByRole('button', { name: '加入場次排程' }).click();
    await expect(admin.locator('#round-list')).toContainText('01 / 解開封包訊息');
    await admin.getByLabel('選擇未公布題目').selectOption('2'); await admin.getByRole('button', { name: '手動配對' }).click();
    await admin.getByLabel('對戰 1 左方').selectOption('1'); await admin.getByLabel('對戰 1 右方').selectOption('2');
    await admin.getByRole('button', { name: '加入場次排程' }).click();
    await expect(admin.locator('#round-list .round')).toHaveCount(2);
    await mobile.goto(base + '/card/' + s.teams[0].cardToken);
    await expect(mobile.getByRole('heading', { name: '綠光小隊' })).toBeVisible();
    await mobile.screenshot({ path: 'test-results/mobile-card.png', fullPage: true });
    await expect(admin.locator('#toast')).not.toHaveClass(/visible/, { timeout: 6000 });
    await admin.screenshot({ path: 'test-results/admin-rounds.png', fullPage: true });
  });
  await check('全員學號與登入碼登入、等待題目不洩漏內容', async () => {
    for (const [i, page] of [a, b].entries()) {
      await page.goto(base + '/play'); await page.getByLabel('隊伍人數').selectOption(String(s.teams[i].size));
      for (let j = 0; j < s.teams[i].size; j++) await page.getByLabel(`成員 ${j + 1} 學號`).fill(`E${i}${j}`);
      await page.getByLabel('6 位組別登入碼').fill(s.teams[i].pin); await page.getByRole('button', { name: '登入組別' }).click();
      await expect(page.getByText('等待下一題公布')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('請還原訊息');
    }
  });
  await check('逐題開始、倒數、錯誤 flag 提示、首解勝、敗方補交與時間', async () => {
    await admin.getByRole('button', { name: '公布並開始' }).first().click();
    await expect(a.getByRole('heading', { name: '01 / 解開封包訊息' })).toBeVisible();
    await expect(b.getByRole('heading', { name: '01 / 解開封包訊息' })).toBeVisible();
    expect(await a.evaluate(() => window.injected)).toBeUndefined();
    await a.getByLabel('提交 flag').fill('bad'); await a.getByRole('button', { name: '提交 FLAG' }).click();
    await expect(a.locator('#toast')).toContainText('flag 不正確');
    await b.getByLabel('提交 flag').fill('flag{ci');
    await a.getByLabel('提交 flag').fill('flag{packet}'); await a.getByRole('button', { name: '提交 FLAG' }).click();
    await expect(a.getByText('搶下首解，取得一勝！')).toBeVisible();
    await expect(b.getByText('對手已先解出', { exact: false })).toBeVisible();
    await expect(b.getByLabel('提交 flag')).toHaveValue('flag{ci');
    await expect(b.getByLabel('提交 flag')).toBeFocused();
    await b.getByLabel('提交 flag').fill('flag{packet}'); await b.getByRole('button', { name: '提交 FLAG' }).click();
    await expect(b.locator('table tbody tr')).toContainText('敗');
    await expect(a.locator('table tbody tr')).toContainText('勝');
    await expect(a.locator('table tbody tr')).toContainText(/\d+\.\d{3} 秒/);
  });
  await check('下一題可開賽、管理員提前結束的確認流程', async () => {
    await expect(admin.getByRole('button', { name: '公布並開始' })).toBeEnabled();
    await admin.getByRole('button', { name: '公布並開始' }).click();
    await expect(a.getByRole('heading', { name: '02 / 古典密碼' })).toBeVisible();
    await admin.getByRole('button', { name: '提前結束', exact: true }).click();
    await expect(admin.getByRole('dialog')).toContainText('各記一平');
    await admin.getByRole('button', { name: '確認提前結束' }).click();
    await expect(a.locator('table tbody tr')).toHaveCount(2);
    await expect(a.locator('table tbody tr').last()).toContainText('平');
  });
  await check('編輯未公布題目，真實五秒逾時後雙方自動記平', async () => {
    await admin.getByRole('tab', { name: '題目庫' }).click();
    await admin.getByLabel('題目名稱').fill('03 / 逾時測試');
    await admin.getByLabel('題目內容 / 題目資源網址').fill('不提交，等候時間到。');
    await admin.getByLabel('正確 flag（區分大小寫）').fill('flag{timeout}');
    await admin.getByLabel('預設限時（秒）').fill('5');
    await admin.getByRole('button', { name: '儲存題目' }).click();
    await admin.getByRole('button', { name: '編輯題目' }).click();
    await admin.getByRole('dialog').getByLabel('題目名稱').fill('03 / 五秒挑戰');
    await admin.getByRole('button', { name: '儲存題目變更' }).click();
    await expect(admin.getByRole('heading', { name: '03 / 五秒挑戰' })).toBeVisible();
    await admin.getByRole('tab', { name: '對戰管理' }).click();
    await admin.getByLabel('選擇未公布題目').selectOption('3');
    await admin.getByRole('button', { name: '自動配對' }).click();
    await admin.getByRole('button', { name: '加入場次排程' }).click();
    await expect(admin.getByRole('button', { name: '公布並開始' })).toBeEnabled();
    await admin.getByRole('button', { name: '公布並開始' }).click();
    await expect(a.getByRole('heading', { name: '03 / 五秒挑戰' })).toBeVisible();
    await expect(a.getByText('等待下一題公布')).toBeVisible({ timeout: 12000 });
    await expect(a.locator('table tbody tr').last()).toContainText('平');
    await expect(b.locator('table tbody tr').last()).toContainText('平');
  });
  await check('換座位讓原電腦登出，再用相同學號與卡片碼登入', async () => {
    await admin.getByRole('tab', { name: '場地座位' }).click();
    await admin.locator('.seat').filter({ hasText: 'B1' }).click(); await admin.getByLabel('安排組別').selectOption('1');
    await admin.getByRole('button', { name: '儲存座位表' }).click();
    await expect(a.getByRole('heading', { name: '隊伍登入' })).toBeVisible();
    await a.getByLabel('成員 1 學號').fill('E00'); await a.getByLabel('成員 2 學號').fill('E01');
    await a.getByLabel('6 位組別登入碼').fill(s.teams[0].pin); await a.getByRole('button', { name: '登入組別' }).click();
    await expect(a.locator('.page-head')).toContainText('B1');
  });
  await check('成員數量修改、換碼後手機同步、成績 CSV 下載', async () => {
    await admin.getByRole('tab', { name: '隊伍與戰鬥卡' }).click();
    await admin.getByRole('button', { name: '成員設定' }).first().click();
    await admin.locator('#edit-size').selectOption('3'); await admin.getByLabel('成員 3 學號').fill('E02');
    await admin.getByRole('button', { name: '儲存設定' }).click();
    await expect(admin.getByRole('dialog')).not.toBeVisible();
    await admin.getByRole('button', { name: '更新登入碼' }).first().click();
    await admin.getByRole('button', { name: '確認更新' }).click();
    await expect(mobile.locator('.pin-block strong')).not.toHaveText(s.teams[0].pin);
    const downloadPromise = admin.waitForEvent('download'); await admin.getByText('匯出成績 CSV').click();
    const download = await downloadPromise; expect(download.suggestedFilename()).toBe('arena-results.csv');
  });
  await check('即時戰況桌面與手機尺寸、無 JavaScript 錯誤', async () => {
    const board = await adminContext.newPage(); await board.goto(base); await expect(board.getByRole('heading', { name: '隊伍戰績' })).toBeVisible();
    await board.screenshot({ path: 'test-results/scoreboard.png', fullPage: true });
    await mobile.goto(base); await expect(mobile.getByRole('heading', { name: '隊伍戰績' })).toBeVisible();
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await mobile.screenshot({ path: 'test-results/mobile-board.png', fullPage: true });
    expect(errors).toEqual([]);
  });
  writeFileSync('test-results/browser-report.json', JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
  console.log(`Browser flow complete: ${checks.length} checks passed.`);
} catch (error) {
  writeFileSync('test-results/browser-report.json', JSON.stringify({ passed: checks.length, checks, errors, failure: String(error) }, null, 2));
  throw error;
} finally { await browser?.close(); await app.close(); }
