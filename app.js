/* ---------------------------------------------------------
   設定：呼叫同源的 Cloudflare Pages Functions，
   由 Function 在伺服器端轉發到 GCIS / Google News / 環境部，避免瀏覽器 CORS 限制。
--------------------------------------------------------- */
const PROXY_BASE = '/api/gcis';
const EP_COMPANIES_BY_PERSON = '4B61A0F1-458C-43F9-93F3-9FD6DA5E1B08';
const EP_DIRECTORS_BY_UBN    = '4E5F7653-1B91-4DDC-99D5-468530FAE396';
const EP_DETAIL_BY_UBN       = '5F64D864-61CB-4D0D-8AD9-492047CC1EA6';
const EP_COMPANY_BY_KEYWORD  = '6BBA2268-1367-4B42-9CCA-BC17499EBE8C';
const EP_BRANCHES_BY_UBN     = 'FDB8D2C8-573D-4276-BFA4-8D3925ABE1CB';

const HEALTHY_STATUS_HINTS = ['核准設立'];

/* ---------------------------------------------------------
   身分與付費權限——都問 auth-hub，這個站自己不管帳號。

   流程：refresh token 存在 .kentshen.com（或舊的 .observer1220.workers.dev）
   這個共用網域的 cookie 裡（Google 登入時由 auth-hub 種下），所以這裡雖然是不同的
   子網域，也帶得上。用它跟 auth-hub 換一個短效期的 access token，
   再拿 access token 去問「這個人有沒有買商業模式報告」。

   access token 只存在記憶體裡、15 分鐘就過期，不寫進 localStorage
   ——就算頁面被 XSS 注入，能偷到的也只是一個很快就失效的憑證。

   真正擋下未付費呼叫的是伺服器端 handleBusinessModelReportGenerate
   前面的 requireEntitlement（它會把 token 轉發給 auth-hub 驗），
   這裡的旗標只決定「要不要顯示按鈕」，不是安全邊界。
--------------------------------------------------------- */
// 兩套網域並存（kentshen.com 與 workers.dev）：登入 cookie 只在各自那一邊帶得上，
// 所以從哪個網域進來就用哪一邊的 auth-hub 與訂閱頁。
const ON_CUSTOM_DOMAIN = location.hostname.endsWith('.kentshen.com');
const AUTH_HUB = ON_CUSTOM_DOMAIN
  ? 'https://auth.kentshen.com'
  : 'https://auth-hub.observer1220.workers.dev';
/* 訂閱頁。它自己會用共用網域的 cookie 認出是誰，不用在網址帶身分資訊。

   ?product=undercurrent 一定要帶。那一頁同時服務好幾個工具，沒帶參數時
   會退回通用的贊助頁文案——那份文案寫的是「並非購買任何付費產品或服務、
   贊助後不會解鎖任何額外功能」，跟這裡實際在賣的東西完全相反，等於在
   使用者要付錢的當下自打嘴巴。帶了才會顯示這個產品自己的標題、單位
   （份）與正確的說明。順帶也讓權限掛到正確的產品上，之後再加新產品時
   不會誤用預設值。 */
const SUBSCRIBE_URL = (ON_CUSTOM_DOMAIN
  ? 'https://pay.kentshen.com/'
  : 'https://ecpay-donation.observer1220.workers.dev/') + '?product=undercurrent';

let authAccessToken = null;
let authTokenIssuedAt = 0;
let canGenerateReport = false;
let authUser = null;
let quotaRemaining = null;   // null = 不限次數
let quotaTotal = null;       // 這個週期總共幾次；null = 不限次數
/* 開通日與到期日。auth-hub 回來的是 D1 的 'YYYY-MM-DD HH:MM:SS'（UTC）。

   為什麼要拿這兩個值：選單原本只寫「本月還可使用 N 次」，但那個「本月」
   並不是日曆月——額度是在每次付款成功的當下歸零的，週期跟著訂閱走。
   使用者看不出來次數什麼時候會回補，也看不出服務哪天到期。 */
let entitlementGrantedAt = null;
let entitlementExpiresAt = null;
// refresh 那一趟是否已經把權限帶回來了——有的話就不用再單獨查一次
let authEntitlementFresh = false;

/* access token 活 15 分鐘，這裡抓 12 分鐘就換新的，留一點餘裕，
   避免使用者剛好在過期邊緣按下按鈕。

   authRefreshPromise 是必要的，不是最佳化：auth-hub 的 refresh token 採
   輪替制（用掉就撤銷、發新的），所以同一個 token 只能用一次。如果頁面
   載入時的 initAuth 還沒回來、使用者就按了按鈕，兩個請求會帶著同一個
   cookie 出去，先到的把它換掉、後到的必定失敗——使用者會看到「登入狀態
   已失效」或按鈕整個不見。這裡讓後來的呼叫共用同一個進行中的請求，
   任何時刻最多只有一個 refresh 在飛。 */
let authRefreshPromise = null;

async function getAccessToken(){
  if(authAccessToken && Date.now() - authTokenIssuedAt < 12 * 60 * 1000) return authAccessToken;
  if(authRefreshPromise) return authRefreshPromise;

  authRefreshPromise = (async () => {
    try{
      // 帶上 app/feature，auth-hub 會把權限狀態跟 token 一起回來。
      // 省掉的不只是一個請求：單獨查權限要帶 Authorization，那是跨網域
      // 非簡單請求，瀏覽器會先送一個 OPTIONS 預檢，所以實際省下 2 個。
      const res = await fetch(
        AUTH_HUB + '/auth/refresh?app=undercurrent&feature=business-model-report',
        { method: 'POST', credentials: 'include', cache: 'no-store' }
      );
      if(!res.ok){
        // 只有在自己確實沒拿到新 token 時才清空，不要覆蓋掉別人剛存進來的有效 token
        authAccessToken = null;
        authUser = null;
        return null;
      }
      const data = await res.json();
      authAccessToken = data.accessToken || null;
      authTokenIssuedAt = Date.now();
      // 讓 track.js 的非 beacon 送出帶得上 Authorization，事件才對得到帳號
      window.UDCAuthToken = authAccessToken;
      authUser = data.user || null;   // refresh 本來就會回傳 user，不必再打一次 /me
      if(data.entitlement){
        canGenerateReport = data.entitlement.allowed === true;
        quotaRemaining = data.entitlement.remaining ?? null;
        quotaTotal = data.entitlement.quota ?? null;
        entitlementGrantedAt = data.entitlement.grantedAt ?? null;
        entitlementExpiresAt = data.entitlement.expiresAt ?? null;
        authEntitlementFresh = true;
      }
      return authAccessToken;
    } catch(err){
      authAccessToken = null;
      authUser = null;
      return null;
    } finally {
      authRefreshPromise = null;
    }
  })();

  return authRefreshPromise;
}

/* auth-hub 回來的時間是 D1 的 'YYYY-MM-DD HH:MM:SS'，UTC，但字串裡
   沒有任何時區標記。直接丟給 new Date() 的話瀏覽器會當成「當地時間」，
   台灣使用者看到的時間會整整早 8 小時——跨到午夜前後的那些筆，顯示出來
   會差一整天。補上 T 和 Z 讓它明確是 UTC，再讓瀏覽器轉回當地時間。 */
function parseUtc(str){
  if(!str) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)
    ? str.replace(' ', 'T') + 'Z'
    : str;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(str){
  const d = parseUtc(str);
  if(!d) return null;
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
}

/* 選單裡的短日期。同一年就不寫年份——訂閱週期是一個月，到期日幾乎
   都落在今年，「2026/」四個字每次都佔位子卻沒帶任何資訊。跨年的到期
   日才補上年份，避免「1/22」看不出是明年。 */
function formatDateShort(str){
  const d = parseUtc(str);
  if(!d) return null;
  const md = (d.getMonth() + 1) + '/' + d.getDate();
  return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '/' + md;
}

/* 還剩幾天。用當地日期的「日界線」相減，不是用 24 小時的倍數——
   今天晚上 11 點看，明天早上 8 點到期應該顯示「剩 1 天」而不是「剩 0 天」。 */
function daysUntil(str){
  const d = parseUtc(str);
  if(!d) return null;
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((endOfDay - today) / 86400000);
}

/* 埋點的薄包裝。

   track.js 沒載入時（被擋、快取沒更新）這兩支就是空操作——分析是附加價值，
   不該讓任何一個真正的功能因為它而壞掉。所有呼叫端都走這裡，不要直接碰
   window.UDCTrack。 */
function track(name, props){
  try{ if(window.UDCTrack) window.UDCTrack(name, props); } catch(err){}
}
function trackOnce(name, props){
  try{ if(window.UDCTrackOnce) window.UDCTrackOnce(name, props); } catch(err){}
}

/* displayName 來自 Google 帳號，是使用者可以自己改的字串，
   直接插進 innerHTML 等於讓人在自己的頁面上執行任意 HTML。
   自己改自己的頁面危害有限，但沒有理由留這個洞。 */
function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

async function initAuth(){
  authEntitlementFresh = false;
  const token = await getAccessToken();
  if(!token){ renderAccountMenu(); return; }
  // refresh 那一趟已經給答案了，不用再問一次
  if(authEntitlementFresh){ renderAccountMenu(); return; }
  try{
    // 用 POST：權限答案不能被快取，而 GET 會被瀏覽器快取、Service Worker
    // 快取、以及 Cloudflare 邊緣快取分別存一份（這三層都各自咬過我們一次）。
    // POST 不會被其中任何一層快取，不必再靠 cache 選項逐層防守。
    const res = await fetch(
      AUTH_HUB + '/entitlements/check?app=undercurrent&feature=business-model-report',
      { method: 'POST', headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' }
    );
    if(res.ok){
      const data = await res.json();
      canGenerateReport = data.allowed === true;
      // remaining 為 null 代表不限次數（後台手動開通的）
      quotaRemaining = data.remaining ?? null;
      quotaTotal = data.quota ?? null;
      entitlementGrantedAt = data.grantedAt ?? null;
      entitlementExpiresAt = data.expiresAt ?? null;
    }
  } catch(err){ /* 問不到就當作沒買，按鈕不顯示 */ }
  renderAccountMenu();
}

/* 帳號選單：登入狀態、權限狀態、登出。
   這裡顯示的東西都只是「告知」，擋下未付費呼叫的是伺服器端的
   requireEntitlement，改這裡的任何值都拿不到報告。 */
/* 把權限狀態掛在 <body> 上，而不是在渲染面板時用 if 決定要不要輸出按鈕。

   原因是 initAuth() 是非同步的：使用者可能在它回來之前就查完一間公司，
   那時面板已經畫好、canGenerateReport 還是 false，按鈕就永遠不會出現，
   除非重新整理——這正是「有時候按了沒反應」的來源。改成永遠把按鈕放進
   DOM、用 CSS 控制可見性之後，權限一確認就會立刻顯示，不用重畫面板。

   （按鈕看不看得到不是安全邊界，伺服器端的 requireEntitlement 才是。） */
function applyReportAccessClass(){
  document.body.classList.toggle('has-report-access', canGenerateReport === true);
  /* 「按鈕看得到」是整個付費漏斗的分母。用 trackOnce 是必要的：
     這個函式每次權限狀態變動都會跑，每次都記的話，次數會變成
     「畫面重繪幾次」而不是「多少人看到了」，漏斗的比例會整個失真。 */
  if(canGenerateReport === true) trackOnce('report.available');
}

/* 已經生成好、可以公開當範例的那份報告 id（/report.html?id=）。
   目前資料庫裡還沒有任何一份存檔成功的報告，所以先留空——留空時說明
   視窗不會出現「看範例」那個連結。之後產出第一份報告，把 id 填進來
   就會自動出現，不用再改別的地方。 */
const SAMPLE_REPORT_ID = '';

/* 沒有訂閱的人點「生成商業模式報告」時開這個視窗。
   在這裡才第一次讓人知道這個功能存在、會產出什麼——所以視窗開啟本身
   要記一筆，它是「看到報價」這一層的分母。 */
function openPaywall(companyName){
  const modal = document.getElementById('paywallModal');
  if(!modal) return;
  /* 只取第一行：傳進來的名稱有時會夾帶統編（節點標籤是「公司名\n統編」，
     而 full.name 也不保證乾淨）。這裡是行銷文案的一部分，混一組統編進去
     會顯得很隨便。 */
  const cleanName = String(companyName || '').split('\n')[0].trim();
  const nameEl = document.getElementById('paywallCompany');
  if(nameEl) nameEl.textContent = cleanName || '這間公司';

  const cta = document.getElementById('paywallCta');
  if(cta) cta.href = SUBSCRIBE_URL;

  const sample = document.getElementById('paywallSample');
  if(sample){
    if(SAMPLE_REPORT_ID){
      sample.href = '/report.html?id=' + encodeURIComponent(SAMPLE_REPORT_ID);
      sample.style.display = 'block';
    } else {
      sample.style.display = 'none';
    }
  }

  modal.classList.add('open');
  track('paywall.view', { company: companyName });
}

function closePaywall(){
  document.getElementById('paywallModal')?.classList.remove('open');
}

/* ---------------------------------------------------------
   安裝到裝置（PWA）

   manifest.json 跟 service worker 都已經設定好，可以安裝，但沒有任何
   UI 告訴使用者這件事存在——這個功能等於不存在。放進帳號選單而不是自動
   彈出：安裝是「使用者想要更常回來用」才有意義的動作，不是每個人都需要，
   跳出來會變成騷擾；但要讓想要的人隨時找得到。

   Android／桌機 Chrome、Edge 支援 beforeinstallprompt：瀏覽器覺得「這個
   網站夠格」才會觸發，所以事件可能永遠不來（例如還沒滿足瀏覽次數門檻），
   點擊時沒有存到事件就退回顯示手動步驟，不能假設一定收得到。
   iOS Safari／iOS 上的其他瀏覽器完全沒有這個 API，只能用文字教怎麼做，
   而且不同瀏覽器的選單長得不一樣，只講 Safari 版本的步驟。
--------------------------------------------------------- */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // 擋掉瀏覽器自己的小工具列提示，改成我們自己的入口觸發
  deferredInstallPrompt = e;
});
// 使用者真的安裝完成後就不用再顯示這個選項了
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; renderAccountMenu(); });

function isStandaloneDisplay(){
  // iOS Safari 用的是非標準的 navigator.standalone；其他瀏覽器看 display-mode
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function handleInstallClick(){
  if(deferredInstallPrompt){
    track('install.prompt_native');
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null; // 每個 beforeinstallprompt 事件只能 prompt() 一次
    try{
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      track('install.native_result', { outcome: choice.outcome });
    } catch(err){ /* 使用者在原生對話框裡點掉，不用特別處理 */ }
    return;
  }
  // 沒有原生安裝事件可用（iOS、還沒觸發、或瀏覽器不支援）→ 顯示手動步驟
  track('install.manual_instructions');
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const el = document.getElementById('installInstructions');
  el.innerHTML = isIOS
    ? '點下方的 <b>分享</b> 圖示（方框加向上箭頭），選單裡選<b>「加入主畫面」</b>，之後就能像 App 一樣從主畫面直接打開，不用每次找瀏覽器分頁。'
    : '在瀏覽器右上角的選單裡找<b>「安裝應用程式」</b>或<b>「新增至主畫面」</b>（不同瀏覽器的文字略有不同）。';
  document.getElementById('installModal').classList.add('open');
}
document.getElementById('closeInstallModal').addEventListener('click', () => {
  document.getElementById('installModal').classList.remove('open');
});

function renderAccountMenu(){
  applyReportAccessClass();
  /* 選單裡所有指向訂閱頁的連結共用一個委派監聽。

     逐一綁的話，每次重畫選單都要重綁一次，而這個函式切換主題、更新權限
     狀態時都會跑——很容易變成同一個連結被綁上好幾個監聽、一次點擊記到
     好幾筆。委派到容器上就沒有這個問題。 */
  const menuEl = document.getElementById('accountMenu');
  if(menuEl && !menuEl.dataset.trackBound){
    menuEl.dataset.trackBound = '1';
    menuEl.addEventListener('click', (e) => {
      const link = e.target.closest('a[href^="' + SUBSCRIBE_URL + '"]');
      if(link) track('subscribe.click', { from: 'account_menu' });
    });
  }
  const menu = document.getElementById('accountMenu');
  const btn = document.getElementById('accountBtn');
  if(!menu || !btn) return;

  /* 「切換亮暗」和「使用說明」原本各佔一顆工具列按鈕。它們和其他按鈕
     不是同一類——那些是對這張關係圖做操作，這兩個是偏好設定和文件。
     移進來之後工具列少兩顆，窄視窗不會再擠到第三列；而 avatar 選單放
     設定與說明也是通用慣例（Google、GitHub 都是這樣）。 */
  const commonItems =
    '<div style="border-top:1px solid var(--line);margin:6px 0 4px;"></div>'
    + '<button class="export-menu-item" id="menuThemeBtn">'
    + (currentTheme === 'dark' ? '切換為亮色' : '切換為暗色') + '</button>'
    + '<button class="export-menu-item" id="menuHelpBtn">使用說明</button>'
    + '<button class="export-menu-item" id="menuFeedbackBtn">意見回饋</button>'
    // 已經是安裝好的獨立視窗就沒什麼好裝的，不要顯示這一項
    + (isStandaloneDisplay() ? '' : '<button class="export-menu-item" id="menuInstallBtn">安裝到裝置</button>');

  function bindCommonItems(){
    document.getElementById('menuThemeBtn').addEventListener('click', () => {
      setTheme(currentTheme === 'dark' ? 'light' : 'dark');
      renderAccountMenu();           // 標籤要跟著換成反向的動作
      menu.classList.remove('open');
    });
    document.getElementById('menuHelpBtn').addEventListener('click', () => {
      /* 分 trigger 是有用的：首次自動彈出的次數約等於新訪客數，
         而「自己從選單找說明」代表介面沒講清楚——後者變多是要改介面的訊號。 */
      track('help.open', { trigger: 'menu' });
      menu.classList.remove('open');
      openHelpPanel();
    });
    document.getElementById('menuFeedbackBtn').addEventListener('click', () => {
      track('feedback.open');
      menu.classList.remove('open');
      openFeedbackPanel();
    });
    const installBtn = document.getElementById('menuInstallBtn');
    if(installBtn) installBtn.addEventListener('click', () => {
      menu.classList.remove('open');
      handleInstallClick();
    });
  }

  if(!authUser){
    btn.classList.remove('signed-in');
    btn.title = '登入與設定';
    menu.innerHTML =
      '<div class="account-state" style="border:none;margin:0;padding:8px 10px;">'
      + '尚未登入。商業模式報告需要登入並訂閱後才能使用。</div>'
      + '<button class="export-menu-item" id="accountLoginBtn">使用 Google 登入</button>'
      + '<a class="export-menu-item" href="' + SUBSCRIBE_URL + '" style="display:block;text-decoration:none;">'
      + '查看訂閱方案</a>'
      + commonItems;
    document.getElementById('accountLoginBtn').addEventListener('click', () => {
      location.href = AUTH_HUB + '/auth/google?redirect='
        + encodeURIComponent(location.origin + '/login.html');
    });
    bindCommonItems();
    return;
  }

  btn.classList.add('signed-in');
  btn.title = '已登入 ' + authUser.email;
  const name = authUser.displayName || authUser.email;
  /* 開通中的狀態：功能名稱一行，次數和到期日合併成一行。

     原本是三行，把開通日、完整到期日、剩餘天數、總次數、「續訂後重新
     計算」全部寫出來，讀起來像合約條款。這是一個使用者每次打開選單都
     會掃過的地方，只有兩件事會影響他接下來的動作：還剩幾次、什麼時候
     到期。開通日不影響任何決定（週期由到期日就看得出來），移到 title
     裡備查；「續訂後重新計算」在次數用完時下面本來就有訂閱入口，那句
     話是重複的。 */
  let state;
  let stateTitle = ''; // 被精簡掉的細節放這裡，滑鼠停著還查得到
  if(!canGenerateReport){
    state = '商業模式報告：未開通';
  } else {
    const until = formatDateShort(entitlementExpiresAt);
    const left = daysUntil(entitlementExpiresAt);

    let quota;
    if(quotaRemaining === null){
      quota = '不限次數';
    } else if(quotaRemaining > 0){
      quota = '還有 ' + quotaRemaining + (quotaTotal ? '／' + quotaTotal : '') + ' 次';
    } else {
      quota = '次數已用完';
    }

    /* 快到期時用「剩 N 天」取代日期，不是兩個都寫——同一件事講兩次
       只是變長，而剩幾天比日期更直接。平常則顯示日期就好。 */
    let expiry = '';
    if(until) expiry = (left !== null && left <= 14) ? '剩 ' + left + ' 天到期' : until + ' 到期';

    state = '<div class="state-head">商業模式報告</div>'
      + '<div class="state-line">' + quota + (expiry ? ' · ' + expiry : '') + '</div>';

    const fullFrom = formatDate(entitlementGrantedAt);
    const fullUntil = formatDate(entitlementExpiresAt);
    stateTitle = [
      fullFrom ? fullFrom + ' 開通' : '',
      fullUntil ? fullUntil + ' 到期' : '無到期日',
      quotaRemaining === null ? '' : '次數在續訂後重新計算',
    ].filter(Boolean).join('\n');
  }

  // 沒開通或次數用完時，選單裡要有一條路可以走，不能只告訴他不行
  const needsSubscription = !canGenerateReport || quotaRemaining === 0;
  const subscribeItem = needsSubscription
    ? '<a class="export-menu-item" href="' + SUBSCRIBE_URL + '" style="display:block;text-decoration:none;">'
      + (canGenerateReport ? '提高方案取得更多次數' : '訂閱以使用商業模式報告') + '</a>'
    : '';

  menu.innerHTML =
    '<div class="account-email">' + escapeHtml(name) + '</div>'
    + '<div class="account-state' + (canGenerateReport && quotaRemaining !== 0 ? ' paid' : '') + '"'
    + (stateTitle ? ' title="' + escapeHtml(stateTitle) + '"' : '') + '>'
    + state
    + '</div>'
    + subscribeItem
    /* 生成過的報告要有地方回頭找。對買了比較多次數的人來說，沒有這個
       入口等於報告生成完看一次就消失了——分享連結只有當下那一份。 */
    + '<button class="export-menu-item" id="accountMyReportsBtn">我的報告</button>'
    // 建立過的關係圖快照：要能回頭複製連結、或撤回（撤回是唯一能讓已嵌入的圖改變的方式）
    + '<button class="export-menu-item" id="accountMyGraphsBtn">我的關係圖</button>'
    + '<button class="export-menu-item" id="accountLogoutBtn">登出</button>'
    + commonItems;
  bindCommonItems();

  document.getElementById('accountMyReportsBtn').addEventListener('click', () => {
    document.getElementById('accountMenu').classList.remove('open');
    openMyReports();
  });
  document.getElementById('accountMyGraphsBtn').addEventListener('click', () => {
    document.getElementById('accountMenu').classList.remove('open');
    openMyGraphs();
  });

  document.getElementById('accountLogoutBtn').addEventListener('click', async () => {
    const item = document.getElementById('accountLogoutBtn');
    item.textContent = '登出中…';
    try{
      // 打 auth-hub 的登出：會把 refresh token 在資料庫裡撤銷（不只是刪 cookie），
      // 所以就算 cookie 被複製走過，那份也一起失效
      await fetch(AUTH_HUB + '/auth/logout', { method: 'POST', credentials: 'include' });
    } catch(err){ /* 連不上也要往下走，至少把這個分頁的狀態清掉 */ }
    // 重新整理最乾淨：access token 在記憶體、按鈕狀態散在畫面各處，一次歸零
    location.reload();
  });
}

/* ---------- 意見回饋 ---------- */

/* 表單是「送出即結束」的一次性互動，所以刻意不做草稿保存、不做送出後
   的編輯。使用者按下送出之後唯一需要知道的事情是「收到了」。 */
function openFeedbackPanel(){
  const panel = document.getElementById('feedbackPanel');
  if(!panel) return;
  // 兩個面板都浮在工具列正下方的同一個位置，開一個就要關掉另一個
  closeHelpPanel();

  panel.classList.add('open');
  syncPanelOffset();
  const box = document.getElementById('feedbackMessage');
  if(box) box.focus();
}

function closeFeedbackPanel(){
  const panel = document.getElementById('feedbackPanel');
  if(panel) panel.classList.remove('open');
}

(function initFeedback(){
  const form = document.getElementById('feedbackForm');
  if(!form) return;   // 面板不存在就整段不綁，不要讓後面的初始化一起死掉

  const msg = document.getElementById('feedbackMessage');
  const counter = document.getElementById('feedbackCount');
  const note = document.getElementById('feedbackNote');
  const submit = document.getElementById('feedbackSubmit');
  const closeBtn = document.getElementById('feedbackCloseBtn');

  if(closeBtn) closeBtn.addEventListener('click', closeFeedbackPanel);
  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape') closeFeedbackPanel();
  });

  if(msg && counter){
    msg.addEventListener('input', () => {
      counter.textContent = msg.value.length;
      counter.parentElement.classList.toggle('near', msg.value.length > 1800);
    });
  }

  function say(text, cls){
    if(!note) return;
    note.textContent = text;
    note.className = 'fb-note' + (cls ? ' ' + cls : '');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = (msg ? msg.value : '').trim();
    if(!text){ say('先寫點什麼再送出吧。', 'bad'); if(msg) msg.focus(); return; }

    submit.disabled = true;
    submit.textContent = '送出中…';
    say('');

    try{
      /* 有登入就帶 token，讓後台知道是誰講的；沒登入照樣送得出去。
         這裡刻意不強制登入——願意花時間打字回報問題的人，不該再被
         擋一道登入牆。 */
      const token = await getAccessToken();
      const headers = { 'Content-Type': 'application/json' };
      if(token) headers.Authorization = 'Bearer ' + token;

      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          category: document.getElementById('feedbackCategory').value,
          message: text,
          contact: document.getElementById('feedbackContact').value,
          page: location.pathname + location.search,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || '送出失敗');

      // 打開 vs 真的送出的落差，是表單本身好不好用的訊號
      track('feedback.submit', {
        category: document.getElementById('feedbackCategory').value,
      });
      say('收到了，謝謝你花時間告訴我。', 'good');
      if(msg) msg.value = '';
      if(counter) counter.textContent = '0';
      // 讓使用者看得到成功訊息再關，直接關掉會讓人懷疑到底送出去了沒
      setTimeout(closeFeedbackPanel, 1600);
    } catch(err){
      say(err.message || '送出失敗，請稍後再試。', 'bad');
    } finally {
      submit.disabled = false;
      submit.textContent = '送出';
    }
  });
})();

