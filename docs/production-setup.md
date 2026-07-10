# Suna Production Setup

This app is ready for a Node web host. Use Render or Railway first, then add Microsoft and Stripe.

## 1. Host The Website

Use Render or Railway. This app is not static-only because it needs `/api` routes for AI tasks, Microsoft login, Stripe webhooks, Mongo sessions, and admin actions.

### Render

Connect the repo and Render will read `render.yaml`.

If creating manually:

```bash
Build command: npm ci && npm run build
Start command: npm start
Health check: /api/health
```

### Railway

Connect the repo and Railway will read `railway.json`.

Required production env before final launch:

```env
NODE_ENV=production
AUTH_REQUIRED=true
APP_BASE_URL=https://YOUR_DOMAIN
ADMIN_EMAILS=you@example.com
MONGODB_URI=...
MONGODB_DB=suna
GROQ_API_KEY=...
```

After the first deploy, copy your public URL. You will use it for Microsoft and Stripe callbacks.

## 2. MongoDB

Create a MongoDB Atlas cluster, then create a database user and copy the connection string.

Required env:

```env
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/suna?retryWrites=true&w=majority
MONGODB_DB=suna
```

## 3. Microsoft OAuth

Create an app registration in Microsoft Entra ID.

Add this redirect URI:

```text
https://YOUR_DOMAIN/api/auth/microsoft/callback
```

Required env:

```env
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=https://YOUR_DOMAIN/api/auth/microsoft/callback
```

## 4. Google OAuth

Create a Google Cloud OAuth client.

Add this redirect URI:

```text
https://YOUR_DOMAIN/api/auth/google/callback
```

Required env:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://YOUR_DOMAIN/api/auth/google/callback
```

## 5. Email Login

Create a Resend account and verify a sending domain.

Required env:

```env
RESEND_API_KEY=...
EMAIL_FROM=Suna <login@YOUR_DOMAIN>
```

## 6. Stripe

Create subscription products/prices for Plus, Pro, Team, and Enterprise.

Add a webhook endpoint:

```text
https://YOUR_DOMAIN/api/stripe/webhook
```

Listen for:

```text
checkout.session.completed
customer.subscription.updated
customer.subscription.deleted
```

Required env:

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PLUS_PRICE_ID=price_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_TEAM_PRICE_ID=price_...
STRIPE_ENTERPRISE_PRICE_ID=price_...
```

## 7. AI Provider

Required env:

```env
GROQ_API_KEY=...
SUNA_BASE_URL=https://api.groq.com/openai/v1
SUNA_MODEL=llama-3.3-70b-versatile
HERMES_BASE_URL=https://api.groq.com/openai/v1
HERMES_MODEL=llama-3.3-70b-versatile
AI_MAX_TOKENS=700
```

## 8. App Settings

Required env:

```env
NODE_ENV=production
AUTH_REQUIRED=true
APP_BASE_URL=https://YOUR_DOMAIN
ADMIN_EMAILS=you@example.com
SESSION_DAYS=30
```

`ADMIN_EMAILS` users become admins automatically after Microsoft login.

## 9. Deploy Commands

Build command:

```bash
npm ci && npm run build
```

Start command:

```bash
npm start
```

Health check:

```text
/api/health
```
