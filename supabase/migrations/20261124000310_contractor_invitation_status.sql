-- Invitation records contain the verified contact email and token hash.
-- The vendor editor only needs the current state, including before the first job.
create function public.contractor_invitation_status(p_vendor uuid)
returns text language sql stable security definer set search_path='' as $$
  select case
    when exists (select from public.contractor_accounts a where a.vendor_id=v.id) then 'connected'
    when exists (select from public.contractor_invites i where i.vendor_id=v.id and i.expires_at>now()) then 'pending'
    else 'available'
  end
  from public.vendors v
  where v.id=p_vendor and (select public.current_account_is_active())
    and (v.owner_id=(select auth.uid()) or
      (v.property_id is not null and public.manages_owned_property(v.property_id,v.owner_id)));
$$;
revoke all on function public.contractor_invitation_status(uuid) from public,anon;
grant execute on function public.contractor_invitation_status(uuid) to authenticated;
