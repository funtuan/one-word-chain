// 戰況數據後台：密碼登入 + 總覽 / 走勢圖 / 最近對戰（隨機配對＋好友房多人）。純前端，無外部相依。
"use strict";

const KEY_STORE = "owc_admin_key"; // sessionStorage：關閉分頁即失效
const gate = document.getElementById("gate");
const gateForm = document.getElementById("gate-form");
const gateErr = document.getElementById("gate-err");
const pwInput = document.getElementById("pw");
const pwBtn = document.getElementById("pw-btn");
const dash = document.getElementById("dash");
const rangeSel = document.getElementById("range");

let adminKey = sessionStorage.getItem(KEY_STORE) || "";

// ---- 資料存取 ----

async function api(path) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`/api/admin/${path}${sep}tz=480`, {
    headers: { "x-admin-key": adminKey },
  });
  if (res.status === 401) throw { code: 401 };
  if (res.status === 503) throw { code: 503 };
  if (!res.ok) throw { code: res.status };
  return res.json();
}

// ---- 登入流程 ----

gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = pwInput.value.trim();
  if (!val) return;
  adminKey = val;
  pwBtn.disabled = true;
  gateErr.textContent = "";
  try {
    await api("overview"); // 用一次真實請求驗證密碼
    sessionStorage.setItem(KEY_STORE, adminKey);
    enterDashboard();
  } catch (err) {
    adminKey = "";
    if (err.code === 503) gateErr.textContent = "後台尚未設定密碼（ADMIN_PASSWORD）。";
    else if (err.code === 401) gateErr.textContent = "密碼錯誤。";
    else gateErr.textContent = "連線失敗，請稍後再試。";
  } finally {
    pwBtn.disabled = false;
  }
});

function enterDashboard() {
  gate.classList.add("hidden");
  dash.classList.remove("hidden");
  loadAll();
}

function logout() {
  sessionStorage.removeItem(KEY_STORE);
  adminKey = "";
  dash.classList.add("hidden");
  gate.classList.remove("hidden");
  pwInput.value = "";
  pwInput.focus();
}

document.getElementById("logout").addEventListener("click", logout);
document.getElementById("refresh").addEventListener("click", loadAll);
rangeSel.addEventListener("change", loadDaily);

// ---- 載入與渲染 ----

async function loadAll() {
  try {
    await Promise.all([loadOverview(), loadDaily(), loadRecent(), loadRooms()]);
    document.getElementById("updated").textContent =
      "更新於 " + new Date().toLocaleString("zh-TW", { hour12: false });
  } catch (err) {
    if (err.code === 401) return logout();
    console.error(err);
  }
}

// 共用：把卡片陣列渲染進指定容器
function renderCards(id, cards) {
  document.getElementById(id).innerHTML = cards
    .map(
      (c) => `<div class="card">
        <div class="label">${c.label}</div>
        <div class="value">${c.raw ? c.value : fmt(c.value)}</div>
        <div class="foot">${c.foot}</div>
      </div>`,
    )
    .join("");
}

