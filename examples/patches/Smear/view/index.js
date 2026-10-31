
/*
    The GUI for Smear. Under the wordmark and Freeze (which freezes all three bands), the
    output's spectrum is drawn as it plays, from 30Hz on the left to 16kHz on the right,
    with the two crossovers on it as lines you can drag. Below that are the three bands'
    controls side by side, then the crossovers, the scale the spectrum is pulled towards,
    and the output (with how much of each hit is kept clean, and minimum phase).
    Parameter ranges and defaults come from the patch's own annotations.
*/

const bands = [{ id: "low", title: "Low" }, { id: "mid", title: "Mid" }, { id: "high", title: "High" }];
const bandParams = [["Smear", "Smear"], ["Shift", "Shift"], ["Peaks", "Peaks"], ["Scatter", "Scatter"], ["Level", "Level"]];

const globalModules = [
    { title: "Crossovers", params: [["lowCross", "Low"], ["highCross", "High"]] },
    { title: "Scale",      params: [["magnet", "Pull"], ["key", "Key"], ["scale", "Scale"]] },
    { title: "Output",     params: [["transients", "Transients"], ["tilt", "Tilt"], ["mix", "Mix"], ["volume", "Output"]],
      toggle: { id: "phaseMode", label: "Min Phase", title: "Minimum phase: ringing from the reshaping comes after a hit instead of before it" } }
];

const crossoverIDs = ["lowCross", "highCross"];
const spectrumLow = 30, spectrumHigh = 16000;

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
    switch (info.unit)
    {
        case "Hz":      return value >= 1000 ? (value / 1000).toFixed (1) + " kHz" : Math.round (value) + " Hz";
        case "st":      return (value > 0.05 ? "+" : "") + value.toFixed (1) + " st";
        case "dB":      return value <= info.min + 0.1 && info.min <= -36 ? "Off" : value.toFixed (1) + " dB";
        case "dB/oct":  return (value > 0.05 ? "+" : "") + value.toFixed (1) + " dB/oct";
    }

    if (info.text)
        return info.text.split ("|")[Math.round (value - info.min)] ?? "";

    if (info.min === 0 && info.max <= 1)
        return Math.round (value / info.max * 100) + "%";

    return value.toFixed (2);
}

// where a frequency sits across the spectrum display, 0 to 1
const frequencyToX = (f) => Math.log (f / spectrumLow) / Math.log (spectrumHigh / spectrumLow);
const xToFrequency = (x) => spectrumLow * Math.pow (spectrumHigh / spectrumLow, x);

//==============================================================================
class SmearView extends HTMLElement
{
    constructor (patchConnection)
    {
        super();
        this.patchConnection = patchConnection;
        this.values = {};
        this.paramInfo = {};
        this.knobs = {};
        this.spectrum = new Float32Array (64);
        this.hoveredCrossover = null;
        this.isBuilt = false;
        this.innerHTML = this.getStyle() + `<div class="sm-root"></div>`;
    }

