// ====== 設定：請把這行換成你自己的 Apps Script Web App 網址 ======
const API_BASE = 'https://script.google.com/macros/s/AKfycbwzaCtg5KK1Th923xFZGUuwyiai5Cn8yXSVFsERfRiUOtbrC8tvn-ek6QNZSSuAluKJXg/exec';
// =================================================================

const SLOTS_PER_DAY = 48; // 一天總共 48 個半小時格（內部仍以此為基準）
const VISIBLE_START_HOUR = 6; // 畫面只顯示從這個時間開始（6 = 早上 6:00），00:00-06:00 不練習所以隱藏
const VISIBLE_START_SLOT = VISIBLE_START_HOUR * 2;
const VISIBLE_SLOT_COUNT = SLOTS_PER_DAY - VISIBLE_START_SLOT; // 顯示到 24:00 為止
const ROW_HEIGHT = 30;
const MIN_OVERLAP = 2; // 至少幾人重疊才算「可約時段」
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const QUICK_JUMPS = [
  { label: '清晨', hour: 6 },
  { label: '上午', hour: 9 },
  { label: '下午', hour: 13 },
  { label: '晚上', hour: 18 },
  { label: '深夜', hour: 22 },
];

const state = {
  people: [],
  availability: {},
  sessions: [],
  selectedPersonId: null,
  tab: 'calendar',
  viewMode: 'week', // week | twoWeek | month
  anchorDate: new Date(),
  monthDrillDate: null,
  draftKey: null,
  draft: null,
};

// ---------- 日期工具 ----------
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function toShortDate(dateStrOrDate) {
  const d = dateStrOrDate instanceof Date ? dateStrOrDate : parseDateStr(dateStrOrDate);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function mondayOf(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d, n) {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}
function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function slotToLabel(slot) {
  const h = Math.floor(slot / 2);
  const m = (slot % 2) * 30;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function slotToDisplayIndex(slot) {
  return slot - VISIBLE_START_SLOT;
}
function slotEndDateTime(dateStr, endSlotExclusive) {
  const d = parseDateStr(dateStr);
  d.setMinutes(d.getMinutes() + endSlotExclusive * 30);
  return d;
}
function idsKey(ids) {
  return [...ids].sort().join(',');
}
function peopleById() {
  const map = {};
  state.people.forEach((p) => (map[p.id] = p));
  return map;
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- API ----------
async function apiGetAll() {
  const res = await fetch(`${API_BASE}?action=getAll`);
  return res.json();
}
async function apiPost(action, payload) {
  setSaving(true);
  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
    });
    return await res.json();
  } finally {
    setSaving(false);
  }
}
function applyData(data) {
  if (data.error) { showError(data.error); return; }
  state.people = data.people || [];
  state.availability = data.availability || {};
  state.sessions = data.sessions || [];
}
function showError(msg) {
  const el = document.getElementById('errorBanner');
  el.textContent = msg;
  el.style.display = 'flex';
}
function hideError() {
  document.getElementById('errorBanner').style.display = 'none';
}
function setSaving(isSaving) {
  document.getElementById('savingIndicator').style.display = isSaving ? 'block' : 'none';
}

// ---------- 初始化 ----------
async function init() {
  document.getElementById('errorBanner').addEventListener('click', hideError);
  document.getElementById('refreshBtn').addEventListener('click', refreshAll);
  setupDragHandlers();
  await refreshAll();
}

async function refreshAll() {
  try {
    const data = await apiGetAll();
    applyData(data);
  } catch (e) {
    showError('讀取資料失敗，請確認 app.js 裡的 API_BASE 網址設定正確');
  }
  render();
}

function pickMe(id) {
  state.selectedPersonId = id;
  render();
}

// ---------- 切換時段（含拉選） ----------
let dragState = null; // { dateStr, startSlot, currentSlot, mode }

async function saveRange(dateStr, startSlot, endSlot, mode) {
  if (!state.selectedPersonId) return;
  try {
    const data = await apiPost('setRangeAvailability', {
      personId: state.selectedPersonId,
      dateStr,
      startSlot,
      endSlot,
      mode,
    });
    applyData(data);
  } catch (e) {
    showError('儲存時段失敗，請再試一次');
  }
  render();
}