function usd(n) {
  if (!n) return "$0";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

async function loadOverview() {
  const o = await api("overview");
  // 隨機配對（1 對 1）
  renderCards("cards", [
    { label: "累計對戰", value: o.totalMatches, foot: `註冊玩家 ${o.totalPlayers} 人` },
    { label: "近 24 小時對戰", value: o.matches24h, foot: `近 7 天 ${o.matches7d} 場` },
    { label: "近 7 天活躍玩家", value: o.activePlayers7d, foot: `新增 ${o.newPlayers7d} 人` },
    {
      label: "近 7 天模式分布",
      value: `${o.modeSplit7d.normal}<small> 普通</small> / ${o.modeSplit7d.devil}<small> 惡魔</small>`,
      foot: "普通 / 惡魔",
      raw: true,
    },
    { label: "近 7 天 AI 花費", value: usd(o.aiCost7dUsd), foot: `累計 ${usd(o.aiCostTotalUsd)}（含好友房）`, raw: true },
  ]);
  // 好友房（多人）
  renderCards("room-cards", [
    { label: "累計好友房", value: o.roomTotal, foot: `近 7 天 ${o.roomMatches7d} 場` },
    { label: "近 24 小時好友房", value: o.roomMatches24h, foot: `近 7 天平均 ${o.roomAvgPlayers7d} 人／場`, raw: false },
    { label: "近 7 天活躍玩家", value: o.roomActivePlayers7d, foot: "曾進好友房的相異玩家" },
    {
      label: "近 7 天模式分布",
      value: `${o.roomModeSplit7d.normal}<small> 普通</small> / ${o.roomModeSplit7d.devil}<small> 惡魔</small>`,
      foot: "普通 / 惡魔",
      raw: true,
    },
  ]);
}

async function loadDaily() {
  const days = Number(rangeSel.value);
  const d = await api(`daily?days=${days}`);
  renderBars("chart-matches", d.days, d.matches, "var(--accent)");
  renderLines(
    "chart-players",
    d.days,
    [
      { data: d.active, color: "var(--accent-2)" },
      { data: d.newPlayers, color: "var(--warn)" },
    ],
  );
  renderBars("chart-rooms", d.days, d.roomMatches, "var(--devil)");
}

async function loadRecent() {
  const { matches } = await api("recent-matches?limit=30");
  const body = document.getElementById("matches-body");
  const empty = document.getElementById("matches-empty");
  if (!matches.length) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.innerHTML = matches
    .map((m) => {
      const t = new Date(m.createdAt).toLocaleString("zh-TW", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      });
      const winner = m.winnerName ? `<span class="win">${esc(m.winnerName)}</span>` : "平手";
      const reason = m.reason === "opponent_left" ? '<div class="reason">對手離開</div>' : "";
      const dur = m.durationMs != null ? fmtDur(m.durationMs) : "—";
      const rounds = m.rounds != null ? m.rounds : "—";
      const delta = m.ratingDelta ? "+" + m.ratingDelta : "—";
      return `<tr class="clickable" data-id="${esc(m.id)}">
        <td>${t}</td>
        <td>${esc(m.p1Name)} <span class="reason">vs</span> ${esc(m.p2Name)}</td>
        <td class="num">${m.p1Score} : ${m.p2Score}</td>
        <td>${winner}${reason}</td>
        <td><span class="tag ${m.mode}">${m.mode === "devil" ? "惡魔" : "普通"}</span></td>
        <td class="num">${rounds}</td>
        <td class="num">${dur}</td>
        <td class="num">${delta}</td>
      </tr>`;
    })
    .join("");
  body.querySelectorAll("tr.clickable").forEach((tr) =>
    tr.addEventListener("click", () => openDetail(tr.dataset.id)),
  );
}

// 好友房結束原因中文
const ROOM_REASON = { rounds: "回合打完", players_left: "剩 1 人" };

// 名次條：依 rank 排序的座位；冠軍反白、淘汰者刪除線。
function standingsHtml(players) {
  return (
    '<div class="standings">' +
    players
      .map((p) => {
        const cls = p.eliminated ? "out" : p.rank === 1 ? "top" : "";
        return `<span class="rankchip ${cls}"><span class="rk">${p.rank}</span><span class="nm">${esc(p.name || "（匿名）")}</span> ${p.score}</span>`;
      })
      .join("") +
    "</div>"
  );
}

async function loadRooms() {
  const { rooms } = await api("recent-rooms?limit=30");
  const body = document.getElementById("rooms-body");
  const empty = document.getElementById("rooms-empty");
  if (!rooms.length) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.innerHTML = rooms
    .map((r) => {
      const t = new Date(r.createdAt).toLocaleString("zh-TW", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      });
      return `<tr class="clickable" data-room="${esc(r.id)}">
        <td>${t}</td>
        <td class="num roomcode">${esc(r.roomCode)}</td>
        <td class="num">${r.playerCount}</td>
        <td>${standingsHtml(r.players)}</td>
        <td><span class="tag ${r.mode}">${r.mode === "devil" ? "惡魔" : "普通"}</span></td>
        <td class="num">${r.rounds}</td>
        <td><span class="reason">${ROOM_REASON[r.reason] || esc(r.reason)}</span></td>
      </tr>`;
    })
    .join("");
  body.querySelectorAll("tr.clickable").forEach((tr) =>
    tr.addEventListener("click", () => openRoomDetail(tr.dataset.room)),
  );
}

