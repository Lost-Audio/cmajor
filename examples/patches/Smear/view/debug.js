
/*
    A plain GUI for Smear, for testing. The parameters are sorted into panels by their IDs
    (the three bands, Pull, Global, LFO and Envelope), laid out on a fixed grid so it all fits the
    patch's window, and each one gets the simplest control
    that fits it: a small knob for anything continuous, a toggle for Off|On, a pair of
    buttons for a short choice, and a drop-down for a long one. Everything else (names,
    ranges, defaults, units) comes from the patch's own annotations, so new parameters show
    up without touching this file; one whose ID no panel claims lands in Global.

    Drag a knob up or down to turn it (hold Shift for fine control), and double-click any
    knob to put it back to its default.

    The styled GUI is view/index.js; the patch's "view" picks which one is shown.
*/

const panels =
[
    { id: "low",    title: "Low" },
    { id: "mid",    title: "Mid" },
    { id: "high",   title: "High" },
    { id: "pull",   title: "Pull" },
    { id: "global", title: "Global" },
    { id: "lfo",    title: "LFO" },
    { id: "env",    title: "Envelope" },
];

const pullIDs = ["magnet", "key", "scale", "scaleEnabled", "pullMode"];
const shortNames = { lowCross: "Low Cross", highCross: "High Cross", lfoToSmear: "→ Smear", lfoToShift: "→ Shift",
                     lfoToScatter: "→ Scatter", lfoSpread: "Spread", lfoSnap: "Snap", lfoDivision: "Sync Rate", envSensitivity: "Sens",
                     pullMode: "Mode", volume: "Output" };

const dragPixels = 180;   // how far a drag goes from one end of a knob to the other

function panelFor (endpointID)
{
    if (endpointID === "lowCross" || endpointID === "highCross")  return "global";
    if (endpointID.startsWith ("lfo"))                            return "lfo";
    if (endpointID.startsWith ("env"))                            return "env";
    if (pullIDs.includes (endpointID))                            return "pull";

    for (const band of ["low", "mid", "high"])
        if (endpointID.startsWith (band))
            return band;

    return "global";
}

// a band's own panel already says which band it is, and the LFO's says it's the LFO
function shortName (endpointID, info)
{
    if (shortNames[endpointID])
        return shortNames[endpointID];

    return (info.name ?? endpointID).replace (/^(Low|Mid|High|LFO|Env) /, "").replace (/^> /, "→ ");
}

function isLogScale (info)      { return (info.unit === "Hz" || info.unit === "ms") && info.min > 0; }
function isBipolar (info)       { return info.min < 0 && info.max > 0; }
function isPercent (info)       { return ! info.unit && ! info.isInteger && info.min >= -1 && info.max <= 1; }

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
    const v = isLogScale (info) ? info.min * Math.pow (info.max / info.min, n)
                                : info.min + n * (info.max - info.min);

    return info.isInteger ? Math.round (v) : v;
}

function formatValue (info, value)
{
    if (info.text)
        return info.text.split ("|")[Math.round (value - info.min)] ?? String (value);

    if (isPercent (info))
        return Math.round (value * 100) + "%";

    const size = Math.abs (value);
    const digits = info.isInteger || size >= 100 ? 0 : (size >= 10 ? 1 : 2);
    const unit = info.unit === "deg" ? "°" : (info.unit ? " " + info.unit : "");
    return value.toFixed (digits) + unit;
}

// an arc of the knob's 270° sweep, from n0 to n1 (both 0 to 1), as an SVG path
function arcPath (n0, n1)
{
    const toPoint = (n) =>
    {
        const angle = (135 + 270 * n) * Math.PI / 180;
        return [20 + 15 * Math.cos (angle), 20 + 15 * Math.sin (angle)];
    };

    // nothing to draw at the origin (an empty arc would still show a dot from its round caps)
    if (Math.abs (n1 - n0) < 0.002)
        return "";

    const [x0, y0] = toPoint (Math.min (n0, n1));
    const [x1, y1] = toPoint (Math.max (n0, n1));
    const isLarge = Math.abs (n1 - n0) * 270 > 180 ? 1 : 0;
    return `M ${x0.toFixed (2)} ${y0.toFixed (2)} A 15 15 0 ${isLarge} 1 ${x1.toFixed (2)} ${y1.toFixed (2)}`;
}

