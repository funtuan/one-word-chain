"use strict";

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    name: $("screen-name"),
    start: $("screen-start"),
    help: $("screen-help"),
    leaderboard: $("screen-leaderboard"),
    join: $("screen-join"),
    room: $("screen-room"),
    matching: $("screen-matching"),
    game: $("screen-game"),
  },
  nameTitle: $("name-title"),
  nameInput: $("name-input"),
  btnNameSave: $("btn-name-save"),
  btnNameCancel: $("btn-name-cancel"),
  acctExport: $("acct-export"),
  acctCode: $("acct-code"),
  btnCopyCode: $("btn-copy-code"),
  btnShowImport: $("btn-show-import"),
  acctImport: $("acct-import"),
  importCode: $("import-code"),
  importError: $("import-error"),
  btnImport: $("btn-import"),
  btnDeleteAccount: $("btn-delete-account"),
  playerBar: $("player-bar"),
  pbName: $("pb-name"),
  pbStats: $("pb-stats"),
  btnLeaderboard: $("btn-leaderboard"),
  btnLbBack: $("btn-lb-back"),
  lbList: $("lb-list"),
  lbMe: $("lb-me"),
  btnLeave: $("btn-leave"),
  btnPlay: $("btn-play"),
  btnCreateRoom: $("btn-create-room"),
  btnJoinRoom: $("btn-join-room"),
  btnHelp: $("btn-help"),
  btnHelpBack: $("btn-help-back"),
  btnHelpPlay: $("btn-help-play"),
  modeOpts: document.querySelectorAll(".mode-opt"),
  modeDesc: $("mode-desc"),
  btnDevilHelp: $("btn-devil-help"),
  helpDevil: $("help-devil"),
  // 加入房間
  btnJoinBack: $("btn-join-back"),
  joinCode: $("join-code"),
  joinError: $("join-error"),
  joinInfo: $("join-info"),
  jiMode: $("ji-mode"),
  jiPlayers: $("ji-players"),
  jiRule: $("ji-rule"),
  jiNote: $("ji-note"),
  btnJoinGo: $("btn-join-go"),
  // 等待室
  roomCode: $("room-code"),
  roomMode: $("room-mode"),
  roomRule: $("room-rule"),
  roomCount: $("room-count"),
  roomList: $("room-list"),
  roomHint: $("room-hint"),
  btnShareRoom: $("btn-share-room"),
  btnStartRoom: $("btn-start-room"),
  btnLeaveRoom: $("btn-leave-room"),
  matchingSub: $("matching-sub"),
  matchingInvite: $("matching-invite"),
  btnCopyLink: $("btn-copy-link"),
  btnCancelMatch: $("btn-cancel-match"),
  btnRetryMatch: $("btn-retry-match"),
  btnSound: $("btn-sound"),
  seats: $("seats"),
  roundBadge: $("round-badge"),
  restriction: $("restriction"),
  restrictionToast: $("restriction-toast"),
  matchingText: $("matching-text"),
  turnBadge: $("turn-badge"),
  timerBar: $("timer-bar"),
  timerText: $("timer-text"),
  timeoutFx: $("timeout-fx"),
  sentence: $("sentence"),
  hint: $("hint"),
  charInput: $("char-input"),
  btnSubmit: $("btn-submit"),
  btnChallenge: $("btn-challenge"),
  overlay: $("overlay"),
  ovTitle: $("ov-title"),
  ovBody: $("ov-body"),
  ovBtn: $("ov-btn"),
  ovBtn2: $("ov-btn2"),
};

const TURN_MS = 20000;
// 新增/開局限制時的提示彈窗阻擋緩衝（與後端一致）；此段時間後端已額外加進截止時間，不佔用 20 秒
const POPUP_MS = 3000;
// 超時額度：每人每場預設次數（與後端一致，僅供無資料時的顯示上限）
const TIMEOUT_QUOTA = 2;
const ROOM_CODE_LEN = 6;

const state = {
  ws: null,
  you: null, // 自己的座位（0..N-1）；null = 觀戰或未入局
  spectator: false,
  source: "match", // "match" 隨機配對 | "room" 好友房
  rule: { kind: "target", target: 5 },
  round: 0,
  seats: [], // SeatInfo[]：{ name, rating, connected, eliminated }
  scores: [],
  timeoutQuota: [],
  mode: "normal", // "normal" | "devil"
  menuMode: "normal", // 開始頁選單目前選的模式；進出好友房不會改到這個，離開房間時用它復原 state.mode
  room: null, // 等待室狀態（roomState 訊息）
  restrictions: [], // 惡魔模式目前生效的限制（隨字數累加）
  restrictionToastTimer: null, // 限制提示彈窗的自動關閉計時
  buffering: false, // 限制提示彈窗阻擋中（此時鎖住操作、計時顯示維持滿格）
  allowedPositions: null, // 位置限制：可放入位置；null 表示不限
  sentence: [],
  currentPlayer: null,
  canChallenge: false,
  selectedIndex: null,
  deadline: 0,
  status: "idle",
  timerRAF: null,
  resultTimer: null,
  timeoutFxTimer: null,
  gameId: null, // 目前對局 id（供斷線重連回同一場；好友房為 "room:房號"）
  reconnectTries: 0, // 斷線後已重連次數
  reconnectTimer: null, // onclose 排定的自動重連 timer（取消配對時要記得清掉）
  keepalive: null, // 保活計時器
  matching: false, // 是否正在（新的）配對等待中
  waitStart: 0, // 開始等待對手的時間戳
  waitTimer: null, // 配對等待秒數更新計時器
  wasMyTurn: false, // 上一次是否輪到自己（用來偵測「換我了」以發通知）
  lastMove: null, // 上一手（供挑戰提示顯示被挑戰的字）
  judgeTimer: null, // 挑戰評分的前端逾時保護
  iAmReady: false, // 結算停留階段我是否已按「準備好了」
  pendingJoinCode: null, // 從連結（?room=CODE）進來、待加入的房號
};

// 等待超過此秒數仍未配到人 -> 顯示「邀請朋友」提示
const INVITE_AFTER_MS = 15000;
// 挑戰評分逾時保護：超過此時間仍未收到結果 -> 視為連線異常，觸發重連
const JUDGE_TIMEOUT_MS = 20000;
const SOUND_KEY = "owc:sound"; // 音效開關（localStorage）
let soundEnabled = true;
let audioCtx = null;

const MODE_DESC = {
  normal: "一般規則，輪流一字接龍",
  devil: "回合開局 1 個限制，每接 5 個字再加 1 個（可同時多個），輪流一字接龍",
};
const MODE_LABEL = {
  normal: "😇 普通模式",
  devil: "😈 惡魔模式",
};

// ---------- 畫面切換 ----------
function show(name) {
  for (const k in el.screens) el.screens[k].classList.toggle("active", k === name);
}

// ---------- 身分（localStorage，無需登入）----------
const STORE_KEY = "owc:player";
const BACKUP_KEY = "owc:backupReminded"; // 是否已提醒過備份帳號代碼
const me = { id: null, name: null, stats: null };

function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.id) {
        me.id = p.id;
        me.name = p.name || null;
      }
    }
  } catch {}
  if (!me.id) me.id = genCode();
}

