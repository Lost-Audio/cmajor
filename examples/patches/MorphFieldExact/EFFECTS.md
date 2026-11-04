The effect bank follows Visco 2.0.3.
Each address below is relative to the loaded binary's base address.

| Effect | Process address | Main method |
|---|---|---|
| Chorus | `0xdfa50` | Two moving delays, two allpass filters, and three stereo mixing stages |
| Diffuser | `0xe0d90` | Predelay and eight stereo delay stages |
| Plate Reverb | `0xe15f0` | Four feedback paths, eight delay stages, and a four-way feedback matrix |
| Room Reverb | `0xe1420`, `0xe2360` | Moving feedback delays, six stereo stages, six allpass filters, and tone filters |
| Spring Reverb | `0xe2c80`, `0xd9c00` | Separate delays for frequency bands, feedback, saturation, and allpass filters |
| Tempo Delay | `0xe01a0` | Two adjacent tempo divisions, moving read positions, filtering, and saturated feedback |
| Compressor | `0xdcfe0` | Linked peak detection, logarithmic gain smoothing, and soft saturation |
| Stereo Fuzz | `0xdd370` | Moving filter coefficients and different positive and negative distortion curves |
| Sticky Compressor | `0xdae20` | Gain-dependent threshold, logarithmic smoothing, and soft saturation |
| L.A. Optical | `0xdb9c0` | Unequal positive and negative detection with two gain states |
| Upward Compressor | `0xdc9e0` | Peak hold, upward gain control, and an instantaneous gain limit |
| Limiter | `0xdb1e0` | Two linked gain states and a curved ceiling |
| Tape Simulator | `0xdc120` | Moving shelves, nonlinear transfer, and local gain control |
| Transformer Amp | `0xdcd60` | Bias-dependent distortion, separate channel states, and soft saturation |

Parameter names, limits, and defaults are stored in `effect-definitions.js`.
These values came from the native effect descriptors.

The shared delay reader uses cubic interpolation.
Its read speed moves toward the requested delay.
The speed changes at block boundaries.
Preserving float operation order matters at high sample rates.

The stereo delay stage stores the right input.
It reads one delayed value, `d`.
Its outputs are `(left + d) / sqrt(2)` and `(left - d) / sqrt(2)`.
This spreads energy between channels without a separate left delay in each stage.

Chorus and Tempo Delay use 32-sample internal steps.
Diffuser uses 16-sample steps.
The other moving effects use 64-sample steps.
These clocks continue between notes.

Spring Reverb uses a 256-sample transform and a 64-sample step.
Each frequency band reads a different frame from spectral history.
Two complex weights blend adjacent history frames.
The weights include phase correction.
This produces frequency-dependent travel time before the feedback loop.
The six common sample rates use captured initializer coefficients.
The coefficient tables contain no source audio.
Other rates use the traced initializer formulas.

The tape random sequence uses `state = 1664525 * state + 1013904223`, modulo `2^32`.
Both main slots share this sequence.
Each channel has two smooth random controls.
One changes the shelf frequency.
The other changes its color.

Room reset uses a separate random sequence.
It uses `state = 214013 * state + 2531011`, modulo `2^32`.
The phase is `((state >> 16) & 32767) / 32767`.
Both send slots share this sequence.
The native comparison controls this random stream.

The wrapper at `0x61210` fades effect switches.
Each sample changes the wet amount by at most `300 / (sampleRate + 1)`.
The wrapper calculates that change for each 64-sample block.
It snaps to the target when the remaining difference falls below `0.0001`.
Send slots fade their return.
Main slots blend the dry and processed signals.

Native startup visits enabled wrappers with a zero-length block.
That visit resets an enabled effect without advancing its fade.
The first real block resets it again.
This consumes two room random values during enabled startup.
Morph Field follows this sequence.

The native room filter stops processing at some Color settings.
Its damping control falls below the function's active range.
The port preserves this branch.

The limiter adds no lookahead delay.
It does not preserve or restore a separate transient sample.
The complete chains use the same reconstructed attack as the neutral generator.

The tests fix synthesis and tape seeds at 2345.
The room reset stream starts at 1.
The native room reset hook changes only that random stream.
The original DSP functions produce the reference audio.
Installed Visco can start from different random states.

`fixtures/effects/reference.json` lists 115 isolated effect cases.
`fixtures/effects/rack-reference.json` lists four complete native chains.
`fixtures/effects/bypass-reference.json` lists two switch tests.
The compressed reference files preserve every float sample.
The inputs are synthetic signals, except for the Phase kick used in complete chains.

The tests do not cover every possible sequence of effect type changes.
They do not cover every supported Cmajor host.
The recorded limits describe these inputs and settings only.
