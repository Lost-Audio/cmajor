# Feather ideas & roadmap

Living document — features that make this fork *ours*, beyond what upstream Cmajor has.
Add freely; move items to FEATHER-MODS.md when they ship.

## In flight
- **Loader-level RAM rolling recorder** — CmajPlugin continuously taps its audio into a lock-free ring buffer (last N seconds, configurable). UI button saves the capture to WAV on the message thread; stretch: drag the clip from the webview straight into the DAW timeline (JUCE OS drag-and-drop with a temp file). Patch-agnostic: every loaded patch gets capture for free. Nothing upstream has this.

## Queued
- **SpectralGate tilt normalization** — negative Tilt currently boosts overall loudness (lows gain a lot). Fix: pivot the tilt around a center frequency (~1kHz) and/or normalize total energy so Tilt changes color, not volume.
- **MIDI out wiring check** — the language supports `output event std::midi::Message`; verify the JUCE/CLAP wrappers + JIT loader forward patch MIDI-out to the host buffer (and declare producesMidi). Unlocks arp/sequencer/MIDI-effect plugins. Watch per-host VST3 MIDI-out quirks.
- **Preset system** — conventions + wrapper support: preset folder per patch (Documents/LostAudio/<patch>/presets), save/load/browse UI component in the Svelte template, wrapper exposes host preset API where sensible. Uses the existing full-state store/restore plumbing.

## UI/UX platform (Svelte is mandatory for custom GUIs — house rule, see CLAUDE.md)
- **Plugin scaling & resize** — every pro plugin has it: drag-corner resize with aspect lock, a scale menu (75/100/125/150/200%), scale persisted per-plugin in state, DPI-aware. Mechanics: wrapper stores scale + size in plugin state; webview applies CSS zoom/transform; manifest keeps min/max. The generic patch view gets it too.
- **"Pro starter" Svelte template variant** — `cmaj create --ui=svelte-pro`: plugin chrome out of the box — header bar (logo, preset browser, A/B, scale menu, settings gear), responsive knob grid bound to endpoints automatically, meter strip, resize handle. New plugin = minutes to pro-looking.
- **Spectrum analyzer component** — real-time FFT display as a reusable Svelte component (endpoint audio streaming → PFFFT-accelerated analysis → motion-gpu/WebGPU rendering). Synergy: we own the whole path from DSP to pixels.
- **Value entry + tooltips** — double-click any knob to type an exact value with units; hover tooltips; fine-drag with shift. Template-level, free for every product.
- **Themes** — dark/light/custom theme tokens in the template (Tailwind vars); per-plugin brand skins.

## Pro-plugin capabilities Cmajor doesn't have (recommendations — the gap between "patch" and "product")
- **Parameter modulation system** — wrapper/template-level LFOs + envelope followers + macro knobs assignable to ANY parameter (Serum/Vital-style drag-to-assign rings in the UI). The single biggest "pro synth/FX" differentiator. Feasible: modulation engine in the wrapper (or a feather:: patch layer), UI rings in the Svelte template.
- **MIDI learn** — right-click knob → "Learn", map CC, persist mapping per plugin. Wrapper-level, patch-agnostic.
- **A/B compare + copy** — two settings slots with instant switch and copy A→B; tiny wrapper feature, huge workflow win.
- **Click-free bypass** — latency-compensated, crossfaded bypass instead of hard toggle.
- **Latency reporting (PDC)** — verify patch latency (e.g. SpectralGate's 1024 samples) is forwarded to the host for delay compensation in all wrappers; fix if not. Quiet but essential for pro use.
- **Per-voice multi-out** — drum/sampler plugins with per-pad output buses (our bus infra already supports arbitrary output buses via annotations — needs an example + DAW validation).
- **Licensing/activation hooks** — you SELL these: wrapper-level serial/activation layer (offline-friendly), watermark-free trial mode. Worth designing early so it's uniform across products.
- **Auto-update check** — plugin pings a Lost Audio endpoint for new versions, shows a gentle badge in the header (no nagging).
- **Crash-safe state journaling** — periodically journal state so a DAW crash never loses a preset-in-progress.

## Backlog (bigger)
- **`feather::` standard-library extension namespace** — our own std-style library shipped in the fork (standard_library/feather_*.cmajor): sampler primitives (zone mapping, velocity layers, round-robin), better envelopes (AHDSR with curves), utility DSP. This is the "extending the std library" layer — patch-level features become reusable across all our products.
- **Playbox-style sample player** — 500-sample kit player as an example/product template: externals array-of-structs packaging (see Cmaj Bundle Sampling doc), `std::voices` allocation, Svelte browser UI. RAM-resident (no disk streaming by design — Playbox scale yes, Kontakt scale no). Pairs with the resampler native below for quality repitching.
- **More natives via the M4 registry** ("natives" = C libraries wired into the LLVM JIT the same way PFFFT was, one registry entry each; pure-Cmajor fallback stays for WASM):
  - windowed-sinc **resampler** (sample-player repitching quality + speed)
  - partitioned **convolution** kernel (IR reverbs at low latency)
- **Oversampling wrapper option** (= run the patch's DSP at 2×/4× the host rate internally, then filter back down — kills aliasing in distortion/saturation-type patches at some CPU cost; a manifest flag + wrapper resampling stage)
- **Drag-and-drop audio export from webview** — generalization of the rolling recorder's drag-out for any patch that renders audio (bounce buffers, captured loops).
- **AU/mac validation pass** — partner's machine; the guarded NSView parking paths carry `// FEATHER: TODO(mac-validate)`.
- **Optional CI** — GitHub Actions: build + cmaj test + all feather smokes on push; weekly upstream-merge dry-run report.

## Shipped (see FEATHER-MODS.md for details)
Persistent WebView editors (JUCE+CLAP) · sidechain/multi-bus everywhere incl. JIT loader · Svelte-default patch UI scaffold · PFFFT native FFT (18.7× kernel, 1.29× real spectral patch) · MCP dev-loop server · bundle sampling + bus layout docs · loader state restore · channel adaptation (mono up-mix) · SpectralGate example + PFFFT A/B harness