// 產生易讀的帳號代碼（去掉易混淆字元 0/O/1/I/L），代碼即帳號 id
function genCode() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  const n = 12;
  const bytes = new Uint8Array(n);
  if (crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return `OWC-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function saveIdentity() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ id: me.id, name: me.name }));
  } catch {}
}

// 向伺服器註冊／更新名稱，回傳最新戰績
async function register() {
  if (!me.id || !me.name) return;
  try {
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: me.id, name: me.name }),
    });
    if (res.ok) {
      me.stats = await res.json();
      renderPlayerBar();
    }
  } catch {}
}

function renderPlayerBar() {
  if (!me.name) {
    el.playerBar.hidden = true;
    return;
  }
  el.pbName.textContent = me.name;
  el.pbStats.textContent = me.stats
    ? `${me.stats.rating} 分 · ${me.stats.wins} 勝`
    : "";
  el.playerBar.hidden = false;
}

// ---------- 命名 ----------
function openNameScreen(editing) {
  el.nameTitle.textContent = editing ? "修改暱稱" : "取個暱稱";
  el.nameInput.value = me.name || "";
  el.btnNameSave.disabled = !el.nameInput.value.trim();
  el.btnNameSave.textContent = editing ? "儲存" : "開始遊戲";
  el.btnNameCancel.hidden = !editing;
  // 帳號代碼：已有帳號（設過名稱）才顯示「我的代碼」與「刪除帳號」
  el.acctExport.hidden = !me.name;
  el.btnDeleteAccount.hidden = !me.name;
  el.acctCode.textContent = accountCode();
  el.btnCopyCode.textContent = "複製";
  el.acctImport.hidden = true;
  el.importCode.value = "";
  el.btnImport.disabled = true;
  if (el.importError) el.importError.hidden = true;
  show("name");
  setTimeout(() => el.nameInput.focus(), 50);
}

// ---------- 帳號代碼（可攜到其他瀏覽器登入）----------
// 代碼即帳號 id，無需編解碼
function accountCode() {
  return me.id || "";
}

// 正規化輸入的代碼：OWC 代碼統一大寫；舊版 UUID 維持原樣
function normalizeCode(code) {
  const c = (code || "").trim();
  if (!c) return null;
  return /^owc-/i.test(c) ? c.toUpperCase() : c;
}

async function copyCode() {
  const code = accountCode();
  try {
    await navigator.clipboard.writeText(code);
    el.btnCopyCode.textContent = "已複製 ✓";
  } catch {
    // 退回：選取文字讓使用者手動複製
    const range = document.createRange();
    range.selectNodeContents(el.acctCode);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.btnCopyCode.textContent = "請手動複製";
  }
  setTimeout(() => (el.btnCopyCode.textContent = "複製"), 2000);
}

// 用代碼登入既有帳號：切換身分並從伺服器載入該帳號名稱
function showImportError(text) {
  el.importError.textContent = text;
  el.importError.hidden = false;
}
function hideImportError() {
  el.importError.hidden = true;
  el.importError.textContent = "";
}

async function importAccount() {
  const id = normalizeCode(el.importCode.value);
  hideImportError();
  if (!id) {
    showImportError("請貼上帳號代碼。");
    el.btnImport.disabled = true;
    return;
  }
  el.btnImport.disabled = true;
  el.btnImport.textContent = "登入中…";
  let stats = null;
  try {
    const res = await fetch("/api/player?id=" + encodeURIComponent(id));
    if (res.ok) stats = (await res.json()).player;
  } catch {}
  el.btnImport.textContent = "登入此帳號";
  el.btnImport.disabled = false;
  if (!stats) {
    // 不清空輸入，方便玩家修正打錯的字元（0/O、1/I 等易混）
    showImportError("找不到此帳號代碼對應的帳號，請確認後再試（注意 0/O、1/I/L 等易混字元）。");
    return;
  }
  // 覆蓋本機身分（原帳號等於登出）
  me.id = stats.id;
  me.name = stats.name;
  me.stats = stats;
  saveIdentity();
  renderPlayerBar();
  show("start");
  register();
}

// 登出帳號：清除本機資料、產生新 id，回到命名頁建立新帳號
function deleteAccount() {
  const ok = window.confirm(
    "確定登出此帳號嗎？\n本機將清除並建立全新帳號。若沒有備份「帳號代碼」，將無法再登入回此帳號。",
  );
  if (!ok) return;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {}
  me.id = null;
  me.name = null;
  me.stats = null;
  loadIdentity(); // 產生全新 id
  renderPlayerBar();
  openNameScreen(false);
}

async function saveName() {
  const name = el.nameInput.value.trim().slice(0, 20);
  if (!name) return;
  me.name = name;
  saveIdentity();
  renderPlayerBar();
  await register();
  // 從連結進來、還沒設暱稱的新玩家：命名完成後接回加入房間流程
  if (state.pendingJoinCode) {
    const code = state.pendingJoinCode;
    state.pendingJoinCode = null;
    openJoinScreen(code);
    return;
  }
  show("start");
}

// ---------- 排行榜 ----------
async function openLeaderboard() {
  show("leaderboard");
  el.lbList.innerHTML = `<div class="lb-empty">載入中…</div>`;
  el.lbMe.hidden = true;
  try {
    const q = me.id ? `&id=${encodeURIComponent(me.id)}` : "";
    const res = await fetch(`/api/leaderboard?limit=20${q}`);
    const { players, me: myRank } = await res.json();
    renderLeaderboard(players || []);
    renderLbMe(myRank, players || []);
  } catch {
    el.lbList.innerHTML = `<div class="lb-empty">載入失敗，請稍後再試</div>`;
  }
}

// 榜單底部固定顯示自己的名次；未上榜（沒場數）則提示去玩一場
function renderLbMe(myRank, players) {
  if (!me.name) {
    el.lbMe.hidden = true;
    return;
  }
  if (!myRank) {
    el.lbMe.hidden = false;
    el.lbMe.innerHTML = `<div class="lb-me-unranked">你還沒有排名，先完成一場對戰吧！</div>`;
    return;
  }
  el.lbMe.hidden = false;
  el.lbMe.innerHTML = `<div class="lb-row">
    <span class="lb-rank">${myRank.rank}</span>
    <span class="lb-name">${escapeHtml(myRank.name)}（你）</span>
    <span class="lb-rating">${myRank.rating}</span>
    <span class="lb-wins">${myRank.wins}</span>
  </div>`;
}

function renderLeaderboard(players) {
  if (!players.length) {
    el.lbList.innerHTML = `<div class="lb-empty">還沒有人上榜，快來成為第一名！</div>`;
    return;
  }
  el.lbList.innerHTML = players
    .map((p, i) => {
      const rank = i + 1;
      const cls = [
        "lb-row",
        rank <= 3 ? `top${rank}` : "",
        p.id === me.id ? "me" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<div class="${cls}">
        <span class="lb-rank">${rank}</span>
        <span class="lb-name">${escapeHtml(p.name)}</span>
        <span class="lb-rating">${p.rating}</span>
        <span class="lb-wins">${p.wins}</span>
      </div>`;
    })
    .join("");
}

// ---------- 配對 + 連線 ----------
// 記住目前這一場，讓斷線／重新整理後能連回同一個對局（而非配到全新的房）。
const ACTIVE_KEY = "owc:activeGame";
const RECONNECT_MAX = 4; // 斷線後最多重連次數
const RECONNECT_DELAY = 1000; // 每次重連間隔（ms）；也讓後端先把「斷線判負」結算完

function rememberGame(gameId, mode) {
  try {
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({ gameId, mode }));
  } catch {}
}
function forgetGame() {
  try {
    sessionStorage.removeItem(ACTIVE_KEY);
  } catch {}
}
function loadActiveGame() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function play() {
  if (!me.name) {
    openNameScreen(false);
    return;
  }
  ensureAudio(); // 藉此次點擊手勢初始化音效（瀏覽器自動播放限制）
  state.wasMyTurn = false;
  show("matching");
  state.matching = true;
  resetMatchingUi();
  el.matchingText.textContent = `${MODE_LABEL[state.mode]} · 配對中…`;
  try {
    const res = await fetch(`/api/matchmake?mode=${state.mode}`);
    const { gameId } = await res.json();
    connect(gameId);
  } catch (e) {
    state.matching = false;
    el.matchingText.textContent = "配對失敗，請重試";
    setTimeout(() => show("start"), 1500);
  }
}

// ---------- 好友房：開房 / 加入 / 等待室 ----------
async function createRoom() {
  if (!me.name) {
    openNameScreen(false);
    return;
  }
  ensureAudio();
  el.btnCreateRoom.disabled = true;
  el.btnCreateRoom.textContent = "建立中…";
  try {
    const res = await fetch("/api/room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: state.mode, playerId: me.id }),
    });
    if (!res.ok) throw new Error("create failed");
    const { code } = await res.json();
    connect(`room:${code}`);
  } catch {
    window.alert("建立房間失敗，請稍後再試");
  } finally {
    el.btnCreateRoom.disabled = false;
    el.btnCreateRoom.textContent = "🏠 開房間";
  }
}

