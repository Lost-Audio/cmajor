
/*
    The GUI for Bile. A smiley face throws up every time a note plays, harder on accents,
    and keeps gushing through slides. Underneath are the synth controls and the
    16-step sequencer: each step has a gate, a note, an accent and a slide.
    Parameter ranges and defaults come from the patch's own annotations.
*/

const modules = [
    { title: "Acid",  params: [["cutoff", "Cutoff"], ["resonance", "Reso"], ["envMod", "Env Mod"], ["decay", "Decay"], ["accent", "Accent"], ["glide", "Glide"]], mode: "wave" },
    { title: "Gross", params: [["drive", "Drive"], ["grit", "Grit"], ["space", "Space"]] }
];

const sequencerParams = [["bpm", "BPM"], ["root", "Root"], ["volume", "Volume"]];

// the notes the dice picks from, as semitones from the root: mostly the root, with
// octaves and a minor-pentatonic spread around it
const diceNotes = [0, 0, 0, 0, 12, 12, -12, 3, 7, 10, 15, 5];

const midiInputEndpointID = "midiIn";

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
        case "s":    return value < 1 ? Math.round (value * 1000) + " ms" : value.toFixed (2) + " s";
        case "dB":   return value.toFixed (1) + " dB";
        case "note": return noteName (value);
    }

    if (info.step)
        return String (Math.round (value));

    if (info.min === 0 && info.max <= 1)
        return Math.round (value / info.max * 100) + "%";

    return value.toFixed (1);
}

//==============================================================================
// The face and everything that comes out of it, drawn flat in two colours.
class Retcher
{
    constructor (canvas, faceColour, featureColour, bileColour)
    {
        this.canvas = canvas;
        this.faceColour = faceColour;
        this.featureColour = featureColour;
        this.bileColour = bileColour;
        this.blobs = [];
        this.retch = 0;      // 0 = smiling, 1 = mouth wide open
        this.gush = 0;       // how much is still coming out
    }

    heave (strength)
    {
        this.retch = Math.max (this.retch, 0.6 + 0.4 * strength);
        this.gush = Math.max (this.gush, strength);

        for (let i = 0; i < 10 + strength * 22; ++i)
            this.spawn (strength);
    }

    spawn (strength)
    {
        if (this.blobs.length > 700)
            this.blobs.shift();

        const s = this.scale;

        this.blobs.push ({
            x: this.mouthX,
            y: this.mouthY,
            vx: (7 + Math.random() * 12 * (0.6 + strength)) * s,
            vy: (-3.5 + Math.random() * 4.5) * s,
            r: (3 + Math.random() * 9 * (0.5 + strength)) * s,
            isLanded: false
        });
    }

    resize()
    {
        const scale = window.devicePixelRatio || 1;
        this.w = this.canvas.clientWidth;
        this.h = this.canvas.clientHeight;
        this.canvas.width = Math.round (this.w * scale);
        this.canvas.height = Math.round (this.h * scale);
        this.canvas.getContext ("2d").setTransform (scale, 0, 0, scale, 0, 0);
        this.scale = this.h / 230;
    }

    update()
    {
        if (this.canvas.clientWidth !== this.w || this.canvas.clientHeight !== this.h)
            this.resize();

        // while there's still some left, it keeps coming
        if (this.gush > 0.05)
            for (let i = 0; i < 3 * this.gush; ++i)
                this.spawn (this.gush * 0.6);

        this.retch *= 0.9;
        this.gush *= 0.86;

        const floor = this.h - 2 * this.scale;

        for (const b of this.blobs)
        {
            if (b.isLanded)
            {
                // spreads out a little, then soaks away
                b.x += b.vx;
                b.vx *= 0.85;
                b.r -= 0.06 * this.scale;
                continue;
            }

            b.vy += 0.55 * this.scale;
            b.x += b.vx;
            b.y += b.vy;

            if (b.y + b.r * 0.4 >= floor)
            {
                b.y = floor;
                b.vx *= 0.35;
                b.isLanded = true;
            }
        }

        this.blobs = this.blobs.filter (b => b.r > 0.5 && b.x < this.w + 40);
    }

