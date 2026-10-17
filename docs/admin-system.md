# Sanket Vaanni — The Administration System

**Audience:** whoever operates, reviews or hands over this system.
**Scope:** how administration works today — identity, permission, the audited action chain, maintenance mode, announcements, bootstrap and recovery.
**Status of every claim:** each section states whether the thing is live, implemented-but-not-configured, or not implemented. Nothing here is aspirational. If something is absent, it says so and says why.

**Companion documents:**
- `docs/admin-migration-checklist.md` — the ordered SQL the owner must review and run by hand. Nothing in it has been run against the hosted project.
- `docs/task-f-final-report.md` — the completion report against the brief, including what was **not** finished.

---

## 1. Where the system lives

| Piece | Path |
|---|---|
| Admin API routes | `apps/backend/src/routes/admin.ts` |
| The authorization hook | `apps/backend/src/middleware/requireAdmin.ts` |
| The audited-action helper | `apps/backend/src/audit/trail.ts` |
| Maintenance gate (server) | `apps/backend/src/maintenance/gate.ts` |
| First-admin bootstrap (library) | `apps/backend/src/admin/bootstrap.ts` |
| First-admin bootstrap (CLI) | `apps/backend/src/scripts/bootstrapAdmin.ts` |
| The console (UI) | `apps/mobile/src/screens/AdminScreen.tsx` |
| The API client (typed) | `apps/mobile/src/admin/client.ts` |
| Audit row → sentence | `apps/mobile/src/admin/auditEntry.ts` |
| Bulk answer → sentence | `apps/mobile/src/admin/bulkEntry.ts` |
| Announcements (client read) | `apps/mobile/src/announcements/reader.ts` |
| Closed-app screen | `apps/mobile/src/screens/MaintenanceScreen.tsx` |
| Schema + policies + grants | `supabase/migrations/` (see the checklist) |

**There is no `apps/web` admin panel.** The console is a screen inside the React Native app, reached from the settings page. That is the project's actual frontend stack, and a second UI framework was deliberately not introduced.

---

## 2. Identity: one system, not two

There is exactly **one** identity system: **Supabase Auth** (hosted). Every account — ordinary user, administrator, the first administrator — is an `auth.users` row.

`public.profiles` extends it, one row per account, created by the `handle_new_user()` trigger:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, references `auth.users(id)`, cascade delete. |
| `email` | text | Mirrored from the auth record. |
| `display_name` | text | |
| `avatar_url` | text | CHECK: must not be an `http(s)://` URL — it is a storage path, not a link. |
| `role` | text | `NOT NULL DEFAULT 'user'`. CHECK: `IN ('user','admin')`. |
| `status` | text | `NOT NULL DEFAULT 'active'`. CHECK: `IN ('active','suspended')`. |
| `created_at` | timestamptz | |

### 2.1 The role model, stated plainly — there is no separate super-admin

**The schema supports exactly two roles: `user` and `admin`.** There is no `super_admin`, no `owner`, no third tier to be promoted into. This is reported rather than worked around: inventing a role that the CHECK constraint and every policy would reject would be a fiction, and a "super admin" screen backed by a role that does not exist is worse than no screen.

The brief allows for this — *"if the system supports or requires a distinct highest-privilege role; otherwise explain the existing role model and implement a safe equivalent"*. The safety properties that a separate highest-privilege role would have provided are provided instead by four things that do exist:

1. **The last-administrator protection.** Neither the single-account suspend route nor the bulk route will let the only remaining active administrator be suspended, and the bulk route refuses a selection that contains *all* active administrators. Enforced server-side, in a transaction-free sequence that re-reads the count each time.
2. **Self-lockout protection.** An administrator cannot suspend their own account through either route.
3. **The one-time bootstrap.** The first administrator cannot be created through the API at all — only by a CLI that refuses to run while any active administrator exists (see §7).
4. **An append-only audit log** that records `actor_id` and `actor_email` from the *verified* token subject, never from the request body.

