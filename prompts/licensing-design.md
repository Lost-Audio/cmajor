# Codex prompt — Lost Audio licensing / activation system (DESIGN-FIRST, then v1)

Commercial licensing for Lost Audio audio plugins (a Cmajor fork). Revenue-critical and security-sensitive: this protects legitimately-sold commercial software from piracy. Correctness, threat-modeling, and never locking out paying customers matter more than speed.

Run interactively in a separate terminal (NOT `codex exec` — the Phase-1 approval gate needs you):

    cd F:\Programming\DSP_Projects\2025\cmajor-feather
    codex "$(Get-Content -Raw prompts\licensing-design.md)"

Everything below the line is the prompt.

---

You are the security engineer designing the licensing + activation system for **Lost Audio**, an indie company that builds and SELLS commercial audio plugins (VST3/AU/CLAP) from a fork of Cmajor. Two product shapes must be covered uniformly: (a) **generated plugins** (patch baked at build time via `cmaj generate`), and (b) the **CmajPlugin JIT loader** (loads .cmajorpatch at runtime). Repo: F:\Programming\DSP_Projects\2025\cmajor-feather, branch main. Read FEATHER-MODS.md, FEATHER-IDEAS.md (layer map), and CLAUDE.md first so your design fits the fork's conventions (layer C = wrapper C++ in include/cmajor/helpers, layer D = Svelte template, layer F = business infra; `// FEATHER:` markers; embedded-file regeneration; Svelte-only UI).

This is legitimate anti-piracy protection for software we own and sell. Scope is DEFENSIVE: prove entitlement, add honest friction, protect revenue — NOT surveillance, not user-hostile DRM, not anything that phones home with personal data.

## PHASE 1 — DESIGN ONLY. Write no production code. Produce docs/Cmaj Licensing.md, then STOP for my approval.

Cover, with reasoning and explicit recommendations:

1. **Threat model & non-goals.** Rank real threats for an indie plugin seller: casual copy/reshare, public key/serial leak, cracked/patched binaries, license-file forgery, clock tampering, machine-farming activations. State plainly what we do NOT defend against (a determined RE with a debugger *will* patch any check — accept it; the goal is friction + honesty + making casual piracy inconvenient, never punishing legitimate buyers). Define success metrics.

2. **Prior art first.** Evaluate JUCE's built-in `juce::OnlineUnlockStatus` / `KeyGeneration` / `TracktionMarketplaceStatus` framework — JUCE is already the wrapper substrate, so using/extending its unlock machinery may beat rolling our own. Compare against: custom offline signed-file scheme, online activation server, challenge-response, third-party (PACE/iLok — reject with reasons for an indie), and hardware. Recommend one primary + rationale. If custom, justify why JUCE's isn't enough.

3. **Recommended scheme (evaluate offline-first signed files as the leading candidate).** Ed25519 (or Ed25519ph) signed license files: Lost Audio holds the private key; each product embeds the public key; a license binds `{schemaVersion, productId, licenseType (perpetual/subscription/trial), customerId/email, orderId, issueDate, optExpiry, optMachineFingerprint, optActivationCount}` and is signed. Plugin verifies at load, offline, constant-time. Specify: exact field set, canonical serialization (stable bytes for signing — raw JSON is fragile; consider a fixed binary/CBOR/base64 envelope), versioning so v2 licenses/keys can coexist, and file extension/format (.lakey).

4. **Trial mode.** Recommend policy and defend it: fully-functional time-limited (e.g. 14 days) is industry-friendly. Trial-state storage that resists trivial clock-rollback WITHOUT hostility (monotonic hints: store last-seen timestamp, detect large backward jumps → expire, but tolerate DST/timezone/legit clock fixes). Decide on trial audio watermark: I lean NO watermark (competitive with the market) — argue it. Trial→paid upgrade path with zero reinstall.

5. **Machine binding (optional, default-off for v1?).** Which STABLE, low-PII signals per OS (Win: volume serial / MachineGuid; Mac: IOPlatformUUID) — hashed, never raw, never transmitted. Activation count per license, offline deactivation/transfer flow, and the reinstall/new-machine story. Recommend whether v1 even needs binding or ships signed-file-only first.

