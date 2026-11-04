Open `MorphFieldExact.cmajorpatch` in Cmajor.
Reload the patch after this update.
Load a WAV or Visco `.blob` file into each source.
Move Morph to blend the sounds.
Use Play or MIDI to trigger a hit.

Version 1.3.0 adds twelve oscillator shapes and harmonic Stretch.
Pitched playback supports up to eight voices.
Enable Tonal mode to play chords.
Drum mode keeps the earlier single-voice behavior.

| Control | What it does | Why it helps |
|---|---|---|
| Voices | Sets the limit from one to eight | Allows chords or overlapping notes |
| Oscillator | Selects one of twelve harmonic patterns | Changes the pitched sound's character |
| Stretch | Changes the spacing between partials | Creates compressed or expanded frequency patterns |
| Release | Sets the fade after note-off | Controls how notes end |
| Sustain position | Holds a point in the loaded sound | Makes a short sound sustain |
| Key track | Changes how the model follows pitch | Controls tone across the keyboard |
| Pitch bend | Sets the wheel range in semitones | Allows pitch slides |
| Stop notes | Clears all voices | Stops held notes |

The sustain pedal uses MIDI controller 64.
MIDI note-off affects matching notes on the same channel.
The on-screen keyboard spans one chromatic octave.
Play previews C4 for 400 milliseconds in Tonal mode.
An earlier sustain position often holds a stronger part of a drum.
Level controls the combined voices before the shared effects.

The tonal renderer follows Visco's twelve oscillator shapes.
Stretch spans the native range from -100 to 100.
Unison and Damping stay at zero.
Visco keeps a small modulation even at zero Unison.
Glide and legato are not implemented.
See `TONAL.md` for methods and test scope.

Version 1.1.0 adds all 13 remaining effects from Visco's send and main menus.
The patch now contains all 14 effect types.
It has two parallel sends and two main slots in series.
All four slots start off.

Select an effect in a slot.
Enable its On switch.
Raise Send to hear a send effect.
Main 1 starts with Tape Simulator selected.
Main 2 starts with Limiter selected.
Tempo follows the host.
Use the Tempo control during standalone playback.

| Send effects | Main effects |
|---|---|
| Chorus | Sticky Compressor |
| Diffuser | L.A. Optical |
| Plate Reverb | Upward Compressor |
| Room Reverb | Limiter |
| Spring Reverb | Tape Simulator |
| Tempo Delay | Transformer Amp |
| Compressor | |
| Stereo Fuzz | |

Level feeds both send paths and the dry path.
The send returns add to the dry signal.
Main 1 processes this sum.
Main 2 follows Main 1.
Each effect keeps its state between drum hits.
The effect switches use Visco's fade.
The two tape slots share one random sequence.
The room effects share a separate random sequence.

The previous limiter controls remain available for saved sessions.
That limiter follows Main 2.
Its controls open automatically when it is on.
Turn it off when comparing Main 2 against one Visco limiter.
Its old bypass behavior remains compatible with version 1.0.2.

The patch uses the traced Visco 2.0.3 import, morph, and neutral sound generator.
WAV import includes Visco's save-and-reload rounding step.
The generator uses 256-sample transforms with 64-sample steps.
Track Filter, Clip, and Width remain outside this patch's verified scope.
Runtime needs Cmajor and the local JavaScript files.
It does not load the Visco binary.

115 isolated effect tests pass against native Visco output.
73 cases match every sample.
The other cases have small float differences.
The largest residual is 104.0 dB below the reference.
Tests cover control extremes, automation, stereo inputs, impulses, tones, noise, and silence.
All effects have references at 44.1, 48, and 96 kHz.
Spring tests also cover 88.2, 176.4, and 192 kHz.
Other rates use the traced spring formulas.

Four complete effect chains pass with the supplied Phase kick at 48 kHz.
Their residuals are 125.7 to 131.9 dB below Visco.
Native Cmajor and WebAssembly give equal results in these chain tests.
The tests apply no signal shift or gain fit.
The native test removes the CLI's startup silence.
Two bypass tests match every sample through repeated on and off changes.
Twenty existing sound generator tests still pass.
All eight import tests still pass.

The native references use controlled random states.
The room reference supplies a fixed random stream during reset.
A normal Visco session can use a different starting state.
These checks do not prove every possible setting or DAW chain matches.
The full Ableton device chain has not been recorded for a separate comparison.

See `EFFECTS.md` for the traced algorithms and addresses.
See `effects-verification.html` for the test report.
The earlier reports remain available in `verification.html` and `limiter-verification.html`.

Run these checks from this folder:

```text
node tests.mjs
node effects-tests.mjs
node rack-tests.mjs
node native-rack-tests.mjs
node bypass-tests.mjs
node limiter-tests.mjs
node validate-worker.mjs
node validate-effects-view.mjs
node polyphony-tests.mjs
node native-polyphony-tests.mjs
node polyphony-tests.mjs oscillators
node native-polyphony-tests.mjs oscillators
```

The tests save logs and generated files in `test-artifacts`.
Native reference audio is stored in `fixtures`.
The native view check verifies effect menus, controls, saved values, and host tempo.
The import worker check verifies both model uploads.

The reference binary is Visco 2.0.3.
Its SHA-256 is `0510AB34128AAA53288D9428AA9C1DA0820F208AFC8CDB311EAAE575CF197F9B`.
The test harness loads a checked copy in a separate process.
It does not change the installed file.
The FFT port includes PFFFT and FFTPACK notices in `FFT-LICENSE.txt`.
The model tables and spring coefficients came from the native reference.
