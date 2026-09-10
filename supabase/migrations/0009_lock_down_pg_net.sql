-- RentView — restrict pg_net where we are able to
--
-- Installing pg_net grants EXECUTE on net.http_post / http_get / http_delete
-- to PUBLIC, which is effectively a general-purpose HTTP client living inside
-- the database. That is worth taking away from anon and authenticated.
--
-- BE AWARE OF WHAT THIS DOES AND DOES NOT DO. On hosted Supabase those grants
-- are made by `supabase_admin`, and a REVOKE only removes grants made by the
-- role running it, so these statements are a NO-OP there — running them as
-- `postgres` (the SQL editor, the CLI, this migration) changes nothing, and
-- silently succeeds. They do take effect on a self-hosted stack where the
-- migration role owns the extension.
--
-- What actually keeps pg_net out of reach on hosted Supabase is that the
-- `net` schema is NOT in the API's exposed schemas, so PostgREST will not
-- route to it. Keep it that way: do not add `net` under
-- Dashboard -> Settings -> API -> Exposed schemas.
--
-- The push triggers are unaffected either way: they are SECURITY DEFINER
-- functions owned by postgres.

revoke all on schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;

grant usage on schema net to postgres, service_role;
grant execute on all functions in schema net to postgres, service_role;
