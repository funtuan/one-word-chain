"use strict";

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    name: $("screen-name"),
    start: $("screen-start"),
    help: $("screen-help"),
    leaderboard: $("screen-leaderboard"),
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
  btnHelp: $("btn-help"),
  btnHelpBack: $("btn-help-back"),
  btnHelpPlay: $("btn-help-play"),
  modeOpts: document.querySelectorAll(".mode-opt"),
  modeDesc: $("mode-desc"),
  btnDevilHelp: $("btn-devil-help"),
  helpDevil: $("help-devil"),
  matchingSub: $("matching-sub"),
  matchingInvite: $("matching-invite"),
  btnCopyLink: $("btn-copy-link"),
  btnCancelMatch: $("btn-cancel-match"),
  btnRetryMatch: $("btn-retry-match"),
  btnSound: $("btn-sound"),
  labelMe: $("label-me"),
  labelOpp: $("label-opp"),
  eloMe: $("elo-me"),
  eloOpp: $("elo-opp"),
  restriction: $("restriction"),
  restrictionToast: $("restriction-toast"),
  matchingText: $("matching-text"),
  scoreMe: $("score-me"),
  scoreOpp: $("score-opp"),
  quotaMe: $("quota-me"),
  quotaOpp: $("quota-opp"),
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

const state = {
  ws: null,
  you: null, // "p1" | "p2"
  names: { p1: "玩家 1", p2: "玩家 2" }, // 雙方顯示名稱
  ratings: { p1: 1000, p2: 1000 }, // 雙方 ELO 積分
  mode: "normal", // "normal" | "devil"
  timeoutQuota: { p1: TIMEOUT_QUOTA, p2: TIMEOUT_QUOTA }, // 雙方剩餘超時額度
  restrictions: [], // 惡魔模式目前生效的限制（隨字數累加）
  restrictionToastTimer: null, // 限制提示彈窗的自動關閉計時
  buffering: false, // 限制提示彈窗阻擋中（此時鎖住操作、計時顯示維持滿格）
  allowedPositions: null, // 位置限制：可放入位置；null 表示不限
  sentence: [],
  currentPlayer: null,
  canChallenge: false,
  selectedIndex: null,
  deadline: 0,
  target: 5,
  status: "idle",
  timerRAF: null,
  resultTimer: null,
  timeoutFxTimer: null,
  gameId: null, // 目前對局 id（供斷線重連回同一場）
  reconnectTries: 0, // 斷線後已重連次數
  keepalive: null, // 保活計時器
  matching: false, // 是否正在（新的）配對等待中
  waitStart: 0, // 開始等待對手的時間戳
  waitTimer: null, // 配對等待秒數更新計時器
  wasMyTurn: false, // 上一次是否輪到自己（用來偵測「換我了」以發通知）
  lastMove: null, // 對方上一手（供挑戰提示顯示被挑戰的字）
  judgeTimer: null, // 挑戰評分的前端逾時保護
  iAmReady: false, // 結算停留階段我是否已按「準備好了」
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
  show("start");
  await register();
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
  const modeLabel = state.mode === "devil" ? "😈 惡魔模式" : "😇 普通模式";
  el.matchingText.textContent = `${modeLabel} · 配對中…`;
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
  stopWaitTimer();
  clearInterval(state.keepalive);
  state.gameId = null;
  forgetGame();
  if (state.ws) {
    try {
      state.ws.onclose = null; // 避免觸發自動重連
      state.ws.close();
    } catch {}
    state.ws = null;
  }
  if (gameId) {
    fetch(
      `/api/cancel?mode=${mode}&gameId=${encodeURIComponent(gameId)}`,
    ).catch(() => {});
  }
  show("start");
}

