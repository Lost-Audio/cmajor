
/*
    A drum-designer GUI for the DrumSynth patch.

    The kick, snare and clap each get a module with knobs for every parameter, a pad
    (and keyboard key) to audition the sound, and a screen showing a preview of the
    waveform the patch will produce. The kick also has a shape editor (the pen button)
    where its amp and pitch envelopes can be drawn as curves.

    Parameter ranges, defaults and units are read from the patch's own annotations,
    so this file only needs to know which endpoints go where.
*/

const sections = [
    {
        id: "kick", title: "Kick", note: 36, key: "a", colour: "#f26b21", hasShapeEditor: true, headMode: "kickModel",
        groups: [
            { model: "909",    label: "909",   columns: 5, isLarge: true, params: [["kick909Tune", "Tune"], ["kick909Attack", "Attack"], ["kick909Decay", "Decay"], ["kickLevel", "Level"]] },
            { model: "909",    label: "Voice", columns: 6, params: [["kickKey", "Key"], ["kick909Snap", "Snap"], ["kick909Shape", "Shape"], ["kick909Drive", "Drive"], ["kick909Hold", "Hold"], ["kick909Click", "Click"]] },
            { model: "custom", label: "Body",  columns: 5, params: [["kickKey", "Key"], ["kickSweep", "Sweep"], ["kickSweepTime", "Glide"], ["kickDecay", "Decay"], ["kickDrive", "Drive"]] },
            { model: "custom", label: "Top",   columns: 5, params: [["kickClick", "Level"], ["kickClickDecay", "Decay"], ["kickClickTone", "Tone"]], mode: "kickClickType" },
            { model: "custom", label: "Sub and output", columns: 5, params: [["kickSub", "Sub"], ["kickSubDecay", "Sub decay"], ["kickTone", "Tone"], ["kickLevel", "Level"]] }
        ]
    },
    {
        id: "snare", title: "Snare", note: 38, key: "s", colour: "#22a7d6",
        groups: [
            { label: "Body",  columns: 5, params: [["snareKey", "Key"], ["snareRatio", "Ratio"], ["snareSweep", "Sweep"], ["snareBodyDecay", "Decay"], ["snareBodyLevel", "Mix"]] },
            { label: "Noise", columns: 5, params: [["snareNoiseFreq", "Freq"], ["snareNoiseQ", "Reso"], ["snareNoiseDecay", "Decay"], ["snareNoiseLevel", "Mix"], ["snareLevel", "Level"]], mode: "snareNoiseMode" }
        ]
    },
    {
        id: "clap", title: "Clap", note: 39, key: "d", colour: "#e8467c",
        groups: [
            { label: "Filter",   columns: 5, params: [["clapFreq", "Freq"], ["clapQ", "Reso"]], mode: "clapFilterMode" },
            { label: "Envelope", columns: 5, params: [["clapBursts", "Bursts"], ["clapSpacing", "Spacing"], ["clapDecay", "Decay"], ["clapReverb", "Reverb"], ["clapLevel", "Level"]] }
        ]
    }
];

const kitParams = [["hatTune", "Hat tune"], ["closedHatDecay", "CH decay"], ["openHatDecay", "OH decay"], ["hatTone", "Hat tone"],
                   ["hatMetal", "Metal"], ["tomDecay", "Tom decay"], ["volume", "Volume"]];

const kitPads = [
    { label: "Closed",  note: 42, key: "f" },
    { label: "Open",    note: 46, key: "g" },
    { label: "Lo tom",  note: 41, key: "h" },
    { label: "Mid tom", note: 45, key: "j" },
    { label: "Hi tom",  note: 48, key: "k" }
];

const shapeEditorParams = {
    "909":    [["kickKey", "Key"], ["kick909Tune", "Tune"], ["kick909Decay", "Length"], ["kick909Attack", "Attack"],
               ["kick909Snap", "Snap"], ["kick909Shape", "Shape"], ["kick909Drive", "Drive"], ["kickLevel", "Level"]],
    "custom": [["kickKey", "Key"], ["kickSweep", "Sweep"], ["kickDecay", "Length"], ["kickDrive", "Drive"],
               ["kickTone", "Tone"], ["kickClick", "Top"], ["kickSub", "Sub"], ["kickLevel", "Level"]]
};

// The 909 model's timings, shared by the preview and the shape editor (they match DrumSynth.cmajor)
function get909DecayTime (decay)     { return 0.1 + 1.4 * decay * decay; }
function get909BendDepth (tune)      { return 6 + 30 * tune; }
function get909BendTime (tune)       { return 0.03 + 0.12 * tune; }

const midiInputEndpointID = "midiIn";
const kitColour = "#ececea";
const fieldInk = "#141414";
const maxCurvePoints = 16;

//==============================================================================
// Helpers for mapping between parameter values and a 0..1 knob position.
// Frequencies and times use a log scale so the useful low end isn't squashed.
function isLogScale (info)      { return (info.unit === "Hz" || info.unit === "s") && info.min > 0; }

function toNormalised (info, value)
{
    const v = Math.min (info.max, Math.max (info.min, value));

    if (isLogScale (info))
        return Math.log (v / info.min) / Math.log (info.max / info.min);

    return (v - info.min) / (info.max - info.min);
}

function fromNormalised (info, n)
{
    n = Math.min (1, Math.max (0, n));
    let v = isLogScale (info) ? info.min * Math.pow (info.max / info.min, n)
                              : info.min + n * (info.max - info.min);

    if (info.step)
        v = info.min + Math.round ((v - info.min) / info.step) * info.step;

    return v;
}

function formatFrequency (value)
{
    return value >= 1000 ? (value / 1000).toFixed (value >= 10000 ? 1 : 2) + " kHz" : Math.round (value) + " Hz";
}

function formatTime (seconds)
{
    return seconds < 1 ? Math.round (seconds * 1000) + " ms" : seconds.toFixed (2) + " s";
}

function formatValue (info, value)
{
    switch (info.unit)
    {
        case "Hz":   return formatFrequency (value);
        case "s":    return formatTime (value);
        case "st":   return "+" + value.toFixed (1) + " st";
        case "dB":   return (value > 0 ? "+" : "") + value.toFixed (1) + " dB";
        case "note": return noteName (value);
    }

    if (info.step)
        return String (Math.round (value));

    if (info.min === 0 && info.max === 1)
        return Math.round (value * 100) + "%";

    return value.toFixed (2);
}

function noteToFrequency (note)
{
    return 440 * Math.pow (2, (note - 69) / 12);
}

function noteName (note)
{
    note = Math.round (note);
    return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][note % 12] + (Math.floor (note / 12) - 2);
}

//==============================================================================
// Curves: lists of {x, y, tension} points with x and y in 0..1. These match
// drums::Curve and drums::evaluateCurve() in DrumSynth.cmajor.
function shapeSegment (p, tension)
{
    return Math.abs (tension) < 0.001 ? p : (Math.exp (tension * p) - 1) / (Math.exp (tension) - 1);
}

function evaluateCurve (points, t)
{
    if (! points?.length)
        return 0;

    const last = points.length - 1;

    if (t <= points[0].x)     return points[0].y;
    if (t >= points[last].x)  return points[last].y;

    for (let i = 0; i < last; ++i)
    {
        const a = points[i], b = points[i + 1];

        if (t < b.x)
            return a.y + (b.y - a.y) * shapeSegment ((t - a.x) / Math.max (b.x - a.x, 1e-6), a.tension ?? 0);
    }

    return points[last].y;
}

function toCurveStruct (points)
{
    const x = new Array (maxCurvePoints).fill (0);
    const y = new Array (maxCurvePoints).fill (0);
    const tension = new Array (maxCurvePoints).fill (0);
    const count = Math.min (points.length, maxCurvePoints);

    for (let i = 0; i < count; ++i)
    {
        x[i] = points[i].x;
        y[i] = points[i].y;
        tension[i] = points[i].tension ?? 0;
    }

    return { x, y, tension, count };
}

