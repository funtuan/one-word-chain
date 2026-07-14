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
  btnImport: $("btn-import"),
  btnDeleteAccount: $("btn-delete-account"),
  playerBar: $("player-bar"),
  pbName: $("pb-name"),
  pbStats: $("pb-stats"),
  btnLeaderboard: $("btn-leaderboard"),
  btnLbBack: $("btn-lb-back"),
  lbList: $("lb-list"),
  btnPlay: $("btn-play"),
  btnHelp: $("btn-help"),
  btnHelpBack: $("btn-help-back"),
  btnHelpPlay: $("btn-help-play"),
  modeOpts: document.querySelectorAll(".mode-opt"),
  modeDesc: $("mode-desc"),
  labelMe: $("label-me"),
  labelOpp: $("label-opp"),
  eloMe: $("elo-me"),
  eloOpp: $("elo-opp"),
  restriction: $("restriction"),
  matchingText: $("matching-text"),
  scoreMe: $("score-me"),
  scoreOpp: $("score-opp"),
  turnBadge: $("turn-badge"),
  timerBar: $("timer-bar"),
  timerText: $("timer-text"),
  sentence: $("sentence"),
  hint: $("hint"),
  charInput: $("char-input"),
  btnSubmit: $("btn-submit"),
  btnChallenge: $("btn-challenge"),
  overlay: $("overlay"),
  ovTitle: $("ov-title"),
  ovBody: $("ov-body"),
  ovBtn: $("ov-btn"),
};

const TURN_MS = 20000;
// 語助詞違規門檻：末字語助詞程度 B（0~3）達此值即視為違規（與後端一致）
const FILLER_THRESHOLD = 2;

const state = {
  ws: null,
  you: null, // "p1" | "p2"
  names: { p1: "玩家 1", p2: "玩家 2" }, // 雙方顯示名稱
  ratings: { p1: 1000, p2: 1000 }, // 雙方 ELO 積分
  mode: "normal", // "normal" | "devil"
  restriction: null, // 惡魔模式本回合限制
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
  gameId: null, // 目前對局 id（供斷線重連回同一場）
  reconnectTries: 0, // 斷線後已重連次數
  keepalive: null, // 保活計時器
};

const MODE_DESC = {
  normal: "一般規則，輪流插字接龍。",
  devil: "每回合隨機抽一個限制：位置、注音韻符、星座語氣或詞性，雙方共用。",
};

// ---------- 畫面切換 ----------
function show(name) {
  for (const k in el.screens) el.screens[k].classList.toggle("active", k === name);
}

