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
| `include/cmajor/helpers/cmaj_JUCEPlugin.h` | M2 bus layouts. Refactors annotation grouping through `cmaj_AudioBusLayoutHelper.h`, keeps generated JUCE wrappers inheriting multi-bus layouts, feeds silence for disabled sidechain input buses, and documents the dynamic loader's fixed construction-time bus shape. | Preserve `// FEATHER:` comments around bus-layout and silence-scratch behaviour. If JUCE bus APIs change, keep disabled auxiliary buses accepted and silence-backed. |
| `include/cmajor/helpers/cmaj_Patch.h` | `a3b276f` sidechain support. Adds a split-pointer `process()` overload so host buffers can be passed as separate main/sidechain input spans without forcing interleaving assumptions. | Keep the overload small and source-compatible. If upstream changes process APIs, port the overload onto the new shape rather than carrying duplicate buffer code. |
| `modules/plugin/include/clap/cmaj_CLAPPlugin.h` | M2 bus layouts. CLAP audio ports now expose one port per shared bus group, mark only the main bus as `CLAP_AUDIO_PORT_IS_MAIN`, and route missing sidechain/aux input ports as silence during process. | Preserve port grouping via `cmaj_AudioBusLayoutHelper.h`; if CLAP wrapper internals change, keep missing input ports silence-backed and validate with the SidechainDuck smoke test. |
| `modules/playback/include/cmaj_PatchPlayer.h` | M2 bus layouts. Documents dev-time player flat channel mapping: bus groups consume device channels in declaration order, main/default first, aux/sidechain from remaining channels, outputs analogous. | Keep comments near playback parameter handoff. If playback routing moves out of `Patch`, update the comment and mapping together. |
| `tools/command/Source/cmaj_command_GeneratePlugin.h` | M2 bus layouts. Generated JUCE `CMakeLists.txt` now documents that `cmaj_JUCEPlugin.h` derives plugin bus layout from endpoint `bus`/`role` annotations. | Preserve the generated-project comment when templates move. Generated JUCE projects inherit multi-bus behaviour through the shared helper include chain. |
| `tools/command/Source/cmaj_command_EmbeddedIncludeFolder.h`, `modules/compiler/src/backends/CPlusPlus/cmaj_EmbeddedIncludeFolder.h`, `tools/command/Source/cmaj_command_EmbeddedPluginHelpersFolder.h` | M2 bus layouts. Regenerated embedded include/plugin-helper bundles after changing helper and plugin wrapper headers. | Never hand-edit; resolve conflicts by rerunning `python tools/scripts/create_embedded_files.py` and checking the idempotent rerun. |
| `tests/feather/sidechain_smoke.py` | M2 bus layouts. CLI smoke test renders SidechainDuck with pulsed and silent sidechain channels and asserts the pulsed render dips significantly by RMS. | Keep this as the primary sidechain regression gate. If render CLI options change, update the script rather than weakening the assertion. |
| `examples/patches/SidechainDuck` | `a3b276f` sidechain support. Example patch used as the regression/smoke fixture for sidechain routing. | Keep the example compiling and runnable. If upstream moves example structure, relocate the patch intact and update any smoke-test paths. |
| `include/cmajor/helpers/cmaj_JUCEPlugin.h` | Persistent WebView, implemented + review-hardened (merged). Processor-owned WebView with parking, attach state machine, native-attachment health checks, owner lifetime tokens, `persistentView` manifest flag (default true). | Expect churn when upstream changes JUCE wrapper lifetime code. Keep processor-owned WebView lifetime isolated and marked; prefer helper extraction over deeper wrapper edits. |
| `include/cmajor/helpers/cmaj_PatchWebView.h` | Persistent WebView, implemented (merged). Tracks text-input focus so keyboard shortcuts and host key handling do not steal typing from Svelte/WebView controls. | Preserve the focus signal and the host/web content boundary. If upstream changes WebView messaging, re-map the focus events onto the new message path. |
| `include/cmajor/helpers/cmaj_PluginHelpers.h` | Persistent WebView, implemented (merged). `WebViewParkingWindow`, JS-bridge spacebar passthrough, process-wide destroy-hook registry with lifetime/registration tokens. Windows implemented; macOS NSView paths guarded but untested (`// FEATHER: TODO(mac-validate)`). | Keep platform-specific code guarded and obvious. macOS behaviour unverified until run on a Mac. |
| `modules/plugin/include/clap/cmaj_CLAPPlugin.h` | Persistent WebView, implemented (merged). CLAP editor lifecycle at parity with JUCE (park on gui_destroy, reattach on gui_create/setParent, api/floating validation, same token model). | During upstream merges, preserve compileability first, then re-test persistence in a CLAP host. |

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