//==============================================================================
class SmearDebugView extends HTMLElement
{
    constructor (patchConnection)
    {
        super();
        this.patchConnection = patchConnection;
        this.controls = {};
        this.isBuilt = false;
        this.innerHTML = this.getStyle() + `<div class="dbg-root"></div>`;
    }

    connectedCallback()
    {
        this.statusListener = (status) =>
        {
            if (this.isBuilt)
                return;

            this.isBuilt = true;
            this.build (status?.details?.inputs ?? []);
        };

        this.paramListener = (event) => this.controls[event.endpointID]?.show (event.value);

        this.patchConnection.addStatusListener (this.statusListener);
        this.patchConnection.addAllParameterListener (this.paramListener);
        this.patchConnection.requestStatusUpdate();
    }

    disconnectedCallback()
    {
        this.patchConnection.removeStatusListener (this.statusListener);
        this.patchConnection.removeAllParameterListener (this.paramListener);
    }

    build (inputs)
    {
        const root = this.querySelector (".dbg-root");
        const bodies = {};

        for (const panel of panels)
        {
            const element = document.createElement ("section");
            element.className = "dbg-panel dbg-" + panel.id;
            element.innerHTML = `<h2>${panel.title}</h2><div class="dbg-switches"></div><div class="dbg-knobs"></div>`;
            bodies[panel.id] = element;
        }

        for (const input of inputs)
        {
            const annotation = input.annotation;

            if (! annotation || annotation.min === undefined || annotation.max === undefined)
                continue;

            const info = { ...annotation, isInteger: !! annotation.text || input.dataType?.type === "int32" };
            const panel = bodies[panelFor (input.endpointID)];
            const control = this.createControl (input.endpointID, info);

            panel.querySelector (control.isSwitch ? ".dbg-switches" : ".dbg-knobs").appendChild (control.element);
            this.controls[input.endpointID] = control;
            this.patchConnection.requestParameterValue (input.endpointID);
        }

        for (const panel of panels)
            if (bodies[panel.id].querySelector (".dbg-control"))
                root.appendChild (bodies[panel.id]);
    }

    createControl (endpointID, info)
    {
        const options = info.text ? info.text.split ("|") : null;

        if (! options)
            return this.createKnob (endpointID, info);

        if (options.length === 2 && options[0] === "Off" && options[1] === "On")
            return this.createToggle (endpointID, info);

        if (options.length <= 3 && options.join ("").length <= 18)
            return this.createButtons (endpointID, info, options);

        return this.createMenu (endpointID, info, options);
    }

