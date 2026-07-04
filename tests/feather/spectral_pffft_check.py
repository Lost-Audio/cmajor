#!/usr/bin/env python3
"""Render-level PFFFT native FFT check using the SpectralGate patch."""

import argparse
import math
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import wave


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
PATCH_DIR = REPO_ROOT / "examples" / "patches" / "SpectralGate"
PATCH = PATCH_DIR / "SpectralGate.cmajorpatch"
PATCH_SOURCE = PATCH_DIR / "SpectralGate.cmajor"
SAMPLE_RATE = 48_000
DURATION_SECONDS = 3.0
CHANNELS = 2
BLOCK_SIZE = 256
FFT_SIZE = 1024
EQUIVALENCE_MAX_DIFF = 1.0e-4
BYPASS_MAX_DIFF = 1.0e-4
BYPASS_RMS_DIFF = 2.0e-5
EFFECT_MIN_RMS_DIFF = 1.0e-3
NONZERO_EPSILON = 1.0e-7


def run(cmd, cwd=REPO_ROOT):
    subprocess.run([str(part) for part in cmd], cwd=cwd, check=True)


def command_output(cmd, cwd=REPO_ROOT):
    return subprocess.check_output([str(part) for part in cmd], cwd=cwd, text=True, stderr=subprocess.STDOUT)


def build_root_for_executable(path):
    path = pathlib.Path(path).resolve()
    for parent in path.parents:
        if (parent / "CMakeCache.txt").exists():
            return parent
    return None


def cache_has_native_overrides(build_root, expected):
    cache = build_root / "CMakeCache.txt"
    if not cache.exists():
        return False

    wanted = "ON" if expected else "OFF"
    return f"CMAJ_ENABLE_NATIVE_OVERRIDES:BOOL={wanted}" in cache.read_text(errors="ignore")


def find_existing_cmaj(explicit, expect_native_overrides):
    candidates = []

    if explicit:
        candidates.append(pathlib.Path(explicit))

    env_name = "CMAJ_EXE" if expect_native_overrides else "CMAJ_NATIVE_OFF_EXE"
    if os.environ.get(env_name):
        candidates.append(pathlib.Path(os.environ[env_name]))

    if expect_native_overrides:
        candidates.extend([
            REPO_ROOT / "build" / "tools" / "command" / "Release" / "cmaj.exe",
            REPO_ROOT / "build-ts" / "tools" / "command" / "RelWithDebInfo" / "cmaj.exe",
            REPO_ROOT / "build-plugin" / "tools" / "command" / "Release" / "cmaj.exe",
        ])
    else:
        candidates.extend([
            REPO_ROOT / "build-native-off" / "tools" / "command" / "Release" / "cmaj.exe",
            REPO_ROOT / "build-native-off" / "tools" / "command" / "RelWithDebInfo" / "cmaj.exe",
        ])

    path_hit = shutil.which("cmaj")
    if expect_native_overrides and path_hit:
        candidates.append(pathlib.Path(path_hit))

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            build_root = build_root_for_executable(candidate)
            if build_root is None or cache_has_native_overrides(build_root, expect_native_overrides):
                return candidate.resolve()

    return None


def source_stamp_inputs():
    return [
        REPO_ROOT / "modules" / "CMakeLists.txt",
        REPO_ROOT / "modules" / "compiler" / "src" / "backends" / "cmaj_NativeFFT.cpp",
        REPO_ROOT / "modules" / "compiler" / "src" / "backends" / "cmaj_NativeFFT.h",
        REPO_ROOT / "modules" / "compiler" / "src" / "backends" / "cmaj_NativeOverrides.h",
        REPO_ROOT / "standard_library" / "std_library_frequency.cmajor",
    ]


def executable_is_stale(exe):
    if not exe or not pathlib.Path(exe).exists():
        return True

    exe_mtime = pathlib.Path(exe).stat().st_mtime
    return any(path.exists() and path.stat().st_mtime > exe_mtime for path in source_stamp_inputs())


def ensure_native_off_cmaj(explicit):
    cmaj = find_existing_cmaj(explicit, False)
    build_dir = REPO_ROOT / "build-native-off"

    if cmaj and not executable_is_stale(cmaj):
        return cmaj

    configure_needed = not cache_has_native_overrides(build_dir, False)

    if configure_needed:
        run([
            "cmake",
            "-Bbuild-native-off",
            "-G",
            "Visual Studio 17 2022",
            "-DCMAJ_ENABLE_NATIVE_OVERRIDES=OFF",
        ])

    run(["cmake", "--build", "build-native-off", "--config", "Release", "--parallel"])

    cmaj = find_existing_cmaj(explicit, False)
    if not cmaj:
        raise RuntimeError("Could not find overrides-OFF cmaj executable after build")

    return cmaj


def ensure_native_on_cmaj(explicit):
    cmaj = find_existing_cmaj(explicit, True)
    if cmaj:
        return cmaj

    raise RuntimeError("Could not find native-overrides-ON cmaj executable; pass --cmaj-on or set CMAJ_EXE")


def clamp16(value):
    value = max(-1.0, min(1.0, value))
    return int(round(value * 32767.0))


