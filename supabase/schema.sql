-- ==============================================================================
-- UNDERCURRENT (暗流) ✕ 台灣政府 OpenData ✕ Supabase BaaS 資料庫架構
-- ==============================================================================
-- 資料來源：
-- 1. 經濟部商業發展署：公司登記基本資料集 (EP: 5F64D864-61CB-4D0D-8AD9-492047CC1EA6)
-- 2. 經濟部商業發展署：公司登記董監事資料集 (EP: 4E5F7653-1B91-4DDC-99D5-468530FAE396)
-- 3. 經濟部商業發展署：公司登記經理人資料集
-- 4. 司法院：法人登記公告資料集 (基金會 / 社團法人 / 財團法人)
-- 5. 環境部：裁罰處分資料集
-- ==============================================================================

-- 1. 公司登記基本資料表 (Companies)
CREATE TABLE IF NOT EXISTS public.companies (
  ubn VARCHAR(10) PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  company_status_desc VARCHAR(50) DEFAULT '核准設立',
  capital_stock_amount NUMERIC DEFAULT 0,
  paid_in_capital_amount NUMERIC DEFAULT 0,
  responsible_name VARCHAR(100),
  company_location TEXT,
  register_organization_desc VARCHAR(100),
  company_setup_date VARCHAR(20),
  change_of_approval_data VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 公司董監事名單表 (Directors & Supervisors)
CREATE TABLE IF NOT EXISTS public.directors (
  id BIGSERIAL PRIMARY KEY,
  ubn VARCHAR(10) NOT NULL REFERENCES public.companies(ubn) ON DELETE CASCADE,
  company_name VARCHAR(255),
  position VARCHAR(50) NOT NULL,
  person_name VARCHAR(100) NOT NULL,
  represents VARCHAR(255) DEFAULT '',
  shares NUMERIC DEFAULT 0,
  rank INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 公司經理人名單表 (Managers)
CREATE TABLE IF NOT EXISTS public.managers (
  id BIGSERIAL PRIMARY KEY,
  ubn VARCHAR(10) NOT NULL REFERENCES public.companies(ubn) ON DELETE CASCADE,
  company_name VARCHAR(255),
  manager_name VARCHAR(100) NOT NULL,
  position VARCHAR(50) DEFAULT '經理人',
  start_date VARCHAR(20) DEFAULT '',
  rank INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 司法院法人登記公告表 (Foundations / Juristic Persons)
CREATE TABLE IF NOT EXISTS public.foundations (
  id BIGSERIAL PRIMARY KEY,
  comname VARCHAR(255) NOT NULL,
  docid VARCHAR(100),
  court VARCHAR(100),
  setup_date VARCHAR(20),
  register_date VARCHAR(20),
  funds VARCHAR(100),
  chairman VARCHAR(100),
  purpose TEXT,
  office_address TEXT,
  donors TEXT,
  directors JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. 環境部裁罰處分資料表 (Environmental Penalties)
CREATE TABLE IF NOT EXISTS public.env_penalties (
  id BIGSERIAL PRIMARY KEY,
  ubn VARCHAR(10),
  company_name VARCHAR(255),
  penalty_date VARCHAR(20),
  penalty_money VARCHAR(50),
  law VARCHAR(255),
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. 關係圖快照表 (Graph Snapshots for Sharing & Embedding)
CREATE TABLE IF NOT EXISTS public.graph_snapshots (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  nodes JSONB NOT NULL,
  edges JSONB NOT NULL,
  node_count INT DEFAULT 0,
  source VARCHAR(100) DEFAULT '經濟部商業發展署 / Supabase',
  theme VARCHAR(20) DEFAULT 'light',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  user_id UUID,
  is_public BOOLEAN DEFAULT TRUE
);

-- 7. 使用者意見回饋表 (User Feedbacks)
CREATE TABLE IF NOT EXISTS public.feedbacks (
  id BIGSERIAL PRIMARY KEY,
  category VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  contact VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 建立高效索引 (Indexes for Lightning-Fast Queries)
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_companies_name ON public.companies(company_name);
CREATE INDEX IF NOT EXISTS idx_companies_resp ON public.companies(responsible_name);
CREATE INDEX IF NOT EXISTS idx_directors_person ON public.directors(person_name);
CREATE INDEX IF NOT EXISTS idx_directors_ubn ON public.directors(ubn);
CREATE INDEX IF NOT EXISTS idx_directors_rep ON public.directors(represents);
CREATE INDEX IF NOT EXISTS idx_managers_name ON public.managers(manager_name);
CREATE INDEX IF NOT EXISTS idx_managers_ubn ON public.managers(ubn);
CREATE INDEX IF NOT EXISTS idx_foundations_name ON public.foundations(comname);
CREATE INDEX IF NOT EXISTS idx_penalties_ubn ON public.env_penalties(ubn);
CREATE INDEX IF NOT EXISTS idx_penalties_name ON public.env_penalties(company_name);
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON public.graph_snapshots(created_at DESC);

-- ==============================================================================
-- 啟用行級安全策略 (Row Level Security - RLS)
-- ==============================================================================
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.foundations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.env_penalties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedbacks ENABLE ROW LEVEL SECURITY;

-- 讀取政策：公開所有商業登記與開放資料
DROP POLICY IF EXISTS "Public can read companies" ON public.companies;
CREATE POLICY "Public can read companies" ON public.companies FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can read directors" ON public.directors;
CREATE POLICY "Public can read directors" ON public.directors FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can read managers" ON public.managers;
CREATE POLICY "Public can read managers" ON public.managers FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can read foundations" ON public.foundations;
CREATE POLICY "Public can read foundations" ON public.foundations FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can read env_penalties" ON public.env_penalties;
CREATE POLICY "Public can read env_penalties" ON public.env_penalties FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can read graph_snapshots" ON public.graph_snapshots;
CREATE POLICY "Public can read graph_snapshots" ON public.graph_snapshots FOR SELECT USING (true);

-- 寫入政策：允許匿名建立快照與意見回饋，以及同步公開資料快取
DROP POLICY IF EXISTS "Public can insert snapshots" ON public.graph_snapshots;
CREATE POLICY "Public can insert snapshots" ON public.graph_snapshots FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public can insert feedbacks" ON public.feedbacks;
CREATE POLICY "Public can insert feedbacks" ON public.feedbacks FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Anon can sync companies" ON public.companies;
CREATE POLICY "Anon can sync companies" ON public.companies FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Anon can update companies" ON public.companies;
CREATE POLICY "Anon can update companies" ON public.companies FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Anon can sync directors" ON public.directors;
CREATE POLICY "Anon can sync directors" ON public.directors FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Anon can sync managers" ON public.managers;
CREATE POLICY "Anon can sync managers" ON public.managers FOR INSERT WITH CHECK (true);

-- ==============================================================================
-- 伺服端 RPC 函數：一鍵展開實體關係圖 (expand_entity)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.expand_entity(q text, stype text, depth int DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
  target_ubn text;
BEGIN
  IF stype = 'ubn' OR (stype = 'company' AND q ~ '^[0-9]{8}$') THEN
    target_ubn := q;
    SELECT jsonb_build_object(
      'centerType', 'ubn',
      'companies', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'ubn', c.ubn,
          'company_name', c.company_name,
          'level', 1
        ))
        FROM public.companies c WHERE c.ubn = target_ubn
      ), '[]'::jsonb),
      'directors', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'ubn', d.ubn,
          'company_name', d.company_name,
          'position', d.position,
          'person_name', d.person_name,
          'represents', d.represents,
          'shares', d.shares::text
        ))
        FROM public.directors d WHERE d.ubn = target_ubn
      ), '[]'::jsonb),
      'managers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'ubn', m.ubn,
          'company_name', m.company_name,
          'manager_name', m.manager_name,
          'position', m.position,
          'start_date', m.start_date
        ))
        FROM public.managers m WHERE m.ubn = target_ubn
      ), '[]'::jsonb)
    ) INTO result;
    RETURN result;

  ELSIF stype = 'company' THEN
    -- 依公司名稱搜尋
    SELECT c.ubn INTO target_ubn FROM public.companies c WHERE c.company_name = q LIMIT 1;
    IF target_ubn IS NULL THEN
      SELECT c.ubn INTO target_ubn FROM public.companies c WHERE c.company_name ILIKE '%' || q || '%' LIMIT 1;
    END IF;

    IF target_ubn IS NOT NULL THEN
      RETURN public.expand_entity(target_ubn, 'ubn', depth);
    ELSE
      RETURN jsonb_build_object('centerType', 'company', 'companies', '[]'::jsonb, 'directors', '[]'::jsonb, 'managers', '[]'::jsonb);
    END IF;

  ELSIF stype = 'person' THEN
    -- 依董監事/經理人姓名展開
    SELECT jsonb_build_object(
      'centerType', 'person',
      'companies', COALESCE((
        SELECT jsonb_agg(DISTINCT jsonb_build_object(
          'ubn', c.ubn,
          'company_name', c.company_name,
          'level', 1
        ))
        FROM public.companies c
        WHERE c.ubn IN (
          SELECT d.ubn FROM public.directors d WHERE d.person_name = q
          UNION
          SELECT m.ubn FROM public.managers m WHERE m.manager_name = q
        )
      ), '[]'::jsonb),
      'directors', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'ubn', d.ubn,
          'company_name', d.company_name,
          'position', d.position,
          'person_name', d.person_name,
          'represents', d.represents,
          'shares', d.shares::text
        ))
        FROM public.directors d
        WHERE d.ubn IN (
          SELECT d2.ubn FROM public.directors d2 WHERE d2.person_name = q
          UNION
          SELECT m2.ubn FROM public.managers m2 WHERE m2.manager_name = q
        )
      ), '[]'::jsonb),
      'managers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'ubn', m.ubn,
          'company_name', m.company_name,
          'manager_name', m.manager_name,
          'position', m.position,
          'start_date', m.start_date
        ))
        FROM public.managers m
        WHERE m.ubn IN (
          SELECT d3.ubn FROM public.directors d3 WHERE d3.person_name = q
          UNION
          SELECT m3.ubn FROM public.managers m3 WHERE m3.manager_name = q
        )
      ), '[]'::jsonb)
    ) INTO result;
    RETURN result;
  END IF;

  RETURN jsonb_build_object('centerType', stype, 'companies', '[]'::jsonb, 'directors', '[]'::jsonb, 'managers', '[]'::jsonb);