function clampTension (t)   { return Math.max (-20, Math.min (20, t)); }

const point = (x, y, tension = 0) => ({ x, y, tension });

// Ready-made shapes for the editor, as [amp, pitch] pairs
const curvePresets = {
    "Punchy": () => [[point (0, 1, -1.5), point (0.2, 0.75, -4), point (1, 0)],
                     [point (0, 1, -5), point (0.12, 0.08, -2), point (1, 0)]],
    "Boom":   () => [[point (0, 1, 0), point (0.65, 0.7, -3), point (1, 0)],
                     [point (0, 1, -6), point (0.35, 0, 0), point (1, 0)]],
    "Gated":  () => [[point (0, 1), point (0.45, 0.95, -3), point (0.52, 0), point (1, 0)],
                     [point (0, 1, -5), point (0.06, 0, 0), point (1, 0)]],
    "Zap":    () => [[point (0, 1, -6.9), point (1, 0)],
                     [point (0, 1, -14), point (0.6, 0, 0), point (1, 0)]],
};

//==============================================================================
// A JavaScript copy of the patch's DSP, used to draw a preview of each sound.
// It mirrors DrumSynth.cmajor closely enough that the shape on screen is what you'll hear.
const previewRate = 24000;

function decayCoefficient (seconds, rate)    { return Math.exp (-6.9 / (Math.max (seconds, 0.001) * rate)); }

class SVF
{
    constructor()   { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; }

    setup (cutoff, q, rate)
    {
        const g = Math.tan (Math.PI * Math.min (cutoff, rate * 0.45) / rate);
        this.k = 1 / q;
        this.a1 = 1 / (1 + g * (g + this.k));
        this.a2 = g * this.a1;
        this.a3 = g * this.a2;
    }

    process (x)
    {
        const v3 = x - this.ic2;
        const v1 = this.a1 * this.ic1 + this.a2 * v3;
        const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
        this.ic1 = 2 * v1 - this.ic1;
        this.ic2 = 2 * v2 - this.ic2;
        this.lp = v2;
        this.bp = v1 * this.k;
        this.hp = x - this.k * v1 - v2;
    }

    get (mode)      { return mode === 0 ? this.lp : (mode === 1 ? this.bp : this.hp); }
}

// A tiny seeded noise source, so the preview doesn't shimmer every time it's redrawn
function createNoise (seed)
{
    let state = seed >>> 0;

    return () =>
    {
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;  state >>>= 0;
        return (state / 4294967296) * 2 - 1;
    };
}

function getPreviewDuration (id, v)
{
    if (id === "kick" && Math.round (v ("kickModel")) === 0)
        return v ("kick909Hold") + get909DecayTime (v ("kick909Decay"));

    if (id === "kick")   return Math.max (v ("kickDecay"), v ("kickSub") > 0 ? v ("kickSubDecay") : 0, 0.08);
    if (id === "snare")  return Math.max (v ("snareBodyDecay"), v ("snareNoiseDecay"), 0.08);

    const tailStart = Math.max (v ("clapSpacing"), 0.001) * (Math.max (Math.round (v ("clapBursts")), 1) - 1);
    return Math.max (tailStart + Math.max (v ("clapDecay"), 0.05), v ("clapReverb") > 0.05 ? v ("clapDecay") * 2 : 0);
}

