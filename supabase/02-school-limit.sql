-- =====================================================================
-- Dismissal Magic — limit of 3 schools per account (for now)
-- Run once in Supabase → SQL Editor, after 01-accounts.sql. Safe to run again.
-- Change the 3 below if you ever want a different limit.
-- Linking an older school with its code + PIN is not limited.
-- =====================================================================
create or replace function public.bus_create_school_owned(p_settings jsonb, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_limit int  := 3;
  r jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;

  -- One at a time per account, so two quick clicks can't sneak past the limit.
  perform pg_advisory_xact_lock(hashtext('bus_owner:' || v_uid::text));
  if (select count(*) from public.bus_school_owners where user_id = v_uid) >= v_limit then
    return jsonb_build_object('ok', false, 'error', 'school_limit', 'limit', v_limit);
  end if;

  r := public.bus_create_school(p_settings, p_pin)::jsonb;

  if coalesce((r->>'ok')::boolean, false) and r ? 'code' then
    insert into public.bus_school_owners (code, user_id)
    values (r->>'code', v_uid)
    on conflict (code) do nothing;
  end if;

  return r;
end $$;

revoke execute on function public.bus_create_school_owned(jsonb, text) from public, anon;
grant  execute on function public.bus_create_school_owned(jsonb, text) to authenticated;
