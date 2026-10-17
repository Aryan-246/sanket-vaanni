# Integration status — 2026-10-15

Addendum §1: the definitive integration inventory, with an honest status per
service and the evidence for each row.

**This document contains no credentials, and no credential value was read in
order to produce it.** Probe scripts were temporary files, printed statuses and
error codes only, and were deleted immediately after use.

---

## 1. The status ladder

Every row below is placed on exactly one rung. The rungs are ordered, and most
services stop well short of the top.

| Rung | Means | Does **not** mean |
|---|---|---|
| **implemented** | Code exists in this repository and is exercised by tests. | That it runs against the real service. |
| **configured** | Credentials or settings for the service are present in the environment. | That they are correct, current, or sufficient. Presence is not proof. |
| **reachable** | A network round trip to the service succeeded. | That anything of ours was accepted. |
| **authenticated** | The service accepted our credentials for the operation attempted. | That any intended operation succeeded. |
| **operation tested** | An operation of the intended kind was actually performed and returned success. | That a provider downstream acted on it. |
| **provider accepted** | The provider acknowledged acceptance (SMTP `accepted`, FCM `messageId`). | That an inbox or a device received anything. |
| **delivery verified** | An independent recipient or device confirmed receipt. | — |

**Nothing in this repository is at the `delivery verified` rung.** No message was
sent to any real recipient during this work, and no device was attached.

## 2. What was actually done to measure this

- Read-only HTTP probes against the hosted Supabase project and the deployed
  backend: `GET` only, every SQL select issued as `?select=*&limit=0` so that no
  row data could be returned even if privileges had allowed it.
- `verifySmtpConnection()` and `initFirebaseAdmin()` were invoked locally. Both
  are handshake calls. **No message was sent by either.**
- No row was inserted, updated or deleted anywhere. No hosted setting, secret or
  configuration was changed. No migration was applied. Nothing was deployed.
- Total cost: ₹0.

One method note, because it affects how the error codes read: the hosted project
issues the newer opaque key formats (`sb_publishable_*` and `sb_secret_*`), not
JWTs. Those are sent in the `apikey` header; there is no role claim to read out of
them. The role each one is treated as is therefore **the service's decision, not
something we can inspect** — which matters for interpreting the codes below.

## 3. Finding 1 — the hosted database refuses every role, and the cause is a missing `GRANT`

Measured 2026-10-15, against `mmovhldjwadvljxtloes.supabase.co` (the project both
`apps/mobile/.env` and `apps/backend/.env` point at):

| Request | anon key | service-role key |
|---|---|---|
| `GET /auth/v1/health` | **200** | — |
| `GET /rest/v1/` (root) | **401** `Secret API key required` | — |
| `GET /rest/v1/profiles?select=*&limit=0` | **401** `42501` | **403** `42501` |
| `…/user_preferences` | **401** `42501` | **403** `42501` |
| `…/calibration_profiles` | **401** `42501` | **403** `42501` |
| `…/oled_profiles` | **401** `42501` | **403** `42501` |
| `…/user_history` | **401** `42501` | **403** `42501` |
| `GET /storage/v1/bucket/user-media` | — | **200** (`public=false`) |

`42501` is PostgreSQL's `insufficient_privilege`. The tables **exist** — a
nonexistent table answers `404 PGRST205`, as the next table shows — and the schema
is reachable, but no request is authorised to read them.

The distinguishing detail is the service-role column. `service_role` bypasses Row
Level Security, but it does **not** bypass table privileges; they are separate
mechanisms, and RLS policies are predicates layered *on top of* a privilege that
must first be granted. A refusal for `service_role` therefore cannot be a policy
problem, a client problem, or a key problem. It is a missing grant.

Reading the migrations explains it, and the omission is narrow and specific:

