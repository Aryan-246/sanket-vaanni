# Sanket Vaanni — Firebase Integration & Architecture Guide

## 1. Overview & Architecture

Sanket Vaanni integrates Firebase exclusively for **Cloud Messaging (FCM)** and push notifications.

### Architectural Boundaries:
- **Authentication**: Remains 100% on **Supabase Auth**. Firebase Authentication is NOT used as a replacement for Supabase.
- **Database & Storage**: User profiles, preferences, calibrations, OLED layouts, and user media remain on **Supabase** (PostgreSQL + RLS) and local device persistence.
- **Backend Push Dispatch**: The Fastify backend (`apps/backend`) uses the **Firebase Admin SDK** to securely dispatch notifications to device tokens or topics.
- **Web Push**: Prepared for the future **Next.js** dashboard (`apps/web`), requiring the Web Push VAPID public key and a service worker.
- **Zero Secrets in Client**: The Firebase Admin SDK service account key is restricted exclusively to the backend server and is stored completely outside the Git repository.

---

## 2. Server-Side Firebase Admin SDK (`apps/backend`)

### Credential Location
- **Path**: `C:\SanketVaanni-Secrets\sanket-vaanni-firebase-adminsdk-fbsvc-85a1db480a.json`
- **Security Rule**: The service account JSON key is kept outside the repository. It must NEVER be committed to Git, copied into the repository, or bundled into client code.

### Environment Variable
The backend environment loader (`apps/backend/src/config.ts`) reads:
```bash
GOOGLE_APPLICATION_CREDENTIALS=C:/SanketVaanni-Secrets/sanket-vaanni-firebase-adminsdk-fbsvc-85a1db480a.json
```

### Backend Setup Steps:
1. `apps/backend/.env` is gitignored and does not exist in the repository by default.
2. Create `apps/backend/.env` by copying from the template:
   ```powershell
   Copy-Item apps/backend/.env.example apps/backend/.env
   ```
3. Verify that `GOOGLE_APPLICATION_CREDENTIALS` points to the external JSON key file.

### Backend Endpoints:
- `GET /notifications/status`: Returns whether Firebase Admin SDK is initialized without exposing private keys.
- `POST /notifications/send`: Sends a push notification to a device registration token (`{ token, title, body, data }`).
- `POST /notifications/send-topic`: Sends a notification to a topic (`{ topic, title, body, data }`).

---

## 3. Firebase Web Push & VAPID Public Key (`apps/web`)

### Dashboard Framework & Location
- Location: `apps/web`
- Planned Framework: **Next.js + React + Tailwind CSS** (Milestone M8). Currently reserved per project roadmap.

### VAPID Public Key Details
- **Project**: `sanket-vaanni`
- **Sender ID**: `133701606069`
- **VAPID Public Key**:
  `BIGRH2t2swsLDMvusWekItzBJUvpBv0-w_QXtaXJC8PlpXDW9HX3GBuRxb1cYAipsy1NalxpNhLra2YJ7VBb-dw`
- **Environment Variable Name**: `NEXT_PUBLIC_FIREBASE_VAPID_KEY`

### Why the VAPID Key is Needed:
VAPID (Voluntary Application Server Identification, RFC 8292) is a standard mechanism that allows browser push services (Google FCM, Mozilla autopush, Apple Web Push) to verify that push messages received by the browser originate from the authorized application server. The public key is passed to `getToken(messaging, { vapidKey })` during client subscription.

### Service Worker & HTTPS Requirements:
1. **Service Worker File**: Must be placed at `apps/web/public/firebase-messaging-sw.js` so it is served from the root scope (`/firebase-messaging-sw.js`).
2. **Secure Context**: Web Push requires **HTTPS** on all production and remote origins. Browsers only permit unencrypted HTTP on `localhost` for local development.
3. **User Permission**: The browser must explicitly prompt the user for permission via `Notification.requestPermission()` before requesting an FCM registration token.

---

## 4. Mobile App Setup (`apps/mobile`)

- Android Configuration: `google-services.json` is placed in `apps/mobile/android/app/google-services.json` (gitignored).
- Package: `com.sanketvaani`.
