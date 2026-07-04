# Codex prompt — Lost Audio licensing/activation system (DESIGN FIRST, then v1)

Run in a separate terminal from the repo root:

    cd F:\Programming\DSP_Projects\2025\cmajor-feather
    codex exec --sandbox workspace-write -c model_reasoning_effort=xhigh "$(cat prompts/licensing-design.md)"

(Everything below the line is the prompt. It intentionally asks for a DESIGN doc and your approval BEFORE it writes production crypto — do not skip that gate.)

---

You are designing the licensing + activation system for Lost Audio, a fork of Cmajor that builds and SELLS commercial audio plugins (VST3/AU/CLAP, both generated plugins and the CmajPlugin JIT loader). Repo: F:\Programming\DSP_Projects\2025\cmajor-feather, branch main. This is security-sensitive and revenue-critical — correctness and threat-modeling matter more than speed.

## PHASE 1 — DESIGN ONLY (do this first, write no production code yet)
Write a design document to docs/Cmaj Licensing.md covering:

- **Threat model**: what we defend against (casual copying, key sharing, cracked builds) and what we explicitly DON'T (a determined reverse-engineer with a debugger — accept this; goal is friction + honesty, not DRM that punishes paying users).
- **Scheme**: recommend offline-first license FILES over online activation servers (musicians work offline; activation servers become a liability and a support burden). Proposed approach to evaluate: Ed25519-signed license files — Lost Audio holds the private key, every plugin embeds the public key, a license file binds {product ID, license type, customer email/name, issue date, optional machine fingerprint} and is signed. Plugin verifies signature at load. Compare against alternatives (online activation, challenge-response, hardware dongles) with tradeoffs for a small indie selling via web checkout.
- **Trial mode**: watermark-free, time-limited or feature-limited? Recommend and justify (I lean: fully functional, periodic gentle nag + maybe a subtle output watermark ONLY in trial — decide and argue it). How trial state resists trivial clock-rollback without being hostile.
- **Machine binding**: optional fingerprint (which stable, non-PII signals on Win/Mac), how many activations per license, how deactivation/transfer works offline.
- **Uniformity**: how EVERY Lost Audio product (generated plugins + the JIT loader) consumes this identically — a shared C++ module (layer C wrapper, e.g. include/cmajor/helpers/feather/cmaj_License.h) + a Svelte activation UI component (layer D template) that drops into any patch view.
- **Key management & sales pipeline** (layer F): where the signing private key lives (NOT in the repo — document the boundary), how license files get generated at point of sale (a small offline CLI tool: `feather-license issue --product X --email ...`), how they reach the customer (email/download), how the web store hooks in. Keep the private key generation/signing tool SEPARATE from the plugin code.
- **UX**: unlicensed-launch experience (don't block audio abruptly), where the license file lives on disk per-OS, drag-a-.lekey-onto-the-plugin activation, error states.
- **Anti-footgun**: what happens on clock change, OS reinstall, plugin update, offline machine — paying customers must NEVER get locked out.

Then STOP and present the design summary (max ~20 lines) with your key recommendations and the 2-3 decisions you need me to confirm (scheme choice, trial policy, machine-binding yes/no). Wait for my approval before Phase 2.

## PHASE 2 — v1 IMPLEMENTATION (only after I approve the design)
- Shared verification module (layer C): loads + verifies a signed license file, exposes isLicensed()/licenseInfo()/isTrial() to wrappers; embedded public key; zero network. Constant-time signature check; fail-closed but grace-not-hostile.
- Standalone signing CLI (separate target, e.g. tools/feather-license/, NOT shipped in plugins): generate keypair, issue signed license files. Private key never touches the plugin build.
- Svelte activation component (layer D): drag-.lekey activation, license status display, trial countdown, buy link. Follows the house Svelte stack.
- Wire into CmajPlugin + the generated-plugin path uniformly (// FEATHER: markers, FEATHER-MODS.md row).
- Tests: signature verify/reject (tampered file, wrong product, expired), trial expiry logic, clock-rollback resistance, offline behavior. Use a THROWAWAY test keypair generated in a temp dir — never commit private keys, add *.lekey-private / signing keys to .gitignore.

Gates for Phase 2: builds (cmaj, CmajPlugin_VST3 clean); pluginval s8 full still passes with licensing active in both licensed and trial states; the license test suite passes; existing feather smokes (sidechain, mono_upmix, loader-state) still pass; NO private key material committed (grep the diff).

Constraints throughout: security correctness first; never commit secrets; the signing key boundary is sacred; paying-customer lockout is the cardinal sin. Report design to docs/Cmaj Licensing.md; implementation report to .feather/reports/licensing-v1.md.