END;
$$;

-- ==============================================================================
-- 伺服端 RPC 函數：自動補全建議 (search_suggestions)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.search_suggestions(q text, stype text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  res jsonb;
BEGIN
  IF stype = 'company' THEN
    SELECT COALESCE(jsonb_agg(DISTINCT c.company_name), '[]'::jsonb) INTO res
    FROM (
      SELECT company_name FROM public.companies WHERE company_name ILIKE '%' || q || '%' LIMIT 10
    ) c;
  ELSIF stype = 'person' THEN
    SELECT COALESCE(jsonb_agg(DISTINCT p.person_name), '[]'::jsonb) INTO res
    FROM (
      SELECT person_name FROM public.directors WHERE person_name ILIKE '%' || q || '%'
      UNION
      SELECT manager_name FROM public.managers WHERE manager_name ILIKE '%' || q || '%'
      LIMIT 10
    ) p;
  ELSIF stype = 'ubn' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('ubn', c.ubn, 'company_name', c.company_name)), '[]'::jsonb) INTO res
    FROM (
      SELECT ubn, company_name FROM public.companies WHERE ubn ILIKE q || '%' LIMIT 10
    ) c;
  ELSIF stype = 'foundation' THEN
    SELECT COALESCE(jsonb_agg(DISTINCT f.comname), '[]'::jsonb) INTO res
    FROM (
      SELECT comname FROM public.foundations WHERE comname ILIKE '%' || q || '%' LIMIT 10
    ) f;
  ELSE
    res := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object('suggestions', res);