function normalizeRoomCode(raw) {
  return (raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .slice(0, ROOM_CODE_LEN);
}

function openJoinScreen(prefill) {
  show("join");
  el.joinError.hidden = true;
  el.joinInfo.hidden = true;
  el.btnJoinGo.disabled = true;
  el.joinCode.value = prefill || "";
  if (prefill) {
    fetchJoinInfo();
  } else {
    setTimeout(() => el.joinCode.focus(), 50);
  }
}

let joinInfoSeq = 0; // 避免慢速回應覆蓋新輸入的查詢結果
async function fetchJoinInfo() {
  const code = normalizeRoomCode(el.joinCode.value);
  el.joinError.hidden = true;
  el.joinInfo.hidden = true;
  el.btnJoinGo.disabled = true;
  if (code.length !== ROOM_CODE_LEN) return;
  const seq = ++joinInfoSeq;
  let info = null;
  try {
    const res = await fetch(`/api/room/info?code=${encodeURIComponent(code)}`);
    if (res.ok) info = await res.json();
  } catch {}
  if (seq !== joinInfoSeq) return;
  if (!info || !info.ok) {
    el.joinError.textContent = "找不到這個房間，請確認房號（房間閒置過久會自動解散）。";
    el.joinError.hidden = false;
    return;
  }
  el.jiMode.textContent = MODE_LABEL[info.mode] || info.mode;
  el.jiPlayers.textContent = `${info.playerCount} / ${info.maxPlayers} 人`;
  el.jiRule.textContent = `共 ${info.rounds} 回合，總分排名（不計積分）`;
  let note = "";
  if (info.status !== "waiting") {
    note = "對局進行中，加入後先觀戰，下一場可入座。";
  } else if (info.playerCount >= info.maxPlayers) {
    note = "房間已滿，加入後為觀戰。";
  }
  el.jiNote.textContent = note;
  el.jiNote.hidden = !note;
  el.joinInfo.hidden = false;
  el.btnJoinGo.disabled = false;
}

function joinRoom() {
  const code = normalizeRoomCode(el.joinCode.value);
  if (code.length !== ROOM_CODE_LEN) return;
  ensureAudio();
  el.btnJoinGo.disabled = true;
  connect(`room:${code}`);
}

// 等待室渲染（roomState 訊息）
function renderRoomState() {
  const r = state.room;
  if (!r) return;
  el.roomCode.textContent = r.code;
  el.roomMode.textContent = MODE_LABEL[r.mode] || r.mode;
  const rounds = r.rule && r.rule.kind === "rounds" ? r.rule.rounds : 5;
  el.roomRule.textContent = `共 ${rounds} 回合，總分排名，不計積分`;
  el.roomCount.textContent = `${r.players.length}/${r.maxPlayers}`;
  el.roomList.innerHTML = r.players
    .map((p, i) => {
      const cls = ["rp-row", i === r.you ? "me" : "", p.connected ? "" : "off"]
        .filter(Boolean)
        .join(" ");
      const tags = [
        p.host ? `<span class="rp-tag host">👑 房主</span>` : "",
        i === r.you ? `<span class="rp-tag you">你</span>` : "",
        p.connected ? "" : `<span class="rp-tag off">斷線</span>`,
      ].join("");
      return `<div class="${cls}"><span class="rp-name">${escapeHtml(p.name)}</span>${tags}</div>`;
    })
    .join("");

  const isSpec = r.you === null;
  el.btnStartRoom.hidden = !r.isHost;
  if (r.isHost) {
    const enough = r.players.length >= r.minPlayers;
    el.btnStartRoom.disabled = !enough;
    el.btnStartRoom.textContent = enough
      ? `開始遊戲（${r.players.length} 人）`
      : `開始遊戲（至少 ${r.minPlayers} 人）`;
  }
  const hostEntry = r.players.find((p) => p.host);
  if (hostEntry && !hostEntry.connected) {
    el.roomHint.textContent = "房主連線中斷，等待重新連線…（逾時房間會自動解散）";
  } else if (isSpec) {
    el.roomHint.textContent = "房間已滿，你目前是觀戰者；下一場開打前有空位就能入座。";
  } else if (r.isHost) {
    el.roomHint.textContent =
      r.players.length < r.minPlayers
        ? "把邀請連結傳給好友，人到齊就能開始！"
        : "人到齊了就按「開始遊戲」！";
  } else {
    el.roomHint.textContent = "等待房主開始遊戲…";
  }
}

// 邀請連結：手機優先用系統分享，桌面複製到剪貼簿
async function shareRoomLink() {
  const code = state.room ? state.room.code : null;
  if (!code) return;
  const link = `${location.origin}/?room=${code}`;
  const text = `來玩一字接龍！房號 ${code}，點連結加入：`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "一字接龍", text, url: link });
      return;
    } catch {
      /* 使用者取消分享 -> 落回複製 */
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    el.btnShareRoom.textContent = "已複製 ✓";
  } catch {
    el.btnShareRoom.textContent = link;
  }
  setTimeout(() => (el.btnShareRoom.textContent = "📋 複製邀請連結"), 2000);
}

// 離開等待室（房主離開 = 解散房間）
function leaveRoom() {
  if (state.room && state.room.isHost && state.room.players.length > 1) {
    const ok = window.confirm("你是房主，離開後房間會解散，確定嗎？");
    if (!ok) return;
  }
  send({ type: "leave" });
  resetGameState();
  show("start");
}

// 房主按「開始遊戲」
function startRoom() {
  send({ type: "startRoom" });
  el.btnStartRoom.disabled = true;
}

// 重置配對畫面的附屬元件（秒數、邀請提示）到初始狀態
function resetMatchingUi() {
  stopWaitTimer();
  el.matchingSub.hidden = true;
  el.matchingSub.textContent = "";
  el.matchingInvite.hidden = true;
  el.btnCancelMatch.hidden = false;
}

// 開始更新「已等待 N 秒」；等待夠久顯示邀請朋友提示
function startWaitTimer() {
  stopWaitTimer();
  state.waitStart = Date.now();
  el.matchingSub.hidden = false;
  const tick = () => {
    const sec = Math.floor((Date.now() - state.waitStart) / 1000);
    el.matchingSub.textContent = `已等待 ${sec} 秒…`;
    if (Date.now() - state.waitStart >= INVITE_AFTER_MS) {
      el.matchingInvite.hidden = false;
    }
  };
  tick();
  state.waitTimer = setInterval(tick, 1000);
}

function stopWaitTimer() {
  clearInterval(state.waitTimer);
  state.waitTimer = null;
}

// 取消配對：關閉連線、通知 Lobby 清掉自己建立的等待房，回到開始頁
function cancelMatch() {
  const gameId = state.gameId;
  const mode = state.mode;
  state.matching = false;
  state.status = "idle"; // 否則計時器 rAF 迴圈會判斷仍在 playing/sent 而永遠繼續跑
  cancelAnimationFrame(state.timerRAF);
  stopWaitTimer();
  clearInterval(state.keepalive);
  clearTimeout(state.reconnectTimer); // 避免 onclose 排定的自動重連稍後還打開一條新連線
  state.gameId = null;
  forgetGame();
  if (state.ws) {
    try {
      state.ws.onclose = null; // 避免觸發自動重連
      state.ws.close();
    } catch {}
    state.ws = null;
  }
  el.btnRetryMatch.hidden = true;
  if (gameId && !gameId.startsWith("room:")) {
    fetch(
      `/api/cancel?mode=${mode}&gameId=${encodeURIComponent(gameId)}`,
    ).catch(() => {});
  }
  show("start");
}

// 重連用盡後，玩家手動重試連回同一場
function retryConnect() {
  if (!state.gameId) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTries = 0;
  el.btnRetryMatch.hidden = true;
  el.matchingText.textContent = "重新連線中…";
  connect(state.gameId);
}

async function copyGameLink() {
  const link = location.origin + location.pathname;
  try {
    await navigator.clipboard.writeText(link);
    el.btnCopyLink.textContent = "已複製 ✓";
  } catch {
    el.btnCopyLink.textContent = link;
  }
  setTimeout(() => (el.btnCopyLink.textContent = "複製遊戲連結"), 2000);
}

function connect(gameId) {
  state.gameId = gameId;
  rememberGame(gameId, state.mode);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({
    mode: state.mode,
    playerId: me.id || "",
    name: me.name || "",
  });
  const ws = new WebSocket(
    `${proto}://${location.host}/game/${gameId}/ws?${q}`,
  );
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectTries = 0;
    el.btnRetryMatch.hidden = true;
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle(msg);
  };
  ws.onclose = () => {
    clearInterval(state.keepalive);
    if (state.status === "over") return;
    // 結算彈窗（挑戰中／回合結算）可能還開著：先關掉，否則它會蓋住底下的配對／
    // 重試畫面，尤其「挑戰中」畫面完全沒有按鈕，會把玩家卡死在看不到出口的地方。
    hideOverlay();
    // 進入重連流程：關掉主動配對的等待秒數／邀請提示
    state.matching = false;
    stopWaitTimer();
    el.matchingSub.hidden = true;
    el.matchingInvite.hidden = true;
    // 非正常中斷：嘗試連回同一場（好友房有重連寬限；隨機配對取回敗北結果）
    if ((state.reconnectTries || 0) < RECONNECT_MAX && state.gameId) {
      state.reconnectTries = (state.reconnectTries || 0) + 1;
      show("matching");
      el.btnCancelMatch.hidden = false;
      el.btnRetryMatch.hidden = true;
      el.matchingText.textContent = "連線中斷，重新連線中…";
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => connect(state.gameId), RECONNECT_DELAY);
    } else {
      // 重連用盡：提供「重試」與「取消」兩個出口，不再停在死畫面
      el.matchingText.textContent = "連線中斷";
      el.btnRetryMatch.hidden = !state.gameId;
      el.btnCancelMatch.hidden = false;
    }
  };
  ws.onerror = () => {};

  // 保活
  clearInterval(state.keepalive);
  state.keepalive = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
  }, 15000);
}

function send(obj) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify(obj));
  }
}

// ---------- 訊息處理 ----------
function handle(msg) {
  switch (msg.type) {
    case "waiting":
      el.matchingText.textContent = "等待對手加入…";
      show("matching");
      // 只有主動配對（非斷線重連）時才顯示等待秒數與邀請提示
      if (state.matching) startWaitTimer();
      break;
    case "roomState":
      showRoomState(msg);
      break;
    case "roomClosed":
      showRoomClosed(msg);
      break;
    case "start":
      state.matching = false;
      stopWaitTimer();
      state.you = msg.you;
      state.spectator = msg.you === null;
      state.source = msg.source;
      state.rule = msg.rule;
      state.round = msg.round;
      state.seats = msg.seats;
      state.mode = msg.mode;
      hideOverlay();
      hideRestrictionToast(); // 清掉上一回合可能殘留的緩衝狀態
      applyRound(msg);
      show("game");
      // 回合開局：跳出本回合起始限制的提示彈窗（阻擋 3 秒）
      if (state.restrictions.length && !msg.lastMove) {
        showRestrictionToast(state.restrictions, true);
      }
      break;
    case "update":
      applyRound(msg);
      break;
    case "timeoutExtend":
      showTimeoutExtend(msg);
      break;
    case "timeoutSkip":
      showTimeoutSkip(msg);
      break;
    case "presence":
      state.seats = msg.seats;
      renderSeats();
      break;
    case "judging":
      showJudging(msg);
      break;
    case "settled":
      showSettled(msg);
      break;
    case "readyState":
      showReadyState(msg);
      break;
    case "gameover":
      showGameover(msg);
      break;
    case "error":
      // 送出被伺服器拒絕（例如非中文字）時，回到可操作狀態，讓玩家改字或挑戰
      if (state.status === "sent") {
        state.status = "playing";
        updateControls();
      }
      flashHint(msg.message);
      break;
  }
}

