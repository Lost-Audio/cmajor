# Cmajor Bundle Sampling

Internal notes for packaging sample data into Cmajor patches, and for writing small sample players in Cmajor. This is aimed at Lost Audio patch work, not public API prose.

## Ground Truth Files

- Patch manifest external mapping: `include/cmajor/helpers/cmaj_PatchManifest.h`
- External variable coercion and annotations: `modules/compiler/src/AST/cmaj_AST_Externals.h`, `include/cmajor/API/cmaj_ExternalVariables.h`
- Generated plugin resource embedding: `tools/command/Source/cmaj_command_GeneratePlugin.h`, `tools/command/Source/cmaj_command_GenerateHelpers.h`, `include/cmajor/helpers/cmaj_JUCEPlugin.h`
- Standard sample data/player types: `standard_library/std_library_audio_data.cmajor`
- Examples: `examples/patches/Piano`, `examples/patches/ConvolutionReverb`

## Packaging Samples

Audio samples are normally supplied through `external` variables. The manifest `externals` object maps a fully-qualified Cmajor external name to JSON data. For a processor-local external, the key is `ProcessorName::varName`; the convolution example uses:

```json
"externals": {
    "ImpulseSource::reverb": "impulse.wav"
}
```

That maps to `external float[] reverb;` in `examples/patches/ConvolutionReverb/reverb.cmajor`. The manifest is `examples/patches/ConvolutionReverb/reverb.cmajorpatch`.

For namespaced data, use the namespace-qualified name. The Piano example declares `external PianoSample[5] samples;` inside `namespace piano`, so the manifest key is `piano::samples` in `examples/patches/Piano/Piano.cmajorpatch`.

The Piano pattern is the best starting point for bundled instruments:

```cmajor
struct PianoSample
{
    std::audio_data::Mono source;
    int rootNote;
}

external PianoSample[5] samples;
```

```json
"externals": {
    "piano::samples": [
        { "source": "piano_36.ogg", "rootNote": 36 },
        { "source": "piano_48.ogg", "rootNote": 48 }
    ]
}
```

The loader walks strings in the manifest external value and tries to decode them as patch-relative audio files. This is implemented by `replaceFilenameStringsWithAudioData()` and `readManifestResourceAsAudioData()` in `include/cmajor/helpers/cmaj_PatchManifest.h`. It supports Ogg, MP3, FLAC, and WAV via the CHOC format list in that file.

The external resolver receives the target external's annotation and type. Audio data is then duck-typed into the target Cmajor shape by `coerceAudioDataToType()` in `modules/compiler/src/AST/cmaj_AST_Externals.h`. The standard library types are simple structs in `standard_library/std_library_audio_data.cmajor`:

- `std::audio_data::Mono`: `const float[] frames`, `float64 sampleRate`
- `std::audio_data::Stereo`: `const float<2>[] frames`, `float64 sampleRate`

Raw arrays also work. `external float[] reverb;` in `ConvolutionReverb` receives only frames; sample rate is discarded because there is no member to receive it.

## External Annotations

For audio-file externals, `include/cmajor/API/cmaj_ExternalVariables.h` shows two annotation properties used while reading audio:

- `resample`: target sample rate for file loading.
- `sourceChannel`: zero-based channel to extract as mono.

Example shape:

```cmajor
external std::audio_data::Mono kick [[ resample: 48000, sourceChannel: 0 ]];
```

The compiler also has annotation-generated external data in `modules/compiler/src/AST/cmaj_AST_Externals.h`. Observed flags/properties are:

- Wave flags: `sine`, `sinewave`, `square`, `squarewave`, `saw`, `sawtooth`, `triangle`
- Required for generated waves: `frequency`, `rate`, and `frames` or `numFrames`
- `default`: a constant annotation value used when no manifest value is provided

Those wave/default annotations are useful for tests and tables, but for product samples prefer explicit files in `.cmajorpatch`.

## Exported Plugins