// 重連用盡後，玩家手動重試連回同一場
function retryConnect() {
  if (!state.gameId) return;
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
    // 進入重連流程：關掉主動配對的等待秒數／邀請提示
    state.matching = false;
    stopWaitTimer();
    el.matchingSub.hidden = true;
    el.matchingInvite.hidden = true;
    // 非正常中斷：本設計「斷線即判負」，因此嘗試連回同一場，
    // 取回自己敗北的結果並顯示（而非停在「連線中斷」）。
    if ((state.reconnectTries || 0) < RECONNECT_MAX && state.gameId) {
      state.reconnectTries = (state.reconnectTries || 0) + 1;
      show("matching");
      el.btnCancelMatch.hidden = false;
      el.btnRetryMatch.hidden = true;
      el.matchingText.textContent = "連線中斷，重新連線中…";
      setTimeout(() => connect(state.gameId), RECONNECT_DELAY);
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
      // 只有主動配對（非斷線重連）時才顯示等待秒數與邀請提示
      if (state.matching) startWaitTimer();
      break;
    case "start":
      state.matching = false;
      stopWaitTimer();
      state.you = msg.you;
      state.target = msg.target;
      state.mode = msg.mode;
      if (msg.names) state.names = msg.names;
      if (msg.ratings) state.ratings = msg.ratings;
      el.labelMe.textContent = myName();
      el.labelOpp.textContent = oppName();
      el.eloMe.textContent = `${state.ratings[state.you]} 分`;
      el.eloOpp.textContent = `${state.ratings[other(state.you)]} 分`;
      hideOverlay();
      hideRestrictionToast(); // 清掉上一回合可能殘留的緩衝狀態
      applyRound(msg);
      show("game");
      // 回合開局：跳出本回合起始限制的提示彈窗（阻擋 3 秒）
      if (state.restrictions.length) {
        showRestrictionToast(state.restrictions, true);
      }
      break;
    case "update":
      applyRound(msg);
      break;
    case "timeoutExtend":
      showTimeoutExtend(msg);
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

function applyRound(msg) {
  clearJudgeTimer(); // 進入新回合狀態，解除評分逾時保護
  state.iAmReady = false;
  state.sentence = msg.sentence;
  state.currentPlayer = msg.currentPlayer;
  state.canChallenge = msg.canChallenge;
  state.lastMove = msg.lastMove || null;
  state.deadline = msg.deadline;
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

  el.scoreMe.textContent = msg.scores[state.you];
  el.scoreOpp.textContent = msg.scores[other(state.you)];

  if (msg.timeoutQuota) state.timeoutQuota = msg.timeoutQuota;
  renderQuota();

  renderSentence(msg.lastMove);
  updateControls();
  startTimer();
  notifyTurnChange();
}

// ---------- 換我了：震動 / 音效 / 分頁標題提示 ----------
const BASE_TITLE = "一字接龍";
function notifyTurnChange() {
  const myTurn = state.currentPlayer === state.you && state.status === "playing";
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

// ---------- 超時額度 ----------
// 以小圓點顯示雙方剩餘的超時額度（已用掉的變暗），保持低調不搶畫面。
function renderQuota() {
  const q = state.timeoutQuota || { p1: TIMEOUT_QUOTA, p2: TIMEOUT_QUOTA };
  renderQuotaFor(el.quotaMe, q[state.you]);
  renderQuotaFor(el.quotaOpp, q[other(state.you)]);
}

function renderQuotaFor(node, left) {
  if (!node) return;
  const remain = Math.max(0, Math.min(TIMEOUT_QUOTA, left ?? TIMEOUT_QUOTA));
  let pips = "";
  for (let i = 0; i < TIMEOUT_QUOTA; i++) {
    pips += `<span class="pip${i < remain ? "" : " used"}"></span>`;
  }
  node.innerHTML = `<span class="quota-ico">⏳</span>${pips}`;
  node.title = `超時額度：剩 ${remain} 次（超時自動 +10 秒）`;
}

// 超時用掉一次額度：更新顯示、延長計時，並播放小動畫（不搶畫面）。
function showTimeoutExtend(msg) {
  if (msg.timeoutQuota) state.timeoutQuota = msg.timeoutQuota;
  renderQuota();
  state.deadline = msg.deadline;
  if (state.status === "playing" || state.status === "sent") startTimer();

  const mine = msg.player === state.you;
  // 被用掉額度的那一方，其額度指示器輕微脈動一下
  const node = mine ? el.quotaMe : el.quotaOpp;
  if (node) {
    node.classList.remove("pulse");
    void node.offsetWidth; // 強制 reflow 以重播動畫
    node.classList.add("pulse");
  }
  // 計時列上方浮出「+10 秒」小提示
  const fx = el.timeoutFx;
  if (fx) {
    fx.textContent = mine ? "超時 +10 秒" : "對手超時 +10 秒";
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
}

// ---------- 句子渲染 ----------
function renderSentence(lastMove) {
  const myTurn = state.currentPlayer === state.you;
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
    // 的 buffering 判斷擋下、且彈窗遮罩本身也會吃掉點擊。若在此處以 buffering 為條件
    // 而不綁事件，回合中新增限制走的渲染順序（先設 buffering 再渲染）會讓空格永遠沒綁
    // 事件，提示消失後也無法點擊。
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
  if (state.currentPlayer === state.you && state.status === "playing") {
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
  const myTurn = state.currentPlayer === state.you && state.status === "playing";
  el.turnBadge.textContent = myTurn ? "輪到你" : "對手回合";
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
      hint += `，或挑戰對方的「${state.lastMove.char}」`;
    }
    el.hint.textContent = hint;
  } else {
    el.hint.textContent = "等待對手出手…";
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
    const char = state.lastMove && state.lastMove.char ? `「${state.lastMove.char}」` : "對方上一個字";
    const ok = window.confirm(
      `要挑戰${char}嗎？\n\nAI 裁判會判定對方剛接的字放進句子後合不合理：\n・不合理／多餘湊字 → 你得分\n・接得合理自然 → 對方得分\n\n確定要挑戰嗎？`,
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
  const who = msg.challenger === state.you ? "你" : "對手";
  el.ovTitle.textContent = "挑戰中";
  el.ovBody.innerHTML = `
    <div class="spinner" style="margin:12px auto"></div>
    <div class="judge-reason">${who}發起挑戰，AI 裁判評分中…</div>`;
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
  el.scoreMe.textContent = msg.scores[state.you];
  el.scoreOpp.textContent = msg.scores[other(state.you)];

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
  if (!msg.awardedTo) {
    totalHtml = `<div class="sheet-total tie">本回合平手，不計分</div>`;
  } else {
    const mine = msg.awardedTo === state.you;
    totalHtml = `<div class="sheet-total ${mine ? "me" : "opp"}">本回合加總　${escapeHtml(sideLabel(msg.awardedTo))} +${msg.awardedPoints} 分</div>`;
  }

  // 對雙方現有分數的影響（before → after）
  const you = state.you;
  const opp = other(you);
  const afterYou = msg.scores[you];
  const afterOpp = msg.scores[opp];
  let beforeYou = afterYou;
  let beforeOpp = afterOpp;
  if (msg.awardedTo === you) beforeYou = afterYou - msg.awardedPoints;
  else if (msg.awardedTo === opp) beforeOpp = afterOpp - msg.awardedPoints;

  const changeHtml = `
    <div class="score-change">
      <div class="sheet-head">分數變化（先達 ${state.target} 分獲勝）</div>
      ${changeRow("你", beforeYou, afterYou, msg.awardedTo === you)}
      ${changeRow(oppName(), beforeOpp, afterOpp, msg.awardedTo === opp)}
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
  el.ovBtn.style.display = "";
  el.ovBtn.textContent = "準備好了 ›";
  el.ovBtn.disabled = false;
  el.ovBtn.onclick = sendReady;
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

// 結算停留：按「準備好了」提前推進；雙方到齊後端即取消倒數、直接進下一回合
function sendReady() {
  if (state.iAmReady) return;
  state.iAmReady = true;
  send({ type: "ready" });
  el.ovBtn.disabled = true;
  el.ovBtn.textContent = "已準備，等待對方…";
  const nextEl = document.getElementById("ov-next");
  if (nextEl) nextEl.textContent = "已準備，等待對方…";
}

function showReadyState(msg) {
  if (state.status !== "result") return;
  const ready = msg.ready || [];
  const oppReady = ready.includes(other(state.you));
  const nextEl = document.getElementById("ov-next");
  if (!nextEl) return;
  if (state.iAmReady) {
    nextEl.textContent = "已準備，等待對方…";
  } else if (oppReady) {
    nextEl.textContent = "對方已準備好，按「準備好了」即可提前開始";
  }
}

function showGameover(msg) {
  state.status = "over";
  clearJudgeTimer();
  document.title = BASE_TITLE;
  hideRestrictionToast();
  forgetGame(); // 對局已結束，清掉重連記錄
  // 斷線者重連取回結果時，沒收過 start，需由 gameover 補上自己的身分與名稱
  if (msg.you) state.you = msg.you;
  if (msg.names) state.names = msg.names;
  // 結算彈窗位於遊戲畫面內，需確保遊戲畫面為 active 才顯示得出來（重連時可能停在配對畫面）
  show("game");
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);
  el.ovBtn.style.display = "";
  const win = msg.winner === state.you;
  el.ovTitle.textContent = win ? "🎉 你贏了！" : "你輸了";
  const reason =
    msg.reason === "opponent_left"
      ? `${oppName()} 已離線`
      : `有人先達到 ${state.target} 分`;
  let eloHtml = "";
  if (msg.elo) {
    eloHtml = `
      <div class="elo-change">
        <div class="elo-head">ELO 積分變化</div>
        ${eloRow(myName(), msg.elo[state.you])}
        ${eloRow(oppName(), msg.elo[other(state.you)])}
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
      <div class="judge-item"><span class="k">${escapeHtml(myName())}</span><span class="v">${msg.scores[state.you]}</span></div>
      <div class="judge-item"><span class="k">${escapeHtml(oppName())}</span><span class="v">${msg.scores[other(state.you)]}</span></div>
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

// 清掉上一場的對局狀態（不重載頁面），供再玩一場／回主選單共用
function resetGameState() {
  hideOverlay();
  stopWaitTimer();
  clearInterval(state.keepalive);
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

// 對戰中主動離開：確認後關閉連線（後端視為斷線 -> 對方判勝），回主選單
function leaveGame() {
  if (state.status === "over") return;
  const ok = window.confirm("離開將直接判負，確定要離開嗎？");
  if (!ok) return;
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

// 把本回合結算拆成條列項目：每項標明加分歸屬（challenger／challenged）與分數。
// notes 為不影響計分、但需說明的限制狀態。
function scoreItems(msg, timeout) {
  const items = [];
  const notes = [];

  if (timeout) {
    if (msg.awardedTo) {
      items.push({ label: "超時未出手，對方得分", role: msg.awardedTo, pts: msg.awardedPoints });
    }
    return { items, notes };
  }

  const challenger = msg.challenger;
  const challenged = other(challenger);
  const rs = msg.restrictions || [];
  const zhuyinR = rs.find((x) => x.kind === "zhuyin");
  const posR = rs.find((x) => x.kind === "pos");
  const meaningR = rs.find((x) => x.kind === "meaning");
  const positionR = rs.find((x) => x.kind === "position");

  // 違規判定（惡魔模式的注音／詞性／語意限制任一違反）：
  // 直接判挑戰方 +3（多項違規也只計一次），忽略其他分數的加總。
  // 無意義湊字／填充語助詞不再獨立判違規，改由句子合理度反映為負分。
  const zhuyinViolation = !!zhuyinR && msg.zhuyinMatch === false;
  const posViolationHit = !!posR && msg.posViolation === true;
  const meaningViolation = !!meaningR && msg.meaningChanged === false;

  if (zhuyinViolation || posViolationHit || meaningViolation) {
    // 只有第一個違規項計 +3，其餘僅列出原因（避免明細加總大於實得分數）
    let scored = false;
    const pushViolation = (label, devil) => {
      items.push({ label, role: challenger, pts: scored ? 0 : 3, devil });
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
    notes.push(
      items.length > 1
        ? "違規直接判對方 +3（多項違規僅計一次），其他分數不計"
        : "違規直接判對方 +3，其他分數不計",
    );
    return { items, notes };
  }

  // 未違規：句子合理度（一律顯示）：正=句子合理→被挑戰方，負=不合理→挑戰方
  const aLabel = `句子合理度 · ${reasonWord(msg.sentenceScore)}`;
  if (msg.sentenceScore > 0) items.push({ label: aLabel, role: challenged, pts: msg.sentenceScore });
  else if (msg.sentenceScore < 0) items.push({ label: aLabel, role: challenger, pts: -msg.sentenceScore });
  else items.push({ label: aLabel, role: null, pts: 0 });

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
  if (positionR) {
    notes.push(`😈 位置限制不影響計分`);
  }

  return { items, notes };
}

// 單一計分項目的一列
function rowHtml(it) {
  let pts;
  if (!it.role || it.pts === 0) {
    pts = `<span class="sr-pts zero">0 分</span>`;
  } else {
    const mine = it.role === state.you;
    pts = `<span class="sr-pts ${mine ? "me" : "opp"}">${escapeHtml(sideLabel(it.role))} +${it.pts}</span>`;
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
function other(role) {
  return role === "p1" ? "p2" : "p1";
}
function myName() {
  return (state.you && state.names[state.you]) || "你";
}
function oppName() {
  return (state.you && state.names[other(state.you)]) || "對手";
}
// 結算/明細用：自己顯示「你」，對手顯示其名稱
function sideLabel(role) {
  return role === state.you ? "你" : oppName();
}
function flashHint(text) {
  el.hint.textContent = text;
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- 事件綁定 ----------
el.modeOpts.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.mode = btn.dataset.mode;
    el.modeOpts.forEach((b) => b.classList.toggle("active", b === btn));
    el.modeDesc.textContent = MODE_DESC[state.mode];
    // 惡魔模式時顯示「看惡魔模式怎麼玩」連結
    el.btnDevilHelp.hidden = state.mode !== "devil";
  });
});
el.btnPlay.addEventListener("click", play);
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
  if (!me.name) {
    openNameScreen(false);
    return;
  }
  renderPlayerBar();
  register(); // 更新名稱並取回最新戰績
  // 重新整理／斷線後若仍有進行中的對局，連回同一場（斷線判負者會在此取回結果）
  const active = loadActiveGame();
  if (active && active.gameId) {
    state.mode = active.mode || state.mode;
    show("matching");
    el.matchingText.textContent = "重新連線中…";
    connect(active.gameId);
  } else {
    show("start");
  }
}
boot();
