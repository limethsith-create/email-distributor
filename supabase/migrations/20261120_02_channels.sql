-- Channels: team chat for Aviance staff and one chat channel per client (the client sees only their own).
-- Runs AFTER 20261120_01_client_accounts.sql, which defines is_staff(), my_client_id() and profiles.client_id.
-- Those two functions are used here and never redefined. Safe to run more than once.

-- ============================================================ tables
create table if not exists public.channels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null check (kind in ('client','team')),
  client_id   text null,
  created_by  uuid null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz null
);
comment on table public.channels is 'A chat channel. kind=client is the one shared with a single client; kind=team is staff only (unless staff add someone).';

-- one channel per client
create unique index if not exists channels_one_per_client on public.channels (client_id) where kind = 'client';

create table if not exists public.channel_members (
  channel_id   uuid not null references public.channels(id) on delete cascade,
  user_id      uuid not null,
  role         text not null default 'member',
  added_at     timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
comment on table public.channel_members is 'Who belongs to a channel, and when they last read it (drives the unread count).';
create index if not exists channel_members_user on public.channel_members (user_id);

create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.channels(id) on delete cascade,
  user_id     uuid not null,
  body        text not null default '' check (length(body) <= 8000),
  attachments jsonb not null default '[]'::jsonb
              check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 5),
  created_at  timestamptz not null default now(),
  edited_at   timestamptz null,
  deleted_at  timestamptz null
);
comment on table public.messages is 'Chat messages. Deleting is soft (deleted_at); attachments are {path,name,size,type} in the chat-files bucket.';
create index if not exists messages_channel_time on public.messages (channel_id, created_at desc);

alter table public.channels         enable row level security;
alter table public.channel_members  enable row level security;
alter table public.messages         enable row level security;

-- ============================================================ who can see / post
-- Staff see every channel. A client sees their own client channel, plus any channel they were added to.
create or replace function public.can_see_channel(c uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    auth.uid() is not null and (
      public.is_staff()
      or exists (select 1 from public.channels ch
                  where ch.id = c and ch.kind = 'client' and ch.client_id is not null
                    and ch.client_id = public.my_client_id())
      or exists (select 1 from public.channel_members m
                  where m.channel_id = c and m.user_id = auth.uid())
    ), false);
$$;

