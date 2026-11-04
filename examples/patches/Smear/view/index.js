
/*
    The GUI for Smear, in the Resocheck design language: a dark plate with controls carved
    into it, one orange accent kept for what's active, and Geist for the type.

    The navbar has the wordmark, a readout naming whatever is under the pointer, and Freeze
    All (which freezes all three bands). Below it, on the plate:

      - down the left, the scale the spectrum is pulled towards: its on/off switch (Scale, in
        the panel's head, with a dot lit while it's on), the key and scale in large
        type (step through them with the arrows, or scroll over them), the Pull strength as
        the big knob, and the switch to the Classic Pull algorithm
      - across the top, the output's spectrum, drawn as it plays from 30Hz on the left to
        16kHz on the right, with the two crossovers on it as lines you can drag
      - under it, the three bands, each with Smear as its big knob, the other four around
        it, and its own Freeze
      - down the right, the crossovers, and Tilt with minimum phase
      - across the foot of the plate, the modulation, on two tabbed pages. The LFO: a small
        screen drawing one cycle of its shape, then Depth, Rate (which turns into the synced
        division while Sync is on), Shape, Randomize and Spread, and how far it moves Smear,
        Shift and Scatter. The Envelope: its On switch, a screen showing the input and what the
        follower makes of it over the last three seconds, Attack, Release and Sensitivity, and
        the same three amounts.

    and along the bottom, sliders for how much of each hit is kept clean, the dry/wet mix
    and the output level. A knob's caption turns into its value while it's under the
    pointer. Parameter ranges and defaults come from the patch's own annotations.
*/

const bands = [{ id: "low", title: "Low" }, { id: "mid", title: "Mid" }, { id: "high", title: "High" }];
const bandParams = [["Shift", "Shift"], ["Peaks", "Peaks"], ["Scatter", "Scatter"], ["Level", "Level"]];

// which of the twelve semitones above the key each scale has, as smear::scaleMask has them
const scaleMasks = [0xab5, 0x5ad, 0x6ad, 0x5ab, 0xad5, 0x6b5, 0x9ad, 0x295, 0x4a9, 0x555, 0x081, 0x001];

const crossoverIDs = ["lowCross", "highCross"];
const spectrumLow = 30, spectrumHigh = 16000;
const gridFrequencies = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

// the canvas can't read CSS variables cheaply every frame, so its inks live here too
const ink = { text: "#d0d0d0", muted: "#7a7a7a", accent: "#ff5900", accentReadable: "#ff7d01" };

// Resocheck's own chevrons
const chevronLeft = `<svg viewBox="0 0 24 24" fill="none"><path d="M14.4 16.8L9.6 12L14.4 7.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const chevronRight = `<svg viewBox="0 0 24 24" fill="none"><path d="M9.6 7.2L14.4 12L9.6 16.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const fontURL = (file) => new URL ("./fonts/" + file, import.meta.url).href;

// the LFO's knobs after Rate, and the shapes its Shape control morphs between
const lfoKnobs = [["lfoShape", "Shape"], ["lfoRandom", "Random"], ["lfoSpread", "Spread"],
                  ["lfoToSmear", "→ Smear"], ["lfoToShift", "→ Shift"], ["lfoToScatter", "→ Scatter"]];
const lfoShapeNames = ["Sine", "Tri", "Ramp", "Square"];

// how many steps of the envelope's history its screen shows (about 60 a second, so 3 seconds)
const envHistoryLength = 180;

// the envelope follower's knobs, in order
const envKnobs = [["envAttack", "Attack"], ["envRelease", "Release"], ["envSensitivity", "Sens"],
                  ["envToSmear", "→ Smear"], ["envToShift", "→ Shift"], ["envToScatter", "→ Scatter"]];

// one point of the LFO's cycle (p from 0 to 1), -1 to 1, as SmearLfo shapes it
function lfoShapeAt (p, shape)
{
    const triangle = 1 - 4 * Math.abs (p - 0.5);
    const ramp = 1 - 2 * p;

    if (shape < 1)  { const sine = Math.sin (2 * Math.PI * p); return sine + (triangle - sine) * shape; }
    if (shape < 2)  return triangle + (ramp - triangle) * (shape - 1);

    return ramp + ((p < 0.5 ? 1 : -1) - ramp) * (shape - 2);
}

// controls whose values read better as words or signs than as the bare number
const customFormats =
{
    lfoShape: (value) =>
    {
        const lower = Math.floor (Math.min (value, 2.999)), amount = value - lower;

        if (amount < 0.05)  return lfoShapeNames[lower];
        if (amount > 0.95)  return lfoShapeNames[lower + 1];

        return lfoShapeNames[lower] + "›" + lfoShapeNames[lower + 1];
    },
};

//==============================================================================
function isLogScale (info)      { return info.unit === "Hz" && info.min > 0; }

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

function formatValue (info, value)
{
    if (customFormats[info.id])
        return customFormats[info.id] (value);

    switch (info.unit)
    {
        case "Hz":      return value >= 1000 ? (value / 1000).toFixed (1) + " kHz"
                             : value < 10 ? value.toFixed (2) + " Hz" : Math.round (value) + " Hz";
        case "deg":     return (value > 0.5 ? "+" : "") + Math.round (value) + "°";
        case "ms":      return (value < 10 ? value.toFixed (1) : Math.round (value)) + " ms";
        case "st":      return (value > 0.05 ? "+" : "") + value.toFixed (1) + " st";
        case "dB":      return value <= info.min + 0.1 && info.min <= -36 ? "Off" : value.toFixed (1) + " dB";
        case "dB/oct":  return (value > 0.05 ? "+" : "") + value.toFixed (Math.abs (value) >= 9.95 ? 0 : 1) + " dB/oct";
    }

    if (info.text)
        return info.text.split ("|")[Math.round (value - info.min)] ?? "";

    if (info.min === 0 && info.max <= 1)
        return Math.round (value / info.max * 100) + "%";

    // an amount that can go either way, like how far the LFO moves Smear
    if (info.min === -1 && info.max === 1)
        return (value > 0.005 ? "+" : "") + Math.round (value * 100) + "%";

    return value.toFixed (2);
}

const formatFrequency = (f) => f >= 1000 ? (f / 1000) + "k" : String (f);

// where a frequency sits across the spectrum display, 0 to 1
const frequencyToX = (f) => Math.log (f / spectrumLow) / Math.log (spectrumHigh / spectrumLow);
const xToFrequency = (x) => spectrumLow * Math.pow (spectrumHigh / spectrumLow, x);

//==============================================================================
// The Resocheck dial: a trench ring with a lit arc in it, and a raised face over both with
// the pointer on it. SVG angles, so 0 degrees is to the right and they turn clockwise:
// the arc runs from 135 (lower left) to 405 (lower right), with the gap at the foot. It's
// drawn in Resocheck's 59-unit box and scaled to whatever size it's shown at.
const knobBox = 59, knobCentre = 29.5;
const arcRadius = 26.88, arcWidth = 2.24, arcStart = 135, arcEnd = 405;
const faceRadius = 22, pointerIn = 13.64, pointerOut = 20.24;
const smallKnob = 42, bigKnob = 64;

const polar = (radius, degrees) => [knobCentre + radius * Math.cos (degrees * Math.PI / 180),
                                    knobCentre + radius * Math.sin (degrees * Math.PI / 180)];

function arcPath (from, to)
{
    const [x1, y1] = polar (arcRadius, from), [x2, y2] = polar (arcRadius, to);
    return `M ${x1.toFixed (2)} ${y1.toFixed (2)} A ${arcRadius} ${arcRadius} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed (2)} ${y2.toFixed (2)}`;
}

