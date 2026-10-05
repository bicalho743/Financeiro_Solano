// Supabase Edge Function (Financeiro Solano): cotações da B3 pela brapi.dev, sem expor o token no site.
// O app chama com sb.functions.invoke("cotacoes", {body:{tickers:["PETR4","MXRF11",...]}}) — só usuário logado.
// Resposta: { precos: { PETR4: {preco, varDia, fechAnt, nome, hora} }, erros: { XXXX11: "motivo" } }
// Histórico (rentabilidade mensal): body {historico:{tickers:["PETR4","^BVSP"], tesouro:["Tesouro IPCA+ 2040"], desde:"2026-01-01"}}
//   → { hist: { PETR4: {"2026-02": 38.1, ...}, "Tesouro IPCA+ 2040": {...} }, erros }  (último fechamento de cada mês)
//
// Secret (Edge Functions › Secrets):
//   BRAPI_TOKEN   token da brapi.dev (Dashboard › API Tokens)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem nas Edge Functions.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Cot = { preco: number; varDia: number | null; fechAnt: number | null; nome: string; hora: string };

function lerResultado(r: any): Cot | null {
  const preco = +r?.regularMarketPrice;
  if (!isFinite(preco) || preco <= 0) return null;
  const chg = r.regularMarketChangePercent != null && isFinite(+r.regularMarketChangePercent) ? +r.regularMarketChangePercent : null;
  return {
    preco,
    // variação: changePercent da brapi (o regularMarketPreviousClose às vezes vem com o preço do dia);
    // o fechamento anterior é deduzido dela
    varDia: chg,
    fechAnt: chg != null ? +(preco / (1 + chg / 100)).toFixed(6) : (+r.regularMarketPreviousClose > 0 ? +r.regularMarketPreviousClose : null),
    nome: r.longName || r.shortName || r.symbol,
    hora: r.regularMarketTime || new Date().toISOString(),
  };
}

async function buscar(lista: string[], token: string) {
  const u = "https://brapi.dev/api/quote/" + encodeURIComponent(lista.join(",")) + "?token=" + encodeURIComponent(token);
  const resp = await fetch(u);
  const corpo = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, corpo };
}

