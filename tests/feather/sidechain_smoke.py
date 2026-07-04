#!/usr/bin/env python3
"""SidechainDuck CLI render smoke test.

This covers the cmaj render/player flat-channel path, including a missing
sidechain input backed by silence. It does not cover JUCE disabled-bus
negotiation or CLAP missing-port processing; those wrapper paths are deferred
to pluginval/DAW checks.
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
PATCH = REPO_ROOT / "examples" / "patches" / "SidechainDuck" / "SidechainDuck.cmajorpatch"
SAMPLE_RATE = 48_000
DURATION_SECONDS = 3.0
FLAT_CHANNELS_IN = 4
MAIN_ONLY_CHANNELS_IN = 2
CHANNELS_OUT = 2
BLOCK_SIZE = 128
PULSES = (0.70, 1.30, 1.90, 2.50)
PULSE_SECONDS = 0.18
MEASURE_OFFSET_SECONDS = 0.045
MEASURE_SECONDS = 0.09
MISSING_SIDECHAIN_MAX_ABS_DIFF = 2.0e-4
MISSING_SIDECHAIN_RMS_DIFF = 2.0e-5


def find_cmaj(explicit):
    candidates = []

    if explicit:
        candidates.append(pathlib.Path(explicit))

    env = os.environ.get("CMAJ_EXE")
    if env:
        candidates.append(pathlib.Path(env))

    path_hit = shutil.which("cmaj")
    if path_hit:
        candidates.append(pathlib.Path(path_hit))

    for root in (REPO_ROOT / "build", REPO_ROOT / "build-plugin"):
        if root.exists():
            candidates.extend(root.rglob("cmaj.exe"))
            candidates.extend(p for p in root.rglob("cmaj") if p.is_file())

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate.resolve()

    raise RuntimeError("Could not find cmaj executable; pass --cmaj or set CMAJ_EXE")


def clamp16(value):
    value = max(-1.0, min(1.0, value))
    return int(round(value * 32767.0))


def write_fixture(path, channel_count, sidechain_pulses):
    total_frames = int(SAMPLE_RATE * DURATION_SECONDS)

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channel_count)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)

        frames = bytearray()

        for frame in range(total_frames):
            t = frame / SAMPLE_RATE
            main = 0.35 * math.sin(2.0 * math.pi * 220.0 * t)
            sidechain = 0.0

            if sidechain_pulses:
                for pulse_start in PULSES:
                    if pulse_start <= t < pulse_start + PULSE_SECONDS:
                        sidechain = 0.95
                        break

            if channel_count == MAIN_ONLY_CHANNELS_IN:
                frames.extend(struct.pack("<hh",
                                          clamp16(main),
                                          clamp16(main)))
            elif channel_count == FLAT_CHANNELS_IN:
                frames.extend(struct.pack("<hhhh",
                                          clamp16(main),
                                          clamp16(main),
                                          clamp16(sidechain),
                                          clamp16(sidechain)))
            else:
                raise RuntimeError(f"Unsupported fixture channel count: {channel_count}")

        wav.writeframes(frames)


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

    bytes_per_sample = bits_per_sample // 8
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
        raise RuntimeError(f"Unsupported WAV format tag={format_tag} bits={bits_per_sample} bytes={bytes_per_sample}")

    return sample_rate, data


def window_rms(data, start_seconds, length_seconds):
    start = int(start_seconds * SAMPLE_RATE)
    end = min(len(data[0]), start + int(length_seconds * SAMPLE_RATE))
    total = 0.0
    count = 0

    for channel in range(min(CHANNELS_OUT, len(data))):
        for sample in data[channel][start:end]:
            total += sample * sample
            count += 1

    if count == 0:
        raise RuntimeError("Empty RMS window")

    return math.sqrt(total / count)


def output_difference(reference, candidate):
    if len(reference) != len(candidate):
        raise RuntimeError(f"Output channel count mismatch: reference={len(reference)} candidate={len(candidate)}")

    max_abs = 0.0
    total = 0.0
    count = 0

    for ref_channel, candidate_channel in zip(reference, candidate):
        if len(ref_channel) != len(candidate_channel):
            raise RuntimeError("Output frame count mismatch")

        for ref_sample, candidate_sample in zip(ref_channel, candidate_channel):
            diff = abs(ref_sample - candidate_sample)
            max_abs = max(max_abs, diff)
            total += diff * diff
            count += 1

    if count == 0:
        raise RuntimeError("Empty output comparison")

    return max_abs, math.sqrt(total / count)


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
    parser = argparse.ArgumentParser(description="SidechainDuck CLI render smoke test")
    parser.add_argument("--cmaj", help="Path to the cmaj executable")
    parser.add_argument("--keep", action="store_true", help="Keep temporary WAV files")
    args = parser.parse_args()

    cmaj = find_cmaj(args.cmaj)

    with tempfile.TemporaryDirectory(prefix="cmaj_sidechain_smoke_", dir=REPO_ROOT / "tests" / "feather") as temp_dir:
        temp = pathlib.Path(temp_dir)
        pulsed_in = temp / "main_with_sidechain.wav"
        silent_in = temp / "main_silent_sidechain.wav"
        main_only_in = temp / "main_only_missing_sidechain.wav"
        pulsed_out = temp / "ducked.wav"
        silent_out = temp / "unducked.wav"
        main_only_out = temp / "missing_sidechain.wav"

        write_fixture(pulsed_in, FLAT_CHANNELS_IN, True)
        write_fixture(silent_in, FLAT_CHANNELS_IN, False)
        write_fixture(main_only_in, MAIN_ONLY_CHANNELS_IN, False)

        run_render(cmaj, pulsed_in, pulsed_out)
        run_render(cmaj, silent_in, silent_out)
        run_render(cmaj, main_only_in, main_only_out)

        pulsed_rate, pulsed_data = read_wav(pulsed_out)
        silent_rate, silent_data = read_wav(silent_out)
        main_only_rate, main_only_data = read_wav(main_only_out)

        if pulsed_rate != SAMPLE_RATE or silent_rate != SAMPLE_RATE or main_only_rate != SAMPLE_RATE:
            raise RuntimeError(f"Unexpected output rate: pulsed={pulsed_rate}, silent={silent_rate}, main_only={main_only_rate}")

        max_diff, rms_diff = output_difference(silent_data, main_only_data)

        print(f"Missing-sidechain diff vs silent-reference: max={max_diff:.8f}, rms={rms_diff:.8f}")

        if max_diff > MISSING_SIDECHAIN_MAX_ABS_DIFF or rms_diff > MISSING_SIDECHAIN_RMS_DIFF:
            print("FAIL: missing sidechain did not match the silent-sidechain reference", file=sys.stderr)
            return 1

        ratios = []

        for pulse_start in PULSES:
            start = pulse_start + MEASURE_OFFSET_SECONDS
            pulsed_rms = window_rms(pulsed_data, start, MEASURE_SECONDS)
            silent_rms = window_rms(silent_data, start, MEASURE_SECONDS)

            if silent_rms <= 1.0e-6:
                raise RuntimeError("Silent-sidechain reference RMS was unexpectedly near zero")

            ratios.append(pulsed_rms / silent_rms)

        average_ratio = sum(ratios) / len(ratios)
        worst_ratio = max(ratios)

        print("SidechainDuck RMS ratios ducked/reference: "
              + ", ".join(f"{ratio:.4f}" for ratio in ratios)
              + f" (avg={average_ratio:.4f}, worst={worst_ratio:.4f})")

        if average_ratio >= 0.72 or worst_ratio >= 0.82:
            print("FAIL: sidechain pulses did not produce a significant dip", file=sys.stderr)
            return 1

        if args.keep:
            keep_dir = REPO_ROOT / "tests" / "feather" / "sidechain_smoke_artifacts"
            keep_dir.mkdir(exist_ok=True)

            for path in (pulsed_in, silent_in, main_only_in, pulsed_out, silent_out, main_only_out):
                shutil.copy2(path, keep_dir / path.name)

            print(f"Kept artifacts in {keep_dir}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
