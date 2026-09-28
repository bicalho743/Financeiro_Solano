// Supabase Edge Function (Financeiro Solano): resumo diário no WhatsApp + planilha do mês para baixar.
// Todo dia: monta o texto do mês, gera o .xlsx no formato da aba LANÇAMENTOS, guarda no Storage
// e manda pelo CallMeBot o texto com o link (o CallMeBot só envia texto, não anexo).
// O link aponta para esta própria função (?planilha=AAAA-MM&k=...), que gera a planilha na hora:
// link curto, sem token JWT (que quebrava ao copiar) e sempre com os dados atuais.
//
// Secrets (Edge Functions › Secrets):
//   LC_USER_ID        seu id em Authentication › Users
//   WA_TELEFONE       55 + DDD + número, ex: 5531999998888
//   CALLMEBOT_APIKEY  apikey do CallMeBot
//   CRON_SECRET       senha qualquer, a mesma do agendamento
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem nas Edge Functions.

import { createClient } from "npm:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

type Lanc = { data: string; hist: string; valor: number; categoria: string; origem?: string; doc?: string;
              tipo?: string; ignorado?: boolean };

const CHAVE = "financeiro-solano:v1";
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const MES_PL = ["JAN","FEV","MAR","ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ"];

// ---- mesmas regras do index.html ----
const GRUPOS = [
    {g:"Receitas", cor:"#1E8A5F", cats:["Salário","13º salário","Rendimentos","Restituição IR","Reembolso e estorno","Outras receitas"]},
    {g:"Financiamento e dívidas", cor:"#7D3C98", cats:["Financiamento casa","Consignado","Consórcio","IOF e taxas","Previdência"]},
    {g:"Moradia", cor:"#5D6D2E", cats:["Luz (Cemig)","Água (Copasa)","Internet","IPTU","TV (Sky)","Celular (TIM)","Assinaturas","Manutenção da casa"]},
    {g:"Serviço doméstico", cor:"#9A6B00", cats:["Doméstica – salário","Doméstica – e-Social","Doméstica – transporte","Doméstica – provisão","Diarista / jardim / extras"]},
    {g:"Alimentação", cor:"#D35400", cats:["Supermercado","Padaria","Açougue","Sacolão / feira","Bar / restaurante","Almoço","Lanche"]},
    {g:"Educação", cor:"#1F6FB2", cats:["Escola","Material / passeios escola"]},
    {g:"Saúde", cor:"#B03A2E", cats:["Unimed","Farmácia","Saúde fora do plano"]},
    {g:"Transporte", cor:"#0B7A83", cats:["Uber / Localiza","Gasolina","IPVA / multas","Seguro auto","Manutenção do carro"]},
    {g:"Lazer e pessoal", cor:"#C2185B", cats:["Clube","Corrida","Passeios","Férias / viagem","Solano – pessoal","Tâmara – pessoal","Meninas","Pet","Vestuário"]},
    {g:"Transferências", cor:"#8D6E63", cats:["Transferências Tâmara"]},
    {g:"Fora dos cálculos", cor:"#95A5A6", cats:["Cartão de crédito","Aplicação e resgate","Transferência entre minhas contas"]},
    {g:"", cor:"#B0AEA6", cats:["Sem categoria"]}
  ];
const GRUPO_DE: Record<string, string> = {};
GRUPOS.forEach((x: any) => x.cats.forEach((c: string) => { GRUPO_DE[c] = x.g; }));
const CAT_ENTRE = "Transferência entre minhas contas";
const CATS_FORA = new Set(["Cartão de crédito", "Aplicação e resgate", CAT_ENTRE]);
const ENTRA_FORA = new Set(["Aplicação e resgate", CAT_ENTRE]);   // resgate e Pix de outra conta sua contam como entrada
const ehMov = (l: Lanc) => !CATS_FORA.has(l.categoria) || (l.valor > 0 && ENTRA_FORA.has(l.categoria));
const ehReceita = (c: string) => GRUPO_DE[c] === "Receitas";

