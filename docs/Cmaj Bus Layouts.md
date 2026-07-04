# Cmajor Bus Layouts

Internal notes for Lost Audio's Feather bus and sidechain fork. This covers the code contract, wrapper behavior, and the regression gate we rely on.

## Ground Truth Files

- Shared interpretation: `include/cmajor/helpers/cmaj_AudioBusLayoutHelper.h`
- JUCE wrapper: `include/cmajor/helpers/cmaj_JUCEPlugin.h`
- CLAP wrapper: `modules/plugin/include/clap/cmaj_CLAPPlugin.h`
- Dev-time player: `modules/playback/include/cmaj_PatchPlayer.h`
- Fixtures and smoke tests: `examples/patches/SidechainDuck`, `tests/feather/sidechain_smoke.py`,
  `examples/patches/HelloWorld`, `tests/feather/mono_upmix_smoke.py`

## Endpoint Annotation Contract

Bus layout is driven by annotations on audio stream endpoints:

```cmajor
input stream float32<2> mainIn    [[ name: "Main Input", bus: "Input", role: "main" ]];
input stream float32<2> sidechain [[ name: "Sidechain Input", bus: "Sidechain", role: "sidechain" ]];
output stream float32<2> out      [[ name: "Output", bus: "Output", role: "main" ]];
```

This exact shape is used by `examples/patches/SidechainDuck/SidechainDuck.cmajor`.

The supported roles in `cmaj_AudioBusLayoutHelper.h` are:

- `main`
- `sidechain`
- `sideChain` as a compatibility spelling for `sidechain`
- `aux`
- omitted/unknown

`bus` is the display/grouping name. Endpoints with the same bus name are grouped into one bus. If no audio endpoint in a list has `bus` or `role`, all audio endpoints collapse into the old default bus named `in` or `out`.

If `bus` is omitted but `role` is present, defaults are:

- `role: "main"` -> `Input` for inputs, `Output` for outputs
- `role: "sidechain"` or `role: "aux"` -> `Sidechain`

Channel count comes from the endpoint stream type. `EndpointDetails::getNumAudioChannels()` in `include/cmajor/API/cmaj_Endpoints.h` returns `1` for a float stream and the vector size for a float vector stream, for example `float32<2>` is stereo.

One further annotation controls channel-count adaptation (see the Channel Adaptation section):

```cmajor
output stream float out [[ name: "Out", channelMode: "strict" ]];
```

`channelMode: "strict"` opts a main-bus endpoint out of adaptation, so its bus group requires an exact host channel-count match. Any other value (or omitting it) leaves main buses adaptive. Aux/sidechain buses are always strict regardless of this annotation.

## Shared Grouping Semantics

`groupEndpointsByBus()` in `cmaj_AudioBusLayoutHelper.h` skips non-audio endpoints, preserves declaration order, and accumulates channel counts for endpoints sharing a bus name.

Main-bus detection is deliberately conservative:

- A bus with role `sidechain` or `aux` is not main.
- A bus named `Sidechain` is treated as auxiliary.
- Otherwise, role `main` or the first bus is main.

This matters because wrappers allow disabled auxiliary buses but keep main buses strict.

## JUCE And Generated JUCE

`cmaj_JUCEPlugin.h` uses the shared helper in `addEndpointAudioBuses()` and `updateCachedAudioBusLayoutFromPatch()`. Generated JUCE projects inherit this because their generated `CMakeLists.txt` includes the same helper chain; see `tools/command/Source/cmaj_command_GeneratePlugin.h`.

JUCE layout validation accepts a zero-channel suggested layout for non-main buses. The comment in `isLayoutOK()` states the intent: disabled auxiliary/sidechain inputs are silence-backed and disabled auxiliary outputs are routed to discard scratch buffers.

Processing prepares the patch for the full declared patch bus shape even if the host disables an auxiliary bus. `getPlaybackParams()` uses cached patch channel counts when loaded, and `refreshAudioChannelPointers()` fills missing input bus channels from `inputSilentBusScratch` and missing output channels from `outputDisabledBusScratch`.

