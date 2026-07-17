// 共用 icon 系統 —— 改用 Flaticon UIcons（Solid Rounded 字型，圓潤實心風格）
// 字型由 CDN 載入：uicons-solid-rounded（見 index.html / admin.html 的 <link>）
// 用法（維持原本 API，不動呼叫端）：
//   HTML：<span class="ic" data-ic="home"></span>  → 載入時自動注入
//   JS  ：window.icon("home")  → 回傳 <i> 字串（可放進 innerHTML 模板）
(function () {
  "use strict";

  // 內部語意名稱 → Flaticon UIcons（fi-sr-*）名稱。
  // 只列實際用到的圖示；名稱皆已對照 uicons-solid-rounded 字型確認存在。
  var MAP = {
    // ---- 功能性 UI ----
    warn: "triangle-warning",
    edit: "edit",
    dice: "dice",
    home: "home",
    key: "key",
    trophy: "trophy",
    book: "book-alt",
    bell: "bell",
    "bell-off": "bell-slash",
    target: "target",
    timer: "stopwatch",
    hourglass: "hourglass",
    help: "interrogation",
    scale: "scale",
    "check-circle": "check-circle",
    "x-circle": "cross-circle",
    pin: "marker",
    type: "text",
    tag: "tags",
    shuffle: "shuffle",
    ban: "ban",
    clipboard: "clipboard",
    x: "cross-small",
    check: "check",
    save: "disk",

    // ---- 遊戲角色／情緒 ----
    devil: "face-smile-horns",
    smile: "smile",
    party: "party-horn",
    crown: "crown",
    medal: "medal",
    eye: "eye",

    // ---- admin 時間軸 ----
    users: "users",
    repeat: "refresh",
    flag: "flag",
    clock: "clock",
    film: "film",
    door: "door-open",
    swords: "sword",
  };

  function icon(name, extraCls) {
    var fi = MAP[name];
    if (fi == null) fi = "interrogation"; // 未知名稱的保底圖示
    var cls = "fi fi-sr-" + fi + " ico" + (extraCls ? " " + extraCls : "");
    return '<i class="' + cls + '" aria-hidden="true"></i>';
  }

  // 把靜態 HTML 裡的 <span data-ic="..."> 注入圖示
  function hydrate(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll("[data-ic]");
    for (var i = 0; i < nodes.length; i++) {
      var elm = nodes[i];
      if (elm.__icDone) continue;
      elm.innerHTML = icon(elm.getAttribute("data-ic"), elm.getAttribute("data-ic-cls"));
      elm.__icDone = true;
    }
  }

  // 注入基礎樣式（app 與 admin 各有獨立樣式表，故由此統一提供）
  // 字型字符大小跟隨 font-size；顏色跟隨 currentColor。
  var css =
    ".ico{font-size:1em;line-height:1;display:inline-block;vertical-align:-.175em;font-style:normal;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}" +
    ".ic{display:inline-flex;align-items:center;justify-content:center;vertical-align:-.175em}" +
    ".ico-gold{color:#f4c74a}.ico-silver{color:#cfd6e6}.ico-bronze{color:#dd9a63}";
  var style = document.createElement("style");
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  window.icon = icon;
  window.hydrateIcons = hydrate;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      hydrate();
    });
  } else {
    hydrate();
  }
})();
