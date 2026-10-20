/**
 * supabase-opendata-bridge.js
 * 
 * 整合台灣政府 OpenData（經濟部商業司、司法院、環境部）與 Supabase BaaS 雲端架構的核心橋接器。
 * 遵循 github-supabase-web 規範：
 * 1. 僅暴露 Supabase URL 與 anon public key，支援本地 localStorage 儲存或環境變數注入。
 * 2. 優先由 Supabase PostgreSQL 索引資料表與 RPC 函數快速取用關聯資料。
 * 3. 具備高韌性回退機制：未設定 Supabase 或網路異常時，自動啟用精準的台灣大企業示範資料庫 (Local Seed Data) 或 OpenData 即時快照。
 * 4. 支援將新查詢之開放資料無感同步快取回 Supabase 資料庫。
 */

(function(global) {
  'use strict';

  // 本地示範資料庫（涵蓋台積電、鴻海、聯發科、廣達、台達電、富邦金控、國泰金控、進金生能源服務等關鍵企業網絡）
  const LOCAL_SEED_DATABASE = {
    companies: [
      {
        ubn: "22099131",
        company_name: "台灣積體電路製造股份有限公司",
        company_status_desc: "核准設立",
        capital_stock_amount: 280500000000,
        paid_in_capital_amount: 259323700670,
        responsible_name: "魏哲家",
        company_location: "新竹科學園區新竹市力行六路8號",
        register_organization_desc: "國家科學及技術委員會新竹科學園區管理局",
        company_setup_date: "0760221",
        change_of_approval_data: "1150821",
        level: 1
      },
      {
        ubn: "04541302",
        company_name: "鴻海精密工業股份有限公司",
        company_status_desc: "核准設立",
        capital_stock_amount: 180000000000,
        paid_in_capital_amount: 138629906090,
        responsible_name: "劉揚偉",
        company_location: "新北市土城區自由街2號",
        register_organization_desc: "經濟部商業發展署",
        company_setup_date: "0630220",
        change_of_approval_data: "1130815",
        level: 1
      },
      {
        ubn: "16148372",
        company_name: "聯發科技股份有限公司",
        company_status_desc: "核准設立",
        capital_stock_amount: 20000000000,
        paid_in_capital_amount: 16002951710,
        responsible_name: "蔡明介",
        company_location: "新竹科學園區新竹市篤行一路1號",
        register_organization_desc: "國家科學及技術委員會新竹科學園區管理局",
        company_setup_date: "0860528",
        change_of_approval_data: "1130718",
        level: 1
      },
      {
        ubn: "22967160",
        company_name: "廣達電腦股份有限公司",
        company_status_desc: "核准設立",
        capital_stock_amount: 45000000000,
        paid_in_capital_amount: 38626345600,
        responsible_name: "林百里",
        company_location: "桃園市龜山區文化二路188號",
        register_organization_desc: "經濟部商業發展署",
        company_setup_date: "0770509",
        change_of_approval_data: "1130628",
        level: 1
      },
      {
        ubn: "04302213",
        company_name: "台達電子工業股份有限公司",
        company_status_desc: "核准設立",
        capital_stock_amount: 30000000000,
        paid_in_capital_amount: 25975438880,
        responsible_name: "鄭平",
        company_location: "台北市內湖區陽光街186號",
        register_organization_desc: "經濟部商業發展署",
        company_setup_date: "0640820",
        change_of_approval_data: "1130615",
        level: 1
      },
      {
        ubn: "70775836",
        company_name: "富邦金融控股股份有限公司",
        company_status_desc: "核准設立",
        capital_stock_amount: 160000000000,
        paid_in_capital_amount: 142089400000,
        responsible_name: "蔡明興",
        company_location: "台北市松山區敦化南路一段108號",
        register_organization_desc: "經濟部商業發展署",
        company_setup_date: "0901219",
        change_of_approval_data: "1130712",
        level: 1
      },
      {
        ubn: "16670878",
        company_name: "國泰金融控股股份有限公司",
        company_status_desc: "核准設立",
        capital_stock_amount: 180000000000,
        paid_in_capital_amount: 147029500000,
        responsible_name: "蔡宏圖",
        company_location: "台北市大安區仁愛路四段296號",
        register_organization_desc: "經濟部商業發展署",
        company_setup_date: "0901231",
        change_of_approval_data: "1130620",
        level: 1
      },
      {
        ubn: "84149807",
        company_name: "進金生能源服務股份有限公司",
        company_status_desc: "核准設立",
        capital_stock_amount: 1000000000,
        paid_in_capital_amount: 715000000,
        responsible_name: "厲燕蒙",
        company_location: "台北市內湖區行善路397號6樓",
        register_organization_desc: "經濟部商業發展署",
        company_setup_date: "1000812",
        change_of_approval_data: "1130910",
        level: 1
      }
    ],
    directors: [
      // 台積電
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "董事長", person_name: "魏哲家", represents: "", shares: "7452349" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "董事", person_name: "曾繁城", represents: "", shares: "24472675" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "董事", person_name: "劉德音", represents: "", shares: "12913114" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "董事", person_name: "葉俊顯", represents: "行政院國家發展基金管理會", shares: "1653709980" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "獨立董事", person_name: "彼得‧邦菲爵士", represents: "", shares: "0" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "獨立董事", person_name: "麥克‧史賓林特", represents: "", shares: "0" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "獨立董事", person_name: "摩西‧蓋弗瑞洛夫", represents: "", shares: "0" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "獨立董事", person_name: "拉斐爾‧萊夫", represents: "", shares: "0" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "獨立董事", person_name: "海芬妮", represents: "", shares: "0" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", position: "獨立董事", person_name: "林全", represents: "", shares: "0" },
      // 鴻海
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "董事長", person_name: "劉揚偉", represents: "", shares: "656000" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "董事", person_name: "郭台銘", represents: "", shares: "1742199588" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "董事", person_name: "李傑", represents: "", shares: "0" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "董事", person_name: "呂芳銘", represents: "", shares: "3929424" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "董事", person_name: "陳振國", represents: "", shares: "0" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "獨立董事", person_name: "王國城", represents: "", shares: "0" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "獨立董事", person_name: "黃清苑", represents: "", shares: "0" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "獨立董事", person_name: "詹文男", represents: "", shares: "0" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", position: "獨立董事", person_name: "劉連煜", represents: "", shares: "0" },
      // 聯發科
      { ubn: "16148372", company_name: "聯發科技股份有限公司", position: "董事長", person_name: "蔡明介", represents: "", shares: "41459461" },
      { ubn: "16148372", company_name: "聯發科技股份有限公司", position: "副董事長", person_name: "蔡力行", represents: "", shares: "2950000" },
      { ubn: "16148372", company_name: "聯發科技股份有限公司", position: "董事", person_name: "陳冠州", represents: "", shares: "1420000" },
      { ubn: "16148372", company_name: "聯發科技股份有限公司", position: "董事", person_name: "謝清江", represents: "", shares: "2380000" },
      { ubn: "16148372", company_name: "聯發科技股份有限公司", position: "獨立董事", person_name: "湯明哲", represents: "", shares: "0" },
      { ubn: "16148372", company_name: "聯發科技股份有限公司", position: "獨立董事", person_name: "吳重雨", represents: "", shares: "0" },
      // 廣達
      { ubn: "22967160", company_name: "廣達電腦股份有限公司", position: "董事長", person_name: "林百里", represents: "", shares: "415738596" },
      { ubn: "22967160", company_name: "廣達電腦股份有限公司", position: "副董事長", person_name: "梁次震", represents: "", shares: "65545239" },
      { ubn: "22967160", company_name: "廣達電腦股份有限公司", position: "董事", person_name: "黃健堂", represents: "", shares: "13800000" },
      // 台達電
      { ubn: "04302213", company_name: "台達電子工業股份有限公司", position: "董事長", person_name: "鄭平", represents: "", shares: "12560000" },
      { ubn: "04302213", company_name: "台達電子工業股份有限公司", position: "董事", person_name: "鄭崇華", represents: "", shares: "97000000" },
      { ubn: "04302213", company_name: "台達電子工業股份有限公司", position: "董事", person_name: "海英俊", represents: "", shares: "7800000" },
      // 富邦金
      { ubn: "70775836", company_name: "富邦金融控股股份有限公司", position: "董事長", person_name: "蔡明興", represents: "", shares: "398000000" },
      { ubn: "70775836", company_name: "富邦金融控股股份有限公司", position: "董事", person_name: "蔡明忠", represents: "", shares: "375000000" },
      { ubn: "70775836", company_name: "富邦金融控股股份有限公司", position: "董事", person_name: "韓蔚廷", represents: "", shares: "4500000" },
      // 國泰金
      { ubn: "16670878", company_name: "國泰金融控股股份有限公司", position: "董事長", person_name: "蔡宏圖", represents: "", shares: "275000000" },
      { ubn: "16670878", company_name: "國泰金融控股股份有限公司", position: "董事", person_name: "蔡政達", represents: "", shares: "210000000" },
      { ubn: "16670878", company_name: "國泰金融控股股份有限公司", position: "董事", person_name: "李長庚", represents: "", shares: "3200000" },
      // 進金生能源
      { ubn: "84149807", company_name: "進金生能源服務股份有限公司", position: "董事長", person_name: "厲燕蒙", represents: "進金生實業股份有限公司", shares: "28500000" },
      { ubn: "84149807", company_name: "進金生能源服務股份有限公司", position: "董事", person_name: "黃顯川", represents: "", shares: "1200000" }
    ],
    managers: [
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", manager_name: "魏哲家", position: "總裁", start_date: "0870303" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", manager_name: "秦永沛", position: "執行副總經理", start_date: "0970219" },
      { ubn: "22099131", company_name: "台灣積體電路製造股份有限公司", manager_name: "米玉傑", position: "執行副總經理", start_date: "1010101" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", manager_name: "劉揚偉", position: "總經理", start_date: "1080701" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", manager_name: "巫俊毅", position: "副總經理暨發言人", start_date: "1110501" },
      { ubn: "04541302", company_name: "鴻海精密工業股份有限公司", manager_name: "黃秋蓮", position: "總財務長", start_date: "0700101" },
      { ubn: "84149807", company_name: "進金生能源服務股份有限公司", manager_name: "黃顯川", position: "總經理", start_date: "1000812" }
    ],
    foundations: [
      {
        comname: "財團法人台積電文教基金會",
        court: "臺灣新竹地方法院",
        setup_date: "1998-05-18",
        funds: "30000000",
        chairman: "曾繁城",
        purpose: "培育科技人才，贊助教育、文化與藝術活動，實踐企業社會責任。",
        office_address: "新竹市科學工業園區力行六路8號",
        directors: [
          { position: "董事長", name: "曾繁城" },
          { position: "董事", name: "張忠謀" },
          { position: "董事", name: "魏哲家" }
        ]
      },
      {
        comname: "財團法人鴻海教育基金會",
        court: "臺灣新北地方法院",
        setup_date: "2008-03-20",
        funds: "50000000",
        chairman: "郭台銘",
        purpose: "獎勵優秀青年，推動科技與生命教育發展，促進弱勢族群向上流動。",
        office_address: "新北市土城區自由街2號",
        directors: [
          { position: "董事長", name: "郭台銘" },
          { position: "董事", name: "劉揚偉" },
          { position: "董事", name: "黃秋蓮" }
        ]
      },
      {
        comname: "財團法人富邦文教基金會",
        court: "臺灣臺北地方法院",
        setup_date: "1990-12-05",
        funds: "40000000",
        chairman: "蔡明興",
        purpose: "推動青少年培力、媒體素養及藝文活動。",
        office_address: "台北市松山區敦化南路一段108號",
        directors: [
          { position: "董事長", name: "蔡明興" },
          { position: "董事", name: "蔡明忠" }
        ]
      }
    ],
    penalties: [
      {
        ubn: "22099131",
        company_name: "台灣積體電路製造股份有限公司",
        penalty_date: "2023-11-04",
        penalty_money: "100,000",
        law: "空氣污染防制法",
        reason: "製程廢氣防制設備未依許可證操作條件運作"
      },
      {
        ubn: "04541302",
        company_name: "鴻海精密工業股份有限公司",
        penalty_date: "2022-08-16",
        penalty_money: "60,000",
        law: "水污染防治法",
        reason: "廢水放流水質懸浮固體超標"
      }
    ]
  };

  class SupabaseOpenDataBridge {
    constructor() {
      this.client = null;
      this.initClient();
    }

    initClient() {
      const url = window.ENV_SUPABASE_URL || localStorage.getItem('SB_URL') || '';
      const key = window.ENV_SUPABASE_ANON_KEY || localStorage.getItem('SB_ANON_KEY') || '';

      if (url && key && window.supabase) {
        try {
          this.client = window.supabase.createClient(url, key);
          console.log('[SupabaseBridge] Client initialized with URL:', url);
        } catch (e) {
          console.warn('[SupabaseBridge] Failed to init supabase client:', e);
          this.client = null;
        }
      } else {
        this.client = null;
      }
    }

    isConfigured() {
      return Boolean(this.client);
    }

    async testConnection(url, key) {
      if (!window.supabase) {
        return { success: false, message: 'Supabase JS SDK 尚未載入' };
      }
      try {
        const testClient = window.supabase.createClient(url, key);
        const { data, error } = await testClient.from('companies').select('ubn').limit(1);
        if (error) {
          return { success: false, message: '連線資料庫失敗: ' + error.message };
        }
        return { success: true, message: '✅ 連線成功！已成功存取 companies 資料表' };
      } catch (err) {
        return { success: false, message: '連線異常: ' + (err.message || err) };
      }
    }

    saveConfig(url, key) {
      if (url) localStorage.setItem('SB_URL', url.trim());
      else localStorage.removeItem('SB_URL');

      if (key) localStorage.setItem('SB_ANON_KEY', key.trim());
      else localStorage.removeItem('SB_ANON_KEY');

      this.initClient();
      this.updateStatusPill();
    }

    updateStatusPill() {
      const pill = document.getElementById('supabaseBtn');
      if (!pill) return;
      if (this.isConfigured()) {
        pill.classList.remove('local');
        pill.classList.add('connected');
        pill.title = '🟢 Supabase 雲端資料庫已連線';
      } else {
        pill.classList.remove('connected');
        pill.classList.add('local');
        pill.title = '🟡 本地示範 / OpenData 模式（點擊配置 Supabase）';
      }
    }

    // 核心查詢展開：結合 Supabase、OpenData 與 Local Demo
    async expandEntity(query, type) {
      type = type || 'person';

      // 1. 若已配置 Supabase，優先由 Supabase RPC / Tables 查詢
      if (this.client) {
        try {
          // 嘗試呼叫 RPC expand_entity
          const { data, error } = await this.client.rpc('expand_entity', {
            q: query,
            stype: type,
            depth: 2
          });

          if (!error && data && data.companies && data.companies.length > 0) {
            console.log('[SupabaseBridge] Fetched from Supabase RPC:', data);
            return data;
          }

          // 降級嘗試直接查 table
          if (type === 'ubn' || (type === 'company' && /^\d{8}$/.test(query))) {
            const { data: comp } = await this.client.from('companies').select('*').eq('ubn', query).maybeSingle();
            if (comp) {
              const { data: dirs } = await this.client.from('directors').select('*').eq('ubn', query);
              const { data: mans } = await this.client.from('managers').select('*').eq('ubn', query);
              return {
                centerType: 'ubn',
                companies: [{ ...comp, level: 1 }],
                directors: (dirs || []).map(d => ({ ...d, shares: String(d.shares || 0) })),
                managers: mans || []
              };
            }
          } else if (type === 'company') {
            const { data: comp } = await this.client.from('companies').select('*').ilike('company_name', `%${query}%`).limit(1).maybeSingle();
            if (comp) {
              return this.expandEntity(comp.ubn, 'ubn');
            }
          } else if (type === 'person') {
            const { data: matchedDirs } = await this.client.from('directors').select('ubn').eq('person_name', query);
            const { data: matchedMans } = await this.client.from('managers').select('ubn').eq('manager_name', query);
            const ubns = [...new Set([...(matchedDirs || []).map(d => d.ubn), ...(matchedMans || []).map(m => m.ubn)])];
            if (ubns.length > 0) {
              const { data: comps } = await this.client.from('companies').select('*').in('ubn', ubns);
              const { data: allDirs } = await this.client.from('directors').select('*').in('ubn', ubns);
              const { data: allMans } = await this.client.from('managers').select('*').in('ubn', ubns);
              return {
                centerType: 'person',
                companies: (comps || []).map(c => ({ ...c, level: 1 })),
                directors: (allDirs || []).map(d => ({ ...d, shares: String(d.shares || 0) })),
                managers: allMans || []
              };
            }
          }
        } catch (sbErr) {
          console.warn('[SupabaseBridge] Supabase query failed, falling back:', sbErr);
        }
      }

      // 2. 搜尋本地示範資料庫 (Local Seed Data)
      const localResult = this.searchLocalSeed(query, type);
      if (localResult && localResult.companies.length > 0) {
        console.log('[SupabaseBridge] Fetched from Local Seed Data');
        return localResult;
      }

      // 3. 線上 OpenData API 備援查詢 (呼叫官方或公開代理)
      try {
        const liveResult = await this.fetchLiveOpenData(query, type);
        if (liveResult && liveResult.companies && liveResult.companies.length > 0) {
          // 若 Supabase 有連線，自動將新獲取的資料同步入庫
          this.syncToSupabase(liveResult);
          return liveResult;
        }
      } catch (liveErr) {
        console.warn('[SupabaseBridge] Live OpenData fetch failed:', liveErr);
      }

      // 4. 若皆無資料，回傳乾淨空集
      return {
        centerType: type,
        companies: [],
        directors: [],
        managers: []
      };
    }

    searchLocalSeed(query, type) {
      if (type === 'ubn' || (type === 'company' && /^\d{8}$/.test(query))) {
        const comp = LOCAL_SEED_DATABASE.companies.find(c => c.ubn === query);
        if (comp) {
          const dirs = LOCAL_SEED_DATABASE.directors.filter(d => d.ubn === query);
          const mans = LOCAL_SEED_DATABASE.managers.filter(m => m.ubn === query);
          return {
            centerType: 'ubn',
            companies: [comp],
            directors: dirs,
            managers: mans
          };
        }
      } else if (type === 'company') {
        const comp = LOCAL_SEED_DATABASE.companies.find(c => c.company_name.includes(query));
        if (comp) {
          return this.searchLocalSeed(comp.ubn, 'ubn');
        }
      } else if (type === 'person') {
        const matchedDirs = LOCAL_SEED_DATABASE.directors.filter(d => d.person_name === query);
        const matchedMans = LOCAL_SEED_DATABASE.managers.filter(m => m.manager_name === query);
        const ubns = [...new Set([...matchedDirs.map(d => d.ubn), ...matchedMans.map(m => m.ubn)])];
        if (ubns.length > 0) {
          const comps = LOCAL_SEED_DATABASE.companies.filter(c => ubns.includes(c.ubn));
          const allDirs = LOCAL_SEED_DATABASE.directors.filter(d => ubns.includes(d.ubn));
          const allMans = LOCAL_SEED_DATABASE.managers.filter(m => ubns.includes(m.ubn));
          return {
            centerType: 'person',
            companies: comps,
            directors: allDirs,
            managers: allMans
          };
        }
      }
      return null;
    }

    async fetchLiveOpenData(query, type) {
      // 呼叫 Cloudflare Pages Functions 或公開鏡像
      const url = new URL('https://undercurrent.kentshen.com/api/d1-expand');
      url.searchParams.set('q', query);
      url.searchParams.set('type', type);
      url.searchParams.set('depth', '2');
      const res = await fetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Live OpenData HTTP ' + res.status);
      return await res.json();
    }

    async syncToSupabase(bundle) {
      if (!this.client || !bundle) return;
      try {
        if (bundle.companies && bundle.companies.length > 0) {
          await this.client.from('companies').upsert(bundle.companies.map(c => ({
            ubn: c.ubn,
            company_name: c.company_name,
            company_status_desc: c.company_status_desc || '核准設立',
            responsible_name: c.responsible_name || '',
            capital_stock_amount: c.capital_stock_amount || 0,
            paid_in_capital_amount: c.paid_in_capital_amount || 0,
            company_location: c.company_location || '',
            updated_at: new Date().toISOString()
          })), { onConflict: 'ubn' });
        }
        if (bundle.directors && bundle.directors.length > 0) {
          await this.client.from('directors').upsert(bundle.directors.map(d => ({
            ubn: d.ubn,
            company_name: d.company_name,
            position: d.position || '董事',
            person_name: d.person_name,
            represents: d.represents || '',
            shares: parseInt(d.shares, 10) || 0
          })));
        }
        if (bundle.managers && bundle.managers.length > 0) {
          await this.client.from('managers').upsert(bundle.managers.map(m => ({
            ubn: m.ubn,
            company_name: m.company_name,
            manager_name: m.manager_name,
            position: m.position || '經理人',
            start_date: m.start_date || ''
          })));
        }
        console.log('[SupabaseBridge] Successfully synced live open data into Supabase!');
      } catch (err) {
        console.warn('[SupabaseBridge] Sync to Supabase failed:', err);
      }
    }

    // 自動補全建議 (Suggestions)
    async getSuggestions(query, type) {
      if (!query || query.trim().length === 0) return [];
      query = query.trim();

      if (this.client) {
        try {
          const { data } = await this.client.rpc('search_suggestions', { q: query, stype: type });
          if (data && data.suggestions && data.suggestions.length > 0) {
            return data.suggestions;
          }
        } catch (e) {
          console.warn('[SupabaseBridge] Suggest RPC error:', e);
        }
      }

      // 本地示範補全
      const suggestions = [];
      if (type === 'company') {
        LOCAL_SEED_DATABASE.companies.forEach(c => {
          if (c.company_name.includes(query) && !suggestions.includes(c.company_name)) {
            suggestions.push(c.company_name);
          }
        });
      } else if (type === 'person') {
        LOCAL_SEED_DATABASE.directors.forEach(d => {
          if (d.person_name.includes(query) && !suggestions.includes(d.person_name)) {
            suggestions.push(d.person_name);
          }
        });
        LOCAL_SEED_DATABASE.managers.forEach(m => {
          if (m.manager_name.includes(query) && !suggestions.includes(m.manager_name)) {
            suggestions.push(m.manager_name);
          }
        });
      } else if (type === 'foundation') {
        LOCAL_SEED_DATABASE.foundations.forEach(f => {
          if (f.comname.includes(query) && !suggestions.includes(f.comname)) {
            suggestions.push(f.comname);
          }
        });
      }

      if (suggestions.length > 0) return suggestions.slice(0, 8);

      // 線上建議 API
      try {
        const u = new URL(type === 'foundation' ? 'https://undercurrent.kentshen.com/api/foundation-suggest' : 'https://undercurrent.kentshen.com/api/d1-suggest');
        u.searchParams.set('q', query);
        if (type !== 'foundation') u.searchParams.set('type', type);
        const r = await fetch(u.toString());
        if (r.ok) {
          const j = await r.json();
          return j.suggestions || [];
        }
      } catch (e) {}

      return [];
    }

    // 司法院法人查詢 (Foundations)
    async getFoundationBundle(query) {
      if (this.client) {
        try {
          const { data } = await this.client.from('foundations').select('*').ilike('comname', `%${query}%`);
          if (data && data.length > 0) return data;
        } catch (e) {}
      }

      const localFoundations = LOCAL_SEED_DATABASE.foundations.filter(f => f.comname.includes(query));
      if (localFoundations.length > 0) return localFoundations;

      try {
        const u = new URL('https://undercurrent.kentshen.com/api/foundation-expand');
        u.searchParams.set('q', query);
        const r = await fetch(u.toString());
        if (r.ok) {
          const j = await r.json();
          return j.foundations || [];
        }
      } catch (e) {}

      return [];
    }

    // 環境部裁罰處分 (Environmental Penalties)
    async getEnvPenalty(ubnOrName) {
      if (this.client) {
        try {
          const { data } = await this.client.from('env_penalties')
            .select('*')
            .or(`ubn.eq.${ubnOrName},company_name.ilike.%${ubnOrName}%`);
          if (data && data.length > 0) return { records: data, scanned: data.length };
        } catch (e) {}
      }

      const recs = LOCAL_SEED_DATABASE.penalties.filter(p => p.ubn === ubnOrName || p.company_name.includes(ubnOrName));
      return { records: recs, scanned: recs.length };
    }

    // 關係圖快照保存 (Save Snapshot to Supabase)
    async saveSnapshot(snapshotData) {
      const id = snapshotData.id || ('udc_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36));
      snapshotData.id = id;
      snapshotData.created_at = new Date().toISOString();

      // 本地備份
      localStorage.setItem('udc_snap_' + id, JSON.stringify(snapshotData));

      if (this.client) {
        try {
          const { error } = await this.client.from('graph_snapshots').insert([{
            id: id,
            title: snapshotData.title || '關係圖快照',
            nodes: snapshotData.nodes,
            edges: snapshotData.edges,
            node_count: snapshotData.node_count || (snapshotData.nodes || []).length,
            theme: snapshotData.theme || 'light',
            source: '經濟部商業發展署 / Supabase'
          }]);
          if (error) console.warn('[SupabaseBridge] Failed to save snapshot to Supabase:', error);
          else console.log('[SupabaseBridge] Snapshot saved to Supabase successfully!');
        } catch (e) {
          console.warn('[SupabaseBridge] Supabase save error:', e);
        }
      }

      return { id, token: id, ...snapshotData };
    }

    // 讀取快照 (Load Snapshot)
    async loadSnapshot(token) {
      if (!token) return null;

      if (this.client) {
        try {
          const { data, error } = await this.client.from('graph_snapshots').select('*').eq('id', token).single();
          if (!error && data) return data;
        } catch (e) {}
      }

      const cached = localStorage.getItem('udc_snap_' + token);
      if (cached) {
        try { return JSON.parse(cached); } catch (e) {}
      }

      // 嘗試從主站讀取
      try {
        const r = await fetch('https://undercurrent.kentshen.com/api/graph-snapshots?t=' + token);
        if (r.ok) return await r.json();
      } catch (e) {}

      return null;
    }

    // 使用者意見回饋 (Feedback)
    async submitFeedback(feedback) {
      if (this.client) {
        try {
          await this.client.from('feedbacks').insert([{
            category: feedback.category,
            content: feedback.content,
            contact: feedback.contact
          }]);
        } catch (e) {
          console.warn('[SupabaseBridge] Feedback submission to Supabase failed:', e);
        }
      }
      return { success: true };
    }
  }

  // 註冊至全域命名空間
  global.SupabaseBridge = new SupabaseOpenDataBridge();

})(typeof window !== 'undefined' ? window : this);
