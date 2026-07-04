# Feather ideas & roadmap

Living document — features that make this fork *ours*, beyond what upstream Cmajor has.
Add freely; move items to FEATHER-MODS.md when they ship.

## In flight
- **Loader-level RAM rolling recorder** — CmajPlugin continuously taps its audio into a lock-free ring buffer (last N seconds, configurable). UI button saves the capture to WAV on the message thread; stretch: drag the clip from the webview straight into the DAW timeline (JUCE OS drag-and-drop with a temp file). Patch-agnostic: every loaded patch gets capture for free. Nothing upstream has this.

## Queued
- **SpectralGate tilt normalization** — negative Tilt currently boosts overall loudness (lows gain a lot). Fix: pivot the tilt around a center frequency (~1kHz) and/or normalize total energy so Tilt changes color, not volume.
- **MIDI out wiring check** — the language supports `output event std::midi::Message`; verify the JUCE/CLAP wrappers + JIT loader forward patch MIDI-out to the host buffer (and declare producesMidi). Unlocks arp/sequencer/MIDI-effect plugins. Watch per-host VST3 MIDI-out quirks.
- **Preset system** — conventions + wrapper support: preset folder per patch (Documents/LostAudio/<patch>/presets), save/load/browse UI component in the Svelte template, wrapper exposes host preset API where sensible. Uses the existing full-state store/restore plumbing.

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
