# Media Toolbox

Private image conversion, video repair, and PDF editing tools. The website runs on any modern browser. Processing can run in the connected server or in the optional cross-platform Local agent. The frontend uses the Next.js Pages Router and plain JSX/JavaScript.

## Features

- Image conversion to original format, JPG/JPEG, PNG, HEIC/HEIF, TIFF, GIF, and BMP.
- Convert up to five images in one request; each image can use its own output extension and optional whole-KB target.
- Selectable image engine: Auto, ImageMagick/libheif, or macOS `sips` fallback when developing locally on macOS.
- Optional whole-KB size target using decimal KB (1 KB = 1,000 bytes). JPG/HEIC quality is searched from 100 to 5; when the best valid output is smaller than the requested target, safe metadata padding is used where the format supports it without changing pixels.
- Pixel dimensions preserved; JPEG transparency warning included.
- Video recovery with lossless remux, MKV/WebM repair, optional Untrunc reference recovery, tolerant transcode, and video-only fallback.
- Recovered video is validated with strict FFmpeg decoding; when Untrunc exposes decodable but damaged frames, the worker re-encodes them into a fresh H.264/AAC MP4 and reports the best-effort limitation.
- PDF editor beta: load 1-5 PDFs (200 MB total), merge them, reorder or delete pages, add blank pages, place/move/resize/rotate images, and add styled text boxes with built-in PDF fonts, size, bold, italic, underline, text colour, and background colour controls.
- PDF editor merges and exports through the Local agent or Server while retaining source page sizes and rotations and never modifying the original PDFs. Inserted HEIC/TIFF/GIF/BMP images use the ImageMagick/libheif normalization path when needed. PDF page previews and thumbnails are rendered by the application; no browser PDF viewer is used.
- PDF text editor beta: open one PDF, select detected text runs across pages, replace them with inline editing, and export through the Local agent or Server. Native PDFs preserve searchable text and change only the selected text-show operators. Image-only PDFs use the bundled English OCR engine as a clearly labeled fallback.
- Responsive two-column workspace with a collapsible tool sidebar.
- Drag-and-drop or browse upload controls.
- Local in-browser image preview before upload, including transparency checkerboard support.
- Background jobs with progress, live worker logs, and downloadable results.
- Public website/server APIs with authorization enforced by the Local agent for local processing, plus automatic temporary-file cleanup.
- Processing location can be selected per job: Local agent or Server.

## Local processing agent

The Local agent is an optional desktop application for macOS, Windows, and Linux. It runs the same worker functions as the server, listens only on `127.0.0.1:4789`, starts at login after installation, and processes one job at a time. Packaged agents use a per-install HTTPS certificate on the loopback endpoint so an HTTPS production website can connect in Safari without a mixed-content block; the installer adds that certificate to the user's trust store where the platform supports it. A trusted browser can upload to it without sending the source files to the server. The agent never accepts shell commands or arbitrary filesystem paths from the website; its download-delete action accepts only a named regular file inside the user's Downloads folder.

The Local agent dashboard owns local processing authorization. Every installation provisions the fixed Admin account (`Admin` / `Aman`), keeps the Admin unlock across restarts until logout, and provides one persistent five-minute trial. The trial starts only when the first local processing session is requested; opening the website or checking agent health does not consume it. An owner can generate a signed, origin-scoped activation code bound to one installation's Device ID for 10 minutes, 30 minutes, 2 hours, 6 hours, or 1 day. The same code cannot be reused on another installation or replayed after it has been consumed. The website never collects these credentials or codes.

On first use, the desktop dashboard requires acceptance of the bundled Privacy Policy and Terms & Conditions before Admin login, activation, or the trial can start. This consent is stored locally with the agent's authorization record and is not sent to the website. Processing requests made before acceptance are rejected until the user accepts both documents in the dashboard.

Start the development agent in a second terminal:

```bash
npm run agent:dev
```

Open `/local-agent`; when the agent is running it creates a browser session automatically for a trusted origin. Use the desktop dashboard to log in as Admin or activate a license. The packaged dashboard is a normal movable desktop window with native application menus; it also keeps a tray shortcut for background operation. To run the desktop agent in development, use:

```bash
npm run agent
```

Build an installer for the current operating system with `npm run agent:package`. GitHub Actions builds macOS, Windows, and Linux installers on an `agent-v*` tag. Set `NEXT_PUBLIC_AGENT_RELEASES_URL` in the website environment to the repository's latest Releases page. The setup page links users to those installers.