//==============================================================================
class SmearView extends HTMLElement
{
    constructor (patchConnection)
    {
        super();
        this.patchConnection = patchConnection;
        this.values = {};
        this.paramInfo = {};
        this.updaters = {};
        this.spectrum = new Float32Array (64);
        this.envHistory = { input: new Float32Array (envHistoryLength), env: new Float32Array (envHistoryLength), next: 0 };
        this.hoveredCrossover = null;
        this.tipText = "";
        this.isBuilt = false;

        // the knob faces share one gradient and one shadow
        this.innerHTML = this.getStyle() + `
            <svg class="sm-defs" width="0" height="0" aria-hidden="true">
                <defs>
                    <linearGradient id="sm-face" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stop-color="#434343"/><stop offset="1" stop-color="#2e2e2e"/>
                    </linearGradient>
                    <filter id="sm-face-shadow" x="-50%" y="-50%" width="200%" height="220%">
                        <feDropShadow dx="0" dy="8" stdDeviation="2" flood-color="#000" flood-opacity="0.51"/>
                    </filter>
                </defs>
            </svg>
            <div class="sm-root"></div>`;
    }

    connectedCallback()
    {
        this.statusListener = (status) =>
        {
            // A new status means the patch was (re)loaded, perhaps with endpoints this view
            // asked for before they existed, so the display streams are asked for again
            this.listenToDisplayEndpoints();

            if (this.isBuilt)
                return;

            for (const input of status?.details?.inputs ?? [])
                if (input.annotation)
                    this.paramInfo[input.endpointID] = { ...input.annotation, id: input.endpointID, step: input.annotation.step ?? (input.annotation.text ? 1 : 0) };

            this.build();
            this.isBuilt = true;

            for (const id of Object.keys (this.paramInfo))
                this.patchConnection.requestParameterValue (id);
        };

        this.paramListener = (event) => this.setDisplayedValue (event.endpointID, event.value);

        // each new spectrum is eased into the one on show, so it moves smoothly
        this.spectrumListener = (spectrum) =>
        {
            const levels = spectrum?.bands ?? [];

            for (let i = 0; i < this.spectrum.length; ++i)
                this.spectrum[i] += ((levels[i] ?? 0) - this.spectrum[i]) * 0.5;

            this.needsRedraw = true;
        };

        // where the LFO is in its cycle for each band, what it's putting out, the envelope's
        // level and the input's peak, held back by the patch to line up with what's heard
        this.modulationListener = (state) =>
        {
            this.modulation = state;
            this.pushEnvelopeHistory (state.inputLevel ?? 0, state.envelope ?? 0);
            this.needsRedraw = true;
        };

        this.keyListener = (e) =>
        {
            if (e.repeat || e.ctrlKey || e.metaKey || e.altKey)
                return;

            if (e.code === "Space" || e.key.toLowerCase() === "f")
            {
                e.preventDefault();
                this.toggleFreezeAll();
            }
        };

        this.patchConnection.addStatusListener (this.statusListener);
        this.patchConnection.addAllParameterListener (this.paramListener);
        window.addEventListener ("keydown", this.keyListener);
        this.patchConnection.requestStatusUpdate();

        // the canvas uses the fonts too, so it's drawn again once they've arrived
        document.fonts?.ready.then (() => { this.needsRedraw = true; });

        const animate = () =>
        {
            if (this.needsRedraw)
            {
                this.needsRedraw = false;
                this.drawSpectrum();
                this.drawLfo();
                this.drawEnvelope();
            }

            this.animationFrame = requestAnimationFrame (animate);
        };

        animate();
    }

    disconnectedCallback()
    {
        cancelAnimationFrame (this.animationFrame);
        this.patchConnection.removeStatusListener (this.statusListener);
        this.patchConnection.removeAllParameterListener (this.paramListener);
        this.stopListeningToDisplayEndpoints();
        window.removeEventListener ("keydown", this.keyListener);
    }

    // the spectrum and the modulation sources, which the patch streams out for the screens
    listenToDisplayEndpoints()
    {
        this.stopListeningToDisplayEndpoints();
        this.patchConnection.addEndpointListener ("spectrumOut", this.spectrumListener);
        this.patchConnection.addEndpointListener ("modulationOut", this.modulationListener);
        this.isListeningToDisplay = true;
    }

    // One step of the envelope's history, about 60 a second as the modulation state arrives:
    // the input's peak over the step and the follower's own value, both 0 to 1 on the
    // follower's scale (-48 dB to 0 dB, after Sensitivity), oldest first round a ring
    pushEnvelopeHistory (inputPeak, envelope)
    {
        const history = this.envHistory;
        const decibels = 20 * Math.log10 (Math.max (inputPeak, 1e-9)) + this.getValue ("envSensitivity");

        history.input[history.next] = Math.max (0, Math.min (1, (decibels + 48) / 48));
        history.env[history.next] = Math.max (0, Math.min (1, envelope));
        history.next = (history.next + 1) % envHistoryLength;
    }

    stopListeningToDisplayEndpoints()
    {
        if (! this.isListeningToDisplay)
            return;

        this.patchConnection.removeEndpointListener ("spectrumOut", this.spectrumListener);
        this.patchConnection.removeEndpointListener ("modulationOut", this.modulationListener);
        this.isListeningToDisplay = false;
    }

