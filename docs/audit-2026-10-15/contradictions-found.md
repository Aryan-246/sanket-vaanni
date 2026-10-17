# Contradictions found in the existing record — 2026-10-15

The repository contains a large number of status documents written at different times by
different workstreams. Several of them contradict each other, and **nothing in the repository
tells a reader which of two conflicting documents is current**. That is a distinct risk from
any single missing feature: a stale claim about work already done reads exactly like a current
one.

Each entry below was verified directly against the file and line cited. When two documents
disagree, the entry states **which reading this audit follows and why**, rather than averaging
them or picking the more flattering one.

---

## C1 — Mobile test totals disagree across five documents

| Document | Claims |
|---|---|
| `docs/final-delivery-report.md:129` | 481 mobile tests |
| `docs/task-f-final-report.md:222` | 623 tests across **38** files |
| `docs/glove-input-layer.md:37` | 886 tests, all passing |
| `docs/admin-phase-final-report.md:122` | 938 tests |
| **measured on the current tree** | **1027 tests across 54 files** |

Backend totals disagree the same way: `docs/task-f-final-report.md:206` records **121 tests in
6 files**; `docs/admin-phase-final-report.md:123` records **171**; the current tree has **171
across 8 files**.

**This audit follows the measured figure**: 54 mobile suites / 1027 tests and 8 backend files /
171 tests, both re-run against the current tree and recorded with their commands in
`tests-static-checks-and-apk.md`.

**Not a contradiction, but worth naming:** rising counts are expected work, not error. The
problem is that no document says it supersedes an earlier one, so five different totals are all
presented as *the* total.

---

## C2 — "No phone was connected" vs "the app was exercised on a phone", same day

`docs/admin-phase-final-report.md:168` states:

> `adb devices -l` → **empty device list**. No phone was connected during this phase

and `:240` elevates it to a blocker:

> **D2 — No phone was connected (blocking).** No install, no startup, no connectivity evidence.

But `docs/device-verification-2026-10-15.md:7` records a handset attached from approximately
17:20 to 17:27 on the **same date**, and `docs/task-f-final-verification-report.md:294` records
Admin flows exercised on that device over `adb reverse`, including verified refusals (last active
administrator cannot be suspended or demoted) surfaced on-device.

**Both documents are defensible about different things, and neither says so.** The Admin-phase
report's statement is correct about *the window in which it was written* and correct about *the
Admin phase* — the device session never opened the Admin console. It is wrong as a statement
about the day, and a reader has no way to know that.

**This audit follows:** the app *has* run on a real handset; the **Admin phase has not**. That is
the reconciliation, and it appears in `requirement-matrix.md` §0.2 and
`tests-static-checks-and-apk.md` §7.

---

## C3 — Migration 1 applied or not applied

`docs/admin-phase-final-report.md:108` states all four migrations exist and are
**"none applied to the hosted project"**, repeated at `:286`. `docs/admin-migration-checklist.md:4`
reinforces it: "**NOTHING IN THIS DOCUMENT HAS BEEN RUN.**"

`docs/integration-status-2026-10-15.md:56-60, :63` records the opposite for migration 1: the base
tables answer `42501` (exists, permission denied) rather than `404`/`42P01` (does not exist).

A nonexistent table cannot return `42501`. **The probe wins.** The tables exist, so migration 1 is
applied and the base-schema tables exist while being ungranted.

**This audit follows the probe**, as already recorded in `supabase-grants-and-rls-review.md` §0,
which states the contradiction explicitly rather than resolving it silently. Consequence, and the
reason this matters: the least-privilege grant fix in that document's §3 can be applied
**without waiting** for migrations 3 and 4, whereas the Admin system as a whole cannot run until
they are applied.

---

## C4 — Announcement push dispatch reported absent; it exists

`docs/task-f-final-report.md:271-273` (D2) and `:358` state that announcement push dispatch is
absent and that "no delivery channel exists".

**Now false.** `apps/backend/src/announcements/dispatch.ts`, the route
`/admin/announcements/:id/dispatch` (`apps/backend/src/routes/admin.ts`), `services/firebase.ts:105`
`sendPushNotification`, the mobile reporter `src/admin/dispatchReport.ts`, and migration 4's
`device_push_tokens` table all exist.

What remains true from that finding: delivery is never claimed
(`dispatchReport.ts` refuses `deliveryConfirmed !== false`), and the `/admin/announcements` list
is unpaginated (`admin.ts:636-647`).

---

## C5 — Admin views 1 and 7 reported absent; both exist

`docs/task-f-final-report.md:283-285` (D5) and `:361` state that view 1 (overview) and view 7
(configuration health) are absent.

**Now false.** `AdminScreen.tsx:131-138` renders six sections including `overview` and `service`,
and "Configuration health" is at `AdminScreen.tsx:2247-2280`.

---

## C6 — `docs/admin-system.md` misstates the Admin surface

| Claim | Actual |
|---|---|
| "Twelve endpoints" | **15** `/admin/*` routes |
| "seven writes" | **eight** |
| Overview "Not built" | built — `OverviewSection`, `overviewFigures.ts`, `GET /admin/overview` |
| Health "Not built" | built — `GET /admin/health`, `AdminScreen.tsx:1756` |
| Push dispatch "Not built" | built — see C4 |

This document is the one most likely to be read as the Admin system's specification, which makes
its stale rows the most misleading of the set.

---

