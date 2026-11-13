-- =====================================================================
-- Dismissal Magic — one school per account
--
--   * New accounts can create 1 school.
--   * You can raise the limit for one account (a district contact, or
--     yourself for testing) by changing its school_limit:
--       update bus_accounts set school_limit = 5
--       where user_id = (select id from auth.users where email = 'someone@district.org');
--   * Allyn's account (allyn@stemstarters.com) is set to 10 for testing.
--   * Schools that already exist are never removed; this only affects
--     creating new ones.
--
-- Run once in Supabase → SQL Editor, after 01–04. Safe to run again.
-- =====================================================================

alter table public.bus_accounts add column if not exists school_limit int not null default 1;

-- Your own account: room for test schools.
insert into public.bus_accounts (user_id, trial_ends_at, school_limit)
select id, now() + interval '30 days', 10 from auth.users where lower(email) = 'allyn@stemstarters.com'
on conflict (user_id) do update set school_limit = greatest(public.bus_accounts.school_limit, 10);


-- Create a school: signed in, within this account's limit, and starts the
-- account's one free trial the first time.
create or replace function public.bus_create_school_owned(p_settings jsonb, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_limit int;
  r jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;

  perform pg_advisory_xact_lock(hashtext('bus_owner:' || v_uid::text));
  v_limit := coalesce((select school_limit from public.bus_accounts where user_id = v_uid), 1);
  if (select count(*) from public.bus_school_owners where user_id = v_uid) >= v_limit then
    return jsonb_build_object('ok', false, 'error', 'school_limit', 'limit', v_limit);
  end if;

  r := public.bus_create_school(p_settings, p_pin)::jsonb;

  if coalesce((r->>'ok')::boolean, false) and r ? 'code' then
    insert into public.bus_school_owners (code, user_id)
    values (r->>'code', v_uid)
    on conflict (code) do nothing;

    insert into public.bus_accounts (user_id, trial_ends_at)
    values (v_uid, now() + interval '30 days')
    on conflict (user_id) do nothing;     -- one trial per account, ever
  end if;

  return r;
end $$;

revoke execute on function public.bus_create_school_owned(jsonb, text) from public, anon;
grant  execute on function public.bus_create_school_owned(jsonb, text) to authenticated;


-- My schools: also tells the app this account's limit.
create or replace function public.bus_my_schools()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  o record;
  s jsonb;
  out jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;

  for o in
    select code, created_at from public.bus_school_owners
    where user_id = v_uid
    order by created_at
  loop
    s := public.bus_get_school(o.code)::jsonb;
    if s is not null and jsonb_typeof(s) = 'object' then
      out := out || jsonb_build_array(jsonb_build_object(
        'code',   o.code,
        'name',   s->'settings'->>'name',
        'since',  o.created_at,
        'access', public.bus_school_access(o.code)
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'schools', out,
    'limit', coalesce((select school_limit from public.bus_accounts where user_id = v_uid), 1)
  );
end $$;

revoke execute on function public.bus_my_schools() from public, anon;
grant  execute on function public.bus_my_schools() to authenticated;