    //==============================================================================
    build()
    {
        const root = this.querySelector (".sm-root");

        root.innerHTML = `
            <header class="sm-navbar">
                <div class="sm-wordmark">SMEAR</div>
                <div class="sm-readout"><span class="sm-tip"></span></div>
                <div class="sm-nav-end">
                    ${this.carveButton ("sm-freeze-all", "Freeze All", "Freeze all three bands (Space or F)")}
                    <span class="sm-brand">LOSTAUDIO</span>
                </div>
            </header>
            <main class="sm-plate">
                <section class="sm-panel sm-scale">
                    <div class="sm-panel-head"><button class="sm-tab sm-scale-power" data-tip="Scale: pull every note towards the key and scale, as hard as Strength says">Scale<span class="sm-tab-dot"></span></button>${this.carveButton ("sm-toggle", "Classic", "Classic Pull: the original algorithm, which pulls every partial on its own for a grainier, more obviously tuned sound")}</div>
                    <div class="sm-scale-screen"></div>
                    <div class="sm-hero"></div>
                </section>
                <div class="sm-screen"><canvas class="sm-spectrum"></canvas></div>
                <div class="sm-bands"></div>
                <div class="sm-side">
                    <section class="sm-panel sm-crossovers">
                        <div class="sm-panel-head"><h2>Crossovers</h2></div>
                        <div class="sm-knob-grid"></div>
                    </section>
                    <section class="sm-panel sm-tone">
                        <div class="sm-panel-head"><h2>Tone</h2>${this.carveButton ("sm-toggle", "Min Phase", "Minimum phase: ringing from the reshaping comes after a hit instead of before it")}</div>
                        <div class="sm-knob-grid"></div>
                    </section>
                </div>
                <section class="sm-panel sm-lfo" data-page="lfo">
                    <div class="sm-panel-head">
                        <div class="sm-tabs">
                            <button class="sm-tab" data-page="lfo" data-tip="The LFO">LFO<span class="sm-tab-dot"></span></button>
                            <button class="sm-tab" data-page="env" data-tip="The envelope follower: the input's level moves the bands">Envelope<span class="sm-tab-dot"></span></button>
                        </div>
                        <div class="sm-head-buttons sm-page-lfo">
                            ${this.carveButton ("sm-lfo-sync", "Sync", "Sync: the LFO's rate follows the host's tempo, and its phase the host's position while it plays")}
                            ${this.carveButton ("sm-lfo-snap", "Snap", "Shape Snap: Shape jumps between sine, triangle, ramp and square instead of morphing")}
                        </div>
                        <div class="sm-head-buttons sm-page-env">
                            ${this.carveButton ("sm-env-on", "On", "Envelope: turns the envelope follower on and off")}
                        </div>
                    </div>
                    <div class="sm-lfo-body sm-page-lfo">
                        <div class="sm-lfo-screen"><canvas class="sm-lfo-shape"></canvas></div>
                        <div class="sm-lfo-knobs"></div>
                    </div>
                    <div class="sm-lfo-body sm-page-env">
                        <div class="sm-lfo-screen"><canvas class="sm-env-shape"></canvas></div>
                        <div class="sm-lfo-knobs sm-env-knobs"></div>
                    </div>
                </section>
            </main>
            <footer class="sm-bottom">
                <div class="sm-bottom-start"></div>
                <div class="sm-bottom-centre"></div>
                <div class="sm-bottom-end"></div>
            </footer>`;

        this.spectrumCanvas = root.querySelector (".sm-spectrum");
        this.tip = root.querySelector (".sm-tip");
        root.querySelector (".sm-freeze-all").onclick = () => this.toggleFreezeAll();
        this.attachCrossoverHandlers (this.spectrumCanvas);

        // the scale: key and scale in large type, Pull, and Classic
        const scalePanel = root.querySelector (".sm-scale");
        scalePanel.querySelector (".sm-scale-screen").append (this.createStepper ("key", "sm-stepper-key"), this.createStepper ("scale", "sm-stepper-scale"), this.createPiano());
        scalePanel.querySelector (".sm-hero").appendChild (this.createKnob ("magnet", "Strength", bigKnob));

        // the switch in the head turns the scale on and off; while it's off the rest of the panel dims
        const scalePower = scalePanel.querySelector (".sm-scale-power");
        scalePower.onclick = () => this.sendValue ("scaleEnabled", Math.round (this.getValue ("scaleEnabled")) === 1 ? 0 : 1);
        scalePower.onpointerenter = () => this.showTip (scalePower.dataset.tip);
        scalePower.onpointerleave = () => this.showTip ("");

        this.addUpdater ("scaleEnabled", (value) =>
        {
            const isOn = Math.round (value) === 1;
            scalePower.classList.toggle ("is-live", isOn);
            scalePanel.classList.toggle ("is-off", ! isOn);
        });
        this.attachToggle (scalePanel.querySelector (".sm-toggle"), "pullMode");

        // the bands: Smear big, the other four around it
        for (const band of bands)
        {
            const element = document.createElement ("section");
            element.className = "sm-panel sm-band";
            element.innerHTML = `
                <div class="sm-panel-head"><h2>${band.title}</h2>${this.carveButton ("sm-band-freeze", "Freeze", `Freeze the ${band.title.toLowerCase()} band`)}</div>
                <div class="sm-hero"></div>
                <div class="sm-knob-grid"></div>`;

            const freeze = element.querySelector (".sm-band-freeze");
            freeze.dataset.band = band.id;
            freeze.onclick = () => this.toggleFreeze (band.id);

            element.querySelector (".sm-hero").appendChild (this.createKnob (band.id + "Smear", "Smear", bigKnob));

            for (const [suffix, label] of bandParams)
                element.querySelector (".sm-knob-grid").appendChild (this.createKnob (band.id + suffix, label, smallKnob));

            root.querySelector (".sm-bands").appendChild (element);
        }

        // the crossovers, and tilt with minimum phase
        const crossovers = root.querySelector (".sm-crossovers .sm-knob-grid");
        crossovers.append (this.createKnob ("lowCross", "Low", smallKnob), this.createKnob ("highCross", "High", smallKnob));

        const tone = root.querySelector (".sm-tone");
        tone.querySelector (".sm-knob-grid").appendChild (this.createKnob ("tilt", "Tilt", smallKnob));
        this.attachToggle (tone.querySelector (".sm-toggle"), "phaseMode");

        // the LFO: Depth, then Rate or the synced division in the same place, then the rest
        const lfo = root.querySelector (".sm-lfo");
        const lfoKnobRow = lfo.querySelector (".sm-lfo-knobs");
        const rateKnob = this.createKnob ("lfoRate", "Rate", smallKnob);
        const divisionKnob = this.createKnob ("lfoDivision", "Rate", smallKnob);
        lfoKnobRow.append (this.createKnob ("lfoDepth", "Depth", smallKnob), rateKnob, divisionKnob);

        for (const [id, label] of lfoKnobs)
            lfoKnobRow.appendChild (this.createKnob (id, label, smallKnob));

        // the three amounts it moves the bands by sit apart from the LFO's own controls
        lfoKnobRow.querySelectorAll (".sm-knob")[6]?.classList.add ("sm-knob-first-target");

        this.attachToggle (lfo.querySelector (".sm-lfo-sync"), "lfoSync");
        this.attachToggle (lfo.querySelector (".sm-lfo-snap"), "lfoSnap");

        this.addUpdater ("lfoSync", (value) =>
        {
            const isSynced = Math.round (value) === 1;
            rateKnob.style.display = isSynced ? "none" : "";
            divisionKnob.style.display = isSynced ? "" : "none";
        });

        this.lfoCanvas = lfo.querySelector (".sm-lfo-shape");

        // the envelope follower's page: how fast it moves, how hard the input drives it, and
        // the same three amounts, set apart the same way
        const envKnobRow = lfo.querySelector (".sm-env-knobs");

        for (const [id, label] of envKnobs)
            envKnobRow.appendChild (this.createKnob (id, label, smallKnob));

        envKnobRow.querySelectorAll (".sm-knob")[3]?.classList.add ("sm-knob-first-target");
        this.attachToggle (lfo.querySelector (".sm-env-on"), "envEnabled");
        this.envCanvas = lfo.querySelector (".sm-env-shape");

        // the tabs pick which page shows; each one's dot lights while its source is moving something
        for (const tab of lfo.querySelectorAll (".sm-tab"))
        {
            tab.onclick = () => { lfo.dataset.page = tab.dataset.page; this.needsRedraw = true; };
            tab.onpointerenter = () => this.showTip (tab.dataset.tip);
            tab.onpointerleave = () => this.showTip ("");
        }

        const [lfoTab, envTab] = lfo.querySelectorAll (".sm-tab");
        const updateDots = () =>
        {
            lfoTab.classList.toggle ("is-live", this.getValue ("lfoDepth") > 0);
            envTab.classList.toggle ("is-live", Math.round (this.getValue ("envEnabled")) === 1);
        };

        this.addUpdater ("lfoDepth", updateDots);
        this.addUpdater ("envEnabled", updateDots);

        for (const id of ["lfoShape", "lfoSnap", "lfoDepth", "lfoRandom", "envEnabled", "envAttack", "envRelease"])
            this.addUpdater (id, () => { this.needsRedraw = true; });

        // the sliders along the bottom
        root.querySelector (".sm-bottom-start").appendChild (this.createSlider ("transients", "Transients"));
        root.querySelector (".sm-bottom-centre").appendChild (this.createSlider ("mix", "Dry", "Wet"));
        root.querySelector (".sm-bottom-end").appendChild (this.createSlider ("volume", "Output"));

        // buttons name themselves in the readout
        for (const button of root.querySelectorAll (".sm-carve"))
        {
            button.onpointerenter = () => this.showTip (button.dataset.tip);
            button.onpointerleave = () => this.showTip ("");
        }

        this.showTip ("");
        new ResizeObserver (() => { this.drawSpectrum(); this.drawLfo(); this.drawEnvelope(); }).observe (root);
    }

    // A carve control: a well cut into the plate with a lit face sitting in it. Its state is
    // carried by the label alone.
    carveButton (className, label, tip)
    {
        return `<button class="sm-carve ${className}" data-tip="${tip}"><span class="sm-carve-face">${label}</span></button>`;
    }

