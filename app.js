// ====== 設定：請把這行換成你自己的 Apps Script Web App 網址 ======
const API_BASE = 'https://script.google.com/macros/s/AKfycbwzaCtg5KK1Th923xFZGUuwyiai5Cn8yXSVFsERfRiUOtbrC8tvn-ek6QNZSSuAluKJXg/exec';
// =================================================================

const SLOTS_PER_DAY = 48; // 一天總共 48 個半小時格（內部仍以此為基準）
const VISIBLE_START_HOUR = 0; // 畫面顯示從這個時間開始（0 = 00:00），顯示全天
const VISIBLE_START_SLOT = VISIBLE_START_HOUR * 2;
const VISIBLE_SLOT_COUNT = SLOTS_PER_DAY - VISIBLE_START_SLOT; // 顯示到 24:00 為止
const OVERNIGHT_END_SLOT = 14; // 00:00-07:00 為「夜練／過夜」時段，超過這個 slot 就是一般時段
function getRowHeight() {
  return window.matchMedia('(max-width: 640px)').matches ? 30 : 40;
}
const MIN_OVERLAP = 2; // 至少幾人重疊才算「可約時段」
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const DAY_COLORS = ['#B08D82', '#8FA089', '#7B95AA', '#C4A265', '#9B84A8', '#5F8A82', '#A85D4D'];
const QUICK_JUMPS = [
  { label: '夜練', hour: 0 },
  { label: '早上', hour: 8 },
  { label: '下午', hour: 13 },
  { label: '晚上', hour: 18 },
];

const state = {
  loaded: false,
  people: [],
  availability: {},
  sessions: [],
  selectedPersonId: null,
  tab: localStorage.getItem('lastTab') || 'calendar',
  viewMode: 'week', // week | twoWeek | month
  anchorDate: new Date(),
  monthDrillDate: null,
  draftKey: null,
  draft: null,
  editSessionId: null,
  editDraft: null,
  pendingChanges: {}, // 拉選/點選後尚未儲存的變更，key: `${dateStr}_${slot}`, value: 'add' | 'remove'
  expandedMatchDays: new Set(), // 可約時段：展開的日期（預設空 = 全部收合）
  matchFilterOpen: false, // 篩選開關：是否顯示日期/時段/人數/成員這排下拉選項
  activeFilterPanel: null, // 目前展開哪個下拉篩選面板 null | 'date' | 'time' | 'people' | 'members'
  matchFilter: { dateFrom: '', dateTo: '', hourFrom: '', hourTo: '', minPeople: 2, memberIds: new Set() },
  expandedHistoryMonths: new Set(), // 已確認練習歷史紀錄：展開的月份（預設只展開最新月）
  historyDefaultApplied: false, // 是否已經套用過「預設展開最新月」，避免每次重繪都覆蓋使用者的收合操作
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
  setupDragHandlers();
  render(); // 先依記住的頁籤切換畫面，不用等資料抓完，避免閃過日曆頁
  await refreshAll();
}

async function refreshAll() {
  try {
    const data = await apiGetAll();
    applyData(data);
  } catch (e) {
    showError('讀取資料失敗，請確認 app.js 裡的 API_BASE 網址設定正確');
  }
  state.loaded = true;
  render();
}

async function pickMe(id) {
  closeSlotDetail();
  if (state.selectedPersonId === id) {
    // 再點一次自己的名字：取消選取，變成只能查看，不會誤觸時段
    state.selectedPersonId = null;
    render();
    return;
  }
  if (Object.keys(state.pendingChanges).length > 0 && state.selectedPersonId) {
    // 切換成別人之前，先把目前的暫存變更存起來，避免搞混是誰的時段
    await savePendingChanges();
  }
  state.selectedPersonId = id;
  render();
}

// ---------- 切換時段（含拉選，先暫存、按儲存才送出） ----------
let dragState = null; // { dateStr, startSlot, currentSlot, mode }

