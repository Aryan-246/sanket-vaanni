# SANKET VAANNI — NEXT SESSION QUICK-START CHECKLIST

**Document:** `docs/NEXT_SESSION_CHECKLIST.md`  
**Target:** Fast onboarding for the incoming developer on the friend's laptop  

---

## 1. Quick Checkout & Toolchain
- **Git Repo:** `https://github.com/Aryan-246/sanket-vaanni.git`
- **Branch:** `3d-hand-viewer-integration`
- **Node.js:** `>= 20.x` (Workstation verified: `v24.16.0`, npm `11.13.0`)
- **JDK:** OpenJDK 17 (`JAVA_HOME` pointing to JDK 17)
- **Android SDK:** API 34-37 with Build Tools 37.0.0

---

## 2. Environment Setup (Out-of-Band)
- Do NOT commit `.env` files to git.
- Create `apps/mobile/.env` from `apps/mobile/.env.example`.
- Create `apps/backend/.env` from `apps/backend/.env.example`.
- Obtain the real `SUPABASE_SERVICE_ROLE_KEY` and `BREVO_API_KEY` directly from the owner.

---

## 3. Verify Baseline
Run these two commands immediately to verify baseline integrity:
```powershell
# Mobile Tests (Expect 61 suites, 1113 tests passed)
cd apps/mobile
npm test

# Backend Tests (Expect 13 suites, 269 tests passed)
cd ../backend
npm test
```

---

## 4. Release APK Artifact
If physical device testing is needed without a local Android build:
- **Location on build workstation:** `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- **File Size:** 71,668,475 bytes (~71.67 MB)
- **SHA256 Checksum:** `DB449752CC4A483ADB6D996E6879CE07C9292E98798166D0ED807CC181EFCCB6`
- **Installation Command:**
  ```powershell
  adb install -r app-release.apk
  ```

---

## 5. Hosted Supabase Migration: COMPLETE & VERIFIED ✅
- **Status:** The owner has executed `PRODUCTION_MIGRATION_CONSOLIDATED.sql` on the hosted Supabase database.
- Backend bootstrap verified: `npm run bootstrap:admin` returned `Nothing to do.` (Admin role active on production).
- Notices table, Push tokens table, Admin audit log, and role permissions are now active in the cloud.

---

## 6. Priority 1 for Next Session: Real Dual Glove ML Capture & Inference
- Connect dual ESP32-S3 gloves (`Sanket-Left` on COM10, `Sanket-Right` on COM11).
- Open ML Studio (unlocked under Settings/Admin), capture 5 repetitions for each of the 6 canonical signs (`HELLO`, `BYE`, `THANK YOU`, `YES`, `NO`, `REST`).
- Train model, verify live prediction on Dashboard, and confirm auto-speak with REST transition lock.
- Verify stability and zero crashes during repeated glove reconnect cycles.
