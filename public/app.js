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
  modeOpts: document.querySelectorAll(".mode-opt"),
  modeDesc: $("mode-desc"),
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

const state = {
  ws: null,
  you: null, // "p1" | "p2"
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
};

const MODE_DESC = {
  normal: "一般規則，輪流插字接龍。",
  devil: "每回合隨機抽一個限制：位置、注音韻符或星座語氣，雙方共用。",
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
    const res = await fetch(`/api/matchmake?mode=${state.mode}`);
    const { gameId } = await res.json();
    connect(gameId);
  } catch (e) {
    el.matchingText.textContent = "配對失敗，請重試";
    setTimeout(() => show("start"), 1500);
  }
}

function connect(gameId) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${proto}://${location.host}/game/${gameId}/ws?mode=${state.mode}`,
  );
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
      state.mode = msg.mode;
      state.restriction = msg.restriction;
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
      // 送出被伺服器拒絕（例如非中文字）時，回到可操作狀態，讓玩家改字或質疑
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
    const who = msg.challenger === state.you ? "你" : "對手";
    infoHtml = `<div class="settle-info">${who}質疑了「${escapeHtml(msg.challengedChar)}」這個字</div>`;
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
    totalHtml = `<div class="sheet-total ${mine ? "me" : "opp"}">本回合加總　${mine ? "你" : "對手"} +${msg.awardedPoints} 分</div>`;
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
      ${changeRow("對手", beforeOpp, afterOpp, msg.awardedTo === opp)}
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
    <div id="ov-count" class="settle-count"></div>
  `;
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

  // 句子合理度（一律顯示）：正=句子合理→被質疑方，負=不合理→質疑方
  const aLabel = `句子合理度 · ${reasonWord(msg.A)}`;
  if (msg.A > 0) items.push({ label: aLabel, role: challenged, pts: msg.A });
  else if (msg.A < 0) items.push({ label: aLabel, role: challenger, pts: -msg.A });
  else items.push({ label: aLabel, role: null, pts: 0 });

  // 語助詞（只有扣分時才顯示）：末字是語助詞→質疑方得分
  if (msg.B > 0) {
    items.push({ label: `語助詞 · ${fillerWord(msg.B)}`, role: challenger, pts: msg.B });
  }

  // 惡魔模式限制
  const r = msg.restriction;
  if (r && r.kind === "zhuyin") {
    const finals = escapeHtml((r.finals || []).join(" "));
    if (msg.zhuyinMatch === false) {
      items.push({ label: `😈 注音不符（${finals}）`, role: challenger, pts: 3, devil: true });
    } else if (msg.zhuyinMatch === true) {
      notes.push(`😈 注音符合（${finals}），未加減分`);
    }
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
    pts = `<span class="sr-pts ${mine ? "me" : "opp"}">${mine ? "你" : "對手"} +${it.pts}</span>`;
  }
  return `<div class="sheet-row${it.devil ? " devil" : ""}"><span class="sr-label">${it.label}</span>${pts}</div>`;
}

// 分數變化的一列：before → after
function changeRow(name, before, after, changed) {
  const val =
    before === after
      ? `<span class="cv same">${after}</span>`
      : `<span class="cv"><span class="cv-old">${before}</span> → <span class="cv-new">${after}</span></span>`;
  return `<div class="change-row${changed ? " changed" : ""}"><span class="ck">${name}</span>${val}</div>`;
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
