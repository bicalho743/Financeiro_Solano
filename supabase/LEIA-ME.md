# Resumo diário no WhatsApp + planilha do mês

Todo dia às 8h (Brasília) o Supabase:
1. monta o resumo do mês (entrou, gastou, sobrou, onde mais gastou);
2. gera a planilha do mês no formato da aba **LANÇAMENTOS** (a mesma do botão *Exportar planilha* do app);
3. manda no WhatsApp o texto com o **link para baixar** a planilha.

O CallMeBot só envia texto, por isso a planilha vai como link. O link aponta para a própria função, que gera a planilha na hora
(sempre com os dados atuais). Ele tem uma chave derivada do `CRON_SECRET`: trocar a senha invalida os links antigos.
No dia 1º o resumo e a planilha são do mês que acabou de fechar.

## 1. CallMeBot (se ainda não ativou)
1. Veja o número atual do bot em https://www.callmebot.com/blog/free-api-whatsapp-messages/ e salve nos contatos.
2. Mande para ele: `I allow callmebot to send me messages`
3. Ele responde com a sua **apikey**.

## 2. Criar a função
Painel do Supabase (projeto `cxdbrmjrwusgzikfyugf`) › **Edge Functions** › *Deploy a new function* › *Via editor*
- Nome: `resumo-whatsapp`
- Cole o conteúdo de `supabase/functions/resumo-whatsapp/index.ts` e clique em *Deploy*.
- Em *Details*, **desligue "Verify JWT"**.

Se já existir uma função `resumo-whatsapp` neste projeto, abra-a, substitua o código e faça *Deploy* de novo.

## 3. Secrets
Edge Functions › **Secrets**:

| Nome | Valor |
|---|---|
| `LC_USER_ID` | seu id em Authentication › Users (UID) |
| `WA_TELEFONE` | `55` + DDD + número, ex: `5531999998888` |
| `CALLMEBOT_APIKEY` | a apikey do passo 1 |
| `CRON_SECRET` | uma senha qualquer |

## 4. Testar
```
curl -H "x-cron-secret: SUA_SENHA" "https://cxdbrmjrwusgzikfyugf.supabase.co/functions/v1/resumo-whatsapp?teste=1"
```
`?teste=1` mostra o texto com o link, sem mandar no WhatsApp (abra o link para conferir a planilha).
Sem o `?teste=1`, envia de verdade.

## 5. Agendar às 8h
SQL Editor (troque a senha):
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'resumo-whatsapp-8h',
  '0 11 * * *',   -- 11h UTC = 8h em Brasília
  $$
  select net.http_post(
    url := 'https://cxdbrmjrwusgzikfyugf.supabase.co/functions/v1/resumo-whatsapp',
    headers := '{"Content-Type":"application/json","x-cron-secret":"SUA_SENHA"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
```
Se já existir um agendamento com esse nome: `select cron.unschedule('resumo-whatsapp-8h');` antes.

## Limites
- O resumo e a planilha só têm o que já foi importado no app.
- Quem tiver o link consegue baixar a planilha do mês; não encaminhe a mensagem.

---

# Cotações automáticas (aba Investimentos)

Ações, FIIs e ETFs vêm da **brapi.dev** por meio da função `cotacoes` (o token fica no Supabase, não no site).
Tesouro Direto vem direto da API pública do Tesouro (preço de resgate do dia). CDB continua com o valor da Posição da B3.

O app atualiza sozinho ao abrir a aba Investimentos e a cada 15 min com ela aberta; o botão **↻ Atualizar cotações** força.
A cotação substitui o preço da Posição da B3 (a quantidade continua vindo da Posição).

## Instalação
1. Edge Functions › *Deploy a new function* › *Via editor* › nome `cotacoes` › cole `supabase/functions/cotacoes/index.ts` › *Deploy*.
   Pode deixar "Verify JWT" ligado: o app chama com o login do usuário.
2. Edge Functions › **Secrets** › `BRAPI_TOKEN` = sua chave da brapi.dev (Dashboard › Sua chave de API).

## Testar
No app, aba Investimentos › **↻ Atualizar cotações**. Aparece "N cotações atualizadas" e, em cada ativo, "cotação dd/mm hh:mm".
Se faltar o secret, o aviso diz "falta o secret BRAPI_TOKEN no Supabase".
