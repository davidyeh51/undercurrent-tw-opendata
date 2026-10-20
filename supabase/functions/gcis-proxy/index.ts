// Supabase Edge Function: gcis-proxy
// 用於代理台灣政府開放資料 API (GCIS / 司法法人 / 環境部)，克服前端 CORS 與政府 CA 憑證問題
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
    const filter = url.searchParams.get("filter") || "";
    const top = url.searchParams.get("top") || "50";

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
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