function renderPreview (id, v, curves)
{
    const duration = Math.min (getPreviewDuration (id, v), 3.2);
    const numSamples = Math.ceil (duration * previewRate);
    const out = new Float32Array (numSamples);
    const period = 1 / previewRate;
    const noise = createNoise (12345);
    const twoPi = Math.PI * 2;

    if (id === "kick" && Math.round (v ("kickModel")) === 0)
    {
        const keyFrequency = noteToFrequency (v ("kickKey")), level = v ("kickLevel");
        const tune = v ("kick909Tune"), attack = v ("kick909Attack"), hold = v ("kick909Hold");
        const snap = v ("kick909Snap"), shape = v ("kick909Shape"), drive = 1 + v ("kick909Drive") * 6;
        const decayTime = get909DecayTime (v ("kick909Decay")), length = hold + decayTime;
        const bendDepth = get909BendDepth (tune);
        const isDrawn = Math.round (v ("kickShapeMode")) === 1;
        const ampCurve = isDrawn && curves.amp?.length >= 2 ? curves.amp : null;
        const pitchCurve = isDrawn && curves.pitch?.length >= 2 ? curves.pitch : null;

        const ampCoeff = decayCoefficient (decayTime, previewRate);
        const snapCoeff = decayCoefficient (0.006, previewRate);
        const bendCoeff = decayCoefficient (get909BendTime (tune), previewRate);
        const clickCoeff = decayCoefficient (0.012, previewRate);
        const clickFilter = new SVF();
        clickFilter.setup (v ("kick909Click"), 0.707, previewRate);

        let ampEnv = 1, snapEnv = 1, bendEnv = 1, clickEnv = 1, phase = 0;

        for (let i = 0; i < numSamples; ++i)
        {
            const time = i * period, position = time / length;
            const amp = ampCurve ? (position < 1 ? evaluateCurve (ampCurve, position) : 0) : ampEnv;
            const bend = pitchCurve ? evaluateCurve (pitchCurve, Math.min (position, 1)) : bendEnv;
            const semitones = snap * 24 * snapEnv + bendDepth * bend;

            const shifted = phase + 0.75;
            const triangle = 4 * Math.abs (shifted - Math.floor (shifted) - 0.5) - 1;
            const wave = triangle + (Math.sin (triangle * Math.PI * 0.5) - triangle) * shape;
            const body = Math.tanh (drive * wave * amp) / Math.tanh (drive);

            clickFilter.process (noise());
            const pulse = time < 0.0007 ? 1 : 0;
            out[i] = level * (body + attack * (0.9 * pulse + 1.2 * clickFilter.lp * clickEnv));

            phase += keyFrequency * Math.pow (2, semitones / 12) * period;
            phase -= Math.floor (phase);

            if (time >= hold)
                ampEnv *= ampCoeff;

            snapEnv *= snapCoeff; bendEnv *= bendCoeff; clickEnv *= clickCoeff;
        }
    }
    else if (id === "kick")
    {
        const keyFrequency = noteToFrequency (v ("kickKey")), sweep = v ("kickSweep"), drive = 1 + v ("kickDrive") * 9;
        const decay = Math.max (v ("kickDecay"), 0.001), level = v ("kickLevel");
        const click = v ("kickClick"), clickType = Math.round (v ("kickClickType")), clickTone = v ("kickClickTone");
        const sub = v ("kickSub");
        const isDrawn = Math.round (v ("kickShapeMode")) === 1;
        const ampCurve = isDrawn && curves.amp?.length >= 2 ? curves.amp : null;
        const pitchCurve = isDrawn && curves.pitch?.length >= 2 ? curves.pitch : null;

        const ampCoeff = decayCoefficient (decay, previewRate);
        const pitchCoeff = decayCoefficient (v ("kickSweepTime"), previewRate);
        const clickCoeff = decayCoefficient (v ("kickClickDecay"), previewRate);
        const beaterCoeff = decayCoefficient (0.004, previewRate);
        const subCoeff = decayCoefficient (v ("kickSubDecay"), previewRate);

        const clickFilter = new SVF(), toneFilter = new SVF();
        clickFilter.setup (clickTone, clickType === 3 ? 0.7 : 0.8, previewRate);
        toneFilter.setup (v ("kickTone"), 0.707, previewRate);

        let ampEnv = 1, pitchEnv = 1, clickEnv = 1, beaterEnv = 1, subEnv = 1;
        let phase = 0, subPhase = 0, clickPhase = 0;

        const getTop = () =>
        {
            const n = noise();

            if (clickType === 0)  { clickFilter.process (n); return 2 * clickFilter.bp; }
            if (clickType === 3)  { clickFilter.process (n); return 1.5 * clickFilter.hp; }

            const isBeater = clickType === 2;
            clickPhase += (isBeater ? clickTone * (1 + beaterEnv) : clickTone) * period;
            clickPhase -= Math.floor (clickPhase);
            const s = Math.sin (clickPhase * twoPi);
            return isBeater ? 0.8 * s + 0.3 * n : s;
        };

        for (let i = 0; i < numSamples; ++i)
        {
            const position = (i * period) / decay;
            const amp = ampCurve ? (position < 1 ? evaluateCurve (ampCurve, position) : 0) : ampEnv;
            const semitones = sweep * (pitchCurve ? evaluateCurve (pitchCurve, Math.min (position, 1)) : pitchEnv);

            const body = Math.tanh (drive * Math.sin (phase * twoPi)) / Math.tanh (drive);
            toneFilter.process (body * amp + sub * Math.sin (subPhase * twoPi) * subEnv);
            out[i] = level * (toneFilter.lp + click * clickEnv * getTop());

            phase += keyFrequency * Math.pow (2, semitones / 12) * period;   phase -= Math.floor (phase);
            subPhase += keyFrequency * 0.5 * period;                         subPhase -= Math.floor (subPhase);
            ampEnv *= ampCoeff; pitchEnv *= pitchCoeff; clickEnv *= clickCoeff; beaterEnv *= beaterCoeff; subEnv *= subCoeff;
        }
    }
    else if (id === "snare")
    {
        const tune = noteToFrequency (v ("snareKey")), ratio = v ("snareRatio"), sweep = v ("snareSweep");
        const bodyLevel = v ("snareBodyLevel"), noiseLevel = v ("snareNoiseLevel"), level = v ("snareLevel");
        const mode = Math.round (v ("snareNoiseMode"));
        const bodyCoeff = decayCoefficient (v ("snareBodyDecay"), previewRate);
        const noiseCoeff = decayCoefficient (v ("snareNoiseDecay"), previewRate);
        const pitchCoeff = decayCoefficient (0.05, previewRate);
        const filter = new SVF();
        filter.setup (v ("snareNoiseFreq"), v ("snareNoiseQ"), previewRate);
        let bodyEnv = 1, noiseEnv = 1, pitch = 1, phase1 = 0, phase2 = 0;

        for (let i = 0; i < numSamples; ++i)
        {
            filter.process (noise());
            const body = 0.6 * Math.sin (phase1 * twoPi) + 0.4 * Math.sin (phase2 * twoPi);
            out[i] = level * (bodyLevel * body * bodyEnv + noiseLevel * filter.get (mode) * noiseEnv);

            const freq = tune * Math.pow (2, sweep * pitch / 12) * period;
            phase1 += freq;          phase1 -= Math.floor (phase1);
            phase2 += freq * ratio;  phase2 -= Math.floor (phase2);
            bodyEnv *= bodyCoeff; noiseEnv *= noiseCoeff; pitch *= pitchCoeff;
        }
    }
    else
    {
        const level = v ("clapLevel"), mode = Math.round (v ("clapFilterMode")), decay = Math.max (v ("clapDecay"), 0.001);
        const burstLength = Math.max (v ("clapSpacing"), 0.001);
        const tailStart = burstLength * (Math.max (Math.round (v ("clapBursts")), 1) - 1);
        const reverb = v ("clapReverb");
        const filter = new SVF(), reverbFilter = new SVF();
        filter.setup (v ("clapFreq"), v ("clapQ"), previewRate);
        reverbFilter.setup (v ("clapFreq") * 0.8, 0.9, previewRate);
        const reverbSmoothing = 1 - Math.pow (0.99, 48000 / previewRate);   // matches the DSP's 0.01-per-sample smoothing at 48kHz
        let reverbEnv = 0;

        for (let i = 0; i < numSamples; ++i)
        {
            const time = i * period;
            const n = noise();
            filter.process (n);
            reverbFilter.process (n);

            const env = time < tailStart ? Math.exp (-(time - burstLength * Math.floor (time / burstLength)) / (burstLength * 0.3))
                                         : Math.exp (-6.9 * (time - tailStart) / decay);

            reverbEnv += (Math.exp (-6.9 * time / (decay * 2)) - reverbEnv) * reverbSmoothing;
            out[i] = level * (1.8 * env * filter.get (mode) + reverb * 2.0 * reverbEnv * reverbFilter.bp);
        }
    }

    return { samples: out, duration };
}

// Draws the min/max outline of some samples as a filled shape
function fillWaveform (g, samples, x, y, w, h, colour)
{
    let peak = 0.0001;

    for (const s of samples)
        peak = Math.max (peak, Math.abs (s));

    const mid = y + h / 2;
    const yScale = (h / 2) / Math.max (peak, 1);
    const samplesPerPixel = samples.length / w;
    const tops = [], bottoms = [];

    for (let px = 0; px < w; ++px)
    {
        const start = Math.floor (px * samplesPerPixel), end = Math.max (start + 1, Math.floor ((px + 1) * samplesPerPixel));
        let lo = 0, hi = 0;

        for (let i = start; i < end && i < samples.length; ++i)
        {
            lo = Math.min (lo, samples[i]);
            hi = Math.max (hi, samples[i]);
        }

        tops.push (mid - hi * yScale);
        bottoms.push (mid - lo * yScale);
    }

    g.beginPath();
    tops.forEach ((ty, px) => px === 0 ? g.moveTo (x + px, ty) : g.lineTo (x + px, ty));

    for (let px = w - 1; px >= 0; --px)
        g.lineTo (x + px, bottoms[px]);

    g.closePath();
    g.fillStyle = colour;
    g.fill();
}

function setupCanvas (canvas)
{
    const scale = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;

    if (canvas.width !== Math.round (w * scale) || canvas.height !== Math.round (h * scale))
    {
        canvas.width = Math.round (w * scale);
        canvas.height = Math.round (h * scale);
    }

    const g = canvas.getContext ("2d");
    g.setTransform (scale, 0, 0, scale, 0, 0);
    return { g, w, h };
}

//==============================================================================
class DrumSynthView extends HTMLElement
{
    constructor (patchConnection)
    {
        super();
        this.patchConnection = patchConnection;
        this.values = {};
        this.paramInfo = {};
        this.knobs = {};
        this.modeSelectors = {};
        this.curves = { amp: null, pitch: null };
        this.editorCurve = "amp";
        this.isBuilt = false;
        this.innerHTML = this.getStyle() + `<div class="ds-root"><div class="ds-loading">Loading…</div></div>`;
    }

    connectedCallback()
    {
        this.statusListener = (status) =>
        {
            if (this.isBuilt)
                return;

            for (const input of status?.details?.inputs ?? [])
                if (input.annotation && ! input.annotation.hidden)
                    this.paramInfo[input.endpointID] = { ...input.annotation, step: input.annotation.step ?? (input.annotation.text ? 1 : 0) };

            this.build();
            this.isBuilt = true;

            for (const id of Object.keys (this.paramInfo))
                this.patchConnection.requestParameterValue (id);

            this.patchConnection.requestStoredStateValue ("kickAmpCurve");
            this.patchConnection.requestStoredStateValue ("kickPitchCurve");
        };

        this.paramListener = (event) => this.setDisplayedValue (event.endpointID, event.value);

        this.storedStateListener = (event) =>
        {
            const curveName = { kickAmpCurve: "amp", kickPitchCurve: "pitch" }[event?.key];

            if (curveName && Array.isArray (event.value) && event.value.length >= 2)
            {
                this.curves[curveName] = event.value;
                this.sendCurveToPatch (curveName);
                this.schedulePreviewUpdate (sections[0]);
            }
        };

        this.keyListener = (e) =>
        {
            if (e.key === "Escape" && this.isEditorOpen())
                return this.closeShapeEditor();

            if (e.repeat || e.ctrlKey || e.metaKey || e.altKey)
                return;

            const target = [...sections, ...kitPads].find (s => s.key === e.key.toLowerCase());

            if (target)
                this.hit (target.note, e.shiftKey ? 60 : 110);
        };

        this.patchConnection.addStatusListener (this.statusListener);
        this.patchConnection.addAllParameterListener (this.paramListener);
        this.patchConnection.addStoredStateValueListener (this.storedStateListener);
        window.addEventListener ("keydown", this.keyListener);
        this.patchConnection.requestStatusUpdate();
    }