    createKnob (endpointID, info)
    {
        const element = this.createElement ("div", "dbg-control dbg-knob", endpointID, info);
        element.innerHTML = `
            <svg viewBox="0 0 40 40">
                <path class="dbg-track" d="${arcPath (0, 1)}" />
                <path class="dbg-fill" />
                <line class="dbg-pointer" x1="20" y1="20" x2="20" y2="9" />
            </svg>
            <span class="dbg-name"></span>
            <span class="dbg-value"></span>`;

        element.querySelector (".dbg-name").textContent = shortName (endpointID, info);

        const fill = element.querySelector (".dbg-fill");
        const pointer = element.querySelector (".dbg-pointer");
        const readout = element.querySelector (".dbg-value");
        const origin = isBipolar (info) ? toNormalised (info, 0) : 0;
        let normalised = 0, drag = null;

        const show = (value) =>
        {
            normalised = toNormalised (info, value);
            fill.setAttribute ("d", arcPath (origin, normalised));
            pointer.setAttribute ("transform", `rotate(${-135 + 270 * normalised} 20 20)`);
            readout.textContent = formatValue (info, value);
        };

        element.addEventListener ("pointerdown", (e) =>
        {
            if (e.button !== 0)
                return;

            element.setPointerCapture (e.pointerId);
            drag = { y: e.clientY, start: normalised, isFine: e.shiftKey };
            element.classList.add ("is-dragging");
            this.patchConnection.sendParameterGestureStart (endpointID);
        });

        element.addEventListener ("pointermove", (e) =>
        {
            if (! drag)
                return;

            // Shift turns it ten times slower, from wherever it has got to
            if (e.shiftKey !== drag.isFine)
                drag = { y: e.clientY, start: normalised, isFine: e.shiftKey };

            const distance = (drag.y - e.clientY) / (dragPixels * (drag.isFine ? 10 : 1));
            this.patchConnection.sendEventOrValue (endpointID, fromNormalised (info, drag.start + distance));
        });

        const endDrag = () =>
        {
            if (! drag)
                return;

            drag = null;
            element.classList.remove ("is-dragging");
            this.patchConnection.sendParameterGestureEnd (endpointID);
        };

        element.addEventListener ("pointerup", endDrag);
        element.addEventListener ("pointercancel", endDrag);
        return { element, show, isSwitch: false };
    }

    createToggle (endpointID, info)
    {
        const element = this.createElement ("button", "dbg-control dbg-toggle", endpointID, info);
        element.textContent = shortName (endpointID, info);
        let isOn = false;

        element.addEventListener ("click", () => this.send (endpointID, isOn ? info.min : info.max));

        const show = (value) =>
        {
            isOn = Math.round (value) !== info.min;
            element.classList.toggle ("is-on", isOn);
        };

        return { element, show, isSwitch: true };
    }

    createButtons (endpointID, info, options)
    {
        const element = this.createElement ("div", "dbg-control dbg-buttons", endpointID, info);
        const label = document.createElement ("span");
        label.className = "dbg-name";
        label.textContent = shortName (endpointID, info);
        element.appendChild (label);

        const buttons = options.map ((name, i) =>
        {
            const button = document.createElement ("button");
            button.textContent = name;
            button.addEventListener ("click", () => this.send (endpointID, info.min + i));
            element.appendChild (button);
            return button;
        });

        const show = (value) => buttons.forEach ((button, i) => button.classList.toggle ("is-on", info.min + i === Math.round (value)));
        return { element, show, isSwitch: true };
    }

    createMenu (endpointID, info, options)
    {
        const element = this.createElement ("label", "dbg-control dbg-menu", endpointID, info);
        const label = document.createElement ("span");
        label.className = "dbg-name";
        label.textContent = shortName (endpointID, info);

        const menu = document.createElement ("select");

        options.forEach ((name, i) =>
        {
            const option = document.createElement ("option");
            option.value = String (info.min + i);
            option.textContent = name;
            menu.appendChild (option);
        });

        menu.addEventListener ("change", () => this.send (endpointID, Number (menu.value)));
        element.append (label, menu);

        const show = (value) => { menu.value = String (Math.round (value)); };
        return { element, show, isSwitch: true };
    }

    // every control shows its full name and ID on hover; a knob also goes back to its default on a
    // double-click (on a toggle or button, a double-click is just two clicks)
    createElement (tag, className, endpointID, info)
    {
        const element = document.createElement (tag);
        element.className = className;
        element.title = `${info.name ?? endpointID}  (${endpointID})`;
        if (tag === "div" && className.includes ("dbg-knob"))
        {
            element.title += "  double-click to reset";
            element.addEventListener ("dblclick", () => this.send (endpointID, info.init ?? info.min));
        }
        return element;
    }

    // a one-off change (a click or a reset) is wrapped in its own gesture
    send (endpointID, value)
    {
        this.patchConnection.sendParameterGestureStart (endpointID);
        this.patchConnection.sendEventOrValue (endpointID, value);
        this.patchConnection.sendParameterGestureEnd (endpointID);
    }

