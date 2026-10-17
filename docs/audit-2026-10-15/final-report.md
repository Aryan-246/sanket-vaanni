# Audit and local gap-closure pass — final report

**Date:** 2026-10-15
**Branch:** `3d-hand-viewer-integration` · **HEAD:** `32937ac` · nothing committed, pushed,
deployed or reset.
**Scope:** the ten-point verification and gap-closure directive. Admin phase only, with ML
management inside Admin. The Dashboard was not redesigned.

---

## 0. What this pass did to your repository

Read this first, because the rest of the document is about what is *in* the tree.

**Preserved, not touched:**

- No commit, no push, no deploy, no remote SQL, no production permission or RLS change, no
  production setting change.
- `apps/mobile/.env.local` is **byte-identical** to before the builds
  (`51d25b4e…15d1936`) and no holdout file was left behind.
- `android/app/build.gradle` matches HEAD exactly — the temporary `debuggableVariants` edit was
  reverted by an `EXIT` trap in both builds.
- No secret, password, API key or service-account value appears anywhere in these documents. None
  was requested from you.
- ₹0 spent. No paid service, no billing change.
- Every pre-existing modification and untracked file is still present.

**Added** — six documents under `docs/audit-2026-10-15/`, plus the Admin gap-closure work
described in §3. Nothing outside the Admin surface was edited, and no file under `supabase/`,
`src/middleware/`, or the orb/theme layer was modified.

**Evaluated but deliberately NOT changed** (proposed for your approval in §6): the stale
on-screen claim in `src/audit/findings.ts`, and a missing touch-target guard test.

---

## 1. Headline

**The Admin phase is code-complete against both requirement lists that the directives are
reported to contain — 8 views and 11 capabilities — with two named PARTIALs that are refused by
design rather than left unbuilt.** The two gaps the last report recorded as open (audit-log
filtering, announcement delivery status) are **closed** by this pass.

**Nothing about it has run against the hosted backend or been exercised on hardware.** The
blockers below are the difference between "code-complete" and "working", and that difference is
the whole point of this report.

---

## 2. Remaining blockers, prioritized

Ordered by what would cause the most damage if ignored, not by effort.

### B1 — The release APK is signed with a public key and must not be distributed
**Severity: security. Owner action required. Cannot be fixed here.**

`app-release.apk` is V2-signed with `CN=Android Debug`, SHA-256
`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` — the well-known AOSP debug
certificate, whose private key ships in every Android SDK. Anyone can sign an update to
`com.sanketvaani` that the platform accepts.

This was recorded in earlier documents as a fact without its consequence. The consequence is the
blocker: **the artefact cannot be uploaded to any store or distributed to a user.**

### B2 — Nothing Admin-related can run until the hosted migrations are applied
**Severity: blocking, by owner action only.**

Two separate problems, and they have different fixes:

1. **Migrations 3 and 4 are not applied.** `admin_audit_log`, `announcements`, `app_settings`
   and `device_push_tokens` do not exist in the hosted project, so every Admin flow and the
   admin audit trail have no storage. This is *the* reason the console cannot work.
2. **The five migration-1 tables have no grants.** They exist and answer `42501` (exists, denied)
   rather than `404`. Because `service_role` is *also* denied — and `service_role` bypasses RLS
   entirely — the refusal can only come from the grant layer, not from a policy. The fix is in
   `supabase-grants-and-rls-review.md` §3 and **does not depend on 3 and 4**; it can be applied
   as soon as you approve it.

**A contradiction in the existing record is flagged, not silently resolved:** the Admin-phase
report says all four migrations are unapplied, but a nonexistent table cannot return `42501`. The
probe wins — migration 1 is live. See `contradictions-found.md` C3.

### B3 — Physical glove integration is BLOCKED
**Severity: blocking. Four independent probes, all negative.**

1. `firmware/` contains only two READMEs — no `.ino`, no ESP-IDF, no driver anywhere.
2. `src/ble/bleTransport.ts` is a stub: `scan()` and `connect()` throw `ProtocolUnverifiedError`.
3. Both construction sites in the app are `MockTransport`; `BleTransport` is imported nowhere else.
4. No Bluetooth permission in the manifest and no BLE library in `package.json` — confirmed
   independently by `aapt2` on the shipped release APK.