async function toggleFullDay(dateStr) {
  if (!state.selectedPersonId) return;
  try {
    const data = await apiPost('toggleFullDay', { personId: state.selectedPersonId, dateStr });
    applyData(data);
  } catch (e) {
    showError('儲存整天時段失敗，請再試一次');
  }
  render();
}

function applyDragPreview() {
  if (!dragState) return;
  const lo = Math.min(dragState.startSlot, dragState.currentSlot);
  const hi = Math.max(dragState.startSlot, dragState.currentSlot);
  document.querySelectorAll(`.slot-cell[data-date="${dragState.dateStr}"]`).forEach((cell) => {
    const s = Number(cell.dataset.slot);
    cell.classList.toggle('drag-preview', s >= lo && s <= hi);
    cell.classList.toggle('drag-remove', dragState.mode === 'remove' && s >= lo && s <= hi);
  });
}

function clearDragPreview() {
  document.querySelectorAll('.slot-cell.drag-preview').forEach((cell) => {
    cell.classList.remove('drag-preview', 'drag-remove');
  });
}

function setupDragHandlers() {
  document.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.slot-cell');
    if (!cell || cell.disabled) return;
    if (!state.selectedPersonId) return;
    const dateStr = cell.dataset.date;
    const slot = Number(cell.dataset.slot);
    const ids = state.availability[`${dateStr}_${slot}`] || [];
    const mode = ids.includes(state.selectedPersonId) ? 'remove' : 'add';
    dragState = { dateStr, startSlot: slot, currentSlot: slot, mode };
    applyDragPreview();
    e.preventDefault();
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest('.slot-cell');
    if (!cell || cell.dataset.date !== dragState.dateStr) return;
    dragState.currentSlot = Number(cell.dataset.slot);
    applyDragPreview();
  });

  const finishDrag = () => {
    if (!dragState) return;
    const { dateStr, startSlot, currentSlot, mode } = dragState;
    const lo = Math.min(startSlot, currentSlot);
    const hi = Math.max(startSlot, currentSlot);
    clearDragPreview();
    dragState = null;
    saveRange(dateStr, lo, hi + 1, mode);
  };
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
}

// ---------- Tab / 檢視模式 ----------
function switchTab(tab) {
  state.tab = tab;
  render();
}
function setViewMode(mode) {
  state.viewMode = mode;
  state.monthDrillDate = null;
  render();
}
function goPrev() {
  if (state.viewMode === 'week') state.anchorDate = addDays(state.anchorDate, -7);
  else if (state.viewMode === 'twoWeek') state.anchorDate = addDays(state.anchorDate, -14);
  else state.anchorDate = addMonths(state.anchorDate, -1);
  render();
}
function goNext() {
  if (state.viewMode === 'week') state.anchorDate = addDays(state.anchorDate, 7);
  else if (state.viewMode === 'twoWeek') state.anchorDate = addDays(state.anchorDate, 14);
  else state.anchorDate = addMonths(state.anchorDate, 1);
  render();
}
function drillIntoDate(dateStr) {
  state.monthDrillDate = dateStr;
  render();
}
function backToMonth() {
  state.monthDrillDate = null;
  render();
}
function scrollToHour(hour) {
  const el = document.getElementById('slotScroll');
  if (el) {
    const idx = slotToDisplayIndex(hour * 2);
    el.scrollTo({ top: idx * ROW_HEIGHT, behavior: 'smooth' });
  }
  document.querySelectorAll('.quick-jump').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.hour) === hour);
  });
}

