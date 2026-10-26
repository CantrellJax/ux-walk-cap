#!/usr/bin/env python3
"""Hardware smoke: capture a silent demo window while afplay supplies meeting audio.

Open only the synthetic fixture in a separate window before passing its native ID.
Requires macOS Screen Recording access, ffmpeg, ffprobe and an audible output device.
No microphone, account, upload or owner automation is used.
"""

import argparse
import array
import json
import math
import os
from pathlib import Path
import select
import subprocess
import time
import wave


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cap", required=True)
    parser.add_argument("--window", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=["studio", "instant"], default="instant")
    parser.add_argument("--audio", choices=["on", "off"], default="on")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    fixture = args.output / "remote.wav"
    rate, frequency = 48000, 997
    samples = array.array("h", (
        int(5000 * math.sin(2 * math.pi * frequency * index / rate))
        for index in range(rate * 3)
    ))
    with wave.open(str(fixture), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(samples.tobytes())
    speech = args.output / "remote.aiff"
    subprocess.run(["say", "-o", str(speech),
                    "This is the remote meeting speaker. The blue bicycle has seven wheels. "
                    "Please fix the checkout button and retry the failed request."], check=True)
    project = args.output / "recording.cap"
    env = dict(os.environ, CAP_GPUI_APP_DATA_DIR=str(args.output / "data"),
               CAP_UX_SHARING_CONFIG=str(args.output / "sharing.json"))
    command = [args.cap, "record", "--window", args.window, "--mode", args.mode,
               "--path", str(project), "--duration", "18", "--fps", "10", "--format", "json"]
    if args.audio == "on":
        command.append("--system-audio")
    with (args.output / "capture.log").open("w") as log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log, text=True, env=env)
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if select.select([process.stdout], [], [], 1)[0]:
                    line = process.stdout.readline()
                    log.write(line)
                    log.flush()
                    if not line:
                        raise AssertionError("Recorder exited before the started event")
                    if line.startswith("{") and json.loads(line).get("type") == "started":
                        break
            else:
                raise AssertionError("Recorder did not start within 45 seconds")
            time.sleep(1)
            subprocess.run(["afplay", str(fixture)], check=True, timeout=8)
            subprocess.run(["afplay", str(speech)], check=True, timeout=12)
            remaining, _ = process.communicate(timeout=40)
            log.write(remaining)
            assert process.returncode == 0, "Recording failed; inspect capture.log"
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)

    media = []
    for path in project.rglob("*"):
        if path.suffix not in (".mp4", ".m4a", ".mp3", ".wav", ".mov", ".ogg"):
            continue
        probe = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)]))
        if any(stream["codec_type"] == "audio" for stream in probe["streams"]):
            media.append(path)
    peaks = []
    for path in media:
        pcm = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path),
                                       "-map", "0:a:0", "-ac", "1", "-ar", "48000",
                                       "-f", "s16le", "-"])
        decoded = array.array("h", pcm)
        size = 4800
        basis = [complex(math.cos(2 * math.pi * frequency * i / rate),
                         math.sin(2 * math.pi * frequency * i / rate)) for i in range(size)]
        peak = max((abs(sum(value * basis[i] for i, value in enumerate(decoded[start:start + size])))
                    * 2 / size / 32768
                    for start in range(0, len(decoded) - size, size)), default=0)
        peaks.append(peak)
    peak = max(peaks, default=0)
    receipt = {"mode": args.mode, "systemAudio": args.audio, "microphone": False,
               "window": args.window, "toneHz": frequency, "toneAmplitude": peak,
               "audioFiles": [str(path.relative_to(project)) for path in media]}
    (args.output / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    if args.audio == "on":
        assert peak > 0.01, "Missing meeting audio from a process outside the selected video window"
    else:
        assert peak < 0.001, "System Audio off still captured the remote fixture"


if __name__ == "__main__":
    run()