    disconnectedCallback()
    {
        this.patchConnection.removeStatusListener (this.statusListener);
        this.patchConnection.removeAllParameterListener (this.paramListener);
        this.patchConnection.removeStoredStateValueListener (this.storedStateListener);
        window.removeEventListener ("keydown", this.keyListener);
        this.resizeObserver?.disconnect();
    }

    //==============================================================================
    build()
    {
        const root = this.querySelector (".ds-root");

        root.innerHTML = `
            <header class="ds-header">
                <div class="ds-logo">DrumSynth</div>
            </header>
            <div class="ds-modules"></div>
            <div class="ds-kit">
                <h2 class="ds-kit-title">Kit</h2>
                <div class="ds-kit-pads"></div>
                <div class="ds-kit-knobs"></div>
            </div>`;

        const modules = root.querySelector (".ds-modules");

        for (const section of sections)
            modules.appendChild (this.createModule (section));

        const kitPadContainer = root.querySelector (".ds-kit-pads");

        for (const pad of kitPads)
            kitPadContainer.appendChild (this.createKitPad (pad));

        const kitKnobContainer = root.querySelector (".ds-kit-knobs");

        for (const [id, label] of kitParams)
            kitKnobContainer.appendChild (this.createKnob (id, label));

        root.appendChild (this.createShapeEditor());

        this.resizeObserver = new ResizeObserver (() =>
        {
            sections.forEach (s => this.updatePreview (s));
            this.drawEditor();
        });

        this.resizeObserver.observe (root);
    }

    createModule (section)
    {
        const module = document.createElement ("section");
        module.className = "ds-module ds-module-" + section.id;
        module.style.setProperty ("--accent", section.colour);

        const shapeButton = section.hasShapeEditor ? `
                    <button class="ds-icon-button ds-shape-button" data-action="shape" title="Draw the kick's amp and pitch shapes">
                        <svg viewBox="0 0 20 20"><path d="M13.5 3.5l3 3-9.5 9.5H4v-3z"/><path d="M11.5 5.5l3 3"/></svg>
                    </button>` : "";

        module.innerHTML = `
            <div class="ds-module-head">
                <h2>${section.title}</h2>
                <span class="ds-head-mode"></span>
                <div class="ds-tools">
                    ${shapeButton}
                    <button class="ds-icon-button" data-action="random" title="Randomise this drum">
                        <svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7" cy="7" r="1.3"/><circle cx="13" cy="13" r="1.3"/><circle cx="13" cy="7" r="1.3"/><circle cx="7" cy="13" r="1.3"/><circle cx="10" cy="10" r="1.3"/></svg>
                    </button>
                    <button class="ds-icon-button" data-action="init" title="Reset this drum to its defaults">
                        <svg viewBox="0 0 20 20"><path d="M4.5 10a5.5 5.5 0 1 0 1.8-4.1"/><path d="M4 3.5v3.6h3.6"/></svg>
                    </button>
                </div>
            </div>
            <div class="ds-screen">
                <canvas></canvas>
                <div class="ds-screen-info"></div>
            </div>`;

        module.querySelector ('[data-action="random"]').onclick = () => this.randomise (section);
        module.querySelector ('[data-action="init"]').onclick = () => this.resetSection (section);

        if (section.hasShapeEditor)
        {
            module.querySelector ('[data-action="shape"]').onclick = () => this.openShapeEditor();
            module.querySelector (".ds-screen").onclick = () => this.openShapeEditor();
            module.querySelector (".ds-screen").title = "Click to draw the kick's shape";
        }

        if (section.headMode)
        {
            module.querySelector (".ds-head-mode").appendChild (this.createModeSelector (section.headMode));
            module.classList.add ("model-909");
        }

        section.module = module;
        section.canvas = module.querySelector ("canvas");
        section.info = module.querySelector (".ds-screen-info");

        for (const group of section.groups)
        {
            const groupElement = document.createElement ("div");
            groupElement.className = "ds-group" + (group.isLarge ? " ds-group-large" : "");

            if (group.model)
                groupElement.dataset.model = group.model;

            const head = document.createElement ("div");
            head.className = "ds-group-head";
            head.innerHTML = `<span>${group.label}</span>`;

            if (group.mode)
                head.appendChild (this.createModeSelector (group.mode));

            const grid = document.createElement ("div");
            grid.className = "ds-knob-grid";
            grid.style.setProperty ("--columns", group.columns);

            for (const [id, label] of group.params)
                grid.appendChild (this.createKnob (id, label));

            groupElement.appendChild (head);
            groupElement.appendChild (grid);
            module.appendChild (groupElement);
        }

        const pad = document.createElement ("button");
        pad.className = "ds-pad";
        pad.dataset.note = section.note;
        pad.textContent = "Hit " + section.title.toLowerCase();
        pad.title = "Key " + section.key.toUpperCase();
        this.attachPadHandler (pad, section.note);
        module.appendChild (pad);

        return module;
    }

    createKitPad (pad)
    {
        const element = document.createElement ("button");
        element.className = "ds-kit-pad";
        element.dataset.note = pad.note;
        element.textContent = pad.label;
        element.title = "Key " + pad.key.toUpperCase();
        this.attachPadHandler (element, pad.note);
        return element;
    }

    attachPadHandler (element, note)
    {
        element.onpointerdown = (e) =>
        {
            // Hitting nearer the top of the pad plays harder
            const rect = element.getBoundingClientRect();
            const position = 1 - (e.clientY - rect.top) / rect.height;
            this.hit (note, Math.round (50 + 77 * Math.min (1, Math.max (0, position))));
        };
    }

    createModeSelector (endpointID)
    {
        const info = this.paramInfo[endpointID];
        const min = info?.min ?? 0;
        const container = document.createElement ("div");
        container.className = "ds-mode";

        const buttons = (info?.text ?? "LP|BP|HP").split ("|").map ((text, index) =>
        {
            const button = document.createElement ("button");
            button.textContent = text;
            button.onclick = () => this.sendValue (endpointID, min + index);
            container.appendChild (button);
            return button;
        });

        (this.modeSelectors[endpointID] ??= []).push ((value) =>
            buttons.forEach ((b, i) => b.classList.toggle ("active", i === Math.round (value - min))));

        return container;
    }

