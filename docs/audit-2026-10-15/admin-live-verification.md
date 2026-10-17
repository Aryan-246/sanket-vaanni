# Admin system — live verification against a real stack

Date: 2026-10-15. Branch `3d-hand-viewer-integration`, HEAD `32937ac`.

This document records what was **actually executed** — real HTTP requests through the
real authorization middleware into a real PostgreSQL database — as distinct from what
the test suites assert. It exists because passing tests and HTTP 200 responses are not
evidence that a system works, and the previous audit already said so.

Two items remain blocked on the owner and are stated plainly in §7 rather than papered
over: the physical phone, and the hosted database.

---

## 1. How the evidence was produced

| Element | What it was |
| --- | --- |
| Database | The local Supabase stack (Docker), fully migrated: `profiles`, `admin_audit_log`, `announcements`, `app_settings`, `device_push_tokens`, `calibration_profiles`, `oled_profiles`, `user_history`, `user_preferences` |
| Identity | A real GoTrue sign-in (`signInWithPassword`) against that stack, producing a real JWT |
| Server | The Fastify backend on `127.0.0.1:4000`, running the working tree |
| Authorization | The real `requireAdmin` middleware, unmodified |
| Writes | Verified by reading the rows back out of PostgreSQL directly, not by trusting the API response |
| Scripts | `$CLAUDE_JOB_DIR/tmp/e2e-admin.cjs`, `delete-semantics.cjs` — throwaway, outside the repository |

Nothing here is a mock. Where a check could have passed vacuously it was rewritten:
an early `?action=` filter and an early maintenance probe both "passed" against empty
or unconstrained result sets, and both were replaced with assertions that fail if the
behaviour is absent (§3.3, §3.5).

---

## 2. The Admin login (Phase 1)

**Status: `IMPLEMENTED BUT UNVERIFIED` on the hosted project — blocked on a migration
you have not approved. `VERIFIED` on the local stack.**

### 2.1 The mechanism

`apps/backend/src/admin/provision.ts` (with CLI `src/scripts/provisionAdmin.ts`,
`npm run provision:admin`). It creates **one** identity and promotes it, or rotates an
existing administrator's password. It is the narrow exception to the rule that only an
administrator creates an administrator, and the tests are mostly about keeping it narrow:

- It refuses to create an account while **any** active administrator exists. An
  operator-held path that always works is a backdoor, not a recovery route.
- It never promotes. Promotion stays in `bootstrap:admin`. `--rotate` refuses a
  non-administrator, so rotation cannot become a second way to grant the role.
- It appends `requested` to `admin_audit_log` **before** promoting, so a privilege
  change that cannot be recorded does not happen.
- The password is generated from 24 CSPRNG bytes (`randomBytes(24).toString('base64url')`)
  and is never logged, echoed, returned in a message, or written into an audit row.
  There is no `--password` flag: a typed password lands in shell history.
- It writes `ADMIN_EMAIL`/`ADMIN_PASSWORD` to `apps/backend/.env` (gitignored) by
  rewriting only the matching lines, so unrelated secrets are carried through untouched.

### 2.2 Verified locally, end to end

Against the local stack, using `--rotate` (the recovery path) on the existing
`test-admin@example.com` identity:

| Check | Result |
| --- | --- |
| Password set through GoTrue admin API | done |
| Sign in with the generated password | **succeeds** |
| Sign in with a wrong password | **refused** — `Invalid login credentials` |
| Audit rows written | `rotate_admin_password` × `requested` + `succeeded`, `actor: operator-cli` |
| Password present anywhere in the audit rows | **no** |

### 2.3 The authorization ladder, verified live

| Request | Result |
| --- | --- |
| `GET /admin/overview` with no token | 401 |
| `GET /admin/overview` with a garbage token | 401 |
| `GET /admin/overview` with the real admin token | 200, real counts from the database |

All 15 `/admin` routes sit behind one `preHandler` hook, so the ladder is not
per-route and cannot drift per-route.

### 2.4 Why hosted credentials still do not exist

A read-only probe of the hosted project found `profiles` has **no `role` column**
(`42703`), and `admin_audit_log`, `announcements`, `app_settings` and
`device_push_tokens` **absent** (`PGRST205`). `requireAdmin.ts` reads `role` from
`profiles`; there is no environment-variable allowlist anywhere in it. So on the
hosted project there is **no code path by which any account can be an administrator**,
and no local workaround exists. This is not a documentation gap — it is a hard block
that only applying the migrations can lift, and applying them is yours to approve.