function personGlyph(name) {
  if (!name) return null;
  const match = name.match(/^(\p{Extended_Pictographic}\uFE0F?)/u);
  return match ? match[1] : null;
}
function personDotHTML(id, pMap, withTitle) {
  const p = pMap[id];
  const title = withTitle ? ` title="${escapeHtml(p?.name || '')}"` : '';
  const glyph = personGlyph(p?.name);
  if (glyph) {
    return `<span class="mini-emoji"${title}>${glyph}</span>`;
  }
  return `<span class="mini-dot"${title} style="background:${p?.color || '#ccc'}"></span>`;
}
function personInSlot(dateStr, slot) {
  const key = `${dateStr}_${slot}`;
  const base = (state.availability[key] || []).includes(state.selectedPersonId);
  const pending = state.pendingChanges[key];
  if (pending === 'add') return true;
  if (pending === 'remove') return false;
  return base;
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

async function savePendingChanges() {
  const entries = Object.entries(state.pendingChanges);
  if (entries.length === 0) return;
  const personId = state.selectedPersonId;
  const changes = entries.map(([key, mode]) => {
    const idx = key.lastIndexOf('_');
    return { dateStr: key.slice(0, idx), slot: Number(key.slice(idx + 1)), mode };
  });
  try {
    const data = await apiPost('applyChanges', { personId, changes });
    applyData(data);
  } catch (e) {
    showError('儲存時段失敗，請再試一次');
  }
  state.pendingChanges = {};
  render();
}

function discardPendingChanges() {
  state.pendingChanges = {};
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
    const mode = personInSlot(dateStr, slot) ? 'remove' : 'add';
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
    for (let s = lo; s <= hi; s++) {
      state.pendingChanges[`${dateStr}_${s}`] = mode;
    }
    render();
  };
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);

  // 沒有選人（純瀏覽）時，點格子改成顯示詳情，而不是登記時段
  document.addEventListener('click', (e) => {
    const popover = document.getElementById('slotDetailBar');
    if (popover.style.display !== 'none' && !popover.contains(e.target) && !e.target.closest('.slot-cell')) {
      closeSlotDetail();
      return;
    }
    if (state.selectedPersonId) return;
    const cell = e.target.closest('.slot-cell');
    if (!cell) return;
    showSlotDetail(cell.dataset.date, Number(cell.dataset.slot), cell);
  });
}

function closeSlotDetail() {
  document.getElementById('slotDetailBar').style.display = 'none';
}

function showSlotDetail(dateStr, slot, cellEl) {
  const pMap = peopleById();
  const ids = state.availability[`${dateStr}_${slot}`] || [];
  const session = state.sessions.find((s) => s.dateStr === dateStr && slot >= s.startSlot && slot < s.endSlot);
  const d = parseDateStr(dateStr);
  const wd = WEEKDAY_LABELS[(d.getDay() + 6) % 7];
  const timeLabel = `${toShortDate(dateStr)}（週${wd}）${slotToLabel(slot)}–${slotToLabel(slot + 1)}`;

  let html = `<div class="popover-time">${timeLabel}</div>`;

  if (session) {
    const sessionChips = session.participantIds.map((id) => `<span class="tag small" style="background:${pMap[id]?.color || '#ccc'}">${escapeHtml(pMap[id]?.name || '未知')}</span>`).join('');
    html += `
      <div class="popover-section popover-session">
        <div class="popover-label">🎯 已確認練習 ${slotToLabel(session.startSlot)}–${slotToLabel(session.endSlot)}</div>
        <div class="chips-row">${sessionChips}</div>
        ${session.note ? `<p class="session-note">${escapeHtml(session.note)}</p>` : ''}
      </div>
    `;
  }

  html += `
    <div class="popover-section">
      <div class="popover-label">登記有空</div>
      ${ids.length === 0
        ? `<p class="hint small popover-empty">目前沒有人登記</p>`
        : `<div class="chips-row">${ids.map((id) => `<span class="tag small" style="background:${pMap[id]?.color || '#ccc'}">${escapeHtml(pMap[id]?.name || '未知')}</span>`).join('')}</div>`}
    </div>
  `;

  document.getElementById('slotDetailText').innerHTML = html;
  positionPopoverNear(cellEl);
}

