# Mobile notifications

## Mobile app

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect; a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Installed web app

Open T3 Code over HTTPS, then choose **Settings → General → Background push** and enable push for each environment you want alerts from. Allow notifications when your browser asks. On iPhone and iPad, this requires iOS or iPadOS 16.4 or later: add T3 Code to your Home Screen and open it from that icon before enabling push.

When thread notifications are enabled, you receive alerts when a thread finishes, fails, needs approval, or asks for input, even when the web app is closed. Tap an alert to open its thread. Your environment must remain running with internet access. T3 Connect is not required, and alerts can arrive while another device is viewing the thread.

Push settings apply to this device and website address. To stop alerts, choose **Disable push** for the environment. Browser and system notification settings also control delivery. **Thread notifications** also controls automatic thread push alerts: **Off** and **Sound only** disable them, **Notifications only** requests silent alerts, and **Notifications with sound** allows system notification sounds. Sound-only playback requires T3 Code to stay open. Custom API and CLI notifications remain independent of thread preferences.

## Send notifications from scripts

Enable **Background push** on each device you want to receive alerts. Other jobs can then send notifications to all devices subscribed to that environment:

```sh
t3 notify --base-dir /path/to/t3-home \
  --title "Backup complete" \
  --message "The database archive is ready." \
  --url https://example.com/backups/42 \
  --tag backups \
  --idempotency-key backup-42
```

Use `--message-file /path/to/message.txt` instead of `--message` for file content. The CLI requires the selected server to be running. It prints JSON delivery counts and exits with an error if delivery fails or no active devices are subscribed.

For an HTTP integration, send a JSON request to `POST /api/notifications/send` using your environment's HTTPS origin and a bearer token with `orchestration:operate` access:

```sh
curl --fail-with-body "$T3_URL/api/notifications/send" \
  -H "Authorization: Bearer $T3_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"title":"Backup complete","body":"The database archive is ready.","url":"https://example.com/backups/42","tag":"backups","idempotencyKey":"backup-42"}'
```

Only `title` and `body` are required. Links can be T3 paths beginning with `/` or external HTTPS URLs. A tag replaces the previous visible alert with that tag. Reuse an idempotency key only when retrying the same notification; each device retains its last 128 delivered keys.

The response reports `subscribed`, `sent`, `failed`, `expired`, and `skipped` counts. `sent` means the browser's push service accepted the notification; `skipped` means that device already received the idempotency key. The encoded notification must fit within 3,500 bytes. The helper agent can use the same input through `api_call` with operation `notifications.send`.