def burst_envelope(t):
    bursts = ((0.22, 0.18), (0.95, 0.24), (1.65, 0.20), (2.35, 0.28))
    envelope = 0.20

    for start, length in bursts:
        if start <= t < start + length:
            phase = (t - start) / length
            envelope += 0.80 * math.sin(math.pi * phase)

    return min(1.0, envelope)


def deterministic_noise(frame, channel):
    n = (frame * 1103515245 + channel * 12345 + 0x4567) & 0x7FFFFFFF
    n = (n ^ (n >> 13) ^ (n << 7)) & 0x7FFFFFFF
    return (n / 0x3FFFFFFF) - 1.0


def write_fixture(path):
    total_frames = int(SAMPLE_RATE * DURATION_SECONDS)

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)

        frames = bytearray()

        for frame in range(total_frames):
            t = frame / SAMPLE_RATE
            env = burst_envelope(t)
            left = (
                0.28 * math.sin(2.0 * math.pi * 147.0 * t)
                + 0.18 * math.sin(2.0 * math.pi * 880.0 * t)
                + 0.10 * math.sin(2.0 * math.pi * 3120.0 * t)
                + 0.11 * env * deterministic_noise(frame, 0)
            )
            right = (
                0.24 * math.sin(2.0 * math.pi * 221.0 * t)
                + 0.16 * math.sin(2.0 * math.pi * 1320.0 * t)
                + 0.08 * math.sin(2.0 * math.pi * 5150.0 * t)
                + 0.11 * env * deterministic_noise(frame, 1)
            )

            frames.extend(struct.pack("<hh", clamp16(left), clamp16(right)))

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


def output_difference(reference, candidate, start_frame=0):
    if len(reference) != len(candidate):
        raise RuntimeError(f"Channel count mismatch: {len(reference)} vs {len(candidate)}")

    max_abs = 0.0
    total = 0.0
    count = 0

    for ref_channel, candidate_channel in zip(reference, candidate):
        if len(ref_channel) != len(candidate_channel):
            raise RuntimeError("Frame count mismatch")

        for ref_sample, candidate_sample in zip(ref_channel[start_frame:], candidate_channel[start_frame:]):
            diff = abs(ref_sample - candidate_sample)
            max_abs = max(max_abs, diff)
            total += diff * diff
            count += 1

    if count == 0:
        raise RuntimeError("Empty output comparison")

    return max_abs, math.sqrt(total / count)


def first_nonzero_frame(data):
    if not data:
        raise RuntimeError("No audio channels")

    frames = len(data[0])

    for frame in range(frames):
        for channel in data:
            if abs(channel[frame]) > NONZERO_EPSILON:
                return frame

    raise RuntimeError("Audio was silent")


def copy_patch_variant(target_dir, *, threshold_db=-48.0, smear_percent=35.0, tilt_db_oct=0.0, mix_percent=100.0):
    target_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(PATCH, target_dir / PATCH.name)

    source = PATCH_SOURCE.read_text()
    source = re.sub(r'input event float threshold \[\[ name: "Threshold", min: -96, max: 0, init: [-0-9.]+',
                    f'input event float threshold [[ name: "Threshold", min: -96, max: 0, init: {threshold_db:g}',
                    source)
    source = re.sub(r'input event float smear\s+\[\[ name: "Smear",\s+min: 0,\s+max: 100, init: [-0-9.]+',
                    f'input event float smear     [[ name: "Smear",     min: 0,   max: 100, init: {smear_percent:g}',
                    source)
    source = re.sub(r'input event float tilt\s+\[\[ name: "Tilt",\s+min: -12, max: 12, init: [-0-9.]+',
                    f'input event float tilt      [[ name: "Tilt",      min: -12, max: 12, init: {tilt_db_oct:g}',
                    source)
    source = re.sub(r'input event float mix\s+\[\[ name: "Mix",\s+min: 0,\s+max: 100, init: [-0-9.]+',
                    f'input event float mix       [[ name: "Mix",       min: 0,   max: 100, init: {mix_percent:g}',
                    source)
    source = re.sub(r'float thresholdGain = [-0-9.]+f;',
                    f'float thresholdGain = {10.0 ** (threshold_db * 0.05):.10f}f;',
                    source)
    source = re.sub(r'float smearAmount = [-0-9.]+f;',
                    f'float smearAmount = {smear_percent * 0.01:.10f}f;',
                    source)
    source = re.sub(r'float tiltDbPerOctave = [-0-9.]+f;',
                    f'float tiltDbPerOctave = {tilt_db_oct:.10f}f;',
                    source)
    source = re.sub(r'float mixAmount = [-0-9.]+f;',
                    f'float mixAmount = {mix_percent * 0.01:.10f}f;',
                    source)

    (target_dir / PATCH_SOURCE.name).write_text(source)
    return target_dir / PATCH.name


def render(cmaj, patch, input_wav, output_wav):
    cmd = [
        cmaj,
        "render",
        f"--input={input_wav}",
        f"--output={output_wav}",
        f"--channels={CHANNELS}",
        f"--blockSize={BLOCK_SIZE}",
        patch,
    ]
    start = time.perf_counter()
    run(cmd)
    return time.perf_counter() - start