// 進等待室（開房、加入、rematch 重置都走這裡）
function showRoomState(msg) {
  state.matching = false;
  stopWaitTimer();
  state.room = msg;
  state.source = "room";
  state.mode = msg.mode;
  state.you = msg.you;
  state.spectator = msg.you === null;
  state.status = "room";
  state.iAmReady = false;
  hideOverlay();
  hideRestrictionToast();
  cancelAnimationFrame(state.timerRAF);
  document.title = BASE_TITLE;
  renderRoomState();
  show("room");
}

function showRoomClosed(msg) {
  const text =
    msg.reason === "host_left" ? "房主已離開，房間解散" : "房間閒置過久，已自動解散";
  state.status = "idle";
  forgetGame();
  if (state.ws) {
    try {
      state.ws.onclose = null;
      state.ws.close();
    } catch {}
    state.ws = null;
  }
  resetGameState();
  show("start");
  window.alert(text);
}

function applyRound(msg) {
  clearJudgeTimer(); // 進入新回合狀態，解除評分逾時保護
  state.iAmReady = false;
  state.sentence = msg.sentence;
  state.currentPlayer = msg.currentPlayer;
  state.canChallenge = msg.canChallenge;
  state.lastMove = msg.lastMove || null;
  state.deadline = msg.deadline;
  state.scores = msg.scores;
  state.allowedPositions =
    msg.allowedPositions === undefined ? null : msg.allowedPositions;
  if (Array.isArray(msg.restrictions)) state.restrictions = msg.restrictions;
  renderRestriction();
  // update 訊息夾帶本次新增的限制 -> 跳提示彈窗（3 秒）
  if (msg.type === "update" && msg.newRestrictions && msg.newRestrictions.length) {
    showRestrictionToast(msg.newRestrictions, false);
  }
  state.status = "playing";
  state.selectedIndex = null;
  el.charInput.value = "";

  if (msg.timeoutQuota) state.timeoutQuota = msg.timeoutQuota;
  renderSeats();
  renderRoundBadge();
  renderSentence(msg.lastMove);
  updateControls();
  startTimer();
  notifyTurnChange();
}

// ---------- 記分板（N 人座位列表） ----------
function quotaPipsHtml(left) {
  const remain = Math.max(0, Math.min(TIMEOUT_QUOTA, left ?? TIMEOUT_QUOTA));
  let pips = "";
  for (let i = 0; i < TIMEOUT_QUOTA; i++) {
    pips += `<span class="pip${i < remain ? "" : " used"}"></span>`;
  }
  return `<span class="quota-ico">⏳</span>${pips}`;
}

function renderSeats() {
  if (!state.seats.length) {
    el.seats.innerHTML = "";
    return;
  }
  el.seats.classList.toggle("many", state.seats.length > 3);
  el.seats.innerHTML = state.seats
    .map((sk, i) => {
      const cls = ["seat-card"];
      if (i === state.you) cls.push("me");
      if (i === state.currentPlayer && state.status !== "over") cls.push("turn");
      if (sk.eliminated) cls.push("out");
      else if (!sk.connected) cls.push("offline");
      const name = i === state.you ? "你" : escapeHtml(sk.name);
      const tag = sk.eliminated
        ? `<span class="sc-tag out">出局</span>`
        : !sk.connected
          ? `<span class="sc-tag off">斷線</span>`
          : "";
      const elo =
        state.source === "match" && sk.rating != null
          ? `<span class="sc-elo">${sk.rating} 分</span>`
          : "";
      return `<div class="${cls.join(" ")}">
        <span class="sc-name" title="${escapeHtml(sk.name)}">${name}${tag}</span>
        <span class="sc-num">${state.scores[i] ?? 0}</span>
        ${elo}
        <span class="quota" data-seat="${i}" title="超時額度">${quotaPipsHtml(state.timeoutQuota[i])}</span>
      </div>`;
    })
    .join("");
}

function renderRoundBadge() {
  if (state.rule && state.rule.kind === "rounds") {
    el.roundBadge.textContent = `第 ${state.round} / ${state.rule.rounds} 回合`;
    el.roundBadge.hidden = false;
  } else {
    el.roundBadge.hidden = true;
  }
}

// ---------- 換我了：震動 / 音效 / 分頁標題提示 ----------
const BASE_TITLE = "一字接龍";
function notifyTurnChange() {
  const myTurn =
    state.you !== null &&
    state.currentPlayer === state.you &&
    state.status === "playing";
  if (myTurn && !state.wasMyTurn && !state.buffering) {
    // 剛換成我的回合：提醒玩家（背景分頁也不會錯過）
    try {
      navigator.vibrate && navigator.vibrate(80);
    } catch {}
    playBeep();
    if (document.hidden) document.title = "🔔 輪到你了 – " + BASE_TITLE;
  }
  if (!myTurn) document.title = BASE_TITLE;
  state.wasMyTurn = myTurn;
}

// ---------- 音效（WebAudio 短音，可開關）----------
function loadSound() {
  try {
    soundEnabled = localStorage.getItem(SOUND_KEY) !== "off";
  } catch {}
}
function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {}
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}
function playBeep() {
  if (!soundEnabled || !audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.26);
  } catch {}
}
function renderSoundToggle() {
  if (!el.btnSound) return;
  el.btnSound.textContent = soundEnabled ? "🔔 音效：開" : "🔕 音效：關";
}
function toggleSound() {
  soundEnabled = !soundEnabled;
  try {
    localStorage.setItem(SOUND_KEY, soundEnabled ? "on" : "off");
  } catch {}
  renderSoundToggle();
  if (soundEnabled) {
    ensureAudio();
    playBeep();
  }
}

function clearJudgeTimer() {
  clearTimeout(state.judgeTimer);
  state.judgeTimer = null;
}

// ---------- 超時 ----------
// 超時用掉一次額度：更新顯示、延長計時，並播放小動畫（不搶畫面）。
function showTimeoutExtend(msg) {
  if (msg.timeoutQuota) state.timeoutQuota = msg.timeoutQuota;
  renderSeats();
  state.deadline = msg.deadline;
  if (state.status === "playing" || state.status === "sent") startTimer();

  const mine = msg.player === state.you;
  // 被用掉額度的那一方，其額度指示器輕微脈動一下
  const node = el.seats.querySelector(`.quota[data-seat="${msg.player}"]`);
  if (node) {
    node.classList.remove("pulse");
    void node.offsetWidth; // 強制 reflow 以重播動畫
    node.classList.add("pulse");
  }
  showTimeoutFx(mine ? "超時 +10 秒" : `${seatName(msg.player)} 超時 +10 秒`);
}

// 好友房：超時無額度被跳過（3 人以上在局），輪到下一位
function showTimeoutSkip(msg) {
  if (msg.timeoutQuota) state.timeoutQuota = msg.timeoutQuota;
  state.currentPlayer = msg.currentPlayer;
  state.canChallenge = msg.canChallenge;
  state.deadline = msg.deadline;
  state.selectedIndex = null;
  renderSeats();
  renderSentence(state.lastMove);
  updateControls();
  if (state.status === "playing" || state.status === "sent") {
    state.status = "playing";
    startTimer();
  }
  const mine = msg.player === state.you;
  showTimeoutFx(mine ? "你超時了，本回合跳過" : `${seatName(msg.player)} 超時跳過`);
  notifyTurnChange();
}

// 計時列上方浮出的小提示
function showTimeoutFx(text) {
  const fx = el.timeoutFx;
  if (!fx) return;
  fx.textContent = text;
  fx.hidden = false;
  fx.classList.remove("show");
  void fx.offsetWidth;
  fx.classList.add("show");
  clearTimeout(state.timeoutFxTimer);
  state.timeoutFxTimer = setTimeout(() => {
    fx.classList.remove("show");
    fx.hidden = true;
  }, 1600);
}

// ---------- 句子渲染 ----------
function renderSentence(lastMove) {
  const myTurn = state.you !== null && state.currentPlayer === state.you;
  el.sentence.innerHTML = "";
  const chars = state.sentence;

  // 放入預覽：選好位置且已輸入合法字時，在該位置以半透明「幽靈字」顯示
  const preview = myTurn ? previewChar() : "";

  const allowed = state.allowedPositions;
  const addSlot = (index) => {
    const slot = document.createElement("div");
    slot.className = "slot";
    // 位置限制：不在開放清單的位置變成鎖住、不可點
    const locked = allowed !== null && !allowed.includes(index);
    if (locked) slot.classList.add("locked");
    // 只要輪到我且位置未鎖就綁定點擊事件；緩衝（限制提示彈窗）期間由 selectSlot
    // 的 buffering 判斷擋下、且彈窗遮罩本身也會吃掉點擊。
    if (myTurn && !locked) {
      slot.classList.add("tappable");
      if (state.selectedIndex === index) slot.classList.add("selected");
      slot.addEventListener("click", () => selectSlot(index));
    }
    el.sentence.appendChild(slot);
    // 幽靈字：緊接在被選中的位置後方
    if (preview && state.selectedIndex === index) {
      const g = document.createElement("span");
      g.className = "char ghost";
      g.textContent = preview;
      el.sentence.appendChild(g);
    }
  };

  addSlot(0);
  for (let i = 0; i < chars.length; i++) {
    const c = document.createElement("span");
    c.className = "char";
    if (lastMove && lastMove.index === i) c.classList.add("latest");
    c.textContent = chars[i];
    el.sentence.appendChild(c);
    addSlot(i + 1);
  }
}

