/*
    The modulation lanes' drawn curves are kept in the patch's stored state, which the
    host saves with the session. This worker runs whenever the patch is loaded and sends
    those curves to the DSP, so they're applied even if the GUI is never opened.
*/

const curveKeys = ["mod1Curve", "mod2Curve", "mod3Curve"];
const maxCurvePoints = 16;

// Converts a list of {x, y, tension} points into the fixed-size strike::Curve struct
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
            patchConnection.sendEventOrValue (event.key, toCurveStruct (event.value), -1, 1000);
    });

    for (const key of curveKeys)
        patchConnection.requestStoredStateValue (key);
}