    createKnob (endpointID, label)
    {
        const info = this.paramInfo[endpointID];
        const element = document.createElement ("div");
        element.className = "ds-knob";
        element.dataset.param = endpointID;

        if (! info)
            return element;

        element.title = info.name;
        element.innerHTML = `
            <div class="ds-knob-dial">
                <svg viewBox="0 0 60 60">
                    <path class="ds-knob-track"/>
                    <path class="ds-knob-arc"/>
                </svg>
                <div class="ds-knob-cap"></div>
            </div>
            <div class="ds-knob-value"></div>
            <div class="ds-knob-label">${label}</div>`;

        const dial = element.querySelector (".ds-knob-dial");
        const cap = element.querySelector (".ds-knob-cap");
        const arc = element.querySelector (".ds-knob-arc");
        const valueText = element.querySelector (".ds-knob-value");

        const arcPath = (n) =>
        {
            const start = -135, end = start + 270 * n;
            const toPoint = (deg) => [30 + 25 * Math.sin (deg * Math.PI / 180), 30 - 25 * Math.cos (deg * Math.PI / 180)];
            const [x1, y1] = toPoint (start), [x2, y2] = toPoint (end);
            return `M ${x1.toFixed (2)} ${y1.toFixed (2)} A 25 25 0 ${end - start > 180 ? 1 : 0} 1 ${x2.toFixed (2)} ${y2.toFixed (2)}`;
        };

        element.querySelector (".ds-knob-track").setAttribute ("d", arcPath (1));

        const update = (value) =>
        {
            const n = toNormalised (info, value);
            arc.setAttribute ("d", arcPath (Math.max (n, 0.002)));
            cap.style.transform = `rotate(${-135 + 270 * n}deg)`;
            valueText.textContent = formatValue (info, value);
        };

        (this.knobs[endpointID] ??= []).push (update);

        const currentNormalised = () => toNormalised (info, this.values[endpointID] ?? info.init ?? info.min);
        let dragStartY = 0, dragStartNorm = 0;

        const onMove = (e) =>
        {
            const n = dragStartNorm + (dragStartY - e.clientY) / (e.shiftKey ? 900 : 180);
            this.sendValue (endpointID, fromNormalised (info, n));
        };

        const onUp = () =>
        {
            element.classList.remove ("dragging");
            window.removeEventListener ("pointermove", onMove);
            window.removeEventListener ("pointerup", onUp);
            this.patchConnection.sendParameterGestureEnd (endpointID);
        };

        dial.onpointerdown = (e) =>
        {
            e.preventDefault();
            element.classList.add ("dragging");
            dragStartY = e.clientY;
            dragStartNorm = currentNormalised();
            this.patchConnection.sendParameterGestureStart (endpointID);
            window.addEventListener ("pointermove", onMove);
            window.addEventListener ("pointerup", onUp);
        };

        dial.ondblclick = () => this.sendValue (endpointID, info.init ?? info.min);

        dial.onwheel = (e) =>
        {
            e.preventDefault();
            const delta = info.step ? Math.sign (-e.deltaY) * info.step / (info.max - info.min)
                                    : -e.deltaY / (e.shiftKey ? 6000 : 1200);
            this.sendValue (endpointID, fromNormalised (info, currentNormalised() + delta));
        };

        update (info.init ?? info.min);
        return element;
    }

    //==============================================================================
    sendValue (endpointID, value)
    {
        this.patchConnection.sendEventOrValue (endpointID, value);
        this.setDisplayedValue (endpointID, value);
    }

    setDisplayedValue (endpointID, value)
    {
        this.values[endpointID] = value;
        this.knobs[endpointID]?.forEach (update => update (value));
        this.modeSelectors[endpointID]?.forEach (update => update (value));

        if (endpointID === "kickShapeMode")
        {
            const isDrawn = Math.round (value) === 1;
            sections[0].module?.classList.toggle ("is-drawn", isDrawn);
        }

        if (endpointID === "kickModel")
        {
            const is909 = Math.round (value) === 0;

            for (const element of [sections[0].module, this.editor])
            {
                element?.classList.toggle ("model-909", is909);
                element?.classList.toggle ("model-custom", ! is909);
            }
        }

        for (const section of sections)
            if (endpointID.startsWith (section.id))
                this.schedulePreviewUpdate (section);
    }

    getValue (id)
    {
        return this.values[id] ?? this.paramInfo[id]?.init ?? 0;
    }

    hit (note, velocity)
    {
        this.patchConnection.sendMIDIInputEvent (midiInputEndpointID, 0x990000 | (note << 8) | velocity);
        setTimeout (() => this.patchConnection.sendMIDIInputEvent (midiInputEndpointID, 0x890000 | (note << 8)), 50);

        for (const element of this.querySelectorAll (`[data-note="${note}"]`))
        {
            element.classList.remove ("hit");
            void element.offsetWidth;
            element.classList.add ("hit");
        }

        const section = sections.find (s => s.note === note);

        if (section)
        {
            section.hitTime = performance.now();
            this.animatePlayhead (section);
        }
    }

    allSectionParams (section)
    {
        return section.groups.flatMap (group => [...group.params.map (([id]) => id), ...(group.mode ? [group.mode] : [])]);
    }

    // only the parameters for the kick model that's showing are randomised
    randomise (section)
    {
        const model = Math.round (this.getValue ("kickModel")) === 0 ? "909" : "custom";
        const groups = section.groups.filter (group => ! group.model || group.model === model);
        const ids = groups.flatMap (group => [...group.params.map (([id]) => id), ...(group.mode ? [group.mode] : [])]);

        for (const id of ids)
        {
            const info = this.paramInfo[id];

            if (info && ! id.endsWith ("Level"))
                this.sendValue (id, fromNormalised (info, Math.random()));
        }

        this.hit (section.note, 110);
    }

    resetSection (section)
    {
        for (const id of this.allSectionParams (section))
        {
            const info = this.paramInfo[id];

            if (info)
                this.sendValue (id, info.init ?? info.min);
        }

        if (section.hasShapeEditor)
            this.sendValue ("kickShapeMode", 0);
    }

    //==============================================================================
    schedulePreviewUpdate (section)
    {
        if (section.updatePending)
            return;

        section.updatePending = true;

        requestAnimationFrame (() =>
        {
            section.updatePending = false;
            this.updatePreview (section);

            if (section.hasShapeEditor)
                this.drawEditor();
        });
    }

    // Re-renders the sound with the current settings and caches an image of its waveform
    updatePreview (section)
    {
        const canvas = section.canvas;

        if (! canvas || ! canvas.clientWidth)
            return;

        const v = (id) => this.getValue (id);
        const preview = renderPreview (section.id, v, this.curves);
        section.preview = preview;

        const { w, h } = setupCanvas (canvas);
        const scale = window.devicePixelRatio || 1;
        const image = section.previewImage ?? document.createElement ("canvas");
        image.width = canvas.width;
        image.height = canvas.height;
        section.previewImage = image;

        const g = image.getContext ("2d");
        g.setTransform (scale, 0, 0, scale, 0, 0);
        g.clearRect (0, 0, w, h);
        fillWaveform (g, preview.samples, 0, 10, w, h - 20, fieldInk);

        section.info.textContent = this.getScreenInfo (section, v, preview.duration);
        this.drawScreen (section);
    }

    getScreenInfo (section, v, duration)
    {
        if (section.id === "kick")    return noteName (v ("kickKey")) + ", " + formatTime (duration);
        if (section.id === "snare")   return noteName (v ("snareKey")) + ", " + formatTime (duration);
        return formatTime (duration);
    }

    getPlayheadPosition (section)
    {
        if (! section.hitTime || ! section.preview)
            return null;

        const elapsed = (performance.now() - section.hitTime) / 1000;
        return elapsed < section.preview.duration ? elapsed : null;
    }

    drawScreen (section)
    {
        const canvas = section.canvas;
        const image = section.previewImage;

        if (! canvas || ! image)
            return;

        const { g, w, h } = setupCanvas (canvas);
        g.clearRect (0, 0, w, h);

        g.drawImage (image, 0, 0, w, h);

        // a white playhead while a hit is sounding
        const elapsed = this.getPlayheadPosition (section);

        if (elapsed !== null)
        {
            g.fillStyle = "#ffffff";
            g.fillRect (Math.round ((elapsed / section.preview.duration) * w), 0, 2, h);
        }
    }

    animatePlayhead (section)
    {
        if (section.animating)
            return;

        section.animating = true;

        const step = () =>
        {
            this.drawScreen (section);

            if (section.hasShapeEditor && this.isEditorOpen())
                this.drawEditor();

            if (this.getPlayheadPosition (section) !== null && this.isConnected)
            {
                requestAnimationFrame (step);
            }
            else
            {
                section.animating = false;
                this.drawScreen (section);

                if (section.hasShapeEditor)
                    this.drawEditor();
            }
        };

        requestAnimationFrame (step);
    }