-- Posting needs the same access, and the channel must not be archived.
create or replace function public.can_post_channel(c uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.can_see_channel(c)
     and exists (select 1 from public.channels ch where ch.id = c and ch.archived_at is null);
$$;

-- ============================================================ client channel set-up
-- Internal: creates the client's channel if missing and adds the right people. No permission check,
-- so it is NOT callable by app users (only by the functions/triggers below).
create or replace function public._client_channel(p_client_id text, p_name text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare cid uuid;
begin
  if p_client_id is null or length(trim(p_client_id)) = 0 then
    raise exception 'A client is needed to set up a channel.';
  end if;
  insert into public.channels (name, kind, client_id)
  values (coalesce(nullif(trim(p_name), ''), p_client_id), 'client', p_client_id)
  on conflict (client_id) where kind = 'client' do nothing;
  select id into cid from public.channels where kind = 'client' and client_id = p_client_id;
  insert into public.channel_members (channel_id, user_id)
  select cid, p.id from public.profiles p
   where p.approved = true
     and (p.role in ('admin','employee') or (p.role = 'client' and p.client_id = p_client_id))
  on conflict (channel_id, user_id) do nothing;
  return cid;
end;
$$;

create or replace function public.ensure_client_channel(p_client_id text, p_name text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Only Aviance staff can set up a client channel.';
  end if;
  return public._client_channel(p_client_id, p_name);
end;
$$;

-- When a profile gets a client_id (the client joined through their invite), put them in their client channel.
create or replace function public.channels_on_profile_client()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.client_id is not null and (tg_op = 'INSERT' or old.client_id is distinct from new.client_id) then
    perform public._client_channel(new.client_id, new.client_id);
    insert into public.channel_members (channel_id, user_id)
    select ch.id, new.id from public.channels ch where ch.kind = 'client' and ch.client_id = new.client_id
    on conflict (channel_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_join_client_channel on public.profiles;
create trigger profiles_join_client_channel
  after insert or update of client_id on public.profiles
  for each row when (new.client_id is not null)
  execute function public.channels_on_profile_client();

-- ============================================================ lists, unread, names
create or replace function public.my_channels()
returns table (id uuid, name text, kind text, client_id text, archived_at timestamptz, last_message_at timestamptz, unread int)
language sql stable security invoker
set search_path = public
as $$
  select c.id, c.name, c.kind, c.client_id, c.archived_at,
         (select max(m.created_at) from public.messages m where m.channel_id = c.id and m.deleted_at is null),
         (select count(*)::int from public.messages m
           where m.channel_id = c.id and m.deleted_at is null and m.user_id <> auth.uid()
             and m.created_at > coalesce(cm.last_read_at, c.created_at))
    from public.channels c
    left join public.channel_members cm on cm.channel_id = c.id and cm.user_id = auth.uid()
   where public.can_see_channel(c.id) and (public.is_staff() or c.archived_at is null)
   order by 6 desc nulls last, c.name;
$$;

-- Mark a channel read for the caller (adds their member row if they only see it through their role).
create or replace function public.mark_channel_read(c uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.can_see_channel(c) then
    raise exception 'You do not have access to that channel.';
  end if;
  insert into public.channel_members (channel_id, user_id, last_read_at)
  values (c, auth.uid(), now())
  on conflict (channel_id, user_id) do update set last_read_at = now();
end;
$$;

-- Display names for people the caller can already see in chat (never exposes emails).
create or replace function public.channel_people(p_ids uuid[])
returns table (id uuid, name text, role text)
language sql stable security definer
set search_path = public
as $$
  select p.id, coalesce(nullif(trim(p.name), ''), nullif(split_part(p.email, '@', 1), ''), 'Someone'), p.role
    from public.profiles p
   where auth.uid() is not null
     and p.id = any(p_ids)
     and ( p.id = auth.uid()
        or public.is_staff()
        or exists (select 1 from public.channel_members m where m.user_id = p.id and public.can_see_channel(m.channel_id))
        or exists (select 1 from public.messages g where g.user_id = p.id and public.can_see_channel(g.channel_id)) );
$$;

-- ============================================================ row level security
-- Table grants: only the columns that may change can be updated.
revoke update on public.channels        from authenticated, anon;
revoke update on public.channel_members from authenticated, anon;
revoke update on public.messages        from authenticated, anon;
revoke all    on public.channels, public.channel_members, public.messages from anon;
grant select, insert on public.channels        to authenticated;
grant select, insert, delete on public.channel_members to authenticated;
grant select, insert on public.messages        to authenticated;
grant update (name, archived_at) on public.channels        to authenticated;
grant update (last_read_at)      on public.channel_members to authenticated;
grant update (body, attachments, edited_at, deleted_at) on public.messages to authenticated;

drop policy if exists channels_select on public.channels;
create policy channels_select on public.channels for select to authenticated
  using (public.can_see_channel(id));
drop policy if exists channels_insert on public.channels;
create policy channels_insert on public.channels for insert to authenticated
  with check (public.is_staff());
drop policy if exists channels_update on public.channels;
create policy channels_update on public.channels for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists members_select on public.channel_members;
create policy members_select on public.channel_members for select to authenticated
  using (public.can_see_channel(channel_id));
drop policy if exists members_insert on public.channel_members;
create policy members_insert on public.channel_members for insert to authenticated
  with check (public.is_staff());
drop policy if exists members_delete on public.channel_members;
create policy members_delete on public.channel_members for delete to authenticated
  using (public.is_staff());
drop policy if exists members_update_own on public.channel_members;
create policy members_update_own on public.channel_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Clients never read messages of an archived channel; staff still can.
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (public.can_see_channel(channel_id)
         and (public.is_staff() or exists (select 1 from public.channels ch where ch.id = channel_id and ch.archived_at is null)));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.can_post_channel(channel_id));
-- Edit or soft-delete: only your own messages (delete = set deleted_at).
drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages for update to authenticated
  using (user_id = auth.uid() and public.can_post_channel(channel_id))
  with check (user_id = auth.uid() and public.can_post_channel(channel_id));

-- ============================================================ function permissions
revoke all on function public._client_channel(text, text) from public, anon, authenticated;
revoke all on function public.channels_on_profile_client() from public, anon, authenticated;
revoke all on function public.can_see_channel(uuid)        from public, anon;
revoke all on function public.can_post_channel(uuid)       from public, anon;
revoke all on function public.ensure_client_channel(text, text) from public, anon;
revoke all on function public.my_channels()                from public, anon;
revoke all on function public.mark_channel_read(uuid)      from public, anon;
revoke all on function public.channel_people(uuid[])       from public, anon;
grant execute on function public.can_see_channel(uuid)        to authenticated;
grant execute on function public.can_post_channel(uuid)       to authenticated;
grant execute on function public.ensure_client_channel(text, text) to authenticated;
grant execute on function public.my_channels()                to authenticated;
grant execute on function public.mark_channel_read(uuid)      to authenticated;
grant execute on function public.channel_people(uuid[])       to authenticated;

-- ============================================================ files (private bucket)
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

-- First folder of a file path is the channel id: chat-files/{channel_id}/{uuid}-{name}
create or replace function public.chat_file_channel(p_name text)
returns uuid
language sql immutable
as $$
  select case when split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end;
$$;
grant execute on function public.chat_file_channel(text) to authenticated;

drop policy if exists "chat files read" on storage.objects;
create policy "chat files read" on storage.objects for select to authenticated
  using (bucket_id = 'chat-files' and public.can_see_channel(public.chat_file_channel(name)));
drop policy if exists "chat files upload" on storage.objects;
create policy "chat files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.can_post_channel(public.chat_file_channel(name)));
drop policy if exists "chat files remove" on storage.objects;
create policy "chat files remove" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-files'
         and public.can_see_channel(public.chat_file_channel(name))
         and (public.is_staff() or owner_id = auth.uid()::text));

-- ============================================================ realtime
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['messages','channels','channel_members'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