| Migration | Table `GRANT` statements |
|---|---|
| `20261012000000_sanket_vaanni_initial.sql` (5 tables) | **0** — only 15 RLS policies and one `GRANT EXECUTE ON FUNCTION` (line 207) |
| `20261013000000_storage_user_media_policies.sql` | **0** |
| `20261014000000_admin_audit_maintenance.sql` | 9, e.g. `GRANT SELECT ON public.admin_audit_log TO authenticated` (410), `GRANT ALL ON public.app_settings TO service_role` (496) |
| `20261014000001_device_push_tokens.sql` | 3, e.g. `GRANT SELECT, INSERT, DELETE ON public.device_push_tokens TO authenticated` (176) |

So the earliest migration creates tables with policies but never grants the
privileges those policies sit on; the two later migrations do it correctly. The
pattern is consistent with plain `public`-schema default privileges having been
removed on this project — under which `CREATE TABLE` alone grants nothing, and
every table needs an explicit `GRANT`.

**Consequence:** on the hosted project today, the five core tables of migration 1
are unreachable by any client, and the four tables of migrations 3 and 4 do not
exist at all. Nothing in this repository can fix that from the client side, and
**§2.2 forbids applying the fix without explicit owner approval.**

This is also the answer to directive §4's requirement to *"document that
explicitly rather than marking cloud persistence as complete"*: **live Supabase
read-back is blocked by unapplied migrations and missing grants.** Guest-migration
cloud persistence is therefore **not** verified, and must not be described as
complete.

## 4. Finding 2 — migrations 3 and 4 are not applied at all

| Request (service-role key) | Result |
|---|---|
| `admin_audit_log` | **404** `PGRST205` |
| `announcements` | **404** `PGRST205` |
| `app_settings` | **404** `PGRST205` |
| `device_push_tokens` | **404** `PGRST205` |

`PGRST205` is PostgREST's "table not found in schema cache". These four tables are
created by migrations 3 and 4 and by nothing else, so those migrations have never
run against this project.

Everything built on those tables — the audit trail, announcements and their
dispatch, the server-side maintenance gate, and device push-token registration —
is **implemented and unit-tested but has no storage in production**. That is why
the admin bootstrap and every write-bearing admin action cannot currently succeed
live, no matter how correct the code is.

## 5. The inventory

