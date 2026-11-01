Open `MorphFieldExact.cmajorpatch` in Cmajor.
Load a WAV file or Visco `.blob` file into A or B.
Move Morph to blend the two models.
Use Play or MIDI to trigger a hit.
Level starts at 0 dB.
For direct listening, set Level to -12 dB to leave room for peaks.

This patch implements the traced Visco 2.0.3 import, morph, sound generator, and limiter.
It covers neutral playback with one voice.
Runtime uses Cmajor and local JavaScript files.

The generator uses three time frames to calculate tone, noise, and attack phases.
It solves phase relationships between nearby bands.
It then reconstructs the waveform with a 256-sample transform and a 64-sample step.
The clock, noise sequence, filter, gain, and repeat behavior follow the native reference.

Four raw WAV tests match every model coordinate and every byte in Visco's saved model format.
Four UI import tests also match the model loaded from Visco's saved file.
Twenty audio tests cover drums, clicks, morph changes, repeat hits, velocity, limiting, and a six-second tail.
They cover 44.1, 48, and 96 kHz playback.
The largest sample error was 0.0000038147.
The waveform transform still has small float rounding differences.
The patch and reference tests use random seed 2345.
These checks do not prove identical results for every possible input.

Version 1.0.2 adds Visco's Limiter from the Main FX menu.
Limiter starts off.
Enable Limiter to compare its sound.
Set Level to 0 dB for the native reference setting.
Set Limiter Gain to 0 dB.
Set Limiter Speed to 50%.
Match these controls in Visco.

Level feeds the limiter.
Limiter Gain ranges from 0 to 48 dB.
Limiter Speed ranges from 0 to 100%.
The limiter links both channels and uses two gain states.
It has no lookahead delay.
Its soft ceiling is near -0.2 dBFS.
The gain states continue between hits.
The bypass switch acts immediately; Visco's effect switch fade is not included.

Five isolated limiter tests match every native sample, including unequal stereo inputs.
Full kick renders with the limiter match within about 129 dB at 44.1 and 48 kHz.
The native Cmajor build passes the same checks.
At Gain 0 and Speed 50, the Phase kick's first 2 ms stay unchanged.
The 20–50 ms section falls by about 6 dB.
This changes the balance between the attack and body.
See `limiter-verification.html` for the limiter comparison.
The limiter audio examples in `verification` have equal peak levels for listening.
These examples do not change the patch's output gain.
The current Ableton device chain has not been recorded for a separate null test.

WAV import now follows Visco's full UI path.
It analyzes the WAV, rounds the model into `.blob` data, then decodes that data for playback.
The first release skipped that rounding step.
The Phase kick exposed a 1 dB attack difference between 1 and 2 ms.
Version 1.0.1 corrects this difference.
Reload the patch, then load previously imported WAV files again.
Existing saved states keep their old model data until you reload the WAV.

The earlier raw analysis tests compared an internal stage before Visco's save-and-reload step.
The new UI tests compare the full import and worker path against native saved-model playback.
See `verification.html` for the Phase kick null test.
The null residual fell from -32.4 dB to -129.3 dB relative to Visco at 44.1 kHz.
The test uses the same random seed and neutral controls.
It applies no time shift or gain adjustment before subtraction.
The two listening renders in `verification` use equal -12 dB gain.
The null recordings use equal +24 dB gain for listening.
Files ending in `-raw.wav` contain the null signal without added gain.

Import remains slower than native Visco.
Recent Node tests took about 90 to 320 ms for short files.
The six-second file took about 850 ms.
Native WebView model transfer took 17 ms in the first check.

Run `node tests.mjs` for the import and audio comparisons.
Run `node limiter-tests.mjs` for the isolated limiter comparisons.
Run `node validate-worker.mjs` for the native WebView transfer check.
The tests write results to `test-results.json` and `worker-test-results.json`.
The reference audio came from the installed Visco binary in a separate test process.
Its SHA-256 is stored in `fixtures/reference.json`.

The FFT port includes PFFFT and FFTPACK notices in `FFT-LICENSE.txt`.
The data tables came from the installed Visco binary.