    //==============================================================================
    // The kick shape editor: two breakpoint curves (amp and pitch) drawn over the
    // length set by the Decay knob. Pitch is a fraction of the Sweep amount.
    createShapeEditor()
    {
        const kick = sections[0];
        const editor = document.createElement ("div");
        editor.className = "ds-editor model-909";
        editor.style.setProperty ("--accent", kick.colour);

        editor.innerHTML = `
            <div class="ds-editor-bar">
                <h2>Kick shape</h2>
                <div class="ds-mode ds-editor-tabs">
                    <button data-curve="amp">Amp</button>
                    <button data-curve="pitch">Pitch</button>
                </div>
                <div class="ds-editor-mode"></div>
                <div class="ds-editor-presets"></div>
                <button class="ds-editor-hit" data-note="${kick.note}" title="Key A">Hit</button>
                <button class="ds-icon-button ds-editor-close" title="Close (Esc)">
                    <svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>
                </button>
            </div>
            <div class="ds-editor-plot">
                <canvas title="Click to add a point. Double-click a point to remove it. Drag a ring to bend a segment."></canvas>
            </div>
            <div class="ds-editor-knobs" data-model="909"></div>
            <div class="ds-editor-knobs" data-model="custom"></div>`;

        editor.querySelector (".ds-editor-mode").appendChild (this.createModeSelector ("kickShapeMode"));
        editor.querySelector (".ds-editor-close").onclick = () => this.closeShapeEditor();
        this.attachPadHandler (editor.querySelector (".ds-editor-hit"), kick.note);

        for (const tab of editor.querySelectorAll ("[data-curve]"))
            tab.onclick = () => { this.editorCurve = tab.dataset.curve; this.updateEditorTabs(); this.drawEditor(); };

        const presets = editor.querySelector (".ds-editor-presets");

        const addPresetButton = (name, makeCurves) =>
        {
            const button = document.createElement ("button");
            button.textContent = name;
            button.onclick = () =>
            {
                const [amp, pitch] = makeCurves();
                this.setCurve ("amp", amp, true);
                this.setCurve ("pitch", pitch, true);
                this.hit (kick.note, 110);
            };

            presets.appendChild (button);
        };

        addPresetButton ("From knobs", () => this.getCurvesFromKnobs());

        for (const [name, makeCurves] of Object.entries (curvePresets))
            addPresetButton (name, makeCurves);

        for (const [model, params] of Object.entries (shapeEditorParams))
        {
            const knobs = editor.querySelector (`.ds-editor-knobs[data-model="${model}"]`);

            for (const [id, label] of params)
                knobs.appendChild (this.createKnob (id, label));
        }

        this.editor = editor;
        this.editorCanvas = editor.querySelector ("canvas");
        this.attachEditorMouseHandlers (this.editorCanvas);
        this.updateEditorTabs();
        return editor;
    }

    isEditorOpen()      { return this.editor?.classList.contains ("open"); }

    openShapeEditor()
    {
        if (! this.curves.amp || ! this.curves.pitch)
        {
            const [amp, pitch] = this.getCurvesFromKnobs();
            this.curves.amp ??= amp;
            this.curves.pitch ??= pitch;
        }

        this.editor.classList.add ("open");
        this.drawEditor();
    }

    closeShapeEditor()
    {
        this.editor.classList.remove ("open");
    }

    updateEditorTabs()
    {
        for (const tab of this.editor.querySelectorAll ("[data-curve]"))
            tab.classList.toggle ("active", tab.dataset.curve === this.editorCurve);
    }

    is909()     { return Math.round (this.getValue ("kickModel")) === 0; }

    // The time the drawn curves are stretched over, for the current kick model
    getKickLength()
    {
        if (this.is909())
            return this.getValue ("kick909Hold") + get909DecayTime (this.getValue ("kick909Decay"));

        return Math.max (this.getValue ("kickDecay"), 0.001);
    }

    // How many semitones the top of the pitch curve is above the key
    getKickPitchDepth()
    {
        return this.is909() ? get909BendDepth (this.getValue ("kick909Tune")) : this.getValue ("kickSweep");
    }

    // Builds curves that sound like the current knob settings
    getCurvesFromKnobs()
    {
        const length = this.getKickLength();

        if (this.is909())
        {
            const holdEnd = this.getValue ("kick909Hold") / length;
            const bendEnd = Math.min (1, get909BendTime (this.getValue ("kick909Tune")) / length);
            const amp = holdEnd > 0.005 ? [point (0, 1), point (holdEnd, 1, -6.9), point (1, 0)]
                                        : [point (0, 1, -6.9), point (1, 0)];
            const pitch = bendEnd >= 0.999 ? [point (0, 1, -6.9 * bendEnd), point (1, 0)]
                                           : [point (0, 1, -6.9), point (bendEnd, 0), point (1, 0)];
            return [amp, pitch];
        }

        const decay = length;
        const glide = this.getValue ("kickSweepTime");
        const glideEnd = Math.min (1, glide / decay);
        const amp = [point (0, 1, -6.9), point (1, 0)];
        const pitch = glideEnd >= 0.999 ? [point (0, 1, clampTension (-6.9 * decay / Math.max (glide, 0.001))), point (1, 0)]
                                        : [point (0, 1, -6.9), point (glideEnd, 0), point (1, 0)];
        return [amp, pitch];
    }

    setCurve (name, points, shouldSave)
    {
        this.curves[name] = points;
        this.sendCurveToPatch (name);

        if (Math.round (this.getValue ("kickShapeMode")) !== 1)
            this.sendValue ("kickShapeMode", 1);

        if (shouldSave)
            this.saveCurve (name);

        this.schedulePreviewUpdate (sections[0]);
    }

    sendCurveToPatch (name)
    {
        const endpoint = name === "amp" ? "kickAmpCurve" : "kickPitchCurve";
        this.patchConnection.sendEventOrValue (endpoint, toCurveStruct (this.curves[name]));
    }

    saveCurve (name)
    {
        const key = name === "amp" ? "kickAmpCurve" : "kickPitchCurve";
        this.patchConnection.sendStoredStateValue (key, this.curves[name].map (p => ({ x: p.x, y: p.y, tension: p.tension ?? 0 })));
    }

    getEditorLayout()
    {
        const { w, h } = { w: this.editorCanvas.clientWidth, h: this.editorCanvas.clientHeight };
        const left = 54, right = 22, top = 22, bottom = 34;
        const plotW = Math.max (10, w - left - right), plotH = Math.max (10, h - top - bottom);

        return {
            w, h, left, top, plotW, plotH,
            toX:   (x)  => left + x * plotW,
            toY:   (y)  => top + (1 - y) * plotH,
            fromX: (px) => Math.min (1, Math.max (0, (px - left) / plotW)),
            fromY: (py) => Math.min (1, Math.max (0, 1 - (py - top) / plotH)),
        };
    }

    getTensionHandle (points, i, layout)
    {
        const a = points[i], b = points[i + 1];
        const y = a.y + (b.y - a.y) * shapeSegment (0.5, a.tension ?? 0);
        return { x: layout.toX ((a.x + b.x) / 2), y: layout.toY (y) };
    }

