/* 功能使用埋點。

   設計上只有三個目標：
   1. 一次造訪只送 1 個請求（不是每點一次送一個）
   2. 頁面關掉之前一定送得出去
   3. 分析壞掉不能影響網站任何功能

   ── 為什麼要批次 ──
   每個事件各打一個請求的話，一次認真的操作就是幾十個請求。你曾經為了
   auth-hub 一天 508 個請求找過原因，埋點如果不批次會讓那個數字直接失控，
   而且每個請求都在跟使用者的操作搶頻寬。這裡累積在陣列裡，在頁面隱藏或
   關閉時用 sendBeacon 一次送出——sendBeacon 是唯一能在頁面正在關閉時
   還保證送得出去的方法，一般的 fetch 會被瀏覽器直接取消。

   ── 為什麼要匿名識別碼 ──
   沒有它就只算得出「被按了幾次」，算不出「多少人按過」。差別會直接害你
   做錯決定：同一個人反覆點十次，看起來像十個人有興趣。

   這個 id 只是一個隨機字串，存在使用者自己的瀏覽器，不對應任何真實身分，
   也不跨網站——每個服務各自有一份。清掉瀏覽器資料就換一個新的。 */
(function () {
  'use strict';

  // 服務代號（appSlug）不在這裡決定，是各服務 Worker 的轉送端點寫死的。

  // 放在後端才不會被前端改掉——事件掛在哪個服務下是後台分類的依據。
  var ENDPOINT = '/api/events';
  var ANON_KEY = 'udc:anon-id';
  var MAX_BATCH = 30;        // 和後端的 EVENTS_PER_BATCH 一致
  var FLUSH_AFTER_MS = 15000;

  var queue = [];
  var timer = null;

  function randomId() {
    try {
      return crypto.randomUUID().replace(/-/g, '');
    } catch (e) {
      return String(Date.now()) + Math.random().toString(36).slice(2);
    }
  }

  /* localStorage 在無痕視窗、或使用者把網站資料設成封鎖時，讀寫都會拋錯。
     整段包起來，拿不到就退回「這次造訪用完就丟」的臨時 id——統計會略微
     高估人數，但總比整個埋點掛掉、順便把呼叫它的地方一起弄壞好。 */
  var anonId = (function () {
    try {
      var v = localStorage.getItem(ANON_KEY);
      if (!v) { v = randomId(); localStorage.setItem(ANON_KEY, v); }
      return v;
    } catch (e) {
      return randomId();
    }
  })();

  // 這一次造訪。重新整理就換一個，用來看「一次造訪裡做了哪些事」
  var sessionId = randomId();

  /* ── 流量來源 ──

     兩個來源，優先序有意義：

     1. 網址上的 ?src= / ?utm_source=（以及 ?p= / ?utm_campaign=）
     2. 推不出來時，退而求其次從 referrer 的網域推

     為什麼不能只靠 referrer：社群 App 的內建瀏覽器常常根本不送 referrer，
     送了也只會是 'threads.net'——分不出是哪一篇貼文帶進來的。而 Threads
     的 API 在單篇貼文層級沒有 clicks 指標，所以「這篇帶進來幾個人」
     只有自己在連結上標記才答得出來。

     存進 sessionStorage 是必要的：使用者從貼文點進來（帶著參數），
     接著在站內操作、重新整理，網址上的參數就沒了。不記住的話，同一次
     造訪的後續事件會全部變成「直接進入」，而那些正是你想看的轉換動作。 */
  var SRC_KEY = 'udc:src';

  // 認得的網域對應到短代號。認不出來就用網域本身，至少看得出是哪來的
  var HOSTS = [
    [/(^|\.)threads\.(net|com)$/, 'threads'],
    [/(^|\.)instagram\.com$/, 'instagram'],
    [/(^|\.)facebook\.com$/, 'facebook'],
    [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'x'],
    [/(^|\.)google\./, 'google'],
    [/(^|\.)bing\.com$/, 'bing'],
    [/(^|\.)linkedin\.com$/, 'linkedin'],
    [/(^|\.)ptt\.cc$/, 'ptt'],
  ];

  // 後端只收 ^[a-z0-9][a-z0-9_-]{0,31}$，這裡先過一次，
  // 不合格的直接當作沒有——送出去也是被丟掉，白費一個欄位
  function cleanTag(v) {
    if (!v) return null;
    var t = String(v).trim().toLowerCase().slice(0, 32);
    return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(t) ? t : null;
  }

  function hostToSource(host) {
    for (var i = 0; i < HOSTS.length; i++) {
      if (HOSTS[i][0].test(host)) return HOSTS[i][1];
    }
    // 網域也要過濾一次：點會被規則擋掉，換成底線才留得下來
    return cleanTag(host.replace(/^www\./, '').replace(/\./g, '_'));
  }

  var source = (function () {
    var src = null;
    var campaign = null;
    try {
      var q = new URLSearchParams(location.search);
      src = cleanTag(q.get('src') || q.get('utm_source'));
      campaign = cleanTag(q.get('p') || q.get('utm_campaign'));
    } catch (e) { /* 舊瀏覽器沒有 URLSearchParams，往下走 */ }

    // 網址上有就以它為準，順便記住這一次造訪
    if (src) {
      try {
        sessionStorage.setItem(SRC_KEY, JSON.stringify({ src: src, campaign: campaign }));
      } catch (e) {}
      return { src: src, campaign: campaign };
    }

    // 同一次造訪稍早記下來的
    try {
      var saved = JSON.parse(sessionStorage.getItem(SRC_KEY) || 'null');
      if (saved && saved.src) return saved;
    } catch (e) {}

    // 最後才看 referrer。站內互連不算來源，否則每次換頁都會蓋掉真正的來源
    try {
      if (document.referrer) {
        var host = new URL(document.referrer).host;
        if (host && host !== location.host) {
          var fromRef = { src: hostToSource(host), campaign: null };
          try { sessionStorage.setItem(SRC_KEY, JSON.stringify(fromRef)); } catch (e) {}
          return fromRef;
        }
      }
    } catch (e) {}

    return { src: null, campaign: null };
  })();


  function payload() {
    return JSON.stringify({
      anonId: anonId,
      sessionId: sessionId,
      referrer: document.referrer || null,
      lang: (navigator.language || '').slice(0, 16),
      src: source.src,
      campaign: source.campaign,
      events: queue.splice(0, MAX_BATCH),
    });
  }

  function flush(useBeacon) {
    if (queue.length === 0) return;
    if (timer) { clearTimeout(timer); timer = null; }

    var body = payload();
    try {
      /* 頁面正在關閉時只有 sendBeacon 保證送得出去；fetch 會被取消。
         平常（例如滿 30 筆時）走 fetch，因為 sendBeacon 沒辦法帶
         Authorization 標頭，登入的使用者就對不到帳號。 */
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      }
      var headers = { 'Content-Type': 'application/json' };
      // window.UDCAuthToken 由 app.js 在拿到 token 時填上，沒有就是匿名
      if (window.UDCAuthToken) headers.Authorization = 'Bearer ' + window.UDCAuthToken;
      fetch(ENDPOINT, { method: 'POST', headers: headers, body: body, keepalive: true })
        .catch(function () { /* 埋點失敗就算了，不要吵使用者 */ });
    } catch (e) { /* 同上 */ }
  }

  /**
   * 記一個事件。
   * @param {string} name  固定的列舉字串，例如 'report.click'
   * @param {object} [props] 只放列舉值，絕對不要放使用者輸入的內容
   */
  function track(name, props) {
    try {
      if (!name) return;
      queue.push({
        name: name,
        props: props || undefined,
        path: location.pathname,
        // 送出時間不等於發生時間（批次的關係），時間點要在這裡記
        at: Date.now(),
      });
      if (queue.length >= MAX_BATCH) { flush(false); return; }
      if (!timer) timer = setTimeout(function () { flush(false); }, FLUSH_AFTER_MS);
    } catch (e) { /* 埋點永遠不該讓呼叫它的程式炸掉 */ }
  }

  /* 同一個名字在一次造訪裡只記一次。
     像「報告按鈕出現」這種狀態型的事件，每次重畫都記的話，次數會變成
     「畫面重繪了幾次」而不是「多少人看到了」，做漏斗分析時分母整個壞掉。 */
  var once = {};
  function trackOnce(name, props) {
    if (once[name]) return;
    once[name] = true;
    track(name, props);
  }

  /* visibilitychange 才是可靠的時機，不是 beforeunload/unload——
     手機上使用者切換 App 或直接關分頁時，後兩者常常不會觸發。 */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', function () { flush(true); });

  window.UDCTrack = track;
  window.UDCTrackOnce = trackOnce;
})();
