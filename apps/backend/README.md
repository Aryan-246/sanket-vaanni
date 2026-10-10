# Sanket Vaanni — Backend

Standalone Node.js + TypeScript + Fastify REST API.

This application is **independently buildable, startable and deployable**. It has
its own `package.json`, dependency tree, environment configuration and scripts,
and it shares no workspace tooling with `apps/mobile`. You can delete
`apps/mobile` and this still runs.

> **Scope.** This milestone delivers a foundation: configuration, a working
> `/health` endpoint and tests. There is deliberately **no** gesture
> recognition, **no** glove BLE handling and **no** database. The firmware
> protocol is unverified (see `docs/ble-protocol.md`), so any endpoint that
> pretended to interpret glove data would be fiction.

## Requirements

- Node.js **≥ 22.11.0** (developed against v24.16.0)
- npm

## Setup

```powershell
cd apps\backend
npm install
Copy-Item .env.example .env    # optional; defaults work without it
```

## Run

```powershell
npm run dev      # tsx watch, reloads on change — http://127.0.0.1:4000
npm start        # production: requires `npm run build` first
```

Then:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/health
```

```json
{
  "status": "ok",
  "service": "sanket-vaanni-backend",
  "version": "0.1.0",
  "uptimeSeconds": 3,
  "timestamp": "2026-10-10T09:15:00.000Z"
}
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Watch-mode dev server with `.env` loaded |
| `npm run build` | Type-check and emit to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Types only, no emit |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |
| `npm run clean` | Remove `dist/` |

## Configuration

All configuration is environment-driven — see `.env.example`. Nothing is
hardcoded and there are no secrets in this project yet.

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to reach it from a physical phone on the same Wi-Fi |
| `PORT` | `4000` | Keep in sync with the mobile app's `API_BASE_URL` |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `LOG_LEVEL` | `info` | pino level |

Invalid values (e.g. a non-numeric `PORT`) **fail startup** rather than silently
falling back to a default, so a misconfiguration is never mistaken for success.

`.env` is loaded by Node itself via `--env-file-if-exists=.env`, so there is no
`dotenv` dependency.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Service identity and available endpoints |
| `GET` | `/health` | Liveness — process facts only |

### Why `/health` reports so little

It reports service name, version, uptime and timestamp. It does **not** report
BLE status, database status or model status, because none of those exist. A test
asserts that these fields stay absent, so the endpoint cannot quietly start
claiming capabilities that are not implemented.

## Structure

```
apps/backend/
├── src/
│   ├── server.ts          entry point — the only file that binds a port
│   ├── app.ts             buildApp(config) — testable, no port binding
│   ├── config.ts          environment parsing and validation
│   ├── version.ts         service identity constants
│   └── routes/
│       ├── health.ts      GET /health
│       └── root.ts        GET /
├── test/
│   ├── health.test.ts     route behaviour via app.inject()
│   └── config.test.ts     config parsing and rejection
├── .env.example
├── tsconfig.json          typecheck config (src + test)
└── tsconfig.build.json    build config (src only → dist/)
```

`app.ts` is split from `server.ts` so tests can exercise real routing through
`app.inject()` without binding a port.

## Deploying

`npm ci && npm run build && npm start`. The build output is plain ESM in
`dist/` with source maps and declarations. No build-time secrets are baked in.

## Not yet present (and why)

| Missing | Reason |
|---|---|
| Database | No requirement yet. Planned for M6/M7 — see `docs/roadmap.md` |
| Auth | No user accounts yet |
| CORS | Only needed once `apps/web` exists |
| Rate limiting | No public traffic yet |
| Docker | No deployment target decided |