// 最外層的分母。放在最後才記，確保前面的初始化都跑完了
track('page.view');

initAuth();

const EXT_LINKS = {
  pcc:      'https://web.pcc.gov.tw/vms/rvlm/rvlmPublicSearch/indexSearchRvlmPublic',
  mops:     'https://mops.twse.com.tw/mops/web/index',
  // 裁判書查詢系統是 ASP.NET WebForms，送出查詢後結果是靠一個內嵌
  // iframe 顯示、網址帶的是伺服器算出來的一次性雜湊值（不是關鍵字
  // 本身），沒辦法把公司名稱直接拼進網址做 deep link——只能比照
  // pcc/mops 的做法，先把名稱複製到剪貼簿，使用者自己貼上去查。
  judicial: 'https://judgment.judicial.gov.tw/FJUD/default.aspx',
};

/* ---------------------------------------------------------
   本機持久快取（localStorage）——這是第三層快取：
   1. cacheCompanies / cacheDetail（記憶體 Map）：同一次瀏覽時最快，
      但重新整理頁面就會清空。
   2. 這裡的 localStorage 快取：重新整理、關掉分頁再打開都還在，
      有 TTL，過期會自動失效重查。
   3. Cloudflare Worker 端本來就有 edge cache（gcis.js / news.js /
      env-penalty.js / director-search.js 裡都有），這是所有使用者
      共用的一層，跟這裡是分開的、互補的。
--------------------------------------------------------- */
const CACHE_PREFIX = 'udc:cache:';
const TTL_COMPANY_DATA = 24 * 60 * 60 * 1000; // 公司登記資料，變動不頻繁
// TTL_NEWS 已移除——新聞功能整個拿掉了（Google RSS 不穩定、付費 API 查不到台灣新聞）
const TTL_PENALTY = 6 * 60 * 60 * 1000;        // 環境部裁罰，介於中間

function cacheGet(key){
  try{
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if(!raw) return undefined;
    const parsed = JSON.parse(raw);
    if(parsed.expires && Date.now() > parsed.expires){
      localStorage.removeItem(CACHE_PREFIX + key);
      return undefined;
    }
    return parsed.value;
  } catch(err){
    return undefined;
  }
}

function cacheSet(key, value, ttlMs){
  try{
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ value, expires: Date.now() + ttlMs }));
  } catch(err){
    // localStorage 滿了或被瀏覽器封鎖時安靜失敗，不影響查詢功能，只是這筆不快取
  }
}

const cacheCompanies = new Map(); // name -> companies[]
const cacheDetail = new Map();    // ubn -> detail
/* 報告快取以台灣時間的日曆月為界（見 worker 的 taipeiMonth），所以這裡也要用
   台灣時間算「本月」——使用者的瀏覽器可能在任何時區。 */
