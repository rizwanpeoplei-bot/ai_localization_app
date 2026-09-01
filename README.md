# AI Video Localization POC

This repository implements the Milestone 0 proof of concept for ElevenLabs Dubbing v2 with English, Urdu, and Hindi. It includes a local web submission interface and the original CLI, but it does not include the production SaaS database, billing, authentication, or queues.

## Safety and cost

The CLI defaults to the mock provider. Live calls require both `--provider elevenlabs` and `--confirm-billable`. Live runs may incur ElevenLabs charges. API keys, source samples, and generated artifacts are ignored by Git.

## Start the local web UI with Docker

Docker is recommended because the interface needs FFmpeg, FFprobe, libass, and Urdu/Hindi fonts to process submitted jobs.

```bash
cd /home/muhammad-rizwan/Sites/AILocalization
mkdir -p artifacts
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose -f compose.ui.yaml up --build
```

Open [http://localhost:3000](http://localhost:3000). The UI accepts a local MP4 upload, a direct public HTTP(S) MP4 URL, or a single YouTube video/Shorts link, plus:

- English, Urdu, and Hindi source/target selection
- Mock or live ElevenLabs provider
- Subtitle file or subtitle burn-in mode
- PNG, JPG, or WebP logo, position, and size
- Brightness from `-50` to `+50`
- Output volume from `0%` to `200%`
- Final preview and artifact downloads

Mock mode only validates ingestion and media processing: it reuses the source audio and emits a deterministic sample transcript. Real translated voice and source-derived subtitles require the live ElevenLabs provider and may incur charges.

Direct URL ingestion blocks localhost, private networks, link-local addresses, credentials, unsafe schemes, oversized responses, and unsafe redirects. YouTube imports use the pinned downloader in the Docker image, accept single video/Shorts links only, and require confirmation that you own or have permission to process the source. TikTok, Facebook, playlists, channel pages, and arbitrary HTML page URLs are not supported.

For a live run, create the ignored `.env.local` from `.env.example`, set `ELEVENLABS_API_KEY`, then start Compose with:

```bash
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) \
  docker compose --env-file .env.local -f compose.ui.yaml up --build
```

The UI processes provider work sequentially. Job progress is held in memory, while source files, settings, manifests, and results remain durable under `artifacts/<run-id>/`.

## Start the web UI directly on the host

Use this only when the documented FFmpeg and font dependencies are installed:

```bash
nvm use
npm install
npm run build
npm run web
```

## Requirements

- Docker with Linux container support.
- For host development: Node 24, npm 11.6.2, FFmpeg/FFprobe with libass, fontconfig, Noto Sans, Noto Sans Devanagari, Noto Nastaliq Urdu, and yt-dlp for YouTube imports.

## Install and verify on the host

```bash
nvm use
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

FFmpeg-dependent integration tests skip on a host without the required binaries/fonts; the Docker verification is authoritative.

## Docker build

```bash
docker build -f Dockerfile.poc -t ai-localization-poc .
```

Run as the host user so mounted artifacts remain writable:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/samples:/workspace/samples:ro" \
  -v "$PWD/artifacts:/workspace/artifacts" \
  ai-localization-poc \
  matrix --config samples/matrix.example.json --provider mock --output artifacts
```

## Single mocked pair

```bash
npm run build
npm run poc -- run \
  --input samples/input/en.mp4 \
  --source-language en \
  --target-language ur \
  --provider mock \
  --output artifacts
```

## Live matrix

1. Add the three licensed files described in `samples/README.md`.
2. Copy `.env.example` to `.env.local` and set `ELEVENLABS_API_KEY`.
3. Pass the ignored file to Docker and explicitly confirm billing:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env-file .env.local \
  -v "$PWD/samples:/workspace/samples:ro" \
  -v "$PWD/artifacts:/workspace/artifacts" \
  ai-localization-poc \
  matrix \
  --config samples/matrix.example.json \
  --provider elevenlabs \
  --confirm-billable \
  --output artifacts
```

The command writes the manifest path on completion. Provider projects are retained for review.

## Resume and cleanup

```bash
npm run poc -- resume --manifest artifacts/<run-id>/manifest.json
npm run poc -- cleanup --manifest artifacts/<run-id>/manifest.json
```

Live resume requires `--confirm-billable`; cleanup does not create new billed work. Cleanup permanently deletes the provider projects but preserves local artifacts.

## Outputs

Each pair directory contains lossless provider audio, normalized target transcript JSON, UTF-8 SRT, a muxed MP4, a subtitle-burned MP4, FFprobe evidence, and a blank bilingual scorecard. The run manifest is updated atomically after every durable stage and excludes API keys and signed URLs.

## Troubleshooting

- `ELEVENLABS_API_KEY_REQUIRED`: set the key only for a live run.
- `BILLABLE_CONFIRMATION_REQUIRED`: add `--confirm-billable` after reviewing cost implications.
- `SUBTITLE_FONTS_MISSING`: use the Docker image or install the documented Noto fonts.
- `YOUTUBE_DOWNLOADER_MISSING`: use the Docker image, which includes the pinned downloader.
- `YOUTUBE_VIDEO_UNAVAILABLE`: use a public, unrestricted video that does not require account cookies.
- `UNSUPPORTED_*`: normalize the POC source to H.264/AAC MP4 at or below 1080p.
- Interrupted runs: use `resume` with the existing manifest; do not start a new billable run.

Live acceptance remains blocked until a paid key, three licensed samples, and bilingual reviewers are available.