    getStyle()
    {
        return `
        <style>
            smear-debug-view { --accent: #ff7a1a; display: block; width: 100%; height: 100%; overflow: auto;
                               background: #121212; color: #9a9a9a; font: 11px/1.2 system-ui, sans-serif;
                               user-select: none; }
            .dbg-root { display: grid; grid-template-columns: repeat(4, 192px); gap: 8px; padding: 8px;
                        grid-template-areas: "low mid high pull" "lfo lfo env global"; }
            .dbg-low { grid-area: low; }  .dbg-mid { grid-area: mid; }  .dbg-high { grid-area: high; }
            .dbg-pull { grid-area: pull; }  .dbg-global { grid-area: global; }  .dbg-lfo { grid-area: lfo; }
            .dbg-env { grid-area: env; }
            .dbg-panel { box-sizing: border-box; min-width: 0; background: #1a1a1a; border: 1px solid #262626; border-radius: 8px; padding: 8px 8px 9px; }
            .dbg-panel h2 { margin: 0 0 8px; font-size: 10px; font-weight: 600; letter-spacing: 0.12em;
                            text-transform: uppercase; color: #6c6c6c; }
            .dbg-switches { display: flex; flex-wrap: wrap; gap: 6px; }
            .dbg-switches:not(:empty) { margin-bottom: 8px; }
            .dbg-knobs { display: grid; grid-template-columns: repeat(3, 56px); gap: 6px 2px; }
            .dbg-lfo .dbg-knobs { grid-template-columns: repeat(auto-fill, 56px); }
            .dbg-knobs:empty { display: none; }

            .dbg-knob { display: flex; flex-direction: column; align-items: center; cursor: ns-resize; touch-action: none; }
            .dbg-knob svg { width: 40px; height: 40px; }
            .dbg-track, .dbg-fill { fill: none; stroke-width: 3.5; stroke-linecap: round; }
            .dbg-track { stroke: #2c2c2c; }
            .dbg-fill { stroke: var(--accent); }
            .dbg-pointer { stroke: #ddd; stroke-width: 2; stroke-linecap: round; }
            .dbg-knob .dbg-name { margin-top: 1px; max-width: 56px; overflow: hidden; white-space: nowrap;
                                  text-overflow: ellipsis; color: #b5b5b5; }
            .dbg-value { font: 10px ui-monospace, Consolas, monospace; color: #6c6c6c; white-space: nowrap; }
            .dbg-knob:hover .dbg-value, .dbg-knob.is-dragging .dbg-value { color: #eee; }

            button { font: inherit; color: #9a9a9a; background: #222; border: 1px solid #333; border-radius: 4px;
                     padding: 3px 8px; cursor: pointer; }
            button:hover { color: #ddd; }
            button.is-on { color: #111; background: var(--accent); border-color: var(--accent); }
            .dbg-buttons { display: flex; align-items: center; gap: 0; }
            .dbg-buttons .dbg-name, .dbg-menu .dbg-name { margin-right: 6px; color: #b5b5b5; }
            .dbg-buttons button { border-radius: 0; margin-left: -1px; }
            .dbg-buttons button:nth-child(2) { border-radius: 4px 0 0 4px; margin-left: 0; }
            .dbg-buttons button:last-child { border-radius: 0 4px 4px 0; }
            .dbg-menu { display: flex; align-items: center; }
            .dbg-menu select { font: inherit; color: #ddd; background: #222; border: 1px solid #333; border-radius: 4px;
                               padding: 2px 4px; }
        </style>`;
    }
}

//==============================================================================
export default function createPatchView (patchConnection)
{
    const customElementName = "smear-debug-view";

    if (! window.customElements.get (customElementName))
        window.customElements.define (customElementName, SmearDebugView);

    return new (window.customElements.get (customElementName)) (patchConnection);
}
