-- Backup diário do Financeiro (e de qualquer app que grave em livro_caixa).
-- Rodar uma vez no Supabase › SQL Editor. Pode rodar de novo sem problema.
-- Todo dia às 3h (Brasília) copia cada linha de livro_caixa para livro_caixa_backup.
-- Mantém os últimos 30 dias e, para sempre, o backup do dia 1º de cada mês.

create extension if not exists pg_cron;

create table if not exists public.livro_caixa_backup (
  id            bigserial primary key,
  user_id       uuid        not null,
  chave         text        not null,
  dia           date        not null,
  valor         jsonb       not null,
  atualizado_em timestamptz,
  criado_em     timestamptz not null default now(),
  unique (user_id, chave, dia)
);

-- só o dono lê os próprios backups; ninguém grava pelo app (só a rotina do banco)
alter table public.livro_caixa_backup enable row level security;
drop policy if exists "le os proprios backups" on public.livro_caixa_backup;
create policy "le os proprios backups" on public.livro_caixa_backup
  for select using (auth.uid() = user_id);

create or replace function public.backup_livro_caixa() returns integer
language plpgsql security definer set search_path = public as $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  n integer;
begin
  insert into livro_caixa_backup (user_id, chave, dia, valor, atualizado_em)
  select user_id, chave, hoje, valor::jsonb, atualizado_em from livro_caixa
  on conflict (user_id, chave, dia)
    do update set valor = excluded.valor, atualizado_em = excluded.atualizado_em, criado_em = now();
  get diagnostics n = row_count;
  delete from livro_caixa_backup where dia < hoje - 30 and extract(day from dia) <> 1;
  return n;
end $$;
revoke execute on function public.backup_livro_caixa() from public, anon, authenticated;

-- agenda: 6h UTC = 3h em Brasília (reagenda se já existir)
select cron.unschedule(jobid) from cron.job where jobname = 'backup-livro-caixa';
select cron.schedule('backup-livro-caixa', '0 6 * * *', $$ select public.backup_livro_caixa(); $$);

-- primeiro backup agora (mostra quantas linhas copiou)
select public.backup_livro_caixa();