    draw()
    {
        this.update();

        const g = this.canvas.getContext ("2d");
        const s = this.scale, r = 92 * s;
        const jolt = this.retch;

        // the head lurches forward and down as it heaves
        const cx = 40 * s + r + jolt * 14 * s;
        const cy = this.h / 2 - 4 * s + jolt * 8 * s;

        g.clearRect (0, 0, this.w, this.h);

        // face
        g.fillStyle = this.faceColour;
        g.beginPath();
        g.arc (cx, cy, r, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = this.featureColour;
        g.strokeStyle = this.featureColour;
        g.lineCap = "round";
        g.lineWidth = 9 * s;

        const eyeY = cy - r * 0.3, eyeDX = r * 0.36;

        if (jolt > 0.3)
        {
            // eyes screwed shut: two chevrons pointing at each other
            for (const side of [-1, 1])
            {
                const ex = cx + side * eyeDX, d = r * 0.12;
                g.beginPath();
                g.moveTo (ex + side * d, eyeY - d);
                g.lineTo (ex - side * d, eyeY);
                g.lineTo (ex + side * d, eyeY + d);
                g.stroke();
            }
        }
        else
        {
            for (const side of [-1, 1])
            {
                g.beginPath();
                g.ellipse (cx + side * eyeDX, eyeY, r * 0.09, r * 0.17, 0, 0, Math.PI * 2);
                g.fill();
            }
        }

        // the mouth: a grin that opens up into a gaping hole
        const mouthY = cy + r * 0.32;
        this.mouthX = cx + r * 0.1;
        this.mouthY = mouthY;

        if (jolt > 0.08)
        {
            g.beginPath();
            g.ellipse (cx + r * 0.06, mouthY, r * (0.3 + 0.12 * jolt), r * (0.08 + 0.3 * jolt), 0, 0, Math.PI * 2);
            g.fill();
        }
        else
        {
            g.beginPath();
            g.arc (cx, cy + r * 0.02, r * 0.55, Math.PI * 0.2, Math.PI * 0.8);
            g.stroke();
        }

        // bile
        g.fillStyle = this.bileColour;

        for (const b of this.blobs)
        {
            g.beginPath();

            if (b.isLanded)
                g.ellipse (b.x, b.y, b.r * 1.8, b.r * 0.55, 0, 0, Math.PI * 2);
            else
                g.arc (b.x, b.y, b.r, 0, Math.PI * 2);

            g.fill();
        }

        // while it's pouring, a solid stream joins the mouth to the spray
        if (this.gush > 0.15)
        {
            g.beginPath();
            g.ellipse (this.mouthX + 26 * s, this.mouthY + 4 * s, 34 * s * this.gush + 8 * s, 12 * s * this.gush + 4 * s, 0.25, 0, Math.PI * 2);
            g.fill();
        }
    }
}

//==============================================================================
class BileView extends HTMLElement
{
    constructor (patchConnection)
    {
        super();
        this.patchConnection = patchConnection;
        this.values = {};
        this.paramInfo = {};
        this.knobs = {};
        this.modeSelectors = {};
        this.bitRows = [];
        this.isBuilt = false;
        this.innerHTML = this.getStyle() + `<div class="bl-root"></div>`;
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

        this.stepListener = (step) =>
        {
            this.currentStep = step;
            this.updateSteps();
        };

        this.hitListener = (strength) => this.heave (strength);

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
                this.playNote (Math.round (this.getValue ("root")), 127);
            }
        };

        this.patchConnection.addStatusListener (this.statusListener);
        this.patchConnection.addAllParameterListener (this.paramListener);
        this.patchConnection.addEndpointListener ("currentStep", this.stepListener);
        this.patchConnection.addEndpointListener ("noteHit", this.hitListener);
        window.addEventListener ("keydown", this.keyListener);
        this.patchConnection.requestStatusUpdate();

        const animate = () =>
        {
            this.retcher?.draw();
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
        this.patchConnection.removeEndpointListener ("noteHit", this.hitListener);
        window.removeEventListener ("keydown", this.keyListener);
    }