function taipeiMonthNow(){
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

const foundationDetailCache = new Map(); // comname -> { kindstr, addr, obj1, date1, chkcodestr, trustees }
const seenPeople = new Set();

/* ---------------------------------------------------------
   手動隱藏節點（右鍵點一下就隱藏）——純前端顯示層級的操作，完全
   不會動到 D1 資料庫或任何後端資料，只是這次瀏覽時把畫面上的節點
   藏起來，方便人名太常見時把明顯不相關的公司排除掉。
--------------------------------------------------------- */
const hiddenNodeIds = new Set();

/* 隱藏某個節點時「順帶」藏起來的節點：只連到它、藏掉它之後就會孤零零飄在
   畫面上的那些（公司的董監事、經理人、「董事（11 位）」聚合點，以及只能
   經由它們才連得到的東西）。

   跟 hiddenNodeIds 分開放，是因為兩者的意思不一樣：
   - hiddenNodeIds 是使用者親手點掉的，之後就算又被查到也維持隱藏。
   - 這裡的只是「暫時沒地方掛」。之後展開別間公司、又連到它們時要重新出現——
     查交叉持股時，某個董事可能先在台塑石化底下被順帶藏掉，之後又出現在
     南亞塑膠的名單裡，那正是要找的交叉關係，不能因為先前藏過就看不到。 */
const orphanHiddenIds = new Set();

/* 用姓名查到的節點（姓名搜尋、在圖上點兩下某個人）。

   只把「那個人」當成問題是不夠的：實測在南亞科技的圖上點兩下王文淵，姓名比對帶進了
   18 個節點；把王文淵本人隱藏之後，還剩下三座互不相連的「小島」——漢龍水電工程、
   福懋興業、毅樺企業。一間水電工程公司很可能是另一位同名同姓的王文淵，它仍然會
   出現在要分享出去的圖上，讓讀者以為它跟這個題目有關。所以要記住的是「這次姓名
   查詢帶進來的每一個節點」，不是只有人。

   做法：姓名查詢進行中（nameLookupDepth > 0）新增的節點，一律記進這裡（在 nodes 的
   add 事件裡記，公司、人、董事聚合點都涵蓋得到）。之後如果某個節點被公司、統編、
   法人的展開再碰到，代表它有正當的來源，就從這裡移除（見 registerToGroup）。

   已知的不精確：備援的 GCIS 路徑是非同步的，中間如果剛好有另一個公司展開在跑，
   那邊新增的節點也會被記成「姓名查到的」。這個方向的錯是保守的（多擋而不是少擋），
   可以接受。 */
const nameDerivedNodes = new Set();
let nameLookupDepth = 0;
function withNameLookup(fn){
  nameLookupDepth++;
  try{ return fn(); } finally { nameLookupDepth--; }
}
async function withNameLookupAsync(fn){
  nameLookupDepth++;
  try{ return await fn(); } finally { nameLookupDepth--; }
}

/* 被收合的查詢群組擋住的節點（見下面 collapseGroup）。「復原隱藏」不能把這些
   也打開，不然收合就失效了。 */
function hiddenByCollapse(id){
  const refs = nodeGroups.get(id);
  if(!refs || refs.size === 0) return false;
  return [...refs].every(gid => {
    const g = groups.get(gid);
    return g && g.collapsed && !g.rootNodeIds.has(id);
  });
}

function isSearchRoot(id){
  for(const g of groups.values()){ if(g.rootNodeIds.has(id)) return true; }
  return false;
}

/* 藏掉 rootId，連同「藏掉它之後就沒有任何可見連線」的節點。回傳順帶藏掉的節點。

   判斷標準是「剩下的可見鄰居」而不是節點類型：同時是台塑與台化董事的人，
   藏掉台化後還連著台塑，所以會留下——那正是交叉持股要看的東西。只連著台化
   的董事則會一起消失。

   一路往外推：某個董事被藏掉後，如果有間公司只透過他才連得上，那間公司也會
   變成孤點、一起藏掉。但使用者自己搜尋的節點永遠不會被順帶藏掉。 */
function hideWithOrphans(rootIds, opts){
  /* rootIds 可以是一個或一組。opts.soft：起點本身也記成「順帶藏掉」而不是「親手點掉」，
     之後被公司、統編、法人的展開再連到時會自己回來。 */
  const roots = Array.isArray(rootIds) ? rootIds : [rootIds];
  const soft = !!(opts && opts.soft);
  const adj = new Map();
  const link = (a, b) => { if(!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  edges.get({ filter: e => !e.hidden }).forEach(e => { link(e.from, e.to); link(e.to, e.from); });

  /* 被「只看交集」濾掉的節點也要當成還在畫面上。否則在交集模式下藏一間
     公司時，它底下那些已經被濾掉的董事不會被記成「順帶藏掉」，等使用者
     關掉交集模式，它們會以為自己該回來，變成一群沒有主節點的孤點。 */
  const isVisible = id => { const n = nodes.get(id); return !!n && (!n.hidden || crossFilteredIds.has(id)); };
  const gone = new Set(roots);
  const orphans = [];
  const queue = roots.slice();
  while(queue.length){
    const cur = queue.shift();
    for(const nb of (adj.get(cur) || [])){
      if(gone.has(nb) || !isVisible(nb) || isSearchRoot(nb)) continue;
      const stillLinked = [...(adj.get(nb) || [])].some(x => !gone.has(x) && isVisible(x));
      if(!stillLinked){
        gone.add(nb);
        orphans.push(nb);
        queue.push(nb);
      }
    }
  }

  roots.forEach(id => (soft ? orphanHiddenIds : hiddenNodeIds).add(id));
  orphans.forEach(id => orphanHiddenIds.add(id));
  nodes.update([...roots, ...orphans].map(id => ({ id, hidden: true })));
  // 藏掉一間公司後，原本在兩間公司任職的人可能只剩一間，交集模式要重算
  scheduleCrossFilter();
  return orphans;
}

/* ---------------------------------------------------------
   只看交集（工具列的「交集」按鈕）。

   查交叉持股時，畫面上大部分的人只在一間公司任職——實測南亞科技 → 台塑石化
   → 台化 → 台塑那張圖，33 個人裡只有 4 個同時在兩間以上公司任職，其他 29 個
   對「公司之間透過誰連在一起」這個問題來說都是雜訊。打開後只留：
     - 所有公司／法人（公司之間的法人股東連線本身就是交叉持股）
     - 連到兩間以上「目前看得到的」公司／法人的人
     - 使用者自己搜尋的節點（不管幾間都留，不然查一個人會把他本人濾掉）
   董事聚合點（「董事（11 位）」）只掛在一間公司底下，一律濾掉。

   這是純顯示層的濾鏡，跟另外三種隱藏各自獨立：
     hiddenNodeIds（親手點掉）、orphanHiddenIds（順帶藏掉）、收合的查詢群組。
   濾掉的節點只記在 crossFilteredIds，關掉時只放回「沒有其他理由該藏」的，
   所以不會把使用者親手藏的、或收合群組裡的東西意外打開。

   「目前看得到」是關鍵：同一個人在台塑與台化都有董事席位，但台化被藏掉之後，
   畫面上他只剩一間，就會被濾掉——判斷的是眼前這張圖，不是資料庫。
--------------------------------------------------------- */
let crossOnly = false;
const crossFilteredIds = new Set();
let crossFilterQueued = false;

function hiddenForOtherReason(id){
  return hiddenNodeIds.has(id) || orphanHiddenIds.has(id) || hiddenByCollapse(id);
}

function applyCrossFilter(){
  crossFilterQueued = false;
  const prev = new Set(crossFilteredIds);
  crossFilteredIds.clear();

  // 以「如果沒有這個濾鏡，現在看得到的節點」為基準
  const shown = new Set(
    nodes.get({ filter: n => (!n.hidden || prev.has(n.id)) && !hiddenForOtherReason(n.id) }).map(n => n.id)
  );

  const next = new Set();
  if(crossOnly){
    const orgs = new Map(); // 人／聚合點 -> 連到的公司／法人
    edges.get({ filter: e => !e.hidden && shown.has(e.from) && shown.has(e.to) }).forEach(e => {
      [[e.from, e.to], [e.to, e.from]].forEach(([a, b]) => {
        if(!(b.startsWith('c:') || b.startsWith('f:'))) return;
        if(!orgs.has(a)) orgs.set(a, new Set());
        orgs.get(a).add(b);
      });
    });
    shown.forEach(id => {
      if(!(id.startsWith('p:') || id.startsWith('cluster:'))) return;
      if(isSearchRoot(id)) return;
      if((orgs.get(id) || new Set()).size < 2) next.add(id);
    });
  }

  const changes = [];
  next.forEach(id => { if(!nodes.get(id).hidden) changes.push({ id, hidden: true }); crossFilteredIds.add(id); });
  prev.forEach(id => {
    if(next.has(id) || !nodes.get(id) || hiddenForOtherReason(id)) return;
    changes.push({ id, hidden: false });
  });
  if(changes.length) nodes.update(changes);
  syncPhysicsParking();
  return next.size;
}

/* vis-network 的物理模擬不管節點有沒有顯示——隱藏的節點照樣互相推擠、
   照樣被邊拉著。實測交集模式下畫面只剩 9 個點，參與模擬的卻還是全部 41 個
   節點、46 條邊：看不見的 32 個人一直把公司往外撐，所以怎麼整理都收不攏。

   交集模式開著時，把所有隱藏的節點和連到它們的邊暫時移出模擬
   （physics:false），關掉時放回去。只記自己移出去的那些，放回時也只動那些，
   不影響其他地方對 physics 的設定。 */
const parkedNodes = new Set();
const parkedEdges = new Set();

function syncPhysicsParking(){
  const wantNodes = new Set(crossOnly ? nodes.get({ filter: n => n.hidden }).map(n => n.id) : []);
  const wantEdges = new Set(crossOnly
    ? edges.get({ filter: e => e.hidden || wantNodes.has(e.from) || wantNodes.has(e.to) }).map(e => e.id)
    : []);

  const nodeChanges = [];
  wantNodes.forEach(id => { if(!parkedNodes.has(id)){ parkedNodes.add(id); nodeChanges.push({ id, physics: false }); } });
  [...parkedNodes].forEach(id => {
    if(wantNodes.has(id)) return;
    parkedNodes.delete(id);
    if(nodes.get(id)) nodeChanges.push({ id, physics: true });
  });

  const edgeChanges = [];
  wantEdges.forEach(id => { if(!parkedEdges.has(id)){ parkedEdges.add(id); edgeChanges.push({ id, physics: false }); } });
  [...parkedEdges].forEach(id => {
    if(wantEdges.has(id)) return;
    parkedEdges.delete(id);
    if(edges.get(id)) edgeChanges.push({ id, physics: true });
  });

  if(nodeChanges.length) nodes.update(nodeChanges);
  if(edgeChanges.length) edges.update(edgeChanges);
}

/* 展開一間公司時會連續加入幾十個節點，每加一個就重算一次太浪費。排進同一輪
   事件迴圈的尾巴，一次算完——而且發生在瀏覽器下一次繪圖之前，畫面上不會
   先閃出一群人再消失。 */
function scheduleCrossFilter(){
  if(!crossOnly || crossFilterQueued) return;
  crossFilterQueued = true;
  queueMicrotask(applyCrossFilter);
}

/* ---------- 交集模式的版面 ----------

   打開交集時要重新排版，關掉時要原封不動還原。

   為什麼打開時要特別處理：原本只呼叫 settlePhysics()，但物理模擬只跑 180 輪、
   向中心的拉力又很弱（centralGravity 0.015），而起點是被幾十個人撐開的舊位置——
   人消失了，公司之間卻沒有力量把它們拉回來，結果剩下 9 個點還是散在原本那麼大
   的範圍裡。所以先把剩下的點往它們的中心收攏，再讓物理把它們撐成自然的間距。

   為什麼關掉時不能也跑物理：那會重新模擬出一張「不一樣的」圖，使用者原本已經
   看熟的相對位置全部跑掉。所以開啟前先把每個節點的位置、連同當時的縮放與視角
   都存起來，關掉時直接放回去。 */
let crossSavedLayout = null; // { positions, view: { position, scale } }

/* 把畫面縮放到剛好容納這些節點，並扣掉被頂端浮動工具列蓋住的高度——跟
   focusNodeSafe 同一個道理，不然整理好的圖上緣會卡在工具列後面。 */
function fitNodesSafe(ids, animate){
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ids.forEach(id => {
    const b = network.getBoundingBox(id);
    if(!b) return;
    minX = Math.min(minX, b.left);  maxX = Math.max(maxX, b.right);
    minY = Math.min(minY, b.top);   maxY = Math.max(maxY, b.bottom);
  });
  if(!isFinite(minX)) return;
  const rect = container.getBoundingClientRect();
  const toolbar = document.querySelector('.toolbar');
  const covered = toolbar ? Math.max(0, toolbar.getBoundingClientRect().bottom - rect.top) : 0;
  const pad = 48;
  const availW = Math.max(120, rect.width - pad * 2);
  const availH = Math.max(120, rect.height - covered - pad * 2);
  // 上限 1.3：只剩兩三個點時不要放大到方框比螢幕還大
  const scale = Math.max(0.25, Math.min(1.3, availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY)));
  network.moveTo({
    position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 - (covered / 2) / scale },
    scale,
    animation: animate ? { duration: 600, easingFunction: 'easeInOutQuad' } : false,
  });
}

function visibleNodeIds(){
  return nodes.get({ filter: n => !n.hidden }).map(n => n.id);
}

/* 跑一次版面整理，用暫時的物理參數，跑完還原成全站預設值。

   - stabilization.fit 關掉：vis-network 預設在整理完之後自己「縮放到全部節點」，
     它不知道頂端有浮動工具列，會蓋掉我們扣掉工具列高度的 fitNodesSafe，結果
     整理好的圖上緣卡在工具列後面。
   - 物理參數本身可以另外傳（fa2），不傳就用全站預設。

   還原要等到事件處理完的下一輪才做，免得 vis 在同一輪裡讀到已經被改回來的
   fit:true，又自己縮放一次。 */
const DEFAULT_FA2 = { gravitationalConstant: -65, springLength: 140 };
function runLayout(iterations, fa2, onDone){
  network.setOptions({ physics: { enabled: true, stabilization: { fit: false }, forceAtlas2Based: fa2 || DEFAULT_FA2 } });
  network.once('stabilizationIterationsDone', () => {
    setTimeout(() => {
      network.setOptions({ physics: { enabled: false, stabilization: { fit: true }, forceAtlas2Based: DEFAULT_FA2 } });
      if(onDone) onDone();
    }, 0);
  });
  network.stabilize(iterations);
}

/* 物理模擬跑完之後，把外框（含名字標籤）互相疊到的節點推開。

   為什麼不靠調物理參數：交集模式下常有好幾個人連著「同一組」公司（王文淵、
   王文潮都連著台塑、台化、台塑石化），彈簧會把他們拉向同一個平衡點。實測把
   斥力從 -65 加到 -160，疊在一起的組數反而從 4 變 5——整張圖被撐大了，但那幾個
   人還是被拉在一起。直接用幾何的方式處理比較可靠：每一輪找出互相重疊的兩個
   節點，沿著重疊比較少的那個方向各退一半，直到沒有重疊為止。

   外框大小是節點自己的（方框大小、名字長度），不會因為移動而改變，所以一開始
   量一次、之後自己算位置，不用每移一次就等畫面重畫才讀得到新外框。 */
function resolveOverlaps(ids, gap){
  gap = gap == null ? 14 : gap;
  const pos = network.getPositions(ids);
  const ext = {};
  ids.forEach(id => {
    const b = network.getBoundingBox(id);
    if(!b || !pos[id]) return;
    ext[id] = { l: b.left - pos[id].x, r: b.right - pos[id].x, t: b.top - pos[id].y, b: b.bottom - pos[id].y };
  });
  const list = ids.filter(id => ext[id]);
  const box = id => ({ l: pos[id].x + ext[id].l, r: pos[id].x + ext[id].r, t: pos[id].y + ext[id].t, b: pos[id].y + ext[id].b });

  for(let round = 0; round < 60; round++){
    let moved = false;
    for(let i = 0; i < list.length; i++){
      for(let j = i + 1; j < list.length; j++){
        const a = list[i], c = list[j];
        const A = box(a), C = box(c);
        const ox = Math.min(A.r, C.r) - Math.max(A.l, C.l) + gap;
        const oy = Math.min(A.b, C.b) - Math.max(A.t, C.t) + gap;
        if(ox <= 0 || oy <= 0) continue;
        moved = true;
        if(ox < oy){
          const d = (ox / 2) * (pos[c].x >= pos[a].x ? 1 : -1);
          pos[a].x -= d; pos[c].x += d;
        } else {
          const d = (oy / 2) * (pos[c].y >= pos[a].y ? 1 : -1);
          pos[a].y -= d; pos[c].y += d;
        }
      }
    }
    if(!moved) break;
  }
  list.forEach(id => network.moveNode(id, pos[id].x, pos[id].y));
}

function compactCrossLayout(){
  const ids = visibleNodeIds();
  if(ids.length === 0) return;
  const pos = network.getPositions(ids);
  const cx = ids.reduce((s, id) => s + pos[id].x, 0) / ids.length;
  const cy = ids.reduce((s, id) => s + pos[id].y, 0) / ids.length;
  const maxR = Math.max(...ids.map(id => Math.hypot(pos[id].x - cx, pos[id].y - cy)));
  /* 收攏到跟節點數平方根成正比的半徑（9 個點約 225）。只縮不放：本來就很集中的
     圖不要反而被拉開。之後物理模擬會依彈簧長度把它們撐成不重疊的自然間距。 */
  const target = 90 + 45 * Math.sqrt(ids.length);
  const k = maxR > target ? target / maxR : 1;
  ids.forEach(id => network.moveNode(id, cx + (pos[id].x - cx) * k, cy + (pos[id].y - cy) * k));
  // 用全站預設的物理參數（加強斥力實測只會把圖撐大、疊字沒解決），跑完再推開重疊
  runLayout(300, null, () => {
    resolveOverlaps(ids);
    fitNodesSafe(ids, true);
  });
}

function restoreCrossLayout(){
  const saved = crossSavedLayout;
  crossSavedLayout = null;
  if(!saved) return;
  const { positions } = saved;

  const fresh = [];
  nodes.getIds().forEach(id => {
    const p = positions[id];
    if(p) network.moveNode(id, p.x, p.y);
    else fresh.push(id);
  });

  const shownFresh = fresh.filter(id => { const n = nodes.get(id); return n && !n.hidden; });
  if(shownFresh.length === 0){
    // 交集模式期間沒有新增節點：連視角一起還原，回到開啟前一模一樣的畫面
    network.moveTo({ ...saved.view, animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
    return;
  }

  /* 交集模式期間又展開了別的公司，這些節點沒有「開啟前」的位置。先把它們放到
     某個有舊位置的鄰居旁邊（一輪一輪往外找，鄰居本身也是新節點時就等它先放好），
     再短暫整理一下。整理時把舊節點釘住，原本的版面才不會被推亂。 */
  const placed = new Map(Object.entries(positions));
  let pending = shownFresh.slice();
  for(let round = 0; round < 6 && pending.length; round++){
    pending = pending.filter(id => {
      const nb = network.getConnectedNodes(id).find(x => placed.has(x));
      if(!nb) return true;
      const p = placed.get(nb);
      const q = { x: p.x + (Math.random() - 0.5) * 180, y: p.y + (Math.random() - 0.5) * 180 };
      network.moveNode(id, q.x, q.y);
      placed.set(id, q);
      return false;
    });
  }
  const pinned = visibleNodeIds().filter(id => positions[id]);
  nodes.update(pinned.map(id => ({ id, fixed: true })));
  runLayout(120, null, () => {
    nodes.update(pinned.map(id => ({ id, fixed: false })));
    fitNodesSafe(visibleNodeIds(), true);
  });
}

document.getElementById('crossOnlyBtn').addEventListener('click', () => {
  crossOnly = !crossOnly;
  const btn = document.getElementById('crossOnlyBtn');
  btn.classList.toggle('active', crossOnly);
  btn.setAttribute('aria-pressed', crossOnly ? 'true' : 'false');

  // 一定要在濾掉節點「之前」存：之後被藏起來的節點也要記得原本在哪裡
  if(crossOnly){
    crossSavedLayout = {
      positions: network.getPositions(),
      view: { position: network.getViewPosition(), scale: network.getScale() },
    };
  }

  const filtered = applyCrossFilter();
  track('graph.cross_only', { on: crossOnly ? 1 : 0 });
  if(!crossOnly){
    setStatus('已顯示全部節點', 'ok', true);
  } else if(nodes.get({ filter: n => !n.hidden && n.id.startsWith('p:') }).length === 0 && filtered > 0){
    setStatus('目前畫面上沒有同時出現在兩間公司的人，只剩公司（再按一次「交集」恢復）', 'ok', true);
  } else {
    setStatus(`只看交集：暫時隱藏了 ${filtered} 個只連到一間公司的節點（再按一次恢復）`, 'ok', true);
  }

  if(crossOnly) compactCrossLayout();
  else restoreCrossLayout();
});

/* ---------------------------------------------------------
   收合群組：每次從搜尋框開始的查詢算一個「群組」。
   收合時，只有「這個群組獨有、沒有被其他仍展開的群組共用」的節點/邊
   才會被隱藏——如果兩個人查出來的資料有重疊，重疊的部分會繼續顯示。
--------------------------------------------------------- */
let groupCounter = 0;
let activeGroupId = null;
const groups = new Map();       // groupId -> { rootName, rootNodeIds:Set, nodeIds:Set, edgeIds:Set, collapsed }
const nodeGroups = new Map();   // nodeId -> Set<groupId>
const edgeGroups = new Map();   // edgeId -> Set<groupId>

function registerToGroup(id, isEdge){
  // 被公司、統編、法人的展開碰到：這個節點有了正當的來源，不再算「姓名查到的」
  if(!isEdge && nameLookupDepth === 0) nameDerivedNodes.delete(id);
  if(!activeGroupId) return;
  const g = groups.get(activeGroupId);
  if(!g) return;
  const membership = isEdge ? edgeGroups : nodeGroups;
  if(!membership.has(id)) membership.set(id, new Set());
  membership.get(id).add(activeGroupId);
  (isEdge ? g.edgeIds : g.nodeIds).add(id);

  const collection = isEdge ? edges : nodes;
  const item = collection.get(id);
  if(item && item.hidden && !g.collapsed){
    if(isEdge || !hiddenNodeIds.has(id)){
      collection.update({ id, hidden: false });
      // 順帶藏掉的節點又被新的展開連到了——它現在有地方掛，恢復成一般節點
      if(!isEdge) orphanHiddenIds.delete(id);
    }
  }
}

function groupIdForRoot(rootKey){
  for(const [id, g] of groups){ if(g.rootName === rootKey) return id; }
  return null;
}

function collapseGroup(groupId){
  const g = groups.get(groupId);
  if(!g || g.collapsed) return;
  g.collapsed = true;
  g.nodeIds.forEach(id => {
    if(g.rootNodeIds.has(id)) return;
    const refs = nodeGroups.get(id) || new Set();
    const stillNeeded = [...refs].some(gid => gid !== groupId && !groups.get(gid).collapsed);
    if(!stillNeeded) nodes.update({ id, hidden: true });
  });
  g.edgeIds.forEach(id => {
    const refs = edgeGroups.get(id) || new Set();
    const stillNeeded = [...refs].some(gid => gid !== groupId && !groups.get(gid).collapsed);
    if(!stillNeeded) edges.update({ id, hidden: true });
  });
  scheduleCrossFilter();
}

function expandGroup(groupId){
  const g = groups.get(groupId);
  if(!g || !g.collapsed) return;
  g.collapsed = false;
  // 順帶藏掉的也要跳過：它們的主節點還藏著，現在打開只會變成一群飄在空中的孤點
  g.nodeIds.forEach(id => {
    if(!hiddenNodeIds.has(id) && !orphanHiddenIds.has(id)) nodes.update({ id, hidden: false });
  });
  scheduleCrossFilter();
  g.edgeIds.forEach(id => edges.update({ id, hidden: false }));
}

/* query 是使用者輸入的字串，type 是 'person'／'company'／'ubn'——
   同一個字串用不同依據查，視為不同的群組（例如同時查一個叫「大順」的
   人跟一間叫「大順」的公司，不會互相干擾）。 */
function startNewSearch(query, type){
  type = type || 'person';
  const rootKey = type + ':' + query;
  const existing = groupIdForRoot(rootKey);
  if(existing){
    activeGroupId = existing;
    if(groups.get(existing).collapsed) expandGroup(existing);
    const g = groups.get(existing);
    const firstRoot = [...g.rootNodeIds][0];
    if(firstRoot) focusNodeSafe(firstRoot, { scale: 1.1, animation: true });
    return;
  }
  activeGroupId = 'g' + (++groupCounter);
  groups.set(activeGroupId, {
    rootName: rootKey, rootNodeIds: new Set(),
    nodeIds: new Set(), edgeIds: new Set(), collapsed: false
  });
  if(type === 'person'){
    groups.get(activeGroupId).rootNodeIds.add(personNodeId(query));
    return expandFromPerson(query);
  }
  if(type === 'foundation'){
    return expandFromFoundationSearch(query);
  }
  return expandFromCompanySearch(query, type);
}

function buildUrl(endpointId, filter, top){
  const url = new URL(PROXY_BASE, location.origin);
  url.searchParams.set('endpoint', endpointId);
  url.searchParams.set('filter', filter);
  url.searchParams.set('top', String(top || 50));
  return url.toString();
}

async function fetchJson(url, timeoutMs){
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try{
    let res;
    try{
      res = await fetch(url, { signal: controller.signal });
    } catch(err){
      if(err.name === 'AbortError') throw new Error('查詢逾時，請稍後再試');
      throw err;
    }
    const text = await res.text();
    if(!res.ok){
      // 伺服器回的 { error: '...' } 本身就是給人看的訊息，直接用；不要把原始 JSON 丟給使用者
      let message = '';
      try{ message = (JSON.parse(text) || {}).error || ''; } catch(err){}
      if(res.status === 429) throw new Error(message || '查詢太頻繁了，請等一分鐘再試');
      throw new Error('HTTP ' + res.status + (message ? '：' + message : (text ? '：' + text.slice(0, 120) : '')));
    }
    if(!text || !text.trim()){
      return [];
    }
    try{
      return JSON.parse(text);
    } catch(err){
      throw new Error('回傳內容不是有效的 JSON');
    }
  } finally {
    clearTimeout(t);
  }
}

async function getCompaniesByPerson(name){
  if(cacheCompanies.has(name)) return cacheCompanies.get(name);
  const cacheKey = 'gcis:companies-by-person:' + name;
  const cached = cacheGet(cacheKey);
  if(cached){ cacheCompanies.set(name, cached); return cached; }
  const url = buildUrl(EP_COMPANIES_BY_PERSON, `Responsible_Name eq '${name}'`, 50);
  const data = await fetchJson(url);
  const companies = (data || []).map(r => ({ ubn: r.Business_Accounting_NO, name: r.Company_Name }));
  cacheCompanies.set(name, companies);
  cacheSet(cacheKey, companies, TTL_COMPANY_DATA);
  return companies;
}

async function getCompanyD1People(ubn){
  const cacheKey = 'd1-expand:ubn:' + ubn;
  const cached = cacheGet(cacheKey);
  if(cached) return cached;

  if(window.SupabaseBridge){
    try {
      const data = await window.SupabaseBridge.expandEntity(ubn, 'ubn');
      if(data && ((data.directors && data.directors.length > 0) || (data.managers && data.managers.length > 0))){
        const result = { directors: data.directors || [], managers: data.managers || [] };
        cacheSet(cacheKey, result, TTL_COMPANY_DATA);
        return result;
      }
    } catch(e) {}
  }

  const url = new URL('/api/d1-expand', location.origin);
  url.searchParams.set('q', ubn);
  url.searchParams.set('type', 'ubn');
  const data = await fetchJson(url.toString(), 10000).catch(() => ({}));
  const result = { directors: data.directors || [], managers: data.managers || [] };
  cacheSet(cacheKey, result, TTL_COMPANY_DATA);
  return result;
}

async function getCompanyDetailOnly(ubn, fallbackName){
  if(cacheDetail.has(ubn)) return cacheDetail.get(ubn);
  const cacheKey = 'gcis:company-detail:' + ubn;
  const cached = cacheGet(cacheKey);
  if(cached){ cacheDetail.set(ubn, cached); return cached; }

  // 優先由 SupabaseBridge 查詢基本資料
  if(window.SupabaseBridge){
    try {
      const data = await window.SupabaseBridge.expandEntity(ubn, 'ubn');
      const comp = data.companies && data.companies[0];
      if(comp && comp.capital_stock_amount !== undefined){
        const full = {
          ubn,
          name: comp.company_name || fallbackName,
          capital: comp.paid_in_capital_amount || comp.capital_stock_amount,
          address: comp.company_location || '',
          setupDate: comp.company_setup_date || '',
          status: comp.company_status_desc || '核准設立'
        };
        cacheDetail.set(ubn, full);
        cacheSet(cacheKey, full, TTL_COMPANY_DATA);
        return full;
      }
    } catch(e) {}
  }

  const detailRaw = await fetchJson(buildUrl(EP_DETAIL_BY_UBN, `Business_Accounting_NO eq ${ubn}`, 1)).catch(() => []);
  const detail = (detailRaw && detailRaw[0]) || {};
  const full = {
    ubn, name: detail.Company_Name || fallbackName,
    capital: detail.Paid_In_Capital_Amount || detail.Capital_Stock_Amount,
    address: detail.Company_Location,
    setupDate: detail.Company_Setup_Date,
    status: detail.Company_Status_Desc || '核准設立',
  };
  cacheDetail.set(ubn, full);
  cacheSet(cacheKey, full, TTL_COMPANY_DATA);
  return full;
}

async function getCompanyDirectorsViaGcis(ubn){
  // 備援用：只有 D1 查不到這間公司的董監事資料時才會被呼叫
  const directorsRaw = await fetchJson(buildUrl(EP_DIRECTORS_BY_UBN, `Business_Accounting_NO eq ${ubn}`, 50));
  return (directorsRaw || []).map(d => ({
    position: d.Person_Position_Name, name: d.Person_Name,
    shareholding: d.Person_Shareholding, juristic: d.Juristic_Person_Name, juristicUbn: ''
  }));
}

/* 相容用組合函式：只給「完全走 GCIS 備援」的舊流程用（D1 查不到
   才會走到這裡）——這種情況下本來就兩份資料都要，不算是額外浪費請求。 */
async function getCompanyFull(ubn, fallbackName){
  const [detail, directors] = await Promise.all([
    getCompanyDetailOnly(ubn, fallbackName),
    getCompanyDirectorsViaGcis(ubn).catch(() => []),
  ]);
  return { ...detail, directors };
}

async function resolveCompanyByName(name){
  const cacheKey = 'gcis:resolve-by-name:' + name;
  const cached = cacheGet(cacheKey);
  if(cached) return cached;
  let resolved = null;
  try{
    const url = buildUrl(EP_COMPANY_BY_KEYWORD, `Company_Name eq '${name}'`, 5);
    const data = await fetchJson(url);
    if(data && data.length > 0){
      resolved = { ubn: data[0].Business_Accounting_NO, name: data[0].Company_Name };
    }
  } catch(err){ /* fall through */ }
  if(!resolved){
    try{
      const url2 = buildUrl(EP_COMPANY_BY_KEYWORD, `Company_Name like '${name}' and Company_Status eq 01`, 5);
      const data2 = await fetchJson(url2);
      if(data2 && data2.length > 0){
        resolved = { ubn: data2[0].Business_Accounting_NO, name: data2[0].Company_Name };
      }
    } catch(err){ /* give up */ }
  }
  if(resolved) cacheSet(cacheKey, resolved, TTL_COMPANY_DATA);
  return resolved;
}

async function getBranches(ubn){
  const cacheKey = 'gcis:branches:' + ubn;
  const cached = cacheGet(cacheKey);
  if(cached) return cached;
  const url = buildUrl(EP_BRANCHES_BY_UBN, `Business_Accounting_NO eq ${ubn}`, 20);
  const data = await fetchJson(url);
  cacheSet(cacheKey, data, TTL_COMPANY_DATA);
  return data;
}

/* ---------------------------------------------------------
   亮色／暗色主題
--------------------------------------------------------- */
const THEMES = {
  dark: {
    nodeFont: '#EAF4F8',
    nodeShadow: 'rgba(63,232,212,0.22)',
    edgeColor: '#1E3648', edgeHighlight: '#E0A548', edgeFont: '#5C7A8C', edgeFontBg: '#050B14',
    personRegular: { bg: '#1F5F58', border: '#3FE8D4', hoverBg: '#57F0DE', hoverBorder: '#3FE8D4' },
    personCenter:  { bg: '#E0A548', border: '#B07E2E', hoverBg: '#F0C070', hoverBorder: '#B07E2E' },
    companyNormal: { bg: '#16232E', border: '#4A8A93', hoverBg: '#1E3542', hoverBorder: '#6AB0BA' },
    companyCenter: { bg: '#3A2A0E', border: '#E0A548', hoverBg: '#4A3512', hoverBorder: '#F0C070' },
    companyFlagged:{ bg: '#301A18', border: '#D9534F', hoverBg: '#3E2320', hoverBorder: '#D9534F' },
    foundationNormal:{ bg: '#241A38', border: '#8B6FD9', hoverBg: '#2E2247', hoverBorder: '#A78EE8' },
    foundationCenter:{ bg: '#2E2147', border: '#B79AF0', hoverBg: '#3A2C5C', hoverBorder: '#C7AEF5' },
    cluster:       { bg: '#101F2E', border: '#5C7A8C', hoverBg: '#16232E', hoverBorder: '#7B98A8' },
  },
  light: {
    nodeFont: '#10262B',
    nodeShadow: 'rgba(14,140,130,0.18)',
    edgeColor: '#CFE3E0', edgeHighlight: '#C9822E', edgeFont: '#7B928F', edgeFontBg: '#F3FAF9',
    personRegular: { bg: '#BFE3E0', border: '#0E8C82', hoverBg: '#9ED9D4', hoverBorder: '#0E8C82' },
    personCenter:  { bg: '#F0BE73', border: '#9C6520', hoverBg: '#F5D398', hoverBorder: '#9C6520' },
    companyNormal: { bg: '#F2E8D0', border: '#A9824A', hoverBg: '#EBDCB8', hoverBorder: '#C79A5C' },
    companyCenter: { bg: '#F5DCA8', border: '#C9822E', hoverBg: '#F0CE8A', hoverBorder: '#9C6520' },
    companyFlagged:{ bg: '#F6D9D5', border: '#C23B32', hoverBg: '#F2C6C0', hoverBorder: '#C23B32' },
    foundationNormal:{ bg: '#EDE7FA', border: '#7A5FC7', hoverBg: '#E1D7F5', hoverBorder: '#8F72D6' },
    foundationCenter:{ bg: '#E3D8FA', border: '#6647B8', hoverBg: '#D8C7F5', hoverBorder: '#7A5FC7' },
    cluster:       { bg: '#E8F3F1', border: '#7B928F', hoverBg: '#DCEAE7', hoverBorder: '#5C7A8C' },
  },
};
/* 報導版 PNG 專用：純白底、黑字、細線，印出來或放進文章都乾淨。
   不是使用者能切換的主題，匯出時暫時套用、畫完就換回原本的。 */
THEMES.print = Object.assign({}, THEMES.light, {
  nodeFont: '#111111', nodeShadow: 'rgba(0,0,0,0)',
  edgeColor: '#8FA3A6', edgeFont: '#333333', edgeFontBg: '#FFFFFF',
  personRegular: { bg: '#FFFFFF', border: '#111111', hoverBg: '#FFFFFF', hoverBorder: '#111111' },
  companyNormal: { bg: '#FFFFFF', border: '#111111', hoverBg: '#FFFFFF', hoverBorder: '#111111' },
  foundationNormal: { bg: '#FFFFFF', border: '#111111', hoverBg: '#FFFFFF', hoverBorder: '#111111' },
  cluster: { bg: '#F2F2F2', border: '#666666', hoverBg: '#F2F2F2', hoverBorder: '#666666' },
});
let currentTheme = 'dark';
function theme(){ return THEMES[currentTheme]; }

/* 判斷一個節點是不是某個群組的「中心」，用來重畫主題色時決定要不要
   套用中心色——直接查 groups 裡各群組記錄的 rootNodeIds，比用節點的
   大小/邊框粗細去猜準確（那些屬性在「異常公司」跟「中心公司」剛好
   會重疊，用猜的會分不清楚）。 */
function isRootNode(nodeId){
  for(const g of groups.values()){ if(g.rootNodeIds.has(nodeId)) return true; }
  return false;
}

function applyThemeToNetworkOptions(){
  const t = theme();
  network.setOptions({
    nodes: { font: { color: t.nodeFont }, shadow: { enabled: true, color: t.nodeShadow, size: 12, x: 0, y: 0 } },
    edges: {
      color: { color: t.edgeColor, highlight: t.edgeHighlight },
      font: { color: t.edgeFont, strokeColor: t.edgeFontBg },
    },
  });
}

function repaintAllNodesForTheme(){
  const t = theme();
  nodes.get().forEach(n => {
    const isPerson = n.id.startsWith('p:');
    const isCompany = n.id.startsWith('c:');
    const isFoundation = n.id.startsWith('f:');
    const isCluster = n.id.startsWith('cluster:');
    if(!isPerson && !isCompany && !isFoundation && !isCluster) return;
    const isCenter = isRootNode(n.id);
    const isFlagged = isCompany && typeof n.label === 'string' && n.label.startsWith('⚠');
    let c;
    if(isCluster) c = t.cluster;
    else if(isPerson) c = isCenter ? t.personCenter : t.personRegular;
    else if(isFoundation) c = isCenter ? t.foundationCenter : t.foundationNormal;
    else c = isFlagged ? t.companyFlagged : (isCenter ? t.companyCenter : t.companyNormal);
    nodes.update({
      id: n.id,
      color: { background: c.bg, border: c.border, highlight: { background: c.hoverBg, border: c.hoverBorder } },
      font: { color: t.nodeFont },
    });
  });
}

function setTheme(name){
  currentTheme = (name === 'light') ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  try{ localStorage.setItem('udc:theme', currentTheme); } catch(err){}
  const themeColorMeta = document.getElementById('themeColorMeta');
  if(themeColorMeta) themeColorMeta.content = currentTheme === 'light' ? '#F3FAF9' : '#050B14';
  applyThemeToNetworkOptions();
  repaintAllNodesForTheme();
}

/* ---------------------------------------------------------
   vis-network 圖表
--------------------------------------------------------- */
const nodes = new vis.DataSet([]);
const edges = new vis.DataSet([]);
window.nodes = nodes;
window.edges = edges;

/* 畫布上一出現第一個節點（不管是查詢查到的、還是點了範例 chip），
   空狀態引導就永遠不用再顯示了——不用另外在每個「查詢成功」的地方
   各自呼叫一次，掛在 DataSet 的 add 事件上最不容易漏掉。resetBtn 清空
   重來時會自己把 nodes.clear() 呼叫一次，那時候要讓它重新出現，見
   resetBtn 的監聽器。 */
const emptyStateHint = document.getElementById('emptyStateHint');
if(emptyStateHint){
  nodes.on('add', () => { emptyStateHint.hidden = true; });
}

/* 「只看交集」模式開著時，展開新公司加進來的節點也要馬上套用濾鏡。
   一定要註冊在這裡、DataSet 建立之後——寫在 applyCrossFilter 旁邊的話，
   那時 nodes 還沒宣告，整支 app.js 會在載入時直接拋錯。 */
nodes.on('add', scheduleCrossFilter);
edges.on('add', scheduleCrossFilter);
// 姓名查詢進行中新增的節點（見 nameDerivedNodes 的說明）
nodes.on('add', (event, props) => {
  if(nameLookupDepth > 0) props.items.forEach(id => nameDerivedNodes.add(id));
});

const container = document.getElementById('graph');
const network = new vis.Network(container, { nodes, edges }, {
  autoResize: true,
  interaction: { hover: true, tooltipDelay: 120 },
  physics: {
    solver: 'forceAtlas2Based',
    forceAtlas2Based: {
      gravitationalConstant: -65,
      centralGravity: 0.015,
      // 從 110 拉到 140：同一個節點掛好幾條邊（董事、董事長、經理人…）時，
      // 邊本身太短會讓邊上的文字標籤全部擠在節點旁邊那一小圈，彼此疊字。
      // 拉長邊，標籤的落點自然會被撐開、彼此隔遠一點。
      springLength: 140,
      springConstant: 0.06,
      damping: 0.45,
      avoidOverlap: 1
    },
    stabilization: { iterations: 180 }
  },
  nodes: {
    borderWidth: 2,
    font: { color: '#EAF4F8', face: 'Inter', size: 13 },
    shadow: { enabled: true, color: 'rgba(63,232,212,0.22)', size: 12, x: 0, y: 0 }
  },
  edges: {
    color: { color: '#1E3648', highlight: '#E0A548' },
    // align 預設是 'horizontal'——不管邊本身朝哪個方向，文字一律畫成
    // 水平的。同一個節點如果同時有好幾條邊用不同角度匯聚過來，它們的
    // 水平標籤會疊成一小疊、分不出誰是誰。'top' 讓標籤跟著自己那條邊
    // 的角度走、畫在線的上方，方向不同的邊會把各自的標籤帶往不同方向，
    // 自然比較不會疊在一起。
    font: { color: '#5C7A8C', size: 10, strokeWidth: 6, strokeColor: '#050B14', face: 'IBM Plex Mono', align: 'top' },
    smooth: { type: 'continuous' },
    arrows: { to: { enabled: true, scaleFactor: 0.5 } }
  }
});
window.network = network;

/* 圖穩定下來之後就把物理引擎關掉，不然節點多、畫面小的時候，
   排斥力/彈簧力常常沒辦法真正收斂，會一直小幅度晃動。每次加新
   節點之前用 settlePhysics() 短暫重新打開，加完再讓它自動穩定關閉。 */
network.on('stabilizationIterationsDone', () => {
  network.setOptions({ physics: { enabled: false } });
});
function settlePhysics(){
  network.setOptions({ physics: { enabled: true } });
  network.stabilize();
}

/* network.focus() 把節點放在整個 graph 容器的正中央，但搜尋工具列是
   蓋在容器最上面的浮動卡片，蓋住了容器的上緣——結果常常是「查到的
   節點剛好卡在工具列後面」，看起來像沒查到。這裡量出工具列實際蓋住
   的高度，把置中的基準改成「扣掉工具列後、真正看得到的那塊區域」，
   而不是整個容器。所有原本呼叫 network.focus() 的地方都改叫這個。 */
function focusNodeSafe(id, opts){
  opts = opts || {};
  const pos = network.getPositions([id])[id];
  if(!pos){ network.focus(id, opts); return; }
  const scale = opts.scale || network.getScale();
  const toolbar = document.querySelector('.toolbar');
  const containerRect = container.getBoundingClientRect();
  const coveredPx = toolbar ? Math.max(0, toolbar.getBoundingClientRect().bottom - containerRect.top) : 0;
  network.moveTo({
    position: { x: pos.x, y: pos.y - (coveredPx / 2) / scale },
    scale,
    animation: opts.animation,
  });
}

function personNodeId(name){ return 'p:' + name; }
function companyNodeId(ubn){ return 'c:' + ubn; }
function foundationNodeId(comname){ return 'f:' + comname; } // 沒有統編可用，用名稱當識別碼

function ensurePersonNode(name, isCenter){
  const id = personNodeId(name);
  const t = theme();
  const c = isCenter ? t.personCenter : t.personRegular;
  if(!nodes.get(id)){
    nodes.add({
      id, label: name, shape: 'dot', size: isCenter ? 24 : 16,
      color: { background: c.bg, border: c.border, highlight: { background: c.hoverBg, border: c.hoverBorder } },
      font: { size: isCenter ? 15 : 13, color: t.nodeFont }
    });
  } else if(isCenter){
    nodes.update({ id, size: 24, color: { background: c.bg, border: c.border, highlight: { background: c.hoverBg, border: c.hoverBorder } }, font: { size: 15, color: t.nodeFont } });
  }
  registerToGroup(id, false);
  return id;
}

function ensureFoundationNode(comname, isCenter){
  // 用獨立的形狀（六角形）+ 獨立色系（紫），跟公司的方框、人物的圓點
  // 一眼區分開來——法人/社團跟公司是不同性質的實體，共用公司的方框
  // 樣式只能靠讀「法人：」文字前綴分辨，圖一多就分不出來。
  const id = foundationNodeId(comname);
  const t = theme();
  const c = isCenter ? t.foundationCenter : t.foundationNormal;
  if(!nodes.get(id)){
    nodes.add({
      id, label: comname, shape: 'hexagon', size: isCenter ? 26 : 18,
      color: { background: c.bg, border: c.border, highlight: { background: c.hoverBg, border: c.hoverBorder } },
      borderWidth: isCenter ? 3 : 2,
      font: { size: isCenter ? 13 : 12, color: t.nodeFont }
    });
  }
  registerToGroup(id, false);
  return id;
}

function ensureCompanyNode(ubn, name, isCenter, viaJuristic){
  const id = companyNodeId(ubn);
  const t = theme();
  const c = isCenter ? t.companyCenter : t.companyNormal;
  if(!nodes.get(id)){
    nodes.add({
      id, label: name + '\n' + ubn, shape: 'box',
      color: { background: c.bg, border: c.border, highlight: { background: c.hoverBg, border: c.hoverBorder } },
      // 虛線框＝這間公司是透過法人代表關係「穿透」找到的，不是搜尋
      // 主角本身直接搜到的——之前這個差異只寫在邊的文字標籤裡，要點
      // 進去或瞇眼看小字才知道，跟方框/圓點分不出公司/法人是同一種毛病
      shapeProperties: { borderRadius: 5, borderDashes: viaJuristic ? [4, 3] : false },
      margin: 10,
      borderWidth: isCenter ? 3 : 2,
      font: { size: isCenter ? 13 : 12, color: t.nodeFont }
    });
  } else if(isCenter){
    nodes.update({
      id,
      color: { background: c.bg, border: c.border, highlight: { background: c.hoverBg, border: c.hoverBorder } },
      borderWidth: 3,
      font: { size: 13, color: t.nodeFont }
    });
  }
  registerToGroup(id, false);
  return id;
}

function ensureEdge(fromId, toId, label, title, dashed){
  const forwardId = fromId + '->' + toId + ':' + (label || '');
  const reverseId = toId + '->' + fromId + ':' + (label || '');
  // 反方向已經有同樣標籤的線了，就不要再建一條——不然同一段關係
  // 只是先後被兩種方向記錄下來（例如先以「公司列出的董監事」身分出現，
  // 之後又被當成搜尋主角展開），畫面上會變成兩條重疊的線。
  if(edges.get(reverseId)){
    registerToGroup(reverseId, true);
    return;
  }
  if(!edges.get(forwardId)){
    edges.add({ id: forwardId, from: fromId, to: toId, label: label || '', title: title || undefined, dashes: !!dashed });
  }
  registerToGroup(forwardId, true);
}

/* ---------------------------------------------------------
   密集董監事／理監事名單聚合：一間公司/法人底下的人一次全部攤開，
   人一多畫面就變成毛球，尤其法人現在有自己的穿透功能之後更明顯。

   兩個規則：
   1. 「長」字輩職稱（理事長／董事長……）不管人數多少一定直接顯示，
      不能被收進聚合節點裡——資料來源的 seqno 排序是登記先後順序，
      不是職務高低，理事長排在名單最後面很常見，直接照順序切前 N 個
      會把理事長切掉。
   2. 人數過多時，其餘的人依職稱分桶（監事一桶、理事/董事一桶），
      分開收成兩顆聚合節點，不要混成一坨——這樣使用者可以只點開
      自己想看的那一半。桶子人數很少（≤2）就不特地聚合，直接顯示。
--------------------------------------------------------- */
const CLUSTER_VISIBLE_LIMIT = 6;
const pendingClusters = new Map(); // clusterNodeId -> { hubId, items: [{name, addEdge}] }
let clusterCounter = 0;

function isChairRole(role){
  return typeof role === 'string' && (role.includes('長') || role.includes('負責人'));
}
function roleBucketKey(role){
  if(typeof role !== 'string' || !role) return '其他';
  if(role.includes('經理')) return '經理人'; // 要放在「理」的通用判斷之前，不然「經理人」會被歸進「理事」桶
  if(role.includes('監')) return '監事';
  if(role.includes('董')) return '董事';
  if(role.includes('理')) return '理事';
  return '其他';
}

function addHubPeople(hubId, items){
  if(items.length <= CLUSTER_VISIBLE_LIMIT){
    items.forEach(item => item.addEdge());
    return;
  }
  const priority = items.filter(item => isChairRole(item.role));
  const rest = items.filter(item => !isChairRole(item.role));
  priority.forEach(item => item.addEdge());

  const buckets = new Map();
  rest.forEach(item => {
    const key = roleBucketKey(item.role);
    if(!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  });
  buckets.forEach((bucketItems, key) => {
    if(bucketItems.length <= 2){
      bucketItems.forEach(item => item.addEdge());
    } else {
      addRoleCluster(hubId, key, bucketItems);
    }
  });
}

function addRoleCluster(hubId, roleKey, items){
  const cid = 'cluster:' + hubId + ':' + (++clusterCounter);
  const t = theme();
  const c = t.cluster;
  nodes.add({
    id: cid, label: `${roleKey}（${items.length} 位）`, shape: 'dot', size: 14,
    color: { background: c.bg, border: c.border, highlight: { background: c.hoverBg, border: c.hoverBorder } },
    font: { size: 11, color: t.nodeFont },
  });
  ensureEdge(hubId, cid, `${roleKey}，點擊展開`);
  pendingClusters.set(cid, { hubId, items });
  registerToGroup(cid, false);
}

function expandCluster(clusterId){
  const pending = pendingClusters.get(clusterId);
  if(!pending) return;
  pendingClusters.delete(clusterId);
  // 這個聚合點本身是姓名查詢帶進來的，點開後新增的人也一樣是
  if(nameDerivedNodes.has(clusterId)) withNameLookup(() => pending.items.forEach(item => item.addEdge()));
  else pending.items.forEach(item => item.addEdge());
  // 節點跟邊是各自獨立的 DataSet，移除節點不會連帶清掉指到它的邊，
  // 要自己找出來一起刪，不然佔位節點消失後那條線會變成孤兒懸在畫面上
  const danglingEdgeIds = edges.get({ filter: e => e.from === clusterId || e.to === clusterId }).map(e => e.id);
  edges.remove(danglingEdgeIds);
  nodes.remove(clusterId);
  settlePhysics();
}

/* 公司現況風險旗標：狀態不是「核准設立」就標紅框 + 警示前綴 */
function applyStatusFlag(ubn, full){
  const id = companyNodeId(ubn);
  const node = nodes.get(id);
  if(!node) return;
  const status = full.status || '';
  const isHealthy = !status || HEALTHY_STATUS_HINTS.some(s => status.includes(s));
  if(!isHealthy && !node.label.startsWith('⚠')){
    const c = theme().companyFlagged;
    nodes.update({
      id,
      label: '⚠ ' + node.label,
      color: { background: c.bg, border: c.border, highlight: { background: c.hoverBg, border: c.hoverBorder } },
      borderWidth: 3
    });
  }
}

/* ---------------------------------------------------------
   狀態提示 toast
--------------------------------------------------------- */
let toastTimer = null;
function setStatus(text, kind, autoHide){
  const toast = document.getElementById('toast');
  document.getElementById('statusText').textContent = text;
  const dot = document.getElementById('statusDot');
  dot.className = 'dot' + (kind ? ' ' + kind : '');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  if(autoHide){
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }
}

/* ---------------------------------------------------------
   查詢流程
--------------------------------------------------------- */

/* ---------------------------------------------------------
   自己的 D1 資料庫（現在的主要資料來源）
   從 GCIS 官方開放資料自己下載、自己存，不再需要即時打 GCIS API
   才能查到「這個人在哪些公司擔任董監事/經理人」。GCIS 官方 API 還留著，
   D1 查不到資料時當備援。
   用 /api/d1-expand 一次拿到「這個人相關的公司」+「這些公司完整的
   董監事/經理人名單」，不用像早期版本那樣每間公司各發一次請求。
--------------------------------------------------------- */
async function getExpandBundleFromD1(query, type){
  type = type || 'person';
  const depth = 2;
  const cacheKey = 'd1-expand:' + type + ':' + depth + ':' + query;
  const cached = cacheGet(cacheKey);
  if(cached) return cached;

  // 1. 優先嘗試由 Supabase BaaS 雲端資料庫展開
  if(window.SupabaseBridge){
    try {
      const sbBundle = await window.SupabaseBridge.expandEntity(query, type);
      if(sbBundle && sbBundle.companies && sbBundle.companies.length > 0){
        cacheSet(cacheKey, sbBundle, TTL_COMPANY_DATA);
        return sbBundle;
      }
    } catch(err){
      console.warn('[app.js] Supabase expand failed, falling back:', err);
    }
  }

  // 2. 原生後端/OpenData 備援
  const url = new URL('/api/d1-expand', location.origin);
  url.searchParams.set('q', query);
  url.searchParams.set('type', type);
  url.searchParams.set('depth', String(depth));
  const data = await fetchJson(url.toString(), 10000).catch(() => ({}));
  const bundle = {
    companies: data.companies || [],
    directors: data.directors || [],
    managers: data.managers || [],
  };
  if(bundle.companies.length > 0) cacheSet(cacheKey, bundle, TTL_COMPANY_DATA);
  return bundle;
}

/* 把董監事的職稱、所代表法人、持股數整理成邊的標籤/提示文字，
   之前這幾個欄位資料庫裡都有存，但完全沒有顯示出來。 */
function formatShares(v){
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : v; // 不是乾淨數字格式就原樣顯示，不要顯示壞掉的東西
}

function directorEdgeLabel(d){
  return d.position || '董監事';
}
function directorEdgeTitle(d){
  const parts = [];
  if(d.represents) parts.push(`代表：${d.represents}`);
  if(d.shares !== undefined && d.shares !== null && d.shares !== '') parts.push(`持股數：${formatShares(d.shares)}`);
  return parts.length ? parts.join('\n') : undefined;
}
function managerEdgeTitle(m){
  return m.start_date ? `到職日：${m.start_date}` : undefined;
}

function buildGraphFromD1(centerName, bundle){
  const pId = ensurePersonNode(centerName, true);
  const directorsByUbn = new Map();
  bundle.directors.forEach(d => {
    if(!directorsByUbn.has(d.ubn)) directorsByUbn.set(d.ubn, []);
    directorsByUbn.get(d.ubn).push(d);
  });
  const managersByUbn = new Map();
  bundle.managers.forEach(m => {
    if(!managersByUbn.has(m.ubn)) managersByUbn.set(m.ubn, []);
    managersByUbn.get(m.ubn).push(m);
  });

  // 「法人代表」連線要連去的來源公司，可能因為聚合機制被延後建立節點
  // （被收進董事/監事聚合節點裡，使用者還沒點開）——先建一份 ubn 對
  // 名稱的對照表，需要時可以直接 ensureCompanyNode 把它「提前」生出來，
  // 不用賭它有沒有已經被畫出來。這種公司本來就是穿透鏈上的節點，被
  // 提前顯示、不進聚合節點，也是合理的（比被收合起來更值得優先看到）。
  const ubnToName = new Map(bundle.companies.map(c => [c.ubn, c.company_name]));

  // 通俗姓名（張O棟、李O成這類）常常同時掛在十幾家公司底下，如果每家
  // 公司都直接攤開成一個節點，畫面會比公司內部董監事名單過多還誇張。
  // 套用跟「公司底下人太多」完全同一套聚合邏輯（addHubPeople 本來就
  // 不管節點類型，只在乎「有沒有 role、能不能分桶」），身分是董事長／
  // 負責人的公司優先直接顯示，其餘依身分分桶收合。
  const companyItems = [];
  bundle.companies.forEach(c => {
    if(!c.ubn || !c.company_name) return;
    const isViaJuristic = c.level && c.level > 1 && c.viaUbn;
    const companyDirectors = directorsByUbn.get(c.ubn) || [];
    const companyManagers = managersByUbn.get(c.ubn) || [];
    const selfDirector = companyDirectors.find(d => d.person_name === centerName);
    const selfManager = companyManagers.find(m => m.manager_name === centerName);
    const role = isViaJuristic ? (c.viaPosition || '法人代表')
      : selfDirector ? directorEdgeLabel(selfDirector)
      : selfManager ? '經理人' : '關聯';

    companyItems.push({
      name: c.company_name, role,
      addEdge: () => {
        const cId = ensureCompanyNode(c.ubn, c.company_name, false, isViaJuristic);

        if(isViaJuristic){
          // 法人穿透：這間公司是某個董監事席位的「法人代表」身分找到的，
          // 畫公司對公司的連線，不是從搜尋主角直接連過來。來源公司可能
          // 還沒被畫出來（被收進聚合節點），用 ubnToName 提前生出節點，
          // 不要賭它剛好已經存在，不然連線會靜默消失、看起來像孤島
          const viaName = ubnToName.get(c.viaUbn);
          const viaId = viaName ? ensureCompanyNode(c.viaUbn, viaName) : companyNodeId(c.viaUbn);
          if(nodes.get(viaId)){
            ensureEdge(cId, viaId, c.viaPosition ? `法人代表（${c.viaPosition}）` : '法人代表', undefined, true);
          }
        } else if(selfDirector){
          ensureEdge(pId, cId, directorEdgeLabel(selfDirector), directorEdgeTitle(selfDirector));
        } else if(selfManager){
          ensureEdge(pId, cId, '經理人', managerEdgeTitle(selfManager));
        } else {
          ensureEdge(pId, cId, '關聯');
        }

        addHubPeople(cId, companyDirectors.filter(d => d.person_name && d.person_name !== centerName).map(d => ({
          name: d.person_name, role: d.position,
          addEdge: () => ensureEdge(cId, ensurePersonNode(d.person_name, false), directorEdgeLabel(d), directorEdgeTitle(d)),
        })));
        addHubPeople(cId, companyManagers.filter(m => m.manager_name && m.manager_name !== centerName).map(m => ({
          name: m.manager_name, role: '經理人',
          addEdge: () => ensureEdge(cId, ensurePersonNode(m.manager_name, false), '經理人', managerEdgeTitle(m)),
        })));
      },
    });
  });
  addHubPeople(pId, companyItems);
  settlePhysics();
}

/* 以公司名稱或統編為主體的搜尋：中心點是公司，不是人。
   如果公司名稱查到多間符合的公司（模糊搜尋本來就可能有這種情況），
   全部都當作中心點顯示，各自展開自己的董監事/經理人名單。 */
function buildGraphFromD1Company(bundle){
  const g = groups.get(activeGroupId);
  const directorsByUbn = new Map();
  bundle.directors.forEach(d => {
    if(!directorsByUbn.has(d.ubn)) directorsByUbn.set(d.ubn, []);
    directorsByUbn.get(d.ubn).push(d);
  });
  const managersByUbn = new Map();
  bundle.managers.forEach(m => {
    if(!managersByUbn.has(m.ubn)) managersByUbn.set(m.ubn, []);
    managersByUbn.get(m.ubn).push(m);
  });
  // 同樣的道理：viaUbn 指到的來源公司如果在 bundle.companies 陣列裡排在
  // 後面、還沒輪到它建立節點，靠 nodes.get() 判斷會賭輸，連線平白消失
  const ubnToName = new Map(bundle.companies.map(c => [c.ubn, c.company_name]));

  bundle.companies.forEach(c => {
    if(!c.ubn || !c.company_name) return;
    const isLevelOne = !c.level || c.level === 1;
    const cId = ensureCompanyNode(c.ubn, c.company_name, isLevelOne, !isLevelOne);
    if(isLevelOne){
      if(g) g.rootNodeIds.add(cId);
    } else if(c.viaUbn){
      const viaName = ubnToName.get(c.viaUbn);
      const viaId = viaName ? ensureCompanyNode(c.viaUbn, viaName) : companyNodeId(c.viaUbn);
      if(nodes.get(viaId)){
        ensureEdge(cId, viaId, c.viaPosition ? `法人代表（${c.viaPosition}）` : '法人代表', undefined, true);
      }
    }

    addHubPeople(cId, (directorsByUbn.get(c.ubn) || []).filter(d => d.person_name).map(d => ({
      name: d.person_name, role: d.position,
      addEdge: () => ensureEdge(cId, ensurePersonNode(d.person_name, false), directorEdgeLabel(d), directorEdgeTitle(d)),
    })));
    addHubPeople(cId, (managersByUbn.get(c.ubn) || []).filter(m => m.manager_name).map(m => ({
      name: m.manager_name, role: '經理人',
      addEdge: () => ensureEdge(cId, ensurePersonNode(m.manager_name, false), '經理人', managerEdgeTitle(m)),
    })));
  });
  settlePhysics();
}

async function getFoundationBundle(query){
  const cacheKey = 'foundation-expand:' + query;
  const cached = cacheGet(cacheKey);
  if(cached) return cached;

  if(window.SupabaseBridge){
    try {
      const fds = await window.SupabaseBridge.getFoundationBundle(query);
      if(fds && fds.length > 0){
        cacheSet(cacheKey, fds, TTL_COMPANY_DATA);
        return fds;
      }
    } catch(e) {}
  }

  const url = new URL('/api/foundation-expand', location.origin);
  url.searchParams.set('q', query);
  const data = await fetchJson(url.toString(), 10000).catch(() => ({}));
  const foundations = data.foundations || [];
  if(foundations.length > 0) cacheSet(cacheKey, foundations, TTL_COMPANY_DATA);
  return foundations;
}

function buildGraphFromFoundations(foundations){
  const g = groups.get(activeGroupId);
  foundations.forEach(f => {
    if(!f.comname) return;
    const fId = ensureFoundationNode(f.comname, true);
    if(g) g.rootNodeIds.add(fId);
    foundationDetailCache.set(f.comname, f);
    addHubPeople(fId, (f.trustees || []).filter(t => t.name).map(t => ({
      name: t.name, role: t.funname,
      addEdge: () => ensureEdge(fId, ensurePersonNode(t.name, false), t.funname || '董監事'),
    })));
  });
  settlePhysics();
}

// 司法院的日期是 7 位數民國年月日（'1150613'），轉成「民國 115 年 6 月 13 日」
function rocDate(s){
  const m = /^(\d{3})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  if(!m) return s ? `民國 ${s}` : '';
  return `民國 ${Number(m[1])} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}

function foundationRecordDetailHtml(f, record, opts){
  opts = opts || {};
  return `
    ${opts.breadcrumb || ''}
    <span class="tag company">${record.kindstr || f.kindstr || '法人'}</span>
    ${entityTitleHtml(f.comname)}
    <div class="field">
      <div class="field-label">${opts.dateLabel || '最新登記日期'}</div>
      <div class="field-value">${rocDate(record.date1)}${record.chkcodestr ? `（${record.chkcodestr}）` : ''}</div>
    </div>
    ${record.addr ? `<div class="field"><div class="field-label">主事務所</div><div class="field-value">${record.addr}</div></div>` : ''}
    ${record.obj1 ? `<div class="field"><div class="field-label">設立目的</div><div class="field-value">${record.obj1}</div></div>` : ''}
    <div class="director-list">
      <div class="field-label list-label">董監事／理監事名單（點擊姓名可延伸查詢）</div>
      ${(record.trustees || []).map(t => `
        <div class="director-block">
          <div class="director-row" data-name="${t.name}">
            <span class="director-name">${t.name}</span>
            <span class="director-position">${t.funname || ''}</span>
          </div>
        </div>
      `).join('') || '<div class="placeholder">無資料</div>'}
    </div>
    ${opts.historyToggle || ''}
    ${externalLookupSectionHtml()}
    <div class="field">
      <div class="footnote">資料來源：司法院法人登記公告資料集。這是「異動記錄」而非即時現況，顯示的是目前查得到的登記記錄，實際狀態可能已經有更新的變更尚未反映在這份資料裡。</div>
    </div>
  `;
}

function bindFoundationPanelEvents(sidebarContent){
  sidebarContent.querySelectorAll('.director-row').forEach(row => {
    row.addEventListener('click', () => expandFromPerson(row.dataset.name));
  });
  const historyBtn = sidebarContent.querySelector('.history-toggle-btn');
  if(historyBtn) historyBtn.addEventListener('click', () => renderFoundationHistoryList(historyBtn.dataset.comname));
  const backBtn = sidebarContent.querySelector('.history-back-btn');
  if(backBtn) backBtn.addEventListener('click', () => renderFoundationPanel(backBtn.dataset.comname));
  sidebarContent.querySelectorAll('.history-list-item').forEach(item => {
    item.addEventListener('click', () => renderFoundationHistoryDetail(item.dataset.comname, Number(item.dataset.index)));
  });
}

function renderFoundationPanel(comname){
  const f = foundationDetailCache.get(comname);
  const sidebarContent = document.getElementById('sidebarContent');
  if(!f){
    sidebarContent.innerHTML = `<div class="placeholder">找不到「${comname}」的詳細資料，請重新搜尋一次。</div>`;
    openSidebar();
    return;
  }
  const history = f.history || [];
  const historyToggle = history.length > 0
    ? `<button class="history-toggle-btn" data-comname="${comname}">歷史紀錄（${history.length}）</button>`
    : '';
  sidebarContent.innerHTML = foundationRecordDetailHtml(f, f, { historyToggle });
  bindFoundationPanelEvents(sidebarContent);
  bindEntityTitleCopy(sidebarContent, f.comname);
  bindExternalLookups(sidebarContent, f.comname);
  openSidebar();
}

function renderFoundationHistoryList(comname){
  const f = foundationDetailCache.get(comname);
  const sidebarContent = document.getElementById('sidebarContent');
  if(!f) return;
  const history = f.history || [];
  sidebarContent.innerHTML = `
    <button class="history-back-btn" data-comname="${comname}">‹ 返回最新</button>
    <span class="tag company">${f.kindstr || '法人'}</span>
    ${entityTitleHtml(f.comname)}
    <div class="field-label list-label">歷史紀錄（由新到舊，共 ${history.length} 筆）</div>
    <div class="history-timeline">
      <div class="history-list-item" data-comname="${comname}" data-index="-1">
        <span class="history-date">${rocDate(f.date1)}</span>
        <span class="history-reason">${f.chkcodestr ? f.chkcodestr + '（目前顯示中的最新一筆）' : '目前顯示中的最新一筆'}</span>
      </div>
      ${history.map((h, i) => `
        <div class="history-list-item" data-comname="${comname}" data-index="${i}">
          <span class="history-date">${rocDate(h.date1)}</span>
          <span class="history-reason">${h.chkcodestr || ''}</span>
        </div>
      `).join('')}
    </div>
  `;
  sidebarContent.querySelector('.history-back-btn').addEventListener('click', () => renderFoundationPanel(comname));
  sidebarContent.querySelectorAll('.history-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = Number(item.dataset.index);
      if(idx === -1) renderFoundationPanel(comname);
      else renderFoundationHistoryDetail(comname, idx);
    });
  });
  // 歷史清單只是切換用的過渡畫面，不放外部查證區；回到任一筆記錄時才會有
  bindEntityTitleCopy(sidebarContent, f.comname);
  openSidebar();
}

function renderFoundationHistoryDetail(comname, index){
  const f = foundationDetailCache.get(comname);
  const sidebarContent = document.getElementById('sidebarContent');
  const record = f && (f.history || [])[index];
  if(!f || !record) return;
  const breadcrumb = `<button class="history-back-btn" data-comname="${comname}">‹ 返回歷史紀錄清單</button>`;
  sidebarContent.innerHTML = foundationRecordDetailHtml(f, record, { breadcrumb, dateLabel: '登記日期（歷史記錄）' });
  sidebarContent.querySelectorAll('.director-row').forEach(row => {
    row.addEventListener('click', () => expandFromPerson(row.dataset.name));
  });
  sidebarContent.querySelector('.history-back-btn').addEventListener('click', () => renderFoundationHistoryList(comname));
  bindEntityTitleCopy(sidebarContent, f.comname);
  bindExternalLookups(sidebarContent, f.comname);
  openSidebar();
}

/* 分享提示：以公司／統編／法人查詢成功之後，讓工具列的「分享」亮一下。
   以姓名查詢不提示——那種圖本來就擋著不能分享（同名同姓的錯誤率太高）。

   什麼時候停止提示，改過一次：原本是「打開過分享選單就永遠不再提示」，
   但那表示任何一次好奇點開——包括不小心點到——就把提示永久關掉了，
   而且同一台電腦再也回不來。現在的規則是：
     - 真的建立過分享快照 → 已經知道有這個功能了，不用再提示
     - 否則最多提示 SHARE_HINT_MAX 次，次數存在 localStorage
   打開選單只會把這一次的閃爍收掉，不影響之後的次數。 */
const SHARE_HINT_COUNT_KEY = 'udc.shareHintCount';
const SHARE_HINT_DONE_KEY = 'udc.shareUsed';
const SHARE_HINT_MAX = 5;
let shareHintTimer = null;

function lsGet(key){
  try{ return localStorage.getItem(key); } catch(err){ return null; }
}
function lsSet(key, value){
  try{ localStorage.setItem(key, value); } catch(err){}
}

function flashShareHint(){
  // 舊版的旗標：清掉，不然上一版已經點開過選單的人永遠等不到新的提示
  try{ localStorage.removeItem('udc.shareHintSeen'); } catch(err){}
  if(lsGet(SHARE_HINT_DONE_KEY)) return;
  const shown = Number(lsGet(SHARE_HINT_COUNT_KEY) || 0);
  if(shown >= SHARE_HINT_MAX) return;
  const btn = document.getElementById('exportBtn');
  if(!btn) return;
  lsSet(SHARE_HINT_COUNT_KEY, String(shown + 1));
  clearTimeout(shareHintTimer);
  // 先移除再加回去，重新觸發動畫：連續查詢兩次時，class 一直都在，
  // 瀏覽器不會重新播放，第二次查詢就完全沒有閃爍。
  btn.classList.remove('share-hint');
  void btn.offsetWidth;
  btn.classList.add('share-hint');
  shareHintTimer = setTimeout(() => btn.classList.remove('share-hint'), 9000); // 跟 CSS 的 1.5 秒 x 5 次對齊，動畫跑完才把顏色收掉
}

/** 收掉目前這一次的閃爍（打開選單時），但不影響之後還會不會提示 */
function stopShareHint(){
  clearTimeout(shareHintTimer);
  const btn = document.getElementById('exportBtn');
  if(btn) btn.classList.remove('share-hint');
}

async function expandFromFoundationSearch(query){
  setStatus(`查詢中：${query}…`, 'loading', false);
  try{
    const foundations = await getFoundationBundle(query);
    if(foundations.length > 0){
      buildGraphFromFoundations(foundations);
      setStatus(`完成（司法院法人登記公告，僅顯示各法人最新一筆記錄）：「${query}」共 ${foundations.length} 筆`, 'ok', true);
      flashShareHint();
      focusNodeSafe(foundationNodeId(foundations[0].comname), { scale: 1.0, animation: true });
      return;
    }
    setStatus(`查無「${query}」的法人/社團登記資料`, 'err', true);
  } catch(err){
    console.error(err);
    setStatus(`查詢失敗：${err.message}`, 'err', true);
  }
}

async function expandFromCompanySearch(query, type){
  setStatus(`查詢中：${query}…`, 'loading', false);
  try{
    const bundle = await getExpandBundleFromD1(query, type);
    if(bundle.companies.length > 0){
      buildGraphFromD1Company(bundle);
      setStatus(`完成（自己的資料庫）：「${query}」共 ${bundle.companies.length} 家公司`, 'ok', true);
      flashShareHint();
      const firstUbn = bundle.companies[0].ubn;
      focusNodeSafe(companyNodeId(firstUbn), { scale: 1.0, animation: true });
      return;
    }
    setStatus(`查無「${query}」的公司資料`, 'err', true);
  } catch(err){
    console.error(err);
    setStatus(`查詢失敗：${err.message}`, 'err', true);
  }
}

async function expandFromPerson(name){
  if(seenPeople.has(name)){
    setStatus(`「${name}」已在圖中展開過`, 'ok', true);
    focusNodeSafe(personNodeId(name), { scale: 1.1, animation: true });
    return;
  }
  setStatus(`查詢中：${name}…`, 'loading', false);

  try{
    const d1Bundle = await getExpandBundleFromD1(name);
    if(d1Bundle.companies.length > 0){
      seenPeople.add(name);
      withNameLookup(() => buildGraphFromD1(name, d1Bundle));
      setStatus(`完成（自己的資料庫）：「${name}」共 ${d1Bundle.companies.length} 家公司`, 'ok', true);
      focusNodeSafe(personNodeId(name), { scale: 1.0, animation: true });
      return;
    }
  } catch(err){
    console.warn('D1 查詢失敗，改用 GCIS 官方 API', err);
  }

  await withNameLookupAsync(() => expandFromPersonViaGcis(name));
}

/* 官方 GCIS API 備援：只查得到「負責人」身分，但穩定度較高 */
async function expandFromPersonViaGcis(name){
  setStatus(`查詢中（官方 API 備援）：${name} 擔任負責人的公司…`, 'loading', false);

  try{
    const companies = await getCompaniesByPerson(name);
    seenPeople.add(name);

    if(companies.length === 0){
      // 查得到人卻查不到公司，代表資料涵蓋有缺口。這個數字如果很高，
      // 該做的是補資料來源，不是加功能——沒有埋點的話你不會知道
      track('search.empty', { type: 'company' });
      setStatus(`查無「${name}」的公司資料`, 'err', false);
      ensurePersonNode(name, true);
      focusNodeSafe(personNodeId(name), { scale: 1.2, animation: true });
      return;
    }

    const pId = ensurePersonNode(name, true);

    // 這支 GCIS 備援 API 查到的公司全部都是「負責人」身分，沒有職稱可以
    // 像 D1 那條路徑一樣分桶，這裡單純依人數決定要不要收合成一顆節點
    const visible = companies.slice(0, CLUSTER_VISIBLE_LIMIT);
    const rest = companies.slice(CLUSTER_VISIBLE_LIMIT);
    visible.forEach(c => {
      const cId = ensureCompanyNode(c.ubn, c.name);
      ensureEdge(pId, cId, '負責人');
    });
    if(rest.length > 0){
      addRoleCluster(pId, '負責人', rest.map(c => ({
        name: c.name,
        addEdge: () => ensureEdge(pId, ensureCompanyNode(c.ubn, c.name), '負責人'),
      })));
    }

    setStatus(`找到 ${companies.length} 家公司，展開董監事名單中…`, 'loading', false);

    for(const c of visible){
      const full = await getCompanyFull(c.ubn, c.name);
      applyStatusFlag(c.ubn, full);
      const cId = companyNodeId(c.ubn);
      (full.directors || []).forEach(d => {
        if(!d.name) return;
        const dId = ensurePersonNode(d.name, false);
        ensureEdge(cId, dId, d.position || '');
      });
    }

    setStatus(`完成（官方 API，僅負責人身分）：「${name}」共 ${companies.length} 家公司`, 'ok', true);
    settlePhysics();
    focusNodeSafe(pId, { scale: 1.0, animation: true });
  } catch(err){
    console.error(err);
    setStatus(`查詢失敗：${err.message}`, 'err', false);
  }
}

/* 法人董事展開——name-only 版本：只有名稱字串，需要先解析出統編
   (GCIS 官方 API 備援流程走這條，因為它只給法人名稱字串) */
async function expandJuristicDirector(fromUbn, juristicName){
  setStatus(`查詢法人股東：${juristicName}…`, 'loading', false);
  const resolved = await resolveCompanyByName(juristicName);
  if(!resolved){
    setStatus(`找不到法人「${juristicName}」的登記資料（可能名稱格式不完全相符）`, 'err', true);
    return;
  }
  await expandJuristicDirectorDirect(fromUbn, resolved.ubn, resolved.name);
}

/* 法人董事展開——已知統編版本，目前實際上很少被觸發（D1／GCIS 都不會
   直接附上法人的統編，只有名稱），保留當作介面備援 */
async function expandJuristicDirectorDirect(fromUbn, targetUbn, targetName){
  setStatus(`展開法人：${targetName}…`, 'loading', false);
  const fromId = companyNodeId(fromUbn);
  const toId = ensureCompanyNode(targetUbn, targetName, false, true);
  ensureEdge(fromId, toId, '法人股東', undefined, true);

  try{
    const full = await getCompanyFull(targetUbn, targetName);
    applyStatusFlag(targetUbn, full);
    (full.directors || []).forEach(d => {
      if(!d.name) return;
      const dId = ensurePersonNode(d.name, false);
      ensureEdge(toId, dId, d.position || '');
    });
    setStatus(`已展開法人「${targetName}」`, 'ok', true);
    settlePhysics();
    focusNodeSafe(toId, { scale: 1.0, animation: true });
  } catch(err){
    setStatus(`展開法人「${targetName}」時查詢失敗：${err.message}`, 'err', true);
  }
}

/* ---------------------------------------------------------
   相關新聞（Google News RSS，免金鑰）
--------------------------------------------------------- */
/* ---------------------------------------------------------
   環境部裁罰查詢
--------------------------------------------------------- */
async function loadEnvPenalty(name, containerId){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = '<div class="placeholder">搜尋中…</div>';
  try{
    const cacheKey = 'env-penalty:' + name;
    let records = cacheGet(cacheKey);
    if(!records){
      if(window.SupabaseBridge){
        try {
          const res = await window.SupabaseBridge.getEnvPenalty(name);
          if(res && res.records && res.records.length > 0){
            records = res.records;
          }
        } catch(e) {}
      }
      if(!records){
        const url = new URL('/api/env-penalty', location.origin);
        url.searchParams.set('q', name);
        const data = await fetchJson(url.toString(), 12000).catch(() => ({}));
        records = data.records || [];
      }
      cacheSet(cacheKey, records, TTL_PENALTY);
    }
    if(records.length === 0){
      el.innerHTML = '<div class="placeholder">近期資料中查無裁罰紀錄（僅涵蓋最新一批資料，非完整歷史)</div>';
      return;
    }
    el.innerHTML = records.map(r => `
      <div class="penalty-item">
        <div class="penalty-case">${r.case || '（無案件名稱）'}</div>
        <div class="penalty-fact">${r.fact || ''}</div>
        <div class="penalty-meta">${r.date || ''}${r.fine ? ' · 罰鍰 ' + Number(r.fine).toLocaleString() + ' 元' : ''}</div>
      </div>
    `).join('');
  } catch(err){
    el.innerHTML = '<div class="placeholder">查無分公司資料</div>';
  }
}

/* ---------------------------------------------------------
   複製名稱 + 外部查證區塊——原本是獨立的「進階查詢」面板，要另外點開
   工具列一顆按鈕才看得到，使用率偏低（很多人根本不知道有這個功能）。
   現在併進公司／人物／法人各自的詳細資料面板裡：查完一間公司，同一個
   畫面往下捲就能看裁罰紀錄、複製名稱去查裁判書，不用再多點一次。

   三個面板（renderCompanyPanel／renderPersonPanel／foundationRecordDetailHtml）
   共用這裡的 HTML 產生器跟事件綁定，各自傳自己的名稱進來。 */
function copyToClipboard(name){
  if(!navigator.clipboard) return Promise.reject(new Error('no clipboard'));
  return navigator.clipboard.writeText(name);
}

/* 標題做成可以點擊複製的按鈕。用 <button> 包住既有的 <h2>，視覺上維持
   原本標題的樣子（樣式在 .entity-title 裡把按鈕預設外觀重置掉），只是
   多了一個可以點的圖示。sidebarContent 每次都整段換掉，所以 id 不會撞。 */
function entityTitleHtml(name){
  return `
    <button class="entity-title" type="button" id="entityTitleBtn" title="複製「${name}」">
      <h2>${name}</h2>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
    </button>
  `;
}

/* container 是剛設完 innerHTML 的 sidebarContent，name 是這個面板當下
   顯示的公司／人物／法人名稱——呼叫端在自己的作用域裡就有這個變數，
   不需要繞道 data-* 屬性再讀回來。 */
function bindEntityTitleCopy(container, name){
  const btn = container.querySelector('#entityTitleBtn');
  if(!btn) return;
  btn.addEventListener('click', () => {
    copyToClipboard(name).then(() => {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1400);
      setStatus(`已複製「${name}」`, 'ok', true);
    }).catch(() => {
      setStatus('這個瀏覽器不允許自動複製，請手動選取名稱。', 'err', true);
    });
  });
}

function externalLookupSectionHtml(){
  return `
    <div class="director-list">
      <div class="field-label list-label">環境部裁罰紀錄</div>
      <div id="entityEnvPenalty" class="placeholder">搜尋中…</div>
    </div>
    <div class="director-list">
      <div class="field-label list-label">其他公開資料查證</div>
      <div class="ext-btn-group">
        <button class="ext-btn" type="button" data-target="judicial">裁判書查詢系統 ↗</button>
        <button class="ext-btn" type="button" data-target="pcc">政府採購拒絕往來廠商 ↗</button>
        <button class="ext-btn" type="button" data-target="mops">公開資訊觀測站(上市櫃) ↗</button>
      </div>
      <div class="ext-note" id="entityExtNote">按上面的按鈕會先複製名稱、再開新分頁貼上查詢。</div>
    </div>
  `;
}

const EXT_NOTE_DEFAULT = '按上面的按鈕會先複製名稱、再開新分頁貼上查詢。';
function bindExternalLookups(container, name){
  loadEnvPenalty(name, 'entityEnvPenalty');
  const note = container.querySelector('#entityExtNote');
  let noteTimer = null;
  const flash = text => {
    if(!note) return;
    note.textContent = text;
    note.classList.add('flash');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note.textContent = EXT_NOTE_DEFAULT;
      note.classList.remove('flash');
    }, 4000);
  };
  container.querySelectorAll('.ext-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      /* 順序不能反過來：await 完剪貼簿再 window.open，瀏覽器會判定那不是
         使用者觸發的，把新分頁當成彈出廣告擋掉。 */
      const copying = copyToClipboard(name);
      window.open(EXT_LINKS[btn.dataset.target], '_blank', 'noopener');
      copying
        .then(() => flash(`已複製「${name}」，在新分頁的搜尋框貼上就能查。`))
        .catch(() => flash(`複製失敗，請在新分頁手動輸入「${name}」。`));
    });
  });
}

function closeHelpPanel(){
  document.getElementById('helpPanel').classList.remove('open');
  // helpBtn 已經從工具列移到帳號選單裡，這裡要容許它不存在
  const btn = document.getElementById('helpBtn');
  if(btn) btn.classList.remove('active');
}

/* 說明面板的開關抽出來，因為觸發點已經從工具列按鈕改成帳號選單。
   保留 helpBtn 的分支，是為了萬一之後又想把按鈕放回工具列。 */
function openHelpPanel(){
  const panel = document.getElementById('helpPanel');
  if(!panel) return;
  closeFeedbackPanel();
  panel.classList.add('open');
  syncPanelOffset();
}

document.getElementById('helpCloseBtn').addEventListener('click', closeHelpPanel);

/* 第一次造訪自動打開說明。

   Undercurrent 的核心互動不直觀——節點要雙擊才展開、右鍵才隱藏——不看
   說明的人很可能點兩下沒反應就離開了。但自動彈出的東西很容易變成騷擾，
   所以三件事都要做到：
     1. 只出現一次（旗標一設就不再出現，不是每次 session）
     2. 旗標在「打開的當下」就寫入，不是關閉時——使用者直接關分頁、
        或頁面當掉，都不該讓它下次再跳一次
     3. 它是側邊面板不是 modal，不擋任何操作，右上角有 × 可以關

   延遲 800 毫秒是為了讓畫面先安定下來。一載入就跳出來，使用者還在
   看版面的時候會覺得被打斷。 */
const HELP_SEEN_KEY = 'udc:help-seen';
function maybeShowFirstVisitHelp(){
  let seen = false;
  try{ seen = localStorage.getItem(HELP_SEEN_KEY) === '1'; } catch(err){ seen = true; }
  if(seen) return;
  try{ localStorage.setItem(HELP_SEEN_KEY, '1'); } catch(err){}
  setTimeout(() => {
    // 這 800 毫秒內使用者已經自己點開一個詳細資料面板的話就別插隊
    if(document.getElementById('sidebar').classList.contains('open')) return;
    track('help.open', { trigger: 'first_visit' });
    openHelpPanel();
  }, 800);
}
maybeShowFirstVisitHelp();

const legacyHelpBtn = document.getElementById('helpBtn');
if(legacyHelpBtn) legacyHelpBtn.addEventListener('click', () => {
  const panel = document.getElementById('helpPanel');
  const btn = legacyHelpBtn;
  const wasOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !wasOpen);
  btn.classList.toggle('active', !wasOpen);
});

/* ---------------------------------------------------------
   側邊詳細資料面板
--------------------------------------------------------- */
function openSidebar(){ document.getElementById('sidebar').classList.add('open'); }
function closeSidebar(){ document.getElementById('sidebar').classList.remove('open'); }

function renderPersonPanel(name){
  const linkedCompanies = edges.get().filter(e => e.to === personNodeId(name) || e.from === personNodeId(name));
  const companyRoles = new Map(); // companyId -> { name, role, title }
  linkedCompanies.forEach(e => {
    // 公司（c:）或法人/社團（f:）都算，不是只有公司才顯示
    const orgId = ['c:', 'f:'].some(p => e.from.startsWith(p)) ? e.from
      : (['c:', 'f:'].some(p => e.to.startsWith(p)) ? e.to : null);
    if(!orgId) return;
    const n = nodes.get(orgId);
    if(!n) return;
    companyRoles.set(orgId, {
      name: n.label.replace(/^⚠ /, '').replace(/^法人：/, '').split('\n')[0],
      role: e.label || '',
      title: e.title || '',
    });
  });
  const companyList = [...companyRoles.values()];

  const gid = groupIdForRoot('person:' + name);
  const collapseToggleHtml = gid ? `
    <div class="field">
      <button class="ext-link" id="toggleGroupBtn">
        ${groups.get(gid).collapsed ? '展開此人資料 ▾' : '收合此人資料 ▴'}
      </button>
    </div>
  ` : '';

  const sidebarContent = document.getElementById('sidebarContent');
  sidebarContent.innerHTML = `
    <span class="tag person">人物</span>
    ${entityTitleHtml(name)}
    <div class="field">
      <div class="footnote">此節點是依「姓名字串完全相同」自動歸併，並非透過身分證字號等唯一識別碼確認為同一人。常見姓名可能對應不同真實個人，穿透關係僅供參考，需自行查證。</div>
    </div>
    <div class="director-list">
      <div class="field-label list-label">目前圖中關聯公司（${companyList.length}）</div>
      ${companyList.length ? companyList.map(c => `
        <div class="director-block">
          <div class="director-row">
            <span class="director-name">${c.name}</span>
            <span class="director-position">${c.role}</span>
          </div>
          ${c.title ? `<div class="director-shares">${c.title}</div>` : ''}
        </div>
      `).join('') : '<div class="placeholder">尚未展開</div>'}
    </div>
    ${collapseToggleHtml}
    ${externalLookupSectionHtml()}
  `;
  bindEntityTitleCopy(sidebarContent, name);
  bindExternalLookups(sidebarContent, name);
  openSidebar();
  if(gid){
    document.getElementById('toggleGroupBtn').addEventListener('click', () => {
      if(groups.get(gid).collapsed) expandGroup(gid); else collapseGroup(gid);
      renderPersonPanel(name);
    });
  }
}

async function renderCompanyPanel(ubn, nameGuess){
  const sidebarContent = document.getElementById('sidebarContent');
  sidebarContent.innerHTML = `<div class="placeholder">載入公司資料中…</div>`;
  openSidebar();
  try{
    const [full, people] = await Promise.all([
      getCompanyDetailOnly(ubn, nameGuess),
      getCompanyD1People(ubn).catch(() => ({ directors: [], managers: [] })), // D1 查不到就退回沒有名單，不要讓整個面板壞掉
    ]);
    applyStatusFlag(ubn, full);
    const isAbnormal = full.status && !HEALTHY_STATUS_HINTS.some(s => full.status.includes(s));

    // 優先用 D1 的名單（欄位比較完整：所代表法人、持股數、經理人到職日）；
    // 只有 D1 真的查不到這間公司時（例如還沒被匯入），才另外打一次 GCIS
    // 查董監事名單當備援——平常不會多打這一次。
    let directorRows, managerRows;
    if(people.directors.length > 0 || people.managers.length > 0){
      directorRows = people.directors.map(d => ({ name: d.person_name, position: d.position, represents: d.represents, shares: d.shares, juristic: d.represents, juristicUbn: '' }));
      managerRows = people.managers;
    } else {
      directorRows = await getCompanyDirectorsViaGcis(ubn).catch(() => []);
      managerRows = [];
    }

    const companyName = full.name || nameGuess;
    sidebarContent.innerHTML = `
      <span class="tag company">公司</span>${isAbnormal ? '<span class="tag flag">狀態異常</span>' : ''}
      ${entityTitleHtml(companyName)}
      <button class="report-trigger-btn" id="bmrTriggerBtn" data-ubn="${full.ubn}" data-name="${companyName}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10"/><path d="M12 20V4"/><path d="M20 20v-6"/></svg>
        生成商業模式報告
        <svg class="bmr-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      </button>
      <div class="field">
        <div class="field-label">統一編號</div>
        <div class="field-value hero">${full.ubn}</div>
      </div>
      ${full.status ? `<div class="field"><div class="field-label">公司現況</div><div class="field-value">${full.status}</div></div>` : ''}
      ${full.setupDate ? `<div class="field"><div class="field-label">核准設立日</div><div class="field-value">${rocDate(full.setupDate)}</div></div>` : ''}
      ${full.capital ? `<div class="field"><div class="field-label">資本額</div><div class="field-value">${Number(full.capital).toLocaleString()} 元</div></div>` : ''}
      ${full.address ? `<div class="field"><div class="field-label">地址</div><div class="field-value">${full.address}</div></div>` : ''}
      <div class="director-list">
        <div class="field-label list-label">董監事名單（點擊姓名可延伸查詢；法人代表可再往上查）</div>
        ${directorRows.map(d => `
          <div class="director-block">
            <div class="director-row" data-name="${d.name}">
              <span class="director-name">${d.name}</span>
              <span class="director-position">${d.position || ''}</span>
            </div>
            ${(d.shares !== undefined && d.shares !== null && d.shares !== '') ? `<div class="director-shares">持股數：${formatShares(d.shares)}</div>` : ''}
            ${d.juristic ? `<div class="juristic-row" data-juristic="${d.juristic}" data-juristic-ubn="${d.juristicUbn || ''}">↳ 法人代表：${d.juristic} — 查詢該法人 →</div>` : ''}
          </div>
        `).join('') || '<div class="placeholder">無資料</div>'}
      </div>
      ${managerRows.length ? `
        <div class="director-list">
          <div class="field-label list-label">經理人名單</div>
          ${managerRows.map(m => `
            <div class="director-block">
              <div class="director-row" data-name="${m.manager_name}">
                <span class="director-name">${m.manager_name}</span>
                <span class="director-position">經理人</span>
              </div>
              ${m.start_date ? `<div class="director-shares">到職日：${m.start_date}</div>` : ''}
              ${m.note ? `<div class="director-shares">備註：${m.note}</div>` : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="branch-list" id="branchSection">
        <div class="field-label list-label">分公司資料</div>
        <div class="placeholder">查詢中…</div>
      </div>
      ${externalLookupSectionHtml()}
    `;
    bindEntityTitleCopy(sidebarContent, companyName);
    bindExternalLookups(sidebarContent, companyName);

    sidebarContent.querySelectorAll('.director-row').forEach(row => {
      row.addEventListener('click', () => expandFromPerson(row.dataset.name));
    });
    sidebarContent.querySelectorAll('.juristic-row').forEach(row => {
      row.addEventListener('click', () => {
        const targetUbn = row.dataset.juristicUbn;
        if(targetUbn){
          expandJuristicDirectorDirect(ubn, targetUbn, row.dataset.juristic);
        } else {
          expandJuristicDirector(ubn, row.dataset.juristic);
        }
      });
    });
    loadBranches(ubn);
    document.getElementById('bmrTriggerBtn')?.addEventListener('click', e => {
      /* e.target 可能是按鈕裡的 svg／path（點到圖示的時候），
         dataset 掛在 button 上，所以要往上找到按鈕本身再讀。 */
      const btn = e.currentTarget;
      if(!canGenerateReport){
        // 沒權限的人不打 API（伺服器也會擋），改成先讓他知道這是什麼
        track('report.locked_click', { company: btn.dataset.name });
        openPaywall(btn.dataset.name);
        return;
      }
      track('report.click');
      generateBusinessModelReport('company', btn.dataset.name, btn.dataset.ubn);
    });
  } catch(err){
    sidebarContent.innerHTML = `<div class="placeholder">載入失敗：${err.message}</div>`;
  }
}

async function loadBranches(ubn){
  const el = document.getElementById('branchSection');
  if(!el) return;
  try{
    const data = await getBranches(ubn);
    const list = Array.isArray(data) ? data : [];
    if(list.length === 0){
      el.innerHTML = `<div class="field-label list-label">分公司資料</div><div class="placeholder">查無分公司資料</div>`;
      return;
    }
    el.innerHTML = `
      <div class="field-label list-label">分公司資料（${list.length}）</div>
      ${list.map(b => {
        const name = b.Branch_Office_Name || '未命名分公司';
        const no = b.Branch_Office_Business_Accounting_NO || '';
        const manager = b.Branch_Office_Manager_Name || '';
        const status = b.Branch_Office_Status_Desc || '';
        const isRevoked = status && !status.includes('核准設立');
        const address = b.Branch_Office_Location || '';
        return `
          <div class="branch-item">
            <div>
              <span>${name}</span>
              ${no ? `<span class="branch-no">${no}</span>` : ''}
              ${isRevoked ? `<span class="tag flag">${status}</span>` : ''}
            </div>
            ${manager ? `<div class="branch-meta">經理人：${manager}</div>` : ''}
            ${address ? `<div class="branch-meta">${address}</div>` : ''}
          </div>
        `;
      }).join('')}
    `;
  } catch(err){
    el.innerHTML = `<div class="field-label list-label">分公司資料</div><div class="placeholder">查詢失敗：${err.message}</div>`;
  }
}

/* 人物節點的單擊會先延遲一小段時間才真的開資訊面板，是為了讓「點兩下
   查公司」有機會先發生——面板一開就會蓋住節點，手機小螢幕上想點第二
   下常常已經點不到節點本體了。延遲時間要跟 vis-network 判定雙擊的間隔
   差不多，太短會讓雙擊來不及被取消、太長則單擊會感覺卡頓。 */
const PERSON_CLICK_DELAY = 300;
let pendingPersonClick = null;

function cancelPendingPersonClick(){
  if(!pendingPersonClick) return;
  clearTimeout(pendingPersonClick.timer);
  pendingPersonClick = null;
}

network.on('click', params => {
  if(params.nodes.length === 0) return;
  const id = params.nodes[0];
  if(id.startsWith('cluster:')){
    expandCluster(id);
  } else if(id.startsWith('p:')){
    cancelPendingPersonClick();
    const timer = setTimeout(() => {
      pendingPersonClick = null;
      renderPersonPanel(id.slice(2));
    }, PERSON_CLICK_DELAY);
    pendingPersonClick = { id, timer };
  } else if(id.startsWith('c:')){
    const label = nodes.get(id).label.replace(/^⚠ /, '').split('\n')[0];
    renderCompanyPanel(id.slice(2), label);
  } else if(id.startsWith('f:')){
    renderFoundationPanel(id.slice(2));
  }
});

network.on('doubleClick', params => {
  if(params.nodes.length === 0) return;
  const id = params.nodes[0];
  if(id.startsWith('p:')){
    cancelPendingPersonClick();
    expandFromPerson(id.slice(2));
  }
});

/* 右鍵點一下節點：從畫面上隱藏（純前端，不動資料庫），適合人名太
   常見、混進一堆明顯不相關公司時，手動排除掉那些節點。 */
network.on('oncontext', params => {
  params.event.preventDefault();
  const nodeId = network.getNodeAt(params.pointer.DOM);
  if(!nodeId) return;
  const node = nodes.get(nodeId);
  if(!node) return;
  /* 原本只藏右鍵點到的那一個節點，公司藏了、底下的董監事經理人還留在原地，
     一群沒有連線的圓點飄在畫面上。查交叉持股時一次會展開好幾間公司，這個
     問題特別明顯。現在連同「只連到它」的節點一起藏；同時連著別間公司的人
     會留下，因為那正是要找的交叉關係。 */
  const orphans = hideWithOrphans(nodeId);
  const label = node.label.replace(/^⚠ /, '').split('\n')[0];
  setStatus(
    orphans.length
      ? `已隱藏「${label}」和只連到它的 ${orphans.length} 個節點（右上角可以復原）`
      : `已隱藏「${label}」（右上角可以復原）`,
    'ok', true
  );
});

/* ---------------------------------------------------------
   匯出：目前的圖存成 PNG，目前的公司/關係清單存成 CSV
--------------------------------------------------------- */
function timestamp(){
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function triggerDownload(url, filename){
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function toCsvValue(v){
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}
function toCsv(rows){
  return rows.map(r => r.map(toCsvValue).join(',')).join('\r\n');
}

/* 把所有看得到的節點塞滿指定尺寸的畫面。

   為什麼不直接用 network.fit()：vis-network 的 fit 把縮放上限寫死在 1.0，
   節點少的圖（例如只有兩家公司加幾個人）本來可以放大，它卻維持原大小，
   結果縮圖中間一小撮、四周一大片空白，字也小到看不清楚。
   這裡自己從節點的外框算縮放，讓圖填滿畫面，只保留固定的留白。

   上限 2.5：只剩一兩個節點時不要放大到整張圖只看得到半個方框。
   留白給 64：getBoundingBox 傳回的是節點本身的外框，人物節點的姓名標在圓圈
   下方、連線上的文字也會凸出去，留白太小會被切到。 */
function fitGraphIntoFrame(width, height, maxScale){
  const ids = nodes.get({ filter: n => !n.hidden }).map(n => n.id);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ids.forEach(id => {
    const b = network.getBoundingBox(id);
    if(!b) return;
    minX = Math.min(minX, b.left);  maxX = Math.max(maxX, b.right);
    minY = Math.min(minY, b.top);   maxY = Math.max(maxY, b.bottom);
  });
  if(!isFinite(minX)){ network.fit({ animation: false }); return; }
  const pad = 64;
  const boxW = Math.max(1, maxX - minX);
  const boxH = Math.max(1, maxY - minY);
  const scale = Math.max(0.15, Math.min(
    maxScale || 2.5,
    (width - pad * 2) / boxW,
    (height - pad * 2) / boxH
  ));
  network.moveTo({
    position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    scale,
    animation: false,
  });
}

/* 把整張關係圖（不是只有目前螢幕看得到的那塊）畫成指定尺寸的 canvas。
   匯出 PNG 跟分享用的預覽縮圖都走這裡：兩者要做的事一樣，只差尺寸跟輸出格式。
   做法是把畫布暫時搬到畫面外、放大到目標解析度、fit 一次，畫完再還原。 */
async function renderGraphToCanvas(width, height, outputSize, opts){
  const print = !!(opts && opts.print);
  const prevTheme = currentTheme;
  const container = document.getElementById('graph');
  const prevViewPosition = network.getViewPosition();
  const prevScale = network.getScale();
  const prevStyle = {
    position: container.style.position,
    top: container.style.top,
    left: container.style.left,
    width: container.style.width,
    height: container.style.height,
  };
  try{
    if(print){
      currentTheme = 'print';
      applyThemeToNetworkOptions();
      repaintAllNodesForTheme();
    }
    container.style.position = 'fixed';
    container.style.left = '-99999px';
    container.style.top = '0px';
    container.style.width = width + 'px';
    container.style.height = height + 'px';

    network.setSize(width + 'px', height + 'px');
    // 物理模擬還在跑的話，算好縮放到真的畫出來的這兩個 frame 之間節點還會移動，
    // 圖就會偏掉（實測過：偏到只剩半張圖在畫面裡）。先把模擬停下來再取景。
    network.stopSimulation();
    fitGraphIntoFrame(width, height);

    // 等瀏覽器真的重繪過兩個 frame，再去讀 canvas 內容，不然常常會抓到
    // 還沒畫完的半成品。但 requestAnimationFrame 在背景分頁完全不會觸發，
    // 沒有這個 1 秒的保險，使用者切到別的分頁時整個匯出／建立快照會永遠卡住。
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if(!settled){ settled = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 1000);
    });

    const sourceCanvas = network.canvas.frame.canvas;
    // vis-network 的 canvas 本身背景是透明的（畫面上看到的底色其實是
    // CSS 疊出來的），直接輸出會變成透明背景，這裡合成一張有實色背景的圖，
    // 看起來才像「這個工具長的樣子」；JPEG 更是完全不支援透明。
    const bg = print ? '#FFFFFF' : (getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#ffffff');
    const composed = document.createElement('canvas');
    /* 畫布的實際像素是「版面尺寸 x 螢幕的 devicePixelRatio」：在 DPR 1.5 的螢幕上，
       要求 1200x630 實際會拿到 1800x945。匯出 PNG 樂見這個額外解析度，但預覽縮圖
       不需要——卡片顯示寬度大約 500px，多出來的像素只是讓檔案變大，而且跟我們在
       og:image:width 宣告的 1200 對不起來。給了 outputSize 就縮放到剛好那個尺寸。 */
    // 報導版在圖下方多留一條說明列：來源與「同名同姓不一定是同一人」的提醒跟著圖一起走，
    // 圖被轉貼到別處時，讀者不用回來找免責聲明
    const scale = sourceCanvas.width / width;
    const footH = print ? Math.round(110 * scale) : 0;
    composed.width = outputSize ? outputSize.w : sourceCanvas.width;
    composed.height = (outputSize ? outputSize.h : sourceCanvas.height) + footH;
    const ctx = composed.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, composed.width, composed.height);
    ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, composed.width, composed.height - footH);
    if(print){
      const face = "'Helvetica Neue', Helvetica, Arial, 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif";
      const pad = Math.round(48 * scale), top = composed.height - footH;
      ctx.fillStyle = '#111111';
      ctx.fillRect(pad, top, composed.width - pad * 2, Math.max(2, Math.round(3 * scale)));
      ctx.textBaseline = 'alphabetic';
      ctx.font = '700 ' + Math.round(26 * scale) + 'px ' + face;
      ctx.fillText('UNDERCURRENT', pad, top + Math.round(52 * scale));
      const w = ctx.measureText('UNDERCURRENT').width;
      ctx.fillStyle = '#555555';
      ctx.font = '400 ' + Math.round(24 * scale) + 'px ' + face;
      ctx.fillText('　資料：經濟部商業司　人物以姓名歸併，同名同姓不一定是同一人', pad + w, top + Math.round(52 * scale));
      ctx.textAlign = 'right';
      ctx.fillText(timestamp(), composed.width - pad, top + Math.round(52 * scale));
      ctx.textAlign = 'left';
    }
    return composed;
  } finally{
    // 還原成原本畫面上看到的大小跟視角
    container.style.position = prevStyle.position;
    container.style.top = prevStyle.top;
    container.style.left = prevStyle.left;
    container.style.width = prevStyle.width;
    container.style.height = prevStyle.height;
    network.setSize('100%', '100%');
    network.moveTo({ position: prevViewPosition, scale: prevScale, animation: false });
    if(print){
      currentTheme = prevTheme;
      applyThemeToNetworkOptions();
      repaintAllNodesForTheme();
    }
  }
}

/* 分享連結的預覽縮圖：1200x630 是 Threads／LINE／Facebook 預覽卡片的標準比例。
   用 JPEG 而不是 PNG——同一張圖 PNG 約 214KB、JPEG q0.82 約 76KB（實測，base64 後的大小）。

   畫質不寫死，改成「壓到預算內為止」：節點少的圖用最高畫質也很小，沒必要犧牲；
   節點多、標籤密的圖才需要降下來。實測同一張圖 q0.8≈76KB、q0.7≈61KB、q0.6≈53KB，
   差別主要在文字邊緣的雜訊，卡片實際顯示寬度大約 500px，看不太出來。
   0.6 還是超過預算就直接用它——那已經是很密的圖，再壓下去文字會糊掉，
   而且 worker 端還有 400KB 的硬上限擋著。

   失敗就回 null：沒有縮圖只是預覽卡片少一張圖，不該害使用者建立不了快照。 */
const PREVIEW_BUDGET_B64 = 60 * 1024; // base64 長度，換算實際檔案約 45KB

async function captureGraphPreview(){
  try{
    const canvas = await renderGraphToCanvas(1200, 630, { w: 1200, h: 630 });
    let url = '';
    for(const quality of [0.8, 0.7, 0.6]){
      url = canvas.toDataURL('image/jpeg', quality);
      if(url.length <= PREVIEW_BUDGET_B64) break;
    }
    return url || null;
  } catch(err){
    console.error('預覽縮圖產生失敗', err);
    return null;
  }
}

async function exportPng(print){
  try{
    setStatus('正在產生完整圖片…', 'loading', false);
    const canvas = await renderGraphToCanvas(2400, 1600, undefined, { print: !!print });
    triggerDownload(canvas.toDataURL('image/png'), `undercurrent-graph-${print ? 'print-' : ''}${timestamp()}.png`);
    setStatus(print ? '報導版圖片已匯出（白底，附資料來源與同名提醒）' : '圖片已匯出（完整關係圖，不只是目前畫面）', 'ok', true);
  } catch(err){
    setStatus(`圖片匯出失敗：${err.message}`, 'err', true);
  }
}

function exportCsv(){
  const companyRows = [['統一編號', '公司名稱', '現況', '資本額', '地址', '核准設立日']];
  nodes.get().forEach(n => {
    if(n.id.startsWith('c:')){
      const ubn = n.id.slice(2);
      const full = cacheDetail.get(ubn) || {};
      const name = n.label.replace(/^⚠ /, '').split('\n')[0];
      companyRows.push([ubn, name, full.status || '', full.capital || '', full.address || '', full.setupDate || '']);
    }
  });

  const relRows = [['人物', '公司', '統一編號', '關係']];
  edges.get().forEach(e => {
    let personId = null, companyId = null;
    if(e.from.startsWith('p:') && e.to.startsWith('c:')){ personId = e.from; companyId = e.to; }
    else if(e.from.startsWith('c:') && e.to.startsWith('p:')){ personId = e.to; companyId = e.from; }
    if(personId && companyId){
      const companyNode = nodes.get(companyId);
      relRows.push([
        personId.slice(2),
        companyNode ? companyNode.label.replace(/^⚠ /, '').split('\n')[0] : '',
        companyId.slice(2),
        e.label || ''
      ]);
    }
  });

  const csv = '公司清單\r\n' + toCsv(companyRows) + '\r\n\r\n關係清單\r\n' + toCsv(relRows);
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `undercurrent-data-${timestamp()}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

document.getElementById('exportBtn').addEventListener('click', () => {
  track('export.click');
  stopShareHint();
  document.getElementById('exportMenu').classList.toggle('open');
});
document.getElementById('exportPngBtn').addEventListener('click', () => {
  document.getElementById('exportMenu').classList.remove('open');
  exportPng();
});
document.getElementById('exportPngPrintBtn').addEventListener('click', () => {
  document.getElementById('exportMenu').classList.remove('open');
  track('graph.export_print');
  exportPng(true);
});
document.getElementById('exportCsvBtn').addEventListener('click', () => {
  document.getElementById('exportMenu').classList.remove('open');
  exportCsv();
  setStatus('已匯出資料清單（CSV）', 'ok', true);
});
document.getElementById('shareGraphBtn').addEventListener('click', () => {
  document.getElementById('exportMenu').classList.remove('open');
  openShareGraph();
});

/* ---------------------------------------------------------
   分享／嵌入關係圖快照

   把「目前畫面上看得到的」存成一張不會再變動的快照：隱藏的節點、交集模式濾掉的
   都不會進去，所以使用者先把圖整理乾淨，存下來的就是乾淨的那張。位置也一起存，
   嵌入之後讀者看到的就是建立者整理好的樣子，不會每次打開重新排版。

   後端會用白名單重組這份資料（worker/index.js 的 sanitizeSnapshot），這裡只負責
   把畫面上的狀態讀出來。
--------------------------------------------------------- */
let shareGraphState = null; // { token, title }

function defaultGraphTitle(){
  // 群組的 rootName 是「類型:查詢字串」，例如 company:南亞科技股份有限公司
  const roots = [...groups.values()].map(g => String(g.rootName || '').split(':').slice(1).join(':')).filter(Boolean);
  const base = roots.length ? roots[0] + (roots.length > 1 ? ' 等' : '') + '的關係圖' : '關係圖';
  // 標題會跟著快照進到報導裡，寫讀者看得懂的「公司之間的交集」，不只寫按鈕上的兩個字
  return (crossOnly ? base + '（公司之間的交集）' : base).slice(0, 80);
}

function captureGraphSnapshot(){
  const shown = nodes.get({ filter: n => !n.hidden });
  const ids = new Set(shown.map(n => n.id));
  const pos = network.getPositions([...ids]);
  const outNodes = shown.map(n => {
    const o = { id: n.id, l: n.label, x: pos[n.id] ? pos[n.id].x : 0, y: pos[n.id] ? pos[n.id].y : 0 };
    if(isSearchRoot(n.id)) o.s = 1;
    if(n.id.startsWith('c:')){
      if(n.shapeProperties && n.shapeProperties.borderDashes) o.d = 1;  // 法人代表穿透找到的
      if(String(n.label || '').startsWith('⚠')) o.w = 1;               // 公司狀態異常
    }
    return o;
  });
  const outEdges = edges.get({ filter: e => !e.hidden && ids.has(e.from) && ids.has(e.to) }).map(e => {
    const o = { f: e.from, t: e.to, l: e.label || '' };
    if(e.dashes) o.d = 1;
    return o;
  });
  return { nodes: outNodes, edges: outEdges };
}

function graphLinks(token, title, themeName){
  const dark = themeName === 'dark';
  const embedSrc = location.origin + '/embed?t=' + token + (dark ? '&theme=dark' : '');
  const safeTitle = String(title || '').replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
  // 寬度 100% 跟著文章欄寬；高度固定 520——iframe 沒辦法自己量出內容高度，
  // 520 在手機直向與桌機文章欄都看得完整，太高會讓讀者捲很久才離開這張圖。
  const code = '<iframe src="' + embedSrc + '" title="關係圖：' + safeTitle + '" width="100%" height="520"'
    + ' style="border:1px solid ' + (dark ? '#1E3648' : '#DCE9E6') + ';border-radius:8px;max-width:100%;"'
    + ' loading="lazy"></iframe>';
  return { link: location.origin + '/graph?t=' + token, embedSrc, code };
}

function showShareStep(step){
  ['shareGraphLogin', 'shareGraphForm', 'shareGraphResult'].forEach(id => {
    document.getElementById(id).hidden = (id !== step);
  });
}

/* 圖上「看得到的、用姓名查到的」節點：用姓名展開過的人，以及那次姓名查詢帶進來的一切。

   姓名查詢（搜尋框選「姓名」，或在圖上點兩下某個人）是拿名字去比對整個資料庫的
   公司登記資料，同名同姓的人會被當成同一個人、連到跟他無關的公司——這種錯誤放進
   報導，就是對當事人的錯誤指控。以公司、統編、法人為起點的圖，每一條連線都來自
   那間公司自己的登記名單，錯誤的機會小得多。

   兩個來源：seenPeople 是「用姓名展開過的人」（搜尋和點兩下兩條路都會寫進去），
   nameDerivedNodes 是「那次姓名查詢帶進來的節點」。只看人不夠——把人藏起來之後，
   他帶進來、但另外還有董事的公司會留在圖上變成孤島（見 nameDerivedNodes 的說明）。
   只看「目前看得到的」。

   這裡不會擋住分享——查證是使用者的責任，不是系統在源頭限制使用者的行為。
   只在圖上確實有這類內容時，於分享視窗多提醒一次風險是什麼；建立快照仍須
   勾選「已查證」，每張快照也都記錄了建立者。 */
function nameDerivedVisible(){
  const shown = nodes.get({ filter: n => !n.hidden });
  const people = shown.filter(n => n.id.startsWith('p:') && seenPeople.has(n.id.slice(2)));
  const ids = shown.filter(n => nameDerivedNodes.has(n.id) || (n.id.startsWith('p:') && seenPeople.has(n.id.slice(2)))).map(n => n.id);
  return { people: people.map(n => n.id.slice(2)), ids };
}

async function openShareGraph(){
  const count = nodes.get({ filter: n => !n.hidden }).length;
  if(count === 0){
    setStatus('畫面上還沒有關係圖，先查詢一間公司或一個人', 'err', true);
    return;
  }
  const byName = nameDerivedVisible();
  const warning = document.getElementById('shareGraphNameWarning');
  if(byName.ids.length){
    track('graph.share_name_warning', { people: byName.people.length, nodes: byName.ids.length });
    const people = byName.people.slice(0, 5).map(n => '「' + n + '」').join('、')
      + (byName.people.length > 5 ? ` 等 ${byName.people.length} 人` : '');
    const others = byName.ids.length - byName.people.length;
    const who = people
      ? people + (others > 0 ? `，以及透過姓名查到的另外 ${others} 個節點` : '')
      : `透過姓名查到的 ${others} 個節點`;
    warning.textContent = `這張圖包含用姓名查到的內容（${who}）。姓名查詢是拿名字去比對全部的公司登記資料，同名同姓的人會被當成同一個人，連到其實跟他無關的公司。分享前請自行查證。`;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  track('graph.share_open', { nodes: count });
  shareGraphState = null;
  document.getElementById('shareGraphCount').textContent = String(count);
  document.getElementById('shareGraphTitle').value = defaultGraphTitle();
  document.getElementById('shareGraphConfirm').checked = false;
  document.getElementById('shareGraphCreate').disabled = true;
  document.getElementById('shareGraphCreate').textContent = '建立快照';
  document.getElementById('shareGraphModal').classList.add('open');

  if(window.SupabaseBridge){
    showShareStep('shareGraphForm');
    return;
  }
  const token = await getAccessToken();
  if(!token){
    document.getElementById('shareGraphLoginLink').href = AUTH_HUB + '/auth/google?redirect='
      + encodeURIComponent(location.origin + '/login.html');
    showShareStep('shareGraphLogin');
    return;
  }
  showShareStep('shareGraphForm');
}

function closeShareGraph(){
  document.getElementById('shareGraphModal').classList.remove('open');
}

function renderShareResult(){
  if(!shareGraphState) return;
  const themeName = document.getElementById('shareGraphTheme').value;
  const { link, embedSrc, code } = graphLinks(shareGraphState.token, shareGraphState.title, themeName);
  document.getElementById('shareGraphLink').value = link;
  document.getElementById('shareGraphCode').value = code;
  document.getElementById('shareGraphPreview').href = embedSrc;
}

document.getElementById('shareGraphConfirm').addEventListener('change', e => {
  document.getElementById('shareGraphCreate').disabled = !e.target.checked;
});

document.getElementById('shareGraphCreate').addEventListener('click', async () => {
  const btn = document.getElementById('shareGraphCreate');
  if(!document.getElementById('shareGraphConfirm').checked) return;
  btn.disabled = true;
  btn.textContent = '建立中…';
  try{
    const title = document.getElementById('shareGraphTitle').value.trim() || defaultGraphTitle();
    const preview = await captureGraphPreview();
    let data;

    if(window.SupabaseBridge){
      const snapshotPayload = {
        title,
        preview,
        ...captureGraphSnapshot()
      };
      data = await window.SupabaseBridge.saveSnapshot(snapshotPayload);
    } else {
      const token = await getAccessToken();
      if(!token){ showShareStep('shareGraphLogin'); return; }
      const res = await fetch('/api/graph-snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ title, preview, ...captureGraphSnapshot() }),
      });
      data = await res.json().catch(() => ({}));
      if(res.status === 401){ showShareStep('shareGraphLogin'); return; }
      if(!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    }
    shareGraphState = { token: data.token, title: data.title };
    document.getElementById('shareGraphTheme').value = currentTheme === 'dark' ? 'dark' : 'light';
    renderShareResult();
    lsSet(SHARE_HINT_DONE_KEY, '1'); // 已經用過分享，不需要再提示
    showShareStep('shareGraphResult');
    track('graph.share_create', { nodes: data.node_count || 0 });
  } catch(err){
    setStatus('建立失敗：' + err.message, 'err', true);
  } finally {
    btn.disabled = !document.getElementById('shareGraphConfirm').checked;
    btn.textContent = '建立快照';
  }
});

document.getElementById('shareGraphTheme').addEventListener('change', renderShareResult);

// 複製按鈕：分享視窗與「我的關係圖」共用
async function copyText(text, btn){
  try{
    await navigator.clipboard.writeText(text);
  } catch(err){
    setStatus('瀏覽器不允許自動複製，請手動選取後複製', 'err', true);
    return;
  }
  if(btn){
    const old = btn.textContent;
    btn.textContent = '已複製';
    setTimeout(() => { btn.textContent = old; }, 1400);
  }
}
document.querySelectorAll('#shareGraphModal .share-copy').forEach(btn => {
  btn.addEventListener('click', () => {
    const el = document.getElementById(btn.dataset.copy);
    copyText(el.value, btn);
    track('graph.share_copy', { what: btn.dataset.copy === 'shareGraphCode' ? 'embed' : 'link' });
  });
});

document.getElementById('closeShareGraph').addEventListener('click', closeShareGraph);
document.getElementById('shareGraphModal').addEventListener('click', e => {
  if(e.target.id === 'shareGraphModal') closeShareGraph();
});

/* 我的關係圖：回頭複製連結、撤回，或刪除已撤回的。 */
function closeMyGraphs(){
  document.getElementById('myGraphsModal').classList.remove('open');
}

async function openMyGraphs(){
  const modal = document.getElementById('myGraphsModal');
  const summary = document.getElementById('myGraphsSummary');
  const list = document.getElementById('myGraphsList');
  modal.classList.add('open');
  summary.textContent = '載入中…';
  list.innerHTML = '';
  try{
    const token = await getAccessToken();
    if(!token){ summary.textContent = '請先登入。'; return; }
    const res = await fetch('/api/my-snapshots', { headers: { Authorization: 'Bearer ' + token } });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    const items = data.snapshots || [];
    if(items.length === 0){
      summary.textContent = '';
      list.innerHTML = '<div class="my-reports-empty">還沒有建立過關係圖。整理好畫面之後，從工具列的「匯出 → 分享／嵌入這張圖」建立。</div>';
      return;
    }
    const active = items.filter(i => !i.withdrawn_at).length;
    summary.textContent = `共 ${items.length} 張，其中 ${active} 張有效。撤回後，所有嵌入或連結的地方都會顯示「已由建立者撤回」。`;
    const DAY = 24 * 3600 * 1000;
    list.innerHTML = items.map(i => {
      const withdrawn = !!i.withdrawn_at;
      // 跟伺服器的規則一致：建立不滿 24 小時不能刪（伺服器才是真正的關卡，這裡只是別讓人白按）
      const tooNew = Date.now() - Date.parse(i.created_at) < DAY;
      return '<div class="my-graph-item' + (withdrawn ? ' withdrawn' : '') + '">'
        + '<div class="my-graph-text">'
        +   '<div class="my-report-name">' + escapeHtml(i.title || '關係圖') + '</div>'
        +   '<div class="my-report-date">' + escapeHtml(String(i.created_at || '').slice(0, 10))
        +     '・' + escapeHtml(String(i.node_count || 0)) + ' 個節點'
        +     (withdrawn ? '・已撤回' : '') + '</div>'
        + '</div>'
        + (withdrawn
          ? '<div class="my-graph-actions"><button type="button" class="share-copy danger" data-act="delete" data-token="' + escapeHtml(i.token) + '"'
            + (tooNew ? ' disabled title="建立滿 24 小時後才能刪除"' : '') + '>刪除</button></div>'
          :
            '<div class="my-graph-actions">'
          +   '<button type="button" class="share-copy" data-act="link" data-token="' + escapeHtml(i.token) + '">複製連結</button>'
          +   '<button type="button" class="share-copy" data-act="code" data-token="' + escapeHtml(i.token) + '" data-title="' + escapeHtml(i.title || '') + '">嵌入碼</button>'
          +   '<button type="button" class="share-copy danger" data-act="withdraw" data-token="' + escapeHtml(i.token) + '">撤回</button>'
          + '</div>')
        + '</div>';
    }).join('');

    list.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const t = btn.dataset.token;
        if(btn.dataset.act === 'link') return copyText(graphLinks(t, '', 'light').link, btn);
        if(btn.dataset.act === 'code') return copyText(graphLinks(t, btn.dataset.title, 'light').code, btn);
        if(btn.dataset.act === 'delete'){
          const ok = window.confirm('刪除後這一列紀錄會從清單消失，無法復原。\n舊連結與嵌入的地方會顯示「找不到這張關係圖」，不再顯示「已由建立者撤回」。\n\n確定要刪除嗎？');
          if(!ok) return;
          btn.disabled = true;
          try{
            const tk = await getAccessToken();
            const r = await fetch('/api/graph-snapshots/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
              body: JSON.stringify({ t }),
            });
            const d = await r.json().catch(() => ({}));
            if(!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
            track('graph.delete');
            setStatus('已刪除', 'ok', true);
            openMyGraphs();
          } catch(err){
            btn.disabled = false;
            setStatus('刪除失敗：' + err.message, 'err', true);
          }
          return;
        }
        if(btn.dataset.act === 'withdraw'){
          const ok = window.confirm('撤回後，所有嵌入或連結這張圖的地方都會改顯示「已由建立者撤回」，圖的內容會被刪除，無法復原。\n\n確定要撤回嗎？');
          if(!ok) return;
          btn.disabled = true;
          try{
            const tk = await getAccessToken();
            const r = await fetch('/api/graph-snapshots/withdraw', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
              body: JSON.stringify({ t }),
            });
            const d = await r.json().catch(() => ({}));
            if(!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
            track('graph.withdraw');
            setStatus('已撤回。各處的嵌入最慢 5 分鐘內會顯示「已撤回」', 'ok', true);
            openMyGraphs();
          } catch(err){
            btn.disabled = false;
            setStatus('撤回失敗：' + err.message, 'err', true);
          }
        }
      });
    });
  } catch(err){
    summary.textContent = '載入失敗：' + err.message;
  }
}

document.getElementById('closeMyGraphs').addEventListener('click', closeMyGraphs);
document.getElementById('myGraphsModal').addEventListener('click', e => {
  if(e.target.id === 'myGraphsModal') closeMyGraphs();
});
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  closeShareGraph();
  closeMyGraphs();
});
document.addEventListener('click', e => {
  const wrapper = document.getElementById('exportMenu');
  if(!wrapper) return;
  if(!e.target.closest('.export-wrapper')) wrapper.classList.remove('open');
});

document.getElementById('accountBtn').addEventListener('click', () => {
  document.getElementById('accountMenu').classList.toggle('open');
});
document.addEventListener('click', e => {
  const menu = document.getElementById('accountMenu');
  if(!menu) return;
  if(!e.target.closest('.account-wrapper')) menu.classList.remove('open');
});

/* 讓浮動面板永遠貼在工具列底下。

   工具列是 position:fixed 而且會隨視窗寬度換行，高度不是定值。面板原本
   用寫死的 top 值，工具列一多一列就被蓋住。這裡量出實際底邊寫進 CSS
   變數，換行、加按鈕、轉螢幕方向都會自己跟上。 */
function syncPanelOffset(){
  const toolbar = document.querySelector('.toolbar');
  if(!toolbar) return;
  const bottom = toolbar.getBoundingClientRect().bottom;
  document.documentElement.style.setProperty('--panel-top', Math.round(bottom + 8) + 'px');
}
if(typeof ResizeObserver !== 'undefined'){
  const toolbar = document.querySelector('.toolbar');
  if(toolbar) new ResizeObserver(syncPanelOffset).observe(toolbar);
}
window.addEventListener('resize', syncPanelOffset);
window.addEventListener('orientationchange', syncPanelOffset);
syncPanelOffset();

/* ---------------------------------------------------------
   UI 事件
--------------------------------------------------------- */

/* ---------------------------------------------------------
   邊打字邊建議（debounce，避免每個按鍵都發一次請求）
--------------------------------------------------------- */
let suggestTimer = null;
let suggestActiveIndex = -1;

function closeSuggestList(){
  const list = document.getElementById('suggestList');
  list.classList.remove('open');
  list.innerHTML = '';
  suggestActiveIndex = -1;
}

function renderSuggestList(items){
  const list = document.getElementById('suggestList');
  if(!items.length){ closeSuggestList(); return; }
  list.innerHTML = items.map((name, i) =>
    `<div class="suggest-item" data-index="${i}">${name}</div>`
  ).join('');
  list.classList.add('open');
  suggestActiveIndex = -1;
  list.querySelectorAll('.suggest-item').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('nameInput').value = el.textContent;
      toggleClearBtn();
      closeSuggestList();
      document.getElementById('searchBtn').click();
    });
  });
}