    attachEditorMouseHandlers (canvas)
    {
        const findTarget = (e) =>
        {
            const points = this.curves[this.editorCurve];
            const layout = this.getEditorLayout();
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;

            for (let i = 0; i < points.length; ++i)
                if (Math.hypot (layout.toX (points[i].x) - mx, layout.toY (points[i].y) - my) < 11)
                    return { type: "point", index: i, mx, my, layout };

            for (let i = 0; i < points.length - 1; ++i)
            {
                const handle = this.getTensionHandle (points, i, layout);

                if (Math.hypot (handle.x - mx, handle.y - my) < 10)
                    return { type: "tension", index: i, mx, my, layout };
            }

            return { type: "empty", mx, my, layout };
        };

        let drag = null;

        canvas.onpointerdown = (e) =>
        {
            if (e.button !== 0)
                return;

            e.preventDefault();
            canvas.setPointerCapture (e.pointerId);
            const points = this.curves[this.editorCurve].map (p => ({ ...p }));
            const target = findTarget (e);

            if (target.type === "empty")
            {
                if (points.length >= maxCurvePoints)
                    return;

                // add a point on the click, then carry on dragging it
                const x = target.layout.fromX (target.mx);
                const insertAt = points.findIndex (p => p.x > x);

                if (insertAt <= 0)
                    return;

                points.splice (insertAt, 0, point (x, target.layout.fromY (target.my), 0));
                this.setCurve (this.editorCurve, points, false);
                drag = { type: "point", index: insertAt };
            }
            else if (target.type === "tension")
            {
                drag = { type: "tension", index: target.index, startY: e.clientY, startTension: points[target.index].tension ?? 0 };
            }
            else
            {
                drag = { type: "point", index: target.index };
            }

            this.hoverTarget = drag;
            this.drawEditor();
        };

        canvas.onpointermove = (e) =>
        {
            if (! drag)
            {
                const target = findTarget (e);
                this.hoverTarget = target.type === "empty" ? null : target;
                canvas.style.cursor = target.type === "point" ? "grab" : (target.type === "tension" ? "ns-resize" : "crosshair");
                this.drawEditor();
                return;
            }

            const points = this.curves[this.editorCurve].map (p => ({ ...p }));
            const layout = this.getEditorLayout();
            const rect = canvas.getBoundingClientRect();

            if (drag.type === "point")
            {
                const p = points[drag.index];
                const isEnd = drag.index === 0 || drag.index === points.length - 1;

                if (! isEnd)
                {
                    const minX = points[drag.index - 1].x + 0.002, maxX = points[drag.index + 1].x - 0.002;
                    p.x = Math.min (maxX, Math.max (minX, layout.fromX (e.clientX - rect.left)));
                }

                p.y = layout.fromY (e.clientY - rect.top);
            }
            else
            {
                const a = points[drag.index], b = points[drag.index + 1];
                const draggedUp = (drag.startY - e.clientY) * (e.shiftKey ? 0.015 : 0.06);
                a.tension = clampTension (drag.startTension + draggedUp * (a.y >= b.y ? 1 : -1));
            }

            this.setCurve (this.editorCurve, points, false);
        };

        canvas.onpointerup = () =>
        {
            if (drag)
                this.saveCurve (this.editorCurve);

            drag = null;
        };

        const removePointAt = (e) =>
        {
            const target = findTarget (e);
            const points = this.curves[this.editorCurve].map (p => ({ ...p }));

            if (target.type === "point" && target.index > 0 && target.index < points.length - 1)
            {
                points.splice (target.index, 1);
                this.setCurve (this.editorCurve, points, true);
            }
            else if (target.type === "tension")
            {
                points[target.index].tension = 0;
                this.setCurve (this.editorCurve, points, true);
            }
        };

        canvas.ondblclick = removePointAt;
        canvas.oncontextmenu = (e) => { e.preventDefault(); removePointAt (e); };

        canvas.onpointerleave = () =>
        {
            if (! drag)
            {
                this.hoverTarget = null;
                this.drawEditor();
            }
        };
    }

    drawEditor()
    {
        if (! this.isEditorOpen() || ! this.curves.amp || ! this.editorCanvas.clientWidth)
            return;

        const kick = sections[0];
        const { g, w, h } = setupCanvas (this.editorCanvas);
        const layout = this.getEditorLayout();
        const { toX, toY, left, top, plotW, plotH } = layout;
        const decay = this.getKickLength();
        const sweep = this.getKickPitchDepth();

        g.clearRect (0, 0, w, h);
        g.font = "600 11px Inter, 'Segoe UI', system-ui, sans-serif";
        g.textBaseline = "middle";

        // the sound itself, faintly, over the same time span
        if (kick.preview)
        {
            const shown = Math.min (kick.preview.samples.length, Math.ceil (decay * previewRate));
            const portion = kick.preview.samples.subarray (0, shown);
            const width = Math.max (1, Math.round (plotW * (shown / previewRate) / decay));
            fillWaveform (g, portion, left, top, width, plotH, "rgba(0, 0, 0, 0.16)");
        }

        // the two ends of each axis
        g.fillStyle = fieldInk;
        g.textAlign = "right";
        const isAmp = this.editorCurve === "amp";
        g.fillText (isAmp ? "100%" : "+" + sweep.toFixed (0) + " st", left - 10, toY (1));
        g.fillText (isAmp ? "0" : noteName (this.getValue ("kickKey")), left - 10, toY (0));

        g.textAlign = "left";
        g.fillText ("0", toX (0), top + plotH + 20);
        g.textAlign = "right";
        g.fillText (formatTime (decay), toX (1), top + plotH + 20);

        const drawCurve = (points, lineWidth, dash) =>
        {
            g.beginPath();

            for (let px = 0; px <= plotW; px += 2)
            {
                const x = px / plotW;
                const y = toY (evaluateCurve (points, x));
                px === 0 ? g.moveTo (left + px, y) : g.lineTo (left + px, y);
            }

            g.setLineDash (dash);
            g.strokeStyle = fieldInk;
            g.lineWidth = lineWidth;
            g.lineJoin = "round";
            g.stroke();
            g.setLineDash ([]);
        };

        // the curve that isn't being edited is shown dashed behind the one that is
        drawCurve (this.curves[isAmp ? "pitch" : "amp"], 1.5, [5, 5]);

        const points = this.curves[this.editorCurve];
        drawCurve (points, 3, []);

        // bend handles
        for (let i = 0; i < points.length - 1; ++i)
        {
            const handle = this.getTensionHandle (points, i, layout);
            const isHot = this.hoverTarget?.type === "tension" && this.hoverTarget.index === i;
            g.beginPath();
            g.arc (handle.x, handle.y, isHot ? 6 : 4.5, 0, Math.PI * 2);
            g.fillStyle = kick.colour;
            g.fill();
            g.lineWidth = 2;
            g.strokeStyle = fieldInk;
            g.stroke();
        }

        // points
        points.forEach ((p, i) =>
        {
            const isHot = this.hoverTarget?.type === "point" && this.hoverTarget.index === i;
            g.beginPath();
            g.arc (toX (p.x), toY (p.y), isHot ? 8 : 6.5, 0, Math.PI * 2);
            g.fillStyle = fieldInk;
            g.fill();
        });

        // playhead
        const elapsed = this.getPlayheadPosition (kick);

        if (elapsed !== null && elapsed < decay)
        {
            g.fillStyle = "#ffffff";
            g.fillRect (Math.round (toX (elapsed / decay)), top, 2, plotH);
        }
    }