// ---- 單場詳情彈窗 ----

const overlay = document.getElementById("detail-overlay");
const detailContent = document.getElementById("detail-content");

document.getElementById("detail-close").addEventListener("click", closeDetail);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeDetail();
});

function closeDetail() {
  overlay.classList.add("hidden");
}

const R_LABEL = { position: "位置", zhuyin: "注音", pos: "詞性", meaning: "意思改變" };
function roleName(role, m) {
  return role === "p1" ? m.p1Name : role === "p2" ? m.p2Name : "";
}

async function openDetail(id) {
  overlay.classList.remove("hidden");
  detailContent.innerHTML = '<div class="d-loading">載入中…</div>';
  let data;
  try {
    data = await api(`match?id=${encodeURIComponent(id)}`);
  } catch (err) {
    if (err.code === 401) return logout();
    detailContent.innerHTML = '<div class="d-loading">載入失敗。</div>';
    return;
  }
  renderDetail(data);
}

async function openRoomDetail(id) {
  overlay.classList.remove("hidden");
  detailContent.innerHTML = '<div class="d-loading">載入中…</div>';
  let data;
  try {
    data = await api(`room?id=${encodeURIComponent(id)}`);
  } catch (err) {
    if (err.code === 401) return logout();
    detailContent.innerHTML = '<div class="d-loading">載入失敗。</div>';
    return;
  }
  renderRoomDetail(data);
}

// 好友房座位配色（依 seat 循環），用於詳情內標示 s0..sN
const SEAT_COLORS = [
  "var(--accent)", "var(--devil)", "var(--accent-2)", "var(--warn)",
  "#c08cff", "#ff9f6b", "#6bd3ff", "#ff6b9d",
];
function seatColor(seat) {
  return SEAT_COLORS[seat % SEAT_COLORS.length];
}
// 由座位標籤（"s3"）取得座位序號
function seatIndex(label) {
  return label && label[0] === "s" ? Number(label.slice(1)) : -1;
}

function renderRoomDetail({ match: m, events }) {
  const t = new Date(m.createdAt).toLocaleString("zh-TW", { hour12: false });
  const modeTag = `<span class="tag ${m.mode}">${m.mode === "devil" ? "惡魔" : "普通"}</span>`;
  // seat -> 名稱對照（事件內以座位標籤表示）
  const nameBySeat = new Map(m.players.map((p) => [p.seat, p.name]));
  const roomSeatName = (label) => {
    const i = seatIndex(label);
    return i < 0 ? "" : nameBySeat.get(i) || `座位 ${i}`;
  };

  const head = `<div class="d-head">
    <h2>好友房詳情</h2>
    <div class="d-meta">
      <span>${modeTag}</span>
      <span>🏠 房號 ${esc(m.roomCode)}</span>
      <span>👥 ${m.playerCount} 人</span>
      <span>🔁 ${m.rounds} 回合</span>
      <span>🏁 ${ROOM_REASON[m.reason] || esc(m.reason)}</span>
      <span>🕑 ${t}</span>
    </div>
    <div class="standings" style="margin-top:8px">${m.players
      .map((p) => {
        const cls = p.eliminated ? "out" : p.rank === 1 ? "top" : "";
        return `<span class="rankchip ${cls}"><span class="rk">${p.rank}</span><span class="nm" style="color:${seatColor(p.seat)}">${esc(p.name || "（匿名）")}</span> ${p.score}</span>`;
      })
      .join("")}</div>
  </div>`;

  if (!events.length) {
    detailContent.innerHTML =
      head + '<div class="d-loading">此場沒有詳細過程紀錄（可能為舊資料）。</div>';
    return;
  }

  const groups = [];
  let cur = null;
  for (const e of events) {
    if (!cur || cur.round !== e.round) {
      cur = { round: e.round, items: [] };
      groups.push(cur);
    }
    cur.items.push(e);
  }

  const html = groups
    .map((g) => {
      const rows = g.items.map((e) => renderRoomEvent(e, roomSeatName)).join("");
      return `<div class="round-group">
        <div class="round-title">第 ${g.round} 回合</div>${rows}
      </div>`;
    })
    .join("");

  detailContent.innerHTML = head + html;
}

