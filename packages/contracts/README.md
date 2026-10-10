# `packages/contracts`

Transport-independent API and data contracts shared between Sanket Vaanni
applications.

## Status in this milestone: defined, deliberately NOT consumed

This package is **types-only and dependency-free**. As of M1, neither
`apps/mobile` nor `apps/backend` imports it. That is a deliberate decision, not
an oversight:

- The milestone brief requires mobile and backend to remain **separately
  buildable and runnable**.
- `apps/mobile` builds with Metro, which resolves modules relative to the app
  root. Importing across `../../packages/contracts` requires extra Metro
  `watchFolders` + `extraNodeModules` configuration and a React Native
  transpilation story for the shared source.
- Doing that in M1 to share **one** five-field health response would add build
  fragility for near-zero benefit.

So this package currently serves as the **canonical written contract**: the
single place where the shape of API payloads is agreed and reviewed. The
backend mirrors it locally in `src/routes/health.ts`; the mobile app mirrors the
subset it needs.

## When to actually wire it in

Wire it up when **both** are true:

1. There is a second consumer with a real need (the `apps/web` dashboard in M8
   is the likely trigger), **and**
2. The shared surface is large enough that hand-mirroring is causing real drift.

At that point, prefer one of:

- **Publish the package** to a private registry and depend on a version, which
  keeps every app's build independent; or
- **Switch to a workspace tool** (npm workspaces / Nx / Turborepo) and accept
  the shared build graph.

Do not solve it with relative-path imports and hope.

## Contract rules

1. **No runtime code.** Types and constants only. A runtime dependency here
   would leak into every app that consumes it.
2. **No hardware lies.** Do not define a `GloveFrame` wire type until the
   firmware protocol is verified (`docs/ble-protocol.md`). A type that looks
   authoritative is worse than no type.
3. **Version explicitly.** Breaking changes get a new type name or a version
   field, never a silent edit.

## Contents

| File | Holds |
|---|---|
| `src/index.ts` | API contracts that exist today (health, service info) |
| `src/sensor.ts` | Reserved. Currently empty of wire types, on purpose — see rule 2 |

## Scripts

```powershell
npm run typecheck
```

There is no build step: `src/*.ts` is the deliverable and consumers compile it.
