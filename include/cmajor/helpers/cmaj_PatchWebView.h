//
//     ,ad888ba,                              88
//    d8"'    "8b
//   d8            88,dba,,adba,   ,aPP8A.A8  88     The Cmajor Toolkit
//   Y8,           88    88    88  88     88  88
//    Y8a.   .a8P  88    88    88  88,   ,88  88     (C)2024 Cmajor Software Ltd
//     '"Y888Y"'   88    88    88  '"8bbP"Y8  88     https://cmajor.dev
//                                           ,88
//                                        888P"
//
//  The Cmajor project is subject to commercial or open-source licensing.
//  You may use it under the terms of the GPLv3 (see www.gnu.org/licenses), or
//  visit https://cmajor.dev to learn about our commercial licence options.
//
//  CMAJOR IS PROVIDED "AS IS" WITHOUT ANY WARRANTY, AND ALL WARRANTIES, WHETHER
//  EXPRESSED OR IMPLIED, INCLUDING MERCHANTABILITY AND FITNESS FOR PURPOSE, ARE
//  DISCLAIMED.

#pragma once

#include <memory>
#include "cmaj_Patch.h"
#include "cmaj_PluginHelpers.h"
#include "../../choc/choc/gui/choc_WebView.h"
#include "../../choc/choc/network/choc_MIMETypes.h"

namespace cmaj
{

//==============================================================================
/// A HTML patch GUI implementation.
struct PatchWebView  : public PatchView
{
    PatchWebView (Patch&, const PatchManifest::View&);
    ~PatchWebView() override;

    void sendMessage (const choc::value::ValueView&) override;
    void reload();
    void requestViewRebuildIfNeeded();

    choc::ui::WebView& getWebView();

    void setStatusMessage (const std::string& newMessage);
    bool isTextInputFocused() const;

   #if FEATHER_WEBVIEW_DEBUG
    void debugProbeDocumentState (const std::string& context);
   #endif

    /// Provides a chunk of javascript that goes in a function which is run before the
    /// view element is added to its parent element.
    std::string extraSetupCode;

    /// Map a file extension (".html", ".js") to a MIME type (i.e. "text/html", "text/javascript").
    /// A default implementation is provided, but it is non-exhaustive. If a custom mapping function is given,
    /// it will be called first, falling back to the default implementation if an empty result is returned.
    std::function<std::string(std::string_view extension)> getMIMETypeForExtension;

private:
    std::unique_ptr<choc::ui::WebView> webview;
    // FEATHER: Tracks HTML text-entry focus so spacebar transport passthrough
    // can stay enabled without stealing spaces typed into patch UI fields.
    bool textInputFocused = false;
   #if FEATHER_WEBVIEW_DEBUG
    uint64_t debugRootFetchCount = 0;
    uint64_t debugBeaconCount = 0;
   #endif
    std::optional<choc::ui::WebView::Options::Resource> onRequest (const std::string&);
    void createBindings();
};




//==============================================================================
//        _        _           _  _
//     __| |  ___ | |_   __ _ (_)| | ___
//    / _` | / _ \| __| / _` || || |/ __|
//   | (_| ||  __/| |_ | (_| || || |\__ \ _  _  _
//    \__,_| \___| \__| \__,_||_||_||___/(_)(_)(_)
//
//   Code beyond this point is implementation detail...
//
//==============================================================================

inline PatchWebView::PatchWebView (Patch& p, const PatchManifest::View& view)
    : PatchView (p, view)
{
    CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView ctor this=" + plugin::debugPointerToString (this));

    choc::ui::WebView::Options options;

   #if CMAJ_ENABLE_WEBVIEW_DEV_TOOLS
    options.enableDebugMode = true;
   #else
    options.enableDebugMode = false;
   #endif

    options.transparentBackground = true;
    options.acceptsFirstMouseClick = true;
    options.fetchResource = [this] (const auto& path) { return onRequest (path); };

    options.webviewIsReady = [this] (choc::ui::WebView& w)
    {
        CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView webviewIsReady this=" + plugin::debugPointerToString (this)
                                  + " native=" + plugin::debugPointerToString (w.getViewHandle()));

        bool boundOK = w.bind ("cmaj_sendMessageToServer", [this] (const choc::value::ValueView& args) -> choc::value::Value
        {
            try
            {
                if (args.isArray() && args.size() != 0)
                    patch.handleClientMessage (*this, args[0]);
            }
            catch (const std::exception& e)
            {
                std::cout << "Error processing message from client: " << e.what() << std::endl;
            }

            return {};
        });

       #if FEATHER_WEBVIEW_DEBUG
        boundOK = w.bind ("cmaj_debugLog", [] (const choc::value::ValueView& args) -> choc::value::Value
        {
            const auto message = args.isArray() && args.size() != 0 ? args[0].toString() : std::string {};
            CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView JS " + message);
            return {};
        }) && boundOK;
       #endif

        // FEATHER: JS focus tracking feeds native spacebar passthrough.
        boundOK = w.bind ("cmaj_setTextInputFocus", [this] (const choc::value::ValueView& args) -> choc::value::Value
        {
            textInputFocused = args.isArray() && args.size() != 0 && args[0].getWithDefault<bool> (false);
            return {};
        }) && boundOK;

        // FEATHER: Prevent the browser from consuming host transport spacebar
        // shortcuts unless the user is typing into an editable element.
        static constexpr auto keyboardFocusScript = R"(
            (() => {
                const isTextInput = element =>
                {
                    if (! element)
                        return false;

                    const tagName = element.tagName;
                    return tagName === "INPUT" || tagName === "TEXTAREA" || element.isContentEditable;
                };

                const updateTextInputFocus = () =>
                    window.cmaj_setTextInputFocus?.(isTextInput (document.activeElement));

                window.addEventListener ("focusin", updateTextInputFocus, true);
                window.addEventListener ("focusout", () => setTimeout (updateTextInputFocus, 0), true);
                window.addEventListener ("keydown", event =>
                {
                    if ((event.code === "Space" || event.key === " ") && ! isTextInput (document.activeElement))
                        event.preventDefault();
                }, true);

                updateTextInputFocus();
            })();
        )";

