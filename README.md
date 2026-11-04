# POMO Clock — Secure Firebase Edition (Session Recovery Fix v5.2)

A mobile-friendly physical-style Pomodoro clock with an Asia/Kolkata analog clock, counter-clockwise focus dial, scheduled breaks, editable session history, pause accounting, and daily/weekly/monthly analytics.

## Included app features
- 60-minute default focus session; custom durations from 1–240 minutes.
- Real clock hands move clockwise; focus progress moves counter-clockwise on a 60-minute dial.
- Scheduled 15-minute short and 60-minute long breaks. The date is automatic (Asia/Kolkata); enter only the time. A time already passed today rolls to tomorrow. Manual override remains available.
- Session names can be entered before starting or changed while running; history also remains editable. Separate cumulative session-pause duration; net focus excludes pauses.
- Session and break history, daily target, analytics charts, CSV and JSON export.
- Forest / sage-green physical-clock design and responsive mobile layout. Compact daily metrics sit above an independent analog stopwatch.
- Local browser persistence and daily local snapshots. The stopwatch keeps only its five most recent completed uses in browser-local temporary storage.

## Security architecture
- Firebase Authentication Google sign-in.
- Client-side owner check for `drparuls580@gmail.com` plus a Firestore rules allowlist. The Firestore rules are the enforcement boundary; the JavaScript check alone is not security.
- Firestore path: `users/{uid}/privateData/main`.
- Firestore data is encrypted in the browser using AES-GCM 256-bit encryption. The key is derived from the owner's POMO Clock password using PBKDF2-SHA-256 (310,000 iterations) and a random salt.
- The same password protects the local browser backup store and encrypted Google Drive backup payloads. The password and derived key are not uploaded or persisted by the app.
- If the password is forgotten, encrypted cloud/local backups cannot be decrypted. Keep a safe password-manager copy.
- Google Drive sync uses the limited `drive.file` OAuth scope. It is optional and requires a Google OAuth Web Client ID configured separately.

### Important limitations
- GitHub Pages is a static host. Firebase Authentication and Firestore rules enforce cloud access; the frontend owner-email check is only an additional UI gate.
- The local app UI is not a substitute for device-level security. Protect the device/browser profile and sign out on shared devices.
- JSON export is intentionally a user-initiated plaintext export. Store exported files safely.
- A static browser app cannot guarantee timer alarms while the page is fully closed or suspended by mobile OS battery management.
- This is a setup build. Do not call it production-secure until Firebase config is completed, rules are published, and both allowed/denied-account tests pass.

## 1. Complete Firebase web config

1. Open Firebase Console → POMO Clock project → Project settings (gear) → General.
2. Under **Your apps**, select the registered web app **My POMO Clock**.
3. Find **SDK setup and configuration** and choose the `Config` option (not npm).
4. Copy the exact `firebaseConfig` values into `firebase-config.js`, replacing `PASTE_API_KEY_HERE` and `PASTE_APP_ID_HERE`. Keep the other project values exactly as Firebase displays them.
5. Do not copy service-account credentials, OAuth client secrets, or private keys. The Firebase web config is public client configuration.

## 2. Publish Firestore security rules

1. Firebase Console → Build → Firestore Database → Rules.
2. Replace the editor contents with the complete contents of `firestore.rules` in this package.
3. Click **Publish**.
4. These rules allow only a verified Firebase-authenticated user whose email is exactly `drparuls580@gmail.com`, and only under that user's own UID path. All other paths are denied.

Do not use test mode or `allow read, write: if true`.

## 3. Authentication settings

- Firebase Authentication → Sign-in method: enable Google.
- Authentication → Settings → Authorized domains: ensure `parulthatsme-debug.github.io` is listed (the user has already added this domain).
- The first sign-in must use the verified Google account `drparuls580@gmail.com`.

## 4. GitHub Pages deployment

Upload these files to the root of the existing repository `New-Pomodoro` and commit to the branch used by GitHub Pages:

- `index.html`
- `style.css`
- `app.js`
- `firebase-config.js`
- `firestore.rules` (reference copy; Firebase rules are published separately in Console)
- `manifest.json`
- `sw.js`
- `icon.svg`
- `README.md`

The existing site URL should remain `https://parulthatsme-debug.github.io/New-Pomodoro/`.

## 5. First login and password

1. Open the deployed site and sign in with `drparuls580@gmail.com`.
2. On first use, create a strong POMO Clock password of at least 12 characters and confirm it.
3. This password encrypts your records before they are sent to Firestore or Google Drive. It is not your Google password.
4. Keep it in a password manager. There is no password reset that can recover encrypted records.

## 6. Google Drive encrypted backup (separate setup)

The app's Drive section accepts a Google OAuth Web Client ID. To use it:
1. Enable Google Drive API in the Google Cloud project associated with your app.
2. Create an OAuth client ID of type **Web application**.
3. Add the exact Authorized JavaScript origin `https://parulthatsme-debug.github.io` (origin only; no repository path).
4. Configure the OAuth consent screen and add the owner account as a test user if the app remains in Testing.
5. Enter the OAuth Client ID in the POMO Clock Drive panel, connect Drive, then sync.
6. Only encrypted JSON envelopes are uploaded. The encryption password/key is not uploaded.

Do not enter an OAuth client secret in the app. The Drive feature is optional; Firestore sync works independently.

