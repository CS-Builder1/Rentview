# What only you can do

Everything in this file needs your accounts, your credentials, or a decision
that is yours to make. Nothing here blocks development — the app runs today
with all of it unset, and each feature fails soft rather than breaking.

**Nothing here is urgent unless the "Blocks" line says so.**

Last reviewed: the billing commit (Lemon Squeezy + PayPal webhooks).

---

## 1. Supabase Auth — leaked password protection

- [ ] Supabase dashboard → Authentication → Policies → enable **leaked password
      protection** (checks new passwords against HaveIBeenPwned).

**Blocks:** nothing. It is the last open item in Supabase's security advisor —
every other warning there is intentional and documented in the README.
**Effort:** one toggle.

---

## 2. Push notifications — Expo project + credentials

The code is complete and the database triggers are live. Push cannot deliver
until Expo can issue tokens for this app.

- [ ] `eas init` — writes `extra.eas.projectId` into `app.json`. Commit that
      change.
- [ ] `eas build --profile development` — Expo Go cannot receive remote push
      from SDK 53 onward, so testing needs a development build.
- [ ] `eas credentials` — FCM (Android) and APNs (iOS) keys. EAS manages them.

**Blocks:** all push delivery. Without a project id the app logs a warning,
skips registration and otherwise runs normally.
**Effort:** 20–30 minutes, mostly waiting on a build.

---

## 3. Push notifications — the hook secret

The triggers call the `send-push` function with a shared secret. I stored the
non-secret half (`push_hook_url`) in Vault already; the secret half is yours to
generate so it never passes through a transcript or a commit.

- [ ] Generate one: `openssl rand -hex 32`
- [ ] Give it to the function:
      `supabase secrets set PUSH_HOOK_SECRET=<value>`
- [ ] Give the same value to the database — Supabase SQL editor:
      ```sql
      select vault.create_secret('<value>', 'push_hook_secret');
      ```
- [ ] Check both halves are set:
      ```sql
      select hook_url is not null as url, hook_secret is not null as secret
      from public.push_hook_config();
      ```

**Blocks:** all push delivery. Until it is set, `notify_push()` returns
immediately — writes still succeed, nobody is notified.
**Effort:** 5 minutes. To rotate later, set a new secret in both places.

---

## 4. Billing — Lemon Squeezy (the primary path)

- [ ] Create the store, product and a subscription variant (~$19/mo).
- [ ] Copy the variant's checkout URL into `.env` as
      `EXPO_PUBLIC_LEMONSQUEEZY_STORE_URL`. The app appends the account id
      itself, so paste the plain URL.
- [ ] Create a webhook pointing at
      `https://blxkpwokmduxkfwlzexh.supabase.co/functions/v1/lemonsqueezy-webhook`,
      subscribed to the `subscription_*` events, with a signing secret.
- [ ] `supabase secrets set LEMONSQUEEZY_WEBHOOK_SECRET=<the signing secret>`
- [ ] Test with a real checkout in test mode and confirm a row appears in
      `subscriptions` for your account.

**Blocks:** anyone paying you. The Subscribe button shows a "not wired up yet"
message while the URL is unset.
**Effort:** ~30 minutes including a test purchase.

---

## 5. Billing — PayPal (the secondary path)

- [ ] Create a product and billing plan; copy the subscribe link into `.env` as
      `EXPO_PUBLIC_PAYPAL_PLAN_URL`.
- [ ] Create a webhook pointing at
      `https://blxkpwokmduxkfwlzexh.supabase.co/functions/v1/paypal-webhook`,
      subscribed to the `BILLING.SUBSCRIPTION.*` events.
- [ ] Set the credentials the function verifies deliveries with:
      ```bash
      supabase secrets set PAYPAL_CLIENT_ID=... PAYPAL_SECRET=... \
        PAYPAL_WEBHOOK_ID=... PAYPAL_ENV=live
      ```
      (`PAYPAL_ENV=sandbox` while testing.)

**Blocks:** PayPal payments only. Lemon Squeezy works independently.
**Know this:** PayPal's hosted subscribe link has no documented way to carry
our account id, so the webhook matches on the payer's **email**. If someone
pays with a different PayPal email than their RentView login, the event lands
in `billing_events` with no subscription applied — look there first when
someone says they paid and the app disagrees.
**Effort:** ~45 minutes; PayPal's console is slower than Lemon Squeezy's.

---

## 6. Email reminders — Resend key

The `send-reminders` function and its cron schedule are deployed, but it can't
send without a key.

- [ ] `supabase secrets set RESEND_API_KEY=...`
- [ ] Optional: `REMINDERS_FROM="RentView <you@yourdomain>"` (defaults to
      Resend's shared test sender, which is fine for testing but not for real
      mail).
- [ ] Optional: `CRON_SECRET=...` if you want the scheduled run, wired up per
      `supabase/reminders_cron.sql`.

**Blocks:** warranty and maintenance reminder emails.
**Effort:** 10 minutes.

---

## 7. `EXPO_PUBLIC_APP_URL`

- [ ] Set it in `.env` to your production web URL.

**Blocks:** printed asset QR codes deep-link to the right place. Everything
else ignores it.

---

## 8. A decision, not a task: what Free actually includes

Right now Free allows **3 properties** and everything else is unlimited —
units, work orders, assets, inventory, documents, offline capture, the tenant
portal. That number is a placeholder I picked to match "a generous free tier";
it is the only thing separating Free from Pro.

It lives in one place: `FREE_PROPERTY_LIMIT` in `lib/plan.ts`.

- [ ] Confirm 3, or tell me a different number / a different axis entirely
      (units instead of properties, tenant-portal seats, and so on).

**Blocks:** nothing technically, but it is what someone is paying $19/mo to
lift, so it is worth deciding before you charge anyone.

---

## 9. Standing rule: never expose the `net` schema

Not a task — a thing not to do later.

Push runs on `pg_net`, whose `net.http_*` functions are executable by any signed-in
role (Supabase installs them that way and it cannot be revoked from the `postgres`
role). They are unreachable only because PostgREST does not expose the `net` schema.

- [ ] Know that adding `net` under Dashboard → Settings → API → **Exposed schemas**
      would hand every signed-in user an HTTP client running inside your database.
      Don't.

---

## 10. End-to-end test with two real accounts

Not credentials — just something no amount of typechecking substitutes for.

- [ ] Owner account: create a property, a unit, a lease, generate an invite.
- [ ] Tenant account (a second email): claim the code, submit a request with a
      photo, message the owner.
- [ ] Owner: convert it to a work order, complete it, confirm the tenant sees
      "resolved" and can rate it.

**Blocks:** confidence. The portal has been verified by typecheck and a clean
web build, never by two humans using it.