// 好友房事件列（座位制；比分快照為全座位）
function renderRoomEvent(e, seatName) {
  const whoOf = (label) => {
    if (!label) return "";
    const i = seatIndex(label);
    return `<span class="who" style="color:${seatColor(i)}">${esc(seatName(label))}</span>`;
  };
  const who = whoOf(e.actor);
  const scoreNow =
    e.scores && e.scores.length
      ? `<span class="score-now">${e.scores.join(" : ")}</span>`
      : "";
  let icon = "•";
  let desc = "";
  let sentence = "";
  let sub = "";

  if (e.type === "round_start") {
    icon = "🎬";
    desc = `${who} 先手　種子詞`;
    sentence = `<div class="sentence">${esc(e.sentence || "")}</div>`;
    if (e.restriction) sub = `<div class="sub">${restrictionChips(e.restriction)}</div>`;
  } else if (e.type === "move") {
    icon = "✍️";
    desc = `${who} 接上「<b style="color:var(--accent-2)">${esc(e.char || "")}</b>」`;
    sentence = `<div class="sentence">${sentenceHtml(e.sentence, e.char)}</div>`;
    const added = e.detail && e.detail.addedRestrictions;
    if (added && added.length) {
      sub = `<div class="sub">新增限制：${added.map((k) => `<span class="r-chip">😈 ${R_LABEL[k] || k}</span>`).join("")}</div>`;
    }
  } else if (e.type === "challenge") {
    icon = "⚔️";
    const target = seatName(e.challenged);
    desc = `${who} 挑戰${esc(target)}的「${esc(e.char || "")}」`;
    const award = e.awardedTo
      ? `<span class="award plus">${esc(seatName(e.awardedTo))} +${e.awardedPts}</span>`
      : `<span class="award">平手不計分</span>`;
    const vio = e.violation ? `　違規：${R_LABEL[e.violation] || e.violation}` : "";
    sub = `<div class="sub">合理度 ${e.sentenceScore ?? "—"}　→　${award}${vio}</div>`;
    if (e.reason) sub += `<div class="sub">${esc(e.reason)}</div>`;
    if (e.sentence) sentence = `<div class="sentence">${sentenceHtml(e.sentence, e.char)}</div>`;
  } else if (e.type === "timeout_extend") {
    icon = "⏳";
    desc = `${who} 超時，用掉一次延長（+10 秒，不計分）`;
  } else if (e.type === "timeout") {
    icon = "⏱️";
    const award = e.awardedTo ? `${esc(seatName(e.awardedTo))} +${e.awardedPts}` : "";
    desc = award
      ? `${who} 超時未出手 → <span class="award plus">${award}</span>`
      : `${who} 超時未出手`;
  } else if (e.type === "leave") {
    icon = "🚪";
    desc = `${who} 離開／斷線`;
    if (e.reason) sub = `<div class="sub">${esc(e.reason)}</div>`;
  } else if (e.type === "game_over") {
    icon = "🏁";
    const winner = seatName(e.winner);
    desc = winner ? `本場結束 — ${esc(winner)} 勝` : "本場結束";
  } else {
    desc = `${who} ${esc(e.type)}`;
  }

  return `<div class="ev">
    <div class="icon">${icon}</div>
    <div class="body"><div class="desc">${desc}</div>${sentence}${sub}</div>
    ${scoreNow}
  </div>`;
}

