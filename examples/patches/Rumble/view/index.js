
/*
    The GUI for Rumble. Beside the wordmark, tectonic plates grind with the rumble's level
    and blow apart on every kick; under it, a seismograph draws the level as it plays, so
    you can watch it swell and duck around every kick. Below that are the sound controls,
    the shape and pitch (curves you draw, which set the level and bend the pitch after
    every trigger), and the 16 trigger steps (click or drag to paint them).
    Parameter ranges and defaults come from the patch's own annotations.
*/

const modules = [
    { title: "Kick",  params: [["note", "Note"], ["punch", "Punch"], ["body", "Body"]] },
    { title: "Space", params: [["space", "Amount"], ["preDelay", "Pre-delay"], ["tail", "Tail"], ["size", "Size"], ["damp", "Damp"], ["width", "Width"]] },
    { title: "Dirt",  params: [["drive", "Drive"], ["lowCut", "Low Cut"], ["highCut", "High Cut"], ["resonance", "Reso"]] }
];

const shapeParams = [["shapeDepth", "Depth"], ["shapeLength", "Length"], ["shapeFilter", "Filter"], ["pitchBend", "Bend"]];
const sequencerParams = [["bpm", "BPM"], ["kickLevel", "Kick"], ["volume", "Volume"]];

const midiInputEndpointID = "midiIn";
const historySeconds = 4;
const levelsPerSecond = 60;

//==============================================================================
// Curves: lists of {x, y, tension} points with x and y in 0..1. These match
// rumble::Curve and rumble::evaluateCurve() in Rumble.cmajor.
const maxCurvePoints = 16;
const point = (x, y, tension = 0) => ({ x, y, tension });

// the same sidechain-style duck as rumble::getDefaultShape()
const defaultShape = () => [point (0, 1, 2), point (0.111, 0.5, -2), point (0.222, 0, 2),
                            point (0.332, 0.5, -2), point (0.443, 1), point (1, 1)];

// no bend: the pitch curve rests along the middle, as in rumble::getDefaultPitch()
const defaultPitch = () => [point (0, 0.5), point (1, 0.5)];

function shapeSegment (p, tension)
{
    return Math.abs (tension) < 0.001 ? p : (Math.exp (tension * p) - 1) / (Math.exp (tension) - 1);
}

function evaluateCurve (points, t)
{
    if (t <= points[0].x)                   return points[0].y;
    if (t >= points[points.length - 1].x)   return points[points.length - 1].y;

    for (let i = 0; i < points.length - 1; ++i)
    {
        const a = points[i], b = points[i + 1];

        if (t < b.x)
            return a.y + (b.y - a.y) * shapeSegment ((t - a.x) / Math.max (b.x - a.x, 1e-6), a.tension ?? 0);
    }

    return points[points.length - 1].y;
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

const clampTension = (t) => Math.min (12, Math.max (-12, t));

//==============================================================================
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

function noteName (note)
{
    note = Math.round (note);
    return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][((note % 12) + 12) % 12] + (Math.floor (note / 12) - 2);
}

function formatValue (info, value)
{
    switch (info.unit)
    {
        case "Hz":   return value >= 1000 ? (value / 1000).toFixed (1) + " kHz" : Math.round (value) + " Hz";
        case "s":    return value < 1 ? Math.round (value * 1000) + " ms" : value.toFixed (1) + " s";
        case "st":   return Math.round (value) + " st";
        case "dB":   return value.toFixed (1) + " dB";
        case "note": return noteName (value);
    }

    if (info.text)
        return info.text.split ("|")[Math.round (value - info.min)] ?? "";

    if (info.step)
        return String (Math.round (value));

    if (info.min === 0 && info.max <= 1)
        return Math.round (value / info.max * 100) + "%";

    return value.toFixed (2);
}

//==============================================================================
// Plates: the strip beside the wordmark is cut into plates along jagged fault lines. The
// rumble's level keeps neighbouring plates grinding past each other, and every kick throws
// them apart and sprays shards out of the faults.
const numPlates = 9;
const pointsPerFault = 6;

function createPlates()
{
    // fault lines in 0..1 across and down the strip; the two outer edges are straight
    const faults = [];

    for (let i = 0; i <= numPlates; ++i)
    {
        const isEdge = i === 0 || i === numPlates;

        faults.push (Array.from ({ length: pointsPerFault }, (_, j) => ({
            x: i / numPlates + (isEdge ? 0 : (Math.random() - 0.5) * 0.7 / numPlates),
            y: j / (pointsPerFault - 1)
        })));
    }

    const plates = Array.from ({ length: numPlates }, (_, i) => ({
        y: 0, velocity: 0, angle: 0, spin: 0,
        rate: 0.8 + Math.random() * 1.6,
        phase: Math.random() * Math.PI * 2,
        direction: i % 2 ? 1 : -1
    }));

    return { faults, plates, shards: [], time: 0 };
}

