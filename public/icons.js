// 共用 duotone SVG icon 系統（自建，零外部相依）
// 風格：圓潤描邊（.d1）＋ 淡色填充底（.d0），皆用 currentColor 跟隨文字顏色。
// 用法：
//   HTML：<span class="ic" data-ic="home"></span>  → 載入時自動注入
//   JS  ：window.icon("home")  → 回傳 <svg> 字串（可放進 innerHTML 模板）
(function () {
  "use strict";

  // 每個圖示的內層 SVG（viewBox 0 0 24 24）。
  // .d0 = 淡色填充底，.d1 = 描邊主線，.dot = 實心點。
  var I = {
    // ---- 功能性 UI ----
    warn:
      '<path class="d0" d="M10.3 4 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/>' +
      '<path class="d1" d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<path class="d1" d="M12 9v4"/><path class="d1" d="M12 17h.01"/>',
    edit:
      '<path class="d0" d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/>' +
      '<path class="d1" d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/>' +
      '<path class="d1" d="m13.5 6.5 4 4"/>',
    dice:
      '<rect class="d0" x="3" y="3" width="18" height="18" rx="4"/>' +
      '<rect class="d1" x="3" y="3" width="18" height="18" rx="4"/>' +
      '<circle class="dot" cx="8" cy="8" r="1.3"/><circle class="dot" cx="16" cy="8" r="1.3"/>' +
      '<circle class="dot" cx="12" cy="12" r="1.3"/>' +
      '<circle class="dot" cx="8" cy="16" r="1.3"/><circle class="dot" cx="16" cy="16" r="1.3"/>',
    home:
      '<path class="d0" d="M4.5 10.2 12 4l7.5 6.2V19a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/>' +
      '<path class="d1" d="M3 10a2 2 0 0 1 .7-1.5l7-6a2 2 0 0 1 2.6 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' +
      '<path class="d1" d="M9 21v-6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6"/>',
    key:
      '<circle class="d0" cx="7.5" cy="15.5" r="5.5"/>' +
      '<circle class="d1" cx="7.5" cy="15.5" r="5.5"/>' +
      '<path class="d1" d="m11.4 11.6 9.6-9.6"/>' +
      '<path class="d1" d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l1.7-1.7"/>',
    trophy:
      '<path class="d0" d="M18 2H6v7a6 6 0 0 0 12 0z"/>' +
      '<path class="d1" d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path class="d1" d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>' +
      '<path class="d1" d="M4 22h16"/>' +
      '<path class="d1" d="M10 14.7V17c0 .6-.5 1-1 1.2C7.9 18.8 7 20.2 7 22"/>' +
      '<path class="d1" d="M14 14.7V17c0 .6.5 1 1 1.2 1.2.6 2 2 2 3.8"/>' +
      '<path class="d1" d="M18 2H6v7a6 6 0 0 0 12 0z"/>',
    book:
      '<path class="d0" d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>' +
      '<path class="d1" d="M12 7v14"/>' +
      '<path class="d1" d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    bell:
      '<path class="d0" d="M4.3 17h15.4c-1.4-1.4-1.7-3-1.7-9a6 6 0 0 0-12 0c0 6-.3 7.6-1.7 9z"/>' +
      '<path class="d1" d="M10.3 21a2 2 0 0 0 3.4 0"/>' +
      '<path class="d1" d="M3.3 15.3A1 1 0 0 0 4 17h16a1 1 0 0 0 .7-1.7C19.4 14 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.4 6-2.7 7.3"/>',
    "bell-off":
      '<path class="d1" d="M10.3 21a2 2 0 0 0 3.4 0"/>' +
      '<path class="d1" d="M17 17H4a1 1 0 0 1-.7-1.7C4.6 14 6 12.5 6 8a6 6 0 0 1 .3-1.7"/>' +
      '<path class="d1" d="m2 2 20 20"/>' +
      '<path class="d1" d="M8.7 3A6 6 0 0 1 18 8c0 2.7.5 4.6 1.3 6.1"/>',
    target:
      '<circle class="d0" cx="12" cy="12" r="9.5"/>' +
      '<circle class="d1" cx="12" cy="12" r="10"/><circle class="d1" cx="12" cy="12" r="6"/><circle class="d1" cx="12" cy="12" r="2"/>',
    timer:
      '<circle class="d0" cx="12" cy="14" r="8"/>' +
      '<path class="d1" d="M10 2h4"/><path class="d1" d="M12 14 15 11"/><circle class="d1" cx="12" cy="14" r="8"/>',
    hourglass:
      '<path class="d0" d="M7 3h10v3.2a2 2 0 0 1-.6 1.4L12 12 7.6 7.6A2 2 0 0 1 7 6.2z"/>' +
      '<path class="d1" d="M5 22h14"/><path class="d1" d="M5 2h14"/>' +
      '<path class="d1" d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22"/>' +
      '<path class="d1" d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4A2 2 0 0 0 17 6.2V2"/>',
    help:
      '<circle class="d0" cx="12" cy="12" r="9.5"/>' +
      '<circle class="d1" cx="12" cy="12" r="10"/>' +
      '<path class="d1" d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path class="d1" d="M12 17h.01"/>',
    scale:
      '<path class="d1" d="m16 16 3-8 3 8c-.9.7-1.9 1-3 1s-2.1-.3-3-1z"/>' +
      '<path class="d1" d="m2 16 3-8 3 8c-.9.7-1.9 1-3 1s-2.1-.3-3-1z"/>' +
      '<path class="d1" d="M7 21h10"/><path class="d1" d="M12 3v18"/>' +
      '<path class="d1" d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
    "check-circle":
      '<circle class="d0" cx="12" cy="12" r="9.5"/>' +
      '<circle class="d1" cx="12" cy="12" r="10"/><path class="d1" d="m9 12 2 2 4-4"/>',
    "x-circle":
      '<circle class="d0" cx="12" cy="12" r="9.5"/>' +
      '<circle class="d1" cx="12" cy="12" r="10"/><path class="d1" d="m15 9-6 6"/><path class="d1" d="m9 9 6 6"/>',
    pin:
      '<path class="d0" d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/>' +
      '<path class="d1" d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/>' +
      '<circle class="d1" cx="12" cy="10" r="3"/>',
    type:
      '<path class="d1" d="M4 7V4h16v3"/><path class="d1" d="M9 20h6"/><path class="d1" d="M12 4v16"/>',
    tag:
      '<path class="d0" d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/>' +
      '<path class="d1" d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/>' +
      '<circle class="d1" cx="7.5" cy="7.5" r="1.3"/>',
    shuffle:
      '<path class="d1" d="m18 14 4 4-4 4"/><path class="d1" d="m18 2 4 4-4 4"/>' +
      '<path class="d1" d="M2 18h2a4 4 0 0 0 3.3-1.7l5.4-8.6A4 4 0 0 1 16 6h6"/>' +
      '<path class="d1" d="M2 6h2a4 4 0 0 1 3.6 2.2"/>' +
      '<path class="d1" d="M22 18h-6a4 4 0 0 1-3.3-1.8l-.4-.5"/>',
    ban:
      '<circle class="d0" cx="12" cy="12" r="9.5"/>' +
      '<circle class="d1" cx="12" cy="12" r="10"/><path class="d1" d="m4.9 4.9 14.2 14.2"/>',
    clipboard:
      '<path class="d0" d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
      '<rect class="d1" width="8" height="4" x="8" y="2" rx="1"/>' +
      '<path class="d1" d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    x: '<path class="d1" d="M18 6 6 18"/><path class="d1" d="m6 6 12 12"/>',
    check: '<path class="d1" d="M20 6 9 17l-5-5"/>',
    save:
      '<path class="d0" d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
      '<path class="d1" d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
      '<path class="d1" d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/>' +
      '<path class="d1" d="M7 3v4a1 1 0 0 0 1 1h7"/>',

    // ---- 遊戲角色／情緒 ----
    devil:
      '<circle class="d0" cx="12" cy="14" r="7"/>' +
      '<circle class="d1" cx="12" cy="14" r="7"/>' +
      '<path class="d1" d="M7.6 8C5.9 6.3 4.9 4.2 4.7 1.8c2.2.5 4 1.8 5.2 3.7"/>' +
      '<path class="d1" d="M16.4 8c1.7-1.7 2.7-3.8 2.9-6.2-2.2.5-4 1.8-5.2 3.7"/>' +
      '<path class="d1" d="m8.3 12.4 2.6 1.1"/><path class="d1" d="m15.7 12.4-2.6 1.1"/>' +
      '<path class="d1" d="M8.4 16.4c1 1 2.2 1.5 3.6 1.5s2.6-.5 3.6-1.5"/>',
    smile:
      '<circle class="d0" cx="12" cy="12" r="9"/>' +
      '<circle class="d1" cx="12" cy="12" r="9"/>' +
      '<path class="d1" d="M9 10h.01"/><path class="d1" d="M15 10h.01"/>' +
      '<path class="d1" d="M8.5 14c.9 1.1 2.1 1.6 3.5 1.6s2.6-.5 3.5-1.6"/>',
    party:
      '<path class="d0" d="M11 13c1.9 1.9 2.8 4.2 2 5s-3.1-.1-5-2-2.8-4.2-2-5 3.1.1 5 2Z"/>' +
      '<path class="d0" d="M5.8 11.3 2 22l10.7-3.8z"/>' +
      '<path class="d1" d="M5.8 11.3 2 22l10.7-3.8"/>' +
      '<path class="d1" d="M4 3h.01"/><path class="d1" d="M22 8h.01"/><path class="d1" d="M15 2h.01"/><path class="d1" d="M22 20h.01"/>' +
      '<path class="d1" d="m22 2-2.2.8a2.9 2.9 0 0 0-2 3.1c.1.9-.6 1.6-1.4 1.6h-.4c-.9 0-1.6.6-1.8 1.4L14 12"/>' +
      '<path class="d1" d="m22 13-.8-.3c-.9-.3-1.8.2-2 1.1-.1.7-.7 1.2-1.4 1.2H17"/>' +
      '<path class="d1" d="m11 2 .3.8c.3.9-.2 1.8-1.1 2-.7.1-1.2.7-1.2 1.4V7"/>' +
      '<path class="d1" d="M11 13c1.9 1.9 2.8 4.2 2 5s-3.1-.1-5-2-2.8-4.2-2-5 3.1.1 5 2Z"/>',
    crown:
      '<path class="d0" d="M11.6 3.3a.5.5 0 0 1 .9 0l2.9 5.6a1 1 0 0 0 1.5.3l4.3-3.7a.5.5 0 0 1 .8.5l-2.8 10.3a1 1 0 0 1-1 .7H5.8a1 1 0 0 1-1-.7L2 6a.5.5 0 0 1 .8-.5l4.3 3.7a1 1 0 0 0 1.5-.3z"/>' +
      '<path class="d1" d="M11.6 3.3a.5.5 0 0 1 .9 0l2.9 5.6a1 1 0 0 0 1.5.3l4.3-3.7a.5.5 0 0 1 .8.5l-2.8 10.3a1 1 0 0 1-1 .7H5.8a1 1 0 0 1-1-.7L2 6a.5.5 0 0 1 .8-.5l4.3 3.7a1 1 0 0 0 1.5-.3z"/>' +
      '<path class="d1" d="M5 21h14"/>',
    medal:
      '<circle class="d0" cx="12" cy="17" r="5"/>' +
      '<path class="d1" d="M7.2 15 2.7 7.1a2 2 0 0 1 .1-2.2l1.6-2.1A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.1a2 2 0 0 1 .1 2.2L16.8 15"/>' +
      '<path class="d1" d="M11 12 5.1 2.2"/><path class="d1" d="m13 12 5.9-9.8"/><path class="d1" d="M8 7h8"/>' +
      '<circle class="d1" cx="12" cy="17" r="5"/><path class="d1" d="M12 18v-2h-.5"/>',
    eye:
      '<path class="d0" d="M2 12a10.8 10.8 0 0 1 20 0 10.8 10.8 0 0 1-20 0"/>' +
      '<path class="d1" d="M2.1 12.3a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 19.8 0 1 1 0 0 1 0 .7 10.8 10.8 0 0 1-19.8 0"/>' +
      '<circle class="d1" cx="12" cy="12" r="3"/>',

    // ---- admin 時間軸 ----
    users:
      '<circle class="d0" cx="9" cy="7" r="4"/>' +
      '<path class="d1" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle class="d1" cx="9" cy="7" r="4"/>' +
      '<path class="d1" d="M22 21v-2a4 4 0 0 0-3-3.9"/><path class="d1" d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    repeat:
      '<path class="d1" d="m17 2 4 4-4 4"/><path class="d1" d="M3 11v-1a4 4 0 0 1 4-4h14"/>' +
      '<path class="d1" d="m7 22-4-4 4-4"/><path class="d1" d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    flag:
      '<path class="d0" d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>' +
      '<path class="d1" d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>' +
      '<path class="d1" d="M4 22v-7"/>',
    clock:
      '<circle class="d0" cx="12" cy="12" r="9.5"/>' +
      '<circle class="d1" cx="12" cy="12" r="10"/><path class="d1" d="M12 6v6l4 2"/>',
    film:
      '<path class="d0" d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' +
      '<path class="d1" d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/>' +
      '<path class="d1" d="m6.2 5.3 3.1 3.9"/><path class="d1" d="m12.4 3.4 3.1 4"/>' +
      '<path class="d1" d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    door:
      '<path class="d0" d="M13 4.6v16.1a1 1 0 0 1-1.2 1L5 20V5.6a2 2 0 0 1 1.5-2l4-1A2 2 0 0 1 13 4.6Z"/>' +
      '<path class="d1" d="M13 4h3a2 2 0 0 1 2 2v14"/><path class="d1" d="M2 20h3"/><path class="d1" d="M13 20h9"/>' +
      '<path class="d1" d="M10 12v.01"/>' +
      '<path class="d1" d="M13 4.6v16.1a1 1 0 0 1-1.2 1L5 20V5.6a2 2 0 0 1 1.5-2l4-1A2 2 0 0 1 13 4.6Z"/>',
    swords:
      '<polyline class="d1" points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/>' +
      '<path class="d1" d="m13 19 6-6"/><path class="d1" d="m16 16 4 4"/><path class="d1" d="m19 21 2-2"/>' +
      '<polyline class="d1" points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/>' +
      '<path class="d1" d="m5 14 4 4"/><path class="d1" d="m7 17-3 3"/><path class="d1" d="m3 19 2 2"/>',
  };

  var VB = "0 0 24 24";

  function svg(name, extraCls) {
    var inner = I[name];
    if (inner == null) inner = '<circle class="dot" cx="12" cy="12" r="2"/>';
    var cls = "ico" + (extraCls ? " " + extraCls : "");
    return (
      '<svg class="' +
      cls +
      '" viewBox="' +
      VB +
      '" fill="none" aria-hidden="true" focusable="false">' +
      inner +
      "</svg>"
    );
  }

  // 把靜態 HTML 裡的 <span data-ic="..."> 注入圖示
  function hydrate(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll("[data-ic]");
    for (var i = 0; i < nodes.length; i++) {
      var elm = nodes[i];
      if (elm.__icDone) continue;
      elm.innerHTML = svg(elm.getAttribute("data-ic"), elm.getAttribute("data-ic-cls"));
      elm.__icDone = true;
    }
  }

  // 注入基礎樣式（app 與 admin 各有獨立樣式表，故由此統一提供）
  var css =
    ".ico{width:1em;height:1em;display:inline-block;vertical-align:-.24em;flex:none;overflow:visible}" +
    ".ico .d0{fill:currentColor;opacity:.22;stroke:none}" +
    ".ico .d1{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}" +
    ".ico .dot{fill:currentColor;stroke:none}" +
    ".ic{display:inline-flex;align-items:center;justify-content:center;vertical-align:-.24em}" +
    ".ico-gold{color:#f4c74a}.ico-silver{color:#cfd6e6}.ico-bronze{color:#dd9a63}";
  var style = document.createElement("style");
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  window.icon = svg;
  window.hydrateIcons = hydrate;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      hydrate();
    });
  } else {
    hydrate();
  }
})();