Dynamic patch-loader caveat: `JITLoaderPlugin::getBusLayout()` is fixed at construction as stereo `Input`, optional stereo `Sidechain`, and stereo `Output`. On patch load, the wrapper derives endpoint groups with `cmaj_AudioBusLayoutHelper.h` and maps the first aux/sidechain input group onto the predeclared sidechain bus. If there is no aux input group, the sidechain bus remains unused; if there are multiple aux input groups, only the first is mapped and the rest are silence-backed with a console warning. More exotic input or output layouts still need `SinglePatchJITPlugin`/generated plugins so their bus shape is known at construction.

`SinglePatchJITPlugin` preloads the manifest and derives bus properties at construction. `GeneratedPlugin` derives bus layout from generated `programDetailsJSON`, so fixed-patch/generated plugins are the right path for product validation.

## CLAP

`modules/plugin/include/clap/cmaj_CLAPPlugin.h` builds `inputAudioBusGroups` and `outputAudioBusGroups` with the shared helper. It exposes one CLAP audio port per bus group, not one port per endpoint. Only buses considered main by `isMainBus()` get `CLAP_AUDIO_PORT_IS_MAIN`.

During process, CLAP flattens active host ports into the declared Cmajor bus shape. Missing input ports/channels are fed from cleared scratch, and missing output ports/channels are rendered into scratch and discarded. See the comments around `toInputChannelArrayView()` and `toOutputChannelArrayView()`.

## Dev-Time Player

`PatchPlayer` does not expose named buses to the OS audio device. Its comment in `modules/playback/include/cmaj_PatchPlayer.h` documents a flat channel mapping:

- bus groups consume input channels in declaration order,
- main/default comes first,
- aux/sidechain groups take remaining input channels,
- outputs are flattened back in the same bus-group order.

This is why the smoke test can feed a four-channel WAV: channels 1-2 are main, channels 3-4 are sidechain for `SidechainDuck`.

## Channel Adaptation

Main bus groups adapt mismatched host channel counts by default. This restores the
behaviour that upstream implemented in `cmaj::Patch::connectPerformerEndpoints()`
(the "Handle mono -> stereo as a special case" block plus the mono-device
replication/summing paths in `cmaj_AudioMIDIPerformer.h`) before the fork's per-bus
mapping bypassed it by preparing the patch with its own exact channel counts. The
user-visible regression this fixes: a mono patch (for example the stock SineSynth)
loaded into the dynamic JIT loader's stereo output bus played hard-left, because its
single output channel mapped to bus channel 0 and channel 1 stayed silent.

The convention deliberately matches upstream's old device-channel adaptation:

- Mono endpoint group into a wider host bus: the single channel is replicated to
  every host bus channel after processing. (Upstream replicated a total-mono output
  to device channels 0 and 1; the fork generalises this to all bus channels.)
- Multi-channel endpoint group into a mono host bus: outputs are folded down by
  unscaled summing (upstream mapped every endpoint channel onto device channel 0,
  where the performer overwrote with the first and added the rest); a mono host
  input is replicated into every input endpoint channel by pointer replication.
- Host bus wider than a multi-channel endpoint group (partial fill): inputs take
  the first N host channels and ignore the rest; the extra output host channels are
  cleared so hosts never see stale buffer garbage. Upstream did not replicate or
  average in this case either (its adaptation only special-cased mono), so no
  averaging/1-over-N downmix was introduced - matching old renders bit-for-bit
  matters more than inventing a nicer downmix.

Rules and scope:

- Only main bus groups adapt. Aux/sidechain groups keep strict, silence-backed
  semantics exactly as before.
- `channelMode: "strict"` on any endpoint in a main group makes the whole group
  strict (exact channel-count match required, as for aux buses).
- When endpoint and host channel counts are equal, none of the adaptation branches
  run and produced audio is bit-identical to the pre-adaptation code.
- Everything is planned against the cached bus-group mappings: input adaptation is
  pure pointer replication, output adaptation copies/sums/clears host channels after
  `patch->process()` using the pre-mapped pointer tables and pre-sized scratch. No
  locks and no heap allocation on the audio path.