Packaged agents check GitHub Releases shortly after startup and periodically while running. When a newer signed release is available, the desktop dashboard shows an **Agent update** notification. Click **Update now** to download it, then click **Restart and install** after the download completes. Automatic replacement is enabled for Developer ID-signed macOS builds and packaged Windows/Linux builds. Unsigned macOS builds show an **Open latest release** button instead; macOS cannot reliably validate automatic updates when each ad-hoc signature has a different executable hash. Development agents do not attempt release updates. The release workflow publishes updater metadata (`latest*.yml` and blockmaps) alongside the installers; this is handled by `.github/workflows/agent-release.yml`.

Unsigned macOS builds also support a separate verified runtime update. This downloads the Node-based processing runtime and the compatible dashboard shell into the agent's application-data directory; it never replaces the unsigned Electron application. The dashboard verifies the archive with SHA-256 and an Ed25519 signature, installs it atomically, and restarts the agent. This allows dashboard fixes, such as removing an obsolete widget, to appear after the verified update. If the runtime update signing keys are not configured, the dashboard keeps the manual GitHub Releases option.

Every signed runtime manifest also declares an `updateType`. It defaults to `runtime`, which enables the verified in-app update. Set the GitHub Actions repository variable `AGENT_UPDATE_TYPE` to `full` for a release that changes the Electron application or another component that cannot be replaced from application data. The dashboard then blocks the runtime installer and clearly instructs the user to download and install the full release. Developer ID-signed macOS builds continue to use the full Electron updater for these releases.

Create the runtime update key pair once outside the repository:

```bash
npm run agent:update-keygen
```

Add the generated public PEM as the GitHub Actions repository **variable** `AGENT_RUNTIME_UPDATE_PUBLIC_KEY`, and add the generated private PEM as the GitHub Actions repository **secret** `AGENT_RUNTIME_UPDATE_PRIVATE_KEY`. The workflow packages and publishes one platform/architecture-specific runtime ZIP and its signed `agent-runtime-manifest-*.json` next to each release. The private key is used only during packaging and is never embedded in the website or agent. If either value is absent, installer packaging still works but verified runtime artifacts are skipped with a warning.

Generate the owner signing key pair once, outside the repository:

```bash
npm run agent:license-keygen
npm run agent:license -- --device-id <device-id> --duration 10m --origins https://media-toolbox-woad.vercel.app,http://localhost:3000,http://127.0.0.1:3000
```

The first command writes the private key and public key to `~/.config/media-toolbox/` by default. Keep the private key on the owner's computer only; never commit it, upload it to Vercel, or add it to a GitHub variable. The public key is safe to distribute because it can only verify licenses.

Before creating an `agent-v*` release, add the public PEM as a GitHub Actions **repository variable**:

1. Open the repository on GitHub and go to **Settings → Secrets and variables → Actions → Variables**.
2. Click **New repository variable**.
3. Set **Name** to `AGENT_LICENSE_PUBLIC_KEY`.
4. Copy the complete contents of `~/.config/media-toolbox/agent-license-public.pem` into **Value**, including `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`, then save it.

The command-line equivalent is:

```bash
gh variable set AGENT_LICENSE_PUBLIC_KEY --repo Amangupta20000/media-toolbox < ~/.config/media-toolbox/agent-license-public.pem
```

The release workflow reads that public variable and embeds it in every packaged agent. It does not read or need the private key. For local development, set `AGENT_LICENSE_PUBLIC_KEY_FILE` to the public PEM path if it is not in `~/.config/media-toolbox/`. The desktop dashboard shows the Device ID required for activation-code generation. Keep it private and send it to the owner through a private channel; it is not a password, and the website does not receive it.

### Owner and user activation flow

1. The user installs and opens the Local agent. The dashboard shows the agent's trusted website origin, authorization state, and Device ID.
2. The user copies the Device ID and sends it to the owner through a private channel.
3. The owner runs `npm run agent:license -- --device-id <device-id> --duration <duration> --origins <origin1,origin2>` on the owner computer, where `<duration>` is `10m`, `30m`, `2h`, `6h`, or `1d`. The command prints one signed `MT1-...` activation code.
4. The owner sends that code to the user through a private channel such as email or chat. The user enters it only in the Local agent desktop dashboard.
5. The agent verifies the signature locally, checks the device binding, trusted origin, and one-use license ID, then authorizes local processing for the requested duration. The website receives only a short-lived local browser session token.

The offline command remains available for development and disconnected use. For public user requests, use the SSD-backed licensing server below; it generates a code without requiring the user to send a Device ID, then binds it atomically to the first agent that redeems it. A code cannot be reused after redemption.