// ---------- 惡魔模式限制橫幅 ----------
// 單一限制的說明 HTML（標籤 + 文字），供橫幅與提示彈窗共用
function restrictionHtml(r) {
  if (!r) return "";
  if (r.kind === "position") {
    return `<span class="r-tag">😈 位置限制</span><span class="r-text">每回合只開放一半的放入位置（最多 5 個），鎖住的位置不能點。</span>`;
  }
  if (r.kind === "zhuyin") {
    const finals = (r.finals || [])
      .map((f) => `<b class="r-final">${escapeHtml(f)}</b>`)
      .join(" ");
    return `<span class="r-tag">😈 注音限制</span><span class="r-text">放入的字字韻母須為 ${finals}，不符合對手 +3 分。</span>`;
  }
  if (r.kind === "pos" && r.pos) {
    return `<span class="r-tag">😈 詞性限制</span><span class="r-text">放入的字不可是 <b class="r-final">${escapeHtml(r.pos)}</b>，違規對手 +3 分。</span>`;
  }
  if (r.kind === "meaning") {
    return `<span class="r-tag">😈 意思改變限制</span><span class="r-text">放入的字必須讓句子的<b class="r-final">含義改變</b>，沒有改變對手 +3 分。</span>`;
  }
  if (r.kind === "noboring") {
    return `<span class="r-tag">😈 別太無聊限制</span><span class="r-text">不可放入無聊字：<b class="r-final">人稱代名詞</b>（你我他…）、<b class="r-final">語氣感嘆詞</b>（嗎吧啊哈呢啦…）、<b class="r-final">親屬稱謂</b>（爸媽叔姨…），違規對手 +3 分。</span>`;
  }
  return "";
}

function renderRestriction() {
  const rs = state.restrictions || [];
  if (!rs.length) {
    el.restriction.hidden = true;
    el.restriction.innerHTML = "";
    return;
  }
  el.restriction.innerHTML = rs
    .map((r) => `<div class="r-item">${restrictionHtml(r)}</div>`)
    .join("");
  el.restriction.hidden = false;
}

// ---------- 限制提示彈窗（阻擋式，3 秒後自動消失）----------
// 阻擋期間鎖住操作；後端已把這 3 秒額外加到回合截止時間，故不佔用玩家的 20 秒。
// opening=true：回合開局的起始限制；false：回合中新增的限制
function showRestrictionToast(restrictions, opening) {
  const node = el.restrictionToast;
  if (!node || !restrictions || !restrictions.length) return;
  const title = opening ? "😈 本回合限制" : "😈 新增限制！";
  const body = restrictions
    .map((r) => `<div class="r-item">${restrictionHtml(r)}</div>`)
    .join("");
  node.innerHTML = `<div class="r-toast-card"><div class="rt-title">${title}</div>${body}<div class="rt-count"><div class="rt-count-bar"></div></div><div class="rt-dismiss">點擊任意處關閉</div></div>`;
  node.hidden = false;
  node.classList.remove("show");
  void node.offsetWidth; // 強制 reflow 以重播動畫
  node.classList.add("show");

  // 阻擋：鎖住操作、計時顯示維持滿格
  state.buffering = true;
  updateControls();
  startTimer();

  // 倒數進度條（3 秒歸零）
  const bar = node.querySelector(".rt-count-bar");
  if (bar) {
    bar.style.transition = "none";
    bar.style.width = "100%";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bar.style.transition = `width ${POPUP_MS}ms linear`;
        bar.style.width = "0%";
      });
    });
  }

  clearTimeout(state.restrictionToastTimer);
  state.restrictionToastTimer = setTimeout(() => {
    hideRestrictionToast();
  }, POPUP_MS);
}

// 關閉限制提示彈窗並解除阻擋
function hideRestrictionToast() {
  clearTimeout(state.restrictionToastTimer);
  const node = el.restrictionToast;
  if (node) {
    node.classList.remove("show");
    node.hidden = true;
  }
  if (state.buffering) {
    state.buffering = false;
    // 解除阻擋：恢復操作與正常計時
    if (state.status === "playing") {
      // 重繪句子：回合中新增限制時，renderSentence 曾在 buffering=true 下執行，
      // 導致空格未綁定點擊事件；解除阻擋後需重繪才能讓當前玩家點格放字。
      renderSentence(state.lastMove);
      updateControls();
      startTimer();
    }
  }
}

// 目前輸入框中的合法單一中文字（供放入預覽用），否則回空字串
function previewChar() {
  const c = (el.charInput.value || "").trim();
  if ([...c].length === 1 && /^[一-鿿]$/u.test(c)) return c;
  return "";
}

// 輸入框變動：更新控制列並刷新放入預覽
function onCharInput() {
  updateControls();
  if (
    state.you !== null &&
    state.currentPlayer === state.you &&
    state.status === "playing"
  ) {
    renderSentence(state.lastMove);
  }
}

function selectSlot(index) {
  if (state.buffering) return;
  state.selectedIndex = index;
  renderSentence(state.lastMove);
  updateControls();
  el.charInput.focus();
}

// ---------- 控制列 ----------
function updateControls() {
  const myTurn =
    state.you !== null &&
    state.currentPlayer === state.you &&
    state.status === "playing";

  if (state.spectator) {
    el.turnBadge.textContent = `👀 觀戰中 · ${seatName(state.currentPlayer)} 的回合`;
    el.turnBadge.classList.remove("your-turn");
    el.charInput.disabled = true;
    el.btnSubmit.disabled = true;
    el.btnChallenge.disabled = true;
    el.hint.textContent = "你正在觀戰，下一場開打前有空位就能入座";
    return;
  }

  el.turnBadge.textContent = myTurn
    ? "輪到你"
    : `${seatName(state.currentPlayer)} 的回合`;
  el.turnBadge.classList.toggle("your-turn", myTurn);

  // 限制提示彈窗阻擋中：鎖住所有操作（這 3 秒不計入計時）
  if (state.buffering) {
    el.charInput.disabled = true;
    el.btnSubmit.disabled = true;
    el.btnChallenge.disabled = true;
    el.hint.textContent = "限制提示中，稍候即可行動…";
    return;
  }

  const hasChar = el.charInput.value.trim().length > 0;
  el.charInput.disabled = !myTurn;
  el.btnSubmit.disabled = !(myTurn && hasChar && state.selectedIndex !== null);
  el.btnChallenge.disabled = !(myTurn && state.canChallenge);

  if (myTurn) {
    const hasPos = state.selectedIndex !== null;
    let hint;
    if (hasChar && hasPos) {
      hint = "按「放入」確認，或改點其他位置";
    } else if (hasChar && !hasPos) {
      hint = "點一下句子中要放入的位置";
    } else if (!hasChar && hasPos) {
      hint = "輸入一個中文字後按「放入」";
    } else {
      hint = "輸入一個字並點選位置（順序不限）";
    }
    // 可挑戰時，順帶提醒被挑戰的字與風險
    if (state.canChallenge && state.lastMove && state.lastMove.char) {
      hint += `，或挑戰${seatName(state.lastMove.player)}的「${state.lastMove.char}」`;
    }
    el.hint.textContent = hint;
  } else {
    el.hint.textContent = `等待${seatName(state.currentPlayer)}出手…`;
  }
}

function submitInsert() {
  const char = el.charInput.value.trim();
  if (state.selectedIndex === null || !char) return;
  // 前端先擋非中文字，給即時提示且不會卡在送出狀態
  if ([...char].length !== 1 || !/^[一-鿿]$/u.test(char)) {
    flashHint("只能輸入單一中文字");
    return;
  }
  send({ type: "insert", index: state.selectedIndex, char });
  state.status = "sent";
  el.btnSubmit.disabled = true;
  el.btnChallenge.disabled = true;
}

const CHALLENGED_KEY = "owc:challengedOnce";
function doChallenge() {
  // 首次挑戰前，說明勝負規則（挑戰失敗對方得分），之後不再打擾
  let firstTime = false;
  try {
    firstTime = !localStorage.getItem(CHALLENGED_KEY);
  } catch {}
  if (firstTime) {
    const char =
      state.lastMove && state.lastMove.char
        ? `「${state.lastMove.char}」`
        : "上一位玩家的字";
    const ok = window.confirm(
      `要挑戰${char}嗎？\n\nAI 裁判會判定剛接的字放進句子後合不合理：\n・不合理／多餘湊字 → 你得分\n・接得合理自然 → 對方得分\n\n確定要挑戰嗎？`,
    );
    if (!ok) return;
    try {
      localStorage.setItem(CHALLENGED_KEY, "1");
    } catch {}
  }
  send({ type: "challenge" });
  el.btnChallenge.disabled = true;
  el.hint.textContent = "挑戰中，AI 裁判評分中…";
}