`cmaj generate` resolves externals before C++ code generation. `Patch::generateCode()` builds with `shouldResolveExternals = true` in `include/cmajor/helpers/cmaj_Patch.h`, which calls `manifest.createExternalResolverFunction()`. The C++ backend then emits resolved constants into the generated performer; large aggregate constants are written as global constant arrays in `modules/compiler/src/backends/CPlusPlus/cmaj_CPlusPlusGenerator.cpp`.

For generated JUCE and CLAP projects, `generateMainClass()` in `tools/command/Source/cmaj_command_GeneratePlugin.h`:

- calls C++ codegen for the performer,
- adds patch resources with `GeneratedFiles::addPatchResources()`,
- embeds the stripped manifest with `manifest.getStrippedManifest()`, which removes `externals`,
- emits a `PatchClass::files` array containing embedded file contents.

At runtime, generated JUCE plugins initialise the manifest from that in-memory file array in `include/cmajor/helpers/cmaj_JUCEPlugin.h`. CLAP generated plugins use `createGeneratedCppEnvironment()` and the same generated file array path through `include/cmajor/helpers/cmaj_PluginHelpers.h`.

Practical implication: sample data used as externals is compiled into the generated performer, not looked up as loose audio files by the shipped plugin. Files listed in manifest `resources`, view folders, and workers are separately embedded for GUI/worker/resource reads by `GeneratedFiles::addPatchResources()` in `tools/command/Source/cmaj_command_GenerateHelpers.h`.

## Sampler Techniques

`std::audio_data::SamplePlayer` in `standard_library/std_library_audio_data.cmajor` is a small, useful primitive:

- `content` event starts a new sample from the beginning.
- `speedRatio` controls playback rate; `0` stops.
- `shouldLoop` toggles wraparound when the end is reached.
- `position` sets the current frame index.
- Playback uses `frames.readLinearInterpolated(currentIndex)`.

The Piano example wraps this with a voice allocator and a `NoteSelector`. `NoteSelector` selects the nearest root sample and uses `std::notes::getSpeedRatioBetween()` to pitch-shift it.

For velocity layers, extend the Piano struct:

```cmajor
struct Layer
{
    std::audio_data::Mono source;
    int rootNote;
    float minVelocity;
    float maxVelocity;
}
```

Then filter candidate samples by `std::notes::NoteOn.velocity` before choosing the nearest `rootNote`. Keep the JSON as an array of objects with `"source": "file.wav"` plus metadata.

For round-robin, add a group/index field to the sample metadata and keep a small wrap counter in the note selector or voice allocator path. Choose the next sample among candidates that match note and velocity. Avoid random selection if repeatability matters for tests.

For looping, either use `std::audio_data::SamplePlayer.shouldLoop`, or write a custom player if you need loop start/end points or crossfades. The stock player loops the entire `frames` array and only subtracts `frames.size` once when the index passes the end, so keep speed ratios sane.

For pitch interpolation, the stock path is linear interpolation. That is fine for short one-shots and lo-fi instruments. For exposed/pitched content, consider:

- More root notes to reduce pitch distance.
- Pre-rendered velocity/root layers.
- A custom interpolator if linear interpolation is audible.

For memory budgeting, treat externals as compile-time constants once exported. A mono `float` frame costs roughly 4 bytes; stereo `float<2>` costs roughly 8 bytes before C++ compiler/object overhead. Because generated plugins bake external sample data into the binary, large libraries should be trimmed, looped, compressed at source only as a packaging convenience, or moved out of the external path if they need runtime streaming. The current standard loader decodes supported audio files to float frame arrays before they reach Cmajor.

## Minimal Checklist

- Put sample files beside the `.cmajorpatch` or in a predictable subfolder.
- Declare a typed external in Cmajor.
- Map the fully-qualified external name in manifest `externals`.
- Use `std::audio_data::Mono`/`Stereo` when sample rate matters.
- Add metadata fields such as `rootNote`, velocity bounds, and round-robin group in the same struct.
- Use the Piano example for pitched one-shots and ConvolutionReverb for raw array audio data.
