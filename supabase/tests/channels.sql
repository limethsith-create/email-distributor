-- Checks for 20261120_02_channels.sql. Run against a database that has BOTH 20261120 migrations applied
-- (a local or branch database, never the live one):   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/channels.sql
-- Everything runs in one transaction and is rolled back at the end. Any failed check raises an error.
begin;

create schema chtest;  -- scratch schema, rolled back at the end

create function chtest.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok: %', what;
end $$;

-- Pretend to be a signed-in user (call before "set local role authenticated").
create function chtest.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true),
         set_config('request.jwt.claim.sub', u::text, true);
$$;
grant usage on schema chtest to authenticated;
grant execute on function chtest.check(boolean, text), chtest.as_user(uuid) to authenticated;

-- ---------------------------------------------------------------- people
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'staff@test.invalid'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'client-a@test.invalid'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'client-b@test.invalid')
on conflict (id) do nothing;
-- (handle_new_user may already have made profiles; make sure they exist, then set roles.)
insert into public.profiles (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'staff@test.invalid'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'client-a@test.invalid'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'client-b@test.invalid')
on conflict (id) do nothing;
update public.profiles set role = 'admin', approved = true where id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- Staff create both client channels.
select chtest.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set local role authenticated;
create temp table ids as
  select public.ensure_client_channel('test-client-a', 'Client A') as a,
         public.ensure_client_channel('test-client-b', 'Client B') as b;
grant select on ids to authenticated;
select chtest.check((select a <> b from ids), 'staff can create two client channels');
select chtest.check(public.ensure_client_channel('test-client-a', 'Client A') = (select a from ids), 'ensure_client_channel is repeatable (same channel back)');
reset role;