// ---------- 計時器 ----------
function startTimer() {
  cancelAnimationFrame(state.timerRAF);
  const tick = () => {
    const remain = Math.max(0, state.deadline - Date.now());
    // 緩衝期間 deadline 比 TURN_MS 更遠，顯示上限維持在滿格 20 秒（降到 20 秒內才開始倒數）
    const shown = Math.min(TURN_MS, remain);
    const ratio = shown / TURN_MS;
    el.timerBar.style.transform = `scaleX(${ratio})`;
    el.timerBar.classList.toggle("low", shown <= 5000);
    el.timerText.textContent = Math.ceil(shown / 1000);
    if (state.status === "playing" || state.status === "sent") {
      state.timerRAF = requestAnimationFrame(tick);
    }
  };
  tick();
}

// ---------- 挑戰等待畫面 ----------
function showJudging(msg) {
  state.status = "settling";
  hideRestrictionToast();
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);
  const who = msg.challenger === state.you ? "你" : seatName(msg.challenger);
  el.ovTitle.textContent = "挑戰中";
  el.ovBody.innerHTML = `
    <div class="spinner" style="margin:12px auto"></div>
    <div class="judge-reason">${escapeHtml(who)}發起挑戰，AI 裁判評分中…</div>`;
  el.ovBtn.style.display = "none";
  el.ovBtn2.hidden = true;
  el.overlay.classList.add("show");

  // 逾時保護：評分太久（多半是連線異常）就觸發重連，避免永遠卡在此畫面
  clearJudgeTimer();
  state.judgeTimer = setTimeout(() => {
    if (state.status !== "settling") return;
    el.ovBody.innerHTML = `
      <div class="spinner" style="margin:12px auto"></div>
      <div class="judge-reason">評分逾時，重新連線中…</div>`;
    if (state.ws) {
      try {
        state.ws.close();
      } catch {}
    }
  }, JUDGE_TIMEOUT_MS);
}

// ---------- 結算 / 結束 彈窗 ----------
function showSettled(msg) {
  state.status = "result";
  state.iAmReady = false;
  clearJudgeTimer();
  hideRestrictionToast();
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);
  const before = state.scores.slice();
  state.scores = msg.scores;
  state.round = msg.round || state.round;
  renderSeats();

  const timeout = msg.challengedChar === null;
  el.ovTitle.textContent = timeout ? "時間到" : "回合結算";

  // AI 評語（超時無評分則略過）
  const reasonHtml = msg.reason
    ? `<div class="ai-verdict"><span class="ai-tag">AI 裁判</span><span class="ai-text">${escapeHtml(msg.reason)}</span></div>`
    : "";

  // 這回合發生什麼：秀出目前接龍全字，最後放入的字以樣式標記
  const chars = Array.isArray(msg.sentence)
    ? msg.sentence
    : Array.from(msg.sentence || "");
  const charsHtml = chars
    .map((c, i) => {
      const latest = !timeout && i === msg.challengedIndex;
      return `<span class="settle-char${latest ? " latest" : ""}">${escapeHtml(c)}</span>`;
    })
    .join("");
  const chainHtml = charsHtml
    ? `<div class="settle-chain">${charsHtml}</div>`
    : "";
  let infoHtml;
  if (timeout) {
    infoHtml = `<div class="settle-info">${chainHtml}<div class="settle-last">時間到還沒出手</div></div>`;
  } else {
    infoHtml = `<div class="settle-info">${chainHtml}</div>`;
  }

  // 計分明細（條列，每項標明歸屬某一方與加分）
  const { items, notes } = scoreItems(msg, timeout);
  const rowsHtml = items.map(rowHtml).join("");
  const notesHtml = notes.map((n) => `<div class="sheet-note">${n}</div>`).join("");

  // 本回合加總
  let totalHtml;
  if (msg.awardedTo === null || msg.awardedTo === undefined) {
    totalHtml = `<div class="sheet-total tie">本回合平手，不計分</div>`;
  } else {
    const mine = msg.awardedTo === state.you;
    totalHtml = `<div class="sheet-total ${mine ? "me" : "opp"}">本回合加總　${escapeHtml(sideLabel(msg.awardedTo))} +${msg.awardedPoints} 分</div>`;
  }

  // 對所有座位現有分數的影響（before → after）
  const ruleText =
    state.rule && state.rule.kind === "rounds"
      ? `第 ${msg.round} / ${state.rule.rounds} 回合 · 打完看總分排名`
      : `先達 ${state.rule ? state.rule.target : 5} 分獲勝`;
  const changeRows = state.seats
    .map((sk, i) =>
      changeRow(
        sideLabel(i),
        before[i] ?? msg.scores[i],
        msg.scores[i],
        msg.awardedTo === i,
      ),
    )
    .join("");
  const changeHtml = `
    <div class="score-change">
      <div class="sheet-head">分數變化（${escapeHtml(ruleText)}）</div>
      ${changeRows}
    </div>`;

  el.ovBody.innerHTML = `
    ${infoHtml}
    ${reasonHtml}
    <div class="score-sheet">
      <div class="sheet-head">計分明細</div>
      ${rowsHtml}
      ${notesHtml}
      ${totalHtml}
    </div>
    ${changeHtml}
    <div class="settle-count"><div id="ov-count-bar" class="settle-count-bar"></div></div>
    <div class="settle-next" id="ov-next">${msg.final ? "即將公布結果…" : "即將開始下一回合…"}</div>
  `;
  // server 於 nextInMs 後自動推進，這裡以進度條倒數；並提供「準備好了」提前推進
  if (state.spectator) {
    el.ovBtn.style.display = "none";
  } else {
    el.ovBtn.style.display = "";
    el.ovBtn.textContent = "準備好了 ›";
    el.ovBtn.disabled = false;
    el.ovBtn.onclick = sendReady;
  }
  el.ovBtn2.hidden = true;
  el.overlay.classList.add("show");

  const dur = msg.nextInMs || 10000;
  const bar = document.getElementById("ov-count-bar");
  // 先滿格，下一幀起以 CSS transition 平滑歸零
  bar.style.transition = "none";
  bar.style.width = "100%";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bar.style.transition = `width ${dur}ms linear`;
      bar.style.width = "0%";
    });
  });
}

// 結算停留：按「準備好了」提前推進；全員到齊後端即取消倒數、直接進下一回合
function sendReady() {
  if (state.iAmReady) return;
  state.iAmReady = true;
  send({ type: "ready" });
  el.ovBtn.disabled = true;
  el.ovBtn.textContent = "已準備，等待其他玩家…";
  const nextEl = document.getElementById("ov-next");
  if (nextEl) nextEl.textContent = "已準備，等待其他玩家…";
}

function showReadyState(msg) {
  if (state.status !== "result") return;
  const ready = msg.ready || [];
  const nextEl = document.getElementById("ov-next");
  if (!nextEl) return;
  if (state.iAmReady) {
    nextEl.textContent = "已準備，等待其他玩家…";
  } else if (ready.length) {
    const names = ready.map((i) => sideLabel(i)).join("、");
    nextEl.textContent = `${names} 已準備好，按「準備好了」可提前開始`;
  }
}

function showGameover(msg) {
  state.status = "over";
  clearJudgeTimer();
  document.title = BASE_TITLE;
  hideRestrictionToast();
  // 斷線者重連取回結果時，沒收過 start，需由 gameover 補上自己的身分與名單
  if (msg.you !== undefined) {
    state.you = msg.you;
    state.spectator = msg.you === null;
  }
  if (msg.seats) state.seats = msg.seats;
  if (msg.source) state.source = msg.source;
  state.scores = msg.scores;
  // 結算彈窗位於遊戲畫面內，需確保遊戲畫面為 active 才顯示得出來（重連時可能停在配對畫面）
  show("game");
  renderSeats();
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);

  if (msg.source === "room") {
    showRoomGameover(msg);
    return;
  }

  // ---- 隨機配對（2 人）----
  forgetGame(); // 對局已結束，清掉重連記錄

  // 非參與者（結束後才點連結／換帳號連進來的第三方）：中性顯示，不判定輸贏
  if (state.you === null) {
    el.ovBtn.style.display = "";
    el.ovTitle.textContent = "對局已結束";
    const neutralReason =
      msg.reason === "opponent_left" ? "其中一方已離線" : "已分出勝負";
    el.ovBody.innerHTML = `
      <div class="judge-reason">${escapeHtml(neutralReason)}</div>
      <div class="judge-row">
        ${state.seats
          .map(
            (sk, i) =>
              `<div class="judge-item"><span class="k">${escapeHtml(sk.name)}</span><span class="v">${msg.scores[i] ?? 0}</span></div>`,
          )
          .join("")}
      </div>
    `;
    el.ovBtn.textContent = "回主選單";
    el.ovBtn.disabled = false;
    el.ovBtn.onclick = backToStart;
    el.ovBtn2.hidden = true;
    el.overlay.classList.add("show");
    return;
  }

  el.ovBtn.style.display = "";
  const win = msg.winner === state.you;
  el.ovTitle.textContent = win ? "🎉 你贏了！" : "你輸了";
  const oppSeat = state.you === 0 ? 1 : 0;
  const reason =
    msg.reason === "opponent_left"
      ? `${seatName(oppSeat)} 已離線`
      : `有人先達到 ${state.rule && state.rule.target ? state.rule.target : 5} 分`;
  let eloHtml = "";
  if (msg.elo && state.you !== null) {
    eloHtml = `
      <div class="elo-change">
        <div class="elo-head">ELO 積分變化</div>
        ${eloRow(seatName(state.you), msg.elo[state.you])}
        ${eloRow(seatName(oppSeat), msg.elo[oppSeat])}
      </div>`;
  }
  // 首次勝利時提醒備份帳號代碼（換裝置不掉分）；只提醒一次
  let showBackup = false;
  try {
    showBackup = win && !!me.name && !localStorage.getItem(BACKUP_KEY);
  } catch {}
  const backupHtml = showBackup
    ? `<button type="button" class="backup-tip" id="backup-tip-btn">💾 記得備份「帳號代碼」，換手機或瀏覽器都不會掉分 ›</button>`
    : "";

  el.ovBody.innerHTML = `
    <div class="judge-reason">${escapeHtml(reason)}</div>
    <div class="judge-row">
      ${state.seats
        .map(
          (sk, i) =>
            `<div class="judge-item"><span class="k">${escapeHtml(sideLabel(i))}</span><span class="v">${msg.scores[i] ?? 0}</span></div>`,
        )
        .join("")}
    </div>
    ${eloHtml}
    ${backupHtml}
  `;
  if (showBackup) {
    try {
      localStorage.setItem(BACKUP_KEY, "1");
    } catch {}
    const tip = document.getElementById("backup-tip-btn");
    if (tip)
      tip.onclick = () => {
        resetGameState();
        openNameScreen(true); // 顯示帳號代碼供備份
      };
  }
  el.ovBtn.textContent = "再玩一場";
  el.ovBtn.disabled = false;
  el.ovBtn.onclick = rematch;
  el.ovBtn2.hidden = false;
  el.ovBtn2.textContent = "回主選單";
  el.ovBtn2.onclick = backToStart;
  el.overlay.classList.add("show");
  // 對戰結束後更新自身積分（供返回開始頁時顯示最新資料）
  register();
}

