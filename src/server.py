"""Parlor — on-device, real-time multimodal AI (voice + vision)."""

import asyncio
import base64
import json
import logging
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import uvicorn
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import litert_lm
import storage
import tts

HF_REPO = "litert-community/gemma-4-E2B-it-litert-lm"
HF_FILENAME = "gemma-4-E2B-it.litertlm"
DB_PATH = Path(__file__).parent / "parlor.db"
PUBLIC_DIR = Path(__file__).parent / "public"
DIST_DIR = PUBLIC_DIR / "dist"
MANIFEST_PATH = DIST_DIR / "manifest.json"
INDEX_TEMPLATE_PATH = Path(__file__).parent / "index.html"

logger = logging.getLogger(__name__)


def resolve_model_path() -> str:
    path = os.environ.get("MODEL_PATH", "")
    if path:
        return path
    from huggingface_hub import hf_hub_download
    print(f"Downloading {HF_REPO}/{HF_FILENAME} (first run only)...")
    return hf_hub_download(repo_id=HF_REPO, filename=HF_FILENAME)


MODEL_PATH = resolve_model_path()
SYSTEM_PROMPT = (
    "You are a friendly, conversational AI assistant. The user is talking to you "
    "through a microphone and showing you their camera. "
    "You MUST always use the respond_to_user tool to reply. "
    "First transcribe exactly what the user said, then write your response."
)

SENTENCE_SPLIT_RE = re.compile(r'(?<=[.!?])\s+')

engine = None
tts_backend = None


def load_models():
    global engine, tts_backend
    print(f"Loading Gemma 4 E2B from {MODEL_PATH}...")
    engine = litert_lm.Engine(
        MODEL_PATH,
        backend=litert_lm.Backend.GPU,
        vision_backend=litert_lm.Backend.GPU,
        audio_backend=litert_lm.Backend.CPU,
    )
    engine.__enter__()
    print("Engine loaded.")

    tts_backend = tts.load()


@asynccontextmanager
async def lifespan(app):
    storage.init_db(DB_PATH)
    await asyncio.get_event_loop().run_in_executor(None, load_models)
    yield


app = FastAPI(lifespan=lifespan)
app.mount("/dist", StaticFiles(directory=DIST_DIR, check_dir=False), name="dist")


class ThreadPayload(BaseModel):
    title: str | None = None


def save_temp(data: bytes, suffix: str) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(data)
    tmp.close()
    return tmp.name


def split_sentences(text: str) -> list[str]:
    """Split text into sentences for streaming TTS."""
    parts = SENTENCE_SPLIT_RE.split(text.strip())
    return [s.strip() for s in parts if s.strip()]


def vite_asset_tags() -> tuple[str, str]:
    """Return css and js tags for the Vite-built entrypoint."""
    if not MANIFEST_PATH.exists():
        return "", ""

    manifest = json.loads(MANIFEST_PATH.read_text())
    entry = manifest.get("frontend/main.js")
    if entry is None:
        entry = next((value for value in manifest.values() if value.get("isEntry")), None)
    if entry is None:
        return "", ""

    css_files = entry.get("css", [])
    css_tags = "\n".join(f'<link rel="stylesheet" href="/dist/{css_file}">' for css_file in css_files)
    js_tag = f'<script type="module" src="/dist/{entry["file"]}"></script>'
    return css_tags, js_tag


@app.get("/")
async def root():
    template = INDEX_TEMPLATE_PATH.read_text()
    css_tags, js_tag = vite_asset_tags()
    html = template.replace("<!-- VITE_CSS -->", css_tags).replace("<!-- VITE_JS -->", js_tag)
    return HTMLResponse(content=html)


@app.get("/api/threads")
async def get_threads():
    return {"threads": storage.list_threads()}


@app.post("/api/threads")
async def create_thread(payload: ThreadPayload | None = None):
    thread = storage.create_thread(
        thread_id=str(uuid.uuid4()),
        title=payload.title if payload else None,
    )
    return {"thread": thread}


@app.patch("/api/threads/{thread_id}")
async def update_thread(thread_id: str, payload: ThreadPayload | None = None):
    thread = storage.update_thread_title(thread_id, payload.title if payload else None)
    if thread is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    return {"thread": thread}


@app.delete("/api/threads/{thread_id}")
async def delete_thread(thread_id: str):
    if not storage.soft_delete_thread(thread_id):
        raise HTTPException(status_code=404, detail="Thread not found")
    return {"ok": True}


@app.get("/api/threads/{thread_id}/messages")
async def get_thread_messages(thread_id: str):
    if not storage.thread_exists(thread_id):
        raise HTTPException(status_code=404, detail="Thread not found")
    return {"thread_id": thread_id, "messages": storage.list_messages(thread_id)}


