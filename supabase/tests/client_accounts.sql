-- Checks for 20261120_01_client_accounts.sql. Run against a database that has the migration applied (a branch / local stack):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/client_accounts.sql
-- Everything happens in one transaction that is rolled back; any failed check raises an error and stops. "ALL CLIENT ACCOUNT CHECKS PASSED" at the end = good.
begin;

create schema t_h;
grant usage on schema t_h to public;

-- act as a signed-in user for the rest of the transaction (or as the server when uid is null)
create or replace function t_h.act_as(uid uuid, mail text) returns void language plpgsql as $$
begin
  reset role;
  if uid is null then return; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'email', mail, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('request.jwt.claim.email', mail, true);
  set local role authenticated;
end $$;
create or replace function t_h.fails(q text, expect text default null) returns boolean language plpgsql as $$
declare n bigint;
begin
  execute q;
  get diagnostics n = row_count;
  return expect is null and n = 0;   -- row security hid the row: nothing changed, which is a refusal too
exception when others then
  return expect is null or sqlerrm ilike '%' || expect || '%';
end $$;
-- run a statement that must not succeed: an error and "0 rows changed" both count as refused (checked afterwards)
create or replace function t_h.try(q text) returns void language plpgsql as $$
begin execute q; exception when others then null; end $$;
grant execute on function t_h.act_as(uuid, text), t_h.fails(text, text), t_h.try(text) to public;