// 好友房結束：全排名 + 同房再來一場（房主）；連線保持，等 roomState 進等待室
function showRoomGameover(msg) {
  const myEntry =
    state.you !== null ? msg.ranking.find((r) => r.seat === state.you) : null;
  if (!myEntry) {
    el.ovTitle.textContent = "對局結束";
  } else if (myEntry.rank === 1) {
    el.ovTitle.textContent = "🏆 你是第 1 名！";
  } else {
    el.ovTitle.textContent = `第 ${myEntry.rank} 名`;
  }

  const reasonText =
    msg.reason === "players_left"
      ? "其他玩家都離開了，對局提前結束"
      : `${state.rule && state.rule.kind === "rounds" ? state.rule.rounds : ""} 回合打完，總分排名`;

  const medal = (rank) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}`);
  const rankingHtml = msg.ranking
    .map((r) => {
      const cls = ["rank-row", r.seat === state.you ? "me" : "", r.eliminated ? "out" : ""]
        .filter(Boolean)
        .join(" ");
      return `<div class="${cls}">
        <span class="rk-medal">${medal(r.rank)}</span>
        <span class="rk-name">${escapeHtml(sideLabel(r.seat))}${r.eliminated ? `<span class="sc-tag out">中離</span>` : ""}</span>
        <span class="rk-score">${r.score} 分</span>
      </div>`;
    })
    .join("");

  el.ovBody.innerHTML = `
    <div class="judge-reason">${escapeHtml(reasonText)}</div>
    <div class="ranking">${rankingHtml}</div>
    <div class="settle-next">好友房不計 ELO 積分</div>
    ${
      msg.canRestart
        ? ""
        : `<div class="settle-next">房主可以開新的一場，留在這裡稍等…</div>`
    }
  `;
  if (msg.canRestart) {
    el.ovBtn.style.display = "";
    el.ovBtn.textContent = "再來一場（同房）";
    el.ovBtn.disabled = false;
    el.ovBtn.onclick = () => {
      send({ type: "restartRoom" });
      el.ovBtn.disabled = true;
      el.ovBtn.textContent = "重開中…";
    };
  } else {
    el.ovBtn.style.display = "none";
  }
  el.ovBtn2.hidden = false;
  el.ovBtn2.textContent = "離開房間";
  el.ovBtn2.onclick = () => {
    send({ type: "leave" });
    resetGameState();
    show("start");
  };
  el.overlay.classList.add("show");
}

// 清掉上一場的對局狀態（不重載頁面），供再玩一場／回主選單共用
function resetGameState() {
  hideOverlay();
  stopWaitTimer();
  clearInterval(state.keepalive);
  clearTimeout(state.reconnectTimer);
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);
  if (state.ws) {
    try {
      state.ws.onclose = null;
      state.ws.close();
    } catch {}
    state.ws = null;
  }
  forgetGame();
  state.status = "idle";
  state.you = null;
  state.spectator = false;
  state.source = "match";
  state.mode = state.menuMode; // 離開好友房不應把它的模式帶進之後的隨機配對
  state.rule = { kind: "target", target: 5 };
  state.round = 0;
  state.seats = [];
  state.scores = [];
  state.timeoutQuota = [];
  state.room = null;
  state.sentence = [];
  state.restrictions = [];
  state.allowedPositions = null;
  state.selectedIndex = null;
  state.canChallenge = false;
  state.reconnectTries = 0;
  state.gameId = null;
  state.matching = false;
  state.buffering = false;
  state.wasMyTurn = false;
  state.lastMove = null;
  state.iAmReady = false;
  clearJudgeTimer();
  document.title = BASE_TITLE;
  el.btnRetryMatch.hidden = true;
}

// 對戰中主動離開：確認後通知後端（好友房=出局、隨機配對=判負），回主選單
function leaveGame() {
  if (state.status === "over") return;
  const text =
    state.source === "room"
      ? state.spectator
        ? "要離開觀戰嗎？"
        : "離開將直接出局（分數保留在計分板），確定要離開嗎？"
      : "離開將直接判負，確定要離開嗎？";
  const ok = window.confirm(text);
  if (!ok) return;
  send({ type: "leave" });
  resetGameState(); // 內含關閉連線（onclose 已解除，不會重連）
  show("start");
}

// 再玩一場：不重載頁面，直接以同模式重新配對
function rematch() {
  resetGameState();
  play();
}

// 回主選單
function backToStart() {
  resetGameState();
  show("start");
}

function hideOverlay() {
  clearInterval(state.resultTimer);
  el.overlay.classList.remove("show");
  el.ovBtn2.hidden = true;
}

// 把本回合結算拆成條列項目：每項標明加分歸屬（挑戰者／被挑戰者）與分數。
// notes 為不影響計分、但需說明的限制狀態。
function scoreItems(msg, timeout) {
  const items = [];
  const notes = [];

  if (timeout) {
    if (msg.awardedTo !== null && msg.awardedTo !== undefined) {
      items.push({
        label: "超時未出手，對方得分",
        seat: msg.awardedTo,
        pts: msg.awardedPoints,
      });
    }
    return { items, notes };
  }

  const challenger = msg.challenger;
  const challenged = msg.challenged;
  const rs = msg.restrictions || [];
  const zhuyinR = rs.find((x) => x.kind === "zhuyin");
  const posR = rs.find((x) => x.kind === "pos");
  const meaningR = rs.find((x) => x.kind === "meaning");
  const positionR = rs.find((x) => x.kind === "position");
  const noBoringR = rs.find((x) => x.kind === "noboring");

  // 違規判定（惡魔模式的注音／詞性／語意／別太無聊限制任一違反）：
  // 直接判挑戰方 +3（多項違規也只計一次），忽略其他分數的加總。
  const zhuyinViolation = !!zhuyinR && msg.zhuyinMatch === false;
  const posViolationHit = !!posR && msg.posViolation === true;
  const meaningViolation = !!meaningR && msg.meaningChanged === false;
  const noBoringViolation = !!noBoringR && msg.noBoringViolation === true;

  if (zhuyinViolation || posViolationHit || meaningViolation || noBoringViolation) {
    // 只有第一個違規項計 +3，其餘僅列出原因（避免明細加總大於實得分數）
    let scored = false;
    const pushViolation = (label, devil) => {
      items.push({ label, seat: challenger, pts: scored ? 0 : 3, devil });
      scored = true;
    };
    if (zhuyinViolation) {
      const finals = escapeHtml((zhuyinR.finals || []).join(" "));
      pushViolation(`😈 注音違規（不符 ${finals}）`, true);
    }
    if (posViolationHit) {
      const pos = posR.pos ? escapeHtml(posR.pos) : "";
      pushViolation(`😈 詞性違規（是${pos}）`, true);
    }
    if (meaningViolation) {
      pushViolation(`😈 意思改變違規（句意未改變）`, true);
    }
    if (noBoringViolation) {
      pushViolation(`😈 別太無聊違規（放入禁止字）`, true);
    }
    notes.push(
      items.length > 1
        ? "違規直接判挑戰方 +3（多項違規僅計一次），其他分數不計"
        : "違規直接判挑戰方 +3，其他分數不計",
    );
    return { items, notes };
  }

  // 未違規：句子合理度（一律顯示）：正=句子合理→被挑戰方，負=不合理→挑戰方
  const aLabel = `句子合理度 · ${reasonWord(msg.sentenceScore)}`;
  if (msg.sentenceScore > 0)
    items.push({ label: aLabel, seat: challenged, pts: msg.sentenceScore });
  else if (msg.sentenceScore < 0)
    items.push({ label: aLabel, seat: challenger, pts: -msg.sentenceScore });
  else items.push({ label: aLabel, seat: null, pts: 0 });

  // 惡魔模式限制（未違規時的說明，逐一列出目前生效的限制）
  if (zhuyinR) {
    const finals = escapeHtml((zhuyinR.finals || []).join(" "));
    notes.push(`😈 注音符合（${finals}），未加減分`);
  }
  if (posR) {
    const pos = posR.pos ? escapeHtml(posR.pos) : "";
    notes.push(`😈 詞性符合（非${pos}），未加減分`);
  }
  if (meaningR) {
    notes.push(`😈 句意有改變，未加減分`);
  }
  if (noBoringR) {
    notes.push(`😈 未放入禁止字，未加減分`);
  }
  if (positionR) {
    notes.push(`😈 位置限制不影響計分`);
  }

  return { items, notes };
}

// 單一計分項目的一列
function rowHtml(it) {
  let pts;
  if (it.seat === null || it.seat === undefined || it.pts === 0) {
    pts = `<span class="sr-pts zero">0 分</span>`;
  } else {
    const mine = it.seat === state.you;
    pts = `<span class="sr-pts ${mine ? "me" : "opp"}">${escapeHtml(sideLabel(it.seat))} +${it.pts}</span>`;
  }
  return `<div class="sheet-row${it.devil ? " devil" : ""}"><span class="sr-label">${it.label}</span>${pts}</div>`;
}

// ELO 變化的一列：before → after（+/-delta）
function eloRow(name, e) {
  if (!e) return "";
  const sign = e.delta > 0 ? "+" : "";
  const cls = e.delta > 0 ? "up" : e.delta < 0 ? "down" : "same";
  return `<div class="elo-row">
    <span class="ek">${escapeHtml(name)}</span>
    <span class="ev">
      <span class="eo">${e.before}</span>
      <span class="earrow">→</span>
      <span class="en">${e.after}</span>
      <span class="ed ${cls}">${sign}${e.delta}</span>
    </span>
  </div>`;
}

// 分數變化的一列：before → after
function changeRow(name, before, after, changed) {
  const val =
    before === after
      ? `<span class="cv same">${after}</span>`
      : `<span class="cv"><span class="cv-old">${before}</span> → <span class="cv-new">${after}</span></span>`;
  return `<div class="change-row${changed ? " changed" : ""}"><span class="ck">${escapeHtml(name)}</span>${val}</div>`;
}

// ---------- 工具 ----------
function reasonWord(a) {
  if (a >= 2) return "很合理";
  if (a === 1) return "還算合理";
  if (a === 0) return "普通";
  if (a === -1) return "有點怪";
  return "很不合理";
}
// 座位顯示名稱（自己以外）
function seatName(seat) {
  if (seat === null || seat === undefined) return "—";
  const sk = state.seats[seat];
  return (sk && sk.name) || `玩家 ${seat + 1}`;
}
// 結算/明細用：自己顯示「你」，其他人顯示其名稱
function sideLabel(seat) {
  return seat === state.you ? "你" : seatName(seat);
}
function flashHint(text) {
  el.hint.textContent = text;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- 事件綁定 ----------
el.modeOpts.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.mode = btn.dataset.mode;
    state.menuMode = state.mode;
    el.modeOpts.forEach((b) => b.classList.toggle("active", b === btn));
    el.modeDesc.textContent = MODE_DESC[state.mode];
    // 惡魔模式時顯示「看惡魔模式怎麼玩」連結
    el.btnDevilHelp.hidden = state.mode !== "devil";
  });
});
el.btnPlay.addEventListener("click", play);
el.btnCreateRoom.addEventListener("click", createRoom);
el.btnJoinRoom.addEventListener("click", () => {
  if (!me.name) {
    openNameScreen(false);
    return;
  }
  openJoinScreen("");
});
el.btnHelp.addEventListener("click", () => show("help"));
el.btnHelpBack.addEventListener("click", () => show("start"));
el.btnHelpPlay.addEventListener("click", play);
// 從開始頁直達惡魔模式說明區塊
el.btnDevilHelp.addEventListener("click", () => {
  show("help");
  if (el.helpDevil) {
    setTimeout(
      () => el.helpDevil.scrollIntoView({ behavior: "smooth", block: "start" }),
      60,
    );
  }
});
// 加入房間畫面
el.btnJoinBack.addEventListener("click", () => show("start"));
el.joinCode.addEventListener("input", () => {
  const v = normalizeRoomCode(el.joinCode.value);
  if (el.joinCode.value !== v) el.joinCode.value = v;
  fetchJoinInfo();
});
el.joinCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !el.btnJoinGo.disabled) joinRoom();
});
el.btnJoinGo.addEventListener("click", joinRoom);
// 等待室
el.btnShareRoom.addEventListener("click", shareRoomLink);
el.btnStartRoom.addEventListener("click", startRoom);
el.btnLeaveRoom.addEventListener("click", leaveRoom);
// 配對畫面：取消配對、複製遊戲連結、重試連線
el.btnCancelMatch.addEventListener("click", cancelMatch);
el.btnCopyLink.addEventListener("click", copyGameLink);
el.btnRetryMatch.addEventListener("click", retryConnect);
// 音效開關
el.btnSound.addEventListener("click", toggleSound);
// 回到前景時還原分頁標題（玩家已在看畫面，不需要提示）
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) document.title = BASE_TITLE;
});
el.btnSubmit.addEventListener("click", submitInsert);
el.btnChallenge.addEventListener("click", doChallenge);
el.btnLeave.addEventListener("click", leaveGame);
// 限制提示彈窗：點擊任意處提前關閉（後端已把緩衝加進截止時間，不影響公平）
el.restrictionToast.addEventListener("click", hideRestrictionToast);
el.charInput.addEventListener("input", onCharInput);
el.charInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !el.btnSubmit.disabled) submitInsert();
});

// 命名
el.nameInput.addEventListener("input", () => {
  el.btnNameSave.disabled = !el.nameInput.value.trim();
});
el.nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !el.btnNameSave.disabled) saveName();
});
el.btnNameSave.addEventListener("click", saveName);
el.btnNameCancel.addEventListener("click", () => show("start"));
el.playerBar.addEventListener("click", () => openNameScreen(true));

// 帳號代碼
el.btnCopyCode.addEventListener("click", copyCode);
el.btnShowImport.addEventListener("click", () => {
  el.acctImport.hidden = !el.acctImport.hidden;
  if (!el.acctImport.hidden) el.importCode.focus();
});
el.importCode.addEventListener("input", () => {
  hideImportError();
  el.btnImport.disabled = !el.importCode.value.trim();
});
el.importCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !el.btnImport.disabled) importAccount();
});
el.btnImport.addEventListener("click", importAccount);
el.btnDeleteAccount.addEventListener("click", deleteAccount);

// 排行榜
el.btnLeaderboard.addEventListener("click", openLeaderboard);
el.btnLbBack.addEventListener("click", () => show("start"));

// ---------- 啟動 ----------
function boot() {
  loadSound();
  renderSoundToggle();
  loadIdentity();

  // 連結加入：?room=CODE（好友傳來的邀請連結）。進站後立刻把它從網址移除——
  // 若留著，之後任何一次重新整理都會被它蓋掉正在進行的對局重連（見下方 active 優先判斷）。
  const roomParam = normalizeRoomCode(
    new URLSearchParams(location.search).get("room") || "",
  );
  if (roomParam) {
    try {
      history.replaceState(null, "", location.pathname);
    } catch {}
  }

  if (!me.name) {
    if (roomParam.length === ROOM_CODE_LEN) state.pendingJoinCode = roomParam;
    openNameScreen(false);
    return;
  }
  renderPlayerBar();
  register(); // 更新名稱並取回最新戰績

  // 重新整理／斷線後若仍有進行中的對局，優先連回同一場（斷線判負者會在此取回結果）；
  // 這必須比邀請連結的加入流程優先，否則透過連結加入房間的玩家每次重整頁面
  // 都會被導去「加入房間」畫面而不是直接重連回自己的座位。
  const active = loadActiveGame();
  if (active && active.gameId) {
    state.mode = active.mode || state.mode;
    show("matching");
    el.matchingText.textContent = "重新連線中…";
    if (String(active.gameId).startsWith("room:")) {
      // 好友房：先確認房間還在（房主離開會解散），避免連向已解散的房
      verifyRoomThenReconnect(active.gameId);
    } else {
      connect(active.gameId);
    }
    return;
  }

  if (roomParam.length === ROOM_CODE_LEN) {
    openJoinScreen(roomParam);
    return;
  }

  show("start");
}

async function verifyRoomThenReconnect(gameId) {
  const code = String(gameId).slice("room:".length);
  let ok = false;
  try {
    const res = await fetch(`/api/room/info?code=${encodeURIComponent(code)}`);
    ok = res.ok && (await res.json()).ok === true;
  } catch {}
  if (ok) {
    connect(gameId);
  } else {
    forgetGame();
    show("start");
  }
}
boot();