// entradas e gastos por categoria, líquidos (estorno abate o gasto da própria categoria) — igual ao entSai do app
function entSai(ls: Lanc[]) {
  const liq: Record<string, number> = {};
  ls.forEach((l) => { const k = l.categoria === "Sem categoria" ? (l.valor > 0 ? "+" : "-") : l.categoria; liq[k] = (liq[k] || 0) + l.valor; });
  const ent: Record<string, number> = {}, sai: Record<string, number> = {};
  for (const k in liq) {
    const v = liq[k]; if (Math.abs(v) < 0.005) continue;
    if (k === "+") ent["Sem categoria"] = v;
    else if (k === "-") sai["Sem categoria"] = -v;
    else if (ehReceita(k) || (ENTRA_FORA.has(k) && v > 0)) ent[k] = v;
    else sai[k] = -v;
  }
  const soma = (o: Record<string, number>) => Object.values(o).reduce((s, x) => s + x, 0);
  return { ent, sai, tE: soma(ent), tS: soma(sai) };
}

// ---- formato da aba LANÇAMENTOS (igual ao botão "Exportar planilha" do app) ----
const MAPA_PLANILHA: Record<string, string> = {
    "bar/restaurante|":"Bar / restaurante","bar/restaurante|bar/restaurante":"Bar / restaurante",
    "bar/restaurante|almoço":"Almoço","bar/restaurante|lanche":"Lanche","bar/restaurante|supermercado":"Supermercado",
    "casa|assinaturas":"Assinaturas","casa|cemig":"Luz (Cemig)","casa|internet":"Internet","casa|iptu":"IPTU",
    "casa|iptu parcela":"IPTU","casa|manutenção":"Manutenção da casa","casa|diversos imprevisto":"Manutenção da casa",
    "casa|sky":"TV (Sky)","casa|tim":"Celular (TIM)","casa|água":"Água (Copasa)",
    "diversos|meninas":"Meninas","diversos|cecília":"Meninas","diversos|pet":"Pet","diversos|solano":"Solano – pessoal",
    "diversos|tâmara":"Tâmara – pessoal","diversos|vestuario":"Vestuário","diversos|vestuário":"Vestuário",
    "escola|":"Escola","escola|escola":"Escola","escola|material passeios":"Material / passeios escola",
    "escola|material/passeio":"Material / passeios escola",
    "financia_invest|empréstimo":"Consignado","financia_invest|financiamento casa":"Financiamento casa",
    "financiamento e dividas|consórcio":"Consórcio","financiamento e dividas|iof taxas":"IOF e taxas",
    "financiamento e dividas|empréstimo":"Consignado","investimento|previdencia":"Previdência",
    "lazer|clube":"Clube","lazer|corrida":"Corrida","lazer|férias":"Férias / viagem","lazer|passeios":"Passeios",
    "provisão|manutenção":"Manutenção da casa","provisão|férias":"Férias / viagem","provisão|vestuario":"Vestuário",
    "provisão|meninas":"Meninas",
    "saúde|extra":"Saúde fora do plano","saúde|farmacia":"Farmácia","saúde|farmácia":"Farmácia","saúde|unimed":"Unimed",
    "serviço doméstico|doméstica":"Doméstica – salário","serviço doméstico|esocial":"Doméstica – e-Social",
    "serviço doméstico|extras":"Diarista / jardim / extras","serviço doméstico|jardim":"Diarista / jardim / extras",
    "serviço doméstico|provisão":"Doméstica – provisão","serviço doméstico|transporte":"Doméstica – transporte",
    "supermercado|":"Supermercado","supermercado|supermercado":"Supermercado","supermercado|açougue":"Açougue",
    "supermercado|padaria":"Padaria","supermercado|sacolão":"Sacolão / feira","supermercado|bar/restaurante":"Bar / restaurante",
    "transporte|consórcio":"Consórcio","transporte|gasolina":"Gasolina","transporte|ipva":"IPVA / multas",
    "transporte|manutenção":"Manutenção do carro","transporte|seguro":"Seguro auto","transporte|uber/localiza":"Uber / Localiza"
  };
