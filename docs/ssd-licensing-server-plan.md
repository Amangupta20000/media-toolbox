# SSD-backed licensing server

## Purpose

Media Toolbox will use this Mac as a small, licensing-only service for users on the public internet. Media processing remains in the existing server or Local Agent; this service only creates, approves, and consumes one-time activation licenses with a requested duration of 10 minutes, 30 minutes, 2 hours, 6 hours, or 1 day.

The service listens on `127.0.0.1:4900` and is published with Tailscale Funnel using the Mac's stable `*.ts.net` hostname. It does not expose the SSD, the desktop, or shell commands.

## Storage and safety

Use only this dedicated directory on the exFAT partition:

```text
/Volumes/Sandisk Exf/MediaToolboxLicensing/
```

The service must verify the configured volume UUID (`62D322F6-B7D6-3CB4-BB99-0A0A428E3F58`) before creating files. It must create and modify only its own directory, never scan the volume and never touch the Time Machine partition or other exFAT files.

SQLite uses full synchronous writes and rollback journaling on exFAT. License codes and signing-key material are encrypted at rest. The encryption wrapping key is kept in macOS Keychain (or an explicitly protected local secret on non-macOS), never in the repository or on the exFAT volume as plaintext.

## License flow

1. A user requests a license from the desktop Local Agent dashboard, choosing one of the five allowed durations, and receives a request ID and private request token.
2. The owner signs into the hidden `/admin` route or the desktop Local Agent dashboard as Admin and approves or declines the request.
3. Approval creates one signed `MT1-...` code scoped to the requested website origin and duration.
4. The desktop dashboard displays the approved code and the user activates it there.
5. The agent redeems the code online with its device ID. The server atomically consumes and binds it to the first device, then returns a short-lived device-bound token.
6. The server deletes the encrypted code payload after redemption and retains only a hash, binding, and audit metadata.

Codes are one-time and cannot be reused by another user or device. No media file is uploaded to the licensing service.

## API

```text
GET  /v1/health
POST /v1/license-requests
GET  /v1/license-requests/:id
POST /v1/licenses/redeem
POST /v1/admin/login
POST /v1/admin/logout
GET  /v1/admin/license-requests
POST /v1/admin/license-requests/:id/approve
POST /v1/admin/license-requests/:id/decline
POST /v1/admin/github/agent-license-server-url
```

Browser endpoints use an explicit trusted-origin allowlist. Admin endpoints use a short-lived bearer session. Request tokens and admin tokens are stored only as hashes.

## Deployment

1. Connect and mount the exFAT SSD.
2. Configure `LICENSE_DATA_DIR=/Volumes/Sandisk Exf/MediaToolboxLicensing` and the volume UUID.
3. Bootstrap an Ed25519 signing key. Keep the private key encrypted in the service data directory and keep the public key in the released Local Agent.
4. Run the licensing service with `npm run license-server` under a process supervisor, or click **Start licensing server** in the installed owner dashboard. The dashboard performs the SSD and health checks and starts the bundled service with the correct runtime.
5. Enable Tailscale Funnel for the Mac and point it at `http://127.0.0.1:4900`. Set the stable HTTPS `*.ts.net` URL as `NEXT_PUBLIC_LICENSE_SERVER_URL` in Vercel.
6. Restrict Funnel to the licensing service. Do not expose the SSD or any desktop management endpoint through it.

Tailscale Funnel is the selected no-domain public option. The Mac, Tailscale, SSD, and licensing service must remain available; a VPS or purchased domain can be added later without changing the licensing API.

## Owner authentication

The owner dashboard uses the existing fixed local Admin account (`Admin / Aman`) because that is the requested product behavior. The password is hashed, sessions expire, login is rate-limited, and every approval/decline is audited. This credential is intentionally weak and must be changed before treating the service as a high-value licensing system.

## Out of scope

Redis/Valkey, media processing, Google Cloud fallback, multi-node licensing, and online payment/subscription management are not required for the first low-volume deployment. The service can later move its metadata to managed PostgreSQL and add a queue without changing the public license flow.