### 2.2 How "administrator" is decided, on every request

Defined in `requireAdmin.ts`. The order is the point:

1. Extract the bearer token. **Absent → 401.**
2. `authClient.auth.getUser(token)` — the token is validated against Supabase, not merely decoded. **Invalid or expired → 401.**
3. **Re-read `profiles` with the service-role key** for that user id, selecting `role, status`. **`role !== 'admin'` → 403.**
4. **`status !== 'active'` → 403.**
5. Only then: `request.adminActor = { id: user.id, email: user.email }` and `request.adminService = serviceClient`.

Two consequences worth stating:

- **The role is read from the row on every request, never from a token claim.** A JWT that carries a stale `role: admin` claim is ignored. This is what makes a suspension take effect immediately instead of at token expiry.
- **The actor is never taken from the request.** No route reads an `actorId` or `actor_id` from the body. A client cannot attribute an action to anybody, including itself. The bulk tests assert this explicitly: a body carrying `actorId` is ignored.

### 2.3 Permission matrix

"Authenticated" below means a verified Supabase session. RLS is the backstop; the hook is the door.

| Action | Ordinary user | Suspended account | Administrator | Service role (backend) |
|---|---|---|---|---|
| Read own preferences / calibration / OLED profiles / history | Yes (own rows only) | **No** — every policy is gated on `is_active()` | Yes (own rows) | Yes |
| Write own preferences / calibration / OLED profiles / history | Yes (own rows) | **No** | Yes (own rows) | Yes |
| Read published, in-window announcements | **Yes, including signed out** | Yes | Yes | Yes |
| Read all announcements (incl. drafts) | No | No | Yes | Yes |
| Read the maintenance setting | **Yes, including signed out** — the value only | Yes | Yes | Yes |
| Change the maintenance setting | No | No | Yes (via API) | Yes |
| Read `profiles` | Own row only | Own row only | **All rows** | Yes |
| Change `role` or `status` on any profile | **No** | No | **No — not even an administrator** | **Yes** |
| Read `admin_audit_log` | No | No | Yes | Yes |
| Write `admin_audit_log` | No | No | No | **Yes — insert only** |
| Update or delete an audit row | **No — for anyone, ever** | No | No | **No — no UPDATE/DELETE grant exists** |
| Register a device push token | Own tokens (max 20, oldest pruned) | Own tokens | Own tokens | Yes |

The row that surprises people is *"Change `role` or `status` … Administrator: No"*. Administrators change role and status **through the API**, which holds the service-role key and writes an audit row. They cannot do it from a client session, because a trigger (`enforce_profile_privilege_boundary` on `profiles`) raises `insufficient_privilege` unless the acting role is `service_role`. That trigger is the single most important guard in the database: without it, any authenticated user could promote themselves to admin with one PostgREST call.

> **Correction to an earlier note on file.** A previous handover described the privileged-column trigger as living on `device_push_tokens`. It does not. `device_push_tokens` has **no trigger at all**; its tightened design is a missing UPDATE policy plus a minimal `GRANT SELECT, INSERT, DELETE`. The privileged-column trigger is on `profiles` and constrains `role`/`status`. Both mechanisms are real, they are just on different tables.

---

## 3. The audited action chain

Every administrative write follows this path, and a feature is only "done" when **all** of it is connected:

```
UI control
  → typed request            mobile/src/admin/client.ts
  → bearer token attached    from the live Supabase session
  → backend route            backend/src/routes/admin.ts
  → token validated          auth.getUser(token)
  → role + status re-read    profiles, service-role key
  → body validated           reason length, target shape, batch bounds, last-admin rule
  → audit row written        "requested" — BEFORE the mutation
  → database mutation        service-role client
  → audit outcome written    "succeeded" / "failed", same requestId
  → UI refresh               the affected list reloads
  → notification attempt     where a real channel exists (§6)
```

### 3.1 Why an action writes **two** audit rows

