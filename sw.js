/* UNDERCURRENT service worker
   只快取「畫面外殼」(HTML/CSS/JS/icons)，讓 PWA 符合可安裝條件、離線時
   還能開得起來。

   兩條規則不能違反，違反過一次代價很大：

   1. 跨網域的請求一律不碰。登入與付費權限都是打 auth-hub（另一個網域），
      這些回應如果被存進 Cache Storage，使用者會拿到「開通前」的舊答案，
      而且怎麼重整都好不了——因為 fetch 的 cache:'no-store' 擋不住
      service worker（SW 在 HTTP 快取之前攔截），伺服器回的
      Cache-Control: no-store 也擋不住（caches.put() 不看回應標頭）。
      只有 Ctrl+Shift+R 能繞過，這不是使用者該知道的事。

   2. 程式碼走網路優先。app.js / style.css 的檔名沒有版本雜湊，cache-first
      的話新版部署了也送不到已安裝過的使用者手上，而且是永久的。網路優先
      多花一次往返，但離線時仍會回退到快取，PWA 的離線能力沒有損失。 */
const CACHE_VERSION = 'udc-shell-v4';

const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/report-template.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  // 版本號變了就把舊快取整個丟掉。上一版把 auth-hub 的權限查詢結果也存了
  // 進去，那些資料必須清掉，不然使用者會一直卡在舊答案。
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** 網路優先、離線回退快取；成功時順便更新快取 */
function networkFirst(request, cacheKey) {
  return fetch(request)
    .then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(cacheKey || request, copy));
      }
      return res;
    })
    .catch(() => caches.match(cacheKey || request));
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 規則 1：不是自己網域的東西一律交還給瀏覽器，我們完全不插手。
  // auth-hub 的 /auth/refresh、/entitlements/check、Google 字型都走這裡。
  if (url.origin !== self.location.origin) return;

  // 自己的 API 也不快取，避免拿到過期的公司/人物資料
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          // 只有首頁能當離線外殼。之前不分頁面一律存成 /index.html，
          // 結果是逛過 /login 之後，離線開首頁會看到登入頁。
          if (res && res.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put('/index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(networkFirst(request));
});