    connectedCallback()
    {
        this.statusListener = (status) =>
        {
            if (this.isBuilt)
                return;

            for (const input of status?.details?.inputs ?? [])
                if (input.annotation)
                    this.paramInfo[input.endpointID] = { ...input.annotation, step: input.annotation.step ?? (input.annotation.text ? 1 : 0) };

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
        this.patchConnection.addEndpointListener ("spectrumOut", this.spectrumListener);
        window.addEventListener ("keydown", this.keyListener);
        this.patchConnection.requestStatusUpdate();

        const animate = () =>
        {
            if (this.needsRedraw)
            {
                this.needsRedraw = false;
                this.drawSpectrum();
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
        this.patchConnection.removeEndpointListener ("spectrumOut", this.spectrumListener);
        window.removeEventListener ("keydown", this.keyListener);
    }

    //==============================================================================
    build()
    {
        const root = this.querySelector (".sm-root");

        root.innerHTML = `
            <header class="sm-head">
                <div class="sm-title">
                    <h1>SMEAR</h1>
                    <button class="sm-freeze sm-freeze-all" title="Freeze all three bands (Space or F)">Freeze</button>
                </div>
                <canvas class="sm-spectrum" title="Drag a line to move that crossover"></canvas>
            </header>
            <div class="sm-bands"></div>
            <div class="sm-globals"></div>`;

        this.spectrumCanvas = root.querySelector (".sm-spectrum");
        root.querySelector (".sm-freeze-all").onclick = () => this.toggleFreezeAll();
        this.attachCrossoverHandlers (this.spectrumCanvas);

        const bandContainer = root.querySelector (".sm-bands");

        for (const band of bands)
        {
            const element = document.createElement ("section");
            element.className = "sm-module";
            element.innerHTML = `
                <div class="sm-module-head">
                    <h2>${band.title}</h2>
                    <button class="sm-freeze sm-band-freeze" data-band="${band.id}">Freeze</button>
                </div>
                <div class="sm-knob-row"></div>`;

            element.querySelector (".sm-band-freeze").onclick = () => this.toggleFreeze (band.id);

            for (const [suffix, label] of bandParams)
                element.querySelector (".sm-knob-row").appendChild (this.createKnob (band.id + suffix, label));

            bandContainer.appendChild (element);
        }

        const globalContainer = root.querySelector (".sm-globals");

        for (const module of globalModules)
        {
            const element = document.createElement ("section");
            element.className = "sm-module";
            element.style.flexGrow = module.params.length;
            const toggle = module.toggle ? `<button class="sm-freeze sm-toggle" data-id="${module.toggle.id}" title="${module.toggle.title}">${module.toggle.label}</button>` : "";
            element.innerHTML = `<div class="sm-module-head"><h2>${module.title}</h2>${toggle}</div><div class="sm-knob-row"></div>`;

            if (module.toggle)
                element.querySelector (".sm-toggle").onclick = () => this.sendValue (module.toggle.id, Math.round (this.getValue (module.toggle.id)) === 1 ? 0 : 1);

            for (const [id, label] of module.params)
                element.querySelector (".sm-knob-row").appendChild (this.createKnob (id, label));

            globalContainer.appendChild (element);
        }

        new ResizeObserver (() => this.drawSpectrum()).observe (root);
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

            const hovered = findCrossover (e);
            canvas.style.cursor = hovered ? "ew-resize" : "default";

            if (hovered !== this.hoveredCrossover)
            {
                this.hoveredCrossover = hovered;
                this.needsRedraw = true;
            }
        };

        canvas.onpointerup = () =>
        {
            if (dragging)
                this.patchConnection.sendParameterGestureEnd (dragging);

            dragging = null;
        };

        canvas.onpointerleave = () =>
        {
            if (! dragging && this.hoveredCrossover)
            {
                this.hoveredCrossover = null;
                this.needsRedraw = true;
            }
        };
    }

    // The spectrum as one filled shape rising from the bottom edge, lows on the left, with
    // the crossovers drawn over it
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

        const style = getComputedStyle (this);
        const n = this.spectrum.length;
        const toX = (i) => i / (n - 1) * w;
        const toY = (i) => h - this.spectrum[i] * h;

        // a smooth line through the bands, using each pair's midpoint as the join
        g.beginPath();
        g.moveTo (0, h);
        g.lineTo (toX (0), toY (0));

        for (let i = 1; i < n - 1; ++i)
            g.quadraticCurveTo (toX (i), toY (i), (toX (i) + toX (i + 1)) / 2, (toY (i) + toY (i + 1)) / 2);

        g.lineTo (toX (n - 1), toY (n - 1));
        g.lineTo (w, h);
        g.closePath();
        g.fillStyle = style.getPropertyValue ("--accent").trim();
        g.fill();

        g.fillStyle = style.getPropertyValue ("--text").trim();
        g.font = "700 12px Inter, 'Segoe UI', system-ui, sans-serif";
        g.textBaseline = "top";

        for (const id of crossoverIDs)
        {
            const value = this.getValue (id);
            const x = Math.round (frequencyToX (value) * w);
            const isHot = this.hoveredCrossover === id;

            g.fillRect (x - (isHot ? 2 : 1), 0, isHot ? 4 : 2, h);
            g.fillText (formatValue (this.paramInfo[id] ?? { unit: "Hz" }, value), x + 8, 10);
        }
    }

    //==============================================================================
    createKnob (endpointID, label)
    {
        const info = this.paramInfo[endpointID];
        const element = document.createElement ("div");
        element.className = "sm-knob";

        if (! info)
            return element;

        element.title = info.name;
        element.innerHTML = `
            <div class="sm-dial">
                <svg viewBox="0 0 60 60"><path class="sm-track"/><path class="sm-arc"/></svg>
                <div class="sm-cap"></div>
            </div>
            <div class="sm-value"></div>
            <div class="sm-label">${label}</div>`;

        const dial = element.querySelector (".sm-dial");
        const cap = element.querySelector (".sm-cap");
        const arc = element.querySelector (".sm-arc");
        const valueText = element.querySelector (".sm-value");

        // controls that go both ways (shift, tilt, level) draw their arc out from zero
        const zero = info.min < 0 && info.max > 0 ? toNormalised (info, 0) : 0;

        const arcPath = (from, to) =>
        {
            const start = -135 + 270 * Math.min (from, to), end = -135 + 270 * Math.max (from, to);
            const toPoint = (deg) => [30 + 25 * Math.sin (deg * Math.PI / 180), 30 - 25 * Math.cos (deg * Math.PI / 180)];
            const [x1, y1] = toPoint (start), [x2, y2] = toPoint (end);
            return `M ${x1.toFixed (2)} ${y1.toFixed (2)} A 25 25 0 ${end - start > 180 ? 1 : 0} 1 ${x2.toFixed (2)} ${y2.toFixed (2)}`;
        };

        element.querySelector (".sm-track").setAttribute ("d", arcPath (0, 1));

        this.knobs[endpointID] = (value) =>
        {
            const n = toNormalised (info, value);
            arc.setAttribute ("d", arcPath (zero, Math.abs (n - zero) < 0.002 ? zero + 0.002 : n));
            cap.style.transform = `rotate(${-135 + 270 * n}deg)`;
            valueText.textContent = formatValue (info, value);
        };

        const current = () => toNormalised (info, this.values[endpointID] ?? info.init ?? info.min);
        let startY = 0, startN = 0;

        const onMove = (e) => this.sendValue (endpointID, fromNormalised (info, startN + (startY - e.clientY) / (e.shiftKey ? 900 : 180)));

        const onUp = () =>
        {
            window.removeEventListener ("pointermove", onMove);
            window.removeEventListener ("pointerup", onUp);
            this.patchConnection.sendParameterGestureEnd (endpointID);
        };

        dial.onpointerdown = (e) =>
        {
            e.preventDefault();
            startY = e.clientY;
            startN = current();
            this.patchConnection.sendParameterGestureStart (endpointID);
            window.addEventListener ("pointermove", onMove);
            window.addEventListener ("pointerup", onUp);
        };

        dial.ondblclick = () => this.sendValue (endpointID, info.init ?? info.min);

        dial.onwheel = (e) =>
        {
            e.preventDefault();
            this.sendValue (endpointID, fromNormalised (info, current() - e.deltaY / 1200));
        };

        this.knobs[endpointID] (info.init ?? info.min);
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
        this.knobs[endpointID]?.(value);

        this.querySelectorAll (`.sm-toggle[data-id="${endpointID}"]`).forEach (button => button.classList.toggle ("is-on", Math.round (value) === 1));

        if (endpointID.endsWith ("Freeze"))
            this.updateFreezeButtons();

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
        // The same palette as Rumble: one ground, one panel, one raised tone, one text colour
        // and one accent. Three full-width bands alternating panel and ground; settings in the
        // text colour, the accent kept for what moves in time: the spectrum, and Freeze while on.
        return `
        <style>
            smear-view {
                --ground: #0d0c0b;
                --panel: #191818;
                --raised: #2b2a29;
                --text: #f1f0ee;
                --accent: #ff8a1c;

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

            smear-view * { box-sizing: border-box; font-family: inherit; }
            smear-view h1, smear-view h2 { margin: 0; }
            smear-view button { cursor: pointer; border: 0; padding: 0; font-weight: 800; color: var(--text); background: var(--raised); }
            smear-view button:active { transform: translateY(1px); }

            .sm-root { min-width: 1040px; display: flex; flex-direction: column; }

            /* the wordmark and Freeze, with the spectrum running along the bottom */
            .sm-head { display: flex; flex-direction: column; background: var(--panel); }
            .sm-title { display: flex; align-items: center; justify-content: space-between; padding: 22px 28px 14px; }
            .sm-title h1 { font-size: 104px; font-weight: 900; line-height: 0.9; letter-spacing: -0.02em; }
            .sm-freeze-all { width: 104px; height: 56px; font-size: 18px; }
            .sm-freeze.is-on { background: var(--accent); color: var(--ground); }
            .sm-spectrum { display: block; width: 100%; height: 168px; touch-action: none; }

            /* the three bands on the ground, then the crossovers and output on the panel */
            .sm-bands { display: flex; gap: 36px; padding: 22px 28px 24px; }
            .sm-globals { display: flex; gap: 36px; padding: 22px 28px 24px; background: var(--panel); }
            .sm-bands .sm-module { flex: 1 1 0; }
            .sm-module { flex-basis: 0; min-width: 0; }
            .sm-module-head { display: flex; align-items: center; justify-content: space-between; height: 28px; margin-bottom: 8px; }
            .sm-module-head h2 { font-size: 18px; font-weight: 900; }
            .sm-band-freeze, .sm-toggle { height: 26px; padding: 0 12px !important; font-size: 12px; }

            .sm-knob-row { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; justify-items: center; }

            .sm-knob { width: 58px; display: flex; flex-direction: column; align-items: center; }
            .sm-dial { position: relative; width: 54px; height: 54px; cursor: ns-resize; touch-action: none; }
            .sm-dial svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
            .sm-track { fill: none; stroke: var(--raised); stroke-width: 5; }
            .sm-arc { fill: none; stroke: var(--text); stroke-width: 5; }
            .sm-cap { position: absolute; left: 50%; top: 50%; width: 32px; height: 32px; margin: -16px 0 0 -16px; border-radius: 50%; background: var(--text); }
            .sm-cap::after { content: ""; position: absolute; left: 50%; top: 4px; width: 3px; height: 10px; margin-left: -1.5px; background: var(--ground); }
            .sm-value { font-size: 12px; font-weight: 700; line-height: 16px; margin-top: 4px; white-space: nowrap; }
            .sm-label { font-size: 12px; line-height: 15px; white-space: nowrap; }
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