Users request a code only from the Local agent desktop dashboard. After accepting the legal documents, they enter the website origin, choose 10 minutes, 30 minutes, 2 hours, 6 hours, or 1 day, and click **Request activation code**. The owner can approve or decline the request in the hidden `/admin` route, or in the desktop agent dashboard after logging in as Admin. Once approved, the code appears in the desktop dashboard, where the user can copy it or click **Activate now**. The website does not create or poll license requests.

### SSD-backed licensing server

The licensing server is a separate, small Node service. It does not run media jobs and does not receive media files. It stores its own SQLite database and encrypted signing-key blob only in `/Volumes/Sandisk Exf/MediaToolboxLicensing`, after checking the configured exFAT volume UUID. The service fails closed if the expected SSD is not mounted.

Create or reuse the signing key and encrypt its private key into the SSD data directory:

```bash
LICENSE_DATA_DIR="/Volumes/Sandisk Exf/MediaToolboxLicensing" npm run license-server:keygen -- --private-key ~/.config/media-toolbox/agent-license-private.pem
```

Run the service locally:

```bash
LICENSE_DATA_DIR="/Volumes/Sandisk Exf/MediaToolboxLicensing" npm run license-server
```

After a restart, the installed Local Agent automatically checks for the licensing SSD and starts the loopback service when the configured storage path is available. If the SSD is not mounted, the dashboard shows **Waiting for licensing SSD** and retries automatically every five seconds. The dashboard still has **Start licensing server** as a manual fallback, and **Stop server** suppresses automatic retries until the service is explicitly started again. The dashboard does not change or recreate the saved Tailscale Funnel configuration.

Expose only `http://127.0.0.1:4900` through Tailscale Funnel. Set the resulting stable HTTPS `*.ts.net` URL as `NEXT_PUBLIC_LICENSE_SERVER_URL` in Vercel. Set the same URL as the GitHub Actions repository variable `AGENT_LICENSE_SERVER_URL` so released agents can redeem server-issued codes. The website uses a same-origin `/api/license` proxy before trying the direct Funnel URL, and released clients use that proxy as a fallback when a laptop cannot reach Tailscale directly. The existing public key variable remains `AGENT_LICENSE_PUBLIC_KEY`.

When developing on the same Mac that runs the licensing server, also set `AGENT_LICENSE_SERVER_LOCAL_URL=http://127.0.0.1:4900` in the ignored `.env.local` file. The local website and source Electron agent try this loopback address first, avoiding unreliable same-machine access through the public Funnel hostname; deployed Vercel pages continue to use `NEXT_PUBLIC_LICENSE_SERVER_URL`.

The GitHub variable can be set with:

```bash
gh variable set AGENT_LICENSE_SERVER_URL --repo Amangupta20000/media-toolbox --body "https://license.example.com"
```

Replace the example hostname with the real Tailscale Funnel hostname. Do not set it until the Funnel is configured.

For a no-domain test or small owner-run deployment, Tailscale Funnel can expose the local licensing service through a stable HTTPS `*.ts.net` hostname. Install and sign in to Tailscale on the SSD Mac, then run the licensing service and Funnel together:

```bash
npm run license-server:funnel
```

The command keeps the Node licensing service running on the SSD and runs `tailscale funnel --bg --https=443 http://127.0.0.1:4900`. It prints the public Tailscale URL. Tailscale must be installed, signed in, and allowed to use Funnel. Keep the SSD mounted; the installed agent automatically starts the licensing service after login and when the SSD is reconnected. Set the printed HTTPS URL as `NEXT_PUBLIC_LICENSE_SERVER_URL` in Vercel and as the `AGENT_LICENSE_SERVER_URL` repository variable before an agent release. The owner dashboard's **Update GitHub variable** button can update the repository variable after `LICENSE_GITHUB_TOKEN` is configured on the licensing server.

Set the owner-only GitHub token on the SSD server as `LICENSE_GITHUB_TOKEN`. It needs permission to manage Actions variables for `Amangupta20000/media-toolbox`; it is never included in the website bundle, desktop agent, or GitHub variable. The dashboard only sends the HTTPS URL to the authenticated licensing server.

The owner opens the hidden `/admin` route, signs in, and approves or declines pending requests, or logs in as Admin in the desktop agent dashboard and uses its **License requests** panel. A user requests a code from the desktop dashboard, waits for owner approval, then copies the displayed code into that dashboard. The service returns the code only to the requesting dashboard session. The agent redeems it with its device ID; the service stores the binding and removes the encrypted code payload.

