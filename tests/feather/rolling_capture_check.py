#!/usr/bin/env python3
"""Dynamic-loader rolling capture functional check.

Builds a tiny JUCE/Cmajor probe that instantiates JITLoaderPlugin, loads the
self-playing HelloWorld patch, processes exactly one second of audio, calls the
same save method used by the native "Save last 30s" button, and prints the saved
WAV path. This script then validates that the WAV is 32-bit float, stereo,
non-silent, and exactly the filled one-second capture length.
"""

import argparse
import math
import os
import pathlib
import shutil
import struct
import subprocess
import sys


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_BUILD_ROOT = REPO_ROOT / ".feather" / "tmp" / "rolling_capture_probe"
DEFAULT_JUCE_PATH = pathlib.Path(os.environ.get("JUCE_PATH", "F:/Programming/JUCE"))
SAMPLE_RATE = 48_000
BLOCK_SIZE = 128
EXPECTED_FRAMES = SAMPLE_RATE
EXPECTED_CHANNELS = 2
MIN_RMS = 0.005


def run(cmd, cwd=None):
    print("+ " + " ".join(str(c) for c in cmd))
    subprocess.run(cmd, cwd=cwd or REPO_ROOT, check=True)


def cmake_quote(path):
    return pathlib.Path(path).resolve().as_posix()


def write_probe_files(source_dir, juce_path):
    source_dir.mkdir(parents=True, exist_ok=True)

    (source_dir / "CMakeLists.txt").write_text(
        f"""cmake_minimum_required(VERSION 3.16..3.22)

project(rolling_capture_probe LANGUAGES CXX C)

set(CMAJ_REPO "{cmake_quote(REPO_ROOT)}" CACHE PATH "Cmajor repo")
set(JUCE_PATH "{cmake_quote(juce_path)}" CACHE PATH "JUCE checkout")
set(CMAJ_VERSION "1.0.3159" CACHE STRING "Cmajor version")

include("${{CMAJ_REPO}}/tools/scripts/cmake_warning_flags")

if(NOT CMAJ_TARGET_COMPILER)
    set(CMAJ_TARGET_COMPILER
        $<$<OR:$<CXX_COMPILER_ID:Clang>,$<CXX_COMPILER_ID:AppleClang>>:cxx_std_17>
        $<$<CXX_COMPILER_ID:GNU>:cxx_std_17>
        $<$<CXX_COMPILER_ID:MSVC>:cxx_std_17>)
endif()

add_subdirectory("${{JUCE_PATH}}" juce)
add_subdirectory("${{CMAJ_REPO}}/modules" cmajor_modules)

MAKE_CMAJ_LIBRARY (
    LIBRARY_NAME rolling_capture_cmajor_lib
    INCLUDE_PLAYBACK
    ENABLE_PERFORMER_LLVM
)

add_executable(rolling_capture_probe rolling_capture_probe.cpp)
target_compile_features(rolling_capture_probe PRIVATE ${{CMAJ_TARGET_COMPILER}})
target_compile_options(rolling_capture_probe PRIVATE ${{CMAJ_WARNING_FLAGS}})
target_compile_definitions(rolling_capture_probe PRIVATE
    JUCE_DISABLE_JUCE_VERSION_PRINTING=1
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_USE_CURL=0
    CMAJ_ENABLE_WEBVIEW_DEV_TOOLS=1)
target_link_libraries(rolling_capture_probe PRIVATE rolling_capture_cmajor_lib juce::juce_audio_utils)
""",
        encoding="utf-8",
    )

    patch_path = REPO_ROOT / "examples" / "patches" / "HelloWorld" / "HelloWorld.cmajorpatch"

    (source_dir / "rolling_capture_probe.cpp").write_text(
        f"""#include <cassert>
#include <cmath>
#include <iostream>
#include <memory>
#include <stdexcept>

#include <juce_audio_utils/juce_audio_utils.h>

#define CHOC_ASSERT(x) assert(x)
#include "cmajor/helpers/cmaj_JUCEPlugin.h"
#include "choc/javascript/choc_javascript_QuickJS.h"

namespace
{{
constexpr double probeSampleRate = {SAMPLE_RATE}.0;
constexpr int probeBlockSize = {BLOCK_SIZE};
constexpr int probeTotalFrames = {EXPECTED_FRAMES};
constexpr const char* patchPath = "{cmake_quote(patch_path)}";

class ProbeLoader final : public cmaj::plugin::JITLoaderPlugin
{{
public:
    explicit ProbeLoader (std::shared_ptr<cmaj::Patch> p)
        : cmaj::plugin::JITLoaderPlugin (std::move (p))
    {{
    }}

    bool loadSync (cmaj::PatchManifest manifest)
    {{
        cmaj::Patch::LoadParams params;
        params.manifest = std::move (manifest);
        const auto loaded = patch->loadPatch (params, true);
        handlePatchChange();
        return loaded;
    }}
}};

std::unique_ptr<ProbeLoader> createLoader()
{{
    auto patch = std::make_shared<cmaj::Patch>();
    patch->setAutoRebuildOnFileChange (false);
    patch->createEngine = +[] {{ return cmaj::Engine::create(); }};

    auto loader = std::make_unique<ProbeLoader> (std::move (patch));
    loader->setPlayConfigDetails ({EXPECTED_CHANNELS}, {EXPECTED_CHANNELS}, probeSampleRate, probeBlockSize);
    loader->prepareToPlay (probeSampleRate, probeBlockSize);
    return loader;
}}
}} // namespace

int main()
{{
    try
    {{
        juce::ScopedJuceInitialiser_GUI juce;
        auto loader = createLoader();

        cmaj::PatchManifest manifest;
        manifest.initialiseWithFile (patchPath);

        if (! loader->loadSync (std::move (manifest)))
            throw std::runtime_error ("HelloWorld load failed");

        if (! loader->patch->isPlayable())
            throw std::runtime_error ("HelloWorld is not playable");

        loader->suspendProcessing (false);
        std::cout << "SUSPENDED=" << loader->isSuspended() << "\\n";

        double sumSquares = 0.0;
        int sampleCount = 0;

        for (int frame = 0; frame < probeTotalFrames; frame += probeBlockSize)
        {{
            juce::AudioBuffer<float> audio ({EXPECTED_CHANNELS}, probeBlockSize);
            juce::MidiBuffer midi;
            audio.clear();
            loader->processBlock (audio, midi);

            for (int channel = 0; channel < audio.getNumChannels(); ++channel)
                for (int sample = 0; sample < audio.getNumSamples(); ++sample)
                {{
                    const auto value = static_cast<double> (audio.getSample (channel, sample));
                    sumSquares += value * value;
                    ++sampleCount;
                }}
        }}

        const auto processRMS = sampleCount > 0 ? std::sqrt (sumSquares / static_cast<double> (sampleCount)) : 0.0;
        std::cout << "PROCESS_RMS=" << processRMS << "\\n";

        auto result = loader->saveLastOutputCapture();

        if (! result.ok)
            throw std::runtime_error (result.message.toStdString());

        std::cout << "CAPTURE_PATH=" << result.file.getFullPathName() << "\\n";
        std::cout << "CAPTURE_FRAMES=" << result.numFrames << "\\n";
        std::cout << "CAPTURE_CHANNELS=" << result.numChannels << "\\n";
        std::cout << "CAPTURE_RATE=" << result.sampleRate << "\\n";
        std::cout << "RESULT PASS\\n";
        return 0;
    }}
    catch (const std::exception& e)
    {{
        std::cerr << "RESULT FAIL: " << e.what() << "\\n";
        return 1;
    }}
}}
""",
        encoding="utf-8",
    )