END;
$$;

-- ==============================================================================
-- 植入示範數據 (Seed OpenData for Major Taiwan Corporations)
-- ==============================================================================

-- 1. 台積電 (TSMC 22099131)
INSERT INTO public.companies (ubn, company_name, company_status_desc, capital_stock_amount, paid_in_capital_amount, responsible_name, company_location, register_organization_desc, company_setup_date, change_of_approval_data)
VALUES ('22099131', '台灣積體電路製造股份有限公司', '核准設立', 280500000000, 259323700670, '魏哲家', '新竹科學園區新竹市力行六路8號', '國家科學及技術委員會新竹科學園區管理局', '0760221', '1150821')
ON CONFLICT (ubn) DO UPDATE SET updated_at = NOW();

INSERT INTO public.directors (ubn, company_name, position, person_name, represents, shares, rank) VALUES
('22099131', '台灣積體電路製造股份有限公司', '董事長', '魏哲家', '', 7452349, 1),
('22099131', '台灣積體電路製造股份有限公司', '董事', '曾繁城', '', 24472675, 2),
('22099131', '台灣積體電路製造股份有限公司', '董事', '劉德音', '', 12913114, 3),
('22099131', '台灣積體電路製造股份有限公司', '董事', '葉俊顯', '行政院國家發展基金管理會', 1653709980, 4),
('22099131', '台灣積體電路製造股份有限公司', '獨立董事', '彼得‧邦菲爵士', '', 0, 5),
('22099131', '台灣積體電路製造股份有限公司', '獨立董事', '麥克‧史賓林特', '', 0, 6),
('22099131', '台灣積體電路製造股份有限公司', '獨立董事', '摩西‧蓋弗瑞洛夫', '', 0, 7),
('22099131', '台灣積體電路製造股份有限公司', '獨立董事', '拉斐爾‧萊夫', '', 0, 8),
('22099131', '台灣積體電路製造股份有限公司', '獨立董事', '海芬妮', '', 0, 9),
('22099131', '台灣積體電路製造股份有限公司', '獨立董事', '林全', '', 0, 10)
ON CONFLICT DO NOTHING;

