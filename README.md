# Parlor

On-device, real-time multimodal AI. Have natural voice and vision conversations with an AI that runs entirely on your machine.

Parlor uses [Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it) for understanding speech and vision, and [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) for text-to-speech. You talk, show your camera, and it talks back, all locally.

https://github.com/user-attachments/assets/cb0ffb2e-f84f-48e7-872c-c5f7b5c6d51f

> **Research preview.** This is an early experiment. Expect rough edges and bugs.

# Why?

I'm [self-hosting a totally free voice AI](https://www.fikrikarim.com/bule-ai-initial-release/) on my home server to help people learn speaking English. It has hundreds of monthly active users, and I've been thinking about how to keep it free while making it sustainable.

The obvious answer: run everything on-device, eliminating any server cost. Six months ago I needed an RTX 5090 to run just the voice models in real-time.

Google just released a super capable small model that I can run on my M3 Pro in real-time, with vision too! Sure you can't do agentic coding with this, but it is a game-changer for people learning a new language. Imagine a few years from now that people can run this locally on their phones. They can point their camera at objects and talk about them. And this model is multi-lingual, so people can always fallback to their native language if they want. This is essentially what OpenAI demoed a few years ago.

## How it works

```
Browser (mic + camera)
    │
    │  WebSocket (audio PCM + JPEG frames)
    ▼
FastAPI server
    ├── Gemma 4 E2B via LiteRT-LM (GPU)  →  understands speech + vision
    └── Kokoro TTS (MLX on Mac, ONNX on Linux/Windows)  →  speaks back
    │
    │  WebSocket (streamed audio chunks)
    ▼
Browser (playback + transcript)
```

