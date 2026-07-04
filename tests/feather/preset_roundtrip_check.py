#!/usr/bin/env python3
"""Lost Audio preset save/load round-trip check.

Builds a small JUCE/Cmajor probe that instantiates the dynamic JIT loader,
loads Tremolo, applies a distinctive full-state value via Patch::handleClientMessage,
saves it through the new native preset command, then loads it into a fresh
loader instance and verifies Patch::getFullStoredState() reports the same data.
"""

import argparse
import os
import pathlib
import shutil
import subprocess
import sys


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_BUILD_ROOT = REPO_ROOT / ".feather" / "tmp" / "preset_roundtrip_probe"
DEFAULT_JUCE_PATH = pathlib.Path(os.environ.get("JUCE_PATH", "F:/Programming/JUCE"))
PRESET_NAME = "Feather Roundtrip Probe"


def run(cmd, cwd=None):
    print("+ " + " ".join(str(c) for c in cmd))
    subprocess.run(cmd, cwd=cwd or REPO_ROOT, check=True)


def cmake_quote(path):
    return pathlib.Path(path).resolve().as_posix()


def write_probe_files(source_dir, juce_path):
    source_dir.mkdir(parents=True, exist_ok=True)

    (source_dir / "CMakeLists.txt").write_text(
        f"""cmake_minimum_required(VERSION 3.16..3.22)

project(preset_roundtrip_probe LANGUAGES CXX C)

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
    LIBRARY_NAME preset_roundtrip_cmajor_lib
    INCLUDE_PLAYBACK
    ENABLE_PERFORMER_LLVM
)

add_executable(preset_roundtrip_probe preset_roundtrip_probe.cpp)
target_compile_features(preset_roundtrip_probe PRIVATE ${{CMAJ_TARGET_COMPILER}})
target_compile_options(preset_roundtrip_probe PRIVATE ${{CMAJ_WARNING_FLAGS}})
target_compile_definitions(preset_roundtrip_probe PRIVATE
    JUCE_DISABLE_JUCE_VERSION_PRINTING=1
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_USE_CURL=0
    CMAJ_ENABLE_WEBVIEW_DEV_TOOLS=1)
target_link_libraries(preset_roundtrip_probe PRIVATE preset_roundtrip_cmajor_lib juce::juce_audio_utils)
""",
        encoding="utf-8",
    )

    patch_path = REPO_ROOT / "examples" / "patches" / "Tremolo" / "Tremolo.cmajorpatch"

    (source_dir / "preset_roundtrip_probe.cpp").write_text(
        f"""#include <cassert>
#include <cmath>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include <juce_audio_utils/juce_audio_utils.h>

#define CHOC_ASSERT(x) assert(x)
#include "cmajor/helpers/cmaj_JUCEPlugin.h"
#include "choc/javascript/choc_javascript_QuickJS.h"

namespace
{{
constexpr double probeSampleRate = 48000.0;
constexpr int probeBlockSize = 128;
constexpr const char* patchPath = "{cmake_quote(patch_path)}";
constexpr const char* probePresetName = "{PRESET_NAME}";
constexpr const char* probeStateKey = "featherPresetProbe";
constexpr const char* probeStateValue = "roundtrip-ok";

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

class CapturingView final : public cmaj::PatchView
{{
public:
    explicit CapturingView (cmaj::Patch& p)
        : cmaj::PatchView (p)
    {{
    }}

    void sendMessage (const choc::value::ValueView& message) override
    {{
        messages[message["type"].toString()] = choc::value::Value (message["message"]);
    }}

    choc::value::Value getReply (const std::string& replyType) const
    {{
        if (auto found = messages.find (replyType); found != messages.end())
            return found->second;

        return {{}};
    }}

    void clear()
    {{
        messages.clear();
    }}

private:
    std::unordered_map<std::string, choc::value::Value> messages;
}};

std::unique_ptr<ProbeLoader> createLoader()
{{
    auto patch = std::make_shared<cmaj::Patch>();
    patch->setAutoRebuildOnFileChange (false);
    patch->createEngine = +[] {{ return cmaj::Engine::create(); }};

    auto loader = std::make_unique<ProbeLoader> (std::move (patch));
    loader->setPlayConfigDetails (1, 1, probeSampleRate, probeBlockSize);
    loader->prepareToPlay (probeSampleRate, probeBlockSize);
    return loader;
}}

void loadTremolo (ProbeLoader& loader)
{{
    cmaj::PatchManifest manifest;
    manifest.initialiseWithFile (patchPath);

    if (! loader.loadSync (std::move (manifest)))
        throw std::runtime_error ("Tremolo load failed");

    if (! loader.patch->isLoaded())
        throw std::runtime_error ("Tremolo did not become loaded");
}}

choc::value::Value sendRequest (cmaj::Patch& patch,
                                CapturingView& view,
                                const choc::value::ValueView& message,
                                const std::string& replyType)
{{
    view.clear();

    if (! patch.handleClientMessage (view, message))
        throw std::runtime_error ("Patch did not handle message " + message["type"].toString());

    auto reply = view.getReply (replyType);

    if (reply.isVoid())
        throw std::runtime_error ("No reply for " + replyType);

    return reply;
}}

cmaj::PatchParameter* chooseParameter (cmaj::Patch& patch)
{{
    auto params = patch.getParameterList();

    for (auto& param : params)
        if (! param->properties.boolean && param->properties.maxValue > param->properties.minValue)
            return param.get();

    if (! params.empty())
        return params.front().get();

    throw std::runtime_error ("Tremolo exposed no parameters");
}}

float chooseDistinctValue (const cmaj::PatchParameter& param)
{{
    if (param.properties.boolean)
        return param.properties.defaultValue < 0.5f ? 1.0f : 0.0f;

    auto value = param.properties.minValue + ((param.properties.maxValue - param.properties.minValue) * 0.73f);

    if (std::abs (value - param.properties.defaultValue) < 0.0001f)
        value = param.properties.minValue + ((param.properties.maxValue - param.properties.minValue) * 0.37f);

    return param.properties.snapAndConstrainValue (value);
}}

choc::value::Value createFullStateFor (const std::string& endpointID, float value)
{{
    auto parameters = choc::value::createEmptyArray();
    parameters.addArrayElement (choc::json::create ("name", endpointID,
                                                    "value", value));

    return choc::json::create ("parameters", parameters,
                               "values", choc::json::create (probeStateKey, probeStateValue));
}}

bool stateContainsParameter (const choc::value::ValueView& state, const std::string& endpointID, float expected)
{{
    if (auto parameters = state["parameters"]; parameters.isArray())
        for (auto param : parameters)
            if (param["name"].toString() == endpointID)
                return std::abs (param["value"].getWithDefault<float> (-9999.0f) - expected) < 0.0001f;

    return false;
}}

bool stateContainsProbeValue (const choc::value::ValueView& state)
{{
    return state["values"][probeStateKey].toString() == probeStateValue;
}}
}} // namespace

int main()
{{
    try
    {{
        juce::ScopedJuceInitialiser_GUI juce;

        std::string endpointID;
        float expectedValue = 0.0f;

        {{
            auto saver = createLoader();
            loadTremolo (*saver);

            CapturingView view (*saver->patch);
            auto* param = chooseParameter (*saver->patch);
            endpointID = param->properties.endpointID;
            expectedValue = chooseDistinctValue (*param);

            saver->patch->handleClientMessage (view,
                                               choc::json::create ("type", "send_full_state",
                                                                   "value", createFullStateFor (endpointID, expectedValue)));

            auto saveReply = sendRequest (*saver->patch,
                                          view,
                                                              choc::json::create ("type", "savePreset",
                                                              "replyType", "save_reply",
                                                              "name", probePresetName),
                                          "save_reply");

            if (! saveReply["ok"].getWithDefault<bool> (false))
                throw std::runtime_error ("Save failed: " + saveReply["error"].toString());
        }}

        auto loader = createLoader();
        loadTremolo (*loader);
        CapturingView view (*loader->patch);

        auto listed = sendRequest (*loader->patch,
                                   view,
                                   choc::json::create ("type", "listPresets",
                                                       "replyType", "list_reply"),
                                   "list_reply");

        bool foundPreset = false;

        if (listed.isArray())
            for (auto preset : listed)
                if (preset["name"].toString() == probePresetName)
                    foundPreset = true;

        if (! foundPreset)
            throw std::runtime_error ("Saved preset was not listed");

        auto loadReply = sendRequest (*loader->patch,
                                      view,
                                      choc::json::create ("type", "loadPreset",
                                                          "replyType", "load_reply",
                                                          "name", probePresetName),
                                      "load_reply");

        if (! loadReply["ok"].getWithDefault<bool> (false))
            throw std::runtime_error ("Load failed: " + loadReply["error"].toString());

        auto restoredState = loader->patch->getFullStoredState();

        if (! stateContainsParameter (restoredState, endpointID, expectedValue))
            throw std::runtime_error ("Restored parameter value did not match");

        if (! stateContainsProbeValue (restoredState))
            throw std::runtime_error ("Restored stored-state value did not match");

        auto deleteReply = sendRequest (*loader->patch,
                                        view,
                                        choc::json::create ("type", "deletePreset",
                                                            "replyType", "delete_reply",
                                                            "name", probePresetName),
                                        "delete_reply");

        if (! deleteReply["ok"].getWithDefault<bool> (false))
            throw std::runtime_error ("Delete failed: " + deleteReply["error"].toString());

        std::cout << "PRESET_NAME=" << probePresetName << "\\n";
        std::cout << "PARAMETER=" << endpointID << "\\n";
        std::cout << "VALUE=" << expectedValue << "\\n";
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
    return build_dir / "Release" / "preset_roundtrip_probe.exe"


def run_probe(probe):
    user_profile = REPO_ROOT / ".feather" / "tmp" / "preset_roundtrip_userprofile"

    if user_profile.exists():
        shutil.rmtree(user_profile)

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


def main():
    parser = argparse.ArgumentParser(description="Functional check for Lost Audio preset save/load")
    parser.add_argument("--build-root", type=pathlib.Path, default=DEFAULT_BUILD_ROOT)
    parser.add_argument("--juce-path", type=pathlib.Path, default=DEFAULT_JUCE_PATH)
    parser.add_argument("--probe", type=pathlib.Path, help="Existing preset_roundtrip_probe.exe to run")
    args = parser.parse_args()

    if args.probe:
        probe = args.probe
    else:
        if not args.juce_path.exists():
            raise RuntimeError(f"JUCE path not found: {args.juce_path}")

        probe = build_probe(args.build_root, args.juce_path)

    if not probe.exists():
        raise RuntimeError(f"Probe executable not found: {probe}")

    run_probe(probe)
    print("PASS: preset save/list/load/delete round-tripped through Patch message state APIs")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