// ---------- 身分（localStorage，無需登入）----------
const STORE_KEY = "owc:player";
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
async function importAccount() {
  const id = normalizeCode(el.importCode.value);
  if (!id) {
    el.importCode.value = "";
    el.importCode.placeholder = "請貼上帳號代碼";
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
  if (!stats) {
    el.importCode.value = "";
    el.importCode.placeholder = "找不到此帳號代碼對應的帳號";
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
  try {
    const res = await fetch("/api/leaderboard?limit=20");
    const { players } = await res.json();
    renderLeaderboard(players || []);
  } catch {
    el.lbList.innerHTML = `<div class="lb-empty">載入失敗，請稍後再試</div>`;
  }
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
  show("matching");
  el.matchingText.textContent = "配對中…";
  try {
    const res = await fetch(`/api/matchmake?mode=${state.mode}`);
    const { gameId } = await res.json();
    connect(gameId);
  } catch (e) {
    el.matchingText.textContent = "配對失敗，請重試";
    setTimeout(() => show("start"), 1500);
  }
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
    // 非正常中斷：本設計「斷線即判負」，因此嘗試連回同一場，
    // 取回自己敗北的結果並顯示（而非停在「連線中斷」）。
    if ((state.reconnectTries || 0) < RECONNECT_MAX && state.gameId) {
      state.reconnectTries = (state.reconnectTries || 0) + 1;
      show("matching");
      el.matchingText.textContent = "連線中斷，重新連線中…";
      setTimeout(() => connect(state.gameId), RECONNECT_DELAY);
    } else {
      el.matchingText.textContent = "連線中斷";
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
      break;
    case "start":
      state.you = msg.you;
      state.target = msg.target;
      state.mode = msg.mode;
      state.restriction = msg.restriction;
      if (msg.names) state.names = msg.names;
      if (msg.ratings) state.ratings = msg.ratings;
      el.labelMe.textContent = myName();
      el.labelOpp.textContent = oppName();
      el.eloMe.textContent = `${state.ratings[state.you]} 分`;
      el.eloOpp.textContent = `${state.ratings[other(state.you)]} 分`;
      renderRestriction();
      hideOverlay();
      applyRound(msg);
      show("game");
      break;
    case "update":
      applyRound(msg);
      break;
    case "judging":
      showJudging(msg);
      break;
    case "settled":
      showSettled(msg);
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
  state.sentence = msg.sentence;
  state.currentPlayer = msg.currentPlayer;
  state.canChallenge = msg.canChallenge;
  state.deadline = msg.deadline;
  state.allowedPositions =
    msg.allowedPositions === undefined ? null : msg.allowedPositions;
  state.status = "playing";
  state.selectedIndex = null;
  el.charInput.value = "";

  el.scoreMe.textContent = msg.scores[state.you];
  el.scoreOpp.textContent = msg.scores[other(state.you)];

  renderSentence(msg.lastMove);
  updateControls();
  startTimer();
}

// ---------- 句子渲染 ----------
function renderSentence(lastMove) {
  const myTurn = state.currentPlayer === state.you;
  el.sentence.innerHTML = "";
  const chars = state.sentence;

  const allowed = state.allowedPositions;
  const addSlot = (index) => {
    const slot = document.createElement("div");
    slot.className = "slot";
    // 位置限制：不在開放清單的位置變成鎖住、不可點
    const locked = allowed !== null && !allowed.includes(index);
    if (locked) slot.classList.add("locked");
    if (myTurn && !locked) {
      slot.classList.add("tappable");
      if (state.selectedIndex === index) slot.classList.add("selected");
      slot.addEventListener("click", () => selectSlot(index));
    }
    el.sentence.appendChild(slot);
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
function renderRestriction() {
  const r = state.restriction;
  if (!r) {
    el.restriction.hidden = true;
    el.restriction.innerHTML = "";
    return;
  }
  let html = "";
  if (r.kind === "position") {
    html = `<span class="r-tag">😈 位置限制</span><span class="r-text">每回合只開放一半的放入位置（最多 5 個），鎖住的位置不能點。</span>`;
  } else if (r.kind === "zhuyin") {
    const finals = (r.finals || [])
      .map((f) => `<b class="r-final">${escapeHtml(f)}</b>`)
      .join(" ");
    html = `<span class="r-tag">😈 注音限制</span><span class="r-text">放入的字字韻母須為 ${finals}，不符合對手 +3 分。</span>`;
  } else if (r.kind === "zodiac" && r.zodiac) {
    html = `<span class="r-tag">😈 星座限制 · ${escapeHtml(r.zodiac.name)}</span><span class="r-text">句子超過 5 字後，須像${escapeHtml(r.zodiac.name)}會說的話。<br>${escapeHtml(r.zodiac.desc)}</span>`;
  } else if (r.kind === "pos" && r.pos) {
    html = `<span class="r-tag">😈 詞性限制</span><span class="r-text">放入的字不可是 <b class="r-final">${escapeHtml(r.pos)}</b>，違規對手 +3 分。</span>`;
  }
  el.restriction.innerHTML = html;
  el.restriction.hidden = false;
}

function selectSlot(index) {
  state.selectedIndex = index;
  renderSentence(null);
  updateControls();
  el.charInput.focus();
}

// ---------- 控制列 ----------
function updateControls() {
  const myTurn = state.currentPlayer === state.you && state.status === "playing";
  el.turnBadge.textContent = myTurn ? "輪到你" : "對手回合";
  el.turnBadge.classList.toggle("your-turn", myTurn);

  const hasChar = el.charInput.value.trim().length > 0;
  el.charInput.disabled = !myTurn;
  el.btnSubmit.disabled = !(myTurn && hasChar && state.selectedIndex !== null);
  el.btnChallenge.disabled = !(myTurn && state.canChallenge);

  if (myTurn) {
    el.hint.textContent =
      state.selectedIndex === null
        ? "點選要放入的位置，再輸入一個字"
        : "輸入一個中文字後按「放入」";
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

function doChallenge() {
  send({ type: "challenge" });
  el.btnChallenge.disabled = true;
  el.hint.textContent = "挑戰中，AI 裁判評分中…";
}

// ---------- 計時器 ----------
function startTimer() {
  cancelAnimationFrame(state.timerRAF);
  const tick = () => {
    const remain = Math.max(0, state.deadline - Date.now());
    const ratio = Math.min(1, remain / TURN_MS);
    el.timerBar.style.transform = `scaleX(${ratio})`;
    el.timerBar.classList.toggle("low", remain <= 5000);
    el.timerText.textContent = Math.ceil(remain / 1000);
    if (state.status === "playing" || state.status === "sent") {
      state.timerRAF = requestAnimationFrame(tick);
    }
  };
  tick();
}

// ---------- 挑戰等待畫面 ----------
function showJudging(msg) {
  state.status = "settling";
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);
  const who = msg.challenger === state.you ? "你" : "對手";
  el.ovTitle.textContent = "挑戰中";
  el.ovBody.innerHTML = `
    <div class="spinner" style="margin:12px auto"></div>
    <div class="judge-reason">${who}發起挑戰，AI 裁判評分中…</div>`;
  el.ovBtn.style.display = "none";
  el.overlay.classList.add("show");
}

// ---------- 結算 / 結束 彈窗 ----------
function showSettled(msg) {
  state.status = "result";
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);
  el.scoreMe.textContent = msg.scores[state.you];
  el.scoreOpp.textContent = msg.scores[other(state.you)];

  const timeout = msg.challengedChar === null;
  el.ovTitle.textContent = timeout ? "時間到" : "回合結算";

  // AI 評語置頂（超時無評分則略過）
  const reasonHtml = msg.reason
    ? `<div class="ai-verdict"><span class="ai-tag">AI 裁判</span><span class="ai-text">${escapeHtml(msg.reason)}</span></div>`
    : "";

  // 這回合發生什麼
  let infoHtml;
  if (timeout) {
    infoHtml = `<div class="settle-info">時間到還沒出手</div>`;
  } else {
    const who = sideLabel(msg.challenger);
    infoHtml = `<div class="settle-info">${escapeHtml(who)}挑戰了「${escapeHtml(msg.challengedChar)}」這個字</div>`;
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
    ${reasonHtml}
    ${infoHtml}
    <div class="score-sheet">
      <div class="sheet-head">計分明細</div>
      ${rowsHtml}
      ${notesHtml}
      ${totalHtml}
    </div>
    ${changeHtml}
    <div class="settle-count"><div id="ov-count-bar" class="settle-count-bar"></div></div>
  `;
  // server 於 nextInMs 後自動推進，這裡以進度條倒數（不顯示文字）
  el.ovBtn.style.display = "none";
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

function showGameover(msg) {
  state.status = "over";
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
  el.ovBody.innerHTML = `
    <div class="judge-reason">${escapeHtml(reason)}</div>
    <div class="judge-row">
      <div class="judge-item"><span class="k">${escapeHtml(myName())}</span><span class="v">${msg.scores[state.you]}</span></div>
      <div class="judge-item"><span class="k">${escapeHtml(oppName())}</span><span class="v">${msg.scores[other(state.you)]}</span></div>
    </div>
    ${eloHtml}
  `;
  el.ovBtn.textContent = "再玩一場";
  el.ovBtn.onclick = () => location.reload();
  el.overlay.classList.add("show");
  // 對戰結束後更新自身積分（供返回開始頁時顯示最新資料）
  register();
}

function hideOverlay() {
  clearInterval(state.resultTimer);
  el.overlay.classList.remove("show");
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
  const r = msg.restriction;

  // 違規判定（語助詞／注音限制／詞性限制任一違反）：
  // 直接判挑戰方 +3，忽略其他分數的加總。
  const fillerViolation = msg.B >= FILLER_THRESHOLD;
  const zhuyinViolation = r && r.kind === "zhuyin" && msg.zhuyinMatch === false;
  const posViolationHit = r && r.kind === "pos" && msg.posViolation === true;

  if (fillerViolation || zhuyinViolation || posViolationHit) {
    if (fillerViolation) {
      items.push({ label: `語助詞違規 · ${fillerWord(msg.B)}`, role: challenger, pts: 3 });
    }
    if (zhuyinViolation) {
      const finals = escapeHtml((r.finals || []).join(" "));
      items.push({ label: `😈 注音違規（不符 ${finals}）`, role: challenger, pts: 3, devil: true });
    }
    if (posViolationHit) {
      const pos = r.pos ? escapeHtml(r.pos) : "";
      items.push({ label: `😈 詞性違規（是${pos}）`, role: challenger, pts: 3, devil: true });
    }
    notes.push("違規直接判對方 +3，其他分數不計");
    return { items, notes };
  }

  // 未違規：句子合理度（一律顯示）：正=句子合理→被挑戰方，負=不合理→挑戰方
  const aLabel = `句子合理度 · ${reasonWord(msg.A)}`;
  if (msg.A > 0) items.push({ label: aLabel, role: challenged, pts: msg.A });
  else if (msg.A < 0) items.push({ label: aLabel, role: challenger, pts: -msg.A });
  else items.push({ label: aLabel, role: null, pts: 0 });

  // 惡魔模式限制（未違規時的加減分與說明）
  if (r && r.kind === "zhuyin") {
    const finals = escapeHtml((r.finals || []).join(" "));
    notes.push(`😈 注音符合（${finals}），未加減分`);
  } else if (r && r.kind === "zodiac") {
    const zn = r.zodiac ? escapeHtml(r.zodiac.name) : "";
    const s = msg.zodiacScore;
    if (typeof s === "number" && s > 0) {
      items.push({ label: `😈 星座語氣（${zn}）· 很像`, role: challenged, pts: s, devil: true });
    } else if (typeof s === "number" && s < 0) {
      items.push({ label: `😈 星座語氣（${zn}）· 不像`, role: challenger, pts: -s, devil: true });
    } else if (typeof s === "number") {
      notes.push(`😈 星座語氣（${zn}）· 普通，未加減分`);
    } else {
      notes.push(`😈 星座（${zn}）：句子未超過 5 字，不計星座分`);
    }
  } else if (r && r.kind === "pos") {
    const pos = r.pos ? escapeHtml(r.pos) : "";
    notes.push(`😈 詞性符合（非${pos}），未加減分`);
  } else if (r && r.kind === "position") {
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
function fillerWord(b) {
  if (b <= 0) return "有意義";
  if (b === 1) return "有點多餘";
  if (b === 2) return "像語助詞";
  return "根本是語助詞";
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
  });
});
el.btnPlay.addEventListener("click", play);
el.btnHelp.addEventListener("click", () => show("help"));
el.btnHelpBack.addEventListener("click", () => show("start"));
el.btnHelpPlay.addEventListener("click", play);
el.btnSubmit.addEventListener("click", submitInsert);
el.btnChallenge.addEventListener("click", doChallenge);
el.charInput.addEventListener("input", updateControls);
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
  el.importCode.placeholder = "例：OWC-AB23-CD45-EF67";
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