//==============================================================================
class RumbleView extends HTMLElement
{
    constructor (patchConnection)
    {
        super();
        this.patchConnection = patchConnection;
        this.values = {};
        this.paramInfo = {};
        this.knobs = {};
        this.levels = new Float32Array (historySeconds * levelsPerSecond);
        this.tectonics = createPlates();
        // Each editor has its shared curve, a list of the steps' own curves (null where a step
        // has none), and the points on show: the shared curve, or the edited step's own.
        this.curves = [{ key: "shape", title: "Shape", stepKey: "stepShapes", stepEndpoint: "stepShape",
                         shared: defaultShape(), makeDefault: defaultShape, restingY: 0 },
                       { key: "pitch", title: "Pitch", stepKey: "stepPitches", stepEndpoint: "stepPitch",
                         shared: defaultPitch(), makeDefault: defaultPitch, restingY: 0.5 }];

        for (const editor of this.curves)
        {
            editor.points = editor.shared;
            editor.stepCurves = new Array (16).fill (null);
            editor.hover = null;
        }

        this.editedStep = null;   // the step whose own curves are being edited, or null for the shared ones
        this.shapePhase = null;
        this.isBuilt = false;
        this.innerHTML = this.getStyle() + `<div class="rb-root"></div>`;
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

            for (const editor of this.curves)
            {
                this.patchConnection.requestStoredStateValue (editor.key);
                this.patchConnection.requestStoredStateValue (editor.stepKey);
            }
        };

        this.storedStateListener = (event) =>
        {
            const toPoints = (list) => Array.isArray (list) && list.length >= 2 ? list.map (p => point (p.x, p.y, p.tension ?? 0)) : null;

            for (const editor of this.curves)
            {
                if (event?.key === editor.key && toPoints (event.value))
                    editor.shared = toPoints (event.value);
                else if (event?.key === editor.stepKey && Array.isArray (event.value))
                    editor.stepCurves = Array.from ({ length: 16 }, (_, i) => toPoints (event.value[i]));
            }

            this.showCurvesFor (this.editedStep);
        };

        this.shapePhaseListener = (phase) =>
        {
            this.shapePhase = phase;
            this.hasNewLevels = true;
        };

        this.paramListener = (event) => this.setDisplayedValue (event.endpointID, event.value);

        this.stepListener = (step) =>
        {
            this.currentStep = step;
            this.updateSteps();

            if (this.isStepOn (step))
                this.quake();
        };

        // each new level pushes the history along by one
        this.levelListener = (level) =>
        {
            this.levels.copyWithin (0, 1);
            this.levels[this.levels.length - 1] = level;
            this.hasNewLevels = true;
        };

        this.keyListener = (e) =>
        {
            if (e.repeat || e.ctrlKey || e.metaKey || e.altKey)
                return;

            if (e.code === "Space")
            {
                e.preventDefault();
                this.sendValue ("run", Math.round (this.getValue ("run")) ? 0 : 1);
            }
            else if (e.key.toLowerCase() === "x")
            {
                this.hit();
            }
        };

        this.patchConnection.addStatusListener (this.statusListener);
        this.patchConnection.addAllParameterListener (this.paramListener);
        this.patchConnection.addEndpointListener ("currentStep", this.stepListener);
        this.patchConnection.addEndpointListener ("levelOut", this.levelListener);
        this.patchConnection.addEndpointListener ("shapePhase", this.shapePhaseListener);
        this.patchConnection.addStoredStateValueListener (this.storedStateListener);
        window.addEventListener ("keydown", this.keyListener);
        this.patchConnection.requestStatusUpdate();

        let lastFrameTime = performance.now();