6. **Anti-footgun (the cardinal rules).** A paying customer must NEVER lose audio: (a) verification failure or a corrupt/absent license must NOT hard-mute mid-session — define a grace/degraded state and where audio is (or isn't) affected; (b) clock change, OS reinstall, plugin update, permanently-offline machine must all keep a valid license working; (c) fail modes are gentle and recoverable, with a clear path to re-activate. Enumerate every lockout risk and its mitigation.

7. **Key management & compromise recovery (layer F).** Where the signing private key lives (offline, secure store, NEVER in repo or build — document the boundary and CI implications). Key rotation and what happens if the private key leaks (embed key-id, support multiple public keys per build, revocation posture for an offline scheme — be honest about its limits). A separate offline signing CLI (`tools/feather-license/`, NOT shipped in plugins): `feather-license keygen`, `feather-license issue --product X --type perpetual --email ...`, `feather-license inspect file.lakey`. How the web store / checkout triggers issuance and delivers the file to the buyer.

8. **Robustness of the verifier as attacker-facing input.** The license-file parser reads untrusted, possibly-malicious bytes — it must be hardened: bounded sizes, no allocations driven by file-declared lengths, total-failure-is-safe, and it must NEVER crash the plugin/host (a crash on a bad license = a crash bug in every DAW). Plan to FUZZ the parser.

9. **Uniformity & fork integration.** One shared verification module (layer C, e.g. include/cmajor/helpers/feather/cmaj_License.h) consumed identically by generated plugins AND the JIT loader. Per-product config (productId, public key id, trial length, binding on/off) flows via the patch manifest / generate step so each product is configured declaratively without code forks. One Svelte activation component (layer D) usable in any patch view: drag-a-.lakey-to-activate, status display, trial countdown, buy link, error/help states — house Svelte stack (shadcn-svelte).

10. **UX.** Unlicensed/trial/licensed launch experiences; per-OS license file location; activation by drag-drop and by file picker; every error state's copy and recovery action.

STOP after writing the doc. Present a <=25-line summary + the 3-4 decisions you need me to confirm (JUCE-framework-vs-custom, trial length + watermark, machine-binding in v1 yes/no, degraded-state audio behavior). WAIT for my approval before Phase 2.

## PHASE 2 — v1 IMPLEMENTATION (only after I approve the design)

Follow the approved design. Deliverables:
- Shared verifier (layer C): loads + verifies a signed license, exposes `isLicensed()/isTrial()/licenseInfo()/daysRemaining()`; embedded public key(s) with key-id; zero network; constant-time verify; hardened bounded parser; fail-safe degraded state per the approved anti-footgun rules.
- Offline signing CLI (`tools/feather-license/`, separate target, never linked into plugins): keygen + issue + inspect.
- Svelte activation component (layer D) wired through the existing webview message bridge (study the Unload/existing bindings and match them).
- Uniform wiring into CmajPlugin + the generated-plugin path; per-product config through the manifest/generate step. `// FEATHER:` markers; FEATHER-MODS.md rows; move the FEATHER-IDEAS licensing item to Shipped.
- Tests: verify accepts a valid license; rejects tampered/wrong-product/expired/wrong-key; trial expiry + clock-rollback logic; offline behavior; **a fuzz/malformed-input suite on the parser proving no crash**; degraded-state behavior keeps audio alive. Use a THROWAWAY keypair in a temp dir. NEVER commit private keys (.gitignore already guards *.lekey-private / signing-key* / *.pem — extend if your format differs; grep the final diff to confirm no secret material).

Phase-2 gates: cmaj + CmajPlugin_VST3 clean build; pluginval strictness 8 FULL passes in BOTH licensed and trial states (a crash here = fail); license test + fuzz suite pass; existing feather smokes (sidechain_smoke, mono_upmix_smoke, loader-state probe) still pass; embedded regen idempotent; diff contains zero secret material.

Throughout: security correctness over speed; the signing-key boundary is sacred; a bad license file must never crash a DAW; paying-customer lockout is the cardinal sin. Design -> docs/Cmaj Licensing.md; implementation report -> .feather/reports/licensing-v1.md.