function positionPopoverNear(cellEl) {
  const popover = document.getElementById('slotDetailBar');
  popover.style.display = 'block';
  const margin = 8;
  const rect = cellEl.getBoundingClientRect();
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;

  let left = rect.left;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
  if (left < margin) left = margin;

  let top = rect.bottom + 6;
  if (top + ph > window.innerHeight - margin) top = rect.top - ph - 6;
  if (top < margin) top = margin;

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

// ---------- Tab / 檢視模式 ----------
function switchTab(tab) {
  state.tab = tab;
  localStorage.setItem('lastTab', tab);
  closeSlotDetail();
  state.activeFilterPanel = null;
  render();
}

// ---------- 可約時段：日期收合 / 篩選 ----------
function toggleMatchDay(dateStr) {
  if (state.expandedMatchDays.has(dateStr)) state.expandedMatchDays.delete(dateStr);
  else state.expandedMatchDays.add(dateStr);
  renderMatchTab();
}
function toggleMatchFilterBar() {
  state.matchFilterOpen = !state.matchFilterOpen;
  if (!state.matchFilterOpen) state.activeFilterPanel = null;
  renderMatchTab();
}
function openFilterPanel(type) {
  state.activeFilterPanel = state.activeFilterPanel === type ? null : type;
  renderMatchTab();
}
function updateMatchFilter(field, value) {
  state.matchFilter[field] = value;
  renderMatchTab();
}
function toggleMatchFilterMember(id) {
  if (state.matchFilter.memberIds.has(id)) state.matchFilter.memberIds.delete(id);
  else state.matchFilter.memberIds.add(id);
  renderMatchTab();
}
function resetMatchFilter() {
  state.matchFilter = { dateFrom: '', dateTo: '', hourFrom: '', hourTo: '', minPeople: 2, memberIds: new Set() };
  renderMatchTab();
}

// ---------- 已確認練習歷史紀錄：月份收合 ----------
function toggleHistoryMonth(key) {
  if (state.expandedHistoryMonths.has(key)) state.expandedHistoryMonths.delete(key);
  else state.expandedHistoryMonths.add(key);
  renderConfirmedTab();
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
    el.scrollTo({ top: idx * getRowHeight(), behavior: 'smooth' });
  }
  document.querySelectorAll('.quick-jump').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.hour) === hour);
  });
}