// ---------- histórico: último fechamento de cada mês ----------
const UA = { "User-Agent": "Mozilla/5.0 (compatible; FinanceiroSolano/1.0)" };
function porMes(pontos: [number, number][]) {          // [timestamp ms, preço] → {"AAAA-MM": último preço}
  const r: Record<string, number> = {};
  pontos.sort((a, b) => a[0] - b[0]).forEach(([t, p]) => {
    if (!(p > 0)) return;
    const d = new Date(t - 3 * 3600e3).toISOString().slice(0, 7);   // horário de Brasília
    r[d] = +p.toFixed(6);
  });
  return r;
}
async function histYahoo(t: string, desde: number) {
  const sym = t.startsWith("^") ? t : t + ".SA";
  const u = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) +
    "?interval=1d&period1=" + Math.floor(desde / 1000) + "&period2=" + Math.floor(Date.now() / 1000);
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error("Yahoo HTTP " + r.status);
  const j = await r.json(), res = j?.chart?.result?.[0];
  const ts: number[] = res?.timestamp || [], cl: number[] = res?.indicators?.quote?.[0]?.close || [];
  if (!ts.length) throw new Error("Yahoo sem dados");
  return porMes(ts.map((x, i) => [x * 1000, cl[i]] as [number, number]));
}
async function histBrapi(t: string, desde: number, token: string) {
  const u = "https://brapi.dev/api/quote/" + encodeURIComponent(t) + "?range=1y&interval=1d&token=" + encodeURIComponent(token);
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  const h = j?.results?.[0]?.historicalDataPrice || [];
  if (!r.ok || !h.length) throw new Error("brapi: " + (j?.message || "sem histórico"));
  return porMes(h.filter((x: any) => x.date * 1000 >= desde).map((x: any) => [x.date * 1000, +x.close] as [number, number]));
}
// Tesouro Transparente: preço de resgate (PU Venda Manhã) de todos os títulos, desde 2002 (CSV grande)
const CSV_TD = "https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv";
async function histTesouro(nomes: string[], desde: number) {
  const alvo: Record<string, string> = {};   // "TESOURO IPCA+|2040" → nome do ativo
  nomes.forEach((n) => { const m = n.match(/^(.*?)\s+(\d{4})$/); if (m) alvo[m[1].trim().toUpperCase() + "|" + m[2]] = n; });
  const r = await fetch(CSV_TD, { headers: UA });
  if (!r.ok) throw new Error("Tesouro Transparente HTTP " + r.status);
  const txt = await r.text();
  const pts: Record<string, [number, number][]> = {};
  const ini = new Date(desde).toISOString().slice(0, 10);
  let pos = txt.indexOf("\n") + 1;
  while (pos > 0 && pos < txt.length) {
    const fim = txt.indexOf("\n", pos), lin = txt.slice(pos, fim < 0 ? undefined : fim); pos = fim < 0 ? -1 : fim + 1;
    const c = lin.split(";"); if (c.length < 7) continue;
    const venc = c[1], base = c[2]; if (!base || base.length < 10) continue;
    const iso = base.slice(6, 10) + "-" + base.slice(3, 5) + "-" + base.slice(0, 2);
    if (iso < ini) continue;
    const nome = alvo[c[0].trim().toUpperCase() + "|" + venc.slice(6, 10)]; if (!nome) continue;
    const pu = parseFloat(c[6].replace(/\./g, "").replace(",", "."));
    (pts[nome] = pts[nome] || []).push([Date.parse(iso + "T15:00:00Z"), pu]);
  }
  const out: Record<string, Record<string, number>> = {};
  Object.entries(pts).forEach(([k, v]) => { out[k] = porMes(v); });
  return out;
}
async function historico(b: any, token: string | undefined) {
  const desde = Date.parse((b.desde || "2026-01-01") + "T00:00:00Z") - 7 * 86400e3;
  const tickers: string[] = [...new Set<string>((b.tickers || []).map((t: string) => String(t).trim().toUpperCase())
    .filter((t: string) => /^\^?[A-Z0-9]{3,12}$/.test(t)))].slice(0, 80);
  const tesouro: string[] = (b.tesouro || []).map(String).slice(0, 30);
  const hist: Record<string, Record<string, number>> = {}, erros: Record<string, string> = {};
  for (let i = 0; i < tickers.length; i += 6) {
    await Promise.all(tickers.slice(i, i + 6).map(async (t) => {
      try { hist[t] = await histYahoo(t, desde); }
      catch (e1) {
        if (!token || t.startsWith("^")) { erros[t] = String(e1); return; }
        try { hist[t] = await histBrapi(t, desde, token); } catch (e2) { erros[t] = String(e1) + " / " + String(e2); }
      }
    }));
  }
  if (tesouro.length) {
    try { Object.assign(hist, await histTesouro(tesouro, desde)); tesouro.forEach((n) => { if (!hist[n]) erros[n] = "título não encontrado no Tesouro Transparente"; }); }
    catch (e) { tesouro.forEach((n) => { erros[n] = String(e); }); }
  }
  return { hist, erros };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // só usuário logado no app
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: u, error: eu } = await admin.auth.getUser(jwt);
  if (eu || !u?.user) return json({ erro: "faça login no app" }, 401);

  const token = Deno.env.get("BRAPI_TOKEN");

  let tickers: string[] = [];
  let corpo: any = {};
  try {
    corpo = req.method === "POST" ? await req.json() : {};
    tickers = (corpo.tickers || new URL(req.url).searchParams.get("tickers")?.split(",") || []);
  } catch { /* corpo vazio */ }
  if (corpo.historico) return json(await historico(corpo.historico, token));
  tickers = [...new Set(tickers.map((t) => String(t).trim().toUpperCase()).filter((t) => /^[A-Z0-9]{4,12}$/.test(t)))].slice(0, 80);
  if (!tickers.length) return json({ precos: {}, erros: {} });
  if (!token) return json({ erro: "falta o secret BRAPI_TOKEN no Supabase" }, 500);

  const precos: Record<string, Cot> = {}, erros: Record<string, string> = {};

  // 1º: todos numa chamada (planos pagos aceitam); se o plano não aceitar, um por um
  const lote = await buscar(tickers, token);
  if (lote.ok && Array.isArray(lote.corpo?.results)) {
    for (const r of lote.corpo.results) { const c = lerResultado(r); if (c) precos[String(r.symbol).toUpperCase()] = c; }
  }
  // plano gratuito: uma requisição por vez — busca em sequência e tenta de novo se a brapi pedir para aguardar
  const faltam = tickers.filter((t) => !precos[t]);
  const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const t of faltam) {
    for (let tent = 0; tent < 4; tent++) {
      try {
        const r = await buscar([t], token);
        const c = r.ok ? lerResultado(r.corpo?.results?.[0]) : null;
        if (c) { precos[t] = c; delete erros[t]; break; }
        erros[t] = r.corpo?.message || ("HTTP " + r.status);
        if (!(r.status === 429 || /simult|aguarde|limite/i.test(erros[t]))) break;
      } catch (e) { erros[t] = String(e); }
      await espera(600 * (tent + 1));
    }
  }
  return json({ precos, erros, em: new Date().toISOString() });
});