-- people: owner (admin), a team member, two would-be clients, a stranger
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@t.test', '{"name":"Owner"}'),
  ('00000000-0000-0000-0000-0000000000b1', 'team@t.test',  '{"name":"Team","role":"admin","client_id":"x","approved":true}'),
  ('00000000-0000-0000-0000-0000000000c1', 'dana@stone.test', '{"name":"Dana","role":"client"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'other@elm.test',  '{"name":"Eli"}'),
  ('00000000-0000-0000-0000-0000000000d1', 'nobody@t.test',   '{"name":"Nobody"}');

do $$ begin
  -- sign-up ignores metadata: unapproved employee, no client id
  assert (select count(*) from public.profiles where id::text like '00000000-0000-0000-0000-0000000000%' and role = 'employee' and approved is false and client_id is null) = 5,
    'sign-up must always make an unapproved employee';
end $$;

-- the server (no user) makes the owner an approved admin and the team member an approved employee
update public.profiles set role = 'admin', approved = true where id = '00000000-0000-0000-0000-0000000000a1';
update public.profiles set approved = true where id = '00000000-0000-0000-0000-0000000000b1';

do $$ begin
  perform t_h.act_as('00000000-0000-0000-0000-0000000000a1', 'owner@t.test');
  assert public.is_admin() and public.is_staff() and public.is_approved(), 'owner is admin and staff';
  perform t_h.act_as('00000000-0000-0000-0000-0000000000b1', 'team@t.test');
  assert not public.is_admin() and public.is_staff() and public.is_approved(), 'employee is staff, not admin';
  assert public.my_client_id() is null, 'employee has no client id';
  perform t_h.act_as('00000000-0000-0000-0000-0000000000d1', 'nobody@t.test');
  assert not public.is_staff() and not public.is_approved(), 'unapproved is not staff';
  reset role;
end $$;

-- a self sign-up cannot promote itself (refused: either an error or nothing changes)
do $$ begin
  perform t_h.act_as('00000000-0000-0000-0000-0000000000d1', 'nobody@t.test');
  perform t_h.try($q$update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000d1'$q$);
  perform t_h.try($q$update public.profiles set approved = true where id = '00000000-0000-0000-0000-0000000000d1'$q$);
  perform t_h.try($q$update public.profiles set role = 'client', client_id = 'stone-roofing' where id = '00000000-0000-0000-0000-0000000000d1'$q$);
  reset role;
  assert (select role = 'employee' and approved is false and client_id is null from public.profiles where id = '00000000-0000-0000-0000-0000000000d1'), 'self -> admin / approve / client must all be refused';
end $$;

-- invites: only the owner can read or write them
do $$
declare v_hash text := encode(sha256(convert_to('tok-dana-1234567890', 'utf8')), 'hex');
begin
  perform t_h.act_as('00000000-0000-0000-0000-0000000000a1', 'owner@t.test');
  insert into public.portal_invites (client_id, email, token_hash, created_by, expires_at)
    values ('stone-roofing', 'Dana@Stone.test', v_hash, '00000000-0000-0000-0000-0000000000a1', now() + interval '14 days');
  insert into public.portal_invites (client_id, email, token_hash, expires_at) values ('stone-roofing', 'old@stone.test', encode(sha256(convert_to('tok-expired', 'utf8')), 'hex'), now() - interval '1 day');
  assert (select count(*) from public.portal_invites) = 2, 'owner sees invites';
  perform t_h.act_as('00000000-0000-0000-0000-0000000000b1', 'team@t.test');
  assert (select count(*) from public.portal_invites) = 0, 'employee sees no invites';
  assert t_h.fails($q$insert into public.portal_invites (client_id, email, token_hash, expires_at) values ('x','y@z.test','h', now() + interval '1 day')$q$), 'employee cannot make invites';
  perform t_h.act_as('00000000-0000-0000-0000-0000000000c1', 'dana@stone.test');
  assert (select count(*) from public.portal_invites) = 0, 'invitee cannot read invites';
  reset role;
end $$;

-- claiming
do $$
declare r text;
begin
  -- wrong person, wrong token, expired token, nobody signed in
  perform t_h.act_as('00000000-0000-0000-0000-0000000000c2', 'other@elm.test');
  assert t_h.fails($q$select public.claim_portal_invite('tok-dana-1234567890')$q$, 'not valid any more'), 'someone else''s email must not claim';
  perform t_h.act_as('00000000-0000-0000-0000-0000000000c1', 'dana@stone.test');
  assert t_h.fails($q$select public.claim_portal_invite('wrong-token')$q$, 'not valid any more'), 'wrong token';
  assert t_h.fails($q$select public.claim_portal_invite('')$q$, 'not valid any more'), 'empty token';
  reset role;
  perform t_h.act_as('00000000-0000-0000-0000-0000000000a1', 'owner@t.test');
  update public.portal_invites set email = 'dana@stone.test' where token_hash = encode(sha256(convert_to('tok-expired', 'utf8')), 'hex');
  perform t_h.act_as('00000000-0000-0000-0000-0000000000c1', 'dana@stone.test');
  assert t_h.fails($q$select public.claim_portal_invite('tok-expired')$q$, 'not valid any more'), 'expired';
  -- an approved team account is never turned into a client
  perform t_h.act_as('00000000-0000-0000-0000-0000000000b1', 'team@t.test');
  assert t_h.fails($q$select public.claim_portal_invite('tok-dana-1234567890')$q$), 'team account cannot claim';
  -- the right person, email compared without case
  perform t_h.act_as('00000000-0000-0000-0000-0000000000c1', 'dana@stone.test');
  r := public.claim_portal_invite('tok-dana-1234567890');
  assert r = 'stone-roofing', 'claim returns the client id';
  assert public.my_client_id() = 'stone-roofing', 'now a client';
  assert not public.is_staff() and not public.is_approved() and not public.is_admin(), 'a client is not staff';
  -- one use only
  assert t_h.fails($q$select public.claim_portal_invite('tok-dana-1234567890')$q$, 'not valid any more'), 'second use';
  -- a client cannot change their own role, approval or client id, nor see other profiles
  assert t_h.fails($q$update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000c1'$q$), 'client -> admin must fail';
  assert t_h.fails($q$update public.profiles set client_id = 'elm-dental' where id = '00000000-0000-0000-0000-0000000000c1'$q$), 'client cannot switch client';
  assert t_h.fails($q$update public.profiles set approved = false where id = '00000000-0000-0000-0000-0000000000c1'$q$), 'client cannot unapprove';
  assert (select count(*) from public.profiles) = 1, 'client sees only their own profile';
  assert t_h.fails($q$delete from public.profiles where id = '00000000-0000-0000-0000-0000000000c1'$q$) or (select count(*) from public.profiles) = 1, 'client cannot delete';
  reset role;
  assert (select role || '/' || approved::text || '/' || client_id from public.profiles where id = '00000000-0000-0000-0000-0000000000c1') = 'client/true/stone-roofing';
  assert (select used_by from public.portal_invites where token_hash = encode(sha256(convert_to('tok-dana-1234567890', 'utf8')), 'hex')) = '00000000-0000-0000-0000-0000000000c1';
end $$;

-- the owner still manages people (approve an employee, as the hub does)
do $$ begin
  perform t_h.act_as('00000000-0000-0000-0000-0000000000a1', 'owner@t.test');
  update public.profiles set approved = true, role = 'employee' where id = '00000000-0000-0000-0000-0000000000d1';
  reset role;
  assert (select approved from public.profiles where id = '00000000-0000-0000-0000-0000000000d1') is true;
end $$;

select 'ALL CLIENT ACCOUNT CHECKS PASSED' as result;
rollback;