## C7 — The app tells the user nothing is sent; the app sends data

`apps/mobile/src/audit/findings.ts:637-641` renders the statement that no screen calls the network
layer, *"so nothing is sent anywhere today."*

Supabase sync, Supabase auth and the admin client all send data now.

**This is the most serious contradiction in this register**, because it is not a stale document
read by a developer — it is a **stale statement shown to the user on screen**, and it
*understates* what leaves the device. The project's own honesty rule requires the opposite
direction of error. Flagged for a fix rather than fixed here: `src/audit/` belongs to another
workstream. Recorded again in `requirement-matrix.md` §10.

---

## C8 — `apps/mobile/src/ml/README.md` describes an ML layer that no longer matches

`ml/README.md:10-12` claims the app ships an `UnimplementedRecogniser` whose `recognise()` always
returns null — still literally true (`src/recognition/index.ts:69-81`) — and that there are
"deliberately no metrics".

The second half is stale: `src/ml/metrics.ts` is a working honest-metrics implementation, and
`src/ml/` contains a full pipeline. The README understates the ML layer in the same way C7
understates the network layer.

---

## C9 — `docs/ble-protocol.md` states a protocol that no device can speak

`ble-protocol.md:1-17` labels the protocol "PROPOSED, NOT YET VERIFIED". Documents that describe
UUIDs, packet layout or sample rates elsewhere in the repository therefore describe a **proposal**,
not an observed interface.

No firmware exists to contradict it, because `firmware/left-glove/` and `firmware/right-glove/`
contain only READMEs. The contradiction is latent rather than realised: the risk is a future
reader treating the proposed UUIDs as real. This audit asserts **no** UUID, packet format, sample
rate, sensor value, label or metric — see `ble-and-firmware-verification.md`.

---

## C10 — "15 Admin areas" has no source

The figure "15 Admin areas" appears in discussion but **is not supported by any document in the
repository**. The real requirement lists are **8 Admin views (PART 11)** and **11 Admin
capabilities (§2)**, as transcribed in `docs/admin-phase-final-report.md:34-61`. The matrix in
`requirement-matrix.md` is built on those two lists.

---

## C11 — The two governing directives are not in the repository

Both *SANKET VAANNI — MASTER ADMIN SYSTEM + GUEST MIGRATION COMPLETION* and *SANKET VAANNI —
FINAL PRODUCT COMPLETION DIRECTIVE* are referenced (`docs/admin-phase-final-report.md:22, :30`) but
their text is absent.

Nothing can be checked against them line by line. Every requirement in this audit traces to a
requirement list **as transcribed inside the repository**, and the matrix says so in §0.3. If the
transcription is incomplete, the matrix is incomplete in the same way.

---

## C12 — The release APK hash in the record is now stale

`docs/admin-phase-final-report.md:106`-area and `docs/apk-verification-2026-10-15.md` record a
release APK of 70,665,851 bytes with SHA-256 `a11eaf32…465758`.

The current tree produces a **different** release artefact — 70,683,391 bytes, SHA-256
`69512622…0be18f` — because the Admin work landed after those documents were written.

A reader who verifies a download against the recorded hash will get a false mismatch. The current
hash is recorded in `tests-static-checks-and-apk.md` §5.3. The earlier hash is superseded, not
wrong for its time.

---

## C13 — "Release APK" does not mean releasable, and only one document implies it

`docs/apk-verification-2026-10-15.md` and `docs/admin-phase-final-report.md` both correctly record
that the release APK is signed with the debug keystore. Neither draws the consequence.

That consequence is the blocker: the debug key is public and shipped in every Android SDK, so the
ARTEFACT IS NOT DISTRIBUTABLE and anyone can produce an accepted update to `com.sanketvaani`. This
is stated as a hard blocker in `tests-static-checks-and-apk.md` §5.4 and
`final-report.md` blocker 1.

---

## C14 — `docs/admin-migration-checklist.md` and `admin-phase-final-report.md` give different
    starting states for the same deploy

The checklist (`:45`) tells the owner to "stop and reconcile rather than re-running them blind" if
migrations 3 or 4 already appear applied, and asserts at `:4` that nothing has been run. The
Admin-phase report asserts nothing was applied anywhere.

Neither document accounts for the probe evidence in C3 that migration 1 is already live. An owner
following either document from a clean assumption will be surprised by the existing tables.

---

## Summary

| # | Nature | Reader impact |
|---|---|---|
| C1 | Stale counts | Cannot tell the current suite size |
| C2 | Conflicting device claims | Over- or under-claims hardware verification |
| C3 | Conflicting migration state | Wrong starting assumption for the deploy |
| C4, C5 | Work reported absent that exists | Owner may re-do finished work |
| C6 | Spec document misstates the surface | Endpoint and write counts wrong |
| **C7** | **Stale on-screen claim to the user** | **Understates data leaving the device** |
| C8 | Stale README | Understates the ML layer |
| C9 | Proposal presented as interface | Risks invented protocol detail |
| C10 | Unsupported figure | Unauditable requirement list |
| C11 | Missing governing text | Matrix cannot be exhaustive |
| C12 | Superseded artefact hash | Download verification false-negatives |
| C13 | Correct fact, missing consequence | Distributable artefact assumed shippable |
| C14 | Different deploy starting states | Owner confusion mid-deploy |

C7 is the only one that misleads an **end user** rather than a maintainer, and is recommended for
the first fix.