This blocks roadmap M2, and cascades: with no captures, M3's capture flow, M4's vocabulary and
held-out-signer accuracy, M5's composition, the hardware-in-the-loop test layer, and every
recorded-fixture rule in `testing-strategy.md` are all unreachable.

**No UUID, packet format, sample rate, sensor value, label, model metric or live prediction is
asserted anywhere in this audit.** None can be observed.

### B4 — The Admin console has never been verified on hardware or against the hosted backend
**Severity: high. No device was attached during this pass.**

`adb devices -l` is empty. A handset session *is* on record for the same day (vivo V2141,
Android 14), and it observed the app launching, the Dashboard, the ML centre and an honest
backend-failure notice. It did **not** open the Admin console, sign in, run TalkBack, or exercise
the Service tab, maintenance transitions or a mixed-outcome bulk action.

So "the app runs on a real handset" is true; "the Admin phase is verified on hardware" is not.
**No screenshots were captured this pass**, because there was nothing attached to capture them
from.

### B5 — No accessibility technology has ever been run
**Severity: high for a product whose stated purpose is accessibility.**

TalkBack has never been executed against this app. Dynamic-type scaling *is* guarded by a test,
and `MIN_TOUCH_TARGET = 48` is applied across the design system — but labels, roles and reading
order are source claims. Contrast ratios are documented, not tested. No per-milestone
accessibility review is recorded.

### B6 — A stale on-screen statement understates what leaves the device
**Severity: high, user-facing. Flagged, not fixed.**

`src/audit/findings.ts:637-641` shows the user that nothing is sent anywhere today. Supabase
sync, auth and the admin client all send data now. This is the only contradiction in the register
that misleads an **end user** rather than a maintainer, and it errs in the direction the project's
honesty rule forbids. `src/audit/` belongs to another workstream, so it is proposed in §6 rather
than edited.

### B7 — Termination semantics cannot be built as specified
**Severity: medium. Requires a product decision.**

`profiles.status` is `CHECK ('active','suspended')` and there is no delete route. Termination is
therefore neither offered nor claimed — the correct behaviour, and still an unmet requirement.
Resolving it means choosing between adding real deletion (with a policy on the Supabase Auth
identity) or formally amending the requirement to status-change-only.

### B8 — Smaller confirmed gaps
- **Announcement targeting** does not exist; announcements are global.
- **The `/admin/announcements` list is unpaginated** (`admin.ts:636-647`) while the users list is.
- **`expectedEndAt` is stored but never enforced**, and no scheduler exists — a maintenance window
  does not end by itself.
- **The contracts package is unwired** — `packages/contracts` is types-only and imported by no
  application, so the contract test layer has nothing to test.
- **No telemetry code**, and **no privacy review** on record, though sync and admin now send data.
- **`apps/web`** (M8) is an untouched placeholder.
- **Four pre-existing lint errors** in the orb/theme layer (another workstream); the count is
  unchanged by this pass.

---

## 3. What this pass closed (local, implemented, tested)

| Gap (from the previous report) | Now |
|---|---|
| Audit-log filtering — backend accepted `action`/`targetType`/`targetId`/`from`/`to`, UI exposed only acted-by + free text (`admin-phase-final-report.md:41`) | **Closed.** `src/admin/auditFilters.ts` builds and clears the full filter set; `__tests__/admin-audit-filters.test.ts`. |
| Announcement delivery status — dispatch existed server-side with nothing in the UI allowed to claim delivery (`:42`) | **Closed.** `AnnouncementsSection` reads the durable `dispatch_announcement` audit rows through the endpoint it already calls and renders a per-notice badge via `src/admin/lastDispatch.ts`. |

Both were closed **without editing shared backend permission files** — the delivery status reads
through `/admin/audit`, which the console already calls. That was deliberate: it respects the
database-permission workstream's ownership boundary while still closing the gap.

### The honesty boundary in the delivery badge

The durable badge is deliberately **weaker** than the live one, for a specific reason: the service
audits a `complete` dispatch that reached **zero registered devices** as `succeeded`. So
`succeeded` does not mean "sent", and the badge says:

- `succeeded` → **`Recorded: not confirmed`** (never "Sent" or "Notified" — those are the same
  claim with a softer word, and a badge is scanned, not read)