    attachToggle (button, endpointID)
    {
        button.onclick = () => this.sendValue (endpointID, Math.round (this.getValue (endpointID)) === 1 ? 0 : 1);
        this.addUpdater (endpointID, (value) => button.classList.toggle ("is-on", Math.round (value) === 1));
    }

    addUpdater (endpointID, update)
    {
        (this.updaters[endpointID] ??= []).push (update);
    }

    // The readout in the navbar names whatever is under the pointer, and otherwise which Pull
    // algorithm is in use
    showTip (text)
    {
        this.tipText = text;

        if (this.tip)
            this.tip.textContent = text || (Math.round (this.getValue ("scaleEnabled")) !== 1 ? "Scale Off"
                                              : Math.round (this.getValue ("pullMode")) === 1 ? "Classic Pull" : "Precise Pull");
    }

    showValueTip (endpointID)
    {
        const info = this.paramInfo[endpointID];
        this.showTip (info ? `${info.name}  ${formatValue (info, this.getValue (endpointID))}` : "");
    }

    isFrozen (bandID)       { return Math.round (this.getValue (bandID + "Freeze")) === 1; }
    toggleFreeze (bandID)   { this.sendValue (bandID + "Freeze", this.isFrozen (bandID) ? 0 : 1); }

    // freezes every band, or thaws them all if they're all frozen already
    toggleFreezeAll()
    {
        const shouldFreeze = ! bands.every (b => this.isFrozen (b.id));

        for (const band of bands)
            this.sendValue (band.id + "Freeze", shouldFreeze ? 1 : 0);
    }

    updateFreezeButtons()
    {
        this.querySelectorAll (".sm-band-freeze").forEach (button => button.classList.toggle ("is-on", this.isFrozen (button.dataset.band)));
        this.querySelector (".sm-freeze-all")?.classList.toggle ("is-on", bands.every (b => this.isFrozen (b.id)));
        this.needsRedraw = true;
    }

    //==============================================================================
    // The crossover lines on the spectrum: hover to pick one up, drag sideways to move it
    attachCrossoverHandlers (canvas)
    {
        let dragging = null;

        const findCrossover = (e) =>
        {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const near = crossoverIDs.map (id => ({ id, distance: Math.abs (frequencyToX (this.getValue (id)) * rect.width - x) }))
                                     .sort ((a, b) => a.distance - b.distance)[0];
            return near.distance < 10 ? near.id : null;
        };

        const moveTo = (e) =>
        {
            const rect = canvas.getBoundingClientRect();
            const info = this.paramInfo[dragging];
            const frequency = xToFrequency ((e.clientX - rect.left) / rect.width);
            this.sendValue (dragging, Math.min (info.max, Math.max (info.min, frequency)));
            this.showValueTip (dragging);
        };

        const setHovered = (id) =>
        {
            canvas.style.cursor = id ? "ew-resize" : "default";

            if (id)
                this.showValueTip (id);
            else if (this.hoveredCrossover)
                this.showTip ("");

            if (id !== this.hoveredCrossover)
            {
                this.hoveredCrossover = id;
                this.needsRedraw = true;
            }
        };

        canvas.onpointerdown = (e) =>
        {
            dragging = findCrossover (e);

            if (! dragging)
                return;

            e.preventDefault();
            canvas.setPointerCapture (e.pointerId);
            this.patchConnection.sendParameterGestureStart (dragging);
            moveTo (e);
        };

        canvas.onpointermove = (e) =>
        {
            if (dragging)
                return moveTo (e);

            setHovered (findCrossover (e));
        };

        canvas.onpointerup = () =>
        {
            if (dragging)
                this.patchConnection.sendParameterGestureEnd (dragging);

            dragging = null;
        };

        canvas.onpointerleave = () =>
        {
            if (! dragging)
                setHovered (null);
        };
    }

    // The spectrum on its screen: a frequency and level grid, each frozen band's region
    // washed in the accent, the trace in white over a faint fill, and the crossovers
    drawSpectrum()
    {
        const canvas = this.spectrumCanvas;

        if (! canvas)
            return;

        const scale = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;

        if (! w || ! h)
            return;

        if (canvas.width !== Math.round (w * scale) || canvas.height !== Math.round (h * scale))
        {
            canvas.width = Math.round (w * scale);
            canvas.height = Math.round (h * scale);
        }

        const g = canvas.getContext ("2d");
        g.setTransform (scale, 0, 0, scale, 0, 0);
        g.clearRect (0, 0, w, h);

        const top = 24;   // room for the frequency ruler
        const plotH = h - top;
        const crossovers = crossoverIDs.map (id => Math.round (frequencyToX (this.getValue (id)) * w));
        const regions = [[0, crossovers[0]], [crossovers[0], crossovers[1]], [crossovers[1], w]];

        // the grid, on whole pixels: a line for each frequency on the ruler, and one every 12dB
        g.font = "500 10px Geist Mono, ui-monospace, monospace";
        g.textBaseline = "middle";
        g.textAlign = "center";

        for (const f of gridFrequencies)
        {
            const x = Math.round (frequencyToX (f) * w) + 0.5;
            g.fillStyle = [100, 1000, 10000].includes (f) ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.035)";
            g.fillRect (x - 0.5, top, 1, plotH);
            g.fillStyle = ink.muted;
            g.fillText (formatFrequency (f), x, top / 2);
        }

        g.textAlign = "right";

        for (let db = 12; db < 84; db += 12)
        {
            const y = Math.round (top + db / 84 * plotH) + 0.5;
            g.fillStyle = "rgba(255,255,255,0.035)";
            g.fillRect (0, y - 0.5, w, 1);
            g.fillStyle = ink.muted;
            g.fillText ("-" + db, w - 8, y - 7);
        }

        // frozen bands, and the bands' names along the foot
        g.font = "600 10px Geist, system-ui, sans-serif";
        g.textAlign = "left";
        g.textBaseline = "alphabetic";

        regions.forEach (([from, to], i) =>
        {
            const isFrozen = this.isFrozen (bands[i].id);

            if (isFrozen)
            {
                g.fillStyle = "rgba(255,89,0,0.08)";
                g.fillRect (from, top, to - from, plotH);
            }

            if (to - from > 60)
            {
                g.fillStyle = isFrozen ? ink.accentReadable : ink.muted;
                this.drawCaption (g, (bands[i].title + (isFrozen ? " frozen" : "")).toUpperCase(), from + 10, h - 10);
            }
        });

        // the trace: a smooth line through the bands, using each pair's midpoint as the join
        const n = this.spectrum.length;
        const toX = (i) => i / (n - 1) * w;
        const toY = (i) => top + (1 - this.spectrum[i]) * plotH;

        const traceLine = () =>
        {
            g.beginPath();
            g.moveTo (toX (0), toY (0));

            for (let i = 1; i < n - 1; ++i)
                g.quadraticCurveTo (toX (i), toY (i), (toX (i) + toX (i + 1)) / 2, (toY (i) + toY (i + 1)) / 2);

            g.lineTo (toX (n - 1), toY (n - 1));
        };

        const fill = g.createLinearGradient (0, top, 0, h);
        fill.addColorStop (0, "rgba(255,255,255,0.10)");
        fill.addColorStop (1, "rgba(255,255,255,0.01)");
        traceLine();
        g.lineTo (w, h);
        g.lineTo (0, h);
        g.closePath();
        g.fillStyle = fill;
        g.fill();

        traceLine();
        g.strokeStyle = "rgba(255,255,255,0.92)";
        g.lineWidth = 1.5;
        g.lineJoin = "round";
        g.stroke();

        // the crossovers, which take the accent while one is picked up
        g.font = "500 10px Geist Mono, ui-monospace, monospace";
        g.textBaseline = "middle";