INSERT INTO public.managers (ubn, company_name, manager_name, position, start_date, rank) VALUES
('22099131', '台灣積體電路製造股份有限公司', '魏哲家', '總裁', '0870303', 1),
('22099131', '台灣積體電路製造股份有限公司', '秦永沛', '執行副總經理', '0970219', 2),
('22099131', '台灣積體電路製造股份有限公司', '米玉傑', '執行副總經理', '1010101', 3),
('22099131', '台灣積體電路製造股份有限公司', '侯永清', '資深副總經理', '1070801', 4),
('22099131', '台灣積體電路製造股份有限公司', '張曉強', '資深副總經理', '1090201', 5),
('22099131', '台灣積體電路製造股份有限公司', '黃仁昭', '資深副總經理暨財務長', '1080901', 6)
ON CONFLICT DO NOTHING;

-- 2. 鴻海精密工業 (04541302)
INSERT INTO public.companies (ubn, company_name, company_status_desc, capital_stock_amount, paid_in_capital_amount, responsible_name, company_location, register_organization_desc, company_setup_date, change_of_approval_data)
VALUES ('04541302', '鴻海精密工業股份有限公司', '核准設立', 180000000000, 138629906090, '劉揚偉', '新北市土城區自由街2號', '經濟部商業發展署', '0630220', '1130815')
ON CONFLICT (ubn) DO UPDATE SET updated_at = NOW();

INSERT INTO public.directors (ubn, company_name, position, person_name, represents, shares, rank) VALUES
('04541302', '鴻海精密工業股份有限公司', '董事長', '劉揚偉', '', 656000, 1),
('04541302', '鴻海精密工業股份有限公司', '董事', '郭台銘', '', 1742199588, 2),
('04541302', '鴻海精密工業股份有限公司', '董事', '李傑', '', 0, 3),
('04541302', '鴻海精密工業股份有限公司', '董事', '呂芳銘', '', 3929424, 4),
('04541302', '鴻海精密工業股份有限公司', '董事', '陳振國', '', 0, 5),
('04541302', '鴻海精密工業股份有限公司', '獨立董事', '王國城', '', 0, 6),
('04541302', '鴻海精密工業股份有限公司', '獨立董事', '黃清苑', '', 0, 7),
('04541302', '鴻海精密工業股份有限公司', '獨立董事', '詹文男', '', 0, 8),
('04541302', '鴻海精密工業股份有限公司', '獨立董事', '劉連煜', '', 0, 9)
ON CONFLICT DO NOTHING;

INSERT INTO public.managers (ubn, company_name, manager_name, position, start_date, rank) VALUES
('04541302', '鴻海精密工業股份有限公司', '劉揚偉', '總經理', '1080701', 1),
('04541302', '鴻海精密工業股份有限公司', '巫俊毅', '副總經理暨發言人', '1110501', 2),
('04541302', '鴻海精密工業股份有限公司', '黃秋蓮', '總財務長', '0700101', 3)
ON CONFLICT DO NOTHING;