The initial owner credential is intentionally fixed as `Admin / Aman` to match the product requirement. It is hashed for comparison, rate-limited, and should be replaced before using this service for valuable licenses. Never put the private signing key, master key, Tailscale auth key, GitHub token, or the SSD directory in Vercel or GitHub variables.

The licensing server also keeps an owner-only audit log in the same SSD-backed `licenses.sqlite3` database. It records activation requests, approvals, declines, redemptions, expiries, admin session logins/logouts, and device activity without storing activation codes or private keys. The web `/admin` page and the desktop agent dashboard show the latest entries after Admin authentication.

The licensing regression tests cover the storage boundary, request flow, admin approval, one-time redemption, wrong-device/replay rejection, and local-agent online redemption. See [`docs/ssd-licensing-server-plan.md`](docs/ssd-licensing-server-plan.md) for the deployment boundary and later scaling options.

For a Vercel frontend that uses the Local agent, set `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_AGENT_URL` (`http://127.0.0.1:4789` for local HTTP development; secure production pages automatically use `https://127.0.0.1:4789`), `NEXT_PUBLIC_AGENT_RELEASES_URL`, `NEXT_PUBLIC_MACOS_AGENT_SIGNED`, and (when using public license requests) `NEXT_PUBLIC_LICENSE_SERVER_URL`. Do not set `NEXT_PUBLIC_AGENT_URL` to a cloud URL: the browser must reach the agent on the same computer. Users must install the latest agent release for Safari production access. The Vercel filesystem is ephemeral and Vercel does not run the separate worker process, so server processing and server history require a persistent backend deployment such as the Docker deployment described below.

### macOS release signing and notarization

The public macOS build should be signed with an Apple Developer ID Application certificate and notarized before users download it. Without those Apple credentials, Gatekeeper can report the app as damaged, and automatic in-app updates are disabled because ad-hoc signatures cannot satisfy a stable update requirement. Unsigned builds remain available for testing through the manual GitHub Releases link.

To enable signed releases:

1. Enroll in the Apple Developer Program and create a **Developer ID Application** certificate. Export the certificate and its private key from Keychain Access as a password-protected `.p12` file.
2. Base64-encode that `.p12` file and add these GitHub repository Secrets: `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Never commit the `.p12` file or put these values in source code.
3. Create the app-specific password at Apple for the Apple ID used by `APPLE_ID`. The workflow uses it only for Apple's notarization service.
4. Push a new `agent-v*` tag. GitHub Actions will sign the app, submit it to Apple, wait for notarization, and publish the signed installers.

After the signed release is published, set `NEXT_PUBLIC_MACOS_AGENT_SIGNED=true` in the website environment so the setup page stops showing the unsigned-build workaround.

The packaged local agent includes platform-specific FFmpeg, ffprobe, Sharp image-processing binaries, and Untrunc for reference-based MP4 recovery. It prefers bundled binaries before checking the host. macOS uses built-in `sips` for HEIC when available; other platforms use the bundled HEIF-capable image engine when supported. Readable MKV/WebM files use FFmpeg without requiring MKVToolNix; MKVToolNix remains an optional enhanced damaged-container path. Optional capabilities are shown instead of silently switching processing locations. Local jobs can either delete their final result after download or keep only the final result in the agent's Results folder.

## Video repair reference rules

| Video situation | Need another video? | What happens |
|---|---|---|
| Video opens normally | No | Make a new copy and fix its timing and file information. |
| MKV or WebM file | No | Rebuild the file when MKVToolNix is available, then make an MP4 copy. |
| Some parts are damaged, but the file opens | No | Save the parts that can still be read. Bad parts may be skipped. |
| MP4/MOV/M4V/3GP will not open because its file information is missing (`moov`) | **Yes** | Use a healthy video from the same device/app to rebuild the file. |
| The actual picture data is broken | Cannot fix the picture | Blank, frozen, or distorted parts may remain. |

The healthy video should come from the same device/app and use the same video size, frame rate, and video/audio format. The web worker uses the reference uploaded with the job. It has no automatic local reference; `UNTRUNC_REFERENCE_PATH` is only used when a deployment intentionally puts a reference video on the server.

## PDF editor limits and behavior

- Add up to 5 PDFs per PDF editor request, with a combined upload limit of 200 MB. There is no separate per-file limit below that total, so a 200 MB PDF uses the complete allowance and prevents another PDF from being added.
- Up to five PDFs can be open in one editor project. A single PDF is supported too.
- A blank page starts at A4 portrait when there is no selected source page. Images can be moved, resized, or rotated by 15-degree steps or an exact angle. Text boxes can be moved and resized in the page preview, and their styling is preserved in Local agent/Server exports. Page rotations are reflected in thumbnails, previews, and exports.
- The result is always one new PDF. Source PDFs are copied, never overwritten. PDF annotations, form fields, attachments, and other advanced structures may not survive page copying; the visible page content, page size, rotation, and order are the supported guarantees.
- The separate `/pdf-text-editor` tool accepts one PDF up to 200 MB. Native text editing preserves page order, rotations, images, graphics, backgrounds, colors, opacity, font size, and non-edited text. Longer replacements may overflow because surrounding content is not reflowed. If the original font cannot encode the replacement, the bundled Helvetica fallback is used when possible and a warning is added; unsupported replacements are blocked safely.
- Image-only/scanned PDFs are rendered and scanned by the bundled Tesseract.js English OCR engine through the Local agent or Server. OCR words are shown as editable regions with confidence information. Export reconstructs only pages containing OCR edits, so the exact source font, opacity, and hidden pixels in those regions cannot be recovered; the export warning explains this limitation. Untouched pages remain copied from the original PDF.
- PDF text editor export is available only through the Local agent or Server. PDF.js is used for page preview and selection; there is no browser export mode. Password-protected or encrypted PDFs that cannot be safely modified are rejected with an explicit message.

## Run with Docker

1. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

2. Start the web app, worker, and reverse proxy:

   ```bash
   docker compose up -d --build
   ```

3. Open the configured `DOMAIN` in a browser. With the defaults, use `http://localhost`.

