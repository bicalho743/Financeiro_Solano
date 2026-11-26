# Financeiro Solano (orçamento pessoal da família)

Responda em português, passo a passo e sem jargão. Uso pessoal do Solano: previsto × realizado, extratos do Itaú e do
BB, faturas dos cartões (Infinite e Altus), investimentos, IR e contracheques da SEF-MG.
É separado do LIVRO_CAIXA_TAMARA (objetivos diferentes); não misture os dois.

Trabalho no PC: ver bicalho743/meu-enxoval-em-dia/docs/CLAUDE-NO-PC.md (guia de migração para o Claude Code do PC Windows "Notebook_Solano").

## Tipo e ids
- **Site** de um arquivo só (`index.html`, HTML + JavaScript, sem build), instalável no celular como app
  (`manifest.webmanifest`, `sw.js`, `icones/`).
- Publicação: **GitHub Pages** em https://bicalho743.github.io/Financeiro_Solano/ (sai sozinho a cada push na `main`).
- Supabase: projeto `cxdbrmjrwusgzikfyugf`; login com Google; dados na tabela `livro_caixa` (chave
  `financeiro-solano:v1`, JSON inteiro em `valor`) e backup diário em `livro_caixa_backup` (`supabase/backup-diario.sql`).
  Funções: `supabase/functions/cotacoes` (cotações da B3) e `resumo-whatsapp`.
- Não tem bundle, loja, Codemagic, Expo, RevenueCat nem Render.

## Regras do código
- **Toda mudança sobe `const BUILD`** (no topo do script). Os dados guardam o BUILD; uma aba antiga aberta no celular
  recarrega sozinha em vez de gravar por cima. Nunca diminuir o BUILD.
- Mudança que altera dados salvos: migração em `migrar()` que roda uma vez (com marca em `dados`).
- Conferir antes de publicar: extrair o maior `<script>` e rodar `node --check`; abrir no Playwright em 390 px
  (celular) e 1366 px (computador) com o Supabase simulado (dados de teste), sem erros na página.
- Trabalhe numa branch e leve para a `main` por PR (squash), como nos PRs anteriores.

## Onde paramos (26/11/2026)
- **No ar:** BUILD 43 (25/11): consignado em folha entra no realizado e soma ao salário; sem o contracheque do mês,
  usa o último importado. Antes (13/11): abre como app no celular (barra de cima fixa, opções da seção à vista,
  barra de baixo com nomes curtos).
- **Decisão tomada (08/11):** a Previsão do mês NÃO acompanha sozinha todos os gastos variáveis (a tentativa foi
  desfeita a pedido); só as linhas "(média)" e as ligadas ao extrato.
- **Nada em andamento.** Pendências conhecidas: nenhuma.