---

## 3. The Admin API, exercised end to end (Phase 3)

**31 of 31 checks pass**, each with a real token and a real database write.

### 3.1 Users, status and safeguards

| Check | Result |
| --- | --- |
| Suspend a normal user | 200, `profiles.status = 'suspended'` read back from Postgres |
| Reactivate | 200 |
| Self-suspension | **400 refused** |
| Self-demotion | **400 refused** |
| A write with no `reason` | **400 refused** |
| Last-admin demotion | refused (see `routes/admin.ts`) |

### 3.2 Bulk actions

| Check | Result |
| --- | --- |
| Suspend 2 targets, one of them nonexistent | 200 — `succeeded: 1, failed: 1`, per-target `results[]` |
| Does it report blanket success? | **No** — `succeeded !== results.length` |
| The one that succeeded really changed | `status = 'suspended'` in Postgres |
| The one that did not, did not | per-target `ok: false` |
| More than 50 targets | 400 refused |

### 3.3 Audit history and every filter

| Filter | Result |
| --- | --- |
| `?action=update_announcement` | 200, 8 rows, all matching; 0 rows of other actions |
| `?targetType=announcement` | 200, 20 rows, all matching |
| `?targetId=<user>` (per-account history) | 200, 6 rows, all that account |
| `?outcome=succeeded` | 200, 28 rows |
| `?from=not-a-date` | 200 — **deliberately widens, does not hide** |

That last row is a design decision, not a bug, and it is documented in the source: a
mistyped date filter drops back to unfiltered so an administrator sees the log rather
than a screen implying nothing happened. It is the opposite policy to `readExpiry`,
which refuses an unreadable date on an announcement because that value decides what
every user sees.

### 3.4 Announcements

| Check | Result |
| --- | --- |
| Create a draft | 201 |
| Publish | 200 |
| Persisted and live | `published = true`, `published_at` set, read from Postgres |
| Re-publish does not move `published_at` | unchanged — it records when it went live, not when it was last touched |
| Dispatch | 200 |

### 3.5 Maintenance mode

| Check | Result |
| --- | --- |
| Enable | 200 |
| `/notifications/status` stays reachable | 200 — deliberately exempt: it is how the app *asks* whether maintenance is on |
| `POST /email/send-security-alert` (a gated route) | **503**, `{"error":"Audit in progress","maintenance":true}` |
| `/admin/*` stays reachable | 200 — **maintenance can never lock you out of turning it off** |
| Disable | 200 |
| Gated route reopens | no longer 503 |
| Enable with an empty message | 400 refused |

---

## 4. Email and push delivery (Phase 4)

**Verification ladder: configured → request attempted → accepted by provider →
delivered/received. Nothing in this project, and nothing in this pass, reaches the last
rung.**

| Mechanism | State | Evidence |
| --- | --- | --- |
| Application email (nodemailer) | **configured, authenticates** | `GET /email/status` with the real `.env`: `configured: true, connected: true, error: null`, `smtp.gmail.com:465` |
| Application email — delivery to an inbox | **UNVERIFIED** | No message was sent. Delivery cannot be confirmed from this environment. |
| Supabase Auth email | **BLOCKED locally** | The local stack has `mailer_autoconfirm: true`, so it sends no confirmation mail at all. The mail catcher holds nothing because nothing is generated. |
| Push notifications (FCM) | **unconfigured** | `GOOGLE_APPLICATION_CREDENTIALS` is blank; no service account |
| In-app announcements | **VERIFIED** | §3.4 — persisted, published, and dispatch reported honestly |

Two things deserve to be said plainly, because they are the whole point of the ladder:

1. **The dispatch path never claims delivery.** With no Firebase account configured,
   `POST /admin/announcements/:id/dispatch` returns
   `{"state":"unavailable","deliveryConfirmed":false,"targets":0,"accepted":0,"failed":0}`
   with the reason attached. It does not turn a configuration gap into a success message.
2. **`GET /admin/health` reports `deliveryTested: false` for every channel, including
   the two it marks `delivers: true`.** It distinguishes "this channel can deliver" from
   "a message was delivered", which is the distinction the directive asked for.

