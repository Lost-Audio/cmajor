# Feather ideas & roadmap

Living document — features that make this fork *ours*, beyond what upstream Cmajor has.
Add freely; move items to FEATHER-MODS.md when they ship.

## Layer map (where each thing lives)

| Layer | What it is |
|---|---|
| **A · Patch** (.cmajor code) | Per-product DSP |
| **B · feather:: library** (standard_library/feather_*.cmajor) | Reusable DSP shipped in the fork |
| **C · Wrapper C++** (helpers / CmajPlugin / CLAP) | Patch-agnostic plugin features |
| **D · Svelte template** (view scaffold + components) | UI everyone gets |
| **E · Toolchain** (cmaj CLI / codegen / natives) | Compiler-level |
| **F · Infra/business** | Outside the plugin |

Rule of thumb: C+D features are patch-agnostic (build once, every product benefits) — highest leverage. A/B are per-product or shared-DSP. E is rare and reviewed hardest. F is business plumbing.

Every item below is tagged with its layer(s).

## In flight — current round (in order)

1. **Latency reporting (PDC) verification** [C] — exploration shows JUCE (`setLatencySamples`, cmaj_JUCEPlugin.h:908) and CLAP (`clap_plugin_latency_t`, cmaj_CLAPPlugin.h:2373) are already wired. Remaining: verify latency updates on patch reload / dynamic change, and add a feather smoke test so it stays wired.
2. **Windowed-sinc resampler native** [B+E] — `feather::` resampler in Cmajor (the WASM fallback for free), overridden by a native C implementation via the M4 registry (cmaj_NativeOverrides.h). Sample-player repitching quality + speed; also reusable by the oversampling stage.
3. **Signalsmith stretch/pitch native** [B+E] — vendor signalsmith-stretch (MIT, header-only C++) in 3rdParty; expose a `feather::stretch` patch API (pitch shift / time stretch); native override does the real algorithm, pure-Cmajor fallback is a simple granular shifter (works on WASM, lower quality). Latency reported via `processor.latency` (hence PDC first).
4. **Partitioned convolution native** [B+E] — low-latency IR convolution kernel via the same registry; pure-Cmajor uniform-partition fallback. IR reverbs at low latency; pairs with PFFFT.
5. **Oversampling wrapper option** [C] — manifest flag; wrapper runs the patch DSP at 2×/4× host rate and filters back down (kills aliasing in distortion/saturation patches). Reuses the resampler; adds latency → reports via PDC.
6. **Drag-and-drop audio export from webview** [C+D] — generalize the rolling recorder's save-to-WAV into drag-out: JS side (patch-connection API + Svelte component) requests a drag with a rendered/captured buffer; native side saves the WAV and initiates the OS drag (JUCE `performExternalDragDropOfFiles`). Nothing exists yet for outbound drag — new bridge.

## Queued (next up)

- **MIDI out wiring check** [C] — the language supports `output event std::midi::Message`; verify the JUCE/CLAP wrappers + JIT loader forward patch MIDI-out to the host buffer (and declare producesMidi). Unlocks arp/sequencer/MIDI-effect plugins. Watch per-host VST3 MIDI-out quirks.
- **AU/mac validation pass** [C] — partner's machine; the guarded NSView parking paths carry `// FEATHER: TODO(mac-validate)`.

## B · feather:: library (reusable DSP)

- **`feather::` standard-library extension namespace** — our own std-style library shipped in the fork (standard_library/feather_*.cmajor): sampler primitives (zone mapping, velocity layers, round-robin), better envelopes (AHDSR with curves), utility DSP. Patch-level features become reusable across all our products. The in-flight natives (resampler, stretch, convolution) seed this namespace.
- **Playbox-style sample player** [A+B] — 500-sample kit player as an example/product template: externals array-of-structs packaging (see Cmaj Bundle Sampling doc), `std::voices` allocation, Svelte browser UI. RAM-resident (no disk streaming by design — Playbox scale yes, Kontakt scale no). Pairs with the resampler native for quality repitching.