async function fetchSuggestions(q, type){
  if(type !== 'company' && type !== 'foundation') { closeSuggestList(); return; }
  try{
    if(window.SupabaseBridge){
      const suggestions = await window.SupabaseBridge.getSuggestions(q, type);
      if(suggestions && suggestions.length > 0){
        renderSuggestList(suggestions);
        return;
      }
    }
    const endpoint = type === 'foundation' ? '/api/foundation-suggest' : '/api/d1-suggest';
    const url = new URL(endpoint, location.origin);
    url.searchParams.set('q', q);
    if(type === 'company') url.searchParams.set('type', type);
    const data = await fetchJson(url.toString(), 5000);
    renderSuggestList(data.suggestions || []);
  } catch(err){
    closeSuggestList();
  }
}

let isComposing = false; // 中文注音/拼音選字階段（候選字還沒真的選定）不要提早觸發查詢

function triggerSuggest(rawValue){
  const q = rawValue.trim();
  clearTimeout(suggestTimer);
  if(q.length < 2){ closeSuggestList(); return; }
  suggestTimer = setTimeout(() => {
    const type = document.getElementById('searchType').value;
    fetchSuggestions(q, type);
  }, 300); // 停頓 300 毫秒才真的發請求，不是每個按鍵都送
}

document.getElementById('nameInput').addEventListener('compositionstart', () => { isComposing = true; });
document.getElementById('nameInput').addEventListener('compositionend', e => {
  isComposing = false;
  triggerSuggest(e.target.value); // 選字完成、字真的定下來了，才觸發
});