function renderDetail({ match: m, events }) {
  const t = new Date(m.createdAt).toLocaleString("zh-TW", { hour12: false });
  const modeTag = `<span class="tag ${m.mode}">${m.mode === "devil" ? "惡魔" : "普通"}</span>`;
  const winnerTxt = m.winner ? esc(roleName(m.winner, m)) + " 勝" : "平手";
  const reasonTxt = m.reason === "opponent_left" ? "（對手離開）" : "";

  const head = `<div class="d-head">
    <h2>對戰詳情</h2>
    <div class="d-score">
      <span class="p1">${esc(m.p1Name)}</span>
      <span class="sep">${m.p1Score} : ${m.p2Score}</span>
      <span class="p2">${esc(m.p2Name)}</span>
    </div>
    <div class="d-meta">
      <span>${modeTag}</span>
      <span>🏆 ${winnerTxt}${reasonTxt}</span>
      <span>🕑 ${t}</span>
      ${m.ratingDelta ? `<span>Δ積分 +${m.ratingDelta}</span>` : ""}
    </div>
  </div>`;

  if (!events.length) {
    detailContent.innerHTML =
      head + '<div class="d-loading">此場沒有詳細過程紀錄（可能為舊資料）。</div>';
    return;
  }

  // 依回合分組
  const groups = [];
  let cur = null;
  for (const e of events) {
    if (!cur || cur.round !== e.round) {
      cur = { round: e.round, items: [] };
      groups.push(cur);
    }
    cur.items.push(e);
  }

  const html = groups
    .map((g) => {
      const rows = g.items.map((e) => renderEvent(e, m)).join("");
      return `<div class="round-group">
        <div class="round-title">第 ${g.round} 回合</div>${rows}
      </div>`;
    })
    .join("");

  detailContent.innerHTML = head + html;
}

// 帶入句子並把被結算／剛接上的字highlight（依 char 首次出現）
function sentenceHtml(sentence, hlChar) {
  if (!sentence) return "";
  const safe = esc(sentence);
  if (hlChar) {
    const i = sentence.indexOf(hlChar);
    if (i >= 0) {
      return (
        esc(sentence.slice(0, i)) + "<b>" + esc(hlChar) + "</b>" + esc(sentence.slice(i + 1))
      );
    }
  }
  return safe;
}

function restrictionChips(restriction) {
  if (!restriction) return "";
  return restriction
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => `<span class="r-chip">😈 ${R_LABEL[k] || k}</span>`)
    .join("");
}

function renderEvent(e, m) {
  const who = e.actor
    ? `<span class="who ${e.actor}">${esc(roleName(e.actor, m))}</span>`
    : "";
  const scoreNow = `<span class="score-now">${e.p1Score}:${e.p2Score}</span>`;
  let icon = "•";
  let desc = "";
  let sentence = "";
  let sub = "";

  if (e.type === "round_start") {
    icon = "🎬";
    desc = `${who} 先手　種子詞`;
    sentence = `<div class="sentence">${esc(e.sentence || "")}</div>`;
    if (e.restriction) sub = `<div class="sub">${restrictionChips(e.restriction)}</div>`;
  } else if (e.type === "move") {
    icon = "✍️";
    desc = `${who} 接上「<b style="color:var(--accent-2)">${esc(e.char || "")}</b>」`;
    sentence = `<div class="sentence">${sentenceHtml(e.sentence, e.char)}</div>`;
    const added = e.detail && e.detail.addedRestrictions;
    if (added && added.length) {
      sub = `<div class="sub">新增限制：${added.map((k) => `<span class="r-chip">😈 ${R_LABEL[k] || k}</span>`).join("")}</div>`;
    }
  } else if (e.type === "challenge") {
    icon = "⚔️";
    const target = e.challenged ? roleName(e.challenged, m) : "";
    desc = `${who} 挑戰${esc(target)}的「${esc(e.char || "")}」`;
    const award =
      e.awardedTo
        ? `<span class="award plus">${esc(roleName(e.awardedTo, m))} +${e.awardedPts}</span>`
        : `<span class="award">平手不計分</span>`;
    const vio = e.violation ? `　違規：${R_LABEL[e.violation] || e.violation}` : "";
    sub = `<div class="sub">合理度 ${e.sentenceScore ?? "—"}　→　${award}${vio}</div>`;
    if (e.reason) sub += `<div class="sub">${esc(e.reason)}</div>`;
    if (e.sentence) sentence = `<div class="sentence">${sentenceHtml(e.sentence, e.char)}</div>`;
  } else if (e.type === "timeout_extend") {
    icon = "⏳";
    desc = `${who} 超時，用掉一次延長（+10 秒，不計分）`;
  } else if (e.type === "timeout") {
    icon = "⏱️";
    const award = e.awardedTo ? `${esc(roleName(e.awardedTo, m))} +${e.awardedPts}` : "";
    desc = `${who} 超時未出手 → <span class="award plus">${award}</span>`;
  } else if (e.type === "leave") {
    icon = "🚪";
    const winner = e.winner ? roleName(e.winner, m) : "";
    desc = `${who} 離開／斷線 → ${esc(winner)} 判勝`;
  } else if (e.type === "game_over") {
    icon = "🏁";
    const winner = e.winner ? roleName(e.winner, m) : "";
    desc = `本場結束 — ${esc(winner)} 勝`;
  } else {
    desc = `${who} ${esc(e.type)}`;
  }

  return `<div class="ev">
    <div class="icon">${icon}</div>
    <div class="body"><div class="desc">${desc}</div>${sentence}${sub}</div>
    ${scoreNow}
  </div>`;
}

