# Media Toolbox

Private image conversion, video repair, and PDF editing tools. The website runs on any modern browser. Processing can run in the connected server, in the browser for PDF editing, or in the optional cross-platform Local agent. The frontend uses the Next.js Pages Router and plain JSX/JavaScript.

## Features

- Image conversion to original format, JPG/JPEG, PNG, HEIC/HEIF, TIFF, GIF, and BMP.
- Selectable image engine: Auto, ImageMagick/libheif, or macOS `sips` fallback when developing locally on macOS.
- Optional whole-KB size target using decimal KB (1 KB = 1,000 bytes). JPG/HEIC quality is searched from 100 to 5; when the best valid output is smaller than the requested target, safe metadata padding is used where the format supports it without changing pixels.
- Pixel dimensions preserved; JPEG transparency warning included.
- Video recovery with lossless remux, MKV/WebM repair, optional Untrunc reference recovery, tolerant transcode, and video-only fallback.
- Recovered video is validated with strict FFmpeg decoding; when Untrunc exposes decodable but damaged frames, the worker re-encodes them into a fresh H.264/AAC MP4 and reports the best-effort limitation.
- PDF editor beta: load 1-5 PDFs (50 MB each), merge them, reorder or delete pages, add blank pages, and place/move/resize PNG, JPG, JPEG, or HEIC images on blank pages.
- PDF Browser mode merges and exports without uploading the PDFs. Local and Server modes use the worker for files Browser mode cannot parse. All modes retain source page sizes and rotations and never modify the original PDFs. Inserted HEIC/TIFF/GIF/BMP images use the ImageMagick/libheif normalization path when needed. PDF page previews and thumbnails are rendered by the application; no browser PDF viewer is used.
- Responsive two-column workspace with a collapsible tool sidebar.
- Drag-and-drop or browse upload controls.
- Local in-browser image preview before upload, including transparency checkerboard support.
- Background jobs with progress, live worker logs, and downloadable results.
- Basic Auth protection and automatic temporary-file cleanup.
- Processing location can be selected per job: Browser (PDF only), Local agent, or Server.

## Local processing agent

The Local agent is an optional desktop application for macOS, Windows, and Linux. It runs the same worker functions as the server, listens only on `127.0.0.1:4789`, starts at login after installation, and processes one job at a time. A paired browser can upload to it without sending the source files to the server. The agent never accepts shell commands or arbitrary filesystem paths from the website.

Start the development agent in a second terminal:

```bash
npm run agent:dev
```

Open `/local-agent`, click **Check connection**, then enter the 6-digit code printed in the agent terminal. For the tray application, use:

```bash
npm run agent
```

Build an installer for the current operating system with `npm run agent:package`. GitHub Actions builds macOS, Windows, and Linux installers on an `agent-v*` tag. Set `NEXT_PUBLIC_AGENT_RELEASES_URL` in the website environment to the repository's latest Releases page. The setup page links users to those installers.

### macOS release signing and notarization

The public macOS build must be signed with an Apple Developer ID Application certificate and notarized before users download it. Without those Apple credentials, Gatekeeper can report the app as damaged. The GitHub workflow intentionally stops the macOS release instead of publishing an unsigned DMG.

To enable signed releases:

1. Enroll in the Apple Developer Program and create a **Developer ID Application** certificate. Export the certificate and its private key from Keychain Access as a password-protected `.p12` file.
2. Base64-encode that `.p12` file and add these GitHub repository Secrets: `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Never commit the `.p12` file or put these values in source code.
3. Create the app-specific password at Apple for the Apple ID used by `APPLE_ID`. The workflow uses it only for Apple's notarization service.
4. Push a new `agent-v*` tag. GitHub Actions will sign the app, submit it to Apple, wait for notarization, and publish the signed installers.

After the signed release is published, set `NEXT_PUBLIC_MACOS_AGENT_SIGNED=true` in the website environment so the setup page stops showing the unsigned-build workaround.

The agent detects FFmpeg, ImageMagick/libheif, MKVToolNix, Poppler, and optional Untrunc on the host. Missing optional capabilities are shown instead of silently switching processing locations. Local jobs can either delete their final result after download or keep only the final result in the agent's Results folder.

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

1. Copy the environment template and set real credentials:

   ```bash
   cp .env.example .env
   ```

   Set `APP_USERNAME`, `APP_PASSWORD`, and a long random `AUTH_SECRET` in `.env`.

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

The local worker requires ImageMagick, libheif, FFmpeg, ffprobe, Poppler (`pdftoppm`), and optionally mkvmerge to be installed on the host. Docker is the recommended way to get a consistent Linux runtime.

To enable truncated-MP4 recovery during local macOS development, run `npm run setup:untrunc`, then upload a healthy reference video recorded with the same device/app settings. The macOS helper is ignored by Docker builds; Linux Docker builds compile the pinned Untrunc helper inside the worker image. The web project has no implicit Record Go reference: a job's uploaded healthy reference is used for that job, or a deployment can explicitly set `UNTRUNC_REFERENCE_PATH` to a reference mounted on the server. The standalone `/Users/<your-user>/Desktop/RUN_SCRIPTS/recover_recording.command` remains a separate local macOS helper and can still use its local reference fallback.

## Operational notes

- Images are limited to 25 MB and videos to 2 GB.
- Uploaded files and generated results are kept only until the retention period expires.
- Use a Linux VM or desktop agent with enough free disk space for the original, temporary candidates, and output. For a 2 GB video, plan for substantially more than 2 GB of free space.
- SQLite and local persistent storage are intended for one worker. Move job state to Postgres/Redis and files to object storage before adding multiple workers.