def build_probe(build_root, juce_path):
    source_dir = build_root / "src"
    build_dir = build_root / "build"
    write_probe_files(source_dir, juce_path)
    run(["cmake", "-S", source_dir, "-B", build_dir])
    run(["cmake", "--build", build_dir, "--config", "Release", "--parallel"])
    return build_dir / "Release" / "rolling_capture_probe.exe"


def run_probe(probe):
    user_profile = REPO_ROOT / ".feather" / "tmp" / "rolling_capture_userprofile"
    user_profile.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["USERPROFILE"] = str(user_profile)

    completed = subprocess.run(
        [str(probe)],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    print(completed.stdout, end="")

    if completed.returncode != 0:
        raise RuntimeError(f"Probe failed with exit code {completed.returncode}")

    for line in completed.stdout.splitlines():
        if line.startswith("CAPTURE_PATH="):
            return pathlib.Path(line.split("=", 1)[1])

    raise RuntimeError("Probe did not print CAPTURE_PATH")


def read_wav(path):
    content = path.read_bytes()

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

    if format_tag != 3 or bits_per_sample != 32:
        raise RuntimeError(f"Expected float32 WAV, got format={format_tag} bits={bits_per_sample}")

    samples = struct.unpack("<" + "f" * (len(data_chunk) // 4), data_chunk)
    data = [[0.0] * frames for _ in range(channels)]

    for frame in range(frames):
        for channel in range(channels):
            data[channel][frame] = samples[frame * channels + channel]

    return sample_rate, data


def channel_rms(data):
    total = 0.0
    count = 0

    for channel in data:
        for sample in channel:
            total += sample * sample
            count += 1

    if count == 0:
        raise RuntimeError("Empty WAV data")

    return math.sqrt(total / count)


def validate_capture(path):
    if not path.exists():
        raise RuntimeError(f"Capture file was not written: {path}")

    rate, data = read_wav(path)
    frames = len(data[0]) if data else 0
    rms = channel_rms(data)

    print(f"Capture WAV: path={path}")
    print(f"Capture WAV: rate={rate}, channels={len(data)}, frames={frames}, rms={rms:.6f}")

    if rate != SAMPLE_RATE:
        raise RuntimeError(f"Unexpected sample rate: {rate}")

    if len(data) != EXPECTED_CHANNELS:
        raise RuntimeError(f"Expected {EXPECTED_CHANNELS} channels, got {len(data)}")

    if frames != EXPECTED_FRAMES:
        raise RuntimeError(f"Expected {EXPECTED_FRAMES} frames, got {frames}")

    if rms < MIN_RMS:
        raise RuntimeError(f"Capture was near-silent: rms={rms:.6f}")


def main():
    parser = argparse.ArgumentParser(description="Functional check for the dynamic-loader rolling recorder")
    parser.add_argument("--build-root", type=pathlib.Path, default=DEFAULT_BUILD_ROOT)
    parser.add_argument("--juce-path", type=pathlib.Path, default=DEFAULT_JUCE_PATH)
    parser.add_argument("--probe", type=pathlib.Path, help="Existing rolling_capture_probe.exe to run")
    parser.add_argument("--keep-capture", action="store_true", help="Leave the generated WAV in Documents/LostAudio/Captures")
    args = parser.parse_args()

    if args.probe:
        probe = args.probe
    else:
        if not args.juce_path.exists():
            raise RuntimeError(f"JUCE path not found: {args.juce_path}")

        probe = build_probe(args.build_root, args.juce_path)

    if not probe.exists():
        raise RuntimeError(f"Probe executable not found: {probe}")

    capture = run_probe(probe)
    validate_capture(capture)

    if not args.keep_capture:
        capture.unlink(missing_ok=True)
        print(f"Removed test capture: {capture}")

    print("PASS: rolling capture saved a valid non-silent float32 WAV with the expected filled length")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