- `failed` → a distinct badge, warning tone
- no dispatch row → **`No recent attempt`**
- audit log unreadable → **`History unread`**, rather than implying no attempt occurred
- tone is **never** `success`

`loggedDispatchBadge` was originally `'Notified: not confirmed'`. My own test caught it — "Notified"
reintroduces the claim being denied, in a word the eye reads as the claim.

---

## 4. Test and static-check results

Re-run against the current tree. Full detail in `tests-static-checks-and-apk.md`.

| Check | Result |
|---|---|
| Mobile Jest | **54 suites / 1027 tests, all passing** |
| Mobile `tsc --noEmit` | **exit 0** |
| Backend Vitest | **8 files / 171 tests, all passing** |
| Backend `tsc --noEmit` | **exit 0** |
| Backend `npm run build` | **exit 0** |
| Mobile `eslint .` | **4 errors, 109 warnings** — unchanged from baseline, all four in the orb/theme workstream |
| Disabled tests (`skip`/`only`/`xit`/`todo`) | **none** in either suite |

**Guard-test integrity was checked by mutation, not assumed.** Removing the action filter from the
new `latestDispatchPerAnnouncement` left all 27 tests passing — the test was vacuous, because both
fixture rows shared an outcome. The fixture was fixed to distinguish the rows and the mutation
re-run to **1 failure**. That defect was in my own work and is recorded rather than quietly fixed.

**A green suite proves much less than it appears to.** No live backend was contacted, no email was
sent, no push was delivered, no BLE traffic occurred, no ML inference ran, and no accessibility
technology was run. All backend tests execute against in-process fakes. No test was weakened to
reach this result, and no working integration was replaced by a mock.

---

## 5. APK artefacts

Both rebuilt from the current tree. Non-destructive: `.env.local` held aside for the hosted
dotenv cascade, bundle intermediates deleted so JS is re-embedded, everything reverted by an
`EXIT` trap — verified by hash and by an empty `build.gradle` diff against HEAD.

| | Debug | Release |
|---|---|---|
| Path | `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` |
| Size | 146,571,403 bytes | 70,683,391 bytes |
| SHA-256 | `eda2d7c4d0cdf213a46259b756aa540d090b73be1f47d9a1f41fb25e0f39433c` | `69512622704f17f523b2f980a8b9931c74a2d1ead86a0e42b27e673fe10be18f` |
| Signature | V2, debug cert | V2, **debug cert** (`fac61745…`) |
| Package | `com.sanketvaani` v1 (1.0), targetSdk 36 | same |

**The release hash in earlier documents (`a11eaf32…`) is superseded** — the Admin work landed
after those were written.

Read out of the shipped release artefact rather than the source:

- **Hosted config present:** `sanket-vaanni-backend.onrender.com`, `mmovhldjwadvljxtloes.supabase.co`.
- **Zero loopback endpoints.** Every scheme- or port-qualified form (`http://127.0.0.1`,
  `127.0.0.1:4000`, `127.0.0.1:54321`, `10.0.2.2`, `localhost:4000`, `localhost:54321`) is 0. A
  bare `127.0.0.1` does match inside the packed asset table, but the surrounding bytes are palette
  hex — recorded as a **false positive in packed data**, not an endpoint.
- **The new Admin strings are present** (`Recorded: not confirmed`, `No recent attempt`,
  `History unread`, `dispatch_announcement`), so the artefact reflects the work, not a stale bundle.
- **No Bluetooth permission of any kind** — independent confirmation of B3.

None of this is evidence that the hosted services respond.

---

## 6. Owner actions — exact

Ordered. Nothing below was done for you.

**A. Apply the database changes (unblocks the entire Admin system).**
1. Review `docs/admin-migration-checklist.md` and apply migrations **3 and 4** in the order it
   gives.
2. Then review `docs/audit-2026-10-15/supabase-grants-and-rls-review.md` §3 and apply the
   least-privilege grant block. It is written inside a transaction and does not depend on 3/4.
3. Run its §5 verification queries — query 4 is the before/after on the recorded failing probe,
   query 6 the self-promotion refusal.
4. §6 holds the rollback SQL. **Read its warning first: rolling back restores a broken state.**

**B. Create the first administrator.** After A, run the bootstrap script
(`admin-bootstrap.md`, `apps/backend/src/scripts/`). It promotes an **existing** Supabase Auth
identity and refuses if any active administrator exists. Do not put a credential in this chat.

