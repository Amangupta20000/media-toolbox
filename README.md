# Media Toolbox

Private image conversion, video repair, and PDF editing tools. The website runs on any modern browser. Processing can run in the connected server or in the optional cross-platform Local agent. The frontend uses the Next.js Pages Router and plain JSX/JavaScript.

## Features

- Image conversion to original format, JPG/JPEG, PNG, HEIC/HEIF, TIFF, GIF, and BMP.
- Selectable image engine: Auto, ImageMagick/libheif, or macOS `sips` fallback when developing locally on macOS.
- Optional whole-KB size target using decimal KB (1 KB = 1,000 bytes). JPG/HEIC quality is searched from 100 to 5; when the best valid output is smaller than the requested target, safe metadata padding is used where the format supports it without changing pixels.
- Pixel dimensions preserved; JPEG transparency warning included.
- Video recovery with lossless remux, MKV/WebM repair, optional Untrunc reference recovery, tolerant transcode, and video-only fallback.
- Recovered video is validated with strict FFmpeg decoding; when Untrunc exposes decodable but damaged frames, the worker re-encodes them into a fresh H.264/AAC MP4 and reports the best-effort limitation.
- PDF editor beta: load 1-5 PDFs (50 MB each), merge them, reorder or delete pages, add blank pages, and place/move/resize PNG, JPG, JPEG, or HEIC images on blank pages.
- PDF editor merges and exports through the Local agent or Server while retaining source page sizes and rotations and never modifying the original PDFs. Inserted HEIC/TIFF/GIF/BMP images use the ImageMagick/libheif normalization path when needed. PDF page previews and thumbnails are rendered by the application; no browser PDF viewer is used.
- Responsive two-column workspace with a collapsible tool sidebar.
- Drag-and-drop or browse upload controls.
- Local in-browser image preview before upload, including transparency checkerboard support.
- Background jobs with progress, live worker logs, and downloadable results.
- Public website/server APIs with authorization enforced by the Local agent for local processing, plus automatic temporary-file cleanup.
- Processing location can be selected per job: Local agent or Server.

## Local processing agent

The Local agent is an optional desktop application for macOS, Windows, and Linux. It runs the same worker functions as the server, listens only on `127.0.0.1:4789`, starts at login after installation, and processes one job at a time. Packaged agents use a per-install HTTPS certificate on the loopback endpoint so an HTTPS production website can connect in Safari without a mixed-content block; the installer adds that certificate to the user's trust store where the platform supports it. A trusted browser can upload to it without sending the source files to the server. The agent never accepts shell commands or arbitrary filesystem paths from the website; its download-delete action accepts only a named regular file inside the user's Downloads folder.

The Local agent dashboard owns local processing authorization. Every installation provisions the fixed Admin account (`Admin` / `12345`), keeps the Admin unlock across restarts until logout, and provides one persistent five-minute trial. An owner can generate a device-bound, signed ten-minute activation code with the license commands below. The website never collects these credentials or codes.

Start the development agent in a second terminal:

```bash
npm run agent:dev
```

Open `/local-agent`; when the agent is running it creates a browser session automatically for a trusted origin. Use the desktop dashboard to log in as Admin or activate a license. For the tray application, use:

```bash
npm run agent
```

Build an installer for the current operating system with `npm run agent:package`. GitHub Actions builds macOS, Windows, and Linux installers on an `agent-v*` tag. Set `NEXT_PUBLIC_AGENT_RELEASES_URL` in the website environment to the repository's latest Releases page. The setup page links users to those installers.

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

The release workflow reads that public variable and embeds it in every packaged agent. It does not read or need the private key. For local development, set `AGENT_LICENSE_PUBLIC_KEY_FILE` to the public PEM path if it is not in `~/.config/media-toolbox/`. The device ID needed for `agent:license` is shown in the desktop agent dashboard.

For a Vercel frontend that uses the Local agent, set only `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_AGENT_URL` (`http://127.0.0.1:4789` for local HTTP development; secure production pages automatically use `https://127.0.0.1:4789`), `NEXT_PUBLIC_AGENT_RELEASES_URL`, and `NEXT_PUBLIC_MACOS_AGENT_SIGNED`. Do not set `NEXT_PUBLIC_AGENT_URL` to a cloud URL: the browser must reach the agent on the same computer. Users must install the latest agent release for Safari production access. The Vercel filesystem is ephemeral and Vercel does not run the separate worker process, so server processing and server history require a persistent backend deployment such as the Docker deployment described below.

### macOS release signing and notarization

The public macOS build must be signed with an Apple Developer ID Application certificate and notarized before users download it. Without those Apple credentials, Gatekeeper can report the app as damaged. The GitHub workflow intentionally stops the macOS release instead of publishing an unsigned DMG.

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

- Each PDF can be up to 50 MB; the combined PDF upload can be up to 250 MB.
- Up to five PDFs can be open in one editor project. A single PDF is supported too.
- A blank page starts at A4 portrait when there is no selected source page. An image is fitted inside the page and can then be moved or resized.
- The result is always one new PDF. Source PDFs are copied, never overwritten. PDF annotations, form fields, attachments, and other advanced structures may not survive page copying; the visible page content, page size, rotation, and order are the supported guarantees.
- PDF text editing is a separate future tool and is not part of this beta.

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
