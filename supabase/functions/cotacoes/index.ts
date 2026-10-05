// Supabase Edge Function (Financeiro Solano): cotações da B3 pela brapi.dev, sem expor o token no site.
// O app chama com sb.functions.invoke("cotacoes", {body:{tickers:["PETR4","MXRF11",...]}}) — só usuário logado.
// Resposta: { precos: { PETR4: {preco, varDia, fechAnt, nome, hora} }, erros: { XXXX11: "motivo" } }
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
  return {
    preco,
    varDia: isFinite(+r.regularMarketChangePercent) ? +r.regularMarketChangePercent : null,
    fechAnt: isFinite(+r.regularMarketPreviousClose) ? +r.regularMarketPreviousClose : null,
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // só usuário logado no app
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: u, error: eu } = await admin.auth.getUser(jwt);
  if (eu || !u?.user) return json({ erro: "faça login no app" }, 401);

  const token = Deno.env.get("BRAPI_TOKEN");
  if (!token) return json({ erro: "falta o secret BRAPI_TOKEN no Supabase" }, 500);

  let tickers: string[] = [];
  try {
    const b = req.method === "POST" ? await req.json() : {};
    tickers = (b.tickers || new URL(req.url).searchParams.get("tickers")?.split(",") || []);
  } catch { /* corpo vazio */ }
  tickers = [...new Set(tickers.map((t) => String(t).trim().toUpperCase()).filter((t) => /^[A-Z0-9]{4,12}$/.test(t)))].slice(0, 80);
  if (!tickers.length) return json({ precos: {}, erros: {} });

  const precos: Record<string, Cot> = {}, erros: Record<string, string> = {};

  // 1º: todos numa chamada (planos pagos aceitam); se o plano não aceitar, um por um
  const lote = await buscar(tickers, token);
  if (lote.ok && Array.isArray(lote.corpo?.results)) {
    for (const r of lote.corpo.results) { const c = lerResultado(r); if (c) precos[String(r.symbol).toUpperCase()] = c; }
  }
  const faltam = tickers.filter((t) => !precos[t]);
  for (let i = 0; i < faltam.length; i += 5) {
    await Promise.all(faltam.slice(i, i + 5).map(async (t) => {
      try {
        const r = await buscar([t], token);
        const c = r.ok ? lerResultado(r.corpo?.results?.[0]) : null;
        if (c) precos[t] = c; else erros[t] = r.corpo?.message || ("HTTP " + r.status);
      } catch (e) { erros[t] = String(e); }
    }));
  }
  return json({ precos, erros, em: new Date().toISOString() });
});