const CAT_PARA_PL: Record<string, [string, string]> = (() => {
  const m: Record<string, [string, string]> = {};
  Object.entries(MAPA_PLANILHA).forEach(([k, c]) => { const [g, sub] = k.split("|"); if (sub && !m[c]) m[c] = [g, sub]; });
  Object.assign(m, {
    "Supermercado": ["supermercado", "supermercado"], "IPTU": ["casa", "IPTU"], "Água (Copasa)": ["casa", "Água"],
    "Transferências Tâmara": ["diversos", "tâmara"],
    "Salário": ["receita", "salário"], "13º salário": ["receita", "13º salário"], "Rendimentos": ["receita", "rendimentos"],
    "Restituição IR": ["receita", "restituição IR"], "Reembolso e estorno": ["receita", "reembolso"], "Outras receitas": ["receita", "outras"],
    "Aplicação e resgate": ["investimento", "aplicação/resgate"], [CAT_ENTRE]: ["transferência", "entre contas"],
    "Cartão de crédito": ["cartão", "fatura"], "Sem categoria": ["", ""],
  });
  return m;
})();
const pareceBanco = (h: string) => /^(PIX|PAY|RSCSS|RSHOP|RSCCS|DEV PIX|REND|SISPAG|INT |DA |TED|DOC|COR |JUROS|DDA|SAQUE|FATURA|FINANC|CONTRB|TAR|ON |BOLETO|COMPRA|Pix -|Compra com)/i.test(h);
function bancoPL(l: Lanc) {
  const d = String(l.doc || "").trim();
  if (l.origem === "itau") return "itaú";
  if (l.origem === "bb") return "BB";
  if (l.origem === "cartao") return /infinite|altus|bb/i.test(d) ? d : "infinite";
  return d;
}
const tipoPL = (l: Lanc) => l.tipo || (l.data.slice(8, 10) === "01" && !pareceBanco(l.hist) ? "FIXO" : "VARIÁVEL");

function planilhaMes(ls: Lanc[], ym: string): Uint8Array {
  const doMes = ls.filter((l) => !l.ignorado && l.data.slice(0, 7) === ym).sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  const aoa: any[][] = [["◀  VOLTAR AO ÍNDICE"], [], ["", "  LANÇAMENTOS  —  EXTRATO DETALHADO"]];
  for (const l of doMes) {
    const [a, m, d] = l.data.split("-").map(Number);
    const [g, sub] = CAT_PARA_PL[l.categoria] || ["", String(l.categoria || "").toLowerCase()];
    aoa.push(["", Date.UTC(a, m - 1, d) / 864e5 + 25569, l.hist, l.valor, bancoPL(l), g, sub, tipoPL(l), MES_PL[m - 1]]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 4; i <= aoa.length; i++) {
    if (ws["B" + i]) ws["B" + i].z = "dd/mm/yyyy";
    if (ws["D" + i]) ws["D" + i].z = "#,##0.00_);[Red](#,##0.00)";
  }
  ws["!cols"] = [{ wch: 4 }, { wch: 12 }, { wch: 40 }, { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 18 }, { wch: 10 }, { wch: 6 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }, { s: { r: 2, c: 1 }, e: { r: 2, c: 8 } }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "LANÇAMENTOS");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

// ---- texto ----
const reais = (v: number) => "R$ " + Math.round(v).toLocaleString("pt-BR");
const dm = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7);
function hojeSP(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); }
// no dia 1º o mês corrente ainda está vazio: manda o fechamento do mês anterior
function mesDoResumo(hoje: string) {
  const [a, m, d] = hoje.split("-").map(Number);
  if (d > 1) return hoje.slice(0, 7);
  const p = new Date(Date.UTC(a, m - 2, 1)); return p.toISOString().slice(0, 7);
}

