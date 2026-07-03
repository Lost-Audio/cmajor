# Feather Modifications

This file tracks intentional Feather fork divergences from upstream Cmajor.

| File | Status | Divergence |
| --- | --- | --- |
| `include/cmajor/helpers/cmaj_PluginHelpers.h` | Implemented | Adds persistent WebView manifest opt-out helpers, patch/view identity tracking, hidden native parking windows for Windows and macOS, Windows CBT pre-destroy native-window hooks, and native child reparent/frame helpers. |
| `include/cmajor/helpers/cmaj_JUCEPlugin.h` | Implemented | Moves patch GUI WebView ownership above the editor by default, parks the native view on editor close, reattaches on editor reopen, probes attach health with soft/hard recovery, recreates when patch identity changes, and honors `"persistentView": false` for legacy per-editor behavior. |
| `include/cmajor/helpers/cmaj_PatchWebView.h` | Implemented | Tracks focused editable HTML elements and resets that focus state on reload so native spacebar passthrough does not steal text-entry spaces. |
| `modules/plugin/include/clap/cmaj_CLAPPlugin.h` | Implemented | Refactors CLAP GUI ViewHolder to park on `clapGui_destroy`, reattach on `clapGui_create`, probe/recover attach state, recreate on patch identity changes, and honor `"persistentView": false` with editor-owned WebViews. |

