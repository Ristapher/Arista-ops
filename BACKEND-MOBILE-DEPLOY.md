# Backend mobile deployment

## What changed

- Worker now supports optional `x-api-token` protection using `API_AUTH_TOKEN`
- Worker now supports comma-separated `ALLOWED_ORIGIN`
- Worker now exposes `POST /api/send-invoice-email`
- Worker proxies invoice/receipt email to the hosted email service using server-side secrets
- Email service is ready for hosted deployment with `gunicorn`

## Minimum production setup

### 1. Deploy the email service
Host `email-service/` on Render, Railway, Fly.io, or another HTTPS host.

Required environment variables:
- `SMTP_SERVER`
- `SMTP_PORT`
- `SMTP_USERNAME`
- `SMTP_PASSWORD`
- `SENDER_EMAIL`
- `SENDER_NAME`
- `REPLY_TO_EMAIL`
- `COMPANY_NAME`
- `COMPANY_PHONE`
- `SERVICE_API_KEY`
- `ALLOWED_ORIGIN`
- `PORT`

### 2. Configure Worker secrets
From `api/`:

```bash
wrangler secret put API_AUTH_TOKEN
wrangler secret put EMAIL_SERVICE_URL
wrangler secret put EMAIL_SERVICE_API_KEY
```

`EMAIL_SERVICE_URL` should be the public base URL of the hosted email service.

### 3. Set Worker origins
In `wrangler.toml`, set:

- `ALLOWED_ORIGIN` to your frontend HTTPS domain and any dev domain
- `OWNER_EMAIL` to the single owner account

### 4. Deploy Worker
```bash
npm run deploy
```

### 5. Frontend change still required
Point the frontend email action to:

- `POST /api/send-invoice-email`

instead of calling the email service directly.

It should also send:
- `x-api-token` when `API_AUTH_TOKEN` is configured

## Offline reality

Offline-capable means:
- the app opens and edits locally without internet
- queued saves sync later
- email sends queue locally and send later

It does **not** mean email can actually leave the device while offline.