-- The clients join (the profiles trigger puts them in their own client channel).
update public.profiles set role = 'client', approved = true, client_id = 'test-client-a' where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
update public.profiles set role = 'client', approved = true, client_id = 'test-client-b' where id = 'aaaaaaaa-0000-0000-0000-00000000000b';
select chtest.check(exists (select 1 from public.channel_members m, ids where m.channel_id = ids.a and m.user_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 'client A was added to channel A when they joined');
select chtest.check(not exists (select 1 from public.channel_members m, ids where m.channel_id = ids.a and m.user_id = 'aaaaaaaa-0000-0000-0000-00000000000b'), 'client B is not in channel A');

-- Seed one message and one file per channel (as the staff member).
select chtest.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set local role authenticated;
insert into public.messages (channel_id, user_id, body) select a, 'aaaaaaaa-0000-0000-0000-000000000001', 'hello A' from ids;
insert into public.messages (channel_id, user_id, body) select b, 'aaaaaaaa-0000-0000-0000-000000000001', 'hello B' from ids;
insert into storage.objects (bucket_id, name, owner_id) select 'chat-files', a || '/11111111-file-a.txt', 'aaaaaaaa-0000-0000-0000-000000000001' from ids;
insert into storage.objects (bucket_id, name, owner_id) select 'chat-files', b || '/22222222-file-b.txt', 'aaaaaaaa-0000-0000-0000-000000000001' from ids;
select chtest.check((select count(*) from public.channels where client_id like 'test-client-%') = 2, 'staff see every client channel');
select chtest.check((select count(*) from public.messages m, ids where m.channel_id in (ids.a, ids.b)) = 2, 'staff see every message');
select chtest.check((select count(*) from storage.objects where bucket_id = 'chat-files' and name like '%-file-%') = 2, 'staff see every file');
select chtest.check((select count(*) from public.my_channels() where client_id like 'test-client-%') = 2, 'my_channels lists both for staff');
reset role;

-- (Inside one transaction now() never moves, so make the members' last read clearly earlier.)
update public.channel_members set last_read_at = now() - interval '1 hour';

-- ---------------------------------------------------------------- client A
select chtest.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
set local role authenticated;
select chtest.check((select count(*) from public.channels where kind = 'client') = 1, 'client A sees exactly one client channel');
select chtest.check(not exists (select 1 from public.channels c, ids where c.id = ids.b), 'client A cannot read channel B');
select chtest.check(not exists (select 1 from public.messages m, ids where m.channel_id = ids.b), 'client A cannot read channel B messages');
select chtest.check(exists (select 1 from public.messages m, ids where m.channel_id = ids.a and m.body = 'hello A'), 'client A reads their own channel messages');
select chtest.check((select count(*) from storage.objects where bucket_id = 'chat-files' and name like '%-file-%') = 1, 'client A sees only their own file');
select chtest.check(not exists (select 1 from storage.objects, ids where bucket_id = 'chat-files' and name like ids.b || '/%'), 'client A cannot see channel B files');
select chtest.check((select unread from public.my_channels() limit 1) = 1, 'client A has 1 unread message');
select public.mark_channel_read(a) from ids;
select chtest.check((select unread from public.my_channels() limit 1) = 0, 'marking read clears unread');
select chtest.check(not exists (select 1 from public.channel_members m, ids where m.channel_id = ids.b), 'client A cannot list channel B members');

do $$
declare cb uuid; ok boolean;
begin
  select b into cb from ids;
  -- cannot post into B
  ok := false;
  begin insert into public.messages (channel_id, user_id, body) values (cb, 'aaaaaaaa-0000-0000-0000-00000000000a', 'sneaky');
  exception when others then ok := true; end;
  perform chtest.check(ok, 'client A cannot post in channel B');
  -- cannot upload into B
  ok := false;
  begin insert into storage.objects (bucket_id, name, owner_id) values ('chat-files', cb || '/33333333-x.txt', 'aaaaaaaa-0000-0000-0000-00000000000a');
  exception when others then ok := true; end;
  perform chtest.check(ok, 'client A cannot upload into channel B');
  -- cannot post as someone else
  ok := false;
  begin insert into public.messages (channel_id, user_id, body) select a, 'aaaaaaaa-0000-0000-0000-000000000001', 'forged' from ids;
  exception when others then ok := true; end;
  perform chtest.check(ok, 'client A cannot post as another person');
  -- cannot create channels, rename, add members
  ok := false;
  begin insert into public.channels (name, kind) values ('mine', 'team'); exception when others then ok := true; end;
  perform chtest.check(ok, 'a client cannot create a channel');
  ok := false;
  begin insert into public.channel_members (channel_id, user_id) select b, 'aaaaaaaa-0000-0000-0000-00000000000a' from ids; exception when others then ok := true; end;
  perform chtest.check(ok, 'a client cannot add themselves to a channel');
  update public.channels set name = 'hacked' where id = (select a from ids);
  perform chtest.check(not exists (select 1 from public.channels where name = 'hacked'), 'a client cannot rename a channel');
  begin perform public.ensure_client_channel('test-client-c', 'C'); ok := false; exception when others then ok := true; end;
  perform chtest.check(ok, 'a client cannot run ensure_client_channel');
end $$;

-- own messages: post, edit, soft-delete; not someone else's
insert into public.messages (channel_id, user_id, body) select a, 'aaaaaaaa-0000-0000-0000-00000000000a', 'from client A' from ids;
update public.messages set body = 'edited', edited_at = now() where body = 'from client A';
select chtest.check(exists (select 1 from public.messages where body = 'edited'), 'client A can edit their own message');
update public.messages set body = 'tampered' where body = 'hello A';
select chtest.check(not exists (select 1 from public.messages where body = 'tampered'), 'client A cannot edit staff messages');
update public.messages set deleted_at = now() where body = 'hello A';
select chtest.check(exists (select 1 from public.messages where body = 'hello A' and deleted_at is null), 'client A cannot delete staff messages');
update public.messages set deleted_at = now() where body = 'edited';
select chtest.check(exists (select 1 from public.messages where body = 'edited' and deleted_at is not null), 'client A can delete (soft) their own message');
do $$
declare ok boolean := false;
begin
  begin delete from public.messages where body = 'edited'; exception when others then ok := true; end;
  perform chtest.check(ok or not exists (select 1 from public.messages where body is null), 'hard delete is not allowed');
end $$;
reset role;
select chtest.check(exists (select 1 from public.messages where body = 'edited'), 'the hard delete did not remove the row');

-- ---------------------------------------------------------------- the staff member edits only their own too
select chtest.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set local role authenticated;
update public.messages set body = 'staff changed it' where body = 'edited';
select chtest.check(not exists (select 1 from public.messages where body = 'staff changed it'), 'staff cannot edit a client message');
reset role;

-- ---------------------------------------------------------------- archived channel
select chtest.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set local role authenticated;
update public.channels set archived_at = now() where id = (select a from ids);
select chtest.check((select count(*) from public.messages m, ids where m.channel_id = ids.a) >= 2, 'staff still read an archived channel');
do $$
declare ok boolean := false;
begin
  begin insert into public.messages (channel_id, user_id, body) select a, 'aaaaaaaa-0000-0000-0000-000000000001', 'into archive' from ids;
  exception when others then ok := true; end;
  perform chtest.check(ok, 'staff cannot post in an archived channel');
end $$;
reset role;

select chtest.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
set local role authenticated;
do $$
declare ok boolean := false;
begin
  begin insert into public.messages (channel_id, user_id, body) select a, 'aaaaaaaa-0000-0000-0000-00000000000a', 'into archive' from ids;
  exception when others then ok := true; end;
  perform chtest.check(ok, 'client A cannot post in an archived channel');
  perform chtest.check(not exists (select 1 from public.messages m, ids where m.channel_id = ids.a), 'client A cannot read an archived channel');
  perform chtest.check(not exists (select 1 from public.my_channels() c, ids where c.id = ids.a), 'an archived channel is not listed for the client');
  ok := false;
  begin insert into storage.objects (bucket_id, name, owner_id) select 'chat-files', a || '/44444444-late.txt', 'aaaaaaaa-0000-0000-0000-00000000000a' from ids;
  exception when others then ok := true; end;
  perform chtest.check(ok, 'client A cannot upload into an archived channel');
end $$;
reset role;

select chtest.check(true, 'ALL CHANNEL CHECKS PASSED');
rollback;
