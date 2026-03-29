"""
CookedBook Chef Voice Assistant — server component.

Receives audio over WebSocket, transcribes with faster-whisper,
queries Ollama with recipe context, responds with Piper TTS audio.
"""

import asyncio
import base64
import io
import json
import logging
import os
import subprocess
import tempfile
import wave
from pathlib import Path

import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("chef")

# --- Config (env vars with sane defaults) ---
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://192.168.50.115:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:9b-q4_K_M")
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "base.en")
PIPER_MODEL_DIR = os.environ.get("PIPER_MODEL_DIR", "/opt/chef/models")
PIPER_VOICE = os.environ.get("PIPER_VOICE", "en_US-ryan-low")
INPUT_SAMPLE_RATE = 16000

# --- Lazy-loaded heavy deps ---
_whisper_model = None
_piper_voice = None


def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        log.info("Loading faster-whisper model: %s", WHISPER_MODEL_SIZE)
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(
            WHISPER_MODEL_SIZE,
            device="cpu",
            compute_type="int8",
        )
        log.info("Whisper model loaded")
    return _whisper_model


def get_piper():
    """Load the Piper voice model. Downloads if not present."""
    global _piper_voice
    if _piper_voice is None:
        model_dir = Path(PIPER_MODEL_DIR)
        model_dir.mkdir(parents=True, exist_ok=True)
        onnx_path = model_dir / f"{PIPER_VOICE}.onnx"
        json_path = model_dir / f"{PIPER_VOICE}.onnx.json"

        if not onnx_path.exists():
            log.info("Downloading Piper voice model: %s", PIPER_VOICE)
            # Parse voice name: en_US-lessac-medium -> en/en_US/lessac/medium/
            parts = PIPER_VOICE.split("-")
            lang = parts[0]                    # en_US
            lang_short = lang.split("_")[0]    # en
            name = parts[1]                    # lessac
            quality = parts[2]                 # medium
            base = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"
            url_prefix = f"{base}/{lang_short}/{lang}/{name}/{quality}/{PIPER_VOICE}"

            for suffix, dest in [(".onnx", onnx_path), (".onnx.json", json_path)]:
                url = url_prefix + suffix
                log.info("Downloading %s", url)
                subprocess.run(
                    ["wget", "-q", "-O", str(dest), url],
                    check=True, timeout=120,
                )

        log.info("Loading Piper voice: %s", onnx_path)
        from piper import PiperVoice
        _piper_voice = PiperVoice.load(str(onnx_path))
        log.info("Piper voice loaded (sample_rate=%d)", _piper_voice.config.sample_rate)
    return _piper_voice


def transcribe_audio(pcm_bytes: bytes) -> str:
    """Transcribe raw 16kHz 16-bit mono PCM to text."""
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if len(samples) < INPUT_SAMPLE_RATE * 0.3:  # less than 0.3s, skip
        return ""
    model = get_whisper()
    segments, _info = model.transcribe(
        samples,
        beam_size=1,
        language="en",
        vad_filter=True,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    log.info("Transcribed: %s", text)
    return text


async def query_llm(transcript: str, recipe_text: str) -> str:
    """Send transcript + recipe context to Ollama, get a short answer."""
    system_prompt = (
        "You are Chef, a voice assistant for a cook in the kitchen. "
        "The cook is busy — hands dirty, things on the stove. "
        "ONE sentence max. Just the answer. Quantities, temps, times — exact numbers only. "
        "Do not repeat the question. Do not say 'according to the recipe'. "
        "Just answer directly like a sous chef would.\n\n"
        f"RECIPE:\n{recipe_text}"
    )

    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": transcript},
        ],
        "stream": False,
        "think": False,
        "options": {
            "temperature": 0.3,
            "num_predict": 150,
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
        resp.raise_for_status()
        data = resp.json()
        answer = data["message"]["content"].strip()

    log.info("LLM answer: %s", answer)
    return answer


def synthesize_speech(text: str) -> bytes:
    """Convert text to WAV using Piper TTS Python API."""
    voice = get_piper()
    buf = io.BytesIO()
    wf = wave.open(buf, "wb")
    voice.synthesize_wav(text, wf)
    wf.close()
    wav_bytes = buf.getvalue()
    log.info("Synthesized %d bytes of audio", len(wav_bytes))
    return wav_bytes


def synthesize_speech_cli(text: str) -> bytes:
    """Fallback: use piper CLI if the Python API fails."""
    model_path = Path(PIPER_MODEL_DIR) / f"{PIPER_VOICE}.onnx"
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp_path = f.name
    try:
        proc = subprocess.run(
            ["piper", "--model", str(model_path), "--output_file", tmp_path],
            input=text.encode(),
            capture_output=True,
            timeout=15,
        )
        if proc.returncode != 0:
            log.error("Piper CLI error: %s", proc.stderr.decode())
            return b""
        return Path(tmp_path).read_bytes()
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# --- FastAPI app ---
app = FastAPI(title="CookedBook Chef")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "model": OLLAMA_MODEL, "whisper": WHISPER_MODEL_SIZE}


