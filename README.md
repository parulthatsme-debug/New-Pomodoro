# AIAPGET 2027 · Physical-style Clock Pomodoro

Mobile-friendly, installable, client-side study timer inspired by the user's reference clock.

## Included
- Physical-style clock body, analog time hands and date/calendar panel (Asia/Kolkata).
- Animated red Pomodoro progress ring on a 60-minute scale: elapsed minutes advance counter-clockwise, while the real clock hands move clockwise. Focus timer defaults to 60 minutes; custom durations (1–240 minutes) are supported and remembered.
- Pause, resume, reset and manual stop.
- Break scheduler with fixed 15-minute short break and 60-minute long break. Choose a future start time; at that time, the running focus is interrupted and break begins. When break ends, another focus session starts automatically.
- Session history, break history, daily target (default 7 focused hours), daily/weekly/monthly KPI cards and charts.
- Local browser autosave, once-per-day local snapshots (up to 30) with restore, JSON export/import, session CSV export.
- Optional Google Drive backup through Google OAuth (drive.file scope).

## Important persistence / timing limits
- Local data is in the current browser's `localStorage`; it does not automatically sync across devices.
- Daily browser snapshots live on the same device and can be lost if browser site data is cleared. Download JSON backups periodically.
- Google Drive integration is optional. It requires a Google OAuth Web Client ID, the Google Drive API enabled, and this GitHub Pages origin added as an Authorized JavaScript origin. No client secret is used in the web app.
- Drive OAuth access tokens are kept in page memory only. Auto-sync runs while the page is open and token remains valid; tokens expire, so you may need to reconnect. The app syncs a latest backup and one daily snapshot file in your Drive. The page also includes a Restore latest action to recover the latest Drive backup on this device.
- A static browser app cannot reliably execute alarms while fully closed or suspended by mobile OS battery management. On reopen, state is reconciled as far as possible; scheduled timer transitions require the page to be active.

## Publish with GitHub Pages
1. Create a repository, e.g. `aiapget-pomodoro`.
2. Upload these files to the repository root: `index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js`, `icon.svg`, `README.md`.
3. Commit changes to the `main` branch.
4. Open Settings → Pages → Deploy from a branch → `main` → `/(root)` → Save.
5. Open the GitHub Pages URL over HTTPS. Add to Android home screen via Chrome's menu → Install app / Add to Home screen.

## Configure Google Drive sync
1. Open https://console.cloud.google.com/ in the Google account that owns your Drive.
2. Create/select a Google Cloud project.
3. APIs & Services → Library → Enable **Google Drive API**.
4. APIs & Services → OAuth consent screen: configure the app name and your own account as a test user if the app is in Testing mode. Do not request broad scopes.
5. APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application.
6. Add the exact HTTPS GitHub Pages origin (e.g. `https://YOUR-USERNAME.github.io`) as an **Authorized JavaScript origin**. Do not add paths to the origin.
7. Copy the OAuth Client ID ending in `.apps.googleusercontent.com` into this app's Google OAuth Client ID field and tap Connect Google Drive.
8. Approve the limited `drive.file` access and tap Sync now to test. Google credentials should never be shared in chat. No client secret is required or used in the frontend.

## Safety
The GitHub repository will be public if set to Public, so all source code is public. Never commit a password, refresh token, client secret, or private key. OAuth Client ID is public config but its authorized origins must be restricted to the exact site. Revoke app access at https://myaccount.google.com/connections if needed.

## Manual test checklist
- Verify date/time fields use Asia/Kolkata, including date changes. The top badge should read India · GMT+05:30 (Kolkata).
- Start a 60-minute focus, pause, resume, finish naturally, and inspect log. Test a shorter custom session too; the red dial should advance counter-clockwise by actual elapsed minutes (for example, about 3 minutes elapsed should point near the 03-minute position on the 60-minute dial).
- Schedule a break a few minutes ahead and verify focus stops, break starts and then auto-starts a new focus.
- Test manual end of session and manual early break end.
- Switch analytics range and change daily target.
- Export/import JSON and refresh to test local persistence.
- Configure Google OAuth only after the site is deployed; test Drive sync with a throwaway backup first.