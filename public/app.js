const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = ms => ms == null ? '未解出' : `${(ms / 1000).toFixed(3)} 秒`;
const resultNames = { win: '勝', loss: '敗', draw: '平', bye: '輪空', pending: '進行中' };
const badge = (r, text) => `<span class="badge ${r}">${esc(text ?? resultNames[r] ?? r)}</span>`;
const empty = (title, note = '') => `<div class="empty"><strong>${esc(title)}</strong><p>${esc(note)}</p></div>`;
let state, tab = 'rounds', seatsDraft, selectedSeat, pairs = [], serverOffset = 0, lastSignature = '', loggedIn = false, polling = false;
let toastTimer, refreshQueued = false;
function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').className = '', 5000);
}
async function api(path, method = 'GET', data) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal });
    const value = await r.json();
    if (!r.ok) { const error = new Error(value.error || '操作失敗'); error.status = r.status; throw error; }
    if (value.serverNow) serverOffset = value.serverNow - Date.now();
    $('#connection').textContent = '● 已連線';
    return value;
  } catch (e) {
    if (!e.status) { $('#connection').textContent = '連線中斷，正在重試'; throw new Error('無法連線，請確認網路後再試'); }
    throw e;
  } finally { clearTimeout(timeout); }
}
function head(eyebrow, title, description, right = '') {
  return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${right}</div>`;
}
function score(t) { return `<div class="score-line"><div><strong class="accent">${t.wins}</strong><span>勝場</span></div><div><strong>${t.losses}</strong><span>敗場</span></div><div><strong>${t.draws}</strong><span>平手</span></div></div>`; }
function history(t) {
  return `<div class="panel"><div class="panel-head"><h2>解題紀錄</h2><span class="muted">${t.solved} 題已解出</span></div>${t.results.length ? `<div class="table-wrap"><table><thead><tr><th>場次 / 題目</th><th>對手</th><th>結果</th><th>解題時間</th></tr></thead><tbody>${t.results.map(r => `<tr><td>#${r.roundId} ${esc(r.title)}</td><td>${esc(r.opponent ?? '—')}</td><td>${badge(r.result)}</td><td class="mono">${r.result === 'bye' ? '—' : time(r.elapsedMs)}</td></tr>`).join('')}</tbody></table></div>` : empty('尚無解題紀錄', '比賽開始後，這裡會顯示每題的結果與提交時間。')}</div>`;
}
function studentInputs(size, values = []) {
  return Array.from({ length: size }, (_, i) => `<label>成員 ${i + 1} 學號<input name="student${i}" value="${esc(values[i] ?? '')}" autocomplete="off" maxlength="40" placeholder="例如 S113001" required></label>`).join('');
}
function readStudents(form) { return $$('input[name^="student"]', form).map(i => i.value.trim()); }
function modal(html) { $('#modal-content').innerHTML = html; $('#modal').showModal(); }
function metrics(s) {
  return `<div class="metrics"><div class="metric"><span>參賽組別</span><strong>${s.teams.length}<small> 隊</small></strong><small>${s.teams.filter(t => t.registered).length} 隊完成報到</small></div><div class="metric"><span>已入座組別</span><strong>${s.teams.filter(t => t.seat).length}<small> 隊</small></strong><small>2v2 · 2v3 · 3v3</small></div><div class="metric"><span>已完成場次</span><strong>${s.rounds.filter(r => r.status === 'finished').length}<small> 場</small></strong><small>共 ${s.rounds.length} 場排程</small></div><div class="metric"><span>目前狀態</span><strong class="accent">${s.rounds.some(r => r.status === 'running') ? '競賽中' : '準備中'}</strong><small>依序公布 · 先解先勝</small></div></div>`;
}
function matchHtml(m) {
  const side = (id, name) => `<div class="match-side"><span>${esc(name ?? '輪空')}</span><small>${id ? (m.winner ? badge(m.winner === id ? 'win' : 'loss') + ' ' : '') + (m.solves.find(s => s.teamId === id) ? time(m.solves.find(s => s.teamId === id).elapsedMs) : '尚未解出') : '不計勝敗平'}</small></div>`;
  return `<div class="match">${side(m.teamA, m.nameA)}<span class="vs">VS</span>${side(m.teamB, m.nameB)}</div>`;
}
function roundList() {
  return state.rounds.length ? [...state.rounds].sort((a, b) => ({ running: 0, scheduled: 1, finished: 2 }[a.status] - { running: 0, scheduled: 1, finished: 2 }[b.status]) || a.id - b.id).map(r => `<article class="round"><div class="round-top"><div><h3><span class="muted">#${r.id.toString().padStart(2, '0')}</span> ${esc(r.title)}</h3><small>${r.duration} 秒限時 · ${r.matches.filter(m => m.teamB).length} 組對戰</small></div>${r.status === 'running' ? `<div class="row">${badge('live', '進行中')}<span class="timer" data-deadline="${r.deadline}"></span></div>` : badge('dim', r.status === 'scheduled' ? '待公布' : '已結束')}</div><div class="round-body">${r.matches.map(matchHtml).join('')}</div><div class="round-actions">${r.status === 'scheduled' ? `<button class="small ghost" data-action="duration" data-id="${r.id}">調整限時</button><button class="small ghost" data-action="cancel-round" data-id="${r.id}">取消排程</button><button class="small" data-action="start" data-id="${r.id}" ${state.rounds.some(x => x.status === 'running' || (x.status === 'scheduled' && x.id < r.id)) ? 'disabled' : ''}>公布並開始</button>` : r.status === 'running' ? `<button class="small danger" data-action="finish-confirm" data-id="${r.id}">提前結束</button>` : ''}</div></article>`).join('') : empty('尚未安排對戰', '建立隊伍與題目，完成報到入座後，即可安排第一場。');
}
function teamOptions(value, allowBye = false) {
  return `<option value="">${allowBye ? '輪空' : '選擇組別'}</option>${state.teams.filter(t => t.registered && t.seat).map(t => `<option value="${t.id}" ${t.id === value ? 'selected' : ''}>${esc(t.name)} (${t.size}人 / ${esc(t.seat)})</option>`).join('')}`;
}
function renderPairs() {
  $('#pair-list').innerHTML = pairs.map((p, i) => `<div class="pair"><select aria-label="對戰 ${i + 1} 左方" data-pair="${i}" data-side="0">${teamOptions(p[0])}</select><span class="vs">v</span><select aria-label="對戰 ${i + 1} 右方" data-pair="${i}" data-side="1">${teamOptions(p[1], true)}</select><button type="button" aria-label="移除對戰 ${i + 1}" data-action="remove-pair" data-index="${i}">×</button></div>`).join('');
}
function adminShell() {
  $('#app').innerHTML = head('賽事管理', '競賽控制中心', '管理隊伍、場地與題目，依序安排對戰。', `<div class="row"><a class="badge dim" href="/api/admin/export">匯出成績 CSV</a><button class="ghost small" data-action="logout">登出</button></div>`) + `<div id="metrics">${metrics(state)}</div><div class="tabs" role="tablist" aria-label="管理功能">${[['rounds', '對戰管理'], ['teams', '隊伍與戰鬥卡'], ['seats', '場地座位'], ['questions', '題目庫'], ['audit', '操作紀錄']].map(([id, title]) => `<button class="tab ${tab === id ? 'active' : ''}" role="tab" aria-selected="${tab === id}" data-action="tab" data-tab="${id}">${title}</button>`).join('')}</div><section id="admin-view"></section>`;
  adminView();
}
function adminView() {
  $$('.tab').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
  const v = $('#admin-view');
  if (tab === 'rounds') {
    const questions = state.questions.filter(q => !state.rounds.some(r => r.questionId === q.id));
    v.innerHTML = `<div class="grid-two"><section class="panel"><div class="panel-head"><div><h2>場次排程</h2><p>同一場次的所有對戰共用題目與倒數</p></div>${badge('live', '即時戰況')}</div><div id="round-list">${roundList()}</div></section><section class="panel"><div class="panel-head"><div><h2>安排下一場</h2><p>配對確認後，對手會出現在戰鬥卡</p></div></div><form id="schedule-form"><label>選擇未公布題目<select name="questionId" id="schedule-question" required><option value="">選擇題目</option>${questions.map(q => `<option value="${q.id}">${esc(q.title)}</option>`).join('')}</select></label><label>本場限時（秒）<input name="duration" type="number" min="5" max="10800" value="300" required></label><div class="panel-head"><h3>對戰組合</h3><button type="button" class="small secondary" data-action="auto-pair">自動配對</button></div><div id="pair-list"></div><div class="row"><button type="button" class="ghost small" data-action="add-pair">＋ 手動配對</button></div><p class="note">自動配對只納入已報到且入座的隊伍，優先避開重複對手。奇數隊伍輪空，不計勝敗平。可在下拉選單指定每場對手。</p><button class="wide" type="submit">加入場次排程</button></form></section></div>`;
    renderPairs();
  } else if (tab === 'teams') {
    v.innerHTML = `<section class="panel"><div class="panel-head"><div><h2>建立參賽組別</h2><p>設定人數後，將隊伍 QR Code 交給參賽者完成報到。</p></div></div><form id="team-create" class="row"><label>組別名稱<input name="name" maxlength="50" placeholder="例如 第 01 組" required></label><label>隊伍人數<select name="size"><option value="2">2 人</option><option value="3">3 人</option></select></label><button type="submit">建立隊伍</button></form></section><section class="panel"><div class="panel-head"><h2>參賽隊伍</h2><span class="muted">${state.teams.length} 隊</span></div>${state.teams.length ? `<div class="table-wrap"><table class="team-table"><thead><tr><th>組別</th><th>報到狀態</th><th>席位</th><th>勝 / 敗 / 平</th><th>累計解題時間</th><th>管理</th></tr></thead><tbody>${state.teams.map(t => `<tr><td><div class="row"><span class="avatar">${String(t.id).padStart(2, '0')}</span><div><h3>${esc(t.name)}</h3><small>${t.size} 人</small></div></div></td><td>${badge(t.registered ? 'live' : 'dim', t.registered ? '已報到' : '待報到')}</td><td>${esc(t.seat ?? '未安排')}</td><td class="team-record"><b>${t.wins}</b> / ${t.losses} / ${t.draws}</td><td class="mono">${time(t.totalSolveMs)}</td><td><div class="team-actions"><button class="small" data-action="qr" data-id="${t.id}">QR 戰鬥卡</button><button class="small ghost" data-action="edit-team" data-id="${t.id}">成員設定</button><button class="small ghost" data-action="rotate-confirm" data-id="${t.id}">更新登入碼</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('尚無參賽隊伍', '請在上方輸入組別名稱並設定人數。')}</section>`;
  } else if (tab === 'seats') {
    seatsDraft ??= structuredClone(state.seats).map(s => ({ ...s, enabled: !!s.enabled }));
    v.innerHTML = `<div class="grid-two"><section class="panel"><div class="panel-head"><div><h2>現場座位配置</h2><p>一個座位格代表一個隊伍席位（容納 2–3 人）</p></div><button class="small" data-action="save-seats">儲存座位表</button></div><div class="stage">主舞台 / 投影幕</div><div class="seat-map-scroll"><div id="seat-grid" class="seat-grid"></div></div><p class="seat-map-hint">左右滑動檢視完整座位表</p><div class="legend"><span>已入座</span><span>開放空位</span><span>停用座位</span></div><p class="note">移動隊伍後，原電腦的登入會失效；新座位請使用全隊學號與戰鬥卡登入碼登入。比賽中無法換位。</p></section><aside class="panel"><h2>座位設定</h2><div id="seat-editor"></div></aside></div>`;
    drawSeats();
  } else if (tab === 'questions') {
    v.innerHTML = `<div class="grid-two"><section class="panel"><div class="panel-head"><div><h2>題目庫</h2><p>未開賽的題目只有管理員可見</p></div>${badge('dim', `${state.questions.length} 題`)}</div>${state.questions.map(q => `<article class="round"><div class="round-top"><h3>${esc(q.title)}</h3>${badge('dim', `${q.duration} 秒`)}</div><div class="round-body"><p class="challenge-text">${esc(q.description)}</p><small>${state.rounds.some(r => r.questionId === q.id) ? '已排程 / 已使用' : '可安排對戰'} · flag 已安全儲存</small>${!state.rounds.some(r => r.questionId === q.id) ? `<button class="small ghost" data-action="edit-question" data-id="${q.id}">編輯題目</button>` : ''}</div></article>`).join('') || empty('尚無題目', '請先新增題目、正確 flag 與作答限時。')}</section><section class="panel"><h2>新增題目</h2><form id="question-create"><label>題目名稱<input name="title" maxlength="120" placeholder="例如 密碼學入門：解開訊息" required></label><label>題目內容 / 題目資源網址<textarea name="description" maxlength="12000" placeholder="輸入完整題目，或放入現場題目服務的網址。" required></textarea></label><label>正確 flag（區分大小寫）<input name="flag" autocomplete="off" maxlength="512" placeholder="flag{...}" required></label><label>預設限時（秒）<input name="duration" type="number" min="5" max="10800" value="300" required></label><button class="wide">儲存題目</button></form><p class="note">計時從管理員按下「公布並開始」起算，以伺服器收到完整 flag 的時間為準。flag 前後空白會自動忽略。</p></section></div>`;
  } else {
    v.innerHTML = `<div class="panel"><div class="panel-head"><h2>最近操作紀錄</h2><span class="muted">最近 40 筆 · 完整紀錄保存在資料庫</span></div>${state.audit.map(a => `<div class="log"><time>${new Date(a.at).toLocaleString('zh-TW')}</time><div><strong>${esc(({ 'team.create': '建立隊伍', 'team.register': '隊伍完成註冊', 'team.update': '更新隊伍', 'team.rotate_pin': '更換登入碼', 'seats.update': '調整座位', 'question.create': '新增題目', 'round.schedule': '安排場次', 'round.cancel': '取消排程', 'round.start': '公布題目', 'round.timeout': '時間到，結算場次', 'round.all_solved': '全隊解出，結算場次', 'round.finish_manual': '管理員提前結束', 'flag.correct': '正確 flag' })[a.action] ?? a.action)}</strong><p>${esc(a.detail)}</p></div></div>`).join('') || empty('尚無操作紀錄')}</div>`;
  }
}
function drawSeats() {
  $('#seat-grid').innerHTML = seatsDraft.map(s => `<button class="seat ${!s.enabled ? 'off' : s.teamId ? 'occupied' : ''} ${selectedSeat === s.id ? 'selected' : ''}" data-action="select-seat" data-id="${s.id}"><small>${esc(s.label)}</small><strong>${!s.enabled ? '停用' : esc(state.teams.find(t => t.id === s.teamId)?.name ?? '空位 ＋')}</strong></button>`).join('');
  const s = seatsDraft.find(s => s.id === selectedSeat);
  $('#seat-editor').innerHTML = s ? `<p class="eyebrow">${esc(s.label)}</p><label class="check"><input id="seat-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}>開放此座位</label><label>安排組別<select id="seat-team" ${!s.enabled ? 'disabled' : ''}><option value="">空位</option>${state.teams.map(t => `<option value="${t.id}" ${t.id === s.teamId ? 'selected' : ''}>${esc(t.name)}（${t.size} 人）</option>`).join('')}</select></label><p class="note">選擇已在其他位置的隊伍，會自動移到此位置。所有調整需按「儲存座位表」才會生效。</p>` : empty('點選一個座位', '可指定組別或標記為停用。');
}
function adminLogin() {
  $('#app').innerHTML = `<section class="panel login"><div class="eyebrow">賽事管理</div><h1>管理員登入</h1><p>登入後管理題目、隊伍、座位與競賽場次。</p><form id="admin-login"><label>管理員密碼<input name="password" type="password" autocomplete="current-password" required></label><button class="wide">進入控制中心</button></form></section>`;
}
function teamLogin(size = 2) {
  $('#app').innerHTML = `<section class="panel login"><div class="eyebrow">參賽入口</div><h1>隊伍登入</h1><p>換位後，輸入全隊學號與手機戰鬥卡上的 6 位登入碼，即可回到原組別。</p><form id="team-login"><label>隊伍人數<select id="login-size"><option value="2" ${size === 2 ? 'selected' : ''}>2 人</option><option value="3" ${size === 3 ? 'selected' : ''}>3 人</option></select></label><div id="login-students">${studentInputs(size)}</div><label>6 位組別登入碼<input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" placeholder="查看手機戰鬥卡" required></label><button class="wide">登入組別</button></form><p class="note">第一次參賽？請先向工作人員取得隊伍 QR Code，掃描後完成學號註冊。</p></section>`;
}
function renderCard(s) {
  const savedStudents = $('#card-register') ? readStudents($('#card-register')) : [];
  const focusedName = document.activeElement?.name;
  const t = s.team;
  $('#app').innerHTML = `<article class="battle-card"><div class="row spread"><span class="eyebrow">隊伍戰鬥卡</span>${badge(t.registered ? 'live' : 'dim', t.registered ? '已報到' : '尚未註冊')}</div><h1>${esc(t.name)}</h1><p>${t.size} 人小隊 <span class="muted">/</span> 席位 ${esc(t.seat ?? '待安排')}</p>${score(t)}<div class="row spread"><span class="muted">累計解題時間</span><strong class="mono">${time(t.totalSolveMs)}</strong></div><div class="pin-block"><small>換位登入碼 · 搭配全隊學號使用</small><strong class="mono">${esc(t.pin)}</strong><small>僅提供給你的隊員，請勿公開戰鬥卡</small></div><div class="row spread"><div><small>下一場對手</small><h2>${esc(t.next ? t.next.opponent ?? '本場輪空' : '等待配對')}</h2></div><span class="badge dim">${t.next ? `#${t.next.roundId} · ${esc(t.next.opponentSeat ?? '—')}` : '尚未安排'}</span></div>${s.active ? `<p class="note">目前第 ${s.active.id} 場正在進行：${esc(s.active.title)}<br><span data-deadline="${s.active.deadline}" class="timer"></span></p>` : ''}${!t.registered ? `<div class="pin-block"><h2>首次報到</h2><p>填入全隊 ${t.size} 位成員學號。</p></div><form id="card-register">${studentInputs(t.size)}<button class="wide">完成隊伍註冊</button></form>` : `<p class="note">請在比賽電腦開啟「參賽入口」，用全隊學號和上方登入碼登入。</p>`}</article><section class="card-history">${history(t)}</section>`;
  if ($('#card-register')) {
    $$('#card-register input').forEach((input, i) => { input.value = savedStudents[i] ?? ''; if (input.name === focusedName) input.focus({ preventScroll: true }); });
  }
}
function renderPlay(s) {
  const t = s.team, r = s.active, m = r?.matches[0], solve = m?.solves.find(x => x.teamId === t.id);
  const flagFocused = document.activeElement?.id === 'flag-input';
  const selection = [$('#flag-input')?.selectionStart, $('#flag-input')?.selectionEnd];
  const oldFlag = $('#flag-input')?.value;
  const oldRound = $('#flag-form')?.dataset.round;
  $('#app').innerHTML = head('參賽介面', esc(t.name), `${t.size} 人小隊 · 目前座位 ${esc(t.seat ?? '待安排')}`, `<button class="ghost small" data-action="logout">換位 / 登出</button>`) + `<div class="grid-two"><section><div class="panel challenge">${r && m?.teamB ? `<div class="panel-head"><div>${badge('live', `第 ${r.id} 場 · 進行中`)}<h2>${esc(r.title)}</h2></div><div><small>剩餘時間</small><div class="timer" data-deadline="${r.deadline}"></div></div></div><div class="row spread"><span class="muted">本場對手</span><strong>${esc(m.teamA === t.id ? m.nameB : m.nameA)}</strong></div><div class="challenge-text">${esc(r.description)}</div>${solve ? `<div class="big-result ${m.winner !== t.id ? 'loss' : ''}">${m.winner === t.id ? '搶下首解，取得一勝！' : '已完成補交，本題記一敗。'}<br>解題時間：${time(solve.elapsedMs)}</div>` : `${m.winner ? '<p class="note">對手已先解出，本題記一敗。你仍可在時限內補交，留下解題時間。</p>' : ''}<form id="flag-form" data-round="${r.id}"><label for="flag-input">提交 flag</label><div class="submit-row"><input id="flag-input" name="flag" placeholder="flag{your_answer}" autocomplete="off" maxlength="512" required><button>提交 FLAG</button></div></form>`}` : empty(r ? '本場輪空，稍作休息' : '等待下一題公布', r ? '本場不計勝敗平。' : '題目開始後會自動出現，不需要重新整理。')}</div>${history(t)}</section><aside class="panel"><div class="eyebrow">本隊累計成績</div><h2>隊伍戰績</h2>${score(t)}<div class="row spread"><span class="muted">累計解題</span><strong class="mono">${time(t.totalSolveMs)}</strong></div><p class="note">下一場對手<br><strong>${esc(t.next ? t.next.opponent ?? '輪空' : '等待安排')}</strong>${t.next ? ` · 第 ${t.next.roundId} 場` : ''}</p><ol class="help-list"><li>每題第一隊正確提交取得一勝，另一隊記一敗。</li><li>敗方可在限時內補交並留下解題時間。</li><li>限時內雙方皆未答對，各記一平。</li></ol></aside></div>`;
  if (oldRound === String(r?.id) && $('#flag-input')) {
    $('#flag-input').value = oldFlag ?? '';
    if (flagFocused) { $('#flag-input').focus({ preventScroll: true }); $('#flag-input').setSelectionRange(...selection); }
  }
}
function renderBoard(s) {
  $('#app').innerHTML = head('LIVE ARENA', '即時戰況', '查看目前場次、隊伍成績與下一場對手。', badge('live', '即時戰況')) + `<div class="hero-board"><div class="row spread"><div><div class="eyebrow">${s.active.length ? '目前場次' : '場次狀態'}</div><h2>${esc(s.active[0]?.title ?? '賽場準備中')}</h2><p>${s.active.length ? `第 ${s.active[0].id} 場已開始，第一個正確 flag 決定勝負。` : '參賽者請掃描隊伍 QR Code 完成報到，再前往指定座位。'}</p></div>${s.active.length ? `<div class="timer" data-deadline="${s.active[0].deadline}"></div>` : '<a class="badge live" href="/play">前往參賽入口</a>'}</div></div><div class="steps"><div class="step"><b>01</b> 掃描戰鬥卡，完成隊伍報到</div><div class="step"><b>02</b> 依指定座位入座，登入組別</div><div class="step"><b>03</b> 等待題目公布，提交你的 flag</div></div><section class="panel"><div class="panel-head"><div><h2>隊伍戰績</h2><p>依勝場、平場、敗場排序；同戰績並列，解題時間獨立記錄</p></div>${badge('dim', `${s.teams.length} 隊`)}</div>${s.teams.length ? `<div class="table-wrap"><table><thead><tr><th>排名</th><th>參賽組別</th><th>席位</th><th>勝</th><th>敗</th><th>平</th><th>已解題數</th><th>累計解題時間</th><th>下一場對手</th></tr></thead><tbody>${s.teams.map((t, i) => { const rank = s.teams.findIndex(x => x.wins === t.wins && x.draws === t.draws && x.losses === t.losses) + 1; return `<tr><td class="rank ${rank === 1 ? 'first' : ''}">${String(rank).padStart(2, '0')}</td><td><div class="row"><span class="avatar">${String(t.id).padStart(2, '0')}</span><div><strong>${esc(t.name)}</strong><br><small>${t.size} 人小隊</small></div></div></td><td>${esc(t.seat ?? '—')}</td><td class="accent">${t.wins}</td><td>${t.losses}</td><td>${t.draws}</td><td>${t.solved}</td><td class="mono">${time(t.totalSolveMs)}</td><td>${esc(t.next ? t.next.opponent ?? '輪空' : '等待安排')}</td></tr>`; }).join('')}</tbody></table></div>` : empty('尚無參賽隊伍', '完成報到後，這裡會即時顯示所有組別的戰績。')}</section>`;
}
async function refresh(force = false) {
  if (polling) { if (force) refreshQueued = true; return; } polling = true;
  try {
    const path = location.pathname;
    if (path === '/admin') {
      if (!loggedIn && !force) return;
      state = await api('/api/admin/state'); loggedIn = true;
      if (!$('#admin-view')) adminShell();
      else if (force) { $('#metrics').innerHTML = metrics(state); adminView(); }
      else { $('#metrics').innerHTML = metrics(state); if ($('#round-list')) $('#round-list').innerHTML = roundList(); }
    } else if (path === '/play') {
      if (!loggedIn && !force) return;
      const s = await api('/api/team/state'); loggedIn = true;
      const sig = JSON.stringify([s.team, s.active]);
      if (force || sig !== lastSignature) renderPlay(s);
      lastSignature = sig;
    } else if (path.startsWith('/card/')) {
      const s = await api(`/api${path}`), sig = JSON.stringify([s.team, s.active]);
      if (force || sig !== lastSignature) renderCard(s); lastSignature = sig;
    } else {
      const s = await api('/api/scoreboard'), sig = JSON.stringify([s.teams, s.active]);
      if (force || sig !== lastSignature) renderBoard(s); lastSignature = sig;
    }
    timers();
  } catch (e) {
    if (e.status === 401) { loggedIn = false; lastSignature = ''; location.pathname === '/admin' ? adminLogin() : teamLogin(); }
    else if (force) { toast(e.message, true); if (!state && !$('#app form')) $('#app').innerHTML = empty('暫時無法載入', e.message); }
  } finally { polling = false; if (refreshQueued) { refreshQueued = false; queueMicrotask(() => refresh(true)); } }
}
function timers() {
  $$('[data-deadline]').forEach(el => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.deadline) - Date.now() - serverOffset) / 1000));
    el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('expired', left === 0);
    if (!left && $('#flag-form button')) $('#flag-form button').disabled = true;
  });
}