        const animate = (now = performance.now()) =>
        {
            this.drawPlates (Math.min (0.05, (now - lastFrameTime) / 1000));
            lastFrameTime = now;

            if (this.hasNewLevels)
            {
                this.hasNewLevels = false;
                this.drawSeismograph();
                this.drawCurves();
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
        this.patchConnection.removeEndpointListener ("currentStep", this.stepListener);
        this.patchConnection.removeEndpointListener ("levelOut", this.levelListener);
        this.patchConnection.removeEndpointListener ("shapePhase", this.shapePhaseListener);
        this.patchConnection.removeStoredStateValueListener (this.storedStateListener);
        window.removeEventListener ("keydown", this.keyListener);
    }

    //==============================================================================
    build()
    {
        const root = this.querySelector (".rb-root");

        root.innerHTML = `
            <header class="rb-head">
                <div class="rb-title">
                    <h1>RUMBLE</h1>
                    <canvas class="rb-plates"></canvas>
                    <div class="rb-transport">
                        <button class="rb-run" title="Space">Run</button>
                        <button class="rb-hit" title="X">Hit</button>
                    </div>
                </div>
                <canvas class="rb-seismograph"></canvas>
            </header>
            <div class="rb-modules"></div>
            <div class="rb-shape">
                <div class="rb-shape-editor rb-curve">
                    <div class="rb-module-head">
                        <h2>Shape</h2>
                        <button class="rb-text-button" title="Back to the default duck">Reset</button>
                    </div>
                    <div class="rb-shape-plot">
                        <canvas title="Click to add a point, drag to move it, drag a midpoint to bend, double-click to remove"></canvas>
                    </div>
                </div>
                <div class="rb-shape-editor rb-curve">
                    <div class="rb-module-head">
                        <h2>Pitch</h2>
                        <button class="rb-text-button" title="Back to no bend">Reset</button>
                    </div>
                    <div class="rb-shape-plot">
                        <canvas title="Above the middle bends up and below bends down, by up to Bend. Click to add a point, drag to move it, drag a midpoint to bend, double-click to remove"></canvas>
                    </div>
                </div>
                <div class="rb-knob-row rb-shape-knobs"></div>
            </div>
            <div class="rb-sequencer">
                <div class="rb-steps"></div>
                <button class="rb-icon" title="New pattern">
                    <svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7" cy="7" r="1.3"/><circle cx="13" cy="13" r="1.3"/><circle cx="13" cy="7" r="1.3"/><circle cx="7" cy="13" r="1.3"/><circle cx="10" cy="10" r="1.3"/></svg>
                </button>
                <div class="rb-knob-row rb-sequencer-knobs"></div>
            </div>`;

        this.seismograph = root.querySelector (".rb-seismograph");
        this.platesCanvas = root.querySelector (".rb-plates");

        root.querySelector (".rb-run").onclick = () => this.sendValue ("run", Math.round (this.getValue ("run")) ? 0 : 1);
        root.querySelector (".rb-hit").onpointerdown = () => this.hit();
        root.querySelector (".rb-icon").onclick = () => this.newPattern();

        const moduleContainer = root.querySelector (".rb-modules");

        for (const module of modules)
        {
            const element = document.createElement ("section");
            element.className = "rb-module";
            element.style.flexGrow = module.params.length;
            element.innerHTML = `<div class="rb-module-head"><h2>${module.title}</h2></div><div class="rb-knob-row"></div>`;

            for (const [id, label] of module.params)
                element.querySelector (".rb-knob-row").appendChild (this.createKnob (id, label));

            moduleContainer.appendChild (element);
        }

        const shapeKnobs = root.querySelector (".rb-shape-knobs");

        for (const [id, label] of shapeParams)
            shapeKnobs.appendChild (this.createKnob (id, label));

        const sequencerKnobs = root.querySelector (".rb-sequencer-knobs");

        for (const [id, label] of sequencerParams)
            sequencerKnobs.appendChild (this.createKnob (id, label));

        this.buildSteps (root.querySelector (".rb-steps"));

        root.querySelectorAll (".rb-curve").forEach ((element, i) =>
        {
            const editor = this.curves[i];
            editor.canvas = element.querySelector ("canvas");
            editor.heading = element.querySelector ("h2");
            editor.resetButton = element.querySelector (".rb-text-button");
            this.attachCurveMouseHandlers (editor);
            editor.resetButton.onclick = () => this.resetCurve (editor);
        });

        this.showCurvesFor (null);

        new ResizeObserver (() => { this.drawSeismograph(); this.drawCurves(); }).observe (root);
    }

    //==============================================================================
    // The curve editors: the shape (the level after each trigger) and the pitch (the bend
    // after each trigger, with no bend along the middle), left to right over the shape's length
    getCurveLayout (editor)
    {
        const w = editor.canvas.clientWidth, h = editor.canvas.clientHeight, pad = 10;
        const plotW = Math.max (10, w - pad * 2), plotH = Math.max (10, h - pad * 2);

        return {
            w, h,
            toX:   (x)  => pad + x * plotW,
            toY:   (y)  => pad + (1 - y) * plotH,
            fromX: (px) => Math.min (1, Math.max (0, (px - pad) / plotW)),
            fromY: (py) => Math.min (1, Math.max (0, 1 - (py - pad) / plotH)),
        };
    }

    getTensionHandle (editor, i, layout)
    {
        const a = editor.points[i], b = editor.points[i + 1];
        const y = a.y + (b.y - a.y) * shapeSegment (0.5, a.tension ?? 0);
        return { x: layout.toX ((a.x + b.x) / 2), y: layout.toY (y) };
    }

    // Changes the curve on show: the shared one, or the edited step's own (which it creates)
    setCurve (editor, points, shouldSave)
    {
        const toStored = (list) => list?.map (p => ({ x: p.x, y: p.y, tension: p.tension ?? 0 })) ?? null;
        const step = this.editedStep;
        editor.points = points;

        if (step === null)
        {
            editor.shared = points;
            this.patchConnection.sendEventOrValue (editor.key, toCurveStruct (points));

            if (shouldSave)
                this.patchConnection.sendStoredStateValue (editor.key, toStored (points));
        }
        else
        {
            editor.stepCurves[step] = points;
            this.patchConnection.sendEventOrValue (editor.stepEndpoint, { step, curve: toCurveStruct (points) });

            if (shouldSave)
                this.patchConnection.sendStoredStateValue (editor.stepKey, editor.stepCurves.map (toStored));
        }

        this.drawCurve (editor);
        this.updateStepEditIcons();
    }

    // Puts the shared curve back to the default, or takes a step's own curve away so the
    // step goes back to playing the shared one
    resetCurve (editor)
    {
        const step = this.editedStep;

        if (step === null)
            return this.setCurve (editor, editor.makeDefault(), true);

        editor.stepCurves[step] = null;
        this.patchConnection.sendEventOrValue (editor.stepEndpoint, { step, curve: toCurveStruct ([]) });
        this.patchConnection.sendStoredStateValue (editor.stepKey, editor.stepCurves.map (c => c?.map (p => ({ x: p.x, y: p.y, tension: p.tension ?? 0 })) ?? null));
        this.showCurvesFor (step);
    }

    // Switches both editors to a step's own curves (showing the shared ones until it has
    // any), or back to the shared ones when step is null
    showCurvesFor (step)
    {
        this.editedStep = step;

        for (const editor of this.curves)
        {
            editor.points = (step !== null ? editor.stepCurves[step] : null) ?? editor.shared;
            editor.hover = null;

            if (editor.heading)
            {
                editor.heading.textContent = step === null ? editor.title : `${editor.title}, step ${step + 1}`;
                editor.resetButton.title = step === null ? "Back to the default" : "Back to the shared curve";
            }
        }

        this.drawCurves();
        this.updateStepEditIcons();
    }

    updateStepEditIcons()
    {
        this.stepEditButtons?.forEach ((button, i) =>
        {
            button.classList.toggle ("has-own", this.curves.some (c => c.stepCurves[i]));
            button.classList.toggle ("is-editing", i === this.editedStep);
        });
    }

    attachCurveMouseHandlers (editor)
    {
        const canvas = editor.canvas;

        const findTarget = (e) =>
        {
            const layout = this.getCurveLayout (editor);
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;

            for (let i = 0; i < editor.points.length; ++i)
                if (Math.hypot (layout.toX (editor.points[i].x) - mx, layout.toY (editor.points[i].y) - my) < 10)
                    return { type: "point", index: i, mx, my, layout };

            for (let i = 0; i < editor.points.length - 1; ++i)
            {
                const handle = this.getTensionHandle (editor, i, layout);

                if (Math.hypot (handle.x - mx, handle.y - my) < 9)
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
            const points = editor.points.map (p => ({ ...p }));
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
                this.setCurve (editor, points, false);
                drag = { type: "point", index: insertAt, hasChanged: true };
            }
            else if (target.type === "tension")
            {
                drag = { type: "tension", index: target.index, startY: e.clientY, startTension: points[target.index].tension ?? 0 };
            }
            else
            {
                drag = { type: "point", index: target.index };
            }

            editor.hover = drag;
            this.drawCurve (editor);
        };

        canvas.onpointermove = (e) =>
        {
            if (! drag)
            {
                const target = findTarget (e);
                editor.hover = target.type === "empty" ? null : target;
                canvas.style.cursor = target.type === "point" ? "grab" : (target.type === "tension" ? "ns-resize" : "crosshair");
                this.drawCurve (editor);
                return;
            }

            const points = editor.points.map (p => ({ ...p }));
            const layout = this.getCurveLayout (editor);
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

            drag.hasChanged = true;
            this.setCurve (editor, points, false);
        };

        // only a real change is saved, so clicking a step's curve doesn't give it its own copy
        canvas.onpointerup = () =>
        {
            if (drag?.hasChanged)
                this.setCurve (editor, editor.points, true);

            drag = null;
        };

        const removeAt = (e) =>
        {
            const target = findTarget (e);
            const points = editor.points.map (p => ({ ...p }));

            if (target.type === "point" && target.index > 0 && target.index < points.length - 1)
            {
                points.splice (target.index, 1);
                this.setCurve (editor, points, true);
            }
            else if (target.type === "tension")
            {
                points[target.index].tension = 0;
                this.setCurve (editor, points, true);
            }
        };

        canvas.ondblclick = removeAt;
        canvas.oncontextmenu = (e) => { e.preventDefault(); removeAt (e); };

        canvas.onpointerleave = () =>
        {
            if (! drag)
            {
                editor.hover = null;
                this.drawCurve (editor);
            }
        };
    }

    drawCurves()
    {
        for (const editor of this.curves)
            this.drawCurve (editor);
    }

    drawCurve (editor)
    {
        const surface = this.prepareCanvas (editor.canvas);

        if (! surface)
            return;

        const { g, h } = surface;
        const layout = this.getCurveLayout (editor);
        const { w, toX, toY } = layout;

        const style = getComputedStyle (this);
        const raised = style.getPropertyValue ("--raised").trim();
        const text = style.getPropertyValue ("--text").trim();
        const accent = style.getPropertyValue ("--accent").trim();

        // the curve, filled to its resting line: the floor for the shape, the middle for the pitch
        g.beginPath();
        g.moveTo (toX (0), toY (editor.restingY));

        for (let px = 0; px <= w; px += 2)
            g.lineTo (toX (layout.fromX (px)), toY (evaluateCurve (editor.points, layout.fromX (px))));

        g.lineTo (toX (1), toY (editor.restingY));
        g.closePath();
        g.fillStyle = raised;
        g.fill();

        g.beginPath();

        for (let px = 0; px <= w; px += 2)
        {
            const x = layout.fromX (px);
            px === 0 ? g.moveTo (toX (x), toY (evaluateCurve (editor.points, x))) : g.lineTo (toX (x), toY (evaluateCurve (editor.points, x)));
        }

        g.strokeStyle = accent;
        g.lineWidth = 3;
        g.lineJoin = "round";
        g.stroke();

        // where the curves are now, while one is playing
        if (this.shapePhase !== null && this.shapePhase < 1)
        {
            g.fillStyle = text;
            g.fillRect (Math.round (toX (this.shapePhase)) - 1, 0, 2, h);
        }

        // bend handles, then points
        g.fillStyle = text;

        for (let i = 0; i < editor.points.length - 1; ++i)
        {
            const handle = this.getTensionHandle (editor, i, layout);
            const isHot = editor.hover?.type === "tension" && editor.hover.index === i;
            g.beginPath();
            g.arc (handle.x, handle.y, isHot ? 5 : 3.5, 0, Math.PI * 2);
            g.fill();
        }

        editor.points.forEach ((p, i) =>
        {
            const isHot = editor.hover?.type === "point" && editor.hover.index === i;
            g.beginPath();
            g.arc (toX (p.x), toY (p.y), isHot ? 7.5 : 6, 0, Math.PI * 2);
            g.fill();
        });
    }

    // The level history as one filled shape rising from the bottom edge, newest on the right.
    // Levels are linear, so each duck shows as a deep notch and the swell after it as a slope.
    drawSeismograph()
    {
        const surface = this.prepareCanvas (this.seismograph);

        if (! surface)
            return;

        const { g, w, h } = surface;
        const toHeight = (level) => Math.min (1, level / 0.9) * h;
        const n = this.levels.length;

        g.beginPath();
        g.moveTo (0, h);

        for (let i = 0; i < n; ++i)
            g.lineTo (i / (n - 1) * w, h - toHeight (this.levels[i]));

        g.lineTo (w, h);
        g.closePath();
        g.fillStyle = getComputedStyle (this).getPropertyValue ("--accent").trim();
        g.fill();
    }

    // Sizes a canvas to its element at the screen's pixel density and clears it
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

    // Kicks every plate off in its own direction and sprays shards out of each fault
    quake()
    {
        const { faults, plates, shards } = this.tectonics;
        const w = this.platesCanvas?.clientWidth ?? 0, h = this.platesCanvas?.clientHeight ?? 0;

        for (const plate of plates)
        {
            plate.velocity += (Math.random() - 0.5) * 700;
            plate.spin += (Math.random() - 0.5) * 1.4;
        }

        for (let i = 1; i < faults.length - 1; ++i)
        {
            for (let n = 0; n < 8; ++n)
            {
                // a random spot somewhere along this fault
                const along = Math.random() * (pointsPerFault - 1);
                const a = faults[i][Math.floor (along)], b = faults[i][Math.min (pointsPerFault - 1, Math.floor (along) + 1)];
                const t = along - Math.floor (along);
                const direction = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
                const speed = 180 + Math.random() * 420;
                const life = 0.4 + Math.random() * 0.5;

                shards.push ({ x: (a.x + (b.x - a.x) * t) * w, y: (a.y + (b.y - a.y) * t) * h,
                               vx: Math.cos (direction) * speed, vy: Math.sin (direction) * speed,
                               angle: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 20,
                               size: 3 + Math.random() * 6, life, maxLife: life });
            }
        }
    }

    // Moves the plates and shards on by dt seconds, and draws them
    drawPlates (dt)
    {
        const surface = this.prepareCanvas (this.platesCanvas);

        if (! surface)
            return;

        const { g, w, h } = surface;
        const { faults, plates, shards } = this.tectonics;
        const level = Math.min (1, this.levels[this.levels.length - 1] / 0.9);
        const time = (this.tectonics.time += dt);
        const style = getComputedStyle (this);

        // springs pull each plate towards where the grinding pushes it, with a tremor on top
        for (const plate of plates)
        {
            const target = plate.direction * Math.sin (time * plate.rate * 5 + plate.phase) * level * h * 0.16
                             + (Math.random() - 0.5) * level * 3;

            plate.velocity += ((target - plate.y) * 220 - plate.velocity * 9) * dt;
            plate.y += plate.velocity * dt;
            plate.spin += (-plate.angle * 220 - plate.spin * 9) * dt;
            plate.angle += plate.spin * dt;
        }

        const margin = h * 0.18;
        const toY = (y) => margin + y * (h - 2 * margin);

        g.fillStyle = style.getPropertyValue ("--raised").trim();
        g.strokeStyle = style.getPropertyValue ("--panel").trim();
        g.lineWidth = 4;
        g.lineJoin = "round";

        plates.forEach ((plate, i) =>
        {
            const outline = [...faults[i], ...[...faults[i + 1]].reverse()];
            const centreX = (faults[i][0].x + faults[i + 1][0].x) * 0.5 * w;

            g.save();
            g.translate (centreX, h * 0.5 + plate.y);
            g.rotate (plate.angle);
            g.beginPath();
            outline.forEach ((p, j) => g[j ? "lineTo" : "moveTo"] (p.x * w - centreX, toY (p.y) - h * 0.5));
            g.closePath();
            g.fill();
            g.stroke();
            g.restore();
        });

        // shards fly up out of the faults, fall back, and shrink away
        g.fillStyle = style.getPropertyValue ("--accent").trim();

        for (const shard of shards)
        {
            shard.vy += 1400 * dt;
            shard.x += shard.vx * dt;
            shard.y += shard.vy * dt;
            shard.angle += shard.spin * dt;
            shard.life -= dt;

            const size = shard.size * Math.max (0, shard.life / shard.maxLife);

            g.save();
            g.translate (shard.x, shard.y);
            g.rotate (shard.angle);
            g.beginPath();
            g.moveTo (0, -size);
            g.lineTo (size, size * 0.7);
            g.lineTo (-size * 0.8, size * 0.5);
            g.closePath();
            g.fill();
            g.restore();
        }

        this.tectonics.shards = shards.filter (s => s.life > 0);
    }

    buildSteps (container)
    {
        this.stepButtons = [];
        this.stepEditButtons = [];
        let paintValue = null;

        for (let i = 0; i < 16; ++i)
        {
            const column = document.createElement ("div");
            column.className = "rb-step-column" + (i % 4 === 0 ? " is-beat" : "");

            const button = document.createElement ("button");
            button.className = "rb-step";

            button.onpointerdown = (e) =>
            {
                e.preventDefault();
                paintValue = ! this.isStepOn (i);
                this.setStep (i, paintValue);
            };

            button.onpointerenter = () =>
            {
                if (paintValue !== null)
                    this.setStep (i, paintValue);
            };

            // under each step, a button that switches the shape and pitch editors to that step's
            // own curves (and back to the shared ones when clicked again)
            const editButton = document.createElement ("button");
            editButton.className = "rb-step-edit";
            editButton.title = `Draw step ${i + 1}'s own shape and pitch`;
            editButton.innerHTML = `<svg viewBox="0 0 20 12"><path d="M2 3 C7 3 7 9 11 9 S15 3 18 3"/></svg>`;
            editButton.onclick = () => this.showCurvesFor (this.editedStep === i ? null : i);

            column.append (button, editButton);
            container.appendChild (column);
            this.stepButtons.push (button);
            this.stepEditButtons.push (editButton);
        }

        this.updateStepEditIcons();

        window.addEventListener ("pointerup", () => paintValue = null);
    }

    isStepOn (i)    { return ((Math.round (this.getValue ("pattern")) >> i) & 1) === 1; }

    setStep (i, isOn)
    {
        const pattern = Math.round (this.getValue ("pattern"));
        this.sendValue ("pattern", isOn ? (pattern | (1 << i)) : (pattern & ~(1 << i)));
    }

    // a random pattern built on the four beats, with the odd extra kick to stir it up
    newPattern()
    {
        let pattern = 0;

        for (let i = 0; i < 16; ++i)
            if (i % 4 === 0 ? Math.random() < 0.9 : Math.random() < 0.12)
                pattern |= 1 << i;

        this.sendValue ("pattern", pattern | 1);
    }

    updateSteps()
    {
        this.stepButtons?.forEach ((button, i) =>
        {
            button.classList.toggle ("is-on", this.isStepOn (i));
            button.classList.toggle ("is-now", i === this.currentStep);
        });
    }

    //==============================================================================
    createKnob (endpointID, label)
    {
        const info = this.paramInfo[endpointID];
        const element = document.createElement ("div");
        element.className = "rb-knob";

        if (! info)
            return element;

        element.title = info.name;
        element.innerHTML = `
            <div class="rb-dial">
                <svg viewBox="0 0 60 60"><path class="rb-track"/><path class="rb-arc"/></svg>
                <div class="rb-cap"></div>
            </div>
            <div class="rb-value"></div>
            <div class="rb-label">${label}</div>`;

        const dial = element.querySelector (".rb-dial");
        const cap = element.querySelector (".rb-cap");
        const arc = element.querySelector (".rb-arc");
        const valueText = element.querySelector (".rb-value");

        const arcPath = (n) =>
        {
            const start = -135, end = start + 270 * n;
            const toPoint = (deg) => [30 + 25 * Math.sin (deg * Math.PI / 180), 30 - 25 * Math.cos (deg * Math.PI / 180)];
            const [x1, y1] = toPoint (start), [x2, y2] = toPoint (end);
            return `M ${x1.toFixed (2)} ${y1.toFixed (2)} A 25 25 0 ${end - start > 180 ? 1 : 0} 1 ${x2.toFixed (2)} ${y2.toFixed (2)}`;
        };

        element.querySelector (".rb-track").setAttribute ("d", arcPath (1));

        this.knobs[endpointID] = (value) =>
        {
            const n = toNormalised (info, value);
            arc.setAttribute ("d", arcPath (Math.max (n, 0.002)));
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
            const delta = info.step ? Math.sign (-e.deltaY) * info.step / (info.max - info.min) : -e.deltaY / 1200;
            this.sendValue (endpointID, fromNormalised (info, current() + delta));
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

        if (endpointID === "pattern")
            this.updateSteps();

        if (endpointID === "run")
            this.querySelector (".rb-run")?.classList.toggle ("is-on", Math.round (value) === 1);
    }

    getValue (id)
    {
        return this.values[id] ?? this.paramInfo[id]?.init ?? 0;
    }

    hit()
    {
        const note = Math.round (this.getValue ("note"));
        this.quake();
        this.patchConnection.sendMIDIInputEvent (midiInputEndpointID, 0x900000 | (note << 8) | 127);
        setTimeout (() => this.patchConnection.sendMIDIInputEvent (midiInputEndpointID, 0x800000 | (note << 8)), 60);
    }

    //==============================================================================
    getStyle()
    {
        // One ground, one panel, one raised tone, one text colour and one accent. The page is
        // four full-width bands alternating panel and ground, with no boxes inside them.
        // Settings are drawn in the text colour; the accent is kept for what moves in time:
        // the seismograph, the shape, the steps, and Run.
        return `
        <style>
            rumble-view {
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

            rumble-view * { box-sizing: border-box; font-family: inherit; }
            rumble-view h1, rumble-view h2 { margin: 0; }
            rumble-view button { cursor: pointer; border: 0; padding: 0; font-weight: 800; color: var(--text); background: var(--raised); }
            rumble-view button:active { transform: translateY(1px); }

            .rb-root { min-width: 1040px; display: flex; flex-direction: column; }

            /* the wordmark and transport, with the seismograph running along the bottom */
            .rb-head { display: flex; flex-direction: column; background: var(--panel); }
            .rb-title { display: flex; align-items: center; gap: 28px; padding: 22px 28px 14px; }
            .rb-plates { flex: 1; min-width: 0; height: 94px; }
            .rb-title h1 { font-size: 104px; font-weight: 900; line-height: 0.9; letter-spacing: -0.02em; }
            .rb-transport { display: flex; gap: 8px; }
            .rb-transport button { width: 104px; height: 56px; font-size: 18px; }
            .rb-run.is-on { background: var(--accent); color: var(--ground); }
            .rb-seismograph { display: block; width: 100%; height: 72px; }

            /* the sound: four groups on the ground, set apart by space alone */
            .rb-modules { display: flex; gap: 36px; padding: 22px 28px 20px; }
            .rb-module { flex-basis: 0; min-width: 0; }
            .rb-module-head { display: flex; align-items: center; height: 28px; margin-bottom: 8px; }
            .rb-module-head h2 { font-size: 18px; font-weight: 900; }

            .rb-knob-row { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; justify-items: center; }

            .rb-knob { width: 62px; display: flex; flex-direction: column; align-items: center; }
            .rb-dial { position: relative; width: 54px; height: 54px; cursor: ns-resize; touch-action: none; }
            .rb-dial svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
            .rb-track { fill: none; stroke: var(--raised); stroke-width: 5; }
            .rb-arc { fill: none; stroke: var(--text); stroke-width: 5; }
            .rb-cap { position: absolute; left: 50%; top: 50%; width: 32px; height: 32px; margin: -16px 0 0 -16px; border-radius: 50%; background: var(--text); }
            .rb-cap::after { content: ""; position: absolute; left: 50%; top: 4px; width: 3px; height: 10px; margin-left: -1.5px; background: var(--ground); }
            .rb-value { font-size: 12px; font-weight: 700; line-height: 16px; margin-top: 4px; white-space: nowrap; }
            .rb-label { font-size: 12px; line-height: 15px; white-space: nowrap; }

            /* the shape and pitch: two wide editors with their controls beside them */
            .rb-shape { display: flex; align-items: flex-end; gap: 28px; padding: 18px 28px 22px; background: var(--panel); }
            .rb-shape-editor { flex: 1; min-width: 0; }
            .rb-shape .rb-module-head { justify-content: space-between; }
            .rb-text-button { height: 26px; padding: 0 12px !important; font-size: 12px; }
            .rb-shape-plot { position: relative; height: 128px; background: var(--ground); }
            .rb-shape-plot canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
            .rb-shape-knobs { flex: none; gap: 8px; padding-bottom: 2px; }

            /* the triggers */
            .rb-sequencer { display: flex; align-items: center; gap: 20px; padding: 18px 28px 22px; }
            .rb-steps { flex: 1; display: grid; grid-template-columns: repeat(16, 1fr); gap: 4px; }
            .rb-step-column { display: flex; flex-direction: column; gap: 4px; }
            .rb-step-column.is-beat { margin-left: 8px; }
            .rb-step-column:first-child { margin-left: 0; }
            .rb-step { height: 56px; }
            .rb-step.is-on { background: var(--accent); }
            .rb-step.is-now { background: var(--text); }

            /* the step edit icons: dim until a step has its own curves, filled while being edited */
            .rb-step-edit { height: 24px; display: grid; place-items: center; background: transparent; color: var(--raised); }
            .rb-step-edit svg { width: 20px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
            .rb-step-edit:hover { color: var(--text); }
            .rb-step-edit.has-own { color: var(--text); }
            .rb-step-edit.is-editing { background: var(--text); color: var(--ground); }

            .rb-icon { width: 40px; height: 40px; flex: none; display: grid; place-items: center; }
            .rb-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; }
            .rb-icon svg circle { fill: currentColor; stroke: none; }
            .rb-sequencer-knobs { gap: 4px; }
        </style>`;
    }
}

//==============================================================================
export default function createPatchView (patchConnection)
{
    const customElementName = "rumble-view";

    if (! window.customElements.get (customElementName))
        window.customElements.define (customElementName, RumbleView);

    return new (window.customElements.get (customElementName)) (patchConnection);
}