function toggleClearBtn(){
  const hasText = document.getElementById('nameInput').value.length > 0;
  document.getElementById('clearInputBtn').classList.toggle('show', hasText);
}

document.getElementById('nameInput').addEventListener('input', e => {
  toggleClearBtn();
  if(isComposing) return; // 還在選字候選清單階段，先不要觸發，等 compositionend
  triggerSuggest(e.target.value);
});

document.getElementById('clearInputBtn').addEventListener('click', () => {
  const input = document.getElementById('nameInput');
  input.value = '';
  toggleClearBtn();
  closeSuggestList();
  input.focus();
});

document.getElementById('nameInput').addEventListener('keydown', e => {
  const list = document.getElementById('suggestList');
  const items = list.querySelectorAll('.suggest-item');
  if(!list.classList.contains('open') || items.length === 0) return;
  if(e.key === 'ArrowDown'){
    e.preventDefault();
    suggestActiveIndex = Math.min(suggestActiveIndex + 1, items.length - 1);
  } else if(e.key === 'ArrowUp'){
    e.preventDefault();
    suggestActiveIndex = Math.max(suggestActiveIndex - 1, -1);
  } else if(e.key === 'Escape'){
    closeSuggestList();
    return;
  } else {
    return;
  }
  items.forEach((el, i) => el.classList.toggle('active', i === suggestActiveIndex));
  if(suggestActiveIndex >= 0){
    document.getElementById('nameInput').value = items[suggestActiveIndex].textContent;
  }
});