    //==============================================================================
    getStyle()
    {
        // One ground, one panel grey, one raised grey, one text colour, one ink, and a single
        // translucent shade for anything recessed on a coloured field. No other tones.
        return `
        <style>
            drum-synth-view {
                --ground: #161616;
                --kit: #262626;
                --raised: #333333;
                --text: #ececea;
                --shade: rgba(0, 0, 0, 0.16);

                display: block;
                width: 100%;
                height: 100%;
                overflow: auto;
                background: var(--ground);
                color: var(--text);
                font-family: "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
                font-variant-numeric: tabular-nums;
                user-select: none;
                -webkit-user-select: none;
            }

            drum-synth-view * { box-sizing: border-box; font-family: inherit; }
            drum-synth-view h2 { margin: 0; }

            .ds-root { position: relative; min-width: 1000px; min-height: 100%; padding: 18px 20px 20px; }
            .ds-loading { padding: 60px; text-align: center; }

            .ds-header { margin-bottom: 14px; }
            .ds-logo { font-size: 22px; font-weight: 800; }

            /* modules: each drum is a flat field of its own colour */
            .ds-modules { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }

            .ds-module {
                --ink: #141414;
                display: flex; flex-direction: column;
                padding: 16px;
                background: var(--accent);
                color: var(--ink);
            }

            .ds-module-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
            .ds-module-head h2 { font-size: 24px; font-weight: 800; line-height: 1; }
            .ds-tools { margin-left: auto; display: flex; gap: 2px; }

            .ds-icon-button {
                width: 30px; height: 30px; display: grid; place-items: center;
                background: transparent; border: 0; border-radius: 50%;
                color: var(--ink); cursor: pointer;
            }
            .ds-icon-button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
            .ds-icon-button svg circle { fill: currentColor; stroke: none; }
            .ds-icon-button:hover { background: var(--shade); }
            .ds-module.is-drawn .ds-shape-button { background: var(--ink); color: var(--accent); }

            /* screen */
            .ds-screen { position: relative; flex: 1 0 116px; min-height: 116px; margin-bottom: 4px; background: var(--shade); }
            .ds-module-kick .ds-screen { flex: 0 0 116px; cursor: pointer; }
            .ds-screen canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
            .ds-screen-info {
                position: absolute; left: 10px; bottom: 7px;
                font-size: 12px; font-weight: 600; color: var(--ink);
                pointer-events: none;
            }

            /* parameter groups */
            .ds-group { margin-top: 10px; }
            .ds-group-head { display: flex; align-items: center; justify-content: space-between; height: 22px; margin-bottom: 2px; }
            .ds-group-head span { font-size: 13px; font-weight: 700; }

            .ds-mode { display: flex; background: var(--shade); }
            .ds-mode button {
                border: 0; background: transparent; color: var(--ink);
                font-size: 12px; font-weight: 600; padding: 3px 9px; cursor: pointer;
            }
            .ds-mode button.active { background: var(--ink); color: var(--accent); }

            .ds-knob-grid { display: grid; grid-template-columns: repeat(var(--columns), 1fr); row-gap: 4px; }

            /* in drawn mode the Glide knob does nothing, so it goes away */
            .ds-module.is-drawn .ds-knob[data-param="kickSweepTime"] { visibility: hidden; }

            /* the kick shows only the controls for its current model */
            .model-909 [data-model="custom"], .model-custom [data-model="909"] { display: none !important; }
            .ds-head-mode:empty { display: none; }

            /* knobs: an ink disc with a field-coloured pointer, on a flat track */
            .ds-knob { display: flex; flex-direction: column; align-items: center; padding: 4px 0 2px; }
            .ds-knob-dial { position: relative; width: 50px; height: 50px; cursor: ns-resize; touch-action: none; }
            .ds-knob-dial svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
            .ds-knob-track { fill: none; stroke: var(--shade); stroke-width: 5; }
            .ds-knob-arc { fill: none; stroke: var(--ink); stroke-width: 5; }
            .ds-knob-cap {
                position: absolute; left: 50%; top: 50%; width: 30px; height: 30px; margin: -15px 0 0 -15px;
                border-radius: 50%; background: var(--ink);
            }
            .ds-knob-cap::after {
                content: ""; position: absolute; left: 50%; top: 4px; width: 3px; height: 9px; margin-left: -1.5px;
                background: var(--accent);
            }
            .ds-knob-value { font-size: 12px; font-weight: 700; line-height: 16px; margin-top: 2px; white-space: nowrap; }
            .ds-knob-label { font-size: 12px; line-height: 15px; white-space: nowrap; }

            /* the 909's four main controls are set large, like a front panel */
            .ds-group-large .ds-knob-grid { grid-template-columns: repeat(4, 1fr); }
            .ds-group-large .ds-knob-dial { width: 64px; height: 64px; }
            .ds-group-large .ds-knob-cap { width: 40px; height: 40px; margin: -20px 0 0 -20px; }
            .ds-group-large .ds-knob-cap::after { top: 5px; height: 12px; width: 4px; margin-left: -2px; }
            .ds-group-large .ds-knob-label { font-size: 13px; font-weight: 700; }

            /* pads flash white when hit */
            .ds-pad {
                margin-top: 14px; height: 48px; flex: none;
                background: var(--ink); color: var(--accent); border: 0;
                font-size: 14px; font-weight: 800; cursor: pointer;
            }
            .ds-module .ds-group:last-of-type { margin-bottom: auto; }
            .ds-pad:active, .ds-kit-pad:active, .ds-editor-hit:active { transform: translateY(1px); }
            .ds-pad.hit, .ds-kit-pad.hit, .ds-editor-hit.hit { animation: ds-flash 0.12s steps(1, end); }

            @keyframes ds-flash { from { background: #ffffff; color: #141414; } }

            /* kit strip */
            .ds-kit {
                --accent: var(--kit);
                --ink: var(--text);
                --shade: var(--raised);
                display: flex; align-items: center; gap: 20px;
                margin-top: 12px; padding: 14px 16px;
                background: var(--kit);
                color: var(--text);
            }
            .ds-kit-title { font-size: 18px; font-weight: 800; }
            .ds-kit-pads { display: flex; gap: 6px; flex: 1; }
            .ds-kit-pad {
                flex: 1; min-width: 0; height: 60px; padding: 0 10px; white-space: nowrap;
                font-size: 13px; font-weight: 700; color: var(--text);
                background: var(--raised); border: 0; cursor: pointer;
            }
            .ds-kit-knobs { display: grid; grid-template-columns: repeat(7, 62px); }

            /* shape editor: covers the whole view while open */
            .ds-editor {
                --ink: #141414;
                position: absolute; inset: 0; z-index: 10;
                display: none; flex-direction: column; gap: 12px;
                padding: 18px 20px 20px;
                background: var(--ground);
            }
            .ds-editor.open { display: flex; }

            .ds-editor-bar { display: flex; align-items: center; gap: 12px; }
            .ds-editor-bar h2 { font-size: 24px; font-weight: 800; color: var(--accent); margin-right: 4px; }

            .ds-editor-bar .ds-mode { background: var(--kit); }
            .ds-editor-bar .ds-mode button { color: var(--text); font-size: 13px; padding: 6px 14px; }
            .ds-editor-bar .ds-mode button.active { background: var(--accent); color: var(--ink); }

            .ds-editor-presets { display: flex; gap: 4px; margin-left: auto; }
            .ds-editor-presets button {
                border: 0; background: var(--kit); color: var(--text);
                font-size: 13px; font-weight: 600; padding: 6px 11px; cursor: pointer;
            }
            .ds-editor-presets button:hover { background: var(--raised); }

            .ds-editor-hit {
                border: 0; background: var(--accent); color: var(--ink);
                font-size: 13px; font-weight: 800; padding: 6px 16px; cursor: pointer;
            }

            .ds-editor-close { color: var(--text); }
            .ds-editor-close:hover { background: var(--kit); }

            .ds-editor-plot { position: relative; flex: 1; min-height: 260px; background: var(--accent); color: var(--ink); }
            .ds-editor-plot canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }

            .ds-editor-knobs {
                --accent: var(--kit);
                --ink: var(--text);
                --shade: var(--raised);
                display: grid; grid-template-columns: repeat(8, 1fr);
                padding: 10px 16px; background: var(--kit); color: var(--text);
            }
        </style>`;
    }
}

//==============================================================================
export default function createPatchView (patchConnection)
{
    const customElementName = "drum-synth-view";

    if (! window.customElements.get (customElementName))
        window.customElements.define (customElementName, DrumSynthView);

    return new (window.customElements.get (customElementName)) (patchConnection);
}