| Service | Implementation | Configuration | Actual test performed | Evidence / result | Remaining blocker |
|---|---|---|---|---|---|
| **Backend host** (`sanket-vaanni-backend.onrender.com`) | Fastify app, `src/server.ts`; `/health` deliberately liveness-only | Deployed (Render blueprint) | Read-only `GET /health` | **200**, 23.4 s (free-tier cold start), body `{"status":"ok","service":"sanket-vaanni-backend","version":"0.1.0","uptimeSeconds":11}` | **Rung: reachable.** A process answering `/health` does not prove email, notifications, database writes or Admin operations work — the route's own comment forbids claiming them. |
| **Backend (local)** `127.0.0.1:4000` | Same code | `.env.local` points here | Read-only `GET /health` | **200** | Running on this machine (not started by this work). Irrelevant to production readiness. |
| **Supabase Auth (GoTrue)** | `supabase-js` in mobile and backend | `SUPABASE_URL` + publishable key present | `GET /auth/v1/health` | **200** | **Rung: reachable.** No sign-in was performed, so the "one Supabase Auth identity" requirement is **unverified live**. No account was created, to avoid creating test users in a hosted project. |
| **Supabase Postgres — migration 1 tables** | Schemas, RLS policies, typed contracts | URL + keys present | `limit=0` selects with both anon and service-role keys | **42501 insufficient_privilege** on all five, for **both** roles (see §3) | **Rung: reachable, not usable.** Needs a `GRANT` migration applied to the hosted project — forbidden without explicit owner approval (§2.2). |
| **Supabase Postgres — migrations 3/4 tables** | Audit, announcements, settings, push tokens | — | `limit=0` selects | **404 PGRST205** on all four | Migrations 3 and 4 **not applied**. Owner approval required. |
| **Supabase Storage** (`user-media`) | Bucket policies, folder-per-`auth.uid()` | Bucket exists, `public=false` | `GET /storage/v1/bucket/user-media` | **200** | **Rung: reachable.** No object was put, listed, downloaded or deleted, so the upload path and its RLS are **unverified**. |
| **Transactional email (SMTP)** | `src/services/email.ts` (nodemailer); Supabase Auth keeps sole ownership of auth emails | `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` present | `verifySmtpConnection()` | **`{"connected":true}`** — this host reached the SMTP server and the credentials were accepted | **Rung: authenticated.** No message was sent, so provider acceptance and delivery are both unverified. Whether the **host** (Render free tier) can reach port 465 outbound is **untested** — a local success does not imply it. |
| **Firebase Cloud Messaging (server)** | `src/services/firebase.ts`, `firebase-admin` | `GOOGLE_APPLICATION_CREDENTIALS` present | `initFirebaseAdmin()` | **`{initialized: true, projectId: 'sanket-vaanni'}`** | **Rung: configured.** No message sent, so no `messageId` exists and nothing is proven about delivery. Also needs a real device token, and the table holding tokens does not exist. |
| **FCM on the physical device** | Android app + `google-services.json` (gitignored; absent here) | — | none | — | **Unavailable.** No device attached; `adb devices -l` empty. Push must not be described as working because a stored toggle says ON. |
| **Admin system** | Full UI → typed API → auth → server-side authorisation → audit | Roles in `profiles.role`, writable only by service role | none possible | — | **Blocked by §3 and §4 together.** Bootstrap writes to `profiles` (42501) and audit writes to `admin_audit_log` (absent). A one-time bootstrap **cannot succeed today**. |
| **Announcements & dispatch** | `src/announcements/dispatch.ts`; counts `accepted`, never `delivered` | — | none possible | — | **Blocked.** No `announcements` table. A successful insert was never a delivery proof anyway. |
| **Guest migration / cloud read-back** | Bounded, cancellable upload + independent read-back, unit-tested | — | none possible | — | **Blocked by §3** — no table is writable. Per directive §4, recorded as blocked rather than complete. |
| **ML pipeline & learning centre** | Windowing, features, classifier, registry, evaluation, inference, screens and navigation | Local device storage only | Full Jest suite | Passing | **Rung: implemented.** Runs offline with no paid API. Two real limits: no verified glove (see next row), and no real captured dataset, so no honestly-trained model exists. |
| **Glove BLE** | Contracts, state machine, controller, error UI, tests complete | — | — | — | **Unavailable.** The firmware protocol is unverified; `BleTransport` refuses every operation by design, and the built APK contains no Bluetooth permission. See `docs/glove-input-layer.md`. |

## 6. What would move each row up a rung

Ordered by what unblocks the most:

1. **Owner approval to apply migrations 1–4 to the hosted project, including the
   missing `GRANT` statements for migration 1.** This alone unblocks the Admin
   system, announcements, audit, the maintenance gate, push-token registration and
   guest-migration read-back. Nothing else on this list is as load-bearing.
2. **A physical device.** Unblocks FCM, install/upgrade verification, and every
   on-hardware behaviour. §7 is explicit: while the device is disconnected, device
   verification must not be claimed.
3. **Verified glove firmware protocol.** Unblocks real sensor capture, and with it
   any claim of a genuinely trained recognition model.
4. **A real dataset captured from that glove.** Until then the ML centre's honest
   state is `DATASET_INSUFFICIENT` — no accuracy figure in this repository was
   measured on the user's own data.
5. **A real recipient for one transactional email, and confirmation from that
   recipient.** Only then does the email row reach `delivery verified`.

Until 1 arrives, the accurate one-line summary of backend integration is:
**the code is written and tested; the hosted database refuses it, and the two
migrations it depends on have never been applied.**