document.addEventListener('click', e => {
  if(!e.target.closest('.search-wrapper')) closeSuggestList();
});

document.getElementById('searchBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  const type = document.getElementById('searchType').value;
  if(!name) return;
  if(name.length < 2){
    setStatus('至少要輸入 2 個字才能查詢', 'err', true);
    return;
  }
  clearTimeout(suggestTimer); // 送出正式搜尋了，取消還沒發出去的建議查詢計時器，避免重複打
  closeSuggestList();
  /* 只記查詢的「類型」，不記查詢內容。

     記內容的話這張表就變成一份「誰在什麼時候調查了哪一間公司」的紀錄——
     usage_logs 犯過一次這個錯，已經拿掉了，不要在新的地方重蹈覆轍。 */
  track('search.submit', { type: type });
  startNewSearch(name, type);
});
document.getElementById('nameInput').addEventListener('keydown', e => {
  if(e.key === 'Enter') document.getElementById('searchBtn').click();
});
document.getElementById('searchType').addEventListener('change', e => {
  const placeholders = { person: '請輸入完整姓名', company: '請輸入公司名稱', ubn: '請輸入統一編號', foundation: '請輸入法人名稱' };
  document.getElementById('nameInput').placeholder = placeholders[e.target.value] || '請輸入搜尋內容';
});