## Manual test checklist
- Allowed account: Google sign-in succeeds for `drparuls580@gmail.com`.
- Denied account: sign-in with another Google account is rejected and Firestore rules deny direct access.
- First use: create password; refresh page; sign in again; same password unlocks.
- Wrong password: encrypted data remains unreadable and the app stays locked.
- Local persistence: create/pause/resume/finish sessions; refresh and verify session history and pause duration.
- Cross-device: sign in on another browser/device, unlock with the same POMO Clock password, verify Firestore records appear.
- Drive (after OAuth setup): sync an encrypted backup and restore it using the same POMO Clock password.
- Timer/break scheduling and analytics should be checked after the security gate is active.
- Session naming: enter a name before starting, confirm the active session shows it, rename while running, and verify the same name appears in history.
- Break scheduler: enter a time only; confirm the date is assigned automatically in Asia/Kolkata and a past time is scheduled for the next day.
- Sound: start/resume alerts run for about 8 seconds, completion alert for about 14 seconds, and Reset stops a currently playing alert immediately. Browser autoplay/audio policies can affect sound until the app has received user interaction.
- Stopwatch: start, pause, resume, finish and save; confirm that the latest five uses remain visible after a page reload in the same browser. Stopwatch data is local-only and is not included in Firestore or Drive sync.

## Session Recovery update (v4)

- A focus session keeps its original fixed time window. Pausing does not move the scheduled end time.
- Pause intervals are recorded separately from active focus periods.
- If the fixed window ends before the planned focus target is reached, the same history record is marked **Partial** and shows the remaining focus time. For example: a 2:00–3:00 PM session with a 15-minute pause records 45 minutes of focus, 15 minutes of pause, and 15 minutes remaining at 3:00 PM.
- **Resume Again** continues the original session ID. Recovery attempts, focus periods, pause intervals, and wait time before returning are shown in expandable details under that same history row; no extra history row is created. The Session Pause column sums only actual pause intervals within focus attempts; the time between a Partial session ending and a later recovery is shown separately as waiting time, not misreported as a manual pause.
- Daily/weekly/monthly focus analytics allocate each tracked focus block to the date on which that work actually happened, including a later recovery block.
- Scheduled breaks during a running focus session pause that same session and automatically resume it after the break, provided its fixed window has not ended. If a manual pause was already active before the scheduled break, the app preserves that manual pause after the break.
- Start/resume/break notifications use a gentle bell-style pentatonic chime for 8 seconds; fixed-window completion uses a longer chime for 14 seconds. Reset stops all scheduled and playing chime notes immediately.


## v4 validation notes
- Session history remains one numbered row per original session. The expandable detail area shows each focus block, manual/scheduled pause, fixed-window end, waiting period before recovery, and each later recovery block in chronological order.
- Focus analytics allocate tracked focus segments to the calendar date when the work actually occurred.
- Recovery-attempt focus and pause totals are stored per attempt as well as in the original session totals.


## v5 recovery behaviour

- The original Pomodoro window remains fixed. Manual pauses during the original window still consume wall-clock window time and can leave the session Partial at its original end.
- Resume Again opens a continuation attempt under the same session record and session number. It displays the session name and remaining focus minutes in the main timer panel.
- Recovery is based on accumulated active focus, not a new wall-clock deadline. Pausing a recovery attempt does not consume the remaining focus time or cause the recovery window to expire.
- Multiple pause/resume periods during recovery are recorded as separate timeline entries under the original session. The session becomes Completed only when total active focus reaches the original planned target.
- Recovery duration shown in the main panel is read-only and reflects the remaining focus (rounded up to whole minutes); the progress bar and elapsed percentage remain based on total focus against the original target.
- Scheduled breaks attached to a recovery session pause focus accounting and return to the same recovery attempt when the scheduled break finishes.

The v5.1 service-worker cache is versioned to force the browser to install the corrected application assets. Firebase configuration and Firestore rules are unchanged.


## v5.1 recovery pause and panel correction

- Recovery attempts no longer receive a wall-clock deadline. Their countdown is calculated from the original session target minus the sum of all actual focus segments.
- Pausing recovery closes the current focus segment and opens a pause interval under the same recovery-attempt ID. Resuming closes that pause interval and opens another focus segment under that same attempt. Multiple recovery pauses therefore accumulate in Session Pause and remain visible in the original session's timeline.
- Time spent paused during recovery does not reduce the remaining focus amount and cannot trigger the original fixed-window end message. Recovery ends only when accumulated actual focus reaches the original planned target, or when the user explicitly ends/resets the session.
- The main timer panel identifies **SESSION RECOVERY**, shows the original session name, displays a read-only **Remaining focus** field rounded up to whole minutes, and shows accumulated focus versus the original target and its percentage.
- The original session's first fixed window is unchanged: its deadline still stays fixed, and pauses during that initial window can result in a Partial record at the original end.
- A previously active v5 recovery record is migrated in-place to the pause-excluded recovery model when the updated app loads; its focus segments and pause intervals are retained.

The v5.1 build increments the service-worker cache to `pomo-clock-session-recovery-v6` so browsers replace the previously deployed v5 assets. Firebase configuration and Firestore rules are unchanged.


## v5.2 recovery panel render fix

- The live timer renderer now keeps total focused time and original target values in function scope, so the recovery right-side panel can finish rendering instead of stopping on a JavaScript scope error.
- During recovery, the main panel reflects the same original session name, recovery status, exact countdown, read-only remaining-focus field, and total focus progress that appear in the history row.
- The remaining-focus number input rounds upward to a whole minute so a partial minute is never cut short; the analog/digital countdown remains second-accurate. For a 15-minute target with exactly 8 minutes focused, recovery is 7 minutes.
- The service-worker cache is incremented to `pomo-clock-session-recovery-v7` to ensure the fixed `app.js` is installed. Firebase configuration and Firestore rules remain unchanged.
