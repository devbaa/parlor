# Parlor

On-device, real-time multimodal AI. Have natural voice and vision conversations with an AI that runs entirely on your machine.

Parlor uses [Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it) for understanding speech and vision, and [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) for text-to-speech. You talk, show your camera, and it talks back, all locally.

https://github.com/user-attachments/assets/placeholder

> **Research preview.** This is an early experiment. Expect rough edges and bugs.

## How it works

```
Browser (mic + camera)
    │
    │  WebSocket (audio PCM + JPEG frames)
    ▼
FastAPI server
    ├── Gemma 4 E2B via LiteRT-LM (GPU)  →  understands speech + vision
    └── Kokoro TTS (MLX on Mac, ONNX on Linux)  →  speaks back
    │
    │  WebSocket (streamed audio chunks)
    ▼
Browser (playback + transcript)
```

- **Voice Activity Detection** in the browser ([Silero VAD](https://github.com/ricky0123/vad)). Hands-free, no push-to-talk.
- **Barge-in.** Interrupt the AI mid-sentence by speaking.
- **Sentence-level TTS streaming.** Audio starts playing before the full response is generated.

## Requirements

- Python 3.12+
- macOS with Apple Silicon (M1/M2/M3/M4), or Linux with a supported GPU
- ~3 GB free RAM for the model

## Quick start

```bash
# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

cd src
uv sync
uv run python server.py
```

Open [http://localhost:8000](http://localhost:8000), grant camera and microphone access, and start talking.

Models are downloaded automatically on first run (~2.6 GB for Gemma 4 E2B, plus TTS models).

## Configuration

| Variable     | Default                        | Description                                    |
| ------------ | ------------------------------ | ---------------------------------------------- |
| `MODEL_PATH` | auto-download from HuggingFace | Path to a local `gemma-4-E2B-it.litertlm` file |
| `PORT`       | `8000`                         | Server port                                    |

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
src/
├── server.py          # FastAPI WebSocket server + Gemma 4 inference
├── tts.py             # Platform-aware TTS (MLX on Mac, ONNX on Linux)
├── index.html         # Frontend UI (VAD, camera, audio playback)
└── pyproject.toml     # Dependencies
benchmarks/
├── bench.py           # End-to-end WebSocket benchmark
└── benchmark_tts.py   # TTS backend comparison
```

## Acknowledgments

- [Gemma 4](https://ai.google.dev/gemma) by Google DeepMind
- [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) by Google AI Edge
- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) TTS by Hexgrad
- [Silero VAD](https://github.com/snakers4/silero-vad) for browser voice activity detection

## License

[Apache 2.0](LICENSE)