Implementation points: `shouldAdaptChannels()` in `cmaj_AudioBusLayoutHelper.h`;
`isLayoutOK()`, `mapInputGroups()` (inside `refreshAudioChannelPointers()`) and
`applyOutputBusChannelAdaptation()` in `cmaj_JUCEPlugin.h` (shared by the dynamic
loader and the fixed/generated `isFixedPatch` paths); `toInputChannelArrayView()`
and the output adaptation block in `clapPlugin_process()` in `cmaj_CLAPPlugin.h`.

The dev-time player and `cmaj render` do not use the wrapper mapping: they pass real
device/file channel counts into `cmaj::Patch`, whose upstream adaptation code is
unchanged, so they already had (and keep) the mono -> stereo behaviour. That path is
pinned by `tests/feather/mono_upmix_smoke.py`.

## Disabled Or Missing Buses

The fork's desired semantics are:

- Main buses adapt mismatched host channel counts (see Channel Adaptation);
  `channelMode: "strict"` groups must match their declared channel count exactly.
- Disabled/missing sidechain or aux inputs read silence.
- Disabled/missing aux outputs are discarded.
- A missing sidechain should not produce null reads or garbage detector input.

This is code-backed for JUCE and CLAP scratch paths, and covered in the dev-time flat-channel path by the smoke test. It is not a substitute for DAW/plugin-format checks.

## DAW Routing Notes

These steps are operational notes, not repo-verifiable code claims.

Ableton Live VST3:

1. Put the generated VST3 on the track that should be processed.
2. Open the sidechain section in the device header.
3. Enable sidechain and choose the source track.
4. Use the patch's meter/debug build or audio result to confirm the sidechain bus is not silent.

Logic AU:

1. Use the generated AU on an audio or instrument channel strip.
2. Pick the source from Logic's Side Chain menu in the plugin header.
3. Logic routes that source to the AU sidechain bus; confirm with a patch like `SidechainDuck`.

Reaper pin mapper:

1. Put the plugin on a track with at least four track channels.
2. Open the plugin pin connector.
3. Map track channels 1/2 to the main input and 3/4 to the sidechain input.
4. For CLAP, verify the listed audio ports are `Input`, `Sidechain`, and `Output`.

Bitwig CLAP:

1. Prefer CLAP when validating the CLAP wrapper path.
2. Add the plugin, expose its sidechain/audio input routing in Bitwig's device inspector.
3. Route a source into the sidechain input and confirm ducking/meter response.

## Regression Gate

`tests/feather/sidechain_smoke.py` is the primary automated gate. It:

- renders `examples/patches/SidechainDuck/SidechainDuck.cmajorpatch`,
- creates a pulsed four-channel input, a silent four-channel input, and a two-channel main-only input,
- asserts the missing-sidechain render matches the silent-sidechain render,
- asserts sidechain pulses produce a meaningful RMS dip.

Coverage limits are explicit in the script docstring: it covers the `cmaj render`/player flat-channel path and missing sidechain silence. It does not cover JUCE disabled-bus negotiation or CLAP missing-port processing; those still need pluginval and DAW checks.

`tests/feather/mono_upmix_smoke.py` guards the mono-output adaptation convention. It renders `examples/patches/HelloWorld` (mono `output stream float out`) at `--channels=2` and asserts both output channels are bit-identical and non-silent. It covers the render/player path; the JUCE dynamic-loader fix (the Bitwig hard-left SineSynth report) still needs a DAW or pluginval check because the plugin wrappers have no CLI harness.

## Authoring Checklist

- Annotate every audio endpoint that participates in multi-bus routing.
- Use stable bus names: `Input`, `Sidechain`, `Output` unless a product needs more.
- Keep sidechain endpoints as streams, usually `float32<2>`.
- The dynamic loader can hot-swap between patches with no aux input and one aux/sidechain input; use fixed/generated plugins for more bus groups or product validation.
- Validate `SidechainDuck` after changing endpoint metadata, wrappers, or generated plugin helpers.
