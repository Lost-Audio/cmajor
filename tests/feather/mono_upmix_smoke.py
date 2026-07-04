#!/usr/bin/env python3
"""Mono-output upmix CLI render smoke test.

Renders a mono-output patch (HelloWorld: `output stream float out`, self-playing,
no MIDI fixture required) to a stereo output via `cmaj render --channels=2` and
asserts both output channels are bit-identical and non-silent.

This guards the mono -> multi-channel adaptation convention that upstream
implemented in cmaj::Patch::connectPerformerEndpoints() ("Handle mono -> stereo
as a special case") and that the Feather bus-layout wrappers replicate in
cmaj_JUCEPlugin.h / cmaj_CLAPPlugin.h. Like sidechain_smoke.py, this covers the
cmaj render/player flat-channel path only; the JUCE dynamic-loader path (the
original Bitwig hard-left report with SineSynth) still needs pluginval/DAW
verification because there is no CLI harness for the plugin wrappers.

SineSynth itself is not used here because it needs MIDI note input to make
sound; HelloWorld exercises the identical mono-output mapping path.
"""

import argparse
import math
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
import wave


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
PATCH = REPO_ROOT / "examples" / "patches" / "HelloWorld" / "HelloWorld.cmajorpatch"
SAMPLE_RATE = 48_000
DURATION_SECONDS = 3.0
CHANNELS_OUT = 2
BLOCK_SIZE = 128
MIN_OUTPUT_RMS = 0.005
MAX_CHANNEL_DIFF = 0.0


def find_cmaj(explicit):
    candidates = []

    if explicit:
        candidates.append(pathlib.Path(explicit))

    env = os.environ.get("CMAJ_EXE")
    if env:
        candidates.append(pathlib.Path(env))

    for root in (REPO_ROOT / "build", REPO_ROOT / "build-plugin"):
        if root.exists():
            candidates.extend(root.rglob("cmaj.exe"))
            candidates.extend(p for p in root.rglob("cmaj") if p.is_file())

    path_hit = shutil.which("cmaj")
    if path_hit:
        candidates.append(pathlib.Path(path_hit))

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate.resolve()

    raise RuntimeError("Could not find cmaj executable; pass --cmaj or set CMAJ_EXE")


def write_silent_fixture(path, channel_count):
    """A silent input WAV just pins the render length and sample rate."""
    total_frames = int(SAMPLE_RATE * DURATION_SECONDS)

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channel_count)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(b"\x00" * (total_frames * channel_count * 2))


def read_wav(path):
    content = pathlib.Path(path).read_bytes()

    if content[:4] != b"RIFF" or content[8:12] != b"WAVE":
        raise RuntimeError(f"Not a WAV file: {path}")

    fmt = None
    data_chunk = None
    pos = 12

    while pos + 8 <= len(content):
        chunk_id = content[pos:pos + 4]
        chunk_size = struct.unpack_from("<I", content, pos + 4)[0]
        chunk_start = pos + 8
        chunk_end = chunk_start + chunk_size

        if chunk_id == b"fmt ":
            fmt = content[chunk_start:chunk_end]
        elif chunk_id == b"data":
            data_chunk = content[chunk_start:chunk_end]

        pos = chunk_end + (chunk_size & 1)

    if fmt is None or data_chunk is None:
        raise RuntimeError(f"Missing fmt/data chunk in {path}")

    format_tag, channels, sample_rate, _, block_align, bits_per_sample = struct.unpack_from("<HHIIHH", fmt, 0)

    if format_tag == 0xFFFE and len(fmt) >= 40:
        subtype = fmt[24:40]
        format_tag = struct.unpack_from("<I", subtype, 0)[0]

    frames = len(data_chunk) // block_align
    data = [[0.0] * frames for _ in range(channels)]

    if format_tag == 1 and bits_per_sample == 16:
        samples = struct.unpack("<" + "h" * (len(data_chunk) // 2), data_chunk)

        for frame in range(frames):
            for channel in range(channels):
                data[channel][frame] = samples[frame * channels + channel] / 32768.0
    elif format_tag == 3 and bits_per_sample == 32:
        samples = struct.unpack("<" + "f" * (len(data_chunk) // 4), data_chunk)

        for frame in range(frames):
            for channel in range(channels):
                data[channel][frame] = samples[frame * channels + channel]
    else:
        raise RuntimeError(f"Unsupported WAV format tag={format_tag} bits={bits_per_sample}")

    return sample_rate, data


def channel_rms(channel):
    if not channel:
        raise RuntimeError("Empty channel")

    return math.sqrt(sum(sample * sample for sample in channel) / len(channel))


def run_render(cmaj, input_wav, output_wav):
    cmd = [
        str(cmaj),
        "render",
        f"--input={input_wav}",
        f"--output={output_wav}",
        f"--channels={CHANNELS_OUT}",
        f"--blockSize={BLOCK_SIZE}",
        str(PATCH),
    ]

    subprocess.run(cmd, cwd=REPO_ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description="Mono-output upmix CLI render smoke test")
    parser.add_argument("--cmaj", help="Path to the cmaj executable")
    parser.add_argument("--keep", action="store_true", help="Keep temporary WAV files")
    args = parser.parse_args()

    cmaj = find_cmaj(args.cmaj)

    with tempfile.TemporaryDirectory(prefix="cmaj_mono_upmix_smoke_") as temp_dir:
        temp = pathlib.Path(temp_dir)
        silent_in = temp / "silent_stereo_in.wav"
        rendered_out = temp / "mono_patch_stereo_out.wav"

        write_silent_fixture(silent_in, CHANNELS_OUT)
        run_render(cmaj, silent_in, rendered_out)

        rate, data = read_wav(rendered_out)

        if rate != SAMPLE_RATE:
            raise RuntimeError(f"Unexpected output rate: {rate}")

        if len(data) != CHANNELS_OUT:
            raise RuntimeError(f"Expected {CHANNELS_OUT} output channels, got {len(data)}")

        left, right = data[0], data[1]

        left_rms = channel_rms(left)
        right_rms = channel_rms(right)
        max_diff = max(abs(l - r) for l, r in zip(left, right))

        print(f"Mono upmix render: left RMS={left_rms:.6f}, right RMS={right_rms:.6f}, "
              f"max |L-R|={max_diff:.9f}")

        failed = False

        if left_rms < MIN_OUTPUT_RMS or right_rms < MIN_OUTPUT_RMS:
            print("FAIL: mono-output patch rendered near-silence; expected the HelloWorld "
                  "melody on both channels", file=sys.stderr)
            failed = True

        if max_diff > MAX_CHANNEL_DIFF:
            print("FAIL: left and right channels differ; mono output was not replicated "
                  "to all output channels", file=sys.stderr)
            failed = True

        if args.keep:
            keep_dir = REPO_ROOT / "tests" / "feather" / "mono_upmix_smoke_artifacts"
            keep_dir.mkdir(exist_ok=True)

            for path in (silent_in, rendered_out):
                shutil.copy2(path, keep_dir / path.name)

            print(f"Kept artifacts in {keep_dir}")

        if failed:
            return 1

    print("PASS: mono output replicated bit-identically to both stereo channels")
    return 0


if __name__ == "__main__":
    sys.exit(main())
