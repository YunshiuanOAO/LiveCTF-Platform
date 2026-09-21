const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function markdownInline(value) {
  const code = [];
  let output = escapeHtml(value).replace(/`([^`]+)`/g, (_, content) => { code.push(`<code>${content}</code>`); return `\u0000CODE${code.length - 1}\u0000`; });
  output = output.replace(/!\[([^\]]*)\]\((\/uploads\/[a-f0-9]{32}\.(?:png|jpg|gif|webp)|https:\/\/[^\s)]+)\)/gi,
    (_, alt, url) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`);
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi,
    (_, label, url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/~~([^~]+)~~/g, '<del>$1</del>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return output.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => code[Number(index)]);
}
function markdown(value) {
  const lines = String(value ?? '').replaceAll('\r', '').split('\n'), output = [];
  let list = null, code = null;
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList();
      if (code) { output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (heading) { closeList(); const level = heading[1].length; output.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`); }
    else if (unordered || ordered) {
      const wanted = unordered ? 'ul' : 'ol';
      if (list !== wanted) { closeList(); list = wanted; output.push(`<${list}>`); }
      output.push(`<li>${markdownInline((unordered || ordered)[1])}</li>`);
    } else if (/^>\s?/.test(line)) { closeList(); output.push(`<blockquote>${markdownInline(line.replace(/^>\s?/, ''))}</blockquote>`); }
    else if (/^\s*---+\s*$/.test(line)) { closeList(); output.push('<hr>'); }
    else if (!line.trim()) { closeList(); }
    else { closeList(); output.push(`<p>${markdownInline(line)}</p>`); }
  }
  closeList(); if (code) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return output.join('');
}
const formatTime = ms => ms == null ? '—' : `${(ms / 1000).toFixed(3)} 秒`;
const resultLabel = { win: '勝', loss: '敗', draw: '平', pending: '進行中' };
let adminState, adminTab = 'rounds', editingQuestionId = null, editingTeamId = null, polling = false, refreshQueued = false, serverOffset = 0, toastTimer, lastMarkup = '', pageLeaving = false;
const activeRequests = new Set();
function storedRegistrationReceipt() {
  try { return JSON.parse(sessionStorage.getItem('arena_registration_receipt') || 'null'); }
  catch { sessionStorage.removeItem('arena_registration_receipt'); return null; }
}
let registrationReceipt = storedRegistrationReceipt();
function syncRegistrationNavigation() {
  const link = document.querySelector('nav a[href="/register"]');
  if (link) link.hidden = !!registrationReceipt;
}
syncRegistrationNavigation();

function renderApp(markup) {
  if (markup === lastMarkup) return false;
  $('#app').innerHTML = markup; lastMarkup = markup; return true;
}

function toast(message, error = false) {
  const element = $('#toast'); element.textContent = message; element.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.className = '', 4500);
}
async function api(path, method = 'GET', data) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
  activeRequests.add(controller);
  try {
    const handoff = sessionStorage.getItem('arena_team_handoff');
    const response = await fetch(path, { method, credentials: 'same-origin', signal: controller.signal,
      headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(handoff ? { 'X-Arena-Handoff': handoff } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await response.json();
    if (!response.ok) { const error = new Error(value.error || '操作失敗'); error.status = response.status; throw error; }
    if (value.serverNow) serverOffset = value.serverNow - Date.now();
    $('#connection').textContent = '已連線'; return value;
  } catch (error) {
    if (!error.status) { $('#connection').textContent = '連線中斷，正在重試'; throw new Error('無法連線，請確認網路後再試'); }
    throw error;
  } finally { clearTimeout(timeout); activeRequests.delete(controller); }
}
const fileBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(new Error('無法讀取圖片'));
  reader.readAsDataURL(file);
});
const badge = (type, label) => `<span class="badge ${type}">${escapeHtml(label)}</span>`;
const empty = (title, note = '') => `<div class="empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(note)}</p></div>`;
const pageHead = (title, description, actions = '') => `<div class="page-head"><div><h1>${title}</h1><p>${description}</p></div>${actions}</div>`;
function studentInputs(size, values = []) {
  return Array.from({ length: size }, (_, i) => `<label>成員 ${i + 1} 學號<input name="student${i}" value="${escapeHtml(values[i] ?? '')}" maxlength="40" autocomplete="off" required></label>`).join('');
}
function sizePicker(target, selected = 2) {
  return `<fieldset class="choice-field"><legend>本組人數</legend><div class="size-options">${[1, 2].map(size => `<label><input type="radio" name="teamSize" value="${size}" data-student-target="${target}" ${size === selected ? 'checked' : ''}><span>${size} 人</span></label>`).join('')}</div></fieldset>`;
}
const readStudents = form => $$('input[name^="student"]', form).map(input => input.value.trim());
const stationText = station => `場地 ${station.arena}・編號 ${station.groupPosition}`;
const resultBadge = result => badge(result === 'win' ? 'win' : result === 'loss' ? 'loss' : result === 'draw' ? 'draw' : 'live', resultLabel[result]);
function history(team) {
  return `<section class="panel"><div class="panel-head"><div><h2>對局紀錄</h2><p>未完成題目會計入該題完整限時</p></div><strong class="mono">累計 ${formatTime(team.totalTimeMs)}</strong></div>${team.results.length ? `<div class="table-wrap"><table><thead><tr><th>場次</th><th>對手</th><th>結果</th><th>實際解題</th><th>計入累計</th></tr></thead><tbody>${team.results.map(row => `<tr><td>#${row.roundId} ${escapeHtml(row.title)}</td><td>${escapeHtml(row.opponent)}</td><td>${resultBadge(row.result)}</td><td class="mono">${row.completed ? formatTime(row.elapsedMs) : '未完成'}</td><td class="mono">${formatTime(row.chargedMs)}</td></tr>`).join('')}</tbody></table></div>` : empty('尚無對局紀錄')}</section>`;
}
function timers() {
  $$('[data-deadline]').forEach(element => {
    const seconds = Math.max(0, Math.ceil((Number(element.dataset.deadline) - Date.now() - serverOffset) / 1000));
    element.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    element.classList.toggle('expired', seconds === 0);
  });
}

function adminLogin() {
  renderApp(`<section class="panel login"><h1>Host 登入</h1><p>管理報到、隨機配對、題目與每局開賽。</p><form id="admin-login"><label>管理員密碼<input name="password" type="password" autocomplete="current-password" required></label><button class="wide">登入</button></form></section>`);
}
function metrics(state) {
  const current = state.rounds.find(r => ['planned', 'preparing', 'running'].includes(r.status));
  return `<div class="metrics"><div class="metric"><span>已報到</span><strong>${state.teams.length}<small> 組</small></strong><small>上限 30 組</small></div><div class="metric"><span>報到狀態</span><strong>${state.registrationLocked ? '已鎖定' : '開放中'}</strong><small>${state.registrationLocked ? '名單不可再變更' : '等待各組完成註冊'}</small></div><div class="metric"><span>目前輪次</span><strong>${current ? `${current.number} / ${state.totalRounds}` : `${state.completedRounds} / ${state.totalRounds}`}</strong><small>${current ? ({ planned: '隊伍移動中', preparing: '登入準備中', running: '對局進行中' }[current.status]) : state.completedRounds >= state.totalRounds ? '競賽已完成' : '尚未配對'}</small></div><div class="metric"><span>準備完成</span><strong>${current?.status === 'preparing' ? current.ready : 0}<small> / ${current ? current.required : state.teams.length}</small></strong><small>${current?.status === 'planned' ? '尚未開放登入' : '每輪皆須重新輸入學號'}</small></div></div>`;
}
function matchRows(round) {
  return round.matches.map(match => `<div class="match"><div class="match-side"><strong>${escapeHtml(match.nameA)}</strong><small>${stationText(match.stationA)}</small></div><span class="vs">VS</span><div class="match-side"><strong>${escapeHtml(match.nameB)}</strong><small>${stationText(match.stationB)}</small></div></div>`).join('');
}
function roundPanel(round) {
  const status = { planned: ['dim', '隊伍移動中'], preparing: ['live', `準備 ${round.ready}/${round.required}`], running: ['live', '進行中'], finished: ['dim', '已結束'] }[round.status];
  const actions = round.status === 'planned' ? `<div class="round-actions"><button data-action="prepare-round" data-id="${round.id}" ${round.questionId ? '' : 'disabled'}>開始對局準備</button></div>`
    : round.status === 'preparing' ? `<div class="round-actions">${round.ready === round.required
      ? `<button data-action="start-round" data-id="${round.id}">開始本輪</button>`
      : `<button class="danger" data-action="force-start-round" data-id="${round.id}" data-missing="${round.required - round.ready}">仍要開始（缺 ${round.required - round.ready} 組）</button>`}</div>`
    : round.status === 'running' ? `<div class="round-actions"><button class="danger" data-action="finish-round" data-id="${round.id}">提前結束</button></div>` : '';
  const missing = round.status === 'preparing' ? `<div class="missing-ready"><div><strong>本輪尚未報到</strong><small>${round.missingReady.length ? `還有 ${round.missingReady.length} 組` : '全部組別皆已完成'}</small></div><div class="row">${round.missingReady.map(team => `<span class="badge ${round.missingReady.length ? 'loss' : 'live'}">${escapeHtml(team.name)}・${stationText(team.station)}</span>`).join('') || badge('live', '全數完成')}</div></div>` : '';
  return `<article class="round"><div class="round-top"><div><h3>第 ${round.number} 輪　${escapeHtml(round.title)}</h3><small>${round.duration ? `${round.duration} 秒` : '尚未設定限時'}・${round.matches.length} 個場地</small></div><div class="row">${badge(...status)}${round.status === 'running' ? `<span class="timer" data-deadline="${round.deadline}"></span>` : ''}</div></div>${missing}<div class="round-body">${matchRows(round)}</div>${actions}</article>`;
}
function adminRounds() {
  const current = adminState.rounds.find(r => ['planned', 'preparing', 'running'].includes(r.status));
  const available = adminState.questions.filter(q => q.id === current?.questionId || !adminState.rounds.some(r => r.questionId === q.id));
  const selectedQuestionId = current?.questionId ?? (available.length === 1 ? available[0].id : null);
  const selectedQuestion = available.find(q => q.id === selectedQuestionId);
  const unlock = adminState.registrationLocked ? `<button class="ghost small" data-action="unlock-registration" ${current?.status === 'running' ? 'disabled' : ''}>解鎖報到</button>` : '';
  const settings = `<section class="panel event-settings"><div class="panel-head"><div><h2>競賽輪數</h2><p>完成設定輪數後停止產生新配對</p></div><button class="danger small" data-action="clear-results" ${current?.status === 'running' || !adminState.completedRounds ? 'disabled' : ''} title="保留隊伍與題目，只清除對局及成績">清除練習成績</button></div><form id="event-settings"><label>總輪數<input name="totalRounds" type="number" min="1" max="30" value="${adminState.totalRounds}" ${adminState.completedRounds ? 'disabled' : ''} required></label><button ${adminState.completedRounds ? 'disabled' : ''}>儲存輪數</button></form></section>`;
  return `${settings}<div class="grid-two"><section class="panel"><div class="panel-head"><div><h2>對局與隨機配對</h2><p>每個場地安排兩組，每組只需要一台隊伍介面</p></div>${unlock}</div>${!adminState.registrationLocked ? `<div class="lock-box"><h3>完成報到後鎖定名單</h3><p>系統只接受偶數組。若目前為奇數組，會把最後報到的雙人組自動拆成兩個單人組。</p><button data-action="lock-registration" ${adminState.teams.length < 2 ? 'disabled' : ''}>鎖定報到並隨機配對</button></div>` : current ? roundPanel(current) : empty('競賽已完成', `已完成 ${adminState.completedRounds} / ${adminState.totalRounds} 輪`)}</section><aside class="panel"><div class="panel-head"><div><h2>本輪題目</h2><p>先設定題目，確認隊伍定位後再開始對局準備</p></div></div>${current?.status === 'planned' ? `<form id="configure-round" data-id="${current.id}"><fieldset class="choice-field question-picker"><legend>選擇題目</legend>${available.length ? available.map(q => `<label class="question-option"><input type="radio" name="questionId" value="${q.id}" ${q.id === selectedQuestionId ? 'checked' : ''}><span><strong>${escapeHtml(q.title)}</strong><small>${q.duration} 秒</small></span></label>`).join('') : `<p class="note">沒有尚未使用的題目，請先到題目庫新增或重新使用。</p>`}<p class="field-error">請先選擇本輪題目。</p></fieldset><label>限時（秒）<input name="duration" type="number" min="5" max="10800" value="${current.duration ?? selectedQuestion?.duration ?? 300}" required></label><button class="wide" ${available.length ? '' : 'disabled'}>儲存本輪題目</button></form>` : `<p>${current?.status === 'preparing' ? '已開放隊伍輸入學號，題目設定已鎖定。' : current?.status === 'running' ? '本輪進行中。' : '競賽已完成。'}</p>`}</aside></div><section class="panel"><div class="panel-head"><h2>歷史輪次</h2><span class="muted">${adminState.completedRounds} / ${adminState.totalRounds} 輪完成</span></div>${adminState.rounds.filter(r => r.status === 'finished').reverse().map(roundPanel).join('') || empty('尚無已完成對局')}</section>`;
}
function adminTeams() {
  const editing = editingTeamId ? adminState.teams.find(team => team.id === editingTeamId) : null;
  if (editingTeamId && !editing) editingTeamId = null;
  const editor = editing ? `<section class="panel team-editor"><div class="panel-head"><div><h2>修改組別</h2><p>儲存後舊學號會釋放，隊伍須使用新學號登入</p></div><button class="ghost small" data-action="cancel-edit-team">取消修改</button></div><form id="team-editor" data-id="${editing.id}"><label>隊伍名稱<input name="name" maxlength="50" value="${escapeHtml(editing.name)}" required></label>${sizePicker('team-edit-students', editing.size)}<div id="team-edit-students">${studentInputs(editing.size, editing.members)}</div><button class="wide">儲存組別修改</button></form></section>` : '';
  return `${editor}<section class="panel"><div class="panel-head"><div><h2>報到名單</h2><p>解鎖報到後可修改或刪除尚無對局紀錄的組別</p></div>${badge(adminState.registrationLocked ? 'dim' : 'live', adminState.registrationLocked ? '已鎖定' : '開放報到')}</div>${adminState.teams.length ? `<div class="table-wrap"><table><thead><tr><th>初始位置</th><th>隊伍</th><th>人數</th><th>學號</th><th>勝 / 敗 / 平</th><th>累計時間</th><th>下一場位置</th><th>操作</th></tr></thead><tbody>${adminState.teams.map(team => { const locked = adminState.registrationLocked || team.results.length; const reason = adminState.registrationLocked ? '請先解鎖報到' : '已有對局紀錄'; return `<tr><td>組別位置 ${team.initialStation}</td><td><strong>${escapeHtml(team.name)}</strong></td><td>${team.size}</td><td class="mono">${team.members.map(escapeHtml).join('、')}</td><td>${team.wins} / ${team.losses} / ${team.draws}</td><td class="mono">${formatTime(team.totalTimeMs)}</td><td>${team.next ? stationText(team.next) : '—'}</td><td><div class="row"><button class="secondary small" data-action="edit-team" data-id="${team.id}" ${locked ? `disabled title="${reason}"` : ''}>修改</button><button class="danger small" data-action="delete-team" data-id="${team.id}" data-name="${escapeHtml(team.name)}" ${locked ? `disabled title="${reason}"` : ''}>刪除組別</button></div></td></tr>`; }).join('')}</tbody></table></div>` : empty('尚無隊伍報到', '請讓學員開啟 /register 輸入自訂隊名與全組學號。')}</section>`;
}
function questionEditor() {
  let question = editingQuestionId ? adminState.questions.find(item => item.id === editingQuestionId) : null;
  if (editingQuestionId && !question) editingQuestionId = null;
  question = editingQuestionId ? question : null;
  const editing = !!question;
  const preview = question?.description ? markdown(question.description) : '<p class="muted">輸入內容後會在這裡預覽。</p>';
  return `<aside class="panel"><div class="panel-head"><h2>${editing ? '修改題目' : '新增題目'}</h2>${editing ? '<button type="button" class="ghost small" data-action="cancel-edit-question">取消修改</button>' : ''}</div><form id="question-editor" data-id="${question?.id ?? ''}"><label>題目名稱<input name="title" maxlength="120" value="${escapeHtml(question?.title ?? '')}" required></label><label>題目內容（支援 Markdown）<textarea name="description" maxlength="12000" required placeholder="## 題目說明&#10;&#10;- 提示一&#10;- 提示二">${escapeHtml(question?.description ?? '')}</textarea></label><label>${editing ? '加入或更換圖片' : '加入圖片'}<input id="question-images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label><small id="image-upload-status">圖片上限 5 MB；上傳後會插入 Markdown。更換圖片時，刪除內容中的舊圖片語法再上傳新圖。</small><div class="markdown-preview"><span>預覽</span><div id="question-preview" class="markdown">${preview}</div></div><label>正確 flag<input name="flag" maxlength="512" autocomplete="off" ${editing ? 'placeholder="留空即保留原 flag"' : 'required'}></label><label>限時（秒）<input name="duration" type="number" min="5" max="10800" value="${question?.duration ?? 300}" required></label><button class="wide">${editing ? '儲存修改' : '儲存題目'}</button></form></aside>`;
}
function adminQuestions() {
  return `<div class="grid-two"><section class="panel"><div class="panel-head"><h2>題目庫</h2><span>${adminState.questions.length} 題</span></div>${adminState.questions.map(q => { const used = adminState.rounds.some(r => r.questionId === q.id), active = adminState.rounds.some(r => r.questionId === q.id && r.status !== 'finished'); return `<article class="round"><div class="round-top"><div><h3>${escapeHtml(q.title)}</h3><small>${q.duration} 秒</small></div><div class="row">${badge(active ? 'live' : used ? 'dim' : 'live', active ? '本局使用中' : used ? '已使用' : '可使用')}<button class="secondary small" data-action="edit-question" data-id="${q.id}" ${active ? 'disabled title="本局使用中，無法修改"' : ''}>修改</button>${used && !active ? `<button class="secondary small" data-action="reuse-question" data-id="${q.id}">重新使用</button>` : ''}<button class="danger small" data-action="delete-question" data-id="${q.id}" data-name="${escapeHtml(q.title)}" ${active ? 'disabled title="本局使用中，無法刪除"' : ''}>刪除</button></div></div><div class="round-body markdown">${markdown(q.description)}</div></article>`; }).join('') || empty('尚無題目')}</section>${questionEditor()}</div>`;
}
function adminAudit() {
  const labels = { 'event.reset': '重設競賽', 'event.results_cleared': '清除練習成績', 'event.settings': '設定競賽輪數', 'event.complete': '競賽完成', 'team.register': '隊伍報到', 'team.update': '修改組別', 'team.delete': '刪除組別', 'team.identify': '恢復隊伍分頁', 'team.session_recovered': '恢復隊伍登入', 'team.late_ready': '遲到隊伍完成登入', 'image.upload': '上傳題目圖片', 'question.delete': '刪除題目', 'question.archive': '移除歷史題目', 'question.reuse': '重新使用題目', 'question.update': '修改題目', 'registration.lock': '鎖定報到', 'registration.unlock': '解鎖報到', 'round.paired': '隨機配對', 'round.configure': '設定題目', 'round.prepare': '開放對局準備', 'team.ready': '隊伍準備完成', 'round.start': '開始對局', 'round.timeout': '時間到', 'round.all_solved': '全員完成', 'round.finish_manual': '提前結束', 'flag.correct': '正確提交' };
  return `<section class="panel"><div class="panel-head"><h2>操作紀錄</h2></div>${adminState.audit.map(row => `<div class="log"><time>${new Date(row.at).toLocaleString('zh-TW')}</time><div><strong>${escapeHtml(labels[row.action] ?? row.action)}</strong><p>${escapeHtml(row.detail)}</p></div></div>`).join('') || empty('尚無操作紀錄')}</section>`;
}
function renderAdmin() {
  renderApp(pageHead('競賽控制中心', '報到鎖定後由系統隨機配對；每局開始前，所有組別必須重新輸入學號。', `<div class="row"><a class="badge dim" href="/api/admin/export">匯出成績 CSV</a><button class="danger small" data-action="reset-event">重設競賽</button><button class="ghost small" data-action="logout">登出</button></div>`) + `<div id="metrics">${metrics(adminState)}</div><div class="tabs">${[['rounds', '對局管理'], ['teams', '報到名單'], ['questions', '題目庫'], ['audit', '操作紀錄']].map(([id, label]) => `<button class="tab ${adminTab === id ? 'active' : ''}" data-action="admin-tab" data-tab="${id}">${label}</button>`).join('')}</div><div id="admin-content">${adminTab === 'rounds' ? adminRounds() : adminTab === 'teams' ? adminTeams() : adminTab === 'questions' ? adminQuestions() : adminAudit()}</div>`);
  timers();
}

async function registrationPage() {
  const event = await api('/api/event');
  if (registrationReceipt) {
    renderApp(pageHead('報到完成', '這些學號已經被安排在同一組。') + `<section class="panel login registration-receipt"><div class="ready-state"><span class="badge live">已建立隊伍</span><h1>${escapeHtml(registrationReceipt.name)}</h1><p>${registrationReceipt.size} 人組</p></div><p class="note">請在這台電腦開啟隊伍介面。Host 鎖定報到後，畫面會顯示本輪應前往的場地。</p><a class="button-link wide" href="/play">開啟隊伍介面</a></section>`);
    return;
  }
  if (event.registrationLocked) {
    renderApp(pageHead('隊伍報到', `目前已有 ${event.teamCount} 組完成報到。`) + `<section class="panel login">${empty('報到已鎖定', '請洽 Host 確認隊伍名單與第一局位置。')}</section>`);
    return;
  }
  renderApp(pageHead('隊伍報到', `自行取隊名，填入全組 1 或 2 位成員的學號。已完成 ${event.teamCount} / ${event.maxTeams} 組。`) + `<section class="panel login registration-form"><h2>建立隊伍</h2><p>同一次送出的學號會自動編為同一組。完成後請保留這台電腦，系統會在此顯示每輪場地。</p><form id="public-register-form"><label>隊伍名稱<input name="name" maxlength="50" autocomplete="off" required></label>${sizePicker('public-register-students')}<div id="public-register-students">${studentInputs(2)}</div><button class="wide">完成報到</button></form></section>`);
}

async function teamPage() {
  const [eventResult, handoffResult] = await Promise.allSettled([api('/api/event'), api('/api/team/state')]);
  if (eventResult.status === 'rejected') throw eventResult.reason;
  const event = eventResult.value;
  let handoff = null;
  if (handoffResult.status === 'fulfilled') handoff = handoffResult.value;
  else if (handoffResult.reason.status !== 401) throw handoffResult.reason;
  if (handoff && !registrationReceipt) {
    registrationReceipt = { id: handoff.team.id, name: handoff.team.name, size: handoff.team.size, station: handoff.team.initialStation };
    sessionStorage.setItem('arena_registration_receipt', JSON.stringify(registrationReceipt)); syncRegistrationNavigation();
  }
  if (registrationReceipt && handoff?.team.id !== registrationReceipt.id) {
    renderApp(pageHead('確認隊伍身分', `這個分頁原本屬於 ${escapeHtml(registrationReceipt.name)}`) + `<section class="panel login station-form"><p>同一瀏覽器的其他分頁曾報到另一組。請重新輸入本組全部學號，這個分頁就會固定回原隊伍。</p><form id="identify-team">${sizePicker('identify-students', registrationReceipt.size)}<div id="identify-students">${studentInputs(registrationReceipt.size)}</div><button class="wide">恢復 ${escapeHtml(registrationReceipt.name)}</button></form><button class="ghost wide" data-action="forget-team">清除此分頁隊伍</button></section>`);
    return;
  }
  if (!event.registrationLocked) {
    renderApp(handoff ? pageHead(escapeHtml(handoff.team.name), '報到完成，等待 Host 鎖定名單') + `<section class="panel login station-form"><div class="ready-state"><span class="badge live">已完成報到</span><h2>${escapeHtml(handoff.team.name)}</h2><p>${handoff.team.size} 人組。名單鎖定並完成配對後，這裡會顯示本輪場地。</p></div></section>` : pageHead('隊伍介面', '完成報到後，這台電腦會顯示每輪場地與題目。') + `<section class="panel login"><h2>尚未識別隊伍</h2><p>請先在這台電腦完成隊伍報到。</p><a class="button-link wide" href="/register">前往隊伍報到</a></section>`);
    return;
  }
  if (event.roundStatus === 'planned') {
    renderApp(handoff?.team.next ? pageHead(escapeHtml(handoff.team.name), `第 ${handoff.team.next.roundId} 輪對戰位置`) + `<section class="move-card"><span>${event.completedRounds ? '上一輪已結束並登出' : '配對已完成'}</span><h2>${escapeHtml(handoff.team.name)}</h2><p>本輪請前往</p><strong>${stationText(handoff.team.next)}</strong><p>對手：${escapeHtml(handoff.team.next.opponent)}</p><small>抵達後請等待 Host 開放對局準備；畫面會自動切換為學號登入。</small></section>${history(handoff.team)}` : pageHead('隊伍移動中', 'Host 尚未開放學號登入。') + `<section class="panel login">${empty('無法識別這台電腦的隊伍', '請回到完成報到的電腦查看本輪場地，或洽 Host。')}</section>`);
    return;
  }
  if (handoff?.loggedIn && handoff.active) {
    const round = handoff.active, match = round.matches[0], solve = match.solves.find(s => s.teamId === handoff.team.id);
    const position = match.teamA === handoff.team.id ? match.stationA : match.stationB;
    renderApp(`${pageHead(escapeHtml(handoff.team.name), stationText(position))}<section class="panel challenge"><div class="panel-head"><div>${badge('live', `第 ${round.number} 輪進行中`)}<h2>${escapeHtml(round.title)}</h2></div><div class="timer" data-deadline="${round.deadline}"></div></div><div class="challenge-text markdown">${markdown(round.description)}</div>${solve ? `<div class="big-result">已提交正確 flag・${formatTime(solve.elapsedMs)}</div>` : `<form id="flag-form"><label for="flag-input">提交 flag</label><div class="submit-row"><input id="flag-input" name="flag" maxlength="512" autocomplete="off" required><button>提交</button></div></form>`}</section>${history(handoff.team)}`);
    timers(); return;
  }
  if (event.roundStatus === 'preparing') {
    const ready = handoff?.loggedIn;
    renderApp(pageHead(ready ? escapeHtml(handoff.team.name) : '對局準備', ready && handoff.team.next ? stationText(handoff.team.next) : '請輸入本組全部學號') + `<section class="panel login station-form">${ready ? `<div class="ready-state"><span class="badge live">準備完成</span><strong>已完成學號驗證</strong><p>等待 Host 開始本輪，開始後題目會自動出現。</p></div>` : `<form id="team-login"><p>每輪都必須重新驗證。請輸入本組 1 或 2 位成員的完整學號。</p>${sizePicker('login-students')}<div id="login-students">${studentInputs(2)}</div><button class="wide">完成驗證並準備</button></form>`}</section>`);
    return;
  }
  if (!event.roundStatus && event.completedRounds >= event.totalRounds) {
    renderApp(handoff ? pageHead('競賽完成', `${escapeHtml(handoff.team.name)} 已完成全部 ${event.totalRounds} 輪`) + `<section class="panel"><div class="score-line"><div><strong>${handoff.team.wins}</strong><span>勝</span></div><div><strong>${handoff.team.losses}</strong><span>敗</span></div><div><strong>${handoff.team.draws}</strong><span>平</span></div></div></section>${history(handoff.team)}` : pageHead('競賽完成', `全部 ${event.totalRounds} 輪已結束`) + `<section class="panel">${empty('感謝參賽', '最終成績請查看即時戰況。')}</section>`);
    return;
  }
  renderApp(pageHead('加入進行中的對局', '遲到或登入狀態遺失的隊伍仍可使用剩餘時間作答') + `<section class="panel login station-form"><form id="team-login"><p>請輸入本組全部學號。驗證完成後會立即進入題目；本輪計時不會重新開始。</p>${sizePicker('login-students')}<div id="login-students">${studentInputs(2)}</div><button class="wide">登入並加入本輪</button></form></section>`);
}

async function scoreboard() {
  const state = await api('/api/scoreboard');
  const active = state.active[0], leaders = state.teams.slice(0, 3), remaining = state.teams.slice(3);
  const arenaStatus = active
    ? `<section class="match-strip live"><div><span>第 ${active.id} 局進行中</span><h2>${escapeHtml(active.title)}</h2><p>${active.matches.length} 個場地同步進行</p></div><div class="match-clock"><small>剩餘時間</small><div class="timer" data-deadline="${active.deadline}"></div></div></section>`
    : `<section class="match-strip standby"><div><span>目前狀態</span><h2>等待下一場對局</h2><p>排行榜持續更新，開賽後將顯示全場倒數。</p></div><strong>STANDBY</strong></section>`;
  const podium = leaders.length ? `<section class="leaders"><div class="section-title"><span>TOP TEAMS</span><h2>領先隊伍</h2></div><div class="leader-grid count-${leaders.length}">${leaders.map((team, index) => `<article class="leader-card place-${index + 1}"><div class="leader-rank"><span>0${index + 1}</span><small>${index === 0 ? 'LEADER' : 'RANK'}</small></div><div class="leader-team"><h3>${escapeHtml(team.name)}</h3><p>${team.size} 人組</p></div><div class="leader-record"><strong>${team.wins}</strong><span>勝</span><b>${team.losses}</b><span>敗</span><b>${team.draws}</b><span>平</span></div><dl><div><dt>完成題數</dt><dd>${team.solved}</dd></div><div><dt>累計時間</dt><dd>${formatTime(team.totalTimeMs)}</dd></div></dl><footer>${team.next ? `下一場　${stationText(team.next)}` : '下一場位置待定'}</footer></article>`).join('')}</div></section>` : '';
  const standings = remaining.length ? `<section class="standings"><div class="section-title standings-head"><div><span>STANDINGS</span><h2>完整排名</h2></div><small>共 ${state.teams.length} 組</small></div><div class="standings-table-wrap"><table class="standings-table"><thead><tr><th>排名</th><th>隊伍</th><th>勝</th><th>敗</th><th>平</th><th>完成題數</th><th>累計時間</th><th>下一場位置</th></tr></thead><tbody>${remaining.map((team, index) => `<tr><td class="placement">${String(index + 4).padStart(2, '0')}</td><td><strong>${escapeHtml(team.name)}</strong><small>${team.size} 人組</small></td><td class="wins">${team.wins}</td><td>${team.losses}</td><td>${team.draws}</td><td>${team.solved}</td><td class="mono">${formatTime(team.totalTimeMs)}</td><td>${team.next ? stationText(team.next) : '—'}</td></tr>`).join('')}</tbody></table></div><div class="mobile-standings">${remaining.map((team, index) => `<article><span class="placement">${String(index + 4).padStart(2, '0')}</span><div class="mobile-team"><strong>${escapeHtml(team.name)}</strong><small>${team.size} 人組 · ${team.wins} 勝 ${team.losses} 敗 ${team.draws} 平</small></div><div class="mobile-time"><strong>${formatTime(team.totalTimeMs)}</strong><small>${team.next ? stationText(team.next) : '位置待定'}</small></div></article>`).join('')}</div></section>` : '';
  renderApp(`<div class="broadcast-scoreboard"><header class="event-heading"><div><span>賽事即時排名</span><h1>即時戰況</h1><p>依勝場、累計時間與平手數排序</p></div><aside><span>參賽隊伍</span><strong>${state.teams.length}</strong><small>TEAMS</small></aside></header>${arenaStatus}${state.teams.length ? `${podium}${standings}` : `<section class="scoreboard-empty"><span>尚未開榜</span><h2>等待隊伍完成報到</h2><p>隊伍建立後會自動顯示於排行榜。</p></section>`}</div>`);
  timers();
}

async function refresh(force = false) {
  if (pageLeaving) return;
  const protectedForm = $('#app form');
  if (!force && protectedForm && (protectedForm.dataset.dirty === 'true' || protectedForm.contains(document.activeElement))) return;
  if (polling) { if (force) refreshQueued = true; return; } polling = true;
  const oldForm = !force ? $('#app form') : null;
  const saved = oldForm ? {
    id: oldForm.id,
    values: Object.fromEntries([...oldForm.elements].filter(x => x.name).map(x => [x.name, x.value])),
    focused: document.activeElement?.name,
    selection: document.activeElement?.selectionStart == null ? null : [document.activeElement.selectionStart, document.activeElement.selectionEnd]
  } : null;
  try {
    if (location.pathname === '/admin') { adminState = await api('/api/admin/state'); renderAdmin(); }
    else if (/^\/station\/\d+$/.test(location.pathname) || location.pathname === '/play') await teamPage();
    else if (location.pathname === '/register') await registrationPage();
    else await scoreboard();
    if (saved && $(`#${saved.id}`)) {
      const form = $(`#${saved.id}`);
      for (const [name, value] of Object.entries(saved.values)) if (form.elements[name]) form.elements[name].value = value;
      const focused = saved.focused && form.elements[saved.focused];
      if (focused) { focused.focus({ preventScroll: true }); if (saved.selection) focused.setSelectionRange(...saved.selection); }
    }
  } catch (error) {
    if (pageLeaving) return;
    if (location.pathname === '/admin' && error.status === 401) adminLogin();
    else if (force) {
      toast(error.message, true);
      if ($('#app')?.textContent.includes('正在連線')) renderApp(`<section class="panel login error-panel"><h1>暫時無法載入</h1><p>${escapeHtml(error.message)}</p><button class="wide" data-action="retry">重新連線</button></section>`);
    }
  } finally { polling = false; if (refreshQueued) { refreshQueued = false; queueMicrotask(() => refresh(true)); } }
}

document.addEventListener('input', event => {
  const form = event.target.closest?.('#app form');
  if (form) form.dataset.dirty = 'true';
  if (event.target.name === 'description' && event.target.closest('#question-editor')) {
    $('#question-preview').innerHTML = event.target.value.trim() ? markdown(event.target.value) : '<p class="muted">輸入內容後會在這裡預覽。</p>';
  }
});
document.addEventListener('change', event => {
  const form = event.target.closest?.('#app form');
  if (form) form.dataset.dirty = 'true';
});
document.addEventListener('change', async event => {
  if (event.target.id === 'question-images') {
    const input = event.target, files = [...input.files], status = $('#image-upload-status'), textarea = input.form.elements.description;
    input.disabled = true;
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index]; status.textContent = `正在上傳 ${index + 1} / ${files.length}：${file.name}`;
        if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} 超過 5 MB`);
        const result = await api('/api/admin/images', 'POST', { type: file.type, data: await fileBase64(file) });
        const alt = file.name.replace(/[\[\]()]/g, '').replace(/\.[^.]+$/, '') || '題目圖片';
        const insertion = `\n![${alt}](${result.url})\n`;
        textarea.setRangeText(insertion, textarea.selectionStart, textarea.selectionEnd, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      status.textContent = `已上傳 ${files.length} 張圖片並插入題目內容。`;
      input.value = '';
    } catch (error) { status.textContent = error.message; toast(error.message, true); }
    finally { input.disabled = false; }
  }
  if (event.target.dataset.studentTarget) $(`#${event.target.dataset.studentTarget}`).innerHTML = studentInputs(Number(event.target.value));
  if (event.target.name === 'questionId' && event.target.closest('#configure-round')) {
    event.target.closest('.question-picker')?.classList.remove('invalid');
    const question = adminState.questions.find(q => q.id === Number(event.target.value)); if (question) event.target.form.duration.value = question.duration;
  }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, values = Object.fromEntries(new FormData(form)); const button = $('button', form); if (button) button.disabled = true;
  try {
    if (form.id === 'admin-login') await api('/api/admin/login', 'POST', { password: values.password });
    else if (form.id === 'register-form') { await api('/api/register', 'POST', { name: values.name, station: Number(form.dataset.station), studentIds: readStudents(form) }); toast('報到完成，等待 Host 鎖定名單'); form.reset(); }
    else if (form.id === 'public-register-form') {
      const result = await api('/api/register', 'POST', { name: values.name, studentIds: readStudents(form) });
      sessionStorage.setItem('arena_team_handoff', result.handoffToken);
      const { handoffToken, ...receipt } = result; registrationReceipt = receipt;
      sessionStorage.setItem('arena_registration_receipt', JSON.stringify(registrationReceipt));
      syncRegistrationNavigation();
      toast('報到完成，所有學號已編入同一組');
    }
    else if (form.id === 'identify-team') {
      const result = await api('/api/identify', 'POST', { studentIds: readStudents(form) });
      sessionStorage.setItem('arena_team_handoff', result.handoffToken);
      const { handoffToken, ...receipt } = result; registrationReceipt = receipt;
      sessionStorage.setItem('arena_registration_receipt', JSON.stringify(receipt)); syncRegistrationNavigation(); toast(`已恢復 ${result.name}`);
    }
    else if (form.id === 'team-login') {
      const result = await api('/api/login', 'POST', { studentIds: readStudents(form) }); sessionStorage.setItem('arena_team_handoff', result.handoffToken);
      registrationReceipt = { id: result.team.id, name: result.team.name, size: result.team.size, station: result.team.initialStation };
      sessionStorage.setItem('arena_registration_receipt', JSON.stringify(registrationReceipt)); syncRegistrationNavigation(); toast('學號驗證完成，已進入準備狀態');
    }
    else if (form.id === 'event-settings') { await api('/api/admin/settings', 'POST', { totalRounds: Number(values.totalRounds) }); toast('競賽輪數已儲存'); }
    else if (form.id === 'team-editor') {
      const result = await api(`/api/admin/teams/${form.dataset.id}`, 'PUT', { name: values.name, studentIds: readStudents(form) });
      editingTeamId = null; toast(`已更新 ${result.name}（${result.size} 人）`);
    }
    else if (form.id === 'question-editor') {
      const id = Number(form.dataset.id);
      if (id) {
        const result = await api(`/api/admin/questions/${id}`, 'PUT', { ...values, duration: Number(values.duration) });
        editingQuestionId = null; toast(result.mode === 'versioned' ? '修改完成；歷史版本已保留，修改後版本可供新對局使用' : '題目已更新');
      } else { await api('/api/admin/questions', 'POST', { ...values, duration: Number(values.duration) }); toast('題目已儲存'); }
    }
    else if (form.id === 'configure-round') {
      if (!values.questionId) { $('.question-picker', form)?.classList.add('invalid'); toast('請先選擇本局題目', true); return; }
      await api(`/api/admin/rounds/${form.dataset.id}/configure`, 'POST', { questionId: Number(values.questionId), duration: Number(values.duration) }); toast('題目已儲存；確認各組抵達場地後，再開放對局準備');
    }
    else if (form.id === 'flag-form') { const result = await api('/api/team/submit', 'POST', { flag: values.flag }); toast(result.correct ? `${result.result === 'win' ? '正確，取得勝場' : '補交完成'}・${formatTime(result.elapsedMs)}` : result.message, !result.correct); }
    await refresh(true);
  } catch (error) { toast(error.message, true); } finally { if (button?.isConnected) button.disabled = false; }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  try {
    if (button.dataset.action === 'admin-tab') { adminTab = button.dataset.tab; renderAdmin(); return; }
    if (button.dataset.action === 'retry') { lastMarkup = ''; await refresh(true); return; }
    if (button.dataset.action === 'forget-team') { registrationReceipt = null; sessionStorage.removeItem('arena_registration_receipt'); sessionStorage.removeItem('arena_team_handoff'); syncRegistrationNavigation(); await refresh(true); return; }
    if (button.dataset.action === 'edit-team') {
      editingTeamId = Number(button.dataset.id); renderAdmin();
      $('#team-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#team-editor input[name="name"]')?.focus(); return;
    }
    if (button.dataset.action === 'cancel-edit-team') { editingTeamId = null; renderAdmin(); return; }
    if (button.dataset.action === 'edit-question') {
      editingQuestionId = Number(button.dataset.id); renderAdmin();
      $('#question-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#question-editor input[name="title"]')?.focus(); return;
    }
    if (button.dataset.action === 'cancel-edit-question') { editingQuestionId = null; renderAdmin(); return; }
    if (button.dataset.action === 'delete-question') {
      if (!confirm(`確定刪除題目「${button.dataset.name}」？`)) return;
      button.disabled = true; const result = await api(`/api/admin/questions/${button.dataset.id}`, 'DELETE', {}); toast(result.mode === 'archived' ? '題目已從題目庫移除，歷史成績仍保留' : '題目已刪除'); await refresh(true); return;
    }
    if (button.dataset.action === 'reuse-question') {
      button.disabled = true; const result = await api(`/api/admin/questions/${button.dataset.id}/reuse`, 'POST', {}); toast(`已將「${result.title}」恢復為可使用`); await refresh(true); return;
    }
    if (button.dataset.action === 'delete-team') {
      if (!confirm(`確定刪除組別「${button.dataset.name}」？該組學號會重新開放報到。`)) return;
      button.disabled = true; const result = await api(`/api/admin/teams/${button.dataset.id}`, 'DELETE', {});
      if (editingTeamId === Number(button.dataset.id)) editingTeamId = null;
      toast(`已刪除 ${result.name}，目前 ${result.teamCount} 組`); await refresh(true); return;
    }
    if (button.dataset.action === 'reset-event') {
      const confirmation = prompt('這會清除所有隊伍、配對、成績與隊伍登入。題目庫會保留。\n\n請輸入 RESET 確認：');
      if (confirmation === null) return;
      button.disabled = true;
      const result = await api('/api/admin/reset', 'POST', { confirmation });
      registrationReceipt = null; editingTeamId = null; sessionStorage.removeItem('arena_registration_receipt'); sessionStorage.removeItem('arena_team_handoff'); syncRegistrationNavigation();
      adminTab = 'rounds'; toast(`競賽已重設，保留 ${result.preservedQuestions} 題並重新開放報到`); await refresh(true); return;
    }
    if (button.dataset.action === 'clear-results') {
      const confirmation = prompt('這會清除所有對局、配對、解題紀錄與成績，但保留隊伍、學號、題目及隊伍裝置。\n\n請輸入 CLEAR 確認：');
      if (confirmation === null) return;
      button.disabled = true;
      const result = await api('/api/admin/results/clear', 'POST', { confirmation });
      toast(`練習成績已清除；保留 ${result.teamCount} 組與 ${result.preservedQuestions} 題${result.paired ? '，已重新配對' : ''}`);
      adminTab = 'rounds'; await refresh(true); return;
    }
    if (button.dataset.action === 'logout') { await api('/api/logout', 'POST', {}); location.reload(); return; }
    button.disabled = true;
    if (button.dataset.action === 'lock-registration') { const result = await api('/api/admin/registration/lock', 'POST', {}); toast(result.split ? `已拆分最後雙人組，目前 ${result.teamCount} 組並完成隨機配對` : `已鎖定 ${result.teamCount} 組並完成隨機配對`); }
    if (button.dataset.action === 'unlock-registration') { const result = await api('/api/admin/registration/unlock', 'POST', {}); toast(result.revertedSplit ? `已解鎖報到，並還原自動拆分的雙人組；目前 ${result.teamCount} 組` : `已解鎖報到；目前 ${result.teamCount} 組`); }
    if (button.dataset.action === 'prepare-round') { await api(`/api/admin/rounds/${button.dataset.id}/prepare`, 'POST', {}); toast('已開放本輪學號登入'); }
    if (button.dataset.action === 'start-round') { await api(`/api/admin/rounds/${button.dataset.id}/start`, 'POST', {}); toast('本局開始'); }
    if (button.dataset.action === 'force-start-round') {
      const round = adminState.rounds.find(item => item.id === Number(button.dataset.id));
      const missing = round?.missingReady.map(team => `${team.name}（${stationText(team.station)}）`).join('、') ?? '';
      if (!confirm(`仍有 ${button.dataset.missing} 組尚未完成登入：\n\n${missing}\n\n確定開始本輪？未登入隊伍之後仍可加入，但計時不會重新開始。`)) return;
      const result = await api(`/api/admin/rounds/${button.dataset.id}/start`, 'POST', { force: true });
      toast(`已強制開始；${result.missingTeamIds.length} 組可稍後補登入`);
    }
    if (button.dataset.action === 'finish-round') { await api(`/api/admin/rounds/${button.dataset.id}/finish`, 'POST', {}); toast('本輪已結束，所有隊伍已登出'); }
    await refresh(true);
  } catch (error) { toast(error.message, true); } finally { if (button.isConnected) button.disabled = false; }
});

document.querySelector('nav').addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  pageLeaving = true;
  activeRequests.forEach(controller => controller.abort());
}, { capture: true });
$$('nav a').forEach(link => { if (link.getAttribute('href') === location.pathname) link.setAttribute('aria-current', 'page'); });
document.body.classList.toggle('scoreboard-page', location.pathname === '/');
document.querySelector('meta[name="theme-color"]').content = '#171717';
await refresh(true);
const pollingDelay = location.pathname === '/admin' ? 2000 : (/^\/station\/\d+$/.test(location.pathname) || location.pathname === '/play') ? 1500 : 3000;
setInterval(() => {
  if (document.visibilityState === 'visible' && !(location.pathname === '/register' && registrationReceipt)) refresh();
}, pollingDelay);
setInterval(timers, 250);
