// Supabase Edge Function: gcis-proxy
// 專屬伺服端代理：直連台灣經濟部商工行政開放資料平臺 (data.gcis.nat.gov.tw)，克服前端瀏覽器跨域 (CORS) 與 SSL 限制
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint") || "5F64D864-61CB-4D0D-8AD9-492047CC1EA6";
    let filter = url.searchParams.get("filter") || "";
    const top = url.searchParams.get("top") || "50";

    // 針對公司名稱搜尋，若未指定公司狀態則自動補上營業中代碼 (Company_Status eq 01)
    if (endpoint === "6BBA2268-1367-4B42-9CCA-BC17499EBE8C" && filter.includes("Company_Name like") && !filter.includes("Company_Status")) {
      filter += " and Company_Status eq 01";
    }

    const targetUrl = new URL(`https://data.gcis.nat.gov.tw/od/data/api/${endpoint}`);
    targetUrl.searchParams.set("$format", "json");
    if (filter) targetUrl.searchParams.set("$filter", filter);
    if (top) targetUrl.searchParams.set("$top", top);

    const res = await fetch(targetUrl.toString(), {
      headers: { "Accept": "application/json" }
    });

    const data = await res.text();
    return new Response(data, {
      status: res.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