The SMTP credential in `.env` authenticates to Gmail. That is a real login, not merely
a populated field — but it is **not** proof that a message reaches a mailbox, and it is
recorded as unverified rather than inferred.

---

## 5. Deletion semantics (Phase 7, verified portion)

**10 of 10 checks pass.** A throwaway account was given a seed row in every table that
references it, then deleted through the exact function the app calls.

| Check | Result |
| --- | --- |
| `auth.users` row | gone |
| `profiles` | gone |
| `user_preferences` | gone |
| `user_history` | gone (seeded 1) |
| `device_push_tokens` | gone (seeded 1) |
| `calibration_profiles` | gone (seeded 1) |
| Audit rows | **survive** — `actor_id`/`created_by` are `ON DELETE SET NULL`, so the log is not erased by its subject |

**Ownership is enforced by construction.** The function is
`public.delete_user_account()` — it takes **no parameters**, so a client-supplied user
id cannot be passed to it at all; it can only ever act on `auth.uid()`. It requires an
authenticated session (`GRANT EXECUTE ... TO authenticated`, revoked from `public`).
This satisfies "a client-supplied user ID must never be sufficient" more strongly than
a check would: there is nothing to check.

**Storage.** A `user-media` bucket exists with per-user RLS
(`(storage.foldername(name))[1] = auth.uid()::text`). No client code uploads to it —
searched the whole app, zero call sites. So the "deleted account leaves orphaned
files" gap is **latent, not active**: there is nothing in the bucket to orphan.

### 5.1 Two real gaps in the deletion path

These are implementation gaps, not verification gaps. Both are stated in source terms
because that is conclusive for an absence of code.

1. **No email verification challenge before deletion.** The app calls the RPC with an
   ordinary session. The directive requires a verification challenge to the verified
   address with server-side challenge verification before the destructive operation.
   The UI has the permanence warning and an explicit confirm ("This cannot be undone"),
   but a confirmation dialog is not the same control as proving control of the mailbox.
2. **No last-administrator guard.** `delete_user_account()` deletes
   `auth.users WHERE id = auth.uid()` and contains no reference to `role`. The admin
   *suspend* and *role* routes both refuse to remove the last administrator (400); this
   function does not. An administrator can therefore delete themselves and leave the
   project with no way to administer it — through a path the directive names explicitly.

---

## 6. Tests and static checks on this tree

| Check | Command | Result |
| --- | --- | --- |
| Backend tests | `cd apps/backend && npm test` | **9 files, 202 tests passed**, exit 0 |
| Mobile tests | `cd apps/mobile && npx jest --silent` | **54 suites, 1027 tests passed**, exit 0 |
| Backend types | `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| Mobile types | `npx tsc --noEmit` | exit 0 |
| Backend build | `npm run build` | exit 0 |

Green, with the standing caveat: these assert behaviour against described inputs. §3 and
§5 are what establish that the same behaviour holds against a live database.

---

## 7. Blocked, and on what

| # | Item | Blocked on | Why guessing is not an option |
| --- | --- | --- | --- |
| B1 | Hosted Admin credentials | **your approval to apply migrations to the hosted project** | The hosted schema has no `role` column; no env allowlist exists. Nothing local can work around it. |
| B2 | Real-phone Admin audit | **a connected phone** | `adb devices -l` is empty. Reporting device testing without a device is exactly what the directive forbids. |
| B3 | Email delivery confirmation | a mailbox I can read, or your word after a test send | Rung 4 of the ladder (§4). |
| B4 | Supabase Auth confirmation email | `mailer_autoconfirm: true` on the local stack | Changing it means editing `supabase/config.toml`, which is Gemini-owned. |

---

## 8. What this pass changed in the repository

| File | Change |
| --- | --- |
| `apps/backend/src/admin/provision.ts` | new — the provisioning mechanism |
| `apps/backend/src/scripts/provisionAdmin.ts` | new — the CLI |
| `apps/backend/package.json` | added the `provision:admin` script |
| `apps/backend/test/admin-provision.test.ts` | new — 31 tests |
| `apps/backend/.env.example` | added `ADMIN_EMAIL`/`ADMIN_PASSWORD` as blank placeholders, documented as a record rather than configuration |

Nothing was committed, pushed or deployed. `supabase/` was read and not modified.
`requireAdmin.ts` was read and not modified. `.env` was not modified (`--no-write-env`
was used throughout, since the credentials exercised were for the local stack only).
