# Pitched polyphonic playback

Tonal mode turns the loaded model into a pitched instrument.
Each note has its own model clock, phase state, and release state.
Up to eight notes can play at once.
Their outputs add before the shared effect rack.

## What makes the pitch

MIDI note 69 sets the fundamental frequency to 440 Hz.
Each semitone multiplies that frequency by `2^(1/12)`.
The renderer creates a bank of harmonics above that fundamental.
The loaded model sets each harmonic's level.
This gives the instrument a stable pitch while keeping the model's changing tone.

The port uses all twelve Visco oscillator shapes.
Each shape supplies spacing and level tables for up to 512 partials.
These tables contain coefficients, not recorded audio.
The model changes each partial's level before output reconstruction.
The renderer uses a 256-sample transform and a 64-sample step.
It places each harmonic between two adjacent frequency bins.
Its frequency limit includes the model's upper boundary band.

## What the shapes change

| Shape | Pattern |
|---|---|
| Saw | Every whole-number harmonic |
| Square | Odd-numbered harmonics |
| Pulse1, Pulse2 | Full harmonic series with signed level patterns |
| Octaves | Frequency doubles between partials |
| Fibonacci | Frequency steps follow a Fibonacci sequence |
| Metallic | Unequal frequency steps and levels |
| RoundRobin | Frequency steps cycle through three sizes |
| DrawBar | Grouped frequency steps with small offsets |
| Sevenths | Frequency steps grow by a musical interval |
| MajorChord, MinorChord | Interleaved harmonic series based on chord intervals |

## What Stretch changes

Stretch changes each spacing step before frequency accumulation.
Its curve grows with the square of the control amount.
Positive values make later steps wider.
Negative values make later steps narrower.
Negative values also limit the partial count before the steps reverse direction.
Visco adjusts the base frequency as part of this operation.
Stretch can therefore change the lowest partial's pitch too.
The model follows the same spacing curve through its frequency map.

## Why the sound can sustain

Sustain position selects a time in the model.
The model clock stops there while the key remains held.
The oscillator phases keep moving.
This holds the tone without repeating the original attack.
If the sound finishes before that position, the note can finish first.

Release resumes the model clock after note-off.
A curved fade reduces the band levels until the voice stops.
The sustain pedal postpones this release.

## Why voice state matters

Free voices receive new notes first.
When all voices are busy, this mode replaces the oldest voice.
Existing overlap samples carry the previous note through its last frame.
The small unison modulation keeps its phase when a voice receives another note.
All tonal voices share Visco's modulation random sequence.
Effects keep running after notes end.

## Controls and scope

The patch exposes oscillator shape, Stretch, voice count, release, sustain position, key tracking, and pitch-bend range.
MIDI notes and note-off messages use their own channels.
The patch also handles velocity-zero note-on, sustain, All Notes Off, and All Sound Off.
The Stop notes button clears the voice buffers.

Unison and Damping stay at zero.
Zero Unison still has a small modulation in Visco.
Glide and legato remain outside this implementation.
The native comparisons use a controlled initial random state.

## Checks

`polyphony-tests.mjs` compares single notes, chords, and overlapping notes against native Visco recordings.
The tested rates are 44.1, 48, and 96 kHz.
Separate checks cover pedal hold, channel handling, pitch bend, voice replacement, and Stop notes.
All 14 native comparisons and six MIDI behavior checks pass.
`native-polyphony-tests.mjs` checks the native Cmajor renderer.
These checks do not include a complete Ableton device chain.

The implementation is in `MorphVoice.cmajor` and `MorphFieldExact.cmajor`.
The saved cases are listed in `fixtures/polyphony/reference.json`.
Shape and Stretch cases are listed in `fixtures/oscillators/reference.json`.
Run both test scripts with `oscillators` to check those cases.

All 90 shape and Stretch comparisons pass.
They cover twelve shapes, three rates, control extremes, and changes during playback.
The tests compare the native reference without a gain fit or signal shift.
