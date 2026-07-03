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
| `include/cmajor/helpers/cmaj_Patch.h` | `a3b276f` sidechain support. Adds a split-pointer `process()` overload so host buffers can be passed as separate main/sidechain input spans without forcing interleaving assumptions. | Keep the overload small and source-compatible. If upstream changes process APIs, port the overload onto the new shape rather than carrying duplicate buffer code. |
| `examples/patches/SidechainDuck` | `a3b276f` sidechain support. Example patch used as the regression/smoke fixture for sidechain routing. | Keep the example compiling and runnable. If upstream moves example structure, relocate the patch intact and update any smoke-test paths. |
| `include/cmajor/helpers/cmaj_JUCEPlugin.h` | `feature/persistent-webview` WIP. Moves WebView ownership toward the processor and supports parking so plugin editors can close/reopen without destroying the patch GUI state. | Expect churn when upstream changes JUCE wrapper lifetime code. Keep processor-owned WebView lifetime isolated and marked; prefer helper extraction over deeper wrapper edits. |
| `include/cmajor/helpers/cmaj_PatchWebView.h` | `feature/persistent-webview` WIP. Tracks text-input focus so keyboard shortcuts and host key handling do not steal typing from Svelte/WebView controls. | Preserve the focus signal and the host/web content boundary. If upstream changes WebView messaging, re-map the focus events onto the new message path. |
| `include/cmajor/helpers/cmaj_PluginHelpers.h` | `feature/persistent-webview` WIP. Adds `WebViewParkingWindow` and spacebar passthrough for persistent editors. Windows-only so far. | Keep Windows-specific code guarded and obvious. Do not claim cross-platform behaviour until macOS/Linux paths are implemented and smoked. |
| `modules/plugin/include/clap/cmaj_CLAPPlugin.h` | `feature/persistent-webview` WIP. CLAP persistence is partially ported, roughly 40%, to align CLAP editor lifetime with the JUCE persistent WebView model. | Treat as incomplete. During upstream merges, preserve compileability first, then re-test persistence before expanding scope. |

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