def resolve_active_thread_id(message: dict[str, Any]) -> str:
    payload_thread_id = (message.get("thread_id") or "").strip()
    if payload_thread_id:
        if not storage.thread_exists(payload_thread_id):
            raise HTTPException(status_code=404, detail="Thread not found")
        return payload_thread_id

    created = storage.create_thread(thread_id=str(uuid.uuid4()))
    return created["id"]


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    # Per-connection tool state captured via closure
    tool_result = {}

    def respond_to_user(transcription: str, response: str) -> str:
        """Respond to the user's voice message.

        Args:
            transcription: Exact transcription of what the user said in the audio.
            response: Your conversational response to the user. Keep it to 1-4 short sentences.
        """
        tool_result["transcription"] = transcription
        tool_result["response"] = response
        return "OK"

    conversation = engine.create_conversation(
        messages=[{"role": "system", "content": SYSTEM_PROMPT}],
        tools=[respond_to_user],
    )
    conversation.__enter__()

    interrupted = asyncio.Event()
    msg_queue = asyncio.Queue()

    async def receiver():
        """Receive messages from WebSocket and route them."""
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                if msg.get("type") == "interrupt":
                    interrupted.set()
                    print("Client interrupted")
                else:
                    await msg_queue.put(msg)
        except WebSocketDisconnect:
            await msg_queue.put(None)

    recv_task = asyncio.create_task(receiver())

    try:
        while True:
            msg = await msg_queue.get()
            if msg is None:
                break

            audio_path = image_path = None
            interrupted.clear()

            try:
                try:
                    thread_id = resolve_active_thread_id(msg)
                except HTTPException:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "status": 404,
                        "detail": "Thread not found",
                    }))
                    continue

                if msg.get("audio"):
                    audio_path = save_temp(base64.b64decode(msg["audio"]), ".wav")
                if msg.get("image"):
                    image_path = save_temp(base64.b64decode(msg["image"]), ".jpg")

                # Build multimodal content
                content = []
                if audio_path:
                    content.append({"type": "audio", "path": os.path.abspath(audio_path)})
                if image_path:
                    content.append({"type": "image", "path": os.path.abspath(image_path)})

                if audio_path and image_path:
                    content.append({"type": "text", "text": "The user just spoke to you (audio) while showing their camera (image). Respond to what they said, referencing what you see if relevant."})
                elif audio_path:
                    content.append({"type": "text", "text": "The user just spoke to you. Respond to what they said."})
                elif image_path:
                    content.append({"type": "text", "text": "The user is showing you their camera. Describe what you see."})
                else:
                    content.append({"type": "text", "text": msg.get("text", "Hello!")})

                # LLM inference
                t0 = time.time()
                tool_result.clear()
                response = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: conversation.send_message({"role": "user", "content": content})
                )
                llm_time = time.time() - t0

                # Extract response from tool call or fallback to raw text
                if tool_result:
                    strip = lambda s: s.replace('<|"|>', "").strip()
                    transcription = strip(tool_result.get("transcription", ""))
                    text_response = strip(tool_result.get("response", ""))
                    print(f"LLM ({llm_time:.2f}s) [tool] heard: {transcription!r} → {text_response}")
                else:
                    transcription = None
                    text_response = response["content"][0]["text"]
                    print(f"LLM ({llm_time:.2f}s) [no tool]: {text_response}")

                user_content = transcription or msg.get("text") or ("[audio+image]" if audio_path and image_path else "[audio]" if audio_path else "[image]")
                tts_time = None
                assistant_content = text_response

                def persist_turn(tts_elapsed: float | None = None) -> None:
                    try:
                        storage.ensure_thread(thread_id)
                        storage.insert_message(
                            message_id=str(uuid.uuid4()),
                            thread_id=thread_id,
                            role="user",
                            transcription=transcription,
                            content=user_content,
                        )
                        storage.maybe_set_generated_title(
                            thread_id,
                            transcription=transcription,
                            content=user_content,
                        )
                        storage.insert_message(
                            message_id=str(uuid.uuid4()),
                            thread_id=thread_id,
                            role="assistant",
                            content=assistant_content,
                            llm_time=round(llm_time, 3),
                            tts_time=round(tts_elapsed, 3) if tts_elapsed is not None else None,
                        )
                    except Exception:
                        logger.exception("Failed to persist websocket turn for thread %s", thread_id)

                if interrupted.is_set():
                    print("Interrupted after LLM, skipping response")
                    persist_turn(None)
                    continue

                reply = {
                    "type": "text",
                    "text": text_response,
                    "llm_time": round(llm_time, 2),
                    "thread_id": thread_id,
                }
                if transcription:
                    reply["transcription"] = transcription
                await ws.send_text(json.dumps(reply))

                if interrupted.is_set():
                    print("Interrupted before TTS, skipping audio")
                    persist_turn(None)
                    continue

                # Streaming TTS: split into sentences and send chunks progressively
                sentences = split_sentences(text_response)
                if not sentences:
                    sentences = [text_response]

                tts_start = time.time()

                # Signal start of audio stream
                await ws.send_text(json.dumps({
                    "type": "audio_start",
                    "sample_rate": tts_backend.sample_rate,
                    "sentence_count": len(sentences),
                    "thread_id": thread_id,
                }))

                for i, sentence in enumerate(sentences):
                    if interrupted.is_set():
                        print(f"Interrupted during TTS (sentence {i+1}/{len(sentences)})")
                        break

                    # Generate audio for this sentence
                    pcm = await asyncio.get_event_loop().run_in_executor(
                        None, lambda s=sentence: tts_backend.generate(s)
                    )

                    if interrupted.is_set():
                        break

                    # Convert to 16-bit PCM and send as base64
                    pcm_int16 = (pcm * 32767).clip(-32768, 32767).astype(np.int16)
                    await ws.send_text(json.dumps({
                        "type": "audio_chunk",
                        "audio": base64.b64encode(pcm_int16.tobytes()).decode(),
                        "index": i,
                        "thread_id": thread_id,
                    }))

                tts_time = time.time() - tts_start
                print(f"TTS ({tts_time:.2f}s): {len(sentences)} sentences")

                if not interrupted.is_set():
                    await ws.send_text(json.dumps({
                        "type": "audio_end",
                        "tts_time": round(tts_time, 2),
                        "thread_id": thread_id,
                    }))

                persist_turn(tts_time)

            finally:
                for p in [audio_path, image_path]:
                    if p and os.path.exists(p):
                        os.unlink(p)

    except WebSocketDisconnect:
        print("Client disconnected")
    finally:
        recv_task.cancel()
        conversation.__exit__(None, None, None)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
