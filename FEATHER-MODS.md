# Feather fork modifications

Purpose: this is Lost Audio's internal fork of Cmajor carrying the Feather feature set: persistent WebView GUIs, multi-bus/sidechain plugin support, Svelte-first patch UIs, native performance externals, and MCP dev tooling. It is an internal tool for building and selling Lost Audio plugins, not a public product.

## Scope

- Feather changes exist to support Lost Audio plugin production.
- Keep public Cmajor behaviour as close to upstream as practical.
- Avoid broad rewrites when a narrow wrapper/helper change will do.
- Treat WIP rows as branch state, not shipped guarantees.

## Current divergences from upstream

| File | What / why | Upstream-merge conflict strategy |
| --- | --- | --- |
| `include/cmajor/helpers/cmaj_JUCEPlugin.h` | `a3b276f` sidechain support. Adds annotation-driven bus grouping so patch metadata can describe main input/output and sidechain buses for JUCE plugin wrappers. | Preserve the annotation parsing and bus grouping behaviour. Re-apply with `// FEATHER:` markers if upstream rewrites the wrapper. Validate with the SidechainDuck smoke test. |
| `include/cmajor/helpers/cmaj_AudioBusLayoutHelper.h` | M2 bus layouts. New shared helper for grouping audio endpoints into ordered bus groups from `bus`/`role` annotations so JUCE, CLAP, generated plugins, and dev-time playback share one interpretation. | Prefer keeping wrapper-specific code thin and porting annotation semantics here first. Validate with the SidechainDuck smoke test after upstream endpoint or annotation changes. |
| `include/cmajor/helpers/cmaj_JUCEPlugin.h` | M2 bus layouts + dynamic-loader sidechain. Refactors annotation grouping through `cmaj_AudioBusLayoutHelper.h`, keeps generated JUCE wrappers inheriting multi-bus layouts, feeds silence for disabled sidechain input buses, and lets the dynamic JIT loader map one loaded aux/sidechain input group onto its predeclared optional stereo `Sidechain` bus. Exotic layouts still need generated plugins. | Preserve `// FEATHER:` comments around bus-layout and silence-scratch behaviour. If JUCE bus APIs change, keep disabled auxiliary buses accepted and silence-backed, and keep the dynamic loader limited to one predeclared aux input bus. |
| `include/cmajor/helpers/cmaj_JUCEPlugin.h` | Dynamic-loader state restore. Stashes host-restored parameter values while `CmajPlugin` compiles a patch asynchronously, reapplies them after parameter rebinding, notifies host-facing fixed parameter slots of restored/init values, and detaches stale slots after hot-swap. | Preserve the pending-restore and post-rebind notification path for non-fixed JUCE loader plugins. Validate with the loader state round-trip probe, SidechainDuck fresh defaults, hot-swap checks, and pluginval state restoration. |
| `include/cmajor/helpers/cmaj_Patch.h` | `a3b276f` sidechain support. Adds a split-pointer `process()` overload so host buffers can be passed as separate main/sidechain input spans without forcing interleaving assumptions. | Keep the overload small and source-compatible. If upstream changes process APIs, port the overload onto the new shape rather than carrying duplicate buffer code. |
| `modules/plugin/include/clap/cmaj_CLAPPlugin.h` | M2 bus layouts. CLAP audio ports now expose one port per shared bus group, mark only the main bus as `CLAP_AUDIO_PORT_IS_MAIN`, and route missing sidechain/aux input ports as silence during process. | Preserve port grouping via `cmaj_AudioBusLayoutHelper.h`; if CLAP wrapper internals change, keep missing input ports silence-backed and validate with the SidechainDuck smoke test. |
| `modules/playback/include/cmaj_PatchPlayer.h` | M2 bus layouts. Documents dev-time player flat channel mapping: bus groups consume device channels in declaration order, main/default first, aux/sidechain from remaining channels, outputs analogous. | Keep comments near playback parameter handoff. If playback routing moves out of `Patch`, update the comment and mapping together. |
| `tools/command/Source/cmaj_command_GeneratePlugin.h` | M2 bus layouts. Generated JUCE `CMakeLists.txt` now documents that `cmaj_JUCEPlugin.h` derives plugin bus layout from endpoint `bus`/`role` annotations. | Preserve the generated-project comment when templates move. Generated JUCE projects inherit multi-bus behaviour through the shared helper include chain. |
| `tools/command/Source/cmaj_command_EmbeddedIncludeFolder.h`, `modules/compiler/src/backends/CPlusPlus/cmaj_EmbeddedIncludeFolder.h`, `tools/command/Source/cmaj_command_EmbeddedPluginHelpersFolder.h` | M2 bus layouts. Regenerated embedded include/plugin-helper bundles after changing helper and plugin wrapper headers. | Never hand-edit; resolve conflicts by rerunning `python tools/scripts/create_embedded_files.py` and checking the idempotent rerun. |
| `tests/feather/sidechain_smoke.py` | M2 bus layouts. CLI smoke test renders SidechainDuck with pulsed and silent sidechain channels and asserts the pulsed render dips significantly by RMS. | Keep this as the primary sidechain regression gate. If render CLI options change, update the script rather than weakening the assertion. |
| `include/cmajor/helpers/cmaj_AudioBusLayoutHelper.h`, `include/cmajor/helpers/cmaj_JUCEPlugin.h`, `modules/plugin/include/clap/cmaj_CLAPPlugin.h`, `tests/feather/mono_upmix_smoke.py` | Main-bus channel adaptation. Restores upstream's pre-bus-layout channel adaptation (mono endpoint group replicated to every main host bus channel, fold-to-mono by unscaled summing, mono host input replicated into endpoint channels) which the strict per-bus mapping had bypassed, making mono patches (e.g. SineSynth) play hard-left in the JIT loader. Adds `channelMode: "strict"` endpoint annotation and `shouldAdaptChannels()`; aux/sidechain buses stay strict and silence-backed; equal channel counts remain bit-identical; adaptation is planned from cached bus-group mappings with no locks or heap allocation on the audio path. | Preserve the `// FEATHER:` adaptation blocks in `refreshAudioChannelPointers()`/`applyOutputBusChannelAdaptation()` (JUCE) and `toInputChannelArrayView()`/`clapPlugin_process()` (CLAP). Contract lives in `docs/Cmaj Bus Layouts.md` (Channel Adaptation). Validate with `tests/feather/mono_upmix_smoke.py`, `tests/feather/sidechain_smoke.py`, and a DAW mono-patch check on the dynamic loader. |
| `examples/patches/SidechainDuck` | `a3b276f` sidechain support. Example patch used as the regression/smoke fixture for sidechain routing. | Keep the example compiling and runnable. If upstream moves example structure, relocate the patch intact and update any smoke-test paths. |
| `include/cmajor/helpers/cmaj_JUCEPlugin.h` | Persistent WebView, implemented + review-hardened (merged). Processor-owned WebView with parking, attach state machine, native-attachment health checks, owner lifetime tokens, `persistentView` manifest flag (default true). | Expect churn when upstream changes JUCE wrapper lifetime code. Keep processor-owned WebView lifetime isolated and marked; prefer helper extraction over deeper wrapper edits. |
| `include/cmajor/helpers/cmaj_PatchWebView.h` | Persistent WebView, implemented (merged). Tracks text-input focus so keyboard shortcuts and host key handling do not steal typing from Svelte/WebView controls. | Preserve the focus signal and the host/web content boundary. If upstream changes WebView messaging, re-map the focus events onto the new message path. |
| `include/cmajor/helpers/cmaj_PluginHelpers.h` | Persistent WebView, implemented (merged). `WebViewParkingWindow`, JS-bridge spacebar passthrough, process-wide destroy-hook registry with lifetime/registration tokens. Windows implemented; macOS NSView paths guarded but untested (`// FEATHER: TODO(mac-validate)`). | Keep platform-specific code guarded and obvious. macOS behaviour unverified until run on a Mac. |
| `modules/plugin/include/clap/cmaj_CLAPPlugin.h` | Persistent WebView, implemented (merged). CLAP editor lifecycle at parity with JUCE (park on gui_destroy, reattach on gui_create/setParent, api/floating validation, same token model). | During upstream merges, preserve compileability first, then re-test persistence in a CLAP host. |
| `tools/command/Source/cmaj_command_CreatePatch.h` | M3 Svelte-first patch UI scaffold. `cmaj create` now defaults to `--ui=svelte`, emits a Svelte 5 + TypeScript + Vite library-mode `view/` folder, and keeps `--ui=generic`/`--ui=none` as no-view upstream-style patch creation paths. | Keep the string-template emission local to this command unless upstream introduces a template system. Preserve the `--ui` parser and generated manifest contract; regenerate embedded command assets after edits. |
| `tools/command/Source/cmaj_command_main.cpp` | M3 Svelte-first patch UI scaffold. Help text documents the Feather `--ui=svelte\|generic\|none` create option and its default. | Re-apply the help text near `cmaj create` if upstream rewrites command help; keep the nearby `// FEATHER:` marker. |
| `docs/Cmaj Bundle Sampling.md` | M5 documentation. Internal guide for packaging sample externals and writing sample players, grounded in the Piano, ConvolutionReverb, manifest, codegen, and standard-library implementations. | Keep as Lost Audio internal documentation. Refresh when external coercion, generated resource embedding, or `std::audio_data` changes. |
| `docs/Cmaj Bus Layouts.md` | M5 documentation. Internal guide for Feather bus/sidechain annotations, JUCE/CLAP/player mapping, disabled-bus semantics, DAW routing notes, and the SidechainDuck smoke gate. | Keep aligned with `cmaj_AudioBusLayoutHelper.h`, JUCE/CLAP wrappers, and `tests/feather/sidechain_smoke.py` whenever bus routing changes. |
| `docs/Cmaj Patch Format.md` | M5 documentation. Adds a fork-extended externals note that points to the bundle sampling guide and clarifies exported-plugin external baking. | Preserve the upstream patch-format text and keep the Lost Audio addition short and clearly marked as fork-extended. |
| `3rdParty/pffft/*` | M4 native FFT. Vendored PFFFT source from the marton78 mirror of Julien Pommier's FFTPACK-derived implementation, with license text intact, used by LLVM native stdlib overrides. | Treat as third-party source. Do not hand-edit; update by replacing from a verified upstream/mirror source and rerun the native FFT gates. |
| `modules/compiler/src/backends/cmaj_NativeOverrides.h` | M4 native FFT. Data-driven native override registry keyed by original generic qualified name, currently binding eligible `std::frequency::complexFFT` specialisations. | Keep new native entries isolated here. If upstream changes generic specialisation metadata, update the matcher rather than matching generated function names. |
| `modules/compiler/src/backends/cmaj_NativeFFT.h`, `modules/compiler/src/backends/cmaj_NativeFFT.cpp` | M4 native FFT. PFFFT-backed f32 complex FFT shims, registration-time setup cache, alignment bounce, and bounded stack/TLS scratch handling for LLVM JIT externals. | Preserve the setup-before-JIT/audio-thread contract. Keep f64 and unsupported/small sizes falling back unless a verified backend is added and gated. |
| `modules/compiler/src/backends/LLVM/cmaj_LLVMGenerator.h` | M4 native FFT. `addNativeOverriddenFunctions()` now calls the Feather native registry behind `CMAJ_ENABLE_NATIVE_OVERRIDES`. | Preserve the nearby `// FEATHER:` marker and keep the hook thin. If upstream adds native overrides, bridge this registry into the upstream mechanism. |
| `modules/compiler/src/backends/LLVM/cmaj_LLVMPerformer.cpp` | M4 native FFT. Bumps the LLVM engine version when native overrides are enabled and skips bitcode cache load/save for modules with native-overridden stdlib bodies. | Preserve cache guard semantics: native-overridden declarations must not be loaded from stale bitcode without absolute symbol registration. |
| `modules/CMakeLists.txt` | M4 native FFT. Adds `CMAJ_ENABLE_NATIVE_OVERRIDES`, compiles PFFFT float sources for LLVM performer targets, defines `PFFFT_STATIC_DEFINE`, and disables native overrides for wasm system targets. | Keep PFFFT include/source wiring local and prefer CMake include dirs over vendored source edits. Re-test ON/OFF override builds after CMake changes. |
| `tests/language_tests/cmaj_test_native_fft.cmajtest` | M4 native FFT. Dual-engine correctness coverage for f32 native/fallback FFT paths, f64 fallback, and an FFT-heavy performanceTest benchmark. | Run with both `--engine=llvm` and `--engine=cpp`; use the llvm performance output to compare native overrides ON vs OFF. |
| `examples/patches/SpectralGate`, `tests/feather/spectral_pffft_check.py` | M4 native FFT real-patch fixture. Adds a stereo 1024/256 Hann STFT spectral gate/smear/tilt/mix patch with `processor.latency = 1024`, using `std::frequency::realOnlyForwardFFT`/`realOnlyInverseFFT` so the PFFFT-backed `complex32[1024]` override is exercised in a real effect. The harness renders native-ON vs `CMAJ_ENABLE_NATIVE_OVERRIDES=OFF`, asserts `1e-4` equivalence, verifies mix=0 dry bypass after the known render startup gap, and prints a wall-clock speedup ratio. | Keep FFT size 1024 unless the native override bounds change. Validate with `cmaj play --dry-run`, `tests/feather/spectral_pffft_check.py`, `tests/feather/sidechain_smoke.py`, and `tests/feather/mono_upmix_smoke.py`. |

