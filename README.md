# UNDERCURRENT 暗流 ✕ 台灣政府 OpenData ✕ Supabase BaaS 公司關係圖譜平台

> **暗流，暗彰表面之下的公司關係。**  
> 依據前瞻逆向工程（Reverse Engineering）標準，完整還原並開源重構 [UNDERCURRENT (undercurrent.kentshen.com)](https://undercurrent.kentshen.com/) 商業情報與企業關係視覺化網絡平台，全面串接**台灣政府開放資料 (OpenData)** 與 **Supabase 雲端無伺服器架構 (BaaS)**，支援 GitHub Pages 一鍵靜態託管。

[![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub%20Pages-blue?logo=github)](https://davidyeh51.github.io/undercurrent-tw-opendata/)
[![Supabase](https://img.shields.io/badge/Backend-Supabase%20PostgreSQL-3ECF8E?logo=supabase)](https://supabase.com)
[![OpenData](https://img.shields.io/badge/Data-Taiwan%20OpenData%20(GCIS)-orange)](https://data.gov.tw/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 🌟 平台核心亮點

### 1. 完整關係圖譜與物理力導向模擬 (`vis-network`)
- **多維實體節點**：支援「公司（六角/圓角方塊）」、「董監事/自然人（圓形）」、「司法院法人基金會（紫調卡片）」。
- **動態身分連線**：區分「董事長」、「董事」、「監事」、「經理人」、「法人代表穿透（虛線箭頭）」等權利控制結構。
- **智慧聚合節點**：當單一公司董監事人數過多時，自動依身分分桶收合成「董事（N 位）」聚合球，單擊展開、避免畫面雜亂。
- **多層級穿透探勘**：在人名節點**雙擊**，立即穿透該人物名下跨任職的所有其他上市櫃及非公開發行公司。
- **暗黑 / 明亮雙主題**：完整承襲 Cyberpunk 工業高對比暗色調與報導版高雅亮色調，自適應動態畫布。

### 2. 深度整合台灣政府三大開放資料源 (OpenData)
- 🏢 **經濟部商業發展署**：
  - 公司登記基本資料集 (`5F64D864-61CB-4D0D-8AD9-492047CC1EA6`)：統一編號、資本額、實收資本額、負責人、登記地址、設立核准日。
  - 公司登記董監事名單 (`4E5F7653-1B91-4DDC-99D5-468530FAE396`)：職稱、姓名、代表法人、持股股數。
  - 公司登記經理人資料：經理人姓名、到職核准日期。
- ⚖️ **司法院**：
  - 法人登記公告資料集：財團法人基金會、社團法人登記之目的、董監事名單、財產總額、捐助人、辦公地址。
- 🌿 **環境部**：
  - 事業裁罰處分紀錄：依統編或公司名稱即時關聯空污、水污、廢棄物等行政裁罰紀錄。
- 🔗 **外跳查證工具箱**：一鍵複製名稱，外跳至「司法院裁判書查詢系統」、「政府採購網拒絕往來廠商」、「公開資訊觀測站 (MOPS)」。

### 3. 符合 `github-supabase-web` 規範之 Supabase BaaS 架構
- **純靜態託管**：相容於 GitHub Pages、Vercel 或 Cloudflare Pages，純 HTML5 / Vanilla JS / CSS3 零構建環境。
- **公開 Client Key 原則**：前端僅暴露 `SUPABASE_URL` 與公開 `anon public key`，絕無私鑰洩漏風險。
- **PostgreSQL 儲存函數 (RPC)**：
  - `expand_entity(q, stype, depth)`：在資料庫端執行 2 層關係展開，極速回傳整併後之關聯圖譜。
  - `search_suggestions(q, stype)`：支援公司名稱、人名、統編、基金會自動補全。
- **行級安全政策 (RLS)**：商業登記資料公開唯讀；關係圖快照 (`graph_snapshots`) 與意見回饋 (`feedbacks`) 支援免登入匿名安全直傳。
- **雙模運作韌性**：
  - 🟢 **Supabase 雲端連線**：即時讀寫雲端資料庫與快照分享。
  - 🟡 **本地示範 / OpenData 模式**：未配置金鑰時，內建台積電、鴻海、聯發科、廣達、台達電、富邦金、國泰金、進金生能源服務等完整企業旗艦圖譜，離線亦可秒開即用。

### 4. 媒體與調查報導專業匯出體系
- 📸 **下載圖檔 (PNG)**：透明/深底高解析視覺快照。
- 📄 **下載報導版圖檔 (白底)**：專為紙本報章、調查報導排版設計之乾淨白底印刷圖檔。
- 📊 **下載資料 (CSV)**：匯出畫面上看得到的公司、人物、持股、職稱清冊（內建 UTF-8 BOM，Excel 直接開啟不亂碼）。
- 🔗 **快照分享與 iframe 嵌入**：建立固定不變的關係圖快照，生成專屬連結與嵌入代碼（如 `/graph.html?t=xxx`）。

---

## 🚀 快速上手 (Quick Start)

### 方式 A：直接訪問線上部署網頁
直接開啟已發布至 GitHub Pages 的線上服務：  
👉 **[https://davidyeh51.github.io/undercurrent-tw-opendata/](https://davidyeh51.github.io/undercurrent-tw-opendata/)**

---

### 方式 B：本地端快速啟動
本專案為零依賴純靜態前端，任何 HTTP 伺服器皆可秒開：

```bash
# Clone 儲存庫
git clone https://github.com/davidyeh51/undercurrent-tw-opendata.git
cd undercurrent-tw-opendata

# 啟動 Python 本地伺服器
python -m http.server 8000

# 瀏覽器開啟 http://localhost:8000
```

---

## ⚡ 串接專屬 Supabase 雲端資料庫

若您希望持久化儲存自己的調查圖譜、快照或擴充全台灣公司登記數據：

### 步驟 1：建立 Supabase 專案
1. 前往 [Supabase 官網 (supabase.com)](https://supabase.com/) 免費註冊並建立新專案。

### 步驟 2：執行 SQL 架構腳本
1. 進入 Supabase 控制台左側選單的 **SQL Editor**。
2. 開啟專案內的 [`supabase/schema.sql`](./supabase/schema.sql)，複製全文貼入。
3. 點擊 **Run** 執行：
   - 自動建立 `companies`, `directors`, `managers`, `foundations`, `env_penalties`, `graph_snapshots`, `feedbacks` 7 張核心資料表。
   - 自動配置高效 B-Tree 與 GIN 索引。
   - 自動建立 `expand_entity` 與 `search_suggestions` PostgreSQL RPC 函數。
   - 自動啟用 Row Level Security (RLS) 行級安全存取政策。
   - 自動植入台積電、鴻海、聯發科等台灣集團旗艦示範資料。

### 步驟 3：在網頁設定連線
1. 在 Supabase 控制台點選 **Project Settings** $\rightarrow$ **API**。
2. 複製 **Project URL** 與 **Project API Keys (anon public)**。
3. 開啟網頁，點擊工具列右上角的 **「🟡 Supabase」** 按鈕。
4. 貼上 URL 與 Anon Key，點擊 **「測試連線」**。確認顯示「✅ 連線成功」後點擊 **「儲存並連線」**。
5. 燈號隨即切換為 **「🟢 Supabase 雲端已連線」**，所有查詢與快照將全面接管至您的專屬雲端庫！

---

## 📂 檔案目錄結構

```
undercurrent-tw-opendata/
├── index.html                   # 主站應用程式入口（關係圖譜、搜尋列、多維側邊欄、工具列）
├── graph.html                   # 關係圖快照專用獨立展示與報導嵌入頁面
├── app.js                       # 主站圖譜邏輯、vis-network 物理模擬、UI 狀態控制
├── graph-view.js                # 快照專屬唯讀輕量渲染器
├── supabase-opendata-bridge.js  # Supabase ✕ OpenData 核心橋接器與本地示範資料庫
├── style.css                    # 暗黑/明亮主題變數、響應式佈局與現代設計風格
├── report-template.js           # 商業模式 AI 報告專用格式化範本
├── track.js                     # 隱私友善事件分析
├── manifest.json                # PWA 應用清單（可加入行動裝置主畫面）
├── og-image.png                 # 社群分享卡片縮圖
├── icons/                       # PWA 與 Apple Touch 圖示
└── supabase/
    ├── schema.sql               # Supabase PostgreSQL 建表、索引、RLS、RPC 與種子資料 SQL
    └── functions/
        └── gcis-proxy/          # Supabase Edge Function：台灣開放資料 CORS 代理
            └── index.ts
```

---

## 📜 資料來源與開放授權聲明

本專案串接之資料集遵循政府資料開放授權條款 (Open Government Data License)：
1. **經濟部商業發展署**：公司登記董監事資料集、公司登記經理人資料集、公司登記基本資料查詢。
2. **司法院**：法人登記公告資料集。
3. **環境部**：裁罰處分資料。

---

## 🤝 貢獻與反饋

歡迎提交 Issue 或 Pull Request 協助完善更多開放資料串接、自動化爬蟲與圖形分析演算法！
如有任何問題，亦可直接使用頁面內的「意見回饋」選單提交回報。
