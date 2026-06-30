-- Security hardening for trigger/helper functions.
-- These run via triggers only and must not be exposed on the REST RPC endpoint.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