**C. Fix the signing blocker.** Obtain or generate a release keystore you control and re-sign.
This is the only blocker that cannot be closed by a code change, and it cannot be closed from
inside this session — a key generated here would have to be handed to you, which is not how
signing keys should change hands.

**D. Attach a device and run the checks that need one.** Install the debug APK
non-destructively, then: the Admin console against the hosted backend, TalkBack on the primary
flows, maintenance on/off transitions, a bulk action with a mixed outcome, and the Service tab —
none of which has ever been exercised.

**E. Decide two product questions.**
- **Termination (B7):** add real deletion with an Auth-identity policy, or formally amend the
  requirement to status-change-only.
- **Glove (B3):** supply firmware and a verified protocol, or formally descope hardware for now.
  If you supply a capture, M3/M4 and the fixture rules all unblock.

**F. Approve or decline the two items I did not change:**
1. Fix the stale on-screen claim in `src/audit/findings.ts:637-641` (B6 — it currently understates
   what leaves the device).
2. Add a test asserting the 48 dp touch-target floor. Four controls are under 44 dp visually and
   rely entirely on `hitSlop` (`IconButton` 36+16, `Sheet` close 32+24, `HandViewer` chip 40+16,
   `Toggle` track 28+24 — each ≥ 48 today, none guarded). `testing-strategy.md:60` requires the
   rule and no test enforces it. I left this alone because those are shared normal-user components,
   outside the Admin-phase scope I was given.

**G. Optional cleanup:** the stale documents in `contradictions-found.md` (C4–C6, C8, C12–C14)
misreport finished work as absent. A one-line "superseded by" header on each would stop the next
reader re-doing it.

---

## 7. Screenshots and evidence

**No screenshots were captured in this pass.** No device was attached, and the directive is
explicit that visual or physical-device verification must not be claimed when the device is
unavailable. Nothing in this report claims otherwise.

What exists instead is **artefact-level and source-level evidence**, all of it reproducible from
the commands in `tests-static-checks-and-apk.md` §6: extracted bundle bytes, `aapt2` manifest and
signature output, file-and-line citations for every claim, and test output with commands.

The only on-device evidence in the repository is the earlier session's, and it is attributed to
that document rather than absorbed into this one.

**No proposed Dashboard changes.** The Dashboard was reviewed, not redesigned, and has no pending
visual proposals.

---

## 8. The audit documents

Under `docs/audit-2026-10-15/`:

| File | Covers |
|---|---|
| `requirement-matrix.md` | §3 — every requirement against file-and-line evidence; 8 views, 11 capabilities, `admin-system.md`, roadmap M2–M8, task-f 1.1–14, every `testing-strategy.md` rule, glove permissions |
| `tests-static-checks-and-apk.md` | §7 — suites, static checks, guard-test mutation, both APK hashes, signature, embedded config, what green does not prove |
| `supabase-grants-and-rls-review.md` | §8 — grants/RLS as local files, least-privilege plan, rollback, owner approval steps |
| `ble-and-firmware-verification.md` | §6 — the four probes behind the BLOCKED verdict, and the unblock list |
| `mobile-screen-and-navigation-review.md` | §5 — 12 screens, navigation graph, state table, touch targets, theming, clipping, 8 ranked findings |
| `contradictions-found.md` | 14 contradictions in the existing record, with the reading this audit follows and why |

---

## 9. Limits of this report

Stated so nothing here is over-read:

- **The two governing directive documents are not in this repository** (§0.3 of the matrix). Every
  requirement traces to a list transcribed inside the repo — 8 views and 11 capabilities. If that
  transcription is incomplete, the matrix is incomplete the same way.
- **The matrix is only as current as this working tree.** It reflects uncommitted work; a commit
  or a further edit changes it.
- **"Verified" here means read from a file or an artefact, not observed running.** Where a claim is
  source-only, the row says so.
- **No hardware was available.** One requirement in the whole matrix is hardware-verified, and it
  is hardware-verified by an *earlier* document, not this pass.
- **Where two documents disagree, this report says which it follows and why** — it does not average
  them. Those choices are in `contradictions-found.md` and can be overturned by you.

---

**This audit and local gap-closure pass is complete. Stopping here for your review.**
