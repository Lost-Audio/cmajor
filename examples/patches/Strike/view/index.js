
/*
    The GUI for Strike. Every hit throws a lightning bolt across the header, the 16 steps
    are the sequencer's pattern (click or drag to paint them), and along the bottom are
    three modulation lanes, each a curve you draw that loops in time with the sequencer.
    Parameter ranges and defaults come from the patch's own annotations.
*/

const modules = [
    { title: "Perc",   params: [["decay", "Decay"], ["pitchDrop", "Drop"], ["fm", "FM"], ["noise", "Noise"]] },
    { title: "Rubber", params: [["cutoff", "Cutoff"], ["resonance", "Reso"], ["envAmount", "Env"], ["rubber", "Snap"]], mode: "filterMode" },
    { title: "Dirt",   params: [["drive", "Drive"], ["fold", "Fold"]] },
    { title: "Echo",   params: [["division", "Time"], ["feedback", "Feedback"], ["delayMix", "Mix"], ["delayTone", "Tone"]] }
];

const sequencerParams = [["bpm", "BPM"], ["root", "Root"], ["volume", "Volume"]];

const midiInputEndpointID = "midiIn";
const accent = "#e4ff1a";

const laneCount = 3;
const laneLengthLabels = ["1/4", "1/2", "1", "2", "4", "8"];   // shown with "bars" as the tooltip
const laneLengthsInSixteenths = [4, 8, 16, 32, 64, 128];
const maxCurvePoints = 16;

//==============================================================================
// Curves: lists of {x, y, tension} points with x and y in 0..1. These match
// strike::Curve and strike::evaluateCurve() in Strike.cmajor.
const point = (x, y, tension = 0) => ({ x, y, tension });
const defaultCurve = () => [point (0, 0), point (1, 1)];

function shapeSegment (p, tension)
{
    return Math.abs (tension) < 0.001 ? p : (Math.exp (tension * p) - 1) / (Math.exp (tension) - 1);
}

function evaluateCurve (points, t)
{
    if (points.length < 2)
        return t;

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
    return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][note % 12] + (Math.floor (note / 12) - 2);
}

