"use strict";

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    start: $("screen-start"),
    help: $("screen-help"),
    matching: $("screen-matching"),
    game: $("screen-game"),
  },
  btnPlay: $("btn-play"),
  btnHelp: $("btn-help"),
  btnHelpBack: $("btn-help-back"),
  btnHelpPlay: $("btn-help-play"),
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

const state = {
  ws: null,
  you: null, // "p1" | "p2"
  sentence: [],
  currentPlayer: null,
  canChallenge: false,
  selectedIndex: null,
  deadline: 0,
  target: 5,
  status: "idle",
  timerRAF: null,
  resultTimer: null,
};

// ---------- 畫面切換 ----------
function show(name) {
  for (const k in el.screens) el.screens[k].classList.toggle("active", k === name);
}

// ---------- 配對 + 連線 ----------
async function play() {
  show("matching");
  el.matchingText.textContent = "配對中…";
  try {
    const res = await fetch("/api/matchmake");
    const { gameId } = await res.json();
    connect(gameId);
  } catch (e) {
    el.matchingText.textContent = "配對失敗，請重試";
    setTimeout(() => show("start"), 1500);
  }
}

function connect(gameId) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/game/${gameId}/ws`);
  state.ws = ws;

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
    if (state.status !== "over") {
      el.matchingText.textContent = "連線中斷";
    }
  };
  ws.onerror = () => {};

  // 保活
  setInterval(() => {
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
      flashHint(msg.message);
      break;
  }
}

function applyRound(msg) {
  state.sentence = msg.sentence;
  state.currentPlayer = msg.currentPlayer;
  state.canChallenge = msg.canChallenge;
  state.deadline = msg.deadline;
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

  const addSlot = (index) => {
    const slot = document.createElement("div");
    slot.className = "slot";
    if (myTurn) {
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
        ? "點選要插入的位置，再輸入一個字"
        : "輸入一個中文字後按「插入」";
  } else {
    el.hint.textContent = "等待對手出手…";
  }
}

function submitInsert() {
  const char = el.charInput.value.trim();
  if (state.selectedIndex === null || !char) return;
  send({ type: "insert", index: state.selectedIndex, char });
  state.status = "sent";
  el.btnSubmit.disabled = true;
  el.btnChallenge.disabled = true;
}

function doChallenge() {
  send({ type: "challenge" });
  el.btnChallenge.disabled = true;
  el.hint.textContent = "質疑中，AI 裁判評分中…";
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

// ---------- 質疑等待畫面 ----------
function showJudging(msg) {
  state.status = "settling";
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);
  const who = msg.challenger === state.you ? "你" : "對手";
  el.ovTitle.textContent = "質疑中";
  el.ovBody.innerHTML = `
    <div class="spinner" style="margin:12px auto"></div>
    <div class="judge-reason">${who}發起質疑，AI 裁判評分中…</div>`;
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

  if (msg.challengedChar === null) {
    // 超時未出手
    const mine = msg.awardedTo === state.you;
    el.ovTitle.textContent = "時間到";
    el.ovBody.innerHTML = `
      <div class="judge-reason">時間到還沒出手</div>
      <div class="award ${mine ? "me" : "opp"}">${mine ? "你" : "對手"} 得 ${msg.awardedPoints} 分</div>
      <div id="ov-count" class="judge-reason"></div>
    `;
  } else {
    const who = msg.challenger === state.you ? "你" : "對手";
    let verdict = "雙方打平，本回合不計分";
    let vClass = "";
    if (msg.awardedTo) {
      const success = msg.delta < 0; // 句子不合理／是語助詞 -> 質疑成立
      const winnerMine = msg.awardedTo === state.you;
      const winnerName = winnerMine ? "你" : "對手";
      verdict = `${success ? "✅ 質疑成立" : "❌ 質疑不成立"} ── ${winnerName} 得 ${msg.awardedPoints} 分`;
      vClass = winnerMine ? "me" : "opp";
    }
    el.ovTitle.textContent = "回合結算";
    el.ovBody.innerHTML = `
      <div class="judge-reason">${who}質疑了「${escapeHtml(msg.challengedChar)}」這個字</div>
      <div class="judge-row">
        <div class="judge-item"><span class="k">句子讀起來</span><span class="v">${reasonWord(msg.A)}</span></div>
        <div class="judge-item"><span class="k">這個字</span><span class="v">${fillerWord(msg.B)}</span></div>
      </div>
      ${msg.reason ? `<div class="judge-reason">AI 裁判：「${escapeHtml(msg.reason)}」</div>` : ""}
      <div class="award ${vClass}">${verdict}</div>
      <div id="ov-count" class="judge-reason"></div>
    `;
  }
  // server 於 nextInMs 後自動推進，這裡只顯示倒數
  el.ovBtn.style.display = "none";
  el.overlay.classList.add("show");

  const label = msg.final ? "秒後公布勝負…" : "秒後進入下一回合…";
  const end = Date.now() + (msg.nextInMs || 10000);
  const countEl = document.getElementById("ov-count");
  const upd = () => {
    const remain = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    countEl.textContent = remain + " " + label;
    if (remain <= 0) clearInterval(state.resultTimer);
  };
  upd();
  state.resultTimer = setInterval(upd, 250);
}

function showGameover(msg) {
  state.status = "over";
  cancelAnimationFrame(state.timerRAF);
  clearInterval(state.resultTimer);
  el.ovBtn.style.display = "";
  const win = msg.winner === state.you;
  el.ovTitle.textContent = win ? "🎉 你贏了！" : "你輸了";
  const reason =
    msg.reason === "opponent_left" ? "對手已離線" : "有人先達到 5 分";
  el.ovBody.innerHTML = `
    <div class="judge-reason">${reason}</div>
    <div class="judge-row">
      <div class="judge-item"><span class="k">我</span><span class="v">${msg.scores[state.you]}</span></div>
      <div class="judge-item"><span class="k">對手</span><span class="v">${msg.scores[other(state.you)]}</span></div>
    </div>
  `;
  el.ovBtn.textContent = "再玩一場";
  el.ovBtn.onclick = () => location.reload();
  el.overlay.classList.add("show");
}

function hideOverlay() {
  clearInterval(state.resultTimer);
  el.overlay.classList.remove("show");
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
function flashHint(text) {
  el.hint.textContent = text;
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- 事件綁定 ----------
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