`beginAction()` writes a `requested` row before the mutation is attempted, because a consequential change with no record of it is the one thing an audit log must never permit. That ordering means the outcome is not yet known when the row is written — so the outcome is appended as a **second row under the same `requestId`**. The pair reads as one action: asked for by this person, for this reason, then resolved either way.

The two rows differ in `metadata`:

- **Request row** — `metadata = { ...callerMetadata, outcome: 'requested', requestId }`
- **Outcome row** — `metadata = { outcome, requestId, detail? }`

So any custom metadata a route attaches (for example `{ bulk: true }`) lives on the **request** row only. Anyone querying `metadata->>'bulk'` gets one row per batch, not two.

The `requestId` is `String(request.id)` — Fastify's own request id — which is why the two rows can be joined, and why a batch of 50 accounts still yields **one** correlation id.

### 3.2 The asymmetry, deliberate

- A failure to write the **request** row **aborts the action** (the handler's existing 500). If it cannot be recorded, it does not happen.
- A failure to write the **outcome** row **does not fail the request**. By then the action has already happened or already failed; throwing could not undo either, and would only turn a completed action into a 500 and invite a retry. The worst case is a row left saying `requested` forever — which is *true as far as it goes*, and is exactly what an investigator should read as unresolved rather than as done.

### 3.3 What the log is protected by

Three independent mechanisms, so no single mistake opens it:

1. **No UPDATE or DELETE policy** exists on `admin_audit_log` for any role.
2. `REVOKE UPDATE, DELETE, TRUNCATE … FROM authenticated` and `REVOKE ALL … FROM anon`.
3. `INSERT` is granted to `service_role` only; `authenticated` holds `SELECT` only.

`actor_email` is populated from the verified identity on every row, so a stale or missing email is never permanent.

---

## 4. The API

Twelve endpoints, all under `/admin`, all behind `requireAdmin`, all except the two reads requiring a `reason` of at least 3 characters (the table's own CHECK constraint enforces the same floor).

### Reads

| Method | Path | Answers |
|---|---|---|
| `GET` | `/admin/users` | Paged list. `page`, `perPage`, `q` (search), `status` filter. Server-side paging, server-side total. |
| `GET` | `/admin/users/:id` | One profile. |
| `GET` | `/admin/audit` | Paged audit log. Filters: `action`, `outcome`, `actor`, `targetType`, `targetId`, `from`, `to`. |
| `GET` | `/admin/announcements` | All announcements including drafts. |
| `GET` | `/admin/maintenance` | The setting, when it last changed, and **who** changed it (possibly nobody). |

### Writes

| Method | Path | Does | Notes |
|---|---|---|---|
| `POST` | `/admin/users/:id/suspend` | Sets `status` to `suspended`/`active` | Refuses self; refuses the last active admin. |
| `POST` | `/admin/users/bulk` | Same, for 1–50 accounts | See §5. |
| `POST` | `/admin/users/:id/role` | Sets `role` | |
| `POST` | `/admin/users/:id/reset-password` | Asks Supabase to send the account its own reset email | **Status is `requested`, never "sent"** — delivery is not observable from here (§6). |
| `POST` | `/admin/announcements` | Creates, published or draft | |
| `POST` | `/admin/announcements/:id` | Publishes, unpublishes, edits | |
| `POST` | `/admin/maintenance` | Turns maintenance mode on or off | Message required when turning it **on**; not when off. |

Every one of the seven writes writes its audit pair. The two `GET`s that are reads of a *setting* deliberately do not.

---

## 5. Bulk actions — and why the answer is not "done"

`POST /admin/users/bulk` accepts `{ userIds, suspended, reason }`.

Server-side rules, in the order they are checked:

1. A reason is required before anything is read.
2. `userIds` must be a non-empty array of non-empty strings. A selection of more than **50** is refused **without reading anything**.
3. Duplicates are folded — a repeated id would otherwise suspend the same account twice and audit it twice.
4. If the action is a suspension and the caller is in the selection, it is refused (self-lockout).
5. If the selection contains **all** active administrators, it is refused. The message says which case it is: *"This is the only active administrator…"* or *"The selection contains all N active administrators…"*.
6. Then, per account, sequentially: `beginAction` → `UPDATE` → `succeeded`/`failed`.

**A partial result is reported as partial, not rolled back.** The database can refuse one account while its neighbours are changed, so the response carries one entry per account (`{ id, ok, status?, error? }`) and the UI counts the rows rather than trusting the service's own tally. An account whose audit row could not be written is reported as *"Not attempted: it could not be recorded in the audit log."* — not as a failure of the action.

The screen (`bulkEntry.ts`, tested in `__tests__/admin-bulk.test.ts`) only says **complete** when every selected account changed. Otherwise it names how many changed out of how many, and lists each account that did not with the reason the service gave — or, when the service gave none, the literal sentence *"The service did not say why."* rather than an invented cause. An answer that cannot be read at all gets its own outcome: *"The service did not say which accounts were changed. Reload the list to see the current state."* — **never** "nothing was changed", which would be a claim about the database made from a response that failed to describe it.

The row's Select control is hidden on the administrator's **own** row, because the backend refuses that selection — a tick box that always ends in a 400 is a control that cannot do what it says.

---

## 6. Honest limits — what is not connected

These are stated because the alternative is a system that appears to do more than it does.

| Thing | Reality |
|---|---|
| **Push notification delivery** | **Not implemented as a delivery path.** Device tokens are registered and stored; no dispatch service exists. No route claims a notification was delivered. |
| **Announcement dispatch** | In-app availability only. An announcement is *available* to a client that fetches it; nothing is *pushed*. There is no retry, no backoff, and no delivery receipt — and therefore no dedup problem to solve. |
| **Announcement targeting** | Not implemented. Every published, in-window announcement is readable by everyone, including signed-out clients. There are no per-audience or per-role announcements. |
| **Password reset** | The request is made and the status reported is `requested`. Whether the mail arrives is decided by the mail provider and is **not observable from this service**, so nothing reports it as sent or delivered. |
| **Account termination / deletion** | **Not implemented, and cannot be as specified.** `profiles.status` is CHECK-constrained to `('active','suspended')`. There is no `terminated` or `deleted` state, and the API has no delete route. Suspension is a status flag and is **described as suspension everywhere** — the console never says an account was terminated or deleted. Deleting the `auth.users` row would cascade to `profiles` and is an owner-level operation, not a console action. |
| **Android process kill during maintenance** | Not attempted. Maintenance mode closes the UI; it does not and should not kill the process. |
| **Blocking hosted Auth sign-in during maintenance** | **Not gated.** Sign-in happens against Supabase's hosted `/auth/v1/token`, which this Fastify service cannot see. The client-side lock-out reads the same world-readable `app_settings` row and is honest about it. A middleware that claimed to block hosted Auth would be a false claim. |
| **Notification / configuration health view** | Part 11 asks for a diagnostics view. The console's **Service** section shows maintenance state and who last changed it, and nothing more. `/email/status` and `/notifications/status` exist and are exempt from the gate, but **are not surfaced in the console**. Reported as absent rather than dressed up. |
| **Admin overview / dashboard** | **Not built.** No counts, no charts. Nothing was fabricated to fill the space — an invented dashboard number is worse than an empty screen. |

---

## 7. Bootstrap and recovery

The first administrator cannot be created through the API. `/admin/*` requires an existing administrator, so the first one has to come from outside — a CLI that reads the database directly and is not reachable over HTTP.

```bash
cd apps/backend
npm run bootstrap:admin -- --email <address> --reason "<why>"
npm run bootstrap:admin -- --email <address> --reason "<why>" --recovery
```

Which resolves to `tsx --env-file-if-exists=.env src/scripts/bootstrapAdmin.ts`.

**Requirements:** an account that **already exists** (sign up through the app first), and `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` present in `apps/backend/.env`. The script prints the *names* of any it is missing, never their values. Absent config → exit 1.

**What it does:** `profiles.role = 'admin'` (promote) or `profiles.status = 'active'` (recovery). It **never** creates an account, **never** sets or prints a password, and touches no column other than the one above.

**Truthfulness table:**

| Situation | Result |
|---|---|
| Promote, no active administrator exists | Promotes. Exit 0. |
| Promote, target is already an active admin | *"That account is already an active administrator. Nothing to do."* Exit 0. |
| Promote, **any** active administrator exists | **Refuses.** *"There is already 1 active administrator on this project…"* Exit 1. **Writes no audit row at all.** |
| Promote, target is suspended (not an admin) | Refuses: *"That account is suspended. Reactivate it before making it an administrator, so the privilege is actually usable."* |
| Promote, target is a **suspended administrator** | Refuses, and says what to do: *"…Run again with --recovery to restore it."* |
| Recovery, target is an admin | Restores `status = 'active'`. Works regardless of how many active admins exist. |
| Recovery, target is **not** an admin | Refuses: *"That account is not an administrator, so there is nothing to restore. Restoring it would be a promotion, which this mode does not perform."* |
| No account with that email | Refuses, and tells the operator to sign up first. |
| Audit row cannot be written | *"A privilege change that cannot be recorded does not happen."* |

**One-time-ness is a live count, not a flag.** Promote mode queries `count of profiles where role='admin' AND status='active'` and refuses if it is non-zero. There is no marker file or state row to get out of sync. Recovery mode deliberately does **not** consult the count — its whole purpose is the case where the only administrator is locked out of their own account.

**Recovery when every administrator is locked out:** run `--recovery` against a suspended administrator. If no administrator exists at all, run the promote path. Both are also recorded in the audit log with `actor_id = NULL` and `metadata.actor = 'operator-cli'`, so a human-operated bootstrap is distinguishable from an API action and is **not** mislabelled as having been performed by a user.

---

## 8. Maintenance mode

**One authoritative setting**, `app_settings` row `key = 'maintenance'`, value `{ enabled, message, enabledAt, expectedEndAt }`. Seeded `enabled: false`.

**Read by:** the backend gate (service-role key, so it works for unauthenticated requests), and every client directly — the row is world-readable *by design*, which is what lets a signed-out app know the service is closed.

**Enforced in two places, and the split matters:**

1. **Server** (`gate.ts`): a Fastify hook that answers `503` with the administrator's own message for the endpoints this service owns — transactional email and push dispatch.
2. **Client**: the app shows `MaintenanceScreen` instead of its content, reading the same row.

**Exempt from the server gate:** `/`, `/health`, `/email/status`, `/notifications/status`, and **everything under `/admin`**. Administration comes first in importance: if maintenance mode could block the admin API, turning it off would be impossible except by editing the database by hand — precisely the situation the mode must not create. The status endpoints stay open so that whoever is debugging a closed app can ask whether the service is up without being answered by the maintenance refusal itself.

**Unreadable is not the same as closed.** If the setting cannot be read — a transient failure, or no service key configured — the gate **allows** the request and logs loudly. Answering 503 because maintenance state could not be determined would report an outage that has not been declared, which is inventing operational status. The client takes the same position with an explicit "unreadable" state rather than a guess.

**`enabled === true`, never a truthy coercion.** A stored string `"false"` is truthy in JavaScript; reading it as "the app is closed" would take the whole service down over a malformed row. This is the one parsing decision in the gate that is easy to get wrong and impossible to exercise through an injected reader, so it is exported and tested directly as `parseMaintenanceRow`.

**The countdown is honest.** `MaintenanceScreen` shows a **10-second re-check countdown** — when it reaches zero the screen *re-reads the setting*, it does not unlock. Nothing about maintenance mode is time-based, and no screen implies otherwise.

---

## 9. Announcements

**Stored** in `public.announcements`: `title`, `body`, `severity` (`info` | `warning` | `critical`), `published`, `published_at`, `expires_at`, plus `created_by` and timestamps. Title and body must be non-empty (CHECK constraints), so validation is enforced by the database as well as the API.

**Administrator side:** create as draft or published, publish, unpublish, edit. Every one is audited.

**User side — what a client may see, and it is the same for everyone:**

```
published = true
AND (published_at IS NULL OR published_at <= now())
AND (expires_at  IS NULL OR expires_at  >  now())
```

That predicate is the **RLS policy itself**, not a client-side filter, so a draft or an expired notice cannot be read by an ordinary or anonymous session no matter what the client asks for. Correct unread/dismiss state is tracked per user; the client distinguishes "no announcements" from "could not load" and does not present a cached list as current.

**Not implemented, deliberately:** server-side push dispatch, retry/backoff, delivery receipts, dedup, per-audience targeting, and pagination of the admin list. There is no delivery channel in this project, so dispatch could not be built without inventing one — and inventing delivery is exactly what the brief forbids.

---

## 10. Environment variables — names only

**Never paste values into a document, a chat, a log or source control.**

**Backend** (`apps/backend/.env`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV`, `API_INTERNAL_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `GOOGLE_APPLICATION_CREDENTIALS`.

**Mobile** (`apps/mobile/.env`): `API_BASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (see `.env.example`).

**The service-role key exists only in the backend.** It is never in the mobile bundle, never in the APK, and never sent to a client. The app authenticates with the publishable key and a user token; the backend uses the service key to act.

**Test isolation (worth knowing before you run the suite).** `react-native-dotenv` is a *babel plugin*: it inlines a `.env` file into the bundle **at transform time**. Jest previously inherited whatever credentials the developer had on disk, so a test run issued real HTTPS requests to a live project. `apps/mobile/babel.config.js` now points the `test` environment at `.env.test`, which does not exist — so tests resolve to no Supabase URL and a localhost API base, and make **zero** network calls. This is what makes the suite reproducible on a fresh clone.

---

## 11. Running the tests

```bash
# Backend — Fastify routes, the gate, the audit pair, bootstrap decisions
cd apps/backend
npm test                 # vitest run

# Mobile — screens, the pure decision modules, storage, sync
cd apps/mobile
npx jest
npx tsc --noEmit
npx eslint
```

The mobile suite has one **known, pre-existing flake**: `__tests__/honesty.test.tsx › the voice panel › does not report ready until an engine exists` passes alone in ~180 ms but can exceed the timeout under full-suite load. It takes ~30 s when starved; the test renders once and asserts a string. It is a load-triggered starvation issue in a slow whole-app-render suite, not a logic failure, and it is reported as an open defect rather than papered over with a longer timeout.

---

## 12. Status summary

| Area | Status |
|---|---|
| One identity system (Supabase Auth) | **Live** |
| Server-side permission model, re-read per request | **Live** |
| Last-administrator and self-lockout protection | **Live**, server-side |
| One-time secure first-admin bootstrap + recovery | **Live** (CLI, owner-run) |
| Audited action chain, two-row log, append-only | **Live** |
| User list, search, server-side paging, status filter | **Live** |
| Suspend / reactivate (single and bulk) | **Live** |
| Role change | **Live** |
| Password reset request | **Live** — status is `requested`, not "sent" |
| Announcements: create / publish / unpublish / user read / dismiss | **Live** |
| Announcement push dispatch, retry, targeting | **Not implemented** — no delivery channel exists |
| Maintenance mode, server-enforced with exemptions | **Live** for this service's endpoints; **not gated** for hosted Auth |
| Console: overview dashboard | **Not built** — nothing fabricated |
| Console: notification / configuration health | **Not built** — endpoints exist, not surfaced |
| Termination / deletion | **Not implemented** — no such status exists in the schema |
| Device token registration | **Implemented**; dispatch is not |