    //==============================================================================
    build()
    {
        const root = this.querySelector (".bl-root");

        root.innerHTML = `
            <header class="bl-head">
                <canvas></canvas>
                <div class="bl-title">
                    <h1>BILE</h1>
                    <div class="bl-transport">
                        <button class="bl-run" title="Space">Run</button>
                        <button class="bl-hit" title="X">Hit</button>
                    </div>
                </div>
            </header>
            <div class="bl-modules"></div>
            <div class="bl-sequencer">
                <div class="bl-grid"></div>
                <div class="bl-side">
                    <button class="bl-icon" title="New acid line">
                        <svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7" cy="7" r="1.3"/><circle cx="13" cy="13" r="1.3"/><circle cx="13" cy="7" r="1.3"/><circle cx="7" cy="13" r="1.3"/><circle cx="10" cy="10" r="1.3"/></svg>
                    </button>
                    <div class="bl-knob-row bl-sequencer-knobs"></div>
                </div>
            </div>`;

        const style = getComputedStyle (this);
        this.retcher = new Retcher (root.querySelector (".bl-head canvas"),
                                    style.getPropertyValue ("--text").trim(),
                                    style.getPropertyValue ("--panel").trim(),
                                    style.getPropertyValue ("--accent").trim());

        this.title = root.querySelector (".bl-title h1");

        root.querySelector (".bl-run").onclick = () => this.sendValue ("run", Math.round (this.getValue ("run")) ? 0 : 1);
        root.querySelector (".bl-hit").onpointerdown = () => this.playNote (Math.round (this.getValue ("root")), 127);
        root.querySelector (".bl-icon").onclick = () => this.newLine();

        const moduleContainer = root.querySelector (".bl-modules");

        for (const module of modules)
        {
            const element = document.createElement ("section");
            element.className = "bl-module";
            element.style.flexGrow = module.params.length;
            element.innerHTML = `<div class="bl-module-head"><h2>${module.title}</h2></div><div class="bl-knob-row"></div>`;

            if (module.mode)
                element.querySelector (".bl-module-head").appendChild (this.createModeSelector (module.mode));

            for (const [id, label] of module.params)
                element.querySelector (".bl-knob-row").appendChild (this.createKnob (id, label));

            moduleContainer.appendChild (element);
        }

        const sequencerKnobs = root.querySelector (".bl-sequencer-knobs");

        for (const [id, label] of sequencerParams)
            sequencerKnobs.appendChild (this.createKnob (id, label));

        const grid = root.querySelector (".bl-grid");
        this.buildBitRow (grid, "pattern", "Gate", "bl-gate");
        this.buildNoteRow (grid);
        this.buildBitRow (grid, "accents", "Accent", "bl-accent");
        this.buildBitRow (grid, "slides", "Slide", "bl-slide");
    }

    heave (strength)
    {
        this.retcher?.heave (strength);

        if (this.title)
        {
            this.title.classList.remove ("is-hit");
            void this.title.offsetWidth;
            this.title.classList.add ("is-hit");
        }
    }

    //==============================================================================
    addRowLabel (grid, text)
    {
        const label = document.createElement ("div");
        label.className = "bl-row-label";
        label.textContent = text;
        grid.appendChild (label);
    }

    // a row of 16 toggles for one bit each of a bitmask parameter; click and drag to paint
    buildBitRow (grid, endpointID, label, className)
    {
        this.addRowLabel (grid, label);

        const cells = [];
        let paintValue = null;

        for (let i = 0; i < 16; ++i)
        {
            const cell = document.createElement ("button");
            cell.className = className + (i % 4 === 0 && i > 0 ? " is-beat" : "");

            cell.onpointerdown = (e) =>
            {
                e.preventDefault();
                paintValue = ! this.isBitOn (endpointID, i);
                this.setBit (endpointID, i, paintValue);
            };

            cell.onpointerenter = () =>
            {
                if (paintValue !== null)
                    this.setBit (endpointID, i, paintValue);
            };

            grid.appendChild (cell);
            cells.push (cell);
        }

        window.addEventListener ("pointerup", () => paintValue = null);
        this.bitRows.push ({ endpointID, cells });
    }