-- 3. 聯發科技 (16148372)
INSERT INTO public.companies (ubn, company_name, company_status_desc, capital_stock_amount, paid_in_capital_amount, responsible_name, company_location, register_organization_desc, company_setup_date, change_of_approval_data)
VALUES ('16148372', '聯發科技股份有限公司', '核准設立', 20000000000, 16002951710, '蔡明介', '新竹科學園區新竹市篤行一路1號', '國家科學及技術委員會新竹科學園區管理局', '0860528', '1130718')
ON CONFLICT (ubn) DO UPDATE SET updated_at = NOW();

INSERT INTO public.directors (ubn, company_name, position, person_name, represents, shares, rank) VALUES
('16148372', '聯發科技股份有限公司', '董事長', '蔡明介', '', 41459461, 1),
('16148372', '聯發科技股份有限公司', '副董事長', '蔡力行', '', 2950000, 2),
('16148372', '聯發科技股份有限公司', '董事', '陳冠州', '', 1420000, 3),
('16148372', '聯發科技股份有限公司', '董事', '謝清江', '', 2380000, 4),
('16148372', '聯發科技股份有限公司', '獨立董事', '湯明哲', '', 0, 5),
('16148372', '聯發科技股份有限公司', '獨立董事', '吳重雨', '', 0, 6)
ON CONFLICT DO NOTHING;

-- 4. 廣達電腦 (22967160)
INSERT INTO public.companies (ubn, company_name, company_status_desc, capital_stock_amount, paid_in_capital_amount, responsible_name, company_location, register_organization_desc, company_setup_date, change_of_approval_data)
VALUES ('22967160', '廣達電腦股份有限公司', '核准設立', 45000000000, 38626345600, '林百里', '桃園市龜山區文化二路188號', '經濟部商業發展署', '0770509', '1130628')
ON CONFLICT (ubn) DO UPDATE SET updated_at = NOW();

INSERT INTO public.directors (ubn, company_name, position, person_name, represents, shares, rank) VALUES
('22967160', '廣達電腦股份有限公司', '董事長', '林百里', '', 415738596, 1),
('22967160', '廣達電腦股份有限公司', '副董事長', '梁次震', '', 65545239, 2),
('22967160', '廣達電腦股份有限公司', '董事', '黃健堂', '', 13800000, 3)
ON CONFLICT DO NOTHING;

-- 5. 台達電子 (04302213)
INSERT INTO public.companies (ubn, company_name, company_status_desc, capital_stock_amount, paid_in_capital_amount, responsible_name, company_location, register_organization_desc, company_setup_date, change_of_approval_data)
VALUES ('04302213', '台達電子工業股份有限公司', '核准設立', 30000000000, 25975438880, '鄭平', '台北市內湖區陽光街186號', '經濟部商業發展署', '0640820', '1130615')
ON CONFLICT (ubn) DO UPDATE SET updated_at = NOW();

INSERT INTO public.directors (ubn, company_name, position, person_name, represents, shares, rank) VALUES
('04302213', '台達電子工業股份有限公司', '董事長', '鄭平', '', 12560000, 1),
('04302213', '台達電子工業股份有限公司', '董事', '鄭崇華', '', 97000000, 2),
('04302213', '台達電子工業股份有限公司', '董事', '海英俊', '', 7800000, 3)
ON CONFLICT DO NOTHING;

-- 6. 富邦金融控股 (70775836)
INSERT INTO public.companies (ubn, company_name, company_status_desc, capital_stock_amount, paid_in_capital_amount, responsible_name, company_location, register_organization_desc, company_setup_date, change_of_approval_data)
VALUES ('70775836', '富邦金融控股股份有限公司', '核准設立', 160000000000, 142089400000, '蔡明興', '台北市松山區敦化南路一段108號', '經濟部商業發展署', '0901219', '1130712')
ON CONFLICT (ubn) DO UPDATE SET updated_at = NOW();

INSERT INTO public.directors (ubn, company_name, position, person_name, represents, shares, rank) VALUES
('70775836', '富邦金融控股股份有限公司', '董事長', '蔡明興', '', 398000000, 1),
('70775836', '富邦金融控股股份有限公司', '董事', '蔡明忠', '', 375000000, 2),
('70775836', '富邦金融控股股份有限公司', '董事', '韓蔚廷', '', 4500000, 3)
ON CONFLICT DO NOTHING;

-- 7. 國泰金融控股 (16670878)
INSERT INTO public.companies (ubn, company_name, company_status_desc, capital_stock_amount, paid_in_capital_amount, responsible_name, company_location, register_organization_desc, company_setup_date, change_of_approval_data)
VALUES ('16670878', '國泰金融控股股份有限公司', '核准設立', 180000000000, 147029500000, '蔡宏圖', '台北市大安區仁愛路四段296號', '經濟部商業發展署', '0901231', '1130620')
ON CONFLICT (ubn) DO UPDATE SET updated_at = NOW();

