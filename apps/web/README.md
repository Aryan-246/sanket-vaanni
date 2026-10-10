# `apps/web` — reserved (not built in this milestone)

Placeholder for the future **Next.js + React + Tailwind CSS** dashboard.

Per the milestone brief, this application is deliberately **not** implemented
yet. It will not be an end-user signing surface — the signing loop is on-device
and offline-first. The dashboard is planned as a research and administration
surface:

- sign-language vocabulary curation and review
- dataset inspection and labelling QA
- model comparison and evaluation reporting
- (later, with consent) aggregate telemetry

See `docs/roadmap.md` milestone **M8**.

## Why the directory exists now

So that the repository layout communicates the intended architecture, and so
that `docs/architecture.md` has something to point at. Creating it now signals
intent; building it now would violate "no premature infrastructure".

**Do not scaffold Next.js here until M8.** When that happens, this README is
replaced.