// ---------- 可約時段 ----------
function computeMatches() {
  const byDate = {};
  Object.entries(state.availability).forEach(([key, ids]) => {
    if (!ids || ids.length === 0) return;
    const [dateStr, slotStr] = key.split('_');
    const slot = Number(slotStr);
    if (!byDate[dateStr]) byDate[dateStr] = [];
    byDate[dateStr].push({ slot, ids });
  });
  const ranges = [];
  Object.entries(byDate).forEach(([dateStr, slots]) => {
    slots.sort((a, b) => a.slot - b.slot);
    let cur = null;
    slots.forEach(({ slot, ids }) => {
      if (cur && cur.endSlot === slot && idsKey(cur.ids) === idsKey(ids)) {
        cur.endSlot = slot + 1;
      } else {
        if (cur) ranges.push(cur);
        cur = { dateStr, startSlot: slot, endSlot: slot + 1, ids: [...ids] };
      }
    });
    if (cur) ranges.push(cur);
  });
  const now = new Date();
  return ranges
    .filter((r) => r.ids.length >= MIN_OVERLAP)
    .filter((r) => slotEndDateTime(r.dateStr, r.endSlot) > now)
    .sort((a, b) => {
      const ak = `${a.dateStr}${String(a.startSlot).padStart(3, '0')}`;
      const bk = `${b.dateStr}${String(b.startSlot).padStart(3, '0')}`;
      return ak.localeCompare(bk);
    });
}

// ---------- 安排練習（草稿表單） ----------
function openDraft(dateStr, startSlot, endSlot, idsCsv) {
  const key = `${dateStr}_${startSlot}_${endSlot}`;
  if (state.draftKey === key) {
    state.draftKey = null;
    state.draft = null;
  } else {
    state.draftKey = key;
    state.draft = {
      dateStr,
      startSlot,
      endSlot,
      participantIds: new Set(idsCsv ? idsCsv.split(',') : []),
      note: '',
    };
  }
  render();
}
function toggleDraftParticipant(id) {
  if (!state.draft) return;
  if (state.draft.participantIds.has(id)) state.draft.participantIds.delete(id);
  else state.draft.participantIds.add(id);
  render();
}
function updateDraftField(field, value) {
  if (!state.draft) return;
  state.draft[field] = field === 'startSlot' || field === 'endSlot' ? Number(value) : value;
}
function cancelDraft() {
  state.draftKey = null;
  state.draft = null;
  render();
}
async function confirmSessionSave() {
  const d = state.draft;
  if (!d) return;
  if (d.endSlot <= d.startSlot) { showError('結束時間要晚於開始時間喔'); return; }
  if (d.participantIds.size === 0) { showError('至少要選一位參加者'); return; }
  try {
    const data = await apiPost('confirmSession', {
      dateStr: d.dateStr,
      startSlot: d.startSlot,
      endSlot: d.endSlot,
      participantIds: [...d.participantIds],
      note: d.note.trim(),
    });
    applyData(data);
  } catch (e) {
    showError('儲存練習時間失敗，請再試一次');
  }
  state.draftKey = null;
  state.draft = null;
  render();
}
async function deleteSessionById(id) {
  try {
    const data = await apiPost('deleteSession', { id });
    applyData(data);
  } catch (e) {
    showError('取消練習失敗，請再試一次');
  }
  render();
}

// ================= 畫面渲染 =================
function render() {
  document.getElementById('tabCalendarBtn').classList.toggle('active', state.tab === 'calendar');
  document.getElementById('tabMatchBtn').classList.toggle('active', state.tab === 'match');
  document.getElementById('calendarTab').style.display = state.tab === 'calendar' ? 'block' : 'none';
  document.getElementById('matchTab').style.display = state.tab === 'match' ? 'block' : 'none';

  if (state.tab === 'calendar') renderCalendarTab();
  else renderMatchTab();
}

function renderCalendarTab() {
  document.getElementById('noPeopleHint').style.display = state.people.length === 0 ? 'block' : 'none';
  document.getElementById('pickMeHint').style.display = state.people.length > 0 && !state.selectedPersonId ? 'block' : 'none';
  document.getElementById('peopleChips').innerHTML = state.people.map((p) => {
    const active = state.selectedPersonId === p.id;
    return `<button class="chip" style="background:${active ? p.color : '#fff'};color:${active ? '#fff' : 'var(--ink)'};box-shadow:0 0 0 2px ${active ? p.color : 'var(--border)'}" onclick="pickMe('${p.id}')">
      <span class="dot" style="background:${active ? '#fff' : p.color}"></span>${escapeHtml(p.name)}
    </button>`;
  }).join('');

  document.querySelectorAll('.viewmode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.viewMode);
  });

  document.getElementById('periodLabel').textContent = getPeriodLabel();

  const gridContainer = document.getElementById('gridContainer');
  const prevScrollEl = document.getElementById('slotScroll');
  const prevScrollTop = prevScrollEl ? prevScrollEl.scrollTop : null;
  if (state.viewMode === 'month') {
    if (state.monthDrillDate) {
      gridContainer.innerHTML = `
        <button class="back-btn" onclick="backToMonth()">‹ 返回月曆</button>
        ${slotGridHTML([parseDateStr(state.monthDrillDate)])}
      `;
    } else {
      gridContainer.innerHTML = monthGridHTML();
    }
  } else {
    gridContainer.innerHTML = slotGridHTML(getPeriodDates());
  }

  if (prevScrollTop !== null) {
    const newScrollEl = document.getElementById('slotScroll');
    if (newScrollEl) newScrollEl.scrollTop = prevScrollTop;
  }
}

