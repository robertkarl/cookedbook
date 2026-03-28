#!/usr/bin/env python3
"""
Test the Chef voice pipeline without a browser.

Usage:
  # Generate speech from text and send it (no mic needed):
  python test-voice.py "how much lemon juice"

  # Send a pre-recorded WAV file:
  python test-voice.py --wav recording.wav

  # Record from your mic for 3 seconds, then send:
  python test-voice.py --record 3

  # Specify a different recipe (default: carnitas):
  python test-voice.py "what's the next step" --recipe pan-seared-ny-strip

All modes send audio to the Chef WebSocket and print the transcript,
LLM answer, and save the TTS response as response.wav.
"""

import argparse
import asyncio
import base64
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import websockets
except ImportError:
    print("pip install websockets")
    sys.exit(1)


CHEF_WS = "wss://chef.robertkarl.net/ws/voice"
RECIPES_DIR = Path(__file__).parent.parent / "content" / "recipes"
SAMPLE_RATE = 16000


def load_recipe(name: str) -> str:
    """Load recipe markdown by slug."""
    path = RECIPES_DIR / f"{name}.md"
    if not path.exists():
        # Try with index.md for bundle-style recipes
        path = RECIPES_DIR / name / "index.md"
    if not path.exists():
        print(f"Recipe not found: {name}")
        print(f"Available: {', '.join(p.stem for p in RECIPES_DIR.glob('*.md') if p.stem != '_index')}")
        sys.exit(1)
    text = path.read_text()
    # Strip frontmatter
    if text.startswith("---"):
        end = text.index("---", 3)
        text = text[end + 3:].strip()
    return text


def text_to_pcm(text: str) -> bytes:
    """Use macOS `say` to generate speech, convert to 16kHz 16-bit mono PCM."""
    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as f:
        aiff_path = f.name
    wav_path = aiff_path.replace(".aiff", ".wav")

    try:
        # Generate speech with macOS TTS
        subprocess.run(
            ["say", "-o", aiff_path, text],
            check=True, capture_output=True,
        )
        # Convert to 16kHz 16-bit mono WAV
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
             aiff_path, wav_path],
            check=True, capture_output=True,
        )
        # Read WAV, skip 44-byte header to get raw PCM
        wav_bytes = Path(wav_path).read_bytes()
        return wav_bytes[44:]
    finally:
        Path(aiff_path).unlink(missing_ok=True)
        Path(wav_path).unlink(missing_ok=True)


def wav_file_to_pcm(wav_path: str) -> bytes:
    """Read a WAV file, resample to 16kHz mono 16-bit PCM if needed."""
    out_path = tempfile.mktemp(suffix=".wav")
    try:
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
             wav_path, out_path],
            check=True, capture_output=True,
        )
        wav_bytes = Path(out_path).read_bytes()
        return wav_bytes[44:]
    finally:
        Path(out_path).unlink(missing_ok=True)


def record_mic(duration: int) -> bytes:
    """Record from the default mic for N seconds, return 16kHz mono PCM."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        out_path = f.name
    try:
        print(f"Recording for {duration} seconds... speak now!")
        subprocess.run(
            ["rec", "-q", "-r", "16000", "-c", "1", "-b", "16",
             out_path, "trim", "0", str(duration)],
            check=True,
        )
        print("Recording done.")
        wav_bytes = Path(out_path).read_bytes()
        return wav_bytes[44:]
    except FileNotFoundError:
        # Fallback: use macOS's built-in tool
        print(f"Recording for {duration} seconds with afrecord...")
        aiff_path = out_path.replace(".wav", ".aiff")
        subprocess.run(
            ["afrecord", "-d", str(duration), "-f", "WAVE",
             "-c", "1", "-r", "16000", out_path],
            check=True,
        )
        wav_bytes = Path(out_path).read_bytes()
        return wav_bytes[44:]
    finally:
        Path(out_path).unlink(missing_ok=True)


async def send_to_chef(pcm_bytes: bytes, recipe_text: str, ws_url: str = CHEF_WS):
    """Send audio to Chef WebSocket and print results."""
    audio_b64 = base64.b64encode(pcm_bytes).decode()
    duration_s = len(pcm_bytes) / (SAMPLE_RATE * 2)
    print(f"Sending {duration_s:.1f}s of audio ({len(pcm_bytes)} bytes)...")

    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({
            "audio": audio_b64,
            "recipe": recipe_text,
        }))

        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=30)
            msg = json.loads(raw)

            if msg["type"] == "status":
                print(f"  [{msg['state']}]")
            elif msg["type"] == "transcript":
                print(f"  You said: \"{msg['text']}\"")
            elif msg["type"] == "answer":
                print(f"  Chef says: \"{msg['text']}\"")
            elif msg["type"] == "audio":
                wav_bytes = base64.b64decode(msg["wav"])
                Path("response.wav").write_bytes(wav_bytes)
                print(f"  Audio saved to response.wav ({len(wav_bytes)} bytes)")
                # Play it
                subprocess.Popen(["afplay", "response.wav"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print("  Playing response...")
            elif msg["type"] == "error":
                print(f"  ERROR: {msg['message']}")

            if msg.get("type") == "status" and msg.get("state") == "idle":
                if msg["type"] == "status":
                    break


def main():
    parser = argparse.ArgumentParser(description="Test Chef voice pipeline")
    parser.add_argument("text", nargs="?", default="how much lemon juice",
                        help="Text to synthesize and send (default: 'how much lemon juice')")
    parser.add_argument("--wav", help="Send a pre-recorded WAV file instead")
    parser.add_argument("--record", type=int, metavar="SECONDS",
                        help="Record from mic for N seconds")
    parser.add_argument("--recipe", default="carnitas",
                        help="Recipe slug to use as context (default: carnitas)")
    parser.add_argument("--ws", default=CHEF_WS, help="WebSocket URL")
    args = parser.parse_args()

    chef_ws_url = args.ws

    recipe_text = load_recipe(args.recipe)
    print(f"Recipe: {args.recipe} ({len(recipe_text)} chars)")

    if args.wav:
        print(f"Loading WAV: {args.wav}")
        pcm = wav_file_to_pcm(args.wav)
    elif args.record:
        pcm = record_mic(args.record)
    else:
        print(f"Generating speech: \"{args.text}\"")
        pcm = text_to_pcm(args.text)

    asyncio.run(send_to_chef(pcm, recipe_text, chef_ws_url))


if __name__ == "__main__":
    main()