def dry_run(cmaj, patch):
    run([cmaj, "play", "--dry-run", "--no-gui", patch])


def main():
    parser = argparse.ArgumentParser(description="SpectralGate native PFFFT render check")
    parser.add_argument("--cmaj-on", help="Path to native-overrides-ON cmaj executable")
    parser.add_argument("--cmaj-off", help="Path to native-overrides-OFF cmaj executable")
    parser.add_argument("--keep", action="store_true", help="Keep temporary WAV files")
    args = parser.parse_args()

    cmaj_on = ensure_native_on_cmaj(args.cmaj_on)
    cmaj_off = ensure_native_off_cmaj(args.cmaj_off)

    print(f"native ON cmaj:  {cmaj_on}")
    print(f"native OFF cmaj: {cmaj_off}")
    print(command_output([cmaj_on, "version"]).strip().splitlines()[0])
    print(command_output([cmaj_off, "version"]).strip().splitlines()[0])

    with tempfile.TemporaryDirectory(prefix="cmaj_spectral_pffft_") as temp_dir:
        temp = pathlib.Path(temp_dir)
        default_patch = copy_patch_variant(temp / "default")
        gated_patch = copy_patch_variant(temp / "gated", threshold_db=-12.0, smear_percent=0.0, tilt_db_oct=0.0, mix_percent=100.0)
        bypass_patch = copy_patch_variant(temp / "bypass", threshold_db=-12.0, smear_percent=0.0, tilt_db_oct=0.0, mix_percent=0.0)

        input_wav = temp / "spectral_fixture.wav"
        native_out = temp / "spectral_native_on.wav"
        fallback_out = temp / "spectral_native_off.wav"
        gated_out = temp / "spectral_gated.wav"
        bypass_out = temp / "spectral_bypass.wav"
        write_fixture(input_wav)

        dry_run(cmaj_on, default_patch)

        native_seconds = render(cmaj_on, default_patch, input_wav, native_out)
        fallback_seconds = render(cmaj_off, default_patch, input_wav, fallback_out)
        gated_seconds = render(cmaj_on, gated_patch, input_wav, gated_out)
        bypass_seconds = render(cmaj_on, bypass_patch, input_wav, bypass_out)

        native_rate, native_data = read_wav(native_out)
        fallback_rate, fallback_data = read_wav(fallback_out)
        input_rate, input_data = read_wav(input_wav)
        gated_rate, gated_data = read_wav(gated_out)
        bypass_rate, bypass_data = read_wav(bypass_out)

        rates = {native_rate, fallback_rate, input_rate, gated_rate, bypass_rate}
        if rates != {SAMPLE_RATE}:
            raise RuntimeError(f"Unexpected sample rates: {sorted(rates)}")

        max_diff, rms_diff = output_difference(native_data, fallback_data)
        startup_skip = first_nonzero_frame(bypass_data)
        bypass_max, bypass_rms = output_difference(input_data, bypass_data, startup_skip)
        effect_max, effect_rms = output_difference(gated_data, bypass_data, startup_skip)
        speedup = fallback_seconds / native_seconds if native_seconds > 0.0 else float("inf")

        print(f"SpectralGate native/fallback diff: max={max_diff:.8f}, rms={rms_diff:.8f}")
        print(f"SpectralGate render startup skip for dry comparisons: {startup_skip} frames")
        print(f"SpectralGate bypass diff vs input after startup: max={bypass_max:.8f}, rms={bypass_rms:.8f}")
        print(f"SpectralGate gated diff vs bypass after startup: max={effect_max:.8f}, rms={effect_rms:.8f}")
        print(f"SpectralGate render times: native={native_seconds:.3f}s, fallback={fallback_seconds:.3f}s, speedup={speedup:.2f}x")
        print(f"Additional render times: gated={gated_seconds:.3f}s, bypass={bypass_seconds:.3f}s")

        failed = False

        if max_diff > EQUIVALENCE_MAX_DIFF:
            print("FAIL: native and fallback renders differ beyond tolerance", file=sys.stderr)
            failed = True

        if bypass_max > BYPASS_MAX_DIFF or bypass_rms > BYPASS_RMS_DIFF:
            print("FAIL: mix=0 bypass did not match input within tolerance", file=sys.stderr)
            failed = True

        if effect_rms < EFFECT_MIN_RMS_DIFF:
            print("FAIL: high-threshold gate did not materially change the signal", file=sys.stderr)
            failed = True

        if args.keep:
            keep_dir = REPO_ROOT / "tests" / "feather" / "spectral_pffft_artifacts"
            keep_dir.mkdir(exist_ok=True)
            for path in (input_wav, native_out, fallback_out, gated_out, bypass_out):
                shutil.copy2(path, keep_dir / path.name)
            print(f"Kept artifacts in {keep_dir}")

        if failed:
            return 1

    print(f"PASS: SpectralGate PFFFT native path matched fallback; speedup={speedup:.2f}x, latency={FFT_SIZE} samples")
    return 0


if __name__ == "__main__":
    sys.exit(main())
