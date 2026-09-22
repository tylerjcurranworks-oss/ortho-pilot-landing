# Ortho Pilot Landing Page

Shared top-of-funnel for the orthopedic RCM suite (Paperclip CUR-3385):

- Global Period Copilot — 90-day accuracy validation pilot (2 practices)
- ASC Migration Decision Tool — early-access waitlist

Static page (`index.html`) hosted on GitHub Pages. No patient data, no PHI, no clinical records.

## Lead flow

1. Visitor submits practice name, surgeon count, PM system, billing model, work email.
2. Browser auto-tags the lead:
   - `asc-early-access` — everyone
   - `gpc-pilot` — Athena/Tebra + in-house billing + 2–8 surgeons
   - `gpc-pilot-size-review` — Athena/Tebra + in-house, size outside 2–8
   - `gpc-deprioritized` — other PM or outsourced billing
3. Browser POSTs the lead to two sinks in parallel:
   - **Primary:** `receiver/lead-receiver.ts` (Deno, Mac mini, exposed via Tailscale Funnel on `:8443`).
     Re-validates and re-tags server-side, appends to `leads.jsonl`, and fires the Paperclip
     routine webhook "Ortho pilot lead intake". Each lead becomes a run issue under CUR-3385
     assigned to the CTO, who forwards to the CMO on CUR-3376.
   - **Backup:** Formspree legacy email endpoint → company inbox.

## Running the receiver

Secrets live in `~/.paperclip/instances/default/ortho-lead-receiver.env` (not in git):

```
LEAD_PORT=8787
LEAD_LOG=/Users/<user>/.paperclip/instances/default/ortho-leads.jsonl
LEAD_ALLOWED_ORIGINS=https://tylerjcurranworks-oss.github.io
PAPERCLIP_WEBHOOK_URL=http://127.0.0.1:3100/api/routine-triggers/public/<publicId>/fire
PAPERCLIP_WEBHOOK_SECRET=<secret>
```

Install as a launchd agent (survives reboots / crashes):

```
cp receiver/com.paperclip.ortho-lead-receiver.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.paperclip.ortho-lead-receiver.plist
tailscale funnel --bg --https=8443 8787
curl https://tylers-mac-mini.tail46b655.ts.net:8443/health
```

Smoke test:

```
curl -s -X POST https://tylers-mac-mini.tail46b655.ts.net:8443/lead \
  -H 'Content-Type: application/json' \
  -d '{"practice":"Test Ortho","surgeons":4,"pm":"athena","billing":"in-house","email":"test@example.com"}'
```