- **Voice Activity Detection** in the browser ([Silero VAD](https://github.com/ricky0123/vad)). Hands-free, no push-to-talk.
- **Barge-in.** Interrupt the AI mid-sentence by speaking.
- **Sentence-level TTS streaming.** Audio starts playing before the full response is generated.

## Supported OS / hardware matrix

| OS | CPU/Hardware | Inference (Gemma via LiteRT-LM) | TTS backend | Status |
| --- | --- | --- | --- | --- |
| macOS (Apple Silicon) | M-series (arm64) | ✅ GPU | ✅ `mlx-audio` (default), optional `kokoro-onnx` | **Supported** |
| Linux (x86_64 / aarch64) | GPU strongly recommended | ✅ GPU/CPU via LiteRT-LM runtime | ✅ `kokoro-onnx` (ONNX Runtime CPU) | **Supported** |
| Windows (`win32`) | x86_64 | ❌ Native LiteRT-LM runtime wheel unavailable | ✅ `kokoro-onnx` (ONNX Runtime CPU) | **Partial** (TTS only) |

> Windows note: as of LiteRT-LM `0.10.1`, `litert_lm_api` wheels are published for macOS arm64 and Linux (x86_64/aarch64), but not native Windows. For Windows users, run the backend in WSL2/Linux and access from your Windows browser.

## Requirements

- Python 3.12+
- macOS with Apple Silicon, or Linux with a supported GPU
- Windows is currently supported for TTS dependencies only; full local inference requires WSL2/Linux due to LiteRT-LM packaging limits
- ~3 GB free RAM for the model

## Quick start

```bash
git clone https://github.com/fikrikarim/parlor.git
cd parlor

# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

cd src
uv sync
cd ..

# Install frontend build tooling (Node.js is build-time only)
cd frontend
npm install
npm run build
cd ..

# Run the Python server that serves compiled frontend assets from public/
cd src
uv run server.py
```

Open [http://localhost:8000](http://localhost:8000), grant camera and microphone access, and start talking.

Models are downloaded automatically on first run (~2.6 GB for Gemma 4 E2B, plus TTS models).

## Desktop app (Tauri v2)

The `desktop/` workspace is now the desktop entrypoint. Tauri launches a bundled backend sidecar (`parlor-backend`) on a dynamic localhost port, waits for `/api/health`, then opens the app window to that URL.

For packaging we **keep Vite output in `public/`** (same artifacts used by FastAPI) and point Tauri at that folder (`desktop/src-tauri/tauri.conf.json` → `build.frontendDist = "../../public"`). This avoids a second frontend output location and ensures one canonical asset set for web + desktop.

```bash
# from repo root
cd desktop
npm install
npm run dev
```

Desktop release build from repo root (enforced order):

```bash
npm run build:desktop
```

This runs:
1. `npm run build:frontend` (Vite build to `public/`)
2. `npm run check:manifest` (requires `public/.vite/manifest.json`)
3. `npm run build:backend` (freeze Python backend to `src/bin/parlor-backend-<target>`)
4. `npm run tauri:build` (package app)

`tauri build` also runs the same `prepackage` step via `beforeBuildCommand`, so stale `public/assets` cannot slip into release artifacts.

## Frontend development and build

Frontend source files live in `frontend/` and are compiled with Vite into `public/` (`assets/`, optional `vendor/`, and `.vite/manifest.json`).
The Python FastAPI app serves static artifacts at runtime from `public/` (`/assets/*`); there is no Node.js server in production.

```bash
# from repo root
cd frontend
npm install

# one-time or CI build
npm run build

# optional local frontend iteration with Vite dev server
npm run dev
```

When running `uv run server.py`, FastAPI serves built assets from `public/assets`, reads Vite metadata from `public/.vite/manifest.json`, and injects hashed asset tags into `public/index.html` before returning the response.

## Configuration

| Variable     | Default                        | Description                                    |
| ------------ | ------------------------------ | ---------------------------------------------- |
| `MODEL_PATH` | auto-download from HuggingFace | Path to a local `gemma-4-E2B-it.litertlm` file |
| `PORT`       | `8000`                         | Server port                                    |
| `SSL_CERTFILE` | unset                        | Optional TLS certificate file for HTTPS/WSS    |
| `SSL_KEYFILE` | unset                         | Optional TLS key file for HTTPS/WSS            |

Set both `SSL_CERTFILE` and `SSL_KEYFILE` to enable HTTPS. The frontend automatically upgrades to `wss://` for `/ws` when loaded over `https://`.

## Performance (Apple M3 Pro)

| Stage                            | Time          |
| -------------------------------- | ------------- |
| Speech + vision understanding    | ~1.8-2.2s     |
| Response generation (~25 tokens) | ~0.3s         |
| Text-to-speech (1-3 sentences)   | ~0.3-0.7s     |
| **Total end-to-end**             | **~2.5-3.0s** |

Decode speed: ~83 tokens/sec on GPU (Apple M3 Pro).

## Project structure

```
frontend/
├── app.js                # Alpine app logic
├── index.html            # Frontend template for Vite dev
├── main.js               # Vite entrypoint
├── styles.css            # Tailwind v4 entry + app styles
├── tailwind.config.js    # Tailwind content scanning
├── vite.config.js        # Build to public/ (assets + .vite manifest)
└── package.json          # Frontend build dependencies

public/
├── index.html            # Runtime HTML template copied from frontend/index.html
├── assets/               # Compiled frontend JS/CSS artifacts from Vite
└── .vite/                # Vite manifest for hashed asset injection

src/
├── server.py             # FastAPI WebSocket server + static dist serving
├── tts.py                # Platform-aware TTS (MLX on Mac, ONNX on Linux/Windows)
├── pyproject.toml        # Python dependencies
└── benchmarks/
    ├── bench.py          # End-to-end WebSocket benchmark
    └── benchmark_tts.py  # TTS backend comparison

desktop/
└── src-tauri/
    ├── src/main.rs       # Tauri desktop entrypoint + backend sidecar lifecycle
    └── tauri.conf.json   # Window + bundle/sidecar configuration
```

## Acknowledgments

- [Gemma 4](https://ai.google.dev/gemma) by Google DeepMind
- [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) by Google AI Edge
- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) TTS by Hexgrad
- [Silero VAD](https://github.com/snakers4/silero-vad) for browser voice activity detection

## License

[Apache 2.0](LICENSE)
