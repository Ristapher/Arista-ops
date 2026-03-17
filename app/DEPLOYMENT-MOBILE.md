# Arista Ops mobile deployment necessities

## What this frontend now expects
- One public HTTPS backend base URL: the deployed Cloudflare Worker
- Optional Worker API token via `VITE_API_AUTH_TOKEN`
- Email sends go through `POST /api/send-invoice-email` on the Worker
- The frontend no longer needs to call the email service directly

## Required frontend environment variables
- `VITE_API_BASE_URL=https://YOUR-WORKER-URL.workers.dev`
- `VITE_OWNER_EMAIL=aristaplumbingllc@gmail.com`
- `VITE_API_AUTH_TOKEN=replace-with-worker-api-token-if-enabled`

## Required backend state
The Worker must provide:
- `GET /api/health`
- `GET /api/state`
- `POST /api/state`
- `POST /api/send-invoice-email`

If Worker auth is enabled, it must accept:
- `x-api-token`

## Operational goal
For iPhone/iPad use anywhere, normal usage should only depend on:
- the deployed static frontend over HTTPS
- the deployed Worker over HTTPS
- the hosted email service behind the Worker

## Still required for full offline-first production use
- IndexedDB-backed live local cache wiring in the app UI
- queued mutation replay after reconnect
- real login/session auth
- final production CORS/origin lockdown
- secret rotation for any exposed values