// ---- 小工具 ----

function fmt(n) {
  return typeof n === "number" ? n.toLocaleString("zh-TW") : n;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "秒";
  const m = Math.floor(s / 60);
  return m + "分" + (s % 60) + "秒";
}
// 稀疏顯示 X 軸標籤：資料點多時只標示部分，避免重疊。
function labelStep(n) {
  return Math.ceil(n / 8);
}
function shortDay(d) {
  return d.slice(5); // MM-DD
}

// ---- SVG 圖表 ----

const W = 720, H = 220, PAD_L = 36, PAD_R = 12, PAD_T = 12, PAD_B = 28;
const plotW = W - PAD_L - PAD_R;
const plotH = H - PAD_T - PAD_B;

function niceMax(v) {
  if (v <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

// 共用：Y 軸格線 + 刻度 + X 軸日期標籤，回傳需插入 svg 內的字串。
function axes(days, max) {
  const ticks = 4;
  let s = "";
  for (let i = 0; i <= ticks; i++) {
    const val = Math.round((max / ticks) * i);
    const y = PAD_T + plotH - (plotH * i) / ticks;
    s += `<line class="grid" x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" />`;
    s += `<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end">${val}</text>`;
  }
  const step = labelStep(days.length);
  days.forEach((d, i) => {
    if (i % step !== 0 && i !== days.length - 1) return;
    const x = PAD_L + (plotW * (i + 0.5)) / days.length;
    s += `<text x="${x}" y="${H - 8}" text-anchor="middle">${shortDay(d)}</text>`;
  });
  return s;
}

function renderBars(id, days, data, color) {
  const max = niceMax(Math.max(1, ...data));
  const bw = (plotW / days.length) * 0.62;
  let bars = "";
  data.forEach((v, i) => {
    const h = (plotH * v) / max;
    const x = PAD_L + (plotW * (i + 0.5)) / days.length - bw / 2;
    const y = PAD_T + plotH - h;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"><title>${days[i]}：${v}</title></rect>`;
  });
  mount(id, axes(days, max) + bars);
}

function renderLines(id, days, series) {
  const allVals = series.flatMap((s) => s.data);
  const max = niceMax(Math.max(1, ...allVals));
  const xOf = (i) => PAD_L + (plotW * (i + 0.5)) / days.length;
  const yOf = (v) => PAD_T + plotH - (plotH * v) / max;
  let paths = "";
  for (const s of series) {
    const pts = s.data.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`);
    paths += `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${pts.join(" ")}" />`;
    paths += s.data
      .map(
        (v, i) =>
          `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="2.5" fill="${s.color}"><title>${days[i]}：${v}</title></circle>`,
      )
      .join("");
  }
  mount(id, axes(days, max) + paths);
}

function mount(id, inner) {
  document.getElementById(id).innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>`;
}

// ---- 啟動：若 sessionStorage 已有密碼則自動嘗試 ----
if (adminKey) {
  api("overview")
    .then(enterDashboard)
    .catch(() => {
      adminKey = "";
      sessionStorage.removeItem(KEY_STORE);
      pwInput.focus();
    });
} else {
  pwInput.focus();
}
