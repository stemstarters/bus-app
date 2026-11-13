-- =====================================================================
-- Dismissal Magic — fix: deleted schools no longer count toward the limit
--
-- When a school is deleted, its link to the account stayed behind, so the
-- "one school per account" check still counted it. Now only schools that
-- still exist count, and leftover links are cleaned up.
-- The free trial is unaffected: it still belongs to the account, so
-- deleting and re-making a school doesn't give a new free month.
--
-- Run once in Supabase → SQL Editor, after 01–05. Safe to run again.
-- =====================================================================

-- Clean up links to schools that no longer exist.
delete from public.bus_school_owners o
where public.bus_get_school(o.code) is null;

create or replace function public.bus_create_school_owned(p_settings jsonb, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_limit int;
  v_have  int;
  r jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;

  perform pg_advisory_xact_lock(hashtext('bus_owner:' || v_uid::text));

  -- Forget links to schools that were deleted.
  delete from public.bus_school_owners o
  where o.user_id = v_uid and public.bus_get_school(o.code) is null;

  v_limit := coalesce((select school_limit from public.bus_accounts where user_id = v_uid), 1);
  select count(*) into v_have from public.bus_school_owners where user_id = v_uid;
  if v_have >= v_limit then
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