## C · Wrapper C++ (patch-agnostic plugin features)

- **Licensing/activation hooks** [C+F] — you SELL these: wrapper-level serial/activation layer (offline-friendly, Ed25519 signed license files), watermark-free trial mode. MEGA PRIORITY — design early so it's uniform across products. Standalone Codex prompt written at prompts/licensing-design.md (run in a separate terminal); design doc at docs/FEATHER-Licensing.md.
- **Parameter modulation system** [C+D] — wrapper/template-level LFOs + envelope followers + macro knobs assignable to ANY parameter (Serum/Vital-style drag-to-assign rings in the UI). The single biggest "pro synth/FX" differentiator. Modulation engine in the wrapper (or a feather:: patch layer), UI rings in the Svelte template.
- **MIDI learn** — right-click knob → "Learn", map CC, persist mapping per plugin.
- **A/B compare + copy** — two settings slots with instant switch and copy A→B; tiny wrapper feature, huge workflow win.
- **Click-free bypass** — latency-compensated, crossfaded bypass instead of hard toggle.
- **Per-voice multi-out** [A+C] — drum/sampler plugins with per-pad output buses (our bus infra already supports arbitrary output buses via annotations — needs an example + DAW validation).
- **Auto-update check** [C+F] — plugin pings a Lost Audio endpoint for new versions, shows a gentle badge in the header (no nagging).
- **Crash-safe state journaling** — periodically journal state so a DAW crash never loses a preset-in-progress.

## D · Svelte template / UI platform (Svelte is mandatory for custom GUIs — house rule, see CLAUDE.md)

- **Plugin scaling & resize** [C+D] — every pro plugin has it: drag-corner resize with aspect lock, a scale menu (75/100/125/150/200%), scale persisted per-plugin in state, DPI-aware. Mechanics: wrapper stores scale + size in plugin state; webview applies CSS zoom/transform; manifest keeps min/max. The generic patch view gets it too.
- **"Pro starter" Svelte template variant** [D+E] — `cmaj create --ui=svelte-pro`: plugin chrome out of the box — header bar (logo, preset browser, A/B, scale menu, settings gear), responsive knob grid bound to endpoints automatically, meter strip, resize handle. New plugin = minutes to pro-looking.
- **Spectrum analyzer component** — real-time FFT display as a reusable Svelte component (endpoint audio streaming → PFFFT-accelerated analysis → motion-gpu/WebGPU rendering). Synergy: we own the whole path from DSP to pixels.
- **Value entry + tooltips** — double-click any knob to type an exact value with units; hover tooltips; fine-drag with shift. Template-level, free for every product.
- **Themes** — dark/light/custom theme tokens in the template (Tailwind vars); per-plugin brand skins.

## E · Toolchain & natives

"Natives" = C libraries wired into the LLVM JIT the same way PFFFT was (one registry entry each in cmaj_NativeOverrides.h; the pure-Cmajor `feather::` implementation stays as the WASM fallback since `CMAJ_ENABLE_NATIVE_OVERRIDES` is forced off there).

- Resampler, Signalsmith stretch, partitioned convolution → **in flight** (above).
- Future native candidates: land here as they come up.

## F · Infra/business

- **License key generation + sales pipeline** — pairs with the licensing hooks [C].
- **Update endpoint** — pairs with auto-update check [C].
- **Optional CI** — GitHub Actions: build + cmaj test + all feather smokes on push; weekly upstream-merge dry-run report.

## Shipped (see FEATHER-MODS.md for details)

Persistent WebView editors (JUCE+CLAP) · sidechain/multi-bus everywhere incl. JIT loader · Svelte-default patch UI scaffold · PFFFT native FFT (18.7× kernel, 1.29× real spectral patch) · MCP dev-loop server · bundle sampling + bus layout docs · loader state restore · channel adaptation (mono up-mix) · loader-level rolling recorder v1 · Lost Audio preset system v1 · SpectralGate example + PFFFT A/B harness · SpectralGate tilt normalization (pivot @1kHz + energy normalization)