Caddy provisions HTTPS automatically when `DOMAIN` points to a real DNS name and ports 80/443 are reachable from the internet.

## Optional Untrunc support

The worker detects `/usr/local/bin/untrunc` at startup. If present, MP4/MOV jobs can use reference-based metadata recovery. Mount or copy a compatible Linux Untrunc binary into the worker image and set `UNTRUNC_PATH` accordingly. Upload a healthy recording from the same device/app in the Video repair form. The web worker has no implicit local reference; set `UNTRUNC_REFERENCE_PATH` only when a deployment intentionally mounts a matching server-side reference. All other video repair paths work without it, but FFmpeg alone cannot reconstruct a missing MP4 `moov` atom.

The reference must match the source's recorder, codec, resolution, frame rate, and recording settings. Rebuilding the `moov` atom does not recreate damaged H.264 bytes. If the recovered stream has some decodable frames but also reports H.264 errors, the worker re-encodes the recoverable frames into a fresh MP4, marks the result as best effort, and shows the warning in the on-screen worker log. Missing picture data can still appear as frozen, blank, or damaged regions and cannot be reconstructed locally.

## Local development

Use the same Node major version as the Docker image:

```bash
nvm install
nvm use
```

Install dependencies and create a local environment file:

```bash
npm install
cp .env.example .env.local
npm run dev
```

`npm run dev` starts the Next.js web server and the existing server-side development worker together. The local agent remains a separate process so the website can show whether it is connected:

```bash
npm run worker
```

In another terminal, when testing Local mode:

```bash
npm run agent:dev
```

After a production build, start the standalone Pages Router server with:

```bash
npm run build
npm run start
```

The packaged local agent supplies FFmpeg, ffprobe, Sharp, and Untrunc. ImageMagick, Poppler (`pdftoppm`), and MKVToolNix are optional host capabilities; macOS `sips` provides the HEIC fallback. Docker is the recommended way to get a consistent Linux runtime for the server worker.

For local agent development, `npm run setup:untrunc` stages or builds the platform-specific Untrunc helper under `vendor/untrunc`. Release builds prepare Untrunc automatically for macOS, Windows, and Linux before packaging, so users do not install it separately. Upload a healthy reference video recorded with the same device/app settings when repairing missing MP4 metadata. The macOS helper is ignored by Docker builds; Linux Docker builds compile the pinned Untrunc helper inside the worker image. The web project has no implicit Record Go reference: a job's uploaded healthy reference is used for that job, or a deployment can explicitly set `UNTRUNC_REFERENCE_PATH` to a reference mounted on the server. The standalone `/Users/<your-user>/Desktop/RUN_SCRIPTS/recover_recording.command` remains a separate local macOS helper and can still use its local reference fallback.

## Operational notes

- Images are limited to 25 MB and videos to 2 GB.
- Uploaded files and generated results are kept only until the retention period expires.
- Use a Linux VM or desktop agent with enough free disk space for the original, temporary candidates, and output. For a 2 GB video, plan for substantially more than 2 GB of free space.
- SQLite and local persistent storage are intended for one worker. Move job state to Postgres/Redis and files to object storage before adding multiple workers.
