/*
    The drawn shape and pitch curves, both the shared ones and each step's own, are kept in
    the patch's stored state, which the host saves with the session. This worker runs
    whenever the patch is loaded and sends them to the DSP, so they're applied even if the
    GUI is never opened.
*/

const curveKeys = ["shape", "pitch"];
const stepCurveKeys = { stepShapes: "stepShape", stepPitches: "stepPitch" };   // stored key -> endpoint
const maxCurvePoints = 16;

// Converts a list of {x, y, tension} points into the fixed-size rumble::Curve struct
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

export default function runWorker (patchConnection)
{
    patchConnection.addStoredStateValueListener ((event) =>
    {
        if (curveKeys.includes (event?.key) && Array.isArray (event.value))
        {
            patchConnection.sendEventOrValue (event.key, toCurveStruct (event.value), -1, 1000);
        }
        else if (stepCurveKeys[event?.key] && Array.isArray (event.value))
        {
            // every step is sent, so a step without its own curve clears any old one
            for (let step = 0; step < 16; ++step)
                patchConnection.sendEventOrValue (stepCurveKeys[event.key], { step, curve: toCurveStruct (event.value[step] ?? []) });
        }
    });

    for (const key of [...curveKeys, ...Object.keys (stepCurveKeys)])
        patchConnection.requestStoredStateValue (key);
}