## Standing rules

### Generated embedded files

The embedded headers and embedded asset bundles are auto-generated. Never hand-edit them and never hand-merge them.

Generated files include:

- `modules/compiler/src/backends/CPlusPlus/cmaj_EmbeddedIncludeFolder.h`
- `tools/command/Source/cmaj_command_EmbeddedIncludeFolder.h`
- `tools/command/Source/cmaj_command_EmbeddedPluginHelpersFolder.h`
- `cmaj_EmbeddedWebAssets.h`
- `modules/embedded_assets/*`

After changing any source that feeds these generated files, regenerate them:

- `include/cmajor/helpers/*`
- `modules/plugin/include/*`
- JavaScript/web assets embedded into Cmajor tools or helpers

Run:

```bash
python tools/scripts/create_embedded_files.py
```

Commit the regeneration separately from the source edit when practical. On merge conflicts in generated embedded files, take either side, run the generator, and commit the regenerated result.

### Line endings

This repository uses LF line endings. Do not introduce CRLF on Windows.

### Upstream-owned files

Any Feather edit inside an upstream-owned file must carry a nearby `// FEATHER:` marker comment explaining the fork-specific behaviour.

Prefer adding new files over editing upstream files when the change can be isolated cleanly.

### Upstream sync

Remotes:

- `origin` is `Lost-Audio/cmajor`
- `upstream` is `cmajor-lang/cmajor`

Merge upstream per release or monthly, whichever comes first.

Post-merge gate:

- build `cmaj`
- run `cmaj test`
- run the `SidechainDuck` sidechain smoke test
- run the persistent-WebView smoke test

### Divergence ledger

Every new divergence from upstream gets a row in the table above in the same PR/commit as the implementation.

Rows should name the file, describe what changed and why, and state the upstream-merge conflict strategy.