        const auto scriptAdded = w.addInitScript (keyboardFocusScript);
        (void) scriptAdded;
        w.evaluateJavascript (keyboardFocusScript);

        (void) boundOK;
        CMAJ_ASSERT (boundOK);
    };

    webview = std::make_unique<choc::ui::WebView> (options);
}

inline PatchWebView::~PatchWebView() = default;

inline void PatchWebView::sendMessage (const choc::value::ValueView& msg)
{
    getWebView().evaluateJavascript ("window.cmaj_deliverMessageFromServer?.(" + choc::json::toString (msg, true) + ");");
}

inline choc::ui::WebView& PatchWebView::getWebView()
{
    CMAJ_ASSERT (webview != nullptr);
    return *webview;
}

inline void PatchWebView::setStatusMessage (const std::string& newMessage)
{
    CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView setStatusMessage this=" + plugin::debugPointerToString (this)
                              + " message=" + newMessage);

    getWebView().evaluateJavascript ("window.setStatusMessage (" + choc::json::getEscapedQuotedString (newMessage) + ")");
}

inline bool PatchWebView::isTextInputFocused() const
{
    return textInputFocused;
}

inline void PatchWebView::reload()
{
    // FEATHER: A reload drops DOM focus; keep the native passthrough predicate
    // conservative until JS reports the next focused editable element.
    textInputFocused = false;

    CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView reload navigate-root this=" + plugin::debugPointerToString (this));

    if (! getWebView().navigate ({}))
        getWebView().evaluateJavascript ("document.location.reload()");
}

inline void PatchWebView::requestViewRebuildIfNeeded()
{
    CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView requestViewRebuildIfNeeded this=" + plugin::debugPointerToString (this));

    getWebView().evaluateJavascript (R"(
        (() => {
            if (typeof window.cmaj_rebuildPatchViewIfNeeded === "function")
                window.cmaj_rebuildPatchViewIfNeeded();
        })();
    )");
}

#if FEATHER_WEBVIEW_DEBUG
inline void PatchWebView::debugProbeDocumentState (const std::string& context)
{
    const auto accepted = getWebView().evaluateJavascript (R"(
        (() => {
            const container = document.getElementById ("cmaj-view-container");
            const debug = window.__cmajPatchDebug || {};
            return JSON.stringify ({
                href: document.location.href,
                readyState: document.readyState,
                bootCount: debug.bootCount || 0,
                viewCreateCount: debug.viewCreateCount || 0,
                statusWrites: debug.statusWrites || 0,
                viewActive: debug.viewActive === true,
                containerChildren: container ? container.children.length : -1,
                bodyText: document.body?.innerText?.slice (0, 96) || ""
            });
        })();
    )",
        [context] (const std::string& error, const choc::value::ValueView& result)
        {
            CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView document-probe context=" + context
                                      + " error=" + error
                                      + " state=" + result.toString());
        });

    if (! accepted)
        CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView document-probe context=" + context + " accepted=false");
}
#endif

#if FEATHER_WEBVIEW_DEBUG
inline int cmajor_patch_gui_debug_hex_value (char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + c - 'a';
    if (c >= 'A' && c <= 'F') return 10 + c - 'A';
    return -1;
}