@app.post("/api/chat")
async def chat_endpoint(body: dict):
    """Multi-turn chat with recipe context. Expects {messages: [...], recipe: "..."}."""
    messages = body.get("messages", [])
    recipe_text = body.get("recipe", "")

    system_prompt = (
        "You are a recipe assistant. Your #1 job is to answer questions ACCURATELY "
        "using the recipe below. When the recipe contains a specific time, temperature, "
        "or quantity, QUOTE IT EXACTLY. Do not make up numbers or paraphrase — use the "
        "actual values from the recipe.\n\n"
        "Personality: you're a tired, blunt line cook. Dry wit, terse, casual. "
        "Not mean, just over it. Mild swearing when natural.\n\n"
        "Rules:\n"
        "- ACCURACY FIRST. If the recipe says 12-15 minutes, say 12-15 minutes.\n"
        "- Terse. 1-3 sentences unless the question genuinely needs more.\n"
        "- No pleasantries, no preamble\n"
        "- If you don't know something and the recipe doesn't say, say you don't know\n"
        "- Drop useful cooking knowledge when relevant, but don't hallucinate recipe details\n"
        "- If the message is vague or off-topic: '*sigh*' or 'ask me about the food'\n"
        "- Use markdown bold and lists sparingly\n\n"
        f"RECIPE:\n{recipe_text}"
    )

    ollama_messages = [{"role": "system", "content": system_prompt}]
    for msg in messages:
        ollama_messages.append({"role": msg["role"], "content": msg["content"]})

    payload = {
        "model": OLLAMA_MODEL,
        "messages": ollama_messages,
        "stream": False,
        "think": False,
        "options": {
            "temperature": 0.4,
            "num_predict": 500,
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
        resp.raise_for_status()
        data = resp.json()
        answer = data["message"]["content"].strip()

    return {"reply": answer}


@app.post("/api/shopping-list")
async def shopping_list(body: dict):
    """Take a list of ingredients to buy and group them by store aisle via LLM."""
    need = body.get("need", [])
    have = body.get("have", [])
    recipe_name = body.get("recipe", "Recipe")

    if not need:
        return {"grouped": [], "raw": []}

    # Number the items so the LLM returns index→aisle mappings
    # instead of rewriting the ingredient text (which it mangles).
    numbered = "\n".join(f"{i}: {item}" for i, item in enumerate(need))

    prompt = (
        "Assign each numbered ingredient to a grocery store aisle. "
        "Output ONLY a JSON object mapping each number to an aisle name. "
        'Example: {"0": "Produce", "1": "Meat/Seafood", "2": "Dairy"}\n'
        "Use these aisle names: Produce, Meat/Seafood, Dairy, Spices/Seasonings, "
        "Canned Goods, Oils & Vinegars, Bakery, Dry Goods/Pasta, Condiments, Pantry Staples.\n"
        "Output ONLY the JSON object. No explanation.\n\n"
        f"Ingredients:\n{numbered}"
    )

    payload = {
        "model": OLLAMA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "think": False,
        "options": {"temperature": 0.1, "num_predict": 500},
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
            resp.raise_for_status()
            data = resp.json()
            answer = data["message"]["content"].strip()

        log.info("Shopping list LLM response: %s", answer)

        # Parse JSON — LLM might wrap in code fences
        cleaned = answer
        if "```" in cleaned:
            start = cleaned.index("```") + 3
            if cleaned[start:].startswith("json"):
                start += 4
            end = cleaned.index("```", start)
            cleaned = cleaned[start:end].strip()

        mapping = json.loads(cleaned)  # {"0": "Produce", "1": "Meat/Seafood", ...}

        # Build grouped output from the mapping, using original item text
        aisles = {}
        assigned = set()
        for idx_str, aisle in mapping.items():
            idx = int(idx_str)
            if 0 <= idx < len(need):
                assigned.add(idx)
                aisles.setdefault(aisle, []).append(need[idx])

        # Catch any items the LLM didn't assign
        for idx, item in enumerate(need):
            if idx not in assigned:
                aisles.setdefault("Other", []).append(item)

        grouped = [{"aisle": a, "items": items} for a, items in aisles.items()]
        return {"grouped": grouped, "raw": need, "recipe": recipe_name}

    except Exception as e:
        log.error("Shopping list LLM error: %s", e)
        # Fallback: return ungrouped
        return {"grouped": [{"aisle": "All Items", "items": need}], "raw": need, "recipe": recipe_name}


@app.websocket("/ws/voice")
async def voice_endpoint(ws: WebSocket):
    await ws.accept()
    log.info("WebSocket connected")

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            audio_b64 = msg.get("audio", "")
            text_query = msg.get("text", "")
            recipe_text = msg.get("recipe", "")

            # Two modes: audio (PCM for STT) or text (pre-transcribed, e.g. from wake word)
            if text_query:
                transcript = text_query.strip()
                await ws.send_json({"type": "transcript", "text": transcript})
            elif audio_b64:
                pcm_bytes = base64.b64decode(audio_b64)
                await ws.send_json({"type": "status", "state": "transcribing"})
                transcript = await asyncio.to_thread(transcribe_audio, pcm_bytes)
                if not transcript:
                    await ws.send_json({"type": "status", "state": "idle"})
                    await ws.send_json({"type": "error", "message": "Could not understand audio"})
                    continue
                await ws.send_json({"type": "transcript", "text": transcript})
            else:
                await ws.send_json({"type": "error", "message": "No audio or text data"})
                continue

            # Step 2: Query LLM
            await ws.send_json({"type": "status", "state": "thinking"})
            answer = await query_llm(transcript, recipe_text)
            await ws.send_json({"type": "answer", "text": answer})

            # Step 3: Synthesize speech
            await ws.send_json({"type": "status", "state": "speaking"})
            try:
                wav_bytes = await asyncio.to_thread(synthesize_speech, answer)
            except Exception:
                log.warning("Piper Python API failed, trying CLI fallback")
                wav_bytes = await asyncio.to_thread(synthesize_speech_cli, answer)

            if wav_bytes:
                await ws.send_json({
                    "type": "audio",
                    "wav": base64.b64encode(wav_bytes).decode(),
                })

            await ws.send_json({"type": "status", "state": "idle"})

    except WebSocketDisconnect:
        log.info("WebSocket disconnected")
    except Exception as e:
        log.exception("WebSocket error: %s", e)
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


STATIC_DIR = os.environ.get("STATIC_DIR", "/opt/chef/public")

if __name__ == "__main__":
    log.info("Preloading models...")
    get_whisper()
    get_piper()

    # Serve Hugo static site if the directory exists (same-origin = no CORS/XSS issues)
    static_path = Path(STATIC_DIR)
    if static_path.is_dir():
        app.mount("/", StaticFiles(directory=str(static_path), html=True), name="static")
        log.info("Serving static site from %s", static_path)
    else:
        log.warning("No static dir at %s — API-only mode", static_path)

    log.info("Server ready on :8099")
    uvicorn.run(app, host="0.0.0.0", port=8099, log_level="info")
