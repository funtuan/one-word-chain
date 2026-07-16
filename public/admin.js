// 戰況數據後台：密碼登入 + 總覽 / 走勢圖 / 最近對戰。純前端，無外部相依。
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
    await Promise.all([loadOverview(), loadDaily(), loadRecent()]);
    document.getElementById("updated").textContent =
      "更新於 " + new Date().toLocaleString("zh-TW", { hour12: false });
  } catch (err) {
    if (err.code === 401) return logout();
    console.error(err);
  }
}

function usd(n) {
  if (!n) return "$0";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

async function loadOverview() {
  const o = await api("overview");
  const cards = [
    { label: "累計對戰", value: o.totalMatches, foot: `註冊玩家 ${o.totalPlayers} 人` },
    { label: "近 24 小時對戰", value: o.matches24h, foot: `近 7 天 ${o.matches7d} 場` },
    { label: "近 7 天活躍玩家", value: o.activePlayers7d, foot: `新增 ${o.newPlayers7d} 人` },
    {
      label: "近 7 天模式分布",
      value: `${o.modeSplit7d.normal}<small> 普通</small> / ${o.modeSplit7d.devil}<small> 惡魔</small>`,
      foot: "普通 / 惡魔",
      raw: true,
    },
    { label: "近 7 天 AI 花費", value: usd(o.aiCost7dUsd), foot: `累計 ${usd(o.aiCostTotalUsd)}`, raw: true },
  ];
  document.getElementById("cards").innerHTML = cards
    .map(
      (c) => `<div class="card">
        <div class="label">${c.label}</div>
        <div class="value">${c.raw ? c.value : fmt(c.value)}</div>
        <div class="foot">${c.foot}</div>
      </div>`,
    )
    .join("");
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
