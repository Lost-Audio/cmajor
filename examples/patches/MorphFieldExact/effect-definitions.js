// Native Visco effect names, ranges, and initial values.
export const effects={
  "send": [
    {
      "name": "Chorus",
      "parameters": [
        {
          "name": "Depth",
          "min": 1,
          "max": 100,
          "default": 5,
          "unit": "",
          "step": 0.1
        },
        {
          "name": "Rate",
          "min": 0.5,
          "max": 10,
          "default": 1,
          "unit": "Hz",
          "step": 0.01
        }
      ]
    },
    {
      "name": "Diffuser",
      "parameters": [
        {
          "name": "Length",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        },
        {
          "name": "Pre-delay",
          "min": 0,
          "max": 300,
          "default": 10,
          "unit": "ms",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Plate Reverb",
      "parameters": [
        {
          "name": "Length",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        },
        {
          "name": "Brightness",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Room Reverb",
      "parameters": [
        {
          "name": "Length",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        },
        {
          "name": "Color",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Spring Reverb",
      "parameters": [
        {
          "name": "Length",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        },
        {
          "name": "Color",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Tempo Delay",
      "parameters": [
        {
          "name": "Length",
          "min": 1,
          "max": 8,
          "default": 2.7,
          "unit": "",
          "step": 0.01
        },
        {
          "name": "Feedback",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Compressor",
      "parameters": [
        {
          "name": "Ratio",
          "min": 0.1,
          "max": 10,
          "default": 3,
          "unit": ":1",
          "step": 0.01
        },
        {
          "name": "Speed",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Stereo Fuzz",
      "parameters": [
        {
          "name": "Drive",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        },
        {
          "name": "Color",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    }
  ],
  "main": [
    {
      "name": "Sticky Compressor",
      "parameters": [
        {
          "name": "Gain",
          "min": 0,
          "max": 48,
          "default": 6,
          "unit": "dB",
          "step": 0.1
        },
        {
          "name": "Speed",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "L.A. Optical",
      "parameters": [
        {
          "name": "Gain",
          "min": 0,
          "max": 48,
          "default": 12,
          "unit": "dB",
          "step": 0.1
        },
        {
          "name": "Speed",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Upward Compressor",
      "parameters": [
        {
          "name": "Ratio",
          "min": 0.1,
          "max": 10,
          "default": 2,
          "unit": ":1",
          "step": 0.01
        },
        {
          "name": "Speed",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Limiter",
      "parameters": [
        {
          "name": "Gain",
          "min": 0,
          "max": 48,
          "default": 0,
          "unit": "dB",
          "step": 0.1
        },
        {
          "name": "Speed",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Tape Simulator",
      "parameters": [
        {
          "name": "Drive",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        },
        {
          "name": "Age",
          "min": 0,
          "max": 100,
          "default": 50,
          "unit": "%",
          "step": 0.1
        }
      ]
    },
    {
      "name": "Transformer Amp",
      "parameters": [
        {
          "name": "Gain",
          "min": 0,
          "max": 48,
          "default": 12,
          "unit": "dB",
          "step": 0.1
        },
        {
          "name": "Bias",
          "min": -100,
          "max": 100,
          "default": 20,
          "unit": "%",
          "step": 0.1
        }
      ]
    }
  ]
};