document.getElementById('resetBtn').addEventListener('click', () => {
  nodes.clear();
  edges.clear();
  if(emptyStateHint) emptyStateHint.hidden = false;
  seenPeople.clear();
  cacheCompanies.clear();
  cacheDetail.clear();
  groups.clear();
  nodeGroups.clear();
  edgeGroups.clear();
  hiddenNodeIds.clear();
  orphanHiddenIds.clear();
  nameDerivedNodes.clear();
  /* 交集模式一併關掉：開著的話，下一次從一間公司開始查，它的董事全都只在
     這一間，會全部被濾掉，畫面上只剩一個方框，看起來像查不到東西。 */
  crossOnly = false;
  crossFilteredIds.clear();
  crossSavedLayout = null;
  parkedNodes.clear();
  parkedEdges.clear();
  document.getElementById('crossOnlyBtn').classList.remove('active');
  document.getElementById('crossOnlyBtn').setAttribute('aria-pressed', 'false');
  activeGroupId = null;
  groupCounter = 0;
  document.getElementById('sidebarContent').innerHTML = '<div class="placeholder">點擊圖中的節點，這裡會顯示公司基本資料或該人物目前找到的關聯。</div>';
  closeSidebar();
  document.getElementById('toast').classList.remove('show');
});

/* 空狀態引導的範例 chip：點了直接帶入查詢條件並觸發搜尋，不用使用者
   自己打字——第一次來的人最需要的是「一鍵看到結果長什麼樣子」。用
   事件代理掛在外層容器上，兩顆 chip 共用同一個監聽器。 */
