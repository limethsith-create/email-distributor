-- Checks for 20261120_03_seat_limits.sql (needs 01 and 02 applied too). Run:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/seat_limits.sql
-- One rolled-back transaction; "ALL SEAT LIMIT CHECKS PASSED" = good.
begin;
create schema t_h; grant usage on schema t_h to public;
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
  execute q; get diagnostics n = row_count;
  return expect is null and n = 0;
exception when others then return expect is null or sqlerrm ilike '%' || expect || '%';
end $$;
grant execute on function t_h.act_as(uuid, text), t_h.fails(text, text) to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@t.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'one@stone.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'two@stone.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'three@stone.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'eli@elm.test');
update public.profiles set role='admin', approved=true where id='00000000-0000-0000-0000-0000000000a1';
-- owner sets plans: stone = starter (2), elm = growth (4)
insert into public.client_seats (client_id, seats) values ('stone', 2), ('elm', 4);
-- owner invites person one, who claims
insert into public.portal_invites (client_id, email, token_hash, expires_at)
  values ('stone', 'one@stone.test', encode(sha256(convert_to('tok1','utf8')),'hex'), now() + interval '7 days');
select t_h.act_as('00000000-0000-0000-0000-0000000000c1', 'one@stone.test');
select public.claim_portal_invite('tok1');
reset role;
do $$ begin assert public.seats_used('stone') = 1, 'one person used'; end $$;

-- the client adds a second person (their own invite): allowed
select t_h.act_as('00000000-0000-0000-0000-0000000000c1', 'one@stone.test');
insert into public.portal_invites (client_id, email, token_hash, expires_at, created_by)
  values ('stone', 'two@stone.test', encode(sha256(convert_to('tok2','utf8')),'hex'), now() + interval '365 days', auth.uid());
do $$ begin
  assert (select count(*) from public.my_people()) = 2, 'my_people lists the person and the waiting invite';
  assert (select count(*) from public.client_seats) = 1, 'client reads only own seats row';
  -- a third is refused: 1 person + 1 waiting invite = 2 of 2
  assert t_h.fails($q$insert into public.portal_invites (client_id, email, token_hash, expires_at, created_by)
     values ('stone','x@stone.test','h3', now()+interval '1 day', auth.uid())$q$, 'reached the limit for your plan (2 people)'), 'limit on invite';
  -- not for another client, not as someone else, not seats
  assert t_h.fails($q$insert into public.portal_invites (client_id, email, token_hash, expires_at, created_by)
     values ('elm','x@elm.test','h4', now()+interval '1 day', auth.uid())$q$), 'other client refused';
  assert t_h.fails($q$update public.client_seats set seats = 50$q$), 'client cannot raise own limit';
  assert t_h.fails($q$insert into public.client_seats values ('stone', 9)$q$), 'client cannot write seats';
  assert t_h.fails($q$select * from public.portal_invites$q$) or (select count(*) from public.portal_invites) = 0, 'client cannot read invites';
end $$;
reset role;
-- the client's invite was shortened to 14 days and credited to them
do $$ begin
  assert (select expires_at < now() + interval '15 days' and created_by = '00000000-0000-0000-0000-0000000000c1' from public.portal_invites where email = 'two@stone.test'), 'expiry clamped';
end $$;

-- the second person claims: fine (their invite was counted); a team-less third claim cannot sneak in
select t_h.act_as('00000000-0000-0000-0000-0000000000c2', 'two@stone.test');
select public.claim_portal_invite('tok2');
reset role;
do $$ begin assert public.seats_used('stone') = 2, 'two used'; end $$;
-- owner can't exceed either, until the limit is raised
select t_h.act_as('00000000-0000-0000-0000-0000000000a1', 'owner@t.test');
do $$ begin
  assert t_h.fails($q$insert into public.portal_invites (client_id, email, token_hash, expires_at) values ('stone','three@stone.test','h5', now()+interval '1 day')$q$, 'reached the limit'), 'owner invite beyond limit';
end $$;
update public.client_seats set seats = 4 where client_id = 'stone';
insert into public.portal_invites (client_id, email, token_hash, expires_at) values ('stone','three@stone.test',encode(sha256(convert_to('tok3','utf8')),'hex'), now()+interval '1 day');
-- lower the limit again, then the claim itself is refused
update public.client_seats set seats = 2 where client_id = 'stone';
select t_h.act_as('00000000-0000-0000-0000-0000000000c3', 'three@stone.test');
do $$ begin assert t_h.fails($q$select public.claim_portal_invite('tok3')$q$, 'reached the limit'), 'claim beyond limit'; end $$;
reset role;
do $$ begin assert (select role from public.profiles where id='00000000-0000-0000-0000-0000000000c3') = 'employee', 'still not a client'; end $$;
-- expired invites do not count
update public.portal_invites set expires_at = now() - interval '1 day' where email = 'three@stone.test';
do $$ begin assert public.seats_used('stone') = 2, 'expired not counted'; end $$;
-- a client with no seats row is not limited; a non-client cannot invite
select t_h.act_as('00000000-0000-0000-0000-0000000000e1', 'eli@elm.test');
do $$ begin assert t_h.fails($q$insert into public.portal_invites (client_id, email, token_hash, expires_at, created_by) values ('elm','y@elm.test','h6', now()+interval '1 day', auth.uid())$q$), 'non-client cannot invite'; end $$;
reset role;
select 'ALL SEAT LIMIT CHECKS PASSED' as result;
rollback;