function getPeriodDates() {
  if (state.viewMode === 'week') {
    const start = mondayOf(state.anchorDate);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  if (state.viewMode === 'twoWeek') {
    const start = mondayOf(state.anchorDate);
    return Array.from({ length: 14 }, (_, i) => addDays(start, i));
  }
  return [];
}

function getPeriodLabel() {
  if (state.viewMode === 'month') {
    return `${state.anchorDate.getFullYear()}年${state.anchorDate.getMonth() + 1}月`;
  }
  const dates = getPeriodDates();
  if (dates.length === 0) return '';
  return `${toShortDate(dates[0])} – ${toShortDate(dates[dates.length - 1])}`;
}

function slotGridHTML(dates) {
  const pMap = peopleById();
  const colW = dates.length <= 1 ? 260 : 54;
  const fitToScreen = dates.length === 7; // 一週檢視直接縮寬塞進畫面，不用橫向滑動
  const timeColWidth = fitToScreen ? 46 : 48;
  const quickJumps = QUICK_JUMPS.map((q) => `<button class="quick-jump" data-hour="${q.hour}" onclick="scrollToHour(${q.hour})">${q.label}</button>`).join('');

  const headerCells = dates.map((d) => {
    const wd = WEEKDAY_LABELS[(d.getDay() + 6) % 7];
    const dateStr = toDateStr(d);
    const isFullDay = state.selectedPersonId && Array.from({ length: VISIBLE_SLOT_COUNT }, (_, s) => VISIBLE_START_SLOT + s)
      .every((s) => (state.availability[`${dateStr}_${s}`] || []).includes(state.selectedPersonId));
    return `<div class="grid-head">
      <div class="grid-head-wd">週${wd}</div>
      <div class="grid-head-date">${toShortDate(d)}</div>
      <button class="fullday-btn ${isFullDay ? 'active' : ''}" ${state.selectedPersonId ? '' : 'disabled'} onclick="toggleFullDay('${dateStr}')">整天${isFullDay ? ' ✓' : ''}</button>
    </div>`;
  }).join('');

  let bodyRows = '';
  for (let i = 0; i < VISIBLE_SLOT_COUNT; i++) {
    const slot = VISIBLE_START_SLOT + i;
    const isHour = slot % 2 === 0;
    const displayHour = Math.floor(slot / 2);
    const displayMin = (slot % 2) * 30;
    const timeLabel = isHour ? `${String(displayHour).padStart(2, '0')}:${String(displayMin).padStart(2, '0')}` : '';
    const borderStyle = isHour ? '1.5px solid rgba(70,66,60,0.3)' : '1px solid rgba(70,66,60,0.12)';
    let rowCells = `<div class="time-label" style="height:${ROW_HEIGHT}px;border-top:${borderStyle}">${timeLabel}</div>`;
    dates.forEach((d) => {
      const dateStr = toDateStr(d);
      const key = `${dateStr}_${slot}`;
      const ids = state.availability[key] || [];
      const isMe = state.selectedPersonId && ids.includes(state.selectedPersonId);
      const session = state.sessions.find((s) => s.dateStr === dateStr && slot >= s.startSlot && slot < s.endSlot);
      let bg = 'transparent';
      if (session) bg = 'rgba(199,177,131,0.35)';
      else if (isMe) bg = `${pMap[state.selectedPersonId]?.color}22`;
      const marker = session && slot === session.startSlot ? '<span class="session-marker">🎯</span>' : '';
      const dots = ids.slice(0, 4).map((id) => `<span class="mini-dot" title="${escapeHtml(pMap[id]?.name || '')}" style="background:${pMap[id]?.color || '#ccc'}"></span>`).join('');
      const overflow = ids.length > 4 ? `<span class="overflow-count">+${ids.length - 4}</span>` : '';
      rowCells += `<button class="slot-cell" data-date="${dateStr}" data-slot="${slot}" style="height:${ROW_HEIGHT}px;border-top:${borderStyle};background:${bg}" ${state.selectedPersonId ? '' : 'disabled'}>${marker}${dots}${overflow}</button>`;
    });
    bodyRows += `<div class="grid-row" style="grid-template-columns:${timeColWidth}px repeat(${dates.length}, 1fr)">${rowCells}</div>`;
  }

  const wrapperStyle = fitToScreen ? 'width:100%' : `min-width:${48 + dates.length * colW}px`;

  return `
    <div class="grid-card">
      <div class="quick-jump-row">${quickJumps}</div>
      <div id="slotScroll" class="grid-scroll">
        <div style="${wrapperStyle}">
          <div class="grid-header-row" style="grid-template-columns:${timeColWidth}px repeat(${dates.length}, 1fr)">
            <div class="corner"></div>
            ${headerCells}
          </div>
          ${bodyRows}
        </div>
      </div>
    </div>
  `;
}

function monthGridHTML() {
  const pMap = peopleById();
  const first = new Date(state.anchorDate.getFullYear(), state.anchorDate.getMonth(), 1);
  const gridStart = mondayOf(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  const weekdayHeader = WEEKDAY_LABELS.map((w) => `<div class="month-wd">週${w}</div>`).join('');

  const cells = days.map((d) => {
    const dateStr = toDateStr(d);
    const isCurrentMonth = d.getMonth() === state.anchorDate.getMonth();
    const ids = new Set();
    Object.entries(state.availability).forEach(([key, arr]) => {
      if (key.startsWith(dateStr + '_')) arr.forEach((id) => ids.add(id));
    });
    const idsArr = [...ids];
    const hasSession = state.sessions.some((s) => s.dateStr === dateStr);
    const dots = idsArr.slice(0, 4).map((id) => `<span class="mini-dot" style="background:${pMap[id]?.color || '#ccc'}"></span>`).join('');
    const overflow = idsArr.length > 4 ? `<span class="overflow-count">+${idsArr.length - 4}</span>` : '';
    return `<button class="month-cell" style="opacity:${isCurrentMonth ? 1 : 0.35};box-shadow:${hasSession ? '0 0 0 2px var(--sand)' : 'none'}" onclick="drillIntoDate('${dateStr}')">
      <span class="month-date">${d.getDate()}</span>
      <div class="month-dots">${dots}${overflow}</div>
    </button>`;
  }).join('');

  return `
    <div class="grid-card month-card">
      <div class="month-weekday-row">${weekdayHeader}</div>
      <div class="month-cells">${cells}</div>
    </div>
  `;
}

function renderMatchTab() {
  const matches = computeMatches();
  const hasAnyAvailability = Object.keys(state.availability).length > 0;
  const pMap = peopleById();

  const listEl = document.getElementById('matchList');
  if (matches.length === 0) {
    listEl.innerHTML = `<p class="hint">${
      !hasAnyAvailability
        ? '還沒有人登記任何時段，先到「日曆登記」頁面填寫吧！'
        : '目前沒有重疊 2 人以上的未來時段。'
    }</p>`;
  } else {
    listEl.innerHTML = matches.map((row) => {
      const d = parseDateStr(row.dateStr);
      const wd = WEEKDAY_LABELS[(d.getDay() + 6) % 7];
      const key = `${row.dateStr}_${row.startSlot}_${row.endSlot}`;
      const isOpen = state.draftKey === key;
      const chips = row.ids.map((id) => `<span class="tag" style="background:${pMap[id]?.color || '#ccc'}">${escapeHtml(pMap[id]?.name || '未知')}</span>`).join('');

      let draftHTML = '';
      if (isOpen && state.draft) {
        const d0 = state.draft;
        const startOptions = Array.from({ length: VISIBLE_SLOT_COUNT }, (_, s) => VISIBLE_START_SLOT + s).map((s) => `<option value="${s}" ${d0.startSlot === s ? 'selected' : ''}>${slotToLabel(s)}</option>`).join('');
        const endOptions = Array.from({ length: VISIBLE_SLOT_COUNT }, (_, s) => VISIBLE_START_SLOT + s + 1).map((s) => `<option value="${s}" ${d0.endSlot === s ? 'selected' : ''}>${slotToLabel(s)}</option>`).join('');
        const participantChips = state.people.map((p) => {
          const checked = d0.participantIds.has(p.id);
          return `<button class="chip small" style="background:${checked ? p.color : '#fff'};color:${checked ? '#fff' : 'var(--ink)'};box-shadow:0 0 0 2px ${checked ? p.color : 'var(--border)'}" onclick="toggleDraftParticipant('${p.id}')">${checked ? '✓ ' : ''}${escapeHtml(p.name)}</button>`;
        }).join('');

        draftHTML = `
          <div class="draft-form">
            <div class="draft-row">
              <label>日期</label>
              <input type="date" value="${d0.dateStr}" oninput="updateDraftField('dateStr', this.value)" />
            </div>
            <div class="draft-row">
              <label>時間</label>
              <select onchange="updateDraftField('startSlot', this.value)">${startOptions}</select>
              <span class="to-label">到</span>
              <select onchange="updateDraftField('endSlot', this.value)">${endOptions}</select>
            </div>
            <div class="draft-row column">
              <label>參加者</label>
              <div class="chips-row">${participantChips}</div>
            </div>
            <input class="note-input" placeholder="備註（選填）" oninput="updateDraftField('note', this.value)" />
            <div class="draft-actions">
              <button class="btn-primary" onclick="confirmSessionSave()">確認練習時間</button>
              <button class="btn-text" onclick="cancelDraft()">取消</button>
            </div>
          </div>
        `;
      }

      return `
        <div class="match-card">
          <div class="match-card-header">
            <span class="match-title">${toShortDate(row.dateStr)}（週${wd}）${slotToLabel(row.startSlot)}–${slotToLabel(row.endSlot)}</span>
            <span class="match-count">${row.ids.length}人</span>
          </div>
          <div class="chips-row">${chips}</div>
          <button class="btn-schedule ${isOpen ? 'active' : ''}" onclick="openDraft('${row.dateStr}', ${row.startSlot}, ${row.endSlot}, '${row.ids.join(',')}')">🎯 安排練習</button>
          ${draftHTML}
        </div>
      `;
    }).join('');
  }

  const confirmedEl = document.getElementById('confirmedList');
  const sorted = [...state.sessions].sort((a, b) => {
    const ak = `${a.dateStr}${String(a.startSlot).padStart(3, '0')}`;
    const bk = `${b.dateStr}${String(b.startSlot).padStart(3, '0')}`;
    return ak.localeCompare(bk);
  });
  if (sorted.length === 0) {
    confirmedEl.innerHTML = `<p class="hint small">還沒有安排任何練習時間</p>`;
  } else {
    confirmedEl.innerHTML = sorted.map((s) => {
      const isPast = slotEndDateTime(s.dateStr, s.endSlot) <= new Date();
      const d = parseDateStr(s.dateStr);
      const wd = WEEKDAY_LABELS[(d.getDay() + 6) % 7];
      const chips = s.participantIds.map((id) => `<span class="tag small" style="background:${pMap[id]?.color || '#ccc'}">${escapeHtml(pMap[id]?.name || '未知')}</span>`).join('');
      return `
        <div class="session-card" style="opacity:${isPast ? 0.5 : 1}">
          <div class="session-info">
            <div class="session-time">${toShortDate(s.dateStr)}（週${wd}）${slotToLabel(s.startSlot)}–${slotToLabel(s.endSlot)}${isPast ? '<span class="past-label"> ・已過</span>' : ''}</div>
            <div class="chips-row">${chips}</div>
            ${s.note ? `<p class="session-note">${escapeHtml(s.note)}</p>` : ''}
          </div>
          <button class="btn-delete" onclick="deleteSessionById('${s.id}')">✕</button>
        </div>
      `;
    }).join('');
  }
}

init();