function montarTexto(ls: Lanc[], ym: string, hoje: string, link: string | null, nLinhas: number): string {
  const [a, m] = ym.split("-").map(Number);
  const diasMes = new Date(a, m, 0).getDate();
  const dia = ym === hoje.slice(0, 7) ? +hoje.slice(8, 10) : diasMes;
  const val = ls.filter((l) => !l.ignorado && ehMov(l));
  const doMes = val.filter((l) => l.data.slice(0, 7) === ym);
  const r = entSai(doMes);
  const linhas = ["*Financeiro · " + dm(hoje) + "*"];
  const ult = ls.reduce((mx, l) => (l.data <= hoje && l.data > mx ? l.data : mx), "");
  if (ult) {
    const x = entSai(val.filter((l) => l.data === ult));
    linhas.push("Último dia com lançamentos: " + dm(ult) + " — entrou " + reais(x.tE) + ", gastou " + reais(x.tS));
  }
  const nome = MESES[m - 1].charAt(0).toUpperCase() + MESES[m - 1].slice(1);
  linhas.push("", "*" + nome + "*" + (dia < diasMes ? " (dia " + dia + " de " + diasMes + ")" : ""));
  linhas.push("Entrou " + reais(r.tE));
  linhas.push("Gastou " + reais(r.tS));
  linhas.push((r.tE - r.tS < 0 ? "Faltou " : "Sobrou ") + reais(Math.abs(r.tE - r.tS)));
  const top = Object.entries(r.sai).sort((x, y) => y[1] - x[1]).slice(0, 5);
  if (top.length) { linhas.push("", "*Onde mais gastou*"); top.forEach(([c, v]) => linhas.push("• " + c + ": " + reais(v))); }
  const semCat = doMes.filter((l) => l.categoria === "Sem categoria").length;
  if (semCat) linhas.push("", "⚠️ " + semCat + " lançamento" + (semCat === 1 ? "" : "s") + " sem categoria");
  if (link) linhas.push("", "📊 Planilha do mês (" + nLinhas + " lançamentos, formato LANÇAMENTOS):", link);
  return linhas.join("\n");
}

// chave do link: HMAC do mês com o CRON_SECRET (só quem recebeu o link consegue baixar)
async function chaveLink(ym: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("CRON_SECRET") || ""),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("planilha:" + ym)));
  return [...sig.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function lerDados(sb: any) {
  const { data, error } = await sb.from("livro_caixa").select("valor")
    .eq("user_id", Deno.env.get("LC_USER_ID")!).eq("chave", CHAVE).maybeSingle();
  if (error) throw error;
  return data ? (data.valor.lancamentos || []) as Lanc[] : null;
}

async function enviarWhatsApp(texto: string) {
  let fone = (Deno.env.get("WA_TELEFONE") || "").replace(/[^\d+]/g, "");
  if (!fone.startsWith("+")) fone = "+" + fone;
  const url = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(fone) +
    "&text=" + encodeURIComponent(texto) + "&apikey=" + encodeURIComponent((Deno.env.get("CALLMEBOT_APIKEY") || "").trim());
  const r = await fetch(url);
  const bruto = await r.text();
  console.log("CallMeBot", r.status, bruto.slice(0, 2000));
  if (!r.ok) throw new Error("CallMeBot " + r.status);
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY"))!);

    // download da planilha pelo link do WhatsApp
    const pl = q.get("planilha");
    if (pl) {
      if (!/^\d{4}-\d{2}$/.test(pl) || q.get("k") !== await chaveLink(pl)) return new Response("link inválido", { status: 403 });
      const ls = await lerDados(sb);
      if (!ls) return new Response("sem dados", { status: 404 });
      return new Response(planilhaMes(ls, pl), { headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="lancamentos-' + pl + '.xlsx"' } });
    }

    // resumo diário (agendamento)
    if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return new Response("não autorizado", { status: 401 });
    const ls = await lerDados(sb);
    if (!ls) return new Response("sem dados", { status: 404 });
    const hoje = hojeSP(), ym = mesDoResumo(hoje);
    const nLinhas = ls.filter((l) => !l.ignorado && l.data.slice(0, 7) === ym).length;
    const link = nLinhas ? Deno.env.get("SUPABASE_URL") + "/functions/v1/resumo-whatsapp?planilha=" + ym + "&k=" + await chaveLink(ym) : null;

    const texto = q.get("curto") === "1" ? "Teste do Financeiro: envio funcionando." : montarTexto(ls, ym, hoje, link, nLinhas);
    if (q.get("teste") === "1") return new Response(texto, { headers: { "content-type": "text/plain; charset=utf-8" } });
    // @ts-ignore EdgeRuntime existe nas Edge Functions
    EdgeRuntime.waitUntil(enviarWhatsApp(texto).catch((e) => console.error("falha no envio", e)));
    return new Response("Enviando.\n\n" + texto, { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    console.error(e);
    return new Response("erro: " + (e as Error).message, { status: 500 });
  }
});