// ---------- 可約時段 ----------
function computeMatches(filter) {
  filter = filter || {};
  const byDate = {};
  Object.entries(state.availability).forEach(([key, ids]) => {
    if (!ids || ids.length === 0) return;
    const [dateStr, slotStr] = key.split('_');
    const slot = Number(slotStr);
    if (slot < VISIBLE_START_SLOT) return; // 排除畫面已隱藏的時段（例如改成 8 點開始前的舊資料）
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
  const minPeople = filter.minPeople || MIN_OVERLAP;
  const hourFromSlot = filter.hourFrom !== '' && filter.hourFrom != null ? Number(filter.hourFrom) * 2 : null;
  const hourToSlot = filter.hourTo !== '' && filter.hourTo != null ? Number(filter.hourTo) * 2 : null;
  return ranges
    .filter((r) => r.ids.length >= minPeople)
    .filter((r) => slotEndDateTime(r.dateStr, r.endSlot) > now)
    .filter((r) => !filter.dateFrom || r.dateStr >= filter.dateFrom)
    .filter((r) => !filter.dateTo || r.dateStr <= filter.dateTo)
    .filter((r) => hourFromSlot === null || r.endSlot > hourFromSlot)
    .filter((r) => hourToSlot === null || r.startSlot < hourToSlot)
    .filter((r) => !filter.memberIds || filter.memberIds.size === 0 || [...filter.memberIds].every((id) => r.ids.includes(id)))
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

function openSessionEdit(id) {
  if (state.editSessionId === id) {
    state.editSessionId = null;
    state.editDraft = null;
  } else {
    const s = state.sessions.find((s) => s.id === id);
    if (!s) return;
    state.editSessionId = id;
    state.editDraft = {
      dateStr: s.dateStr,
      startSlot: s.startSlot,
      endSlot: s.endSlot,
      participantIds: new Set(s.participantIds),
      note: s.note || '',
    };
  }
  render();
}
function toggleEditParticipant(id) {
  if (!state.editDraft) return;
  if (state.editDraft.participantIds.has(id)) state.editDraft.participantIds.delete(id);
  else state.editDraft.participantIds.add(id);
  render();
}
function updateEditField(field, value) {
  if (!state.editDraft) return;
  state.editDraft[field] = field === 'startSlot' || field === 'endSlot' ? Number(value) : value;
}
function cancelSessionEdit() {
  state.editSessionId = null;
  state.editDraft = null;
  render();
}
async function saveSessionEdit() {
  const d = state.editDraft;
  const id = state.editSessionId;
  if (!d || !id) return;
  if (d.endSlot <= d.startSlot) { showError('結束時間要晚於開始時間喔'); return; }
  if (d.participantIds.size === 0) { showError('至少要選一位參加者'); return; }
  try {
    const data = await apiPost('updateSession', {
      id,
      dateStr: d.dateStr,
      startSlot: d.startSlot,
      endSlot: d.endSlot,
      participantIds: [...d.participantIds],
      note: d.note.trim(),
    });
    applyData(data);
  } catch (e) {
    showError('更新練習時間失敗，請再試一次');
  }
  state.editSessionId = null;
  state.editDraft = null;
  render();
}

// ================= 畫面渲染 =================
function render() {
  document.getElementById('tabCalendarBtn').classList.toggle('active', state.tab === 'calendar');
  document.getElementById('tabMatchBtn').classList.toggle('active', state.tab === 'match');
  document.getElementById('tabConfirmedBtn').classList.toggle('active', state.tab === 'confirmed');
  document.getElementById('calendarTab').style.display = state.tab === 'calendar' ? 'block' : 'none';
  document.getElementById('matchTab').style.display = state.tab === 'match' ? 'block' : 'none';
  document.getElementById('confirmedTab').style.display = state.tab === 'confirmed' ? 'block' : 'none';

  const pendingCount = Object.keys(state.pendingChanges).length;
  const pendingBar = document.getElementById('pendingBar');
  pendingBar.style.display = pendingCount > 0 ? 'flex' : 'none';
  if (pendingCount > 0) {
    document.getElementById('pendingCount').textContent = `已選取 ${pendingCount} 個時段，尚未儲存`;
  }

  if (state.tab === 'calendar') renderCalendarTab();
  else if (state.tab === 'match') renderMatchTab();
  else renderConfirmedTab();
}

function renderCalendarTab() {
  document.getElementById('noPeopleHint').style.display = (state.loaded && state.people.length === 0) ? 'block' : 'none';
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
  const isNarrowScreen = window.matchMedia('(max-width: 640px)').matches;
  const colW = dates.length <= 1 ? (isNarrowScreen ? 260 : 320) : (isNarrowScreen ? 54 : 74);
  const fitToScreen = dates.length === 7; // 一週檢視直接縮寬塞進畫面，不用橫向滑動
  const timeColWidth = fitToScreen ? (isNarrowScreen ? 46 : 60) : (isNarrowScreen ? 48 : 58);
  const rowH = getRowHeight();
  const maxIcons = isNarrowScreen ? 2 : 5; // 電腦版空間夠，多顯示幾個 emoji 再用 +N
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
    if (slot === 0) {
      bodyRows += `<div class="section-divider">🌙 夜練／過夜</div>`;
    }
    if (slot === OVERNIGHT_END_SLOT) {
      bodyRows += `<div class="section-divider">☀️ 一般時段</div>`;
    }
    const isHour = slot % 2 === 0;
    const displayHour = Math.floor(slot / 2);
    const displayMin = (slot % 2) * 30;
    const timeLabel = isHour ? `${String(displayHour).padStart(2, '0')}:${String(displayMin).padStart(2, '0')}` : '';
    const borderStyle = isHour ? '1.5px solid rgba(70,66,60,0.3)' : '1px solid rgba(70,66,60,0.12)';
    let rowCells = `<div class="time-label" style="height:${rowH}px;border-top:${borderStyle}">${timeLabel}</div>`;
    dates.forEach((d) => {
      const dateStr = toDateStr(d);
      const key = `${dateStr}_${slot}`;
      const baseIds = state.availability[key] || [];
      const pendingMode = state.pendingChanges[key];
      let ids = baseIds;
      if (pendingMode === 'add' && state.selectedPersonId && !baseIds.includes(state.selectedPersonId)) {
        ids = [...baseIds, state.selectedPersonId];
      } else if (pendingMode === 'remove' && state.selectedPersonId) {
        ids = baseIds.filter((id) => id !== state.selectedPersonId);
      }
      const isMe = state.selectedPersonId && ids.includes(state.selectedPersonId);
      const session = state.sessions.find((s) => s.dateStr === dateStr && slot >= s.startSlot && slot < s.endSlot);
      let bg = 'transparent';
      if (session) bg = 'rgba(199,177,131,0.35)';
      else if (isMe) bg = `${pMap[state.selectedPersonId]?.color}22`;
      else if (slot < OVERNIGHT_END_SLOT) bg = 'rgba(91,120,150,0.07)';
      const marker = session && slot === session.startSlot ? '<span class="session-marker">🎯</span>' : '';
      const cellContent = ids.length === 0
        ? ''
        : ids.length <= maxIcons
          ? ids.map((id) => personDotHTML(id, pMap, true)).join('')
          : `${ids.slice(0, maxIcons).map((id) => personDotHTML(id, pMap, true)).join('')}<span class="overflow-count">+${ids.length - maxIcons}</span>`;
      const pendingClass = pendingMode ? 'pending-change' : '';
      rowCells += `<button class="slot-cell ${pendingClass}" data-date="${dateStr}" data-slot="${slot}" style="height:${rowH}px;border-top:${borderStyle};background:${bg}">${marker}${cellContent}</button>`;
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
      if (!key.startsWith(dateStr + '_')) return;
      const slot = Number(key.split('_')[1]);
      if (slot < VISIBLE_START_SLOT) return;
      arr.forEach((id) => ids.add(id));
    });
    const idsArr = [...ids];
    const hasSession = state.sessions.some((s) => s.dateStr === dateStr);
    const dots = idsArr.slice(0, 4).map((id) => personDotHTML(id, pMap, false)).join('');
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
  const matches = computeMatches(state.matchFilter);
  const hasAnyAvailability = Object.keys(state.availability).length > 0;
  const pMap = peopleById();
  const f = state.matchFilter;

  const isDateActive = !!(f.dateFrom || f.dateTo);
  const isTimeActive = f.hourFrom !== '' || f.hourTo !== '';
  const isPeopleActive = f.minPeople > 2;
  const isMembersActive = f.memberIds.size > 0;
  const anyActive = isDateActive || isTimeActive || isPeopleActive || isMembersActive;

  const dropdownHTML = (type, label, active) => {
    const isOpen = state.activeFilterPanel === type;
    let panelBody = '';
    if (type === 'date') {
      panelBody = `
        <div class="draft-row column">
          <label>從</label>
          <input type="date" value="${f.dateFrom}" onchange="updateMatchFilter('dateFrom', this.value)" />
        </div>
        <div class="draft-row column">
          <label>到</label>
          <input type="date" value="${f.dateTo}" onchange="updateMatchFilter('dateTo', this.value)" />
        </div>
      `;
    } else if (type === 'time') {
      const hourOptions = (selected) => Array.from({ length: 25 }, (_, h) => h)
        .map((h) => `<option value="${h}" ${Number(selected) === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
      panelBody = `
        <div class="draft-row column">
          <label>從</label>
          <select onchange="updateMatchFilter('hourFrom', this.value)"><option value="">不限</option>${hourOptions(f.hourFrom)}</select>
        </div>
        <div class="draft-row column">
          <label>到</label>
          <select onchange="updateMatchFilter('hourTo', this.value)"><option value="">不限</option>${hourOptions(f.hourTo)}</select>
        </div>
      `;
    } else if (type === 'people') {
      panelBody = `
        <div class="draft-row">
          <label>至少幾人</label>
          <div class="stepper">
            <button onclick="updateMatchFilter('minPeople', ${Math.max(2, f.minPeople - 1)})">−</button>
            <span>${f.minPeople}</span>
            <button onclick="updateMatchFilter('minPeople', ${f.minPeople + 1})">＋</button>
          </div>
        </div>
      `;
    } else if (type === 'members') {
      const chips = state.people.map((p) => {
        const checked = f.memberIds.has(p.id);
        return `<button class="chip small" style="background:${checked ? p.color : '#fff'};color:${checked ? '#fff' : 'var(--ink)'};box-shadow:0 0 0 2px ${checked ? p.color : 'var(--border)'}" onclick="toggleMatchFilterMember('${p.id}')">${checked ? '✓ ' : ''}${escapeHtml(p.name)}</button>`;
      }).join('');
      panelBody = `<div class="chips-row">${chips}</div><p class="hint small">只列出這些人都有空的時段</p>`;
    }
    return `
      <div class="filter-dropdown">
        <button class="filter-pill ${active ? 'active' : ''} ${isOpen ? 'open' : ''}" onclick="openFilterPanel('${type}')">${label} <span class="filter-pill-caret">${isOpen ? '▾' : '▸'}</span></button>
        ${isOpen ? `<div class="filter-dropdown-panel">${panelBody}</div>` : ''}
      </div>
    `;
  };

  const filterBarHTML = `
    <div class="match-filter-row">
      <button class="filter-toggle-main ${state.matchFilterOpen ? 'active' : ''}" onclick="toggleMatchFilterBar()">🔍 篩選</button>
      ${state.matchFilterOpen ? `
        <div class="filter-dropdown-group">
          ${dropdownHTML('date', '📅 日期', isDateActive)}
          ${dropdownHTML('time', '⏰ 時段', isTimeActive)}
          ${dropdownHTML('people', '👥 人數', isPeopleActive)}
          ${dropdownHTML('members', '🙋 成員', isMembersActive)}
          ${anyActive ? `<button class="filter-pill filter-clear" onclick="resetMatchFilter()">清除</button>` : ''}
        </div>
      ` : ''}
    </div>
  `;

  const listEl = document.getElementById('matchList');
  if (!state.loaded) {
    listEl.innerHTML = filterBarHTML + `<p class="hint">⏳ 讀取中…</p>`;
    return;
  }
  if (matches.length === 0) {
    listEl.innerHTML = filterBarHTML + `<p class="hint">${
      !hasAnyAvailability
        ? '還沒有人登記任何時段，先到「日曆登記」頁面填寫吧！'
        : '目前沒有符合條件的時段，試著調整篩選看看。'
    }</p>`;
    positionFilterDropdown();
    return;
  }

  // 依日期分組
  const groups = [];
  matches.forEach((row) => {
    let g = groups[groups.length - 1];
    if (!g || g.dateStr !== row.dateStr) {
      g = { dateStr: row.dateStr, rows: [] };
      groups.push(g);
    }
    g.rows.push(row);
  });

  const groupsHTML = groups.map((g, idx) => {
    const d = parseDateStr(g.dateStr);
    const wd = WEEKDAY_LABELS[(d.getDay() + 6) % 7];
    const expanded = state.expandedMatchDays.has(g.dateStr);
    const color = DAY_COLORS[idx % DAY_COLORS.length];
    return `
      <div class="match-day-group">
        <button class="match-day-header" style="border-left: 4px solid ${color}" onclick="toggleMatchDay('${g.dateStr}')">
          <span class="match-day-title">${toShortDate(g.dateStr)}（週${wd}）</span>
          <span class="match-day-count">${g.rows.length} 個時段</span>
          <span class="match-day-caret">${expanded ? '▾' : '▸'}</span>
        </button>
        ${expanded ? `<div class="match-day-body">${g.rows.map((row) => matchRowHTML(row, pMap)).join('')}</div>` : ''}
      </div>
    `;
  }).join('');

  listEl.innerHTML = filterBarHTML + groupsHTML;
  positionFilterDropdown();
}

function positionFilterDropdown() {
  const panel = document.querySelector('.filter-dropdown-panel');
  if (!panel) return;
  const wrapper = panel.closest('.filter-dropdown');
  const btn = wrapper ? wrapper.querySelector('.filter-pill') : null;
  if (!btn) return;
  const btnRect = btn.getBoundingClientRect();
  const panelWidth = panel.offsetWidth;
  let left = btnRect.left;
  if (left + panelWidth > window.innerWidth - 12) {
    left = window.innerWidth - panelWidth - 12;
  }
  if (left < 12) left = 12;
  panel.style.left = `${left}px`;
  panel.style.top = `${btnRect.bottom + 6}px`;
}

function matchRowHTML(row, pMap) {
  const key = `${row.dateStr}_${row.startSlot}_${row.endSlot}`;
  const isOpen = state.draftKey === key;
  const chips = row.ids.map((id) => `<span class="tag" style="background:${pMap[id]?.color || '#ccc'}">${escapeHtml(pMap[id]?.name || '未知')}</span>`).join('');
  const alreadyBooked = state.sessions.some((s) => s.dateStr === row.dateStr && row.startSlot < s.endSlot && row.endSlot > s.startSlot);

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
        <span class="match-title">${slotToLabel(row.startSlot)}–${slotToLabel(row.endSlot)}</span>
        <span class="match-count">${row.ids.length}人</span>
        <button class="btn-schedule ${isOpen ? 'active' : ''}" onclick="openDraft('${row.dateStr}', ${row.startSlot}, ${row.endSlot}, '${row.ids.join(',')}')">🎯 安排練習</button>
      </div>
      ${alreadyBooked ? `<div class="already-booked-badge">✅ 這個時段已經安排練習了</div>` : ''}
      <div class="chips-row">${chips}</div>
      ${draftHTML}
    </div>
  `;
}

function renderConfirmedTab() {
  const pMap = peopleById();
  const confirmedEl = document.getElementById('confirmedList');
  const now = new Date();
  const upcoming = state.sessions
    .filter((s) => slotEndDateTime(s.dateStr, s.endSlot) > now)
    .sort((a, b) => {
      const ak = `${a.dateStr}${String(a.startSlot).padStart(3, '0')}`;
      const bk = `${b.dateStr}${String(b.startSlot).padStart(3, '0')}`;
      return ak.localeCompare(bk);
    });
  const history = state.sessions
    .filter((s) => slotEndDateTime(s.dateStr, s.endSlot) <= now)
    .sort((a, b) => {
      const ak = `${a.dateStr}${String(a.startSlot).padStart(3, '0')}`;
      const bk = `${b.dateStr}${String(b.startSlot).padStart(3, '0')}`;
      return bk.localeCompare(ak); // 最近的歷史紀錄排前面
    });

  if (!state.loaded) {
    confirmedEl.innerHTML = `<p class="hint small">⏳ 讀取中…</p>`;
    return;
  }

  const upcomingHTML = upcoming.length === 0
    ? `<p class="hint small">目前沒有即將進行的練習</p>`
    : upcoming.map((s) => sessionCardHTML(s, pMap, false)).join('');

  let historyHTML;
  if (history.length === 0) {
    historyHTML = `<p class="hint small">還沒有歷史紀錄</p>`;
  } else {
    const monthGroups = [];
    history.forEach((s) => {
      const monthKey = s.dateStr.slice(0, 7); // "2026-07"
      let g = monthGroups[monthGroups.length - 1];
      if (!g || g.key !== monthKey) {
        g = { key: monthKey, sessions: [] };
        monthGroups.push(g);
      }
      g.sessions.push(s);
    });
    // 預設只展開最新一個月，且只套用「一次」，之後使用者收合/展開都不會再被覆蓋
    if (!state.historyDefaultApplied && monthGroups.length > 0) {
      state.expandedHistoryMonths.add(monthGroups[0].key);
      state.historyDefaultApplied = true;
    }
    historyHTML = monthGroups.map((g) => {
      const [y, m] = g.key.split('-');
      const expanded = state.expandedHistoryMonths.has(g.key);
      return `
        <div class="history-month-group">
          <button class="history-month-header" onclick="toggleHistoryMonth('${g.key}')">
            <span>${y}年${Number(m)}月</span>
            <span class="history-month-count">${g.sessions.length} 筆</span>
            <span class="match-day-caret">${expanded ? '▾' : '▸'}</span>
          </button>
          ${expanded ? `<div class="history-month-body">${g.sessions.map((s) => sessionCardHTML(s, pMap, true)).join('')}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  confirmedEl.innerHTML = `
    <p class="section-subtitle">🔜 即將進行</p>
    ${upcomingHTML}
    <p class="section-subtitle history-subtitle">🗂 歷史紀錄</p>
    ${historyHTML}
  `;
}

function sessionCardHTML(s, pMap, isPast) {
  const d = parseDateStr(s.dateStr);
  const wd = WEEKDAY_LABELS[(d.getDay() + 6) % 7];
  const chips = s.participantIds.map((id) => `<span class="tag small" style="background:${pMap[id]?.color || '#ccc'}">${escapeHtml(pMap[id]?.name || '未知')}</span>`).join('');
  const isEditing = state.editSessionId === s.id;

  let editHTML = '';
  if (isEditing && state.editDraft) {
    const d0 = state.editDraft;
    const startOptions = Array.from({ length: VISIBLE_SLOT_COUNT }, (_, i) => VISIBLE_START_SLOT + i).map((slot) => `<option value="${slot}" ${d0.startSlot === slot ? 'selected' : ''}>${slotToLabel(slot)}</option>`).join('');
    const endOptions = Array.from({ length: VISIBLE_SLOT_COUNT }, (_, i) => VISIBLE_START_SLOT + i + 1).map((slot) => `<option value="${slot}" ${d0.endSlot === slot ? 'selected' : ''}>${slotToLabel(slot)}</option>`).join('');
    const participantChips = state.people.map((p) => {
      const checked = d0.participantIds.has(p.id);
      return `<button class="chip small" style="background:${checked ? p.color : '#fff'};color:${checked ? '#fff' : 'var(--ink)'};box-shadow:0 0 0 2px ${checked ? p.color : 'var(--border)'}" onclick="toggleEditParticipant('${p.id}')">${checked ? '✓ ' : ''}${escapeHtml(p.name)}</button>`;
    }).join('');

    editHTML = `
      <div class="draft-form">
        <div class="draft-row">
          <label>日期</label>
          <input type="date" value="${d0.dateStr}" oninput="updateEditField('dateStr', this.value)" />
        </div>
        <div class="draft-row">
          <label>時間</label>
          <select onchange="updateEditField('startSlot', this.value)">${startOptions}</select>
          <span class="to-label">到</span>
          <select onchange="updateEditField('endSlot', this.value)">${endOptions}</select>
        </div>
        <div class="draft-row column">
          <label>參加者</label>
          <div class="chips-row">${participantChips}</div>
        </div>
        <input class="note-input" value="${escapeHtml(d0.note)}" placeholder="備註（選填）" oninput="updateEditField('note', this.value)" />
        <div class="draft-actions">
          <button class="btn-primary" onclick="saveSessionEdit()">儲存修改</button>
          <button class="btn-text" onclick="cancelSessionEdit()">取消</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="session-card-wrap" style="opacity:${isPast ? 0.6 : 1}">
      <div class="session-card">
        <div class="session-info">
          <div class="session-time">${toShortDate(s.dateStr)}（週${wd}）${slotToLabel(s.startSlot)}–${slotToLabel(s.endSlot)}</div>
          <div class="chips-row">${chips}</div>
          ${s.note ? `<p class="session-note">${escapeHtml(s.note)}</p>` : ''}
        </div>
        <div class="session-actions">
          <button class="btn-edit ${isEditing ? 'active' : ''}" onclick="openSessionEdit('${s.id}')">✏️</button>
          <button class="btn-delete" onclick="deleteSessionById('${s.id}')">✕</button>
        </div>
      </div>
      ${editHTML}
    </div>
  `;
}

init();