INSERT INTO public.directors (ubn, company_name, position, person_name, represents, shares, rank) VALUES
('16670878', '國泰金融控股股份有限公司', '董事長', '蔡宏圖', '', 275000000, 1),
('16670878', '國泰金融控股股份有限公司', '董事', '蔡政達', '', 210000000, 2),
('16670878', '國泰金融控股股份有限公司', '董事', '李長庚', '', 3200000, 3)
ON CONFLICT DO NOTHING;

-- 8. 進金生能源服務 (84149807)
INSERT INTO public.companies (ubn, company_name, company_status_desc, capital_stock_amount, paid_in_capital_amount, responsible_name, company_location, register_organization_desc, company_setup_date, change_of_approval_data)
VALUES ('84149807', '進金生能源服務股份有限公司', '核准設立', 1000000000, 715000000, '厲燕蒙', '台北市內湖區行善路397號6樓', '經濟部商業發展署', '1000812', '1130910')
ON CONFLICT (ubn) DO UPDATE SET updated_at = NOW();

INSERT INTO public.directors (ubn, company_name, position, person_name, represents, shares, rank) VALUES
('84149807', '進金生能源服務股份有限公司', '董事長', '厲燕蒙', '進金生實業股份有限公司', 28500000, 1),
('84149807', '進金生能源服務股份有限公司', '董事', '黃顯川', '', 1200000, 2)
ON CONFLICT DO NOTHING;

INSERT INTO public.managers (ubn, company_name, manager_name, position, start_date, rank) VALUES
('84149807', '進金生能源服務股份有限公司', '黃顯川', '總經理', '1000812', 1)
ON CONFLICT DO NOTHING;

-- 植入示範法人基金會 (Foundations)
INSERT INTO public.foundations (comname, docid, court, setup_date, register_date, funds, chairman, purpose, office_address, donors, directors)
VALUES
('財團法人台積電文教基金會', '1998-新竹-01', '臺灣新竹地方法院', '1998-05-18', '1998-06-01', '30000000', '曾繁城', '培育科技人才，贊助教育、文化與藝術活動，實踐企業社會責任。', '新竹科學園區新竹市力行六路8號', '台灣積體電路製造股份有限公司', '[{"name":"曾繁城","position":"董事長"},{"name":"張忠謀","position":"董事"},{"name":"魏哲家","position":"董事"},{"name":"孫又文","position":"董事"}]'::jsonb),
('財團法人鴻海教育基金會', '2008-板橋-02', '臺灣新北地方法院', '2008-03-20', '2008-04-10', '50000000', '郭台銘', '獎勵優秀青年，推動科技與生命教育發展，促進弱勢族群向上流動。', '新北市土城區自由街2號', '鴻海精密工業股份有限公司、郭台銘', '[{"name":"郭台銘","position":"董事長"},{"name":"劉揚偉","position":"董事"},{"name":"黃秋蓮","position":"董事"}]'::jsonb),
('財團法人富邦文教基金會', '1990-台北-03', '臺灣臺北地方法院', '1990-12-05', '1991-01-15', '40000000', '蔡明興', '推動青少年培力、媒體素養及藝文活動。', '台北市松山區敦化南路一段108號', '富邦金融控股股份有限公司', '[{"name":"蔡明興","position":"董事長"},{"name":"蔡明忠","position":"董事"}]'::jsonb)
ON CONFLICT DO NOTHING;

-- 植入示範裁罰處分紀錄 (Environmental Penalties)
INSERT INTO public.env_penalties (ubn, company_name, penalty_date, penalty_money, law, reason)
VALUES
('22099131', '台灣積體電路製造股份有限公司', '2023-11-04', '100,000', '空氣污染防制法', '製程廢氣防制設備未依許可證操作條件運作'),
('04541302', '鴻海精密工業股份有限公司', '2022-08-16', '60,000', '水污染防治法', '廢水放流水質懸浮固體超標'),
('16148372', '聯發科技股份有限公司', '2021-05-10', '30,000', '廢棄物清理法', '事業廢棄物清理計畫書變更未依期限申報')
ON CONFLICT DO NOTHING;