        crossoverIDs.forEach ((id, i) =>
        {
            const x = crossovers[i] + 0.5;
            const isHot = this.hoveredCrossover === id;
            g.fillStyle = isHot ? ink.accent : "rgba(208,208,208,0.45)";
            g.fillRect (x - 0.5, top, 1, plotH);
            g.fillStyle = isHot ? ink.accentReadable : ink.text;
            g.fillText (formatValue (this.paramInfo[id] ?? { unit: "Hz" }, this.getValue (id)), x + 6, top + 12);
        });
    }

    // carve-caption type, which canvas can only space out a letter at a time
    drawCaption (g, text, x, y)
    {
        for (const letter of text)
        {
            g.fillText (letter, x, y);
            x += g.measureText (letter).width + 0.6;
        }
    }

    // One cycle of the LFO's shape on its little screen, lit in the accent as Depth comes up,
    // with the playhead on it. Randomize is drawn as a faint wobble around the shape (the
    // values it will pick aren't known ahead), but the playhead's dots sit at what the LFO
    // is really putting out: one for the low band, and with Spread, fainter ones for the
    // mid and high bands further along the cycle.
    drawLfo()
    {
        const prepared = this.prepareCanvas (this.lfoCanvas);

        if (! prepared)
            return;

        const { g, w, h } = prepared;
        const morph = Math.min (3, Math.max (0, this.getValue ("lfoShape")));
        const shape = Math.round (this.getValue ("lfoSnap")) === 1 ? Math.round (morph) : morph;
        const depth = Math.min (1, Math.max (0, this.getValue ("lfoDepth")));
        const random = Math.min (1, Math.max (0, this.getValue ("lfoRandom")));
        const padX = 8, padY = 9, midY = h / 2, amplitude = h / 2 - padY;

        g.fillStyle = "rgba(255,255,255,0.05)";
        g.fillRect (padX, Math.round (midY), w - 2 * padX, 1);

        g.beginPath();

        for (let x = 0; x <= w - 2 * padX; ++x)
        {
            const p = x / (w - 2 * padX);
            const wobble = random * 0.35 * Math.sin (p * 2 * Math.PI * 3 + 1.3) * Math.sin (p * Math.PI);
            const y = midY - (lfoShapeAt (Math.min (p, 0.9999), shape) * (1 - random * 0.35) + wobble) * amplitude;
            x === 0 ? g.moveTo (padX + x, y) : g.lineTo (padX + x, y);
        }

        g.strokeStyle = depth > 0 ? ink.accent : ink.muted;
        g.globalAlpha = depth > 0 ? 0.45 + 0.55 * depth : 0.8;
        g.lineWidth = 1.5;
        g.lineJoin = "round";
        g.stroke();
        g.globalAlpha = 1;

        const phases = this.modulation?.lfoPhase, values = this.modulation?.lfoValue;

        if (! phases || ! values)
            return;

        const toX = (phase) => padX + (phase - Math.floor (phase)) * (w - 2 * padX);
        const toY = (value) => midY - Math.max (-1, Math.min (1, value)) * amplitude;

        // the low band's playhead line, then the dots from high to low so the low band's is on top
        g.fillStyle = "rgba(255,255,255,0.18)";
        g.fillRect (Math.round (toX (phases[0])), padY - 4, 1, h - 2 * (padY - 4));

        const hasSpread = Math.abs (this.getValue ("lfoSpread")) > 0.5;

        for (let band = hasSpread ? 2 : 0; band >= 0; --band)
        {
            g.beginPath();
            g.arc (toX (phases[band]), toY (values[band]), band === 0 ? 3 : 2.5, 0, 2 * Math.PI);
            g.fillStyle = band === 0 ? "#fff" : "rgba(255,255,255,0.45)";
            g.fill();
        }
    }

    // The envelope follower over the last few seconds, scrolling to the left: the input's level
    // as a grey area, and what the follower makes of it as a line over it, lit in the accent
    // while it's on, with a dot where it is now. Both are on the follower's own scale, so
    // Sensitivity raises the grey too, and it keeps running while the envelope is off, so
    // Sensitivity, Attack and Release can be set by eye before it's switched on.
    drawEnvelope()
    {
        const prepared = this.prepareCanvas (this.envCanvas);

        if (! prepared)
            return;

        const { g, w, h } = prepared;
        const { input, env, next } = this.envHistory;
        const isOn = Math.round (this.getValue ("envEnabled")) === 1;
        const padX = 6, padY = 7, baseY = h - padY, topY = padY;
        const toX = (i) => padX + i / (envHistoryLength - 1) * (w - 2 * padX);
        const toY = (level) => baseY - level * (baseY - topY);
        const at = (values, i) => values[(next + i) % envHistoryLength];   // i = 0 is the oldest

        g.fillStyle = "rgba(255,255,255,0.05)";
        g.fillRect (padX, Math.round (baseY), w - 2 * padX, 1);

        // the input, filled down to the floor
        g.beginPath();
        g.moveTo (toX (0), baseY);

        for (let i = 0; i < envHistoryLength; ++i)
            g.lineTo (toX (i), toY (at (input, i)));

        g.lineTo (toX (envHistoryLength - 1), baseY);
        g.closePath();
        g.fillStyle = "rgba(160,160,166,0.32)";
        g.fill();

        // the follower
        g.beginPath();

        for (let i = 0; i < envHistoryLength; ++i)
            i === 0 ? g.moveTo (toX (i), toY (at (env, i))) : g.lineTo (toX (i), toY (at (env, i)));

        g.strokeStyle = isOn ? ink.accent : ink.text;
        g.globalAlpha = isOn ? 1 : 0.55;
        g.lineWidth = 1.5;
        g.lineJoin = "round";
        g.stroke();
        g.globalAlpha = 1;

        g.beginPath();
        g.arc (toX (envHistoryLength - 1), toY (at (env, envHistoryLength - 1)), 2.5, 0, 2 * Math.PI);
        g.fillStyle = isOn ? ink.accent : ink.text;
        g.fill();
    }

    // Sizes a canvas to its box at the screen's pixel density and clears it, or gives back
    // nothing while it isn't shown (a hidden page of the modulation panel)
    prepareCanvas (canvas)
    {
        if (! canvas)
            return null;

        const scale = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;

        if (! w || ! h)
            return null;

        if (canvas.width !== Math.round (w * scale) || canvas.height !== Math.round (h * scale))
        {
            canvas.width = Math.round (w * scale);
            canvas.height = Math.round (h * scale);
        }

        const g = canvas.getContext ("2d");
        g.setTransform (scale, 0, 0, scale, 0, 0);
        g.clearRect (0, 0, w, h);
        return { g, w, h };
    }

    //==============================================================================
    // Drags up and down, or scrolls, a control's normalised position; double-click resets it
    attachDrag (element, endpointID, pixelsPerRange, onStart, onEnd)
    {
        const info = this.paramInfo[endpointID];
        const current = () => toNormalised (info, this.getValue (endpointID));
        let startY = 0, startN = 0;

        const onMove = (e) => this.sendValue (endpointID, fromNormalised (info, startN + (startY - e.clientY) / (e.shiftKey ? pixelsPerRange * 5 : pixelsPerRange)));

        const onUp = () =>
        {
            window.removeEventListener ("pointermove", onMove);
            window.removeEventListener ("pointerup", onUp);
            this.patchConnection.sendParameterGestureEnd (endpointID);
            onEnd?.();
        };

        element.onpointerdown = (e) =>
        {
            e.preventDefault();
            startY = e.clientY;
            startN = current();
            onStart?.();
            this.patchConnection.sendParameterGestureStart (endpointID);
            window.addEventListener ("pointermove", onMove);
            window.addEventListener ("pointerup", onUp);
        };

        element.ondblclick = () => this.sendValue (endpointID, info.init ?? info.min);

        element.onwheel = (e) =>
        {
            e.preventDefault();
            this.sendValue (endpointID, fromNormalised (info, current() - e.deltaY / 1200));
        };
    }

    createKnob (endpointID, label, size)
    {
        const info = this.paramInfo[endpointID];
        const element = document.createElement ("div");
        element.className = "sm-knob";

        if (! info)
            return element;

        const [tickX1, tickY1] = polar (arcRadius + 3, 270), [tickX2, tickY2] = polar (arcRadius + 6, 270);

        element.innerHTML = `
            <div class="sm-dial" style="width: ${size}px; height: ${size}px">
                <svg viewBox="0 0 ${knobBox} ${knobBox}">
                    <path class="sm-trench" d="${arcPath (arcStart, arcEnd)}"/>
                    <path class="sm-arc"/>
                    <line class="sm-zero-tick" x1="${tickX1}" y1="${tickY1}" x2="${tickX2}" y2="${tickY2}"/>
                    <circle class="sm-face" cx="${knobCentre}" cy="${knobCentre}" r="${faceRadius}"/>
                    <circle class="sm-face-edge" cx="${knobCentre}" cy="${knobCentre}" r="${faceRadius}"/>
                    <line class="sm-pointer"/>
                </svg>
            </div>
            <div class="sm-caption"><span class="sm-label">${label}</span><span class="sm-value"></span></div>`;

        const arc = element.querySelector (".sm-arc");
        const pointer = element.querySelector (".sm-pointer");
        const valueText = element.querySelector (".sm-value");

        // controls that go both ways (shift, tilt, level) draw their arc out from the top,
        // with a tick there to mark zero
        const isBipolar = info.min < 0 && info.max > 0;
        const zero = isBipolar ? toNormalised (info, 0) : 0;
        element.querySelector (".sm-zero-tick").style.display = isBipolar ? "" : "none";

        const toAngle = (n) => arcStart + n * (arcEnd - arcStart);
        const isActive = () => element.matches (":hover") || element.classList.contains ("is-dragging");

        this.addUpdater (endpointID, (value) =>
        {
            const n = toNormalised (info, value);
            const from = toAngle (Math.min (n, zero)), to = toAngle (Math.max (n, zero));
            arc.setAttribute ("d", to - from > 0.5 ? arcPath (from, to) : "");

            const [x1, y1] = polar (pointerIn, toAngle (n)), [x2, y2] = polar (pointerOut, toAngle (n));
            pointer.setAttribute ("x1", x1); pointer.setAttribute ("y1", y1);
            pointer.setAttribute ("x2", x2); pointer.setAttribute ("y2", y2);

            valueText.textContent = formatValue (info, value);

            if (isActive())
                this.showValueTip (endpointID);
        });

        this.attachDrag (element.querySelector (".sm-dial"), endpointID, 180,
                         () => element.classList.add ("is-dragging"),
                         () => { element.classList.remove ("is-dragging"); if (! isActive()) this.showTip (""); });

        element.onpointerenter = () => this.showValueTip (endpointID);
        element.onpointerleave = () => { if (! isActive()) this.showTip (""); };

        return element;
    }

    // A choice shown in large type between two arrows that step through it; scrolling over
    // it steps too
    createStepper (endpointID, className)
    {
        const info = this.paramInfo[endpointID];
        const element = document.createElement ("div");
        element.className = "sm-stepper " + className;

        if (! info)
            return element;

        element.innerHTML = `
            <button class="sm-step" data-step="-1">${chevronLeft}</button>
            <span class="sm-stepper-value"></span>
            <button class="sm-step" data-step="1">${chevronRight}</button>`;

        const count = info.max - info.min + 1;
        const step = (by) => this.sendValue (endpointID, info.min + ((Math.round (this.getValue (endpointID) - info.min) + by) % count + count) % count);

        for (const button of element.querySelectorAll (".sm-step"))
            button.onclick = () => step (+button.dataset.step);

        element.onwheel = (e) => { e.preventDefault(); step (e.deltaY > 0 ? 1 : -1); };
        element.onpointerenter = () => this.showValueTip (endpointID);
        element.onpointerleave = () => this.showTip ("");

        const valueText = element.querySelector (".sm-stepper-value");

        this.addUpdater (endpointID, (value) =>
        {
            valueText.textContent = formatValue (info, value);

            if (element.matches (":hover"))
                this.showValueTip (endpointID);
        });

        return element;
    }

    // One octave of keys from C, lit where the chosen scale has a note, with the key's own
    // note in the accent
    createPiano()
    {
        const element = document.createElement ("div");
        element.className = "sm-piano";

        const whiteNotes = [0, 2, 4, 5, 7, 9, 11];
        const blackNotes = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]];   // each black key's note, and the white key it sits before
        const keys = [];

        whiteNotes.forEach ((note, i) => keys[note] = Object.assign (document.createElement ("div"), { className: "sm-piano-white", style: `left: ${i / 7 * 100}%` }));
        blackNotes.forEach (([note, before]) => keys[note] = Object.assign (document.createElement ("div"), { className: "sm-piano-black", style: `left: ${before / 7 * 100}%` }));
        element.append (...keys);

        const update = () =>
        {
            const key = Math.round (this.getValue ("key"));
            const mask = scaleMasks[Math.round (this.getValue ("scale"))] ?? scaleMasks[0];

            keys.forEach ((element, note) =>
            {
                const interval = (note - key + 12) % 12;
                element.classList.toggle ("is-in-scale", (mask & (1 << interval)) !== 0);
                element.classList.toggle ("is-root", interval === 0);
            });
        };

        this.addUpdater ("key", update);
        this.addUpdater ("scale", update);
        update();
        return element;
    }

    // A horizontal slider: a groove cut into the bar, lit in the accent from zero to the
    // value, with a handle. Drag it, or click where it should go.
    createSlider (endpointID, label, endLabel)
    {
        const info = this.paramInfo[endpointID];
        const element = document.createElement ("div");
        element.className = "sm-slider-group";

        if (! info)
            return element;

        element.innerHTML = `
            <span class="sm-slider-label">${label}</span>
            <div class="sm-slider"><div class="sm-slider-fill"></div><div class="sm-slider-handle"></div></div>
            ${endLabel ? `<span class="sm-slider-label">${endLabel}</span>` : ""}`;

        const slider = element.querySelector (".sm-slider");
        const fill = element.querySelector (".sm-slider-fill");
        const handle = element.querySelector (".sm-slider-handle");
        const zero = info.min < 0 && info.max > 0 ? toNormalised (info, 0) : 0;
        let isDragging = false;

        this.addUpdater (endpointID, (value) =>
        {
            const n = toNormalised (info, value);
            fill.style.left = (Math.min (n, zero) * 100) + "%";
            fill.style.width = (Math.abs (n - zero) * 100) + "%";
            handle.style.left = (n * 100) + "%";

            if (isDragging || element.matches (":hover"))
                this.showValueTip (endpointID);
        });

        const moveTo = (e) =>
        {
            const rect = slider.getBoundingClientRect();
            this.sendValue (endpointID, fromNormalised (info, (e.clientX - rect.left) / rect.width));
        };

        slider.onpointerdown = (e) =>
        {
            e.preventDefault();
            isDragging = true;
            slider.setPointerCapture (e.pointerId);
            this.patchConnection.sendParameterGestureStart (endpointID);
            moveTo (e);
        };

        slider.onpointermove = (e) => { if (isDragging) moveTo (e); };

        slider.onpointerup = () =>
        {
            isDragging = false;
            this.patchConnection.sendParameterGestureEnd (endpointID);
        };

        slider.ondblclick = () => this.sendValue (endpointID, info.init ?? info.min);

        slider.onwheel = (e) =>
        {
            e.preventDefault();
            this.sendValue (endpointID, fromNormalised (info, toNormalised (info, this.getValue (endpointID)) - e.deltaY / 1200));
        };

        element.onpointerenter = () => this.showValueTip (endpointID);
        element.onpointerleave = () => { if (! isDragging) this.showTip (""); };

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

        for (const update of this.updaters[endpointID] ?? [])
            update (value);

        if (endpointID.endsWith ("Freeze"))
            this.updateFreezeButtons();

        if ((endpointID === "pullMode" || endpointID === "scaleEnabled") && ! this.tipText)
            this.showTip ("");

        if (crossoverIDs.includes (endpointID))
            this.needsRedraw = true;
    }

    getValue (id)
    {
        return this.values[id] ?? this.paramInfo[id]?.init ?? 0;
    }

    //==============================================================================
    getStyle()
    {
        // Resocheck's tokens (its DESIGN.md): a neutral grey ramp and one orange accent, kept
        // for active values. Depth comes from carving: wells recessed with an inner shadow,
        // faces raised inside them with a lit top edge, and panels set into the plate.
        return `
        <style>
            @font-face { font-family: "Geist"; src: url("${fontURL ("GeistVariableVF.ttf")}") format("truetype"); font-weight: 100 900; }
            @font-face { font-family: "Geist Mono"; src: url("${fontURL ("GeistMono.ttf")}") format("truetype"); font-weight: 100 900; }

            smear-view {
                --bg: #0c0c0e;
                --screen: #141414;
                --bar: #1b1b1c;
                --panel-top: #1e1e20;
                --panel-bottom: #19191b;
                --screen-face: linear-gradient(133.44deg, rgba(255,255,255,0.08) 0.835%, rgba(255,255,255,0.035) 36.157%, rgba(255,255,255,0) 36.998%), linear-gradient(rgba(61,61,61,0.2), rgba(0,0,0,0.2)), #141414;
                --stripes: repeating-linear-gradient(135deg, rgba(255,255,255,0.03) 0 0.75px, transparent 0.75px 2.83px);
                --text: #d0d0d0;
                --bright: #e4e4e7;
                --muted: #7a7a7a;
                --muted-readable: #a0a0a6;
                --accent: #ff5900;
                --accent-readable: #ff7d01;
                --ease-out: cubic-bezier(0.23, 1, 0.32, 1);

                display: block;
                width: 100%;
                height: 100%;
                overflow: auto;
                background: var(--bg);
                color: var(--text);
                font-family: "Geist", "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
                font-variant-numeric: tabular-nums;
                user-select: none;
                -webkit-user-select: none;
            }

            smear-view * { box-sizing: border-box; font-family: inherit; }
            smear-view h2 { margin: 0; }
            smear-view button { font: inherit; color: inherit; }
            .sm-defs { position: absolute; }

            .sm-root { min-width: 1040px; height: 100%; min-height: 780px; display: flex; flex-direction: column; background: var(--bg); }

            /* the bars at the top and bottom */
            .sm-navbar, .sm-bottom { position: relative; z-index: 1; flex: none; display: flex; align-items: center; padding: 0 16px; background: var(--bar); }
            .sm-navbar { height: 46px; justify-content: space-between; border-bottom: 1px solid #000; box-shadow: 0 1px 0 rgba(255,255,255,0.04); }
            .sm-wordmark { font-size: 21px; font-weight: 800; letter-spacing: 0.14em; color: var(--bright); }
            .sm-nav-end { display: flex; align-items: center; gap: 18px; }
            .sm-brand { font-size: 11px; font-weight: 800; letter-spacing: 0.1em; color: var(--text); }

            /* the readout: a well in the navbar, like Resocheck's preset field */
            .sm-readout { position: absolute; left: 50%; top: 8px; width: 300px; height: 30px; margin-left: -150px; display: flex; align-items: center; justify-content: center;
                          border-radius: 10px; background: var(--bg); box-shadow: 0 1px 0 rgba(255,255,255,0.08), inset 0 2px 4px rgba(0,0,0,0.75);
                          font-size: 12px; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; }

            /* the plate the panels are set into */
            .sm-plate { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 216px minmax(0, 1fr) 196px; grid-template-rows: minmax(0, 1fr) auto auto;
                        gap: 12px; padding: 14px 16px; }
            .sm-scale { grid-column: 1; grid-row: 1 / 4; }
            .sm-lfo { grid-column: 2 / 4; grid-row: 3; }
            .sm-screen { grid-column: 2 / 4; grid-row: 1; }
            .sm-bands { grid-column: 2; grid-row: 2; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
            .sm-side { grid-column: 3; grid-row: 2; display: flex; flex-direction: column; gap: 12px; }
            .sm-side .sm-panel { flex: 1; }

            /* a panel: Resocheck's strip panel, the knobs' home. It stands up off the dark
               ground on its shadows (a faint glow above, a deep shadow below and a lit lip),
               with its fine diagonal texture. Only displays are screens. */
            .sm-panel { min-width: 0; display: flex; flex-direction: column; padding: 10px 12px 10px 14px; border-radius: 14px; border: 1px solid #000;
                        background: var(--stripes), linear-gradient(var(--panel-top), var(--panel-bottom));
                        box-shadow: 0 -3px 6.7px rgba(123,123,123,0.15), 0 4px 12px rgba(0,0,0,0.65), 0 1px 0 rgba(255,255,255,0.13), inset 0 1px 0 rgba(255,255,255,0.05); }

            /* a screen: Resocheck's screen face, with the hard-edged sweep of light across it */
            .sm-screen, .sm-scale-screen, .sm-lfo-screen { border: 1px solid #000; background: var(--screen-face);
                                           box-shadow: 0 1px 0 rgba(255,255,255,0.1), inset 0 2px 8px rgba(0,0,0,0.45); }
            .sm-screen { border-radius: 14px; }
            .sm-panel-head { display: flex; align-items: center; justify-content: space-between; height: 30px; margin-bottom: 6px; }
            .sm-panel-head h2 { font-size: 10px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted-readable); }

            /* the spectrum's screen */
            .sm-screen { min-height: 0; display: flex; overflow: hidden; }
            .sm-spectrum { display: block; flex: 1; width: 100%; height: 100%; touch-action: none; }

            /* the big knob, and the small ones in pairs under it */
            .sm-hero { display: flex; justify-content: center; }
            .sm-knob-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 6px; justify-items: center; }
            .sm-band .sm-hero { margin-bottom: 6px; }
            .sm-side .sm-knob-grid { flex: 1; align-content: center; }
            .sm-tone .sm-knob-grid { grid-template-columns: 1fr; }

            /* the scale: the key and scale in large type on a screen, then Pull */
            .sm-scale { justify-content: space-between; }
            .sm-scale-screen { flex: 1; display: flex; flex-direction: column; align-items: stretch; justify-content: center; gap: 10px; margin: 4px 0 18px; padding: 0 0 4px;
                               border-radius: 10px; }
            .sm-stepper { display: flex; align-items: center; justify-content: space-between; padding: 0 6px; cursor: ns-resize; }
            .sm-stepper-value { flex: 1; text-align: center; white-space: nowrap; }
            .sm-stepper-key .sm-stepper-value { font-size: 56px; font-weight: 300; line-height: 1; color: var(--bright); }
            .sm-stepper-scale .sm-stepper-value { font-size: 12px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text); }
            .sm-step { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--muted); cursor: pointer;
                       transition: color 160ms var(--ease-out), background-color 160ms var(--ease-out); }
            .sm-step:hover { color: var(--bright); background: rgba(255,255,255,0.05); }
            .sm-step svg { display: block; width: 100%; height: 100%; }
            .sm-scale .sm-hero { padding-bottom: 6px; }

            /* the LFO: its shape on a small screen, then its knobs in a row, with the three
               amounts it moves the bands by set apart behind a thin rule */
            .sm-head-buttons { display: flex; gap: 8px; }

            /* the modulation panel's two pages, LFO and Envelope, picked by the tabs in its head;
               a tab's dot lights while its source is moving something */
            .sm-lfo[data-page="lfo"] .sm-page-env, .sm-lfo[data-page="env"] .sm-page-lfo { display: none; }
            .sm-tabs { display: flex; gap: 18px; }
            .sm-tab { position: relative; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0; border: 0; background: none; cursor: pointer;
                      font-size: 10px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted);
                      transition: color 160ms var(--ease-out); }
            .sm-tab:hover { color: var(--text); background: none; }
            .sm-tab:focus { outline: none; }
            .sm-tab::after { content: ""; position: absolute; left: 0; right: 0; bottom: 4px; height: 1px; background: var(--accent); opacity: 0;
                             transition: opacity 160ms var(--ease-out); }
            .sm-lfo[data-page="lfo"] .sm-tab[data-page="lfo"], .sm-lfo[data-page="env"] .sm-tab[data-page="env"] { color: var(--bright); }
            .sm-lfo[data-page="lfo"] .sm-tab[data-page="lfo"]::after, .sm-lfo[data-page="env"] .sm-tab[data-page="env"]::after { opacity: 1; }
            .sm-tab-dot { width: 5px; height: 5px; border-radius: 50%; background: #383838; transition: background-color 160ms var(--ease-out); }
            .sm-tab.is-live .sm-tab-dot { background: var(--accent); }

            /* the scale panel while its switch is off: everything but the head dims */
            .sm-scale-screen, .sm-scale .sm-hero { transition: opacity 160ms var(--ease-out); }
            .sm-scale.is-off .sm-scale-screen, .sm-scale.is-off .sm-hero { opacity: 0.4; }
            .sm-lfo-body { display: flex; align-items: center; gap: 16px; }
            .sm-lfo-screen { flex: none; width: 180px; height: 64px; border-radius: 10px; overflow: hidden; }
            .sm-lfo-shape { display: block; width: 100%; height: 100%; }
            .sm-lfo-knobs { flex: 1; min-width: 0; display: flex; justify-content: space-between; }
            .sm-knob-first-target { margin-left: 6px; padding-left: 14px; border-left: 1px solid rgba(255,255,255,0.06); }

            /* the octave of keys under the scale's name */
            .sm-piano { position: relative; height: 54px; margin: 8px 18px 0; }
            .sm-piano-white, .sm-piano-black { position: absolute; top: 0; border-radius: 0 0 3px 3px; transition: background-color 160ms var(--ease-out); }
            .sm-piano-white { width: calc(100% / 7 - 2px); height: 100%; margin-left: 1px; background: #262628; box-shadow: inset 0 1px 0 rgba(255,255,255,0.05); }
            .sm-piano-black { z-index: 1; width: calc(100% / 7 * 0.6); height: 58%; margin-left: calc(100% / 7 * -0.3); background: #1b1b1c; box-shadow: 0 0 0 1.5px #0c0c0e; }
            .sm-piano-white.is-in-scale { background: var(--text); }
            .sm-piano-black.is-in-scale { background: #8c8c90; }
            .sm-piano-white.is-root, .sm-piano-black.is-root { background: var(--accent); }

            /* carve controls: a 95 x 30 well, and a lit face 2px inside it */
            .sm-carve { width: 95px; height: 30px; flex: none; padding: 2px; border: 0; border-radius: 10px; cursor: pointer; background: var(--bg);
                        box-shadow: 0 1px 0 rgba(255,255,255,0.13), inset 0 2px 4px rgba(0,0,0,0.75); }
            .sm-band .sm-carve { width: 76px; }
            .sm-carve-face { position: relative; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
                             border-radius: 8px; background: #28282a; box-shadow: inset 0 1px 0 rgba(255,255,255,0.07);
                             font-size: 10px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted);
                             transition: transform 160ms var(--ease-out), background-color 160ms var(--ease-out), color 160ms var(--ease-out); }
            .sm-carve:hover .sm-carve-face { background: #2e2e30; }
            .sm-carve:active .sm-carve-face { transform: scale(0.98); }
            .sm-carve.is-on .sm-carve-face { color: #fff; }

            /* the carve sheen: two soft glints on the face's own 1px edge, top right and bottom left */
            .sm-carve-face::after { content: ""; position: absolute; inset: 0; border-radius: 8px; padding: 1px; pointer-events: none;
                                    background: radial-gradient(32px 18px at calc(100% - 10px) 1px, rgba(217,217,217,0.15), transparent),
                                                radial-gradient(40px 22px at 4px calc(100% - 1px), rgba(217,217,217,0.23), transparent);
                                    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
                                    -webkit-mask-composite: xor; mask-composite: exclude; }

            /* knobs */
            .sm-knob { min-width: 60px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
            .sm-dial { margin: 3px 0; cursor: ns-resize; touch-action: none; }
            .sm-dial svg { display: block; width: 100%; height: 100%; overflow: visible; }
            .sm-trench { fill: none; stroke: #383838; stroke-width: ${arcWidth}; }
            .sm-arc { fill: none; stroke: #d0d0d0; stroke-width: ${arcWidth}; }
            .sm-zero-tick { stroke: #d0d0d0; stroke-width: 1; }
            .sm-face { fill: url(#sm-face); filter: url(#sm-face-shadow); }
            .sm-face-edge { fill: none; stroke: rgba(208,208,208,0.16); stroke-width: 1; }
            .sm-pointer { stroke: #d0d0d0; stroke-width: 1.6; stroke-linecap: round; }

            /* the caption, which turns into the value while the knob is under the pointer */
            .sm-caption { position: relative; height: 18px; width: 100%; display: flex; align-items: center; justify-content: center; white-space: nowrap; }
            .sm-label { font-size: 10px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text); }
            .sm-value { position: absolute; font-family: "Geist Mono", ui-monospace, monospace; font-size: 10px; color: #fff; opacity: 0; }
            .sm-knob:hover .sm-label, .sm-knob.is-dragging .sm-label { opacity: 0; }
            .sm-knob:hover .sm-value, .sm-knob.is-dragging .sm-value { opacity: 1; }

            /* the bottom bar: Transients, the dry/wet mix in the middle, and the output */
            .sm-bottom { height: 46px; padding-bottom: 6px; display: grid; grid-template-columns: 1fr auto 1fr; background: none; }
            .sm-bottom-end { display: flex; justify-content: flex-end; }
            .sm-slider-group { display: flex; align-items: center; gap: 12px; }
            .sm-slider-label { font-size: 10px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted-readable); }
            .sm-slider { position: relative; width: 170px; height: 22px; cursor: ew-resize; touch-action: none; }
            .sm-bottom-centre .sm-slider { width: 280px; }
            .sm-slider::before { content: ""; position: absolute; left: 0; right: 0; top: 8px; height: 6px; border-radius: 3px; background: var(--bg);
                                 box-shadow: 0 1px 0 rgba(255,255,255,0.1), inset 0 1px 2px rgba(0,0,0,0.8); }
            .sm-slider-fill { position: absolute; top: 9px; height: 4px; border-radius: 2px; background: var(--accent); }
            .sm-slider-handle { position: absolute; top: 3px; width: 4px; height: 16px; margin-left: -2px; border-radius: 2px; background: var(--bright);
                                box-shadow: 0 1px 3px rgba(0,0,0,0.6); }
        </style>`;
    }
}

//==============================================================================
export default function createPatchView (patchConnection)
{
    const customElementName = "smear-view";

    if (! window.customElements.get (customElementName))
        window.customElements.define (customElementName, SmearView);

    return new (window.customElements.get (customElementName)) (patchConnection);
}