if(emptyStateHint){
  emptyStateHint.addEventListener('click', e => {
    const chip = e.target.closest('.empty-state-chip');
    if(!chip) return;
    document.getElementById('searchType').value = chip.dataset.exampleType;
    document.getElementById('searchType').dispatchEvent(new Event('change'));
    document.getElementById('nameInput').value = chip.dataset.exampleValue;
    startNewSearch(chip.dataset.exampleValue, chip.dataset.exampleType);
  });
}

document.getElementById('restoreHiddenBtn').addEventListener('click', () => {
  const all = new Set([...hiddenNodeIds, ...orphanHiddenIds]);
  if(all.size === 0){
    setStatus('目前沒有被隱藏的節點', 'ok', true);
    return;
  }
  /* 被收合的查詢群組擋住的節點不能在這裡打開——那是另一個功能的隱藏，
     復原手動隱藏時順手把它打開，收合就失效了。 */
  const restore = [...all].filter(id => nodes.get(id) && !hiddenByCollapse(id));
  nodes.update(restore.map(id => ({ id, hidden: false })));
  hiddenNodeIds.clear();
  orphanHiddenIds.clear();
  // 交集模式開著的話，放回來的人裡面只連一間公司的，要再被濾掉
  if(crossOnly) applyCrossFilter();
  setStatus(`已恢復 ${restore.length} 個被隱藏的節點`, 'ok', true);
});

document.getElementById('closeSidebar').addEventListener('click', closeSidebar);

/* 顯名聲明彈跳視窗 */
function openAttributionModal(){ document.getElementById('attributionModal').classList.add('open'); }
function closeAttributionModal(){ document.getElementById('attributionModal').classList.remove('open'); }
document.getElementById('attributionBtn').addEventListener('click', openAttributionModal);
document.getElementById('closeAttributionModal').addEventListener('click', closeAttributionModal);
document.getElementById('attributionModal').addEventListener('click', e => {
  if(e.target.id === 'attributionModal') closeAttributionModal();
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') closeAttributionModal();
});

/* 付費說明視窗：關閉鈕、點背景關閉、Esc 關閉，跟其他視窗一致。
   CTA 另外記一筆並標明來源，才分得出「從公司面板點進訂閱頁」和
   「從帳號選單點進訂閱頁」哪一條路真的有效。 */
document.getElementById('closePaywall')?.addEventListener('click', closePaywall);
document.getElementById('paywallModal')?.addEventListener('click', e => {
  if(e.target.id === 'paywallModal') closePaywall();
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') closePaywall();
});
document.getElementById('paywallCta')?.addEventListener('click', () => {
  track('subscribe.click', { from: 'paywall' });
});

/* 我的報告視窗的關閉方式，跟其他視窗保持一致 */
document.getElementById('closeMyReports')?.addEventListener('click', closeMyReports);
document.getElementById('myReportsModal')?.addEventListener('click', e => {
  if(e.target.id === 'myReportsModal') closeMyReports();
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') closeMyReports();
});
document.getElementById('paywallSample')?.addEventListener('click', () => {
  track('paywall.sample_click');
});

// 主題切換的觸發點已移進帳號選單（menuThemeBtn）。這裡保留舊按鈕的
// 綁定，但要容許它不存在——否則 getElementById 回 null 會拋錯，
// 而這段在檔案很後面，一拋就把後面所有的事件綁定全部停掉。
const legacyThemeBtn = document.getElementById('themeToggleBtn');
if(legacyThemeBtn) legacyThemeBtn.addEventListener('click', () => {
  setTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

/* ---------------------------------------------------------
   商業模式報告：按鈕生成 -> 呼叫後端（D1 快取，沒有才即時呼叫
   Claude API 研究）-> 用 report-template.js 共用的渲染引擎組成
   一份獨立 HTML，放進 iframe 顯示。用 iframe 是為了讓報告自己的
   CSS／字體完全隔離，不會跟主站樣式互相污染，也不用擔心 LLM
   產出的內容意外撞到主站的 class 名稱。
--------------------------------------------------------- */
let currentReportId = null;
/* 分享連結用的隨機 token，不是資料庫的流水號。

   流水號是猜得到的：原本分享連結長 /report.html?id=7，任何人從 1 數上去
   就能把所有付費報告讀完。改成後端產生的 96-bit token，拿到連結的人照樣
   不必登入就看得到，猜不到連結的人試不出來。 */
let currentReportToken = null;

/* 這顆按鈕要有 token 才有意義，而 token 只有在報告成功寫進 D1 之後才存在。
   資料庫寫不進去時（例如容量滿了），它就是一顆保證失敗的按鈕，不如不要出現。

   用動態顯示而不是把程式碼刪掉：資料庫恢復之後 token 會自己回來，按鈕
   也就自己回來了，不需要記得回頭改這裡。 */
function updateShareButton(){
  const btn = document.getElementById('reportShareBtn');
  if(btn) btn.style.display = currentReportToken ? '' : 'none';
}

function openReportModal(){ document.getElementById('reportModal').classList.add('open'); }
function closeReportModal(){
  document.getElementById('reportModal').classList.remove('open');
  document.getElementById('reportModalBody').innerHTML = '';
  currentReportId = null;
  currentReportToken = null;
  updateShareButton();
}

/* 打開一份「已經存在」的報告（來自我的報告清單）。

   跟 generateBusinessModelReport 的差別：這支不會扣次數、也不呼叫 AI，
   純粹把資料庫裡那份撈出來重畫，所以回頭檢視舊報告是免費的。 */
async function openSavedReport(id, nameHint, shareToken){
  const body = document.getElementById('reportModalBody');
  const titleEl = document.getElementById('reportModalTitle');
  titleEl.textContent = nameHint || '商業模式報告';
  body.innerHTML = '<div class="placeholder">載入中…</div>';
  currentReportId = null;
  currentReportToken = null;
  updateShareButton();
  openReportModal();
  try{
    /* 清單本來就只會列出自己的報告，所以直接用那份報告的 token 讀，
       不必再走「流水號 + 驗證擁有者」那條路——少一次 auth-hub 往返。
       沒有 token 的舊資料才退回流水號，那條路會驗證身分。 */
    const query = shareToken
      ? 't=' + encodeURIComponent(shareToken)
      : 'id=' + encodeURIComponent(id);
    const token = await getAccessToken();
    const res = await fetch('/api/business-model-report?' + query, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentReportId = data.id ?? null;
    currentReportToken = data.share_token ?? null;
    updateShareButton();
    titleEl.textContent = (data.report && data.report.company_name) || nameHint || '商業模式報告';
    const iframe = document.createElement('iframe');
    /* sandbox 不給 allow-same-origin：srcdoc 的 iframe 預設跟主站同一個來源，
       報告裡的程式碼可以直接碰到主站的 window（包括取得登入憑證的函式）。
       報告內容是 AI 依網路資料寫的，不能完全信任，所以把它關進獨立的來源裡；
       目錄的捲動程式只碰自己的文件，不受影響。連結開新分頁時跳出 sandbox，
       被連到的網站才能正常運作。 */
    iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    body.innerHTML = '';
    body.appendChild(iframe);
    iframe.srcdoc = window.UDCReport.render(data.report, { created_at: data.created_at });
    track('report.reopen', { id });
  } catch(err){
    body.innerHTML = `<div class="placeholder">載入失敗：${escapeHtml(err.message)}</div>`;
  }
}

function closeMyReports(){
  document.getElementById('myReportsModal')?.classList.remove('open');
}

/* 我的報告清單。每次打開都重新抓，因為使用者可能剛剛才生成了新的一份。 */
const MY_REPORTS_PAGE_SIZE = 10;

async function openMyReports(){
  const modal = document.getElementById('myReportsModal');
  const summary = document.getElementById('myReportsSummary');
  const list = document.getElementById('myReportsList');
  const pager = document.getElementById('myReportsPager');
  if(!modal) return;
  modal.classList.add('open');
  summary.textContent = '載入中…';
  list.innerHTML = '';
  pager.hidden = true;
  track('myreports.view');

  try{
    const token = await getAccessToken();
    if(!token){
      summary.textContent = '請先登入才能看自己的報告。';
      return;
    }
    const res = await fetch('/api/my-reports', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const reports = data.reports || [];
    if(reports.length === 0){
      summary.textContent = '';
      list.innerHTML = '<div class="my-reports-empty">還沒有生成過報告。'
        + '在公司資料面板按「生成商業模式報告」之後，報告就會留在這裡，'
        + '之後回頭再看不會再扣次數。</div>';
      return;
    }

    summary.textContent = `共 ${reports.length} 份。點開重看不會再扣次數；標示「非本月」的報告內容停留在生成當時，重新查詢會生成新的一份。`;
    const thisMonth = taipeiMonthNow();
    const pageCount = Math.ceil(reports.length / MY_REPORTS_PAGE_SIZE);
    let page = 1;

    // 超過一頁才顯示分頁列；每次開啟都從第一頁開始（最新的在最前面）
    function renderPager(){
      if(pageCount <= 1){ pager.hidden = true; return; }
      pager.hidden = false;
      pager.innerHTML = '<button type="button" class="share-copy" data-pg="-1"' + (page <= 1 ? ' disabled' : '') + '>‹ 上一頁</button>'
        + '<span class="pager-info">第 ' + page + ' / ' + pageCount + ' 頁</span>'
        + '<button type="button" class="share-copy" data-pg="1"' + (page >= pageCount ? ' disabled' : '') + '>下一頁 ›</button>';
      pager.querySelectorAll('button[data-pg]').forEach(b => b.addEventListener('click', () => {
        page = Math.min(pageCount, Math.max(1, page + Number(b.dataset.pg)));
        renderPage();
        list.scrollTop = 0;
      }));
    }

    function renderPage(){
      const pageItems = reports.slice((page - 1) * MY_REPORTS_PAGE_SIZE, page * MY_REPORTS_PAGE_SIZE);
      list.innerHTML = pageItems.map(r => {
        const name = escapeHtml(String(r.company_name || '').split('\n')[0] || '（未命名）');
        /* 顯示「報告是什麼時候生成的」，不是「什麼時候加進我的清單」——
           投資人關心的是內容有多舊，不是自己什麼時候看到它。 */
        const day = String(r.generated_at || r.owned_at || '').slice(0, 10);
        const stale = day.slice(0, 7) && day.slice(0, 7) !== thisMonth;
        return '<button class="my-report-item" data-id="' + escapeHtml(String(r.id)) + '"'
          + ' data-token="' + escapeHtml(String(r.share_token || '')) + '">'
          + '<span class="my-report-name">' + name + '</span>'
          + '<span class="my-report-date' + (stale ? ' stale' : '') + '">' + escapeHtml(day)
          + (stale ? ' · 非本月' : '') + '</span>'
          + '</button>';
      }).join('');

      list.querySelectorAll('.my-report-item').forEach(btn => {
        btn.addEventListener('click', () => {
          closeMyReports();
          openSavedReport(btn.dataset.id, btn.querySelector('.my-report-name').textContent, btn.dataset.token);
        });
      });
      renderPager();
    }
    renderPage();
  } catch(err){
    summary.textContent = '載入失敗：' + err.message;
  }
}

/* 生成中的狀態。

   reportInFlight 擋重複送出：原本按鈕在生成期間沒有任何保護，連按兩下
   就是兩個 POST，第二個吃快取但照樣扣一次額度。實際上就發生過。

   reportRunId 是為了判斷「這次的結果還該不該畫進視窗」——使用者可能已經
   關掉視窗，或已經開始查下一間公司了。 */
let reportInFlight = false;
let reportRunId = 0;

function reportModalIsOpen(){
  return !!document.getElementById('reportModal')?.classList.contains('open');
}

async function generateBusinessModelReport(type, name, ubn){
  if(reportInFlight){
    setStatus('已經有一份報告在生成中，完成前請先等一下', 'err', true);
    return;
  }
  const runId = ++reportRunId;
  reportInFlight = true;
  const subject = name || ubn || '這間公司';

  const body = document.getElementById('reportModalBody');
  const titleEl = document.getElementById('reportModalTitle');
  titleEl.textContent = name || ubn || '商業模式報告';
  /* 明確講「可以關掉」。

     使用者本來看不出關掉視窗會發生什麼事，只能猜——而猜錯的代價是一次
     付費額度，所以很多人會不敢動。實際上關掉視窗不會中斷任何事：fetch
     還在跑，報告會生成、會存檔、會記進「我的報告」。這件事本來就是真的，
     只是沒有講出來，講出來它才有用。 */
  body.innerHTML = `<div class="placeholder">生成中，第一次查詢這間公司需要 AI 即時研究，可能要等 30-60 秒…`
    + `<br><br>可以關掉這個視窗，報告會在背景繼續生成，完成後會出現在右上角帳號選單的「我的報告」裡。</div>`;
  currentReportId = null;
  currentReportToken = null;
  updateShareButton();
  openReportModal();

  /* 這次的結果還該不該畫進視窗？視窗關了、或使用者已經開始查下一間公司，
     就不要動畫面（那是別人的視窗了），改用 toast 告訴他報告好了。 */
  const stillMine = () => reportRunId === runId && reportModalIsOpen();

  try{
    const token = await getAccessToken();
    if(!token){
      if(stillMine()) body.innerHTML = `<div class="placeholder">登入狀態已失效，請重新<a href="/login.html">登入</a>。</div>`;
      else setStatus('登入狀態已失效，報告沒有生成', 'err', true);
      return;
    }
    const res = await fetch('/api/business-model-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ type, name, ubn: ubn || '' }),
    });
    const data = await res.json();
    if(res.status === 402){
      /* 這是整個付費漏斗裡最有價值的一格：想用、按了、被擋下來的人。

         分「沒開通」和「次數用完」是必要的——前者要看訂閱頁的說服力，
         後者要看方案的次數是不是訂太少，兩件事的處置完全相反。 */
      track('report.blocked', {
        reason: /次數/.test(String(data.error || '')) ? 'quota_exhausted' : 'not_entitled',
      });
      // 付費相關的擋下，錯誤訊息裡直接給連結——這時候使用者最需要的
      // 就是「那我要去哪裡處理」
      if(stillMine()){
        body.innerHTML = '<div class="placeholder">' + escapeHtml(data.error || '這是付費功能。')
          + '<br><br><a href="' + SUBSCRIBE_URL + '" style="font-weight:600;">前往訂閱頁 →</a></div>';
      } else {
        setStatus(data.error || '這是付費功能，報告沒有生成', 'err', true);
      }
      // 權限狀態可能已經變了（例如次數剛用完），重新問一次讓選單同步
      initAuth();
      return;
    }
    if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // cached 代表這份報告是吃快取的，沒有真的花 LLM 的錢——
    // 成本估算要分得出來
    track('report.done', { cached: data.cached ? 1 : 0 });

    /* 剩餘次數要無條件更新，跟視窗還開不開沒有關係——選單上的數字必須是
       真的，不然使用者關掉視窗之後看到的是過期的次數。 */
    if(data.quotaRemaining !== undefined){
      quotaRemaining = data.quotaRemaining;
      renderAccountMenu();
    }
    // 沒扣次數（本來就是自己的報告）要講出來，不然使用者會以為又被扣了一次
    if(data.cached && data.charged === false){
      setStatus('這份報告你已經有了，這次沒有扣次數', 'ok', true);
    }

    if(!stillMine()){
      /* 視窗已經關了（或使用者去查別間公司了）。報告是生成完成的、也存進
         「我的報告」了，所以這裡不是錯誤處理，而是把結果交還給使用者——
         不講的話他只會以為次數白花了。 */
      setStatus(`「${subject}」的報告完成了，在帳號選單的「我的報告」可以打開`, 'ok', true);
      return;
    }

    // data.id 為 null 代表報告產出來了但沒存進資料庫（例如 D1 容量滿），
    // 這種情況報告照樣看得到，只是沒有分享連結
    currentReportId = data.id ?? null;
    currentReportToken = data.share_token ?? null;
    updateShareButton();
    titleEl.textContent = (data.report && data.report.company_name) || name || ubn;
    const html = window.UDCReport.render(data.report, { created_at: data.created_at });
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox'); // 見 openSavedReport 的說明
    body.innerHTML = '';
    body.appendChild(iframe);
    iframe.srcdoc = html;
    // 報告本身生成成功，但存進 D1 快取失敗——不擋顯示，但要讓使用者
    // 看得到，不然「沒進資料庫」這種問題只會默默發生、無從察覺
    if(data.saveError){
      setStatus(`報告已生成，但存檔失敗（下次查詢會重新生成）：${data.saveError}`, 'error', true);
    }
  } catch(err){
    if(stillMine()) body.innerHTML = `<div class="placeholder">生成失敗：${err.message}</div>`;
    else setStatus(`「${subject}」的報告生成失敗：${err.message}`, 'err', true);
  } finally {
    reportInFlight = false;
  }
}

document.getElementById('closeReportModal').addEventListener('click', closeReportModal);
document.getElementById('reportModal').addEventListener('click', e => {
  if(e.target.id === 'reportModal') closeReportModal();
});
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  closeReportModal();
  // 說明面板現在會自己跳出來，Escape 是使用者第一個會按的鍵
  closeHelpPanel();
});
document.getElementById('reportShareBtn').addEventListener('click', async () => {
  if(!currentReportToken){
    setStatus('這份報告還沒存檔，暫時無法分享', 'error', true);
    return;
  }
  const link = `${location.origin}/report.html?t=${currentReportToken}`;
  try{
    await navigator.clipboard.writeText(link);
    setStatus('分享連結已複製', 'ok', true);
  } catch(err){
    setStatus(`複製失敗，連結：${link}`, 'error', true);
  }
});

/* ---------------------------------------------------------
   初始載入
--------------------------------------------------------- */
let savedTheme = 'light';
try{ savedTheme = localStorage.getItem('udc:theme') || 'light'; } catch(err){}
setTheme(savedTheme);
/* 輸入框現在預設空白，不再自動查詢，等使用者自己輸入姓名 */

/* PWA：註冊 service worker，只快取畫面外殼，/api/* 一律不快取 */
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW 註冊失敗', err));
  });
}


/* ---------------------------------------------------------
   Supabase BaaS ✕ OpenData UI 控制邏輯
--------------------------------------------------------- */
function setupSupabaseUI(){
  const modal = document.getElementById('supabaseModal');
  const openBtn = document.getElementById('supabaseBtn');
  const closeBtn = document.getElementById('closeSupabaseModal');
  const testBtn = document.getElementById('sbTestBtn');
  const saveBtn = document.getElementById('sbSaveBtn');
  const clearBtn = document.getElementById('sbClearBtn');
  const urlInput = document.getElementById('sbUrlInput');
  const keyInput = document.getElementById('sbKeyInput');
  const alertBox = document.getElementById('sbTestAlert');

  function openModal(){
    if(!modal) return;
    if(urlInput) urlInput.value = localStorage.getItem('SB_URL') || '';
    if(keyInput) keyInput.value = localStorage.getItem('SB_ANON_KEY') || '';
    if(alertBox) alertBox.style.display = 'none';
    modal.classList.add('open');
    modal.style.display = 'flex';
  }

  function closeModal(){
    if(!modal) return;
    modal.classList.remove('open');
    modal.style.display = 'none';
  }

  if(openBtn) openBtn.addEventListener('click', openModal);
  if(closeBtn) closeBtn.addEventListener('click', closeModal);
  if(modal) {
    modal.addEventListener('click', (e) => {
      if(e.target === modal) closeModal();
    });
  }

  if(testBtn){
    testBtn.addEventListener('click', async () => {
      const u = (urlInput.value || '').trim();
      const k = (keyInput.value || '').trim();
      if(!u || !k){
        alertBox.style.display = 'block';
        alertBox.style.background = 'rgba(217, 83, 79, 0.2)';
        alertBox.style.color = '#ff8080';
        alertBox.textContent = '請輸入 Project URL 與 Anon Key';
        return;
      }
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(63, 232, 212, 0.15)';
      alertBox.style.color = 'var(--current)';
      alertBox.textContent = '測試連線中，請稍候…';

      if(window.SupabaseBridge){
        const res = await window.SupabaseBridge.testConnection(u, k);
        if(res.success){
          alertBox.style.background = 'rgba(79, 191, 139, 0.2)';
          alertBox.style.color = 'var(--ok)';
          alertBox.textContent = res.message;
        } else {
          alertBox.style.background = 'rgba(217, 83, 79, 0.2)';
          alertBox.style.color = '#ff8080';
          alertBox.textContent = res.message;
        }
      }
    });
  }

  if(saveBtn){
    saveBtn.addEventListener('click', () => {
      const u = (urlInput.value || '').trim();
      const k = (keyInput.value || '').trim();
      if(window.SupabaseBridge){
        window.SupabaseBridge.saveConfig(u, k);
      }
      closeModal();
      alert('已成功儲存 Supabase 連線設定！');
    });
  }

  if(clearBtn){
    clearBtn.addEventListener('click', () => {
      if(window.SupabaseBridge){
        window.SupabaseBridge.saveConfig('', '');
      }
      if(urlInput) urlInput.value = '';
      if(keyInput) keyInput.value = '';
      closeModal();
      alert('已切換回本地示範 / OpenData 模式');
    });
  }

  // 初始化狀態
  if(window.SupabaseBridge){
    window.SupabaseBridge.updateStatusPill();
  }
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', setupSupabaseUI);
} else {
  setupSupabaseUI();
}