inline std::string cmajor_patch_gui_debug_decode_beacon_message (std::string_view path)
{
    const auto queryStart = path.find ('?');

    if (queryStart == std::string_view::npos)
        return std::string (path);

    const auto messageStart = path.find ("m=", queryStart + 1);

    if (messageStart == std::string_view::npos)
        return std::string (path);

    auto encoded = path.substr (messageStart + 2);

    if (const auto end = encoded.find ('&'); end != std::string_view::npos)
        encoded = encoded.substr (0, end);

    std::string result;
    result.reserve (encoded.size());

    for (size_t i = 0; i < encoded.size(); ++i)
    {
        if (encoded[i] == '%' && i + 2 < encoded.size())
        {
            const auto hi = cmajor_patch_gui_debug_hex_value (encoded[i + 1]);
            const auto lo = cmajor_patch_gui_debug_hex_value (encoded[i + 2]);

            if (hi >= 0 && lo >= 0)
            {
                result.push_back (static_cast<char> ((hi << 4) | lo));
                i += 2;
                continue;
            }
        }

        result.push_back (encoded[i] == '+' ? ' ' : encoded[i]);
    }

    return result;
}

static constexpr auto cmajor_patch_gui_debug_bootstrap = R"(
window.__cmajPatchDebug = window.__cmajPatchDebug || {};
window.__cmajPatchDebug.bootCount = (window.__cmajPatchDebug.bootCount || 0) + 1;
window.__cmajPatchDebug.viewCreateCount = window.__cmajPatchDebug.viewCreateCount || 0;
window.__cmajPatchDebug.statusWrites = window.__cmajPatchDebug.statusWrites || 0;
window.__cmajPatchDebug.viewActive = false;
window.__cmajPatchDebug.log = message =>
{
    try
    {
        fetch (`/cmaj_debug_log?m=${encodeURIComponent (message)}&t=${Date.now()}&r=${Math.random()}`, { cache: "no-store" }).catch (() => {});
    }
    catch {}

    window.cmaj_debugLog?.(message);
};
window.__cmajPatchDebug.log (`boot bootCount=${window.__cmajPatchDebug.bootCount}`);
)";

static constexpr auto cmajor_patch_gui_debug_status_write = R"(
    if (window.__cmajPatchDebug)
    {
        window.__cmajPatchDebug.statusWrites = (window.__cmajPatchDebug.statusWrites || 0) + 1;
        window.__cmajPatchDebug.viewActive = false;
        window.__cmajPatchDebug.log (`status-write count=${window.__cmajPatchDebug.statusWrites}`);
    }
)";

static constexpr auto cmajor_patch_gui_debug_view_created = R"(
        if (window.__cmajPatchDebug)
        {
            window.__cmajPatchDebug.viewCreateCount = (window.__cmajPatchDebug.viewCreateCount || 0) + 1;
            window.__cmajPatchDebug.viewActive = true;
            window.__cmajPatchDebug.log (`view-created count=${window.__cmajPatchDebug.viewCreateCount}`);
        }
)";

static constexpr auto cmajor_patch_gui_debug_rebuild_check = R"(
    window.__cmajPatchDebug?.log (`rebuild-check active=${isViewActive} bootCount=${window.__cmajPatchDebug.bootCount || 0} viewCreateCount=${window.__cmajPatchDebug.viewCreateCount || 0} statusWrites=${window.__cmajPatchDebug.statusWrites || 0}`);
)";
#else
static constexpr auto cmajor_patch_gui_debug_bootstrap = "";
static constexpr auto cmajor_patch_gui_debug_status_write = "";
static constexpr auto cmajor_patch_gui_debug_view_created = "";
static constexpr auto cmajor_patch_gui_debug_rebuild_check = "";
#endif

static constexpr auto cmajor_patch_gui_html = R"(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Cmajor Patch Controls</title>
</head>

<style>
  * { box-sizing: border-box; padding: 0; margin: 0; border: 0; }
  html { background: black; overflow: hidden; }
  body { display: block; position: absolute; width: 100%; height: 100%; color: white; font-family: Monaco, Consolas, monospace; }
  #cmaj-view-container { display: block; position: relative; width: 100%; height: 100%; overflow: auto; }
  #cmaj-error-text { display: block; position: relative; width: 100%; height: 100%; padding: 1rem; text-wrap: wrap; }
</style>

<body>
  <div id="cmaj-view-container"></div>
</body>

<script type="module">

import { PatchConnection } from "../cmaj_api/cmaj-patch-connection.js"
import { createPatchViewHolder } from "./cmaj_api/cmaj-patch-view.js"

//==============================================================================
const patchManifest = $MANIFEST$;

const viewInfo = $VIEW_TO_USE$;

$DEBUG_BOOTSTRAP_CODE$