document.addEventListener('submit', async e => {
  e.preventDefault(); const form = e.target, values = Object.fromEntries(new FormData(form));
  const button = $('button[type="submit"], button:not([type])', form); if (button) button.disabled = true;
  try {
    if (form.id === 'admin-login') { await api('/api/admin/login', 'POST', values); loggedIn = true; }
    else if (form.id === 'team-login') { await api('/api/login', 'POST', { pin: values.pin, studentIds: readStudents(form) }); loggedIn = true; }
    else if (form.id === 'card-register') { await api(`/api${location.pathname}/register`, 'POST', { studentIds: readStudents(form) }); toast('報到完成！請前往指定座位登入。'); }
    else if (form.id === 'team-create') { await api('/api/admin/teams', 'POST', { name: values.name, size: Number(values.size) }); toast('隊伍已建立，請發送戰鬥卡 QR Code'); }
    else if (form.id === 'question-create') { await api('/api/admin/questions', 'POST', { ...values, duration: Number(values.duration) }); toast('題目已儲存'); }
    else if (form.id === 'question-edit') { await api(`/api/admin/questions/${form.dataset.id}`, 'PATCH', { ...values, duration: Number(values.duration) }); $('#modal').close(); toast('題目已更新'); }
    else if (form.id === 'schedule-form') { await api('/api/admin/rounds', 'POST', { questionId: Number(values.questionId), duration: Number(values.duration), pairs }); pairs = []; toast('場次已排程，戰鬥卡已更新下一場對手'); }
    else if (form.id === 'team-edit') { await api(`/api/admin/teams/${form.dataset.id}`, 'PATCH', { name: values.name, size: Number(values.size), studentIds: readStudents(form).filter(Boolean) }); $('#modal').close(); toast('隊伍已更新，請使用新成員學號重新登入'); }
    else if (form.id === 'duration-edit') { await api(`/api/admin/rounds/${form.dataset.id}`, 'PATCH', { duration: Number(values.duration) }); $('#modal').close(); toast('限時已更新'); }
    else if (form.id === 'flag-form') {
      const r = await api('/api/team/submit', 'POST', { roundId: Number(form.dataset.round), flag: values.flag });
      toast(r.correct ? `${r.result === 'win' ? '正確！取得一勝' : '補交成功'} · ${time(r.elapsedMs)}` : r.message, !r.correct);
      if (r.correct) form.reset();
    }
    await refresh(true);
  } catch (e) { toast(e.message, true); if (e.status === 401 && form.id === 'flag-form') await refresh(true); }
  finally { if (button?.isConnected) button.disabled = false; timers(); }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'login-size') $('#login-students').innerHTML = studentInputs(Number(el.value));
  if (el.id === 'edit-size') $('#edit-students').innerHTML = studentInputs(Number(el.value), readStudents($('#team-edit'))).replaceAll(' required', $('#team-edit').dataset.registered === 'true' ? ' required' : '');
  if (el.id === 'schedule-question') { const q = state.questions.find(q => q.id === Number(el.value)); if (q) $('#schedule-form input[name="duration"]').value = q.duration; }
  if (el.dataset.pair !== undefined) pairs[Number(el.dataset.pair)][Number(el.dataset.side)] = el.value ? Number(el.value) : null;
  if (el.id === 'seat-enabled') { const s = seatsDraft.find(s => s.id === selectedSeat); s.enabled = el.checked; if (!s.enabled) s.teamId = null; drawSeats(); }
  if (el.id === 'seat-team') { const id = el.value ? Number(el.value) : null; for (const s of seatsDraft) if (s.teamId === id) s.teamId = null; seatsDraft.find(s => s.id === selectedSeat).teamId = id; drawSeats(); }
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-action]'); if (!b || b.disabled) return;
  const action = b.dataset.action, id = Number(b.dataset.id);
  try {
    if (action === 'close-modal') { $('#modal').close(); return; }
    if (action === 'tab') { tab = b.dataset.tab; await refresh(true); return; }
    if (action === 'logout') { await api('/api/logout', 'POST', {}); loggedIn = false; location.reload(); return; }
    if (action === 'auto-pair') { pairs = (await api('/api/admin/pairings/preview', 'POST', {})).pairs; renderPairs(); toast('已產生配對，可手動調整後加入排程'); return; }
    if (action === 'add-pair') { pairs.push([null, null]); renderPairs(); return; }
    if (action === 'remove-pair') { pairs.splice(Number(b.dataset.index), 1); renderPairs(); return; }
    if (action === 'select-seat') { selectedSeat = id; drawSeats(); return; }
    if (action === 'save-seats') { await api('/api/admin/seats', 'PUT', { seats: seatsDraft }); seatsDraft = null; toast('座位表已儲存；換位隊伍需重新登入'); }
    if (action === 'qr') {
      const t = state.teams.find(t => t.id === id);
      modal(`<div class="qr"><div class="eyebrow">隊伍報到</div><h2>${esc(t.name)}</h2><p>${t.size} 人隊伍 · 掃描完成報到及查看戰鬥卡</p><img src="/api/admin/teams/${id}/qr" alt="${esc(t.name)} 專屬 QR Code"><a href="/card/${t.cardToken}" target="_blank" rel="noopener">開啟隊伍戰鬥卡</a><p class="note">請透過手機能連線的主機 IP 開啟後台，或設定 PUBLIC_URL，確保 QR Code 指向現場網址。</p><button data-action="print" class="ghost small">列印 QR Code</button></div>`); return;
    }
    if (action === 'print') { window.print(); return; }
    if (action === 'edit-team') {
      const t = state.teams.find(t => t.id === id);
      modal(`<h2>組別與成員設定</h2><form id="team-edit" data-id="${id}" data-registered="${t.registered}"><label>組別名稱<input name="name" value="${esc(t.name)}" required maxlength="50"></label><label>隊伍人數<select name="size" id="edit-size"><option value="2" ${t.size === 2 ? 'selected' : ''}>2 人</option><option value="3" ${t.size === 3 ? 'selected' : ''}>3 人</option></select></label><div id="edit-students">${studentInputs(t.size, t.members).replaceAll(' required', t.registered ? ' required' : '')}</div><p class="note">未報到隊伍可以留空學號，讓參賽者掃 QR Code 自行填寫。已報到隊伍需填寫完整成員。</p><button class="wide">儲存設定</button></form>`); return;
    }
    if (action === 'edit-question') {
      const q = state.questions.find(q => q.id === id);
      modal(`<h2>編輯未公布題目</h2><form id="question-edit" data-id="${id}"><label>題目名稱<input name="title" value="${esc(q.title)}" maxlength="120" required></label><label>題目內容<textarea name="description" maxlength="12000" required>${esc(q.description)}</textarea></label><label>更新 flag（留空保留原值）<input name="flag" maxlength="512" autocomplete="off"></label><label>預設限時（秒）<input name="duration" type="number" min="5" max="10800" value="${q.duration}" required></label><button class="wide">儲存題目變更</button></form>`); return;
    }
    if (action === 'duration') { const r = state.rounds.find(r => r.id === id); modal(`<h2>調整第 ${id} 場限時</h2><form id="duration-edit" data-id="${id}"><label>限時（秒）<input name="duration" type="number" min="5" max="10800" value="${r.duration}" required></label><button class="wide">儲存限時</button></form>`); return; }
    if (action === 'finish-confirm') { modal(`<h2>提前結束第 ${id} 場？</h2><p>尚無正確提交的對戰將各記一平；已分勝負的對戰保留結果，並停止敗方補交。</p><p class="note">此操作會立即結算，無法重新開賽。</p><button class="danger wide" data-action="finish" data-id="${id}">確認提前結束</button>`); return; }
    if (action === 'rotate-confirm') { modal(`<h2>更新組別登入碼？</h2><p>戰鬥卡會顯示新的 6 位隨機碼，該隊所有電腦需要重新登入。</p><button class="wide" data-action="rotate" data-id="${id}">確認更新</button>`); return; }
    b.disabled = true;
    if (action === 'start') { await api(`/api/admin/rounds/${id}/start`, 'POST', {}); toast('題目已公布，比賽開始！'); }
    if (action === 'finish') { await api(`/api/admin/rounds/${id}/finish`, 'POST', {}); $('#modal').close(); toast('場次已結算'); }
    if (action === 'cancel-round') { await api(`/api/admin/rounds/${id}`, 'DELETE', {}); toast('排程已取消，題目可以重新安排'); }
    if (action === 'rotate') { await api(`/api/admin/teams/${id}/rotate`, 'POST', {}); $('#modal').close(); toast('登入碼已更新'); }
    await refresh(true);
  } catch (e) { toast(e.message, true); } finally { if (b.isConnected) b.disabled = false; }
});
document.body.classList.toggle('card-page', location.pathname.startsWith('/card/'));
$$('nav a').forEach(a => { if (a.getAttribute('href') === location.pathname) a.setAttribute('aria-current', 'page'); });
await refresh(true);
setInterval(() => refresh(), 1000);
setInterval(timers, 250);