function formatValue (info, value)
{
    switch (info.unit)
    {
        case "Hz":   return value >= 1000 ? (value / 1000).toFixed (1) + " kHz" : Math.round (value) + " Hz";
        case "s":    return value < 1 ? Math.round (value * 1000) + " ms" : value.toFixed (2) + " s";
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

    if (info.min === -1 && info.max === 1)
        return (value > 0.005 ? "+" : "") + Math.round (value * 100) + "%";

    return value.toFixed (1);
}

//==============================================================================
// Lightning: a jagged line made by repeatedly displacing the midpoints of a straight one,
// with a couple of shorter branches forking off it.
function makeBolt (x1, y1, x2, y2, roughness, depth)
{
    let points = [[x1, y1], [x2, y2]];
    let spread = Math.hypot (x2 - x1, y2 - y1) * roughness;

    for (let d = 0; d < depth; ++d)
    {
        const next = [points[0]];

        for (let i = 1; i < points.length; ++i)
        {
            const [ax, ay] = points[i - 1], [bx, by] = points[i];
            next.push ([(ax + bx) / 2 + (Math.random() - 0.5) * spread, (ay + by) / 2], [bx, by]);
        }

        points = next;
        spread *= 0.55;
    }

    return points;
}

function drawBolt (g, w, h)
{
    const startX = w * (0.1 + Math.random() * 0.8);
    const endX = startX + (Math.random() - 0.5) * w * 0.25;
    const trunk = makeBolt (startX, 0, endX, h, 0.35, 6);

    const stroke = (points, width) =>
    {
        g.beginPath();
        points.forEach (([x, y], i) => i === 0 ? g.moveTo (x, y) : g.lineTo (x, y));
        g.lineWidth = width;
        g.stroke();
    };

    g.strokeStyle = accent;
    g.lineJoin = "miter";
    stroke (trunk, 7);

    for (let b = 0; b < 2; ++b)
    {
        const [fx, fy] = trunk[Math.floor (trunk.length * (0.25 + Math.random() * 0.4))];
        const direction = Math.random() < 0.5 ? -1 : 1;
        stroke (makeBolt (fx, fy, fx + direction * w * (0.06 + Math.random() * 0.1), Math.min (h, fy + h * 0.45), 0.3, 4), 3);
    }
}

//==============================================================================
class StrikeView extends HTMLElement
{
    constructor (patchConnection)
    {
        super();
        this.patchConnection = patchConnection;
        this.values = {};
        this.paramInfo = {};
        this.knobs = {};
        this.modeSelectors = {};
        this.lanes = [];
        this.curves = {};
        this.modClock = null;
        this.isBuilt = false;
        this.innerHTML = this.getStyle() + `<div class="st-root"></div>`;

        for (let i = 1; i <= laneCount; ++i)
            this.curves["mod" + i + "Curve"] = defaultCurve();
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

            for (const key of Object.keys (this.curves))
                this.patchConnection.requestStoredStateValue (key);
        };

        this.paramListener = (event) => this.setDisplayedValue (event.endpointID, event.value);

        this.storedStateListener = (event) =>
        {
            if (event?.key in this.curves && Array.isArray (event.value) && event.value.length >= 2)
            {
                this.curves[event.key] = event.value.map (p => point (p.x, p.y, p.tension ?? 0));
                this.drawLanes();
            }
        };

        this.modClockListener = (position) =>
        {
            this.modClock = position;
            this.drawLanes();
        };

        // a click anywhere else closes an open target menu
        this.outsideClickListener = (e) =>
        {
            for (const lane of this.lanes)
                if (lane.menu.classList.contains ("is-open") && ! lane.menu.contains (e.target) && ! lane.targetButton.contains (e.target))
                    lane.menu.classList.remove ("is-open");
        };

        this.stepListener = (step) =>
        {
            this.currentStep = step;
            this.updateSteps();

            if (step >= 0 && (Math.round (this.getValue ("pattern")) >> step) & 1)
                this.strike();
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
        this.patchConnection.addEndpointListener ("modClock", this.modClockListener);
        this.patchConnection.addStoredStateValueListener (this.storedStateListener);
        window.addEventListener ("keydown", this.keyListener);
        window.addEventListener ("pointerdown", this.outsideClickListener);
        this.patchConnection.requestStatusUpdate();
    }

    disconnectedCallback()
    {
        this.patchConnection.removeStatusListener (this.statusListener);
        this.patchConnection.removeAllParameterListener (this.paramListener);
        this.patchConnection.removeEndpointListener ("currentStep", this.stepListener);
        this.patchConnection.removeEndpointListener ("modClock", this.modClockListener);
        this.patchConnection.removeStoredStateValueListener (this.storedStateListener);
        window.removeEventListener ("keydown", this.keyListener);
        window.removeEventListener ("pointerdown", this.outsideClickListener);
    }

    //==============================================================================
    build()
    {
        const root = this.querySelector (".st-root");

        root.innerHTML = `
            <header class="st-sky">
                <canvas></canvas>
                <h1>STRIKE</h1>
                <div class="st-transport">
                    <button class="st-run" title="Space">Run</button>
                    <button class="st-hit" title="X">Hit</button>
                </div>
            </header>
            <div class="st-modules"></div>
            <div class="st-sequencer">
                <div class="st-steps"></div>
                <button class="st-icon" title="New pattern">
                    <svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7" cy="7" r="1.3"/><circle cx="13" cy="13" r="1.3"/><circle cx="13" cy="7" r="1.3"/><circle cx="7" cy="13" r="1.3"/><circle cx="10" cy="10" r="1.3"/></svg>
                </button>
                <div class="st-knob-row st-sequencer-knobs"></div>
            </div>
            <div class="st-lanes"></div>`;

        this.sky = root.querySelector (".st-sky");
        this.skyCanvas = root.querySelector (".st-sky canvas");

        root.querySelector (".st-run").onclick = () => this.sendValue ("run", Math.round (this.getValue ("run")) ? 0 : 1);
        root.querySelector (".st-hit").onpointerdown = () => this.hit();
        root.querySelector (".st-icon").onclick = () => this.newPattern();

        const moduleContainer = root.querySelector (".st-modules");

        for (const module of modules)
        {
            const element = document.createElement ("section");
            element.className = "st-module";
            element.style.flexGrow = module.grow ?? module.params.length;
            element.innerHTML = `<div class="st-module-head"><h2>${module.title}</h2></div><div class="st-knob-row"></div>`;

            if (module.mode)
                element.querySelector (".st-module-head").appendChild (this.createModeSelector (module.mode));

            for (const [id, label] of module.params)
                element.querySelector (".st-knob-row").appendChild (this.createKnob (id, label));

            moduleContainer.appendChild (element);
        }

        const sequencerKnobs = root.querySelector (".st-sequencer-knobs");

        for (const [id, label] of sequencerParams)
            sequencerKnobs.appendChild (this.createKnob (id, label));

        this.buildSteps (root.querySelector (".st-steps"));

        for (let i = 1; i <= laneCount; ++i)
            root.querySelector (".st-lanes").appendChild (this.createLane (i));

        new ResizeObserver (() => this.drawLanes()).observe (root.querySelector (".st-lanes"));
    }

    //==============================================================================
    // A modulation lane: a target, a length, a depth, and a curve drawn straight onto it
    createLane (index)
    {
        const prefix = "mod" + index;
        const curveKey = prefix + "Curve";
        const targetID = prefix + "Target";
        const element = document.createElement ("section");
        element.className = "st-lane";
        element.innerHTML = `
            <div class="st-lane-head">
                <button class="st-target" title="Mod ${index}: what this lane moves"><span></span><svg viewBox="0 0 12 12"><path d="M1 3.5h10L6 9.5z"/></svg></button>
            </div>
            <div class="st-lane-body">
                <div class="st-lane-plot">
                    <canvas title="Click to add a point, drag to move it, drag a midpoint to bend, double-click to remove"></canvas>
                </div>
            </div>
            <div class="st-target-menu"></div>`;

        const lane = {
            index, curveKey,
            canvas: element.querySelector ("canvas"),
            targetButton: element.querySelector (".st-target"),
            menu: element.querySelector (".st-target-menu"),
            hover: null
        };

        // target: a button that opens a menu of everything a lane can move
        const targetInfo = this.paramInfo[targetID];
        const targetNames = (targetInfo?.text ?? "").split ("|");

        targetNames.forEach ((name, i) =>
        {
            const option = document.createElement ("button");
            option.textContent = name;
            option.onclick = () =>
            {
                this.sendValue (targetID, i);
                lane.menu.classList.remove ("is-open");
            };
            lane.menu.appendChild (option);
        });

        lane.targetButton.onclick = () => lane.menu.classList.toggle ("is-open");

        this.modeSelectors[targetID] = (value) =>
        {
            const i = Math.round (value);
            lane.targetButton.querySelector ("span").textContent = targetNames[i] ?? "";
            [...lane.menu.children].forEach ((b, j) => b.classList.toggle ("is-on", j === i));
        };

        // length, under the curve, and depth beside it
        const lengthSelector = this.createModeSelector (prefix + "Length", laneLengthLabels);
        lengthSelector.title = "Length in bars";
        element.querySelector (".st-lane-head").appendChild (lengthSelector);
        element.querySelector (".st-lane-body").appendChild (this.createKnob (prefix + "Depth", "Depth"));

        this.attachLaneMouseHandlers (lane);
        this.lanes.push (lane);
        return element;
    }

    getLaneLayout (lane)
    {
        const w = lane.canvas.clientWidth, h = lane.canvas.clientHeight, pad = 8;
        const plotW = Math.max (10, w - pad * 2), plotH = Math.max (10, h - pad * 2);

        return {
            w, h,
            toX:   (x)  => pad + x * plotW,
            toY:   (y)  => pad + (1 - y) * plotH,
            fromX: (px) => Math.min (1, Math.max (0, (px - pad) / plotW)),
            fromY: (py) => Math.min (1, Math.max (0, 1 - (py - pad) / plotH)),
        };
    }

    getTensionHandle (points, i, layout)
    {
        const a = points[i], b = points[i + 1];
        const y = a.y + (b.y - a.y) * shapeSegment (0.5, a.tension ?? 0);
        return { x: layout.toX ((a.x + b.x) / 2), y: layout.toY (y) };
    }

    setCurve (lane, points, shouldSave)
    {
        this.curves[lane.curveKey] = points;
        this.patchConnection.sendEventOrValue (lane.curveKey, toCurveStruct (points));

        if (shouldSave)
            this.patchConnection.sendStoredStateValue (lane.curveKey, points.map (p => ({ x: p.x, y: p.y, tension: p.tension ?? 0 })));

        this.drawLanes();
    }

    attachLaneMouseHandlers (lane)
    {
        const canvas = lane.canvas;

        const findTarget = (e) =>
        {
            const points = this.curves[lane.curveKey];
            const layout = this.getLaneLayout (lane);
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;

            for (let i = 0; i < points.length; ++i)
                if (Math.hypot (layout.toX (points[i].x) - mx, layout.toY (points[i].y) - my) < 9)
                    return { type: "point", index: i, mx, my, layout };

            for (let i = 0; i < points.length - 1; ++i)
            {
                const handle = this.getTensionHandle (points, i, layout);

                if (Math.hypot (handle.x - mx, handle.y - my) < 8)
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
            const points = this.curves[lane.curveKey].map (p => ({ ...p }));
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
                this.setCurve (lane, points, false);
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

            lane.hover = drag;
            this.drawLanes();
        };

        canvas.onpointermove = (e) =>
        {
            if (! drag)
            {
                const target = findTarget (e);
                lane.hover = target.type === "empty" ? null : target;
                canvas.style.cursor = target.type === "point" ? "grab" : (target.type === "tension" ? "ns-resize" : "crosshair");
                this.drawLanes();
                return;
            }

            const points = this.curves[lane.curveKey].map (p => ({ ...p }));
            const layout = this.getLaneLayout (lane);
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

            this.setCurve (lane, points, false);
        };

        canvas.onpointerup = () =>
        {
            if (drag)
                this.setCurve (lane, this.curves[lane.curveKey], true);

            drag = null;
        };

        const removeAt = (e) =>
        {
            const target = findTarget (e);
            const points = this.curves[lane.curveKey].map (p => ({ ...p }));

            if (target.type === "point" && target.index > 0 && target.index < points.length - 1)
            {
                points.splice (target.index, 1);
                this.setCurve (lane, points, true);
            }
            else if (target.type === "tension")
            {
                points[target.index].tension = 0;
                this.setCurve (lane, points, true);
            }
        };

        canvas.ondblclick = removeAt;
        canvas.oncontextmenu = (e) => { e.preventDefault(); removeAt (e); };

        canvas.onpointerleave = () =>
        {
            if (! drag)
            {
                lane.hover = null;
                this.drawLanes();
            }
        };
    }

    drawLanes()
    {
        for (const lane of this.lanes)
        {
            const canvas = lane.canvas;
            const scale = window.devicePixelRatio || 1;
            const layout = this.getLaneLayout (lane);
            const { w, h, toX, toY } = layout;

            if (! w || ! h)
                continue;

            if (canvas.width !== Math.round (w * scale) || canvas.height !== Math.round (h * scale))
            {
                canvas.width = Math.round (w * scale);
                canvas.height = Math.round (h * scale);
            }

            const g = canvas.getContext ("2d");
            g.setTransform (scale, 0, 0, scale, 0, 0);
            g.clearRect (0, 0, w, h);

            const style = getComputedStyle (this);
            const raised = style.getPropertyValue ("--raised").trim();
            const text = style.getPropertyValue ("--text").trim();
            const points = this.curves[lane.curveKey];

            // the shape, filled down to the floor
            g.beginPath();
            g.moveTo (toX (0), toY (0));

            for (let px = 0; px <= w; px += 2)
                g.lineTo (toX (layout.fromX (px)), toY (evaluateCurve (points, layout.fromX (px))));

            g.lineTo (toX (1), toY (0));
            g.closePath();
            g.fillStyle = raised;
            g.fill();

            g.beginPath();

            for (let px = 0; px <= w; px += 2)
            {
                const x = layout.fromX (px);
                px === 0 ? g.moveTo (toX (x), toY (evaluateCurve (points, x))) : g.lineTo (toX (x), toY (evaluateCurve (points, x)));
            }

            g.strokeStyle = accent;
            g.lineWidth = 2.5;
            g.lineJoin = "round";
            g.stroke();

            // where the lane is now
            if (this.modClock !== null)
            {
                const length = laneLengthsInSixteenths[Math.round (this.getValue ("mod" + lane.index + "Length"))] ?? 16;
                const phase = (this.modClock % length) / length;
                g.fillStyle = text;
                g.fillRect (Math.round (toX (phase)) - 1, 0, 2, h);
            }

            // bend handles, then points
            g.fillStyle = text;

            for (let i = 0; i < points.length - 1; ++i)
            {
                const handle = this.getTensionHandle (points, i, layout);
                const isHot = lane.hover?.type === "tension" && lane.hover.index === i;
                g.beginPath();
                g.arc (handle.x, handle.y, isHot ? 4.5 : 3, 0, Math.PI * 2);
                g.fill();
            }

            points.forEach ((p, i) =>
            {
                const isHot = lane.hover?.type === "point" && lane.hover.index === i;
                g.beginPath();
                g.arc (toX (p.x), toY (p.y), isHot ? 7 : 5.5, 0, Math.PI * 2);
                g.fill();
            });
        }
    }

    buildSteps (container)
    {
        this.stepButtons = [];
        let paintValue = null;

        for (let i = 0; i < 16; ++i)
        {
            const button = document.createElement ("button");
            button.className = "st-step" + (i % 4 === 0 ? " is-beat" : "");

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

            container.appendChild (button);
            this.stepButtons.push (button);
        }

        window.addEventListener ("pointerup", () => paintValue = null);

        // under each step, the note it plays: drag or scroll to change it, double-click for the root
        this.noteCells = [];

        for (let i = 0; i < 16; ++i)
        {
            const id = "note" + (i + 1);
            const cell = document.createElement ("div");
            cell.className = "st-note" + (i % 4 === 0 ? " is-beat" : "");
            cell.title = "Drag or scroll to change, double-click for the root note";

            let startY = 0, startOffset = 0;

            const onMove = (e) => this.setStepNote (i, startOffset + Math.round ((startY - e.clientY) / 8));

            const onUp = () =>
            {
                window.removeEventListener ("pointermove", onMove);
                window.removeEventListener ("pointerup", onUp);
                this.patchConnection.sendParameterGestureEnd (id);
            };

            cell.onpointerdown = (e) =>
            {
                e.preventDefault();
                startY = e.clientY;
                startOffset = this.getStepNote (i);
                this.patchConnection.sendParameterGestureStart (id);
                window.addEventListener ("pointermove", onMove);
                window.addEventListener ("pointerup", onUp);
                this.playNote (this.getStepPitch (i));
            };

            cell.onwheel = (e) =>
            {
                e.preventDefault();
                this.setStepNote (i, this.getStepNote (i) + Math.sign (-e.deltaY));
            };

            cell.ondblclick = () => this.setStepNote (i, 0);

            container.appendChild (cell);
            this.noteCells.push (cell);
        }
    }

    getStepNote (i)     { return Math.round (this.getValue ("note" + (i + 1))); }
    getStepPitch (i)    { return Math.round (this.getValue ("root")) + this.getStepNote (i); }

    setStepNote (i, offset)
    {
        offset = Math.min (24, Math.max (-24, offset));

        if (offset === this.getStepNote (i))
            return;

        this.sendValue ("note" + (i + 1), offset);
        this.playNote (this.getStepPitch (i));
    }

    playNote (note)
    {
        note = Math.min (127, Math.max (0, note));
        this.patchConnection.sendMIDIInputEvent (midiInputEndpointID, 0x900000 | (note << 8) | 110);
        setTimeout (() => this.patchConnection.sendMIDIInputEvent (midiInputEndpointID, 0x800000 | (note << 8)), 60);
    }

    isStepOn (i)    { return ((Math.round (this.getValue ("pattern")) >> i) & 1) === 1; }

    setStep (i, isOn)
    {
        const pattern = Math.round (this.getValue ("pattern"));
        this.sendValue ("pattern", isOn ? (pattern | (1 << i)) : (pattern & ~(1 << i)));
    }

    // a random pattern that always lands on the first beat
    newPattern()
    {
        let pattern = 1;

        for (let i = 1; i < 16; ++i)
            if (Math.random() < (i % 2 === 0 ? 0.6 : 0.4))
                pattern |= 1 << i;

        this.sendValue ("pattern", pattern);
    }

    updateSteps()
    {
        this.stepButtons?.forEach ((button, i) =>
        {
            button.classList.toggle ("is-on", this.isStepOn (i));
            button.classList.toggle ("is-now", i === this.currentStep);
        });

        this.noteCells?.forEach ((cell, i) =>
        {
            cell.textContent = noteName (this.getStepPitch (i));
            cell.classList.toggle ("is-now", i === this.currentStep);
        });
    }

    createModeSelector (endpointID, labels = null)
    {
        const info = this.paramInfo[endpointID];
        const min = info?.min ?? 0;
        const container = document.createElement ("div");
        container.className = "st-mode";

        const buttons = (labels ?? (info?.text ?? "").split ("|")).map ((text, index) =>
        {
            const button = document.createElement ("button");
            button.textContent = text;
            button.onclick = () => this.sendValue (endpointID, min + index);
            container.appendChild (button);
            return button;
        });

        this.modeSelectors[endpointID] = (value) =>
            buttons.forEach ((b, i) => b.classList.toggle ("is-on", i === Math.round (value - min)));

        return container;
    }

    createKnob (endpointID, label)
    {
        const info = this.paramInfo[endpointID];
        const element = document.createElement ("div");
        element.className = "st-knob";

        if (! info)
            return element;

        element.title = info.name;
        element.innerHTML = `
            <div class="st-dial">
                <svg viewBox="0 0 60 60"><path class="st-track"/><path class="st-arc"/></svg>
                <div class="st-cap"></div>
            </div>
            <div class="st-value"></div>
            <div class="st-label">${label}</div>`;

        const dial = element.querySelector (".st-dial");
        const cap = element.querySelector (".st-cap");
        const arc = element.querySelector (".st-arc");
        const valueText = element.querySelector (".st-value");

        const arcPath = (n) =>
        {
            const start = -135, end = start + 270 * n;
            const toPoint = (deg) => [30 + 25 * Math.sin (deg * Math.PI / 180), 30 - 25 * Math.cos (deg * Math.PI / 180)];
            const [x1, y1] = toPoint (start), [x2, y2] = toPoint (end);
            return `M ${x1.toFixed (2)} ${y1.toFixed (2)} A 25 25 0 ${end - start > 180 ? 1 : 0} 1 ${x2.toFixed (2)} ${y2.toFixed (2)}`;
        };

        element.querySelector (".st-track").setAttribute ("d", arcPath (1));

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
        this.modeSelectors[endpointID]?.(value);

        if (endpointID === "pattern" || endpointID === "root" || /^note\d+$/.test (endpointID))
            this.updateSteps();

        if (/^mod\dLength$/.test (endpointID))
            this.drawLanes();

        if (endpointID === "run")
            this.querySelector (".st-run")?.classList.toggle ("is-on", Math.round (value) === 1);
    }

    getValue (id)
    {
        return this.values[id] ?? this.paramInfo[id]?.init ?? 0;
    }

    hit()
    {
        this.playNote (Math.round (this.getValue ("root")));
        this.strike();
    }

    // draws a bolt, flickers it once, and flashes the header
    strike()
    {
        const canvas = this.skyCanvas;

        if (! canvas)
            return;

        const scale = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        canvas.width = Math.round (w * scale);
        canvas.height = Math.round (h * scale);

        const g = canvas.getContext ("2d");
        g.setTransform (scale, 0, 0, scale, 0, 0);

        const show = () => { g.clearRect (0, 0, w, h); drawBolt (g, w, h); };
        const hide = () => g.clearRect (0, 0, w, h);

        clearTimeout (this.boltTimer);
        show();
        this.sky.classList.add ("is-struck");

        this.boltTimer = setTimeout (() =>
        {
            hide();
            this.sky.classList.remove ("is-struck");

            this.boltTimer = setTimeout (() =>
            {
                show();
                this.boltTimer = setTimeout (hide, 50);
            }, 30);
        }, 45);
    }

    //==============================================================================
    getStyle()
    {
        // One ground, one panel, one raised tone, one text colour and one accent. The page is
        // four full-width bands alternating ground and panel, with no boxes inside them.
        // Settings are drawn in the text colour; the accent is kept for what moves in time:
        // the steps, the lane curves, Run, and the lightning.
        return `
        <style>
            strike-view {
                --ground: #0b0b0d;
                --panel: #17171b;
                --raised: #28282e;
                --text: #f2f2ee;
                --accent: ${accent};

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

            strike-view * { box-sizing: border-box; font-family: inherit; }
            strike-view h1, strike-view h2 { margin: 0; }
            strike-view button { cursor: pointer; border: 0; padding: 0; font-weight: 800; color: var(--text); background: var(--raised); }
            strike-view button:active { transform: translateY(1px); }

            .st-root { min-width: 1040px; display: flex; flex-direction: column; }

            /* the sky: wordmark and transport, with bolts drawn behind */
            .st-sky { position: relative; height: 150px; display: flex; align-items: center; justify-content: space-between; padding: 0 28px; background: var(--panel); overflow: hidden; }
            .st-sky canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
            .st-sky h1 { position: relative; font-size: 104px; font-weight: 900; line-height: 1; letter-spacing: -0.02em; }
            .st-sky.is-struck { background: var(--raised); }
            .st-sky.is-struck h1 { color: var(--accent); }

            .st-transport { position: relative; display: flex; gap: 8px; }
            .st-transport button { width: 104px; height: 56px; font-size: 18px; }
            .st-run.is-on { background: var(--accent); color: var(--ground); }

            /* the sound: four groups on the ground, set apart by space alone */
            .st-modules { display: flex; gap: 36px; padding: 22px 28px 20px; }
            .st-module { flex-basis: 0; min-width: 0; }
            .st-module-head { display: flex; align-items: center; justify-content: space-between; height: 28px; margin-bottom: 8px; }
            .st-module-head h2 { font-size: 18px; font-weight: 900; }

            .st-mode { display: flex; background: var(--raised); }
            .st-mode button { height: 24px; min-width: 26px; padding: 0 8px; font-size: 12px; background: transparent; }
            .st-mode button.is-on { background: var(--text); color: var(--ground); }

            .st-knob-row { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; justify-items: center; }

            .st-knob { width: 62px; display: flex; flex-direction: column; align-items: center; }
            .st-dial { position: relative; width: 54px; height: 54px; cursor: ns-resize; touch-action: none; }
            .st-dial svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
            .st-track { fill: none; stroke: var(--raised); stroke-width: 5; }
            .st-arc { fill: none; stroke: var(--text); stroke-width: 5; }
            .st-cap { position: absolute; left: 50%; top: 50%; width: 32px; height: 32px; margin: -16px 0 0 -16px; border-radius: 50%; background: var(--text); }
            .st-cap::after { content: ""; position: absolute; left: 50%; top: 4px; width: 3px; height: 10px; margin-left: -1.5px; background: var(--ground); }
            .st-value { font-size: 12px; font-weight: 700; line-height: 16px; margin-top: 4px; white-space: nowrap; }
            .st-label { font-size: 12px; line-height: 15px; white-space: nowrap; }

            /* the sequence */
            .st-sequencer { display: flex; align-items: center; gap: 20px; padding: 18px 28px; background: var(--panel); }
            .st-steps { flex: 1; display: grid; grid-template-columns: repeat(16, 1fr); gap: 4px; }
            .st-step { height: 56px; }
            .st-step.is-beat, .st-note.is-beat { margin-left: 8px; }
            .st-step:first-child, .st-note:nth-child(17) { margin-left: 0; }
            .st-step.is-on { background: var(--accent); }
            .st-step.is-now { background: var(--text); }

            .st-note { height: 26px; display: grid; place-items: center; font-size: 12px; font-weight: 700; cursor: ns-resize; touch-action: none; }
            .st-note.is-now { color: var(--accent); }

            .st-icon { width: 40px; height: 40px; flex: none; display: grid; place-items: center; }
            .st-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; }
            .st-icon svg circle { fill: currentColor; stroke: none; }
            .st-sequencer-knobs { gap: 4px; }

            /* modulation: three lanes on the ground, each named by what it moves */
            .st-lanes { display: flex; gap: 32px; padding: 20px 28px 24px; }
            .st-lane { position: relative; flex: 1; min-width: 0; }
            .st-lane-head { display: flex; align-items: center; justify-content: space-between; height: 28px; margin-bottom: 8px; }

            .st-target { display: inline-flex; align-items: center; gap: 7px; height: 28px; font-size: 18px; font-weight: 900; white-space: nowrap; background: transparent !important; }
            .st-target svg { width: 11px; height: 11px; fill: currentColor; }

            .st-target-menu { position: absolute; z-index: 5; left: 0; right: 0; top: 36px; display: none; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 8px; background: var(--panel); }
            .st-target-menu.is-open { display: grid; }
            .st-target-menu button { height: 28px; font-size: 12px; }
            .st-target-menu button.is-on { background: var(--text); color: var(--ground); }

            .st-lane-body { display: flex; align-items: center; gap: 8px; }
            .st-lane-plot { position: relative; flex: 1; height: 96px; background: var(--panel); }
            .st-lane-plot canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
        </style>`;
    }
}

//==============================================================================
export default function createPatchView (patchConnection)
{
    const customElementName = "strike-view";

    if (! window.customElements.get (customElementName))
        window.customElements.define (customElementName, StrikeView);

    return new (window.customElements.get (customElementName)) (patchConnection);
}
