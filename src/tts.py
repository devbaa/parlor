"""Platform-aware Kokoro TTS runtime selection."""

import os
import platform
import sys

import numpy as np


def _is_apple_silicon() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


class TTSBackend:
    """Unified TTS interface."""

    sample_rate: int = 24000

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.1) -> np.ndarray:
        raise NotImplementedError


class MLXBackend(TTSBackend):
    """mlx-audio backend (Apple Silicon GPU via MLX)."""

    def __init__(self) -> None:
        from mlx_audio.tts.generate import load_model

        self._model = load_model("mlx-community/Kokoro-82M-bf16")
        self.sample_rate = self._model.sample_rate
        # Warmup: triggers pipeline init (phonemizer, spacy, etc.)
        list(self._model.generate(text="Hello", voice="af_heart", speed=1.0))

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.1) -> np.ndarray:
        results = list(self._model.generate(text=text, voice=voice, speed=speed))
        return np.concatenate([np.array(r.audio) for r in results])


class ONNXBackend(TTSBackend):
    """kokoro-onnx backend (ONNX Runtime, CPU)."""

    def __init__(self) -> None:
        import kokoro_onnx
        from huggingface_hub import hf_hub_download

        model_path = hf_hub_download("fastrtc/kokoro-onnx", "kokoro-v1.0.onnx")
        voices_path = hf_hub_download("fastrtc/kokoro-onnx", "voices-v1.0.bin")

        self._model = kokoro_onnx.Kokoro(model_path, voices_path)
        self.sample_rate = 24000

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.1) -> np.ndarray:
        pcm, _sr = self._model.create(text, voice=voice, speed=speed)
        return pcm


def _unsupported_platform_error(platform_name: str) -> RuntimeError:
    return RuntimeError(
        "TTS backend unavailable on this platform.\n"
        f"Detected platform: {platform_name}.\n"
        "Supported TTS platforms are:\n"
        "  - darwin/arm64: mlx-audio (default) or kokoro-onnx with KOKORO_ONNX=1\n"
        "  - linux: kokoro-onnx\n"
        "  - win32: kokoro-onnx\n"
        "Remediation: run on one of the supported platforms, or install a supported TTS backend "
        "and re-run `uv sync` in src/."
    )


def _backend_import_error_message(backend_name: str, err: ImportError) -> RuntimeError:
    return RuntimeError(
        f"Unable to load TTS backend '{backend_name}'.\n"
        f"Import error: {err}\n"
        "Remediation:\n"
        "  1) From src/, run `uv sync` to install platform-specific dependencies.\n"
        "  2) For macOS Apple Silicon, use mlx-audio (default) or set KOKORO_ONNX=1 to force ONNX.\n"
        "  3) For Linux/Windows, ensure kokoro-onnx and onnxruntime are installed."
    )


def load() -> TTSBackend:
    """Load the best available TTS backend for this platform."""
    platform_name = sys.platform

    if platform_name == "darwin":
        if _is_apple_silicon() and not os.environ.get("KOKORO_ONNX"):
            try:
                backend: TTSBackend = MLXBackend()
                print(f"TTS: mlx-audio (Apple GPU, sample_rate={backend.sample_rate})")
                return backend
            except ImportError:
                print("TTS: mlx-audio not installed, falling back to kokoro-onnx")
            except Exception as err:
                raise RuntimeError(
                    "mlx-audio backend failed to initialize on Apple Silicon.\n"
                    "Remediation: set KOKORO_ONNX=1 to force ONNX runtime, or reinstall mlx-audio with `uv sync`."
                ) from err

        try:
            backend = ONNXBackend()
            print(f"TTS: kokoro-onnx (CPU, sample_rate={backend.sample_rate})")
            return backend
        except ImportError as err:
            raise _backend_import_error_message("kokoro-onnx", err) from err

    if platform_name == "linux":
        try:
            backend = ONNXBackend()
            print(f"TTS: kokoro-onnx (CPU, sample_rate={backend.sample_rate})")
            return backend
        except ImportError as err:
            raise _backend_import_error_message("kokoro-onnx", err) from err

    if platform_name == "win32":
        try:
            backend = ONNXBackend()
            print(f"TTS: kokoro-onnx (CPU, sample_rate={backend.sample_rate})")
            return backend
        except ImportError as err:
            raise _backend_import_error_message("kokoro-onnx", err) from err

    raise _unsupported_platform_error(platform_name)