//==============================================================================
class EmbeddedPatchConnection  extends PatchConnection
{
    constructor()
    {
        super();
        this.manifest = patchManifest;
        window.cmaj_deliverMessageFromServer = msg => this.deliverMessageFromServer (msg);
    }

    getResourceAddress (path)
    {
        return path.startsWith ("/") ? path : ("/" + path);
    }

    sendMessageToServer (message)
    {
        window.cmaj_sendMessageToServer (message);
    }
}

//==============================================================================
const container = document.getElementById ("cmaj-view-container");
let isViewActive = false;
let activePatchConnection;

async function initialiseContainer()
{
$EXTRA_SETUP_CODE$
}

window.setStatusMessage = (newMessage) =>
{
    isViewActive = false;
$DEBUG_STATUS_WRITE_CODE$
    container.innerHTML = `<pre id="cmaj-error-text">${newMessage}</pre>`;
};

window.cmaj_rebuildPatchViewIfNeeded = () =>
{
$DEBUG_REBUILD_CHECK_CODE$
    if (! isViewActive)
        activePatchConnection?.requestStatusUpdate();
};

async function createViewIfNeeded (patchConnection)
{
    if (isViewActive)
        return;

    container.innerHTML = "";

    await initialiseContainer();

    const view = await createPatchViewHolder (patchConnection, viewInfo);

    if (view)
    {
        container.appendChild (view);
        isViewActive = true;
$DEBUG_VIEW_CREATED_CODE$
    }
    else
    {
        window.setStatusMessage ("No view available");
    }
}

async function initialisePatch()
{
    const patchConnection = new EmbeddedPatchConnection();
    activePatchConnection = patchConnection;

    const statusListener = async status =>
    {
        const getDescription = () =>
        {
            if (status.manifest?.name)
                return `Error building '${status.manifest.name}':`;

            return `Error:`;
        }

        if (status.error)
            window.setStatusMessage (getDescription() + "\n\n" + status.error.toString());
        else
            await createViewIfNeeded (patchConnection);
    };

    patchConnection.addStatusListener (statusListener);
    patchConnection.requestStatusUpdate();
}

initialisePatch();


</script>
</html>
)";

inline std::optional<choc::ui::WebView::Options::Resource> PatchWebView::onRequest (const std::string& path)
{
   #if FEATHER_WEBVIEW_DEBUG
    if (path.rfind ("/cmaj_debug_log", 0) == 0)
    {
        ++debugBeaconCount;
        CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView JS beacon count=" + std::to_string (debugBeaconCount)
                                  + " this=" + plugin::debugPointerToString (this)
                                  + " message=" + cmajor_patch_gui_debug_decode_beacon_message (path));

        return choc::ui::WebView::Options::Resource ("", "text/plain");
    }
   #endif

    const auto toMimeType = [this] (const auto& extension)
    {
        if (getMIMETypeForExtension)
            if (auto m = getMIMETypeForExtension (extension); ! m.empty())
                return m;

        return choc::network::getMIMETypeFromFilename (extension, "application/octet-stream");
    };

    auto relativePath = std::filesystem::path (path).relative_path();

    if (relativePath.empty())
    {
       #if FEATHER_WEBVIEW_DEBUG
        ++debugRootFetchCount;
        CMAJ_FEATHER_WEBVIEW_LOG ("PatchWebView root-fetch count=" + std::to_string (debugRootFetchCount)
                                  + " this=" + plugin::debugPointerToString (this)
                                  + " path=" + path);
       #endif

        choc::value::Value manifestObject;
        cmaj::PatchManifest::View viewToUse;

        if (auto manifest = patch.getManifest())
        {
            manifestObject = manifest->manifest;

            if (auto v = manifest->findDefaultView())
                viewToUse = *v;
        }

        return choc::ui::WebView::Options::Resource (choc::text::replace (cmajor_patch_gui_html,
                                                        "$MANIFEST$", choc::json::toString (manifestObject, true),
                                                        "$VIEW_TO_USE$", choc::json::toString (viewToUse.view, true),
                                                        "$EXTRA_SETUP_CODE$", extraSetupCode,
                                                        "$DEBUG_BOOTSTRAP_CODE$", cmajor_patch_gui_debug_bootstrap,
                                                        "$DEBUG_STATUS_WRITE_CODE$", cmajor_patch_gui_debug_status_write,
                                                        "$DEBUG_VIEW_CREATED_CODE$", cmajor_patch_gui_debug_view_created,
                                                        "$DEBUG_REBUILD_CHECK_CODE$", cmajor_patch_gui_debug_rebuild_check),
                                                     "text/html");
    }

    if (auto content = readJavascriptResource (path, patch.getManifest()))
        if (! content->empty())
            return choc::ui::WebView::Options::Resource (*content, toMimeType (relativePath.extension().string()));

    return {};
}


} // namespace cmaj