    // under each gate, the note it plays: drag or scroll to change it, double-click for the root
    buildNoteRow (grid)
    {
        this.addRowLabel (grid, "Note");
        this.noteCells = [];

        for (let i = 0; i < 16; ++i)
        {
            const id = "note" + (i + 1);
            const cell = document.createElement ("div");
            cell.className = "bl-note" + (i % 4 === 0 && i > 0 ? " is-beat" : "");
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
                this.playNote (this.getStepPitch (i), 90);
            };

            cell.onwheel = (e) =>
            {
                e.preventDefault();
                this.setStepNote (i, this.getStepNote (i) + Math.sign (-e.deltaY));
            };

            cell.ondblclick = () => this.setStepNote (i, 0);

            grid.appendChild (cell);
            this.noteCells.push (cell);
        }
    }

    isBitOn (endpointID, i)     { return ((Math.round (this.getValue (endpointID)) >> i) & 1) === 1; }

    setBit (endpointID, i, isOn)
    {
        const bits = Math.round (this.getValue (endpointID));
        this.sendValue (endpointID, isOn ? (bits | (1 << i)) : (bits & ~(1 << i)));
    }

    getStepNote (i)     { return Math.round (this.getValue ("note" + (i + 1))); }
    getStepPitch (i)    { return Math.round (this.getValue ("root")) + this.getStepNote (i); }

    setStepNote (i, offset)
    {
        offset = Math.min (24, Math.max (-24, offset));

        if (offset === this.getStepNote (i))
            return;

        this.sendValue ("note" + (i + 1), offset);
        this.playNote (this.getStepPitch (i), 90);
    }

    // a fresh random acid line: gates, accents, slides and notes
    newLine()
    {
        let pattern = 1, accents = 1, slides = 0;

        for (let i = 0; i < 16; ++i)
        {
            if (i > 0 && Math.random() < 0.7)   pattern |= 1 << i;
            if (i > 0 && Math.random() < 0.25)  accents |= 1 << i;
            if (Math.random() < 0.3)            slides  |= 1 << i;

            this.sendValue ("note" + (i + 1), i === 0 ? 0 : diceNotes[Math.floor (Math.random() * diceNotes.length)]);
        }

        this.sendValue ("pattern", pattern);
        this.sendValue ("accents", accents);
        this.sendValue ("slides", slides);
    }

    updateSteps()
    {
        for (const row of this.bitRows)
        {
            row.cells.forEach ((cell, i) =>
            {
                cell.classList.toggle ("is-on", this.isBitOn (row.endpointID, i));
                cell.classList.toggle ("is-now", i === this.currentStep);
            });
        }

        this.noteCells?.forEach ((cell, i) =>
        {
            cell.textContent = noteName (this.getStepPitch (i));
            cell.classList.toggle ("is-now", i === this.currentStep);
        });
    }

    //==============================================================================
    createModeSelector (endpointID)
    {
        const info = this.paramInfo[endpointID];
        const min = info?.min ?? 0;
        const container = document.createElement ("div");
        container.className = "bl-mode";

        const buttons = (info?.text ?? "").split ("|").map ((text, index) =>
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
        element.className = "bl-knob";

        if (! info)
            return element;

        element.title = info.name;
        element.innerHTML = `
            <div class="bl-dial">
                <svg viewBox="0 0 60 60"><path class="bl-track"/><path class="bl-arc"/></svg>
                <div class="bl-cap"></div>
            </div>
            <div class="bl-value"></div>
            <div class="bl-label">${label}</div>`;

        const dial = element.querySelector (".bl-dial");
        const cap = element.querySelector (".bl-cap");
        const arc = element.querySelector (".bl-arc");
        const valueText = element.querySelector (".bl-value");

        const arcPath = (n) =>
        {
            const start = -135, end = start + 270 * n;
            const toPoint = (deg) => [30 + 25 * Math.sin (deg * Math.PI / 180), 30 - 25 * Math.cos (deg * Math.PI / 180)];
            const [x1, y1] = toPoint (start), [x2, y2] = toPoint (end);
            return `M ${x1.toFixed (2)} ${y1.toFixed (2)} A 25 25 0 ${end - start > 180 ? 1 : 0} 1 ${x2.toFixed (2)} ${y2.toFixed (2)}`;
        };

        element.querySelector (".bl-track").setAttribute ("d", arcPath (1));

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

        if (["pattern", "accents", "slides", "root"].includes (endpointID) || /^note\d+$/.test (endpointID))
            this.updateSteps();

        if (endpointID === "run")
            this.querySelector (".bl-run")?.classList.toggle ("is-on", Math.round (value) === 1);
    }

    getValue (id)
    {
        return this.values[id] ?? this.paramInfo[id]?.init ?? 0;
    }

    playNote (note, velocity)
    {
        note = Math.min (127, Math.max (0, note));
        this.patchConnection.sendMIDIInputEvent (midiInputEndpointID, 0x900000 | (note << 8) | velocity);
        setTimeout (() => this.patchConnection.sendMIDIInputEvent (midiInputEndpointID, 0x800000 | (note << 8)), 120);
    }

    //==============================================================================
    getStyle()
    {
        // One ground, one panel, one raised tone, one text colour and one accent: bile. The
        // page is three full-width bands alternating panel and ground, with no boxes inside.
        // Settings are drawn in the text colour; the accent is kept for what the acid does:
        // the bile itself, the gates and slides, the playing note, and Run.
        return `
        <style>
            bile-view {
                --ground: #0d0e0b;
                --panel: #18191a;
                --raised: #2a2b2c;
                --text: #f0f0ee;
                --accent: #a6ff1c;

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

            bile-view * { box-sizing: border-box; font-family: inherit; }
            bile-view h1, bile-view h2 { margin: 0; }
            bile-view button { cursor: pointer; border: 0; padding: 0; font-weight: 800; color: var(--text); background: var(--raised); }
            bile-view button:active { transform: translateY(1px); }

            .bl-root { min-width: 1040px; display: flex; flex-direction: column; }

            /* the face gets the whole header band to throw up across */
            .bl-head { position: relative; height: 230px; background: var(--panel); overflow: hidden; }
            .bl-head canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
            .bl-title { position: absolute; top: 24px; right: 28px; display: flex; flex-direction: column; align-items: flex-end; gap: 16px; }
            .bl-title h1 { font-size: 104px; font-weight: 900; line-height: 0.9; letter-spacing: -0.02em; }
            .bl-title h1.is-hit { animation: bl-flash 0.14s steps(1, end); }

            @keyframes bl-flash { from { color: var(--accent); } }

            .bl-transport { display: flex; gap: 8px; }
            .bl-transport button { width: 104px; height: 56px; font-size: 18px; }
            .bl-run.is-on { background: var(--accent); color: var(--ground); }

            /* the sound: two groups on the ground, set apart by space alone */
            .bl-modules { display: flex; gap: 48px; padding: 22px 28px 20px; }
            .bl-module { flex-basis: 0; min-width: 0; }
            .bl-module-head { display: flex; align-items: center; justify-content: space-between; height: 28px; margin-bottom: 8px; }
            .bl-module-head h2 { font-size: 18px; font-weight: 900; }

            .bl-mode { display: flex; background: var(--raised); }
            .bl-mode button { height: 24px; padding: 0 9px; font-size: 12px; background: transparent; }
            .bl-mode button.is-on { background: var(--text); color: var(--ground); }

            .bl-knob-row { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; justify-items: center; }

            .bl-knob { width: 64px; display: flex; flex-direction: column; align-items: center; }
            .bl-dial { position: relative; width: 54px; height: 54px; cursor: ns-resize; touch-action: none; }
            .bl-dial svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
            .bl-track { fill: none; stroke: var(--raised); stroke-width: 5; }
            .bl-arc { fill: none; stroke: var(--text); stroke-width: 5; }
            .bl-cap { position: absolute; left: 50%; top: 50%; width: 32px; height: 32px; margin: -16px 0 0 -16px; border-radius: 50%; background: var(--text); }
            .bl-cap::after { content: ""; position: absolute; left: 50%; top: 4px; width: 3px; height: 10px; margin-left: -1.5px; background: var(--ground); }
            .bl-value { font-size: 12px; font-weight: 700; line-height: 16px; margin-top: 4px; white-space: nowrap; }
            .bl-label { font-size: 12px; line-height: 15px; white-space: nowrap; }

            /* the sequence: a label column, then 16 steps in four rows */
            .bl-sequencer { display: flex; align-items: center; gap: 20px; padding: 18px 28px 22px; background: var(--panel); }
            .bl-grid { flex: 1; display: grid; grid-template-columns: 52px repeat(16, 1fr); gap: 4px; align-items: center; }
            .bl-row-label { font-size: 12px; font-weight: 700; }
            .bl-grid .is-beat { margin-left: 8px; }

            .bl-gate { height: 44px; }
            .bl-gate.is-on { background: var(--accent); }
            .bl-gate.is-now { background: var(--text); }

            .bl-note { height: 22px; display: grid; place-items: center; font-size: 12px; font-weight: 700; cursor: ns-resize; touch-action: none; }
            .bl-note.is-now { color: var(--accent); }

            .bl-accent { height: 18px; }
            .bl-accent.is-on { background: var(--text); }

            /* a slide reaches across the gap into the next step, like the glide it makes */
            .bl-slide { height: 18px; position: relative; background: transparent !important; }
            .bl-slide::before { content: ""; position: absolute; left: 0; right: 0; top: 7px; height: 4px; background: var(--raised); }
            .bl-slide.is-on::before { right: -12px; top: 5px; height: 8px; background: var(--accent); }
            .bl-slide.is-on:last-child::before { right: 0; }

            .bl-side { display: flex; align-items: center; gap: 16px; }
            .bl-icon { width: 40px; height: 40px; flex: none; display: grid; place-items: center; }
            .bl-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; }
            .bl-icon svg circle { fill: currentColor; stroke: none; }
            .bl-sequencer-knobs { gap: 4px; }
        </style>`;
    }
}

//==============================================================================
export default function createPatchView (patchConnection)
{
    const customElementName = "bile-view";

    if (! window.customElements.get (customElementName))
        window.customElements.define (customElementName, BileView);

    return new (window.customElements.get (customElementName)) (patchConnection);
}
