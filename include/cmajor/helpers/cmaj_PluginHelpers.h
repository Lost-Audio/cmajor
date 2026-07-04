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

#include "cmaj_Patch.h"
#include "cmaj_GeneratedCppEngine.h"

#if CMAJ_USE_QUICKJS_WORKER
 #include "cmaj_PatchWorker_QuickJS.h"
#else
 #include "cmaj_PatchWorker_WebView.h"
#endif

#include <algorithm>
#if FEATHER_WEBVIEW_DEBUG
 #include <chrono>
 #include <cstdlib>
 #include <fstream>
 #include <sstream>
 #include <thread>
#endif
#include <filesystem>
#include <functional>
#include <istream>
#include <memory>
#include <mutex>
#include <condition_variable>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "../../choc/choc/gui/choc_WebView.h"

namespace cmaj::plugin
{

//==============================================================================
#if FEATHER_WEBVIEW_DEBUG
inline std::string debugPointerToString (const void* ptr)
{
    std::ostringstream out;
    out << ptr;
    return out.str();
}

inline std::filesystem::path getWebViewDebugLogFile()
{
    if (auto* path = std::getenv ("FEATHER_WEBVIEW_DEBUG_LOG"))
        if (*path != 0)
            return path;

  #if CHOC_WINDOWS
    char tempPath[MAX_PATH + 1] = {};
    const auto length = GetTempPathA (MAX_PATH, tempPath);

    if (length != 0 && length <= MAX_PATH)
        return std::filesystem::path (tempPath) / "feather-webview-debug.log";
  #endif

    return std::filesystem::temp_directory_path() / "feather-webview-debug.log";
}

inline void debugLogWebViewLifecycle (const std::string& message)
{
    static std::mutex mutex;
    std::lock_guard<std::mutex> lock (mutex);

    const auto now = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::steady_clock::now().time_since_epoch()).count();

    std::ostringstream line;
    line << "[" << now << " tid=" << std::this_thread::get_id() << "] "
         << message << "\n";

  #if CHOC_WINDOWS
    OutputDebugStringA (line.str().c_str());
  #endif

    std::ofstream out (getWebViewDebugLogFile(), std::ios::app);
    out << line.str();
}

 #define CMAJ_FEATHER_WEBVIEW_LOG(message) \
    do { ::cmaj::plugin::debugLogWebViewLifecycle ((message)); } while (false)
#else
 #define CMAJ_FEATHER_WEBVIEW_LOG(message) do {} while (false)
#endif

//==============================================================================
struct Environment
{
    enum class EngineType
    {
        AOT,
        JIT
    };

    struct VirtualFileSystem
    {
        std::function<std::unique_ptr<std::istream>(const std::filesystem::path&)> createFileReader;
        std::function<std::filesystem::path(const std::filesystem::path&)> getFullPathForFile;
        std::function<std::filesystem::file_time_type(const std::filesystem::path&)> getFileModificationTime;
        std::function<bool(const std::filesystem::path&)> fileExists;
    };

    EngineType engineType;
    std::function<cmaj::Engine()> createEngine;
    std::optional<VirtualFileSystem> vfs; // will default to OS filesystem

    PatchManifest makePatchManifest (const std::filesystem::path& path) const
    {
        try
        {
            PatchManifest manifest;
            manifest.needsToBuildSource = engineType == EngineType::JIT;

            if (vfs)
            {
                manifest.initialiseWithVirtualFile (path.generic_string(),
                                                    vfs->createFileReader,
                                                    [getFullPath = vfs->getFullPathForFile] (const auto& p) { return getFullPath (p).string(); },
                                                    vfs->getFileModificationTime,
                                                    vfs->fileExists);
            }
            else
            {
                manifest.initialiseWithFile (path);
            }

            return manifest;
        }
        catch (...) {}

        return {};
    }

    void initialisePatch (cmaj::Patch& patch) const
    {
        patch.createEngine = createEngine;
        patch.stopPlayback = [] {};
        patch.startPlayback = [] {};
        patch.patchChanged = [] {};
        patch.statusChanged = [] (auto&&...) {};
        patch.handleOutputEvent = [] (auto&&...) {};

       #if CMAJ_USE_QUICKJS_WORKER
        enableQuickJSPatchWorker (patch);
       #else
        enableWebViewPatchWorker (patch);
       #endif

        patch.setAutoRebuildOnFileChange (engineType == EngineType::JIT);
    }
};

//==============================================================================
struct FrequencyAndBlockSize
{
    double frequency;
    uint32_t maxBlockSize;
};

//==============================================================================
template <typename PatchClass>
Environment::VirtualFileSystem createVirtualFileSystem()
{
    return
    {
        [] (const auto& f) -> std::unique_ptr<std::istream>
        {
            for (auto& file : PatchClass::files)
                if (f == file.name)
                    return std::make_unique<std::istringstream> (std::string (file.content), std::ios::binary);

            return {};
        },
        [] (const auto& path) -> std::filesystem::path { return path; },
        [] (const auto&) -> std::filesystem::file_time_type { return {}; },
        [] (const auto& f)
        {
            for (auto& file : PatchClass::files)
                if (f == file.name)
                    return true;

            return false;
        }
    };
}

template <typename PatchClass>
Environment createGeneratedCppEnvironment()
{
    using PerformerClass = typename PatchClass::PerformerClass;

    return
    {
        Environment::EngineType::AOT,
        [] { return cmaj::createEngineForGeneratedCppProgram<PerformerClass>(); },
        createVirtualFileSystem<PatchClass>(),
    };
}

inline cmaj::PatchManifest::View findDefaultViewForPatch (const cmaj::Patch& patch)
{
    if (auto manifest = patch.getManifest())
        if (auto* maybeView = manifest->findDefaultView())
            return *maybeView;

    return {};
}

// FEATHER: The patch manifest can opt out of processor-owned/native parked
// WebViews with "persistentView": false. The default is true so existing patches
// preserve their web runtime across editor close/reopen.
inline bool shouldUsePersistentView (const cmaj::PatchManifest* manifest)
{
    return manifest == nullptr || manifest->manifest["persistentView"].getWithDefault<bool> (true);
}

inline bool shouldUsePersistentView (const cmaj::Patch& patch)
{
    return shouldUsePersistentView (patch.getManifest());
}

// FEATHER: A persistent WebView may be reused for source rebuilds of the same
// loaded patch, but must be recreated when the loaded manifest/view identity
// changes so JS state from one patch cannot leak into another.
inline std::string getPersistentViewIdentity (const cmaj::Patch& patch)
{
    if (auto manifest = patch.getManifest())
    {
        const auto view = findDefaultViewForPatch (patch);
        return manifest->ID + "\n"
             + manifest->getFullPathForFile (manifest->manifestFile) + "\n"
             + view.getSource();
    }

    return {};
}

//==============================================================================
struct WebViewParkingWindow
{
    WebViewParkingWindow()
    {
      #if CHOC_WINDOWS
        static constexpr const char* className = "CmajorWebViewParkingWindow";
        static bool classRegistered = false;

        if (! classRegistered)
        {
            WNDCLASSA wc = {};
            wc.lpfnWndProc = +[] (HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) -> LRESULT
            {
                (void) hwnd;
                (void) msg;
                (void) wParam;
                (void) lParam;
                return DefWindowProc (hwnd, msg, wParam, lParam);
            };
            wc.hInstance = GetModuleHandle (nullptr);
            wc.lpszClassName = className;

            RegisterClassA (&wc);
            classRegistered = true;
        }

        hwnd = CreateWindowExA (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                                className,
                                "Cmajor WebView Parking",
                                WS_POPUP,
                                -100, -100, 1, 1,
                                nullptr, nullptr,
                                GetModuleHandle (nullptr),
                                nullptr);
      #elif CHOC_OSX || defined (__APPLE__)
        // FEATHER: TODO(mac-validate) verify parked NSView lifetime in AU/VST3 hosts.
        CHOC_AUTORELEASE_BEGIN
        nsView = choc::objc::call<id> (choc::objc::callClass<id> ("NSView", "alloc"), "init");
        choc::objc::call<void> ((id) nsView, "setHidden:", (BOOL) 1);
        CHOC_AUTORELEASE_END
      #endif
    }

    ~WebViewParkingWindow()
    {
      #if CHOC_WINDOWS
        if (hwnd != nullptr)
            DestroyWindow (hwnd);
      #elif CHOC_OSX || defined (__APPLE__)
        // FEATHER: TODO(mac-validate) verify release order when the host owns the parent NSView.
        if (nsView != nullptr)
        {
            choc::objc::call<void> ((id) nsView, "removeFromSuperview");
            choc::objc::call<void> ((id) nsView, "release");
        }
      #endif
    }

    WebViewParkingWindow (const WebViewParkingWindow&) = delete;
    WebViewParkingWindow& operator= (const WebViewParkingWindow&) = delete;

    void* getHandle() const
    {
      #if CHOC_WINDOWS
        return hwnd;
      #elif CHOC_OSX || defined (__APPLE__)
        return nsView;
      #else
        return nullptr;
      #endif
    }

  #if CHOC_WINDOWS
    HWND hwnd = nullptr;
  #elif CHOC_OSX || defined (__APPLE__)
    void* nsView = nullptr;
  #endif
};

//==============================================================================
#if CHOC_WINDOWS
// FEATHER: CBT destroy watching lets a parked WebView detach before the
// host/JUCE editor native window is destroyed. The registry is process-wide so
// a cross-thread editor teardown can remove callbacks before their owner dies.
struct NativeWindowDestroyHookLifetimeToken
{
    bool tryBeginCallback()
    {
        std::lock_guard<std::mutex> lock (mutex);

        if (! alive)
            return false;

        ++callbacksInFlight;
        ++callbacksInFlightByThread[GetCurrentThreadId()];
        return true;
    }

    void endCallback()
    {
        std::lock_guard<std::mutex> lock (mutex);

        if (callbacksInFlight != 0)
            --callbacksInFlight;

        const auto threadID = GetCurrentThreadId();

        if (auto found = callbacksInFlightByThread.find (threadID); found != callbacksInFlightByThread.end())
        {
            if (found->second > 1)
                --found->second;
            else
                callbacksInFlightByThread.erase (found);
        }

        if (callbacksInFlight == 0)
            callbacksDrained.notify_all();
    }

    void cancelAndWait()
    {
        std::unique_lock<std::mutex> lock (mutex);
        alive = false;

        // FEATHER: callbacks call unwatch while detaching. If a callback cancels
        // its own registration, do not wait on itself.
        if (callbacksInFlightByThread.find (GetCurrentThreadId()) != callbacksInFlightByThread.end())
            return;

        callbacksDrained.wait (lock, [this] { return callbacksInFlight == 0; });
    }

private:
    std::mutex mutex;
    std::condition_variable callbacksDrained;
    bool alive = true;
    uint32_t callbacksInFlight = 0;
    std::unordered_map<DWORD, uint32_t> callbacksInFlightByThread;
};

struct NativeWindowDestroyHookCallbackScope
{
    explicit NativeWindowDestroyHookCallbackScope (std::shared_ptr<NativeWindowDestroyHookLifetimeToken> tokenToUse)
        : token (std::move (tokenToUse))
    {
        if (token != nullptr && token->tryBeginCallback())
            active = true;
    }

    ~NativeWindowDestroyHookCallbackScope()
    {
        if (! active)
            return;

        token->endCallback();
    }

    NativeWindowDestroyHookCallbackScope (const NativeWindowDestroyHookCallbackScope&) = delete;
    NativeWindowDestroyHookCallbackScope& operator= (const NativeWindowDestroyHookCallbackScope&) = delete;

    explicit operator bool() const { return active; }

    std::shared_ptr<NativeWindowDestroyHookLifetimeToken> token;
    bool active = false;
};

inline std::shared_ptr<NativeWindowDestroyHookLifetimeToken> createNativeWindowDestroyHookLifetimeToken()
{
    return std::make_shared<NativeWindowDestroyHookLifetimeToken>();
}

inline void cancelNativeWindowDestroyHookCallbacks (const std::shared_ptr<NativeWindowDestroyHookLifetimeToken>& lifetime)
{
    if (lifetime != nullptr)
        lifetime->cancelAndWait();
}

struct NativeWindowDestroyHookEntry
{
    void* owner = nullptr;
    std::function<void()> onDestroy;
    std::weak_ptr<NativeWindowDestroyHookLifetimeToken> ownerLifetime;
    std::shared_ptr<NativeWindowDestroyHookLifetimeToken> registrationLifetime;
    DWORD threadID = 0;
    uint64_t generation = 0;
};

struct NativeWindowDestroyHookRegistry
{
    std::mutex mutex;
    std::unordered_map<DWORD, HHOOK> hooksByThread;
    std::unordered_map<HWND, std::vector<NativeWindowDestroyHookEntry>> trackedWindows;
    uint64_t nextGeneration = 1;
};

inline NativeWindowDestroyHookRegistry& getNativeWindowDestroyHookRegistry()
{
    static NativeWindowDestroyHookRegistry registry;
    return registry;
}

inline bool nativeWindowDestroyThreadHasTrackedWindows (const NativeWindowDestroyHookRegistry& registry, DWORD threadID)
{
    for (const auto& window : registry.trackedWindows)
        for (const auto& entry : window.second)
            if (entry.threadID == threadID)
                return true;

    return false;
}

inline void maybeRemoveNativeWindowDestroyHook (NativeWindowDestroyHookRegistry& registry, DWORD threadID)
{
    auto found = registry.hooksByThread.find (threadID);

    if (found != registry.hooksByThread.end() && ! nativeWindowDestroyThreadHasTrackedWindows (registry, threadID))
    {
        UnhookWindowsHookEx (found->second);
        registry.hooksByThread.erase (found);
    }
}

inline LRESULT CALLBACK nativeWindowDestroyHookProc (int code, WPARAM wParam, LPARAM lParam)
{
    auto& registry = getNativeWindowDestroyHookRegistry();
    const auto threadID = GetCurrentThreadId();
    HHOOK hook = nullptr;
    std::vector<NativeWindowDestroyHookEntry> callbacks;

    {
        std::lock_guard<std::mutex> lock (registry.mutex);

        if (auto foundHook = registry.hooksByThread.find (threadID); foundHook != registry.hooksByThread.end())
            hook = foundHook->second;

        if (code == HCBT_DESTROYWND)
        {
            auto destroyedWindow = reinterpret_cast<HWND> (wParam);
            auto found = registry.trackedWindows.find (destroyedWindow);

            if (found != registry.trackedWindows.end())
            {
                callbacks = std::move (found->second);
                registry.trackedWindows.erase (found);

                maybeRemoveNativeWindowDestroyHook (registry, threadID);
            }
        }
    }

    for (auto& entry : callbacks)
    {
        auto ownerLifetime = entry.ownerLifetime.lock();

        if (ownerLifetime == nullptr || entry.registrationLifetime == nullptr)
            continue;

        NativeWindowDestroyHookCallbackScope ownerCallback (std::move (ownerLifetime));
        NativeWindowDestroyHookCallbackScope registrationCallback (entry.registrationLifetime);

        if (ownerCallback && registrationCallback && entry.onDestroy)
            entry.onDestroy();
    }

    return CallNextHookEx (hook, code, wParam, lParam);
}

inline void watchNativeWindowDestroy (void* owner, HWND hwnd,
                                      const std::shared_ptr<NativeWindowDestroyHookLifetimeToken>& ownerLifetime,
                                      const std::shared_ptr<NativeWindowDestroyHookLifetimeToken>& registrationLifetime,
                                      std::function<void()> onDestroy)
{
    if (owner == nullptr || hwnd == nullptr || ownerLifetime == nullptr || registrationLifetime == nullptr)
        return;

    auto& registry = getNativeWindowDestroyHookRegistry();
    const auto threadID = GetWindowThreadProcessId (hwnd, nullptr);

    if (threadID == 0)
        return;

    std::lock_guard<std::mutex> lock (registry.mutex);

    if (registry.hooksByThread.find (threadID) == registry.hooksByThread.end())
    {
        auto hook = SetWindowsHookEx (WH_CBT, nativeWindowDestroyHookProc, nullptr, threadID);

        if (hook == nullptr)
            return;

        registry.hooksByThread[threadID] = hook;
    }

    auto& entries = registry.trackedWindows[hwnd];

    auto existing = std::find_if (entries.begin(), entries.end(),
                                  [owner] (const auto& entry) { return entry.owner == owner; });

    if (existing != entries.end())
    {
        existing->onDestroy = std::move (onDestroy);
        existing->ownerLifetime = ownerLifetime;
        existing->registrationLifetime = registrationLifetime;
        existing->threadID = threadID;
        existing->generation = registry.nextGeneration++;
        return;
    }

    entries.push_back ({ owner, std::move (onDestroy), ownerLifetime, registrationLifetime, threadID, registry.nextGeneration++ });
}

inline void unwatchNativeWindowDestroy (void* owner, HWND hwnd)
{
    if (owner == nullptr || hwnd == nullptr)
        return;

    auto& registry = getNativeWindowDestroyHookRegistry();
    std::vector<DWORD> affectedThreadIDs;
    std::vector<std::shared_ptr<NativeWindowDestroyHookLifetimeToken>> cancelledRegistrations;

    {
        std::lock_guard<std::mutex> lock (registry.mutex);
        auto found = registry.trackedWindows.find (hwnd);

        if (found == registry.trackedWindows.end())
            return;

        auto& entries = found->second;

        for (const auto& entry : entries)
        {
            if (entry.owner == owner)
            {
                affectedThreadIDs.push_back (entry.threadID);
                cancelledRegistrations.push_back (entry.registrationLifetime);
            }
        }

        entries.erase (std::remove_if (entries.begin(), entries.end(),
                                       [owner] (const auto& entry) { return entry.owner == owner; }),
                       entries.end());

        if (entries.empty())
            registry.trackedWindows.erase (found);

        for (auto threadID : affectedThreadIDs)
            maybeRemoveNativeWindowDestroyHook (registry, threadID);
    }

    for (auto& registration : cancelledRegistrations)
        cancelNativeWindowDestroyHookCallbacks (registration);
}

inline void unwatchAllNativeWindowDestroy (void* owner)
{
    if (owner == nullptr)
        return;

    auto& registry = getNativeWindowDestroyHookRegistry();
    std::vector<DWORD> affectedThreadIDs;
    std::vector<std::shared_ptr<NativeWindowDestroyHookLifetimeToken>> cancelledRegistrations;

    {
        std::lock_guard<std::mutex> lock (registry.mutex);

        for (auto i = registry.trackedWindows.begin(); i != registry.trackedWindows.end();)
        {
            auto& entries = i->second;

            for (const auto& entry : entries)
            {
                if (entry.owner == owner)
                {
                    affectedThreadIDs.push_back (entry.threadID);
                    cancelledRegistrations.push_back (entry.registrationLifetime);
                }
            }

            entries.erase (std::remove_if (entries.begin(), entries.end(),
                                           [owner] (const auto& entry) { return entry.owner == owner; }),
                           entries.end());

            if (entries.empty())
                i = registry.trackedWindows.erase (i);
            else
                ++i;
        }

        for (auto threadID : affectedThreadIDs)
            maybeRemoveNativeWindowDestroyHook (registry, threadID);
    }

    for (auto& registration : cancelledRegistrations)
        cancelNativeWindowDestroyHookCallbacks (registration);
}
#endif

//==============================================================================
inline bool addChildView (void* parent, void* child)
{
    CMAJ_FEATHER_WEBVIEW_LOG ("addChildView parent=" + debugPointerToString (parent)
                              + " child=" + debugPointerToString (child));

  #if CHOC_OSX || defined (__APPLE__)
    try
    {
        // FEATHER: TODO(mac-validate) verify coordinate origin after reparenting
        // from the parking NSView back to the host editor NSView.
        choc::objc::call<void> ((id) child, "removeFromSuperview");
        choc::objc::call<void> ((id) parent, "addSubview:", (id) child);
        choc::objc::call<void> ((id) child, "setHidden:", (BOOL) 0);
        return true;
    }
    catch (...) {}

    return false;
  #elif CHOC_WINDOWS
    SetLastError (ERROR_SUCCESS);
    auto previousParent = SetParent (static_cast<HWND> (child), static_cast<HWND> (parent));

    if (previousParent == nullptr && GetLastError() != ERROR_SUCCESS)
        return false;

    ShowWindow (static_cast<HWND> (child), SW_SHOWNA);
    return true;
  #else
    (void) parent;
    (void) child;
    // TODO: support linux
    return false;
  #endif
}

inline bool removeChildView (void* child)
{
    if (child == nullptr)
        return false;

    CMAJ_FEATHER_WEBVIEW_LOG ("removeChildView child=" + debugPointerToString (child));

  #if CHOC_OSX || defined (__APPLE__)
    try
    {
        choc::objc::call<void> ((id) child, "setHidden:", (BOOL) 1);
        choc::objc::call<void> ((id) child, "removeFromSuperview");
        return true;
    }
    catch (...) {}

    return false;
  #elif CHOC_WINDOWS
    ShowWindow (static_cast<HWND> (child), SW_HIDE);
    SetLastError (ERROR_SUCCESS);
    auto previousParent = SetParent (static_cast<HWND> (child), nullptr);
    return previousParent != nullptr || GetLastError() == ERROR_SUCCESS;
  #else
    (void) child;
    // TODO: support linux
    return false;
  #endif
}

inline bool parkChildView (WebViewParkingWindow& parkingWindow, void* child)
{
    if (child == nullptr)
        return false;

    CMAJ_FEATHER_WEBVIEW_LOG ("parkChildView parking=" + debugPointerToString (parkingWindow.getHandle())
                              + " child=" + debugPointerToString (child));

  #if CHOC_WINDOWS
    if (auto* parkingHandle = static_cast<HWND> (parkingWindow.getHandle()))
    {
        SetLastError (ERROR_SUCCESS);
        auto previousParent = SetParent (static_cast<HWND> (child), parkingHandle);

        if (previousParent == nullptr && GetLastError() != ERROR_SUCCESS)
            return false;

        ShowWindow (static_cast<HWND> (child), SW_HIDE);
        return true;
    }

    return removeChildView (child);
  #elif CHOC_OSX || defined (__APPLE__)
    if (auto* parkingView = parkingWindow.getHandle())
    {
        if (! addChildView (parkingView, child))
            return false;

        // FEATHER: TODO(mac-validate) confirm WKWebView remains alive and quiet
        // while hidden under this unattached parking NSView.
        choc::objc::call<void> ((id) child, "setHidden:", (BOOL) 1);
        return true;
    }

    return removeChildView (child);
  #else
    (void) parkingWindow;
    return removeChildView (child);
  #endif
}

inline bool isNativeChildViewAttachedToParentChain (void* parent, void* child)
{
    if (parent == nullptr || child == nullptr)
        return false;

  #if CHOC_WINDOWS
    auto parentHwnd = static_cast<HWND> (parent);
    auto childHwnd = static_cast<HWND> (child);

    if (! IsWindow (parentHwnd) || ! IsWindow (childHwnd))
        return false;

    for (auto hwnd = GetParent (childHwnd); hwnd != nullptr; hwnd = GetParent (hwnd))
        if (hwnd == parentHwnd)
            return true;

    return false;
  #else
    return true;
  #endif
}

#if CHOC_WINDOWS
inline LPARAM makeSpacebarPassthroughLParam (bool keyDown, bool repeated)
{
    constexpr auto scanCode = 0x39u;
    auto flags = 1u | (scanCode << 16);

    if (repeated || ! keyDown)
        flags |= 1u << 30;

    if (! keyDown)
        flags |= 1u << 31;

    return static_cast<LPARAM> (flags);
}
#endif

inline bool installSpacebarPassthrough (choc::ui::WebView& webView, std::function<bool()> shouldPassSpaceToHost)
{
  #if CHOC_WINDOWS
    auto hwnd = static_cast<HWND> (webView.getViewHandle());

    if (hwnd == nullptr)
        return false;

    // FEATHER: WebView2 key events target transient Chrome_WidgetWin child
    // HWNDs, so subclassing the outer WebView HWND misses spacebar input.
    // A page-level bridge survives WebView2 child churn and reloads.
    static constexpr auto bridgeScript = R"(
        (() => {
            if (window.__cmajSpacebarPassthroughInstalled)
                return;

            window.__cmajSpacebarPassthroughInstalled = true;

            const isTextInput = element =>
            {
                if (! element)
                    return false;

                const tagName = element.tagName;
                return tagName === "INPUT" || tagName === "TEXTAREA" || element.isContentEditable;
            };

            const passSpacebarToHost = event =>
            {
                if (event.code !== "Space" && event.key !== " ")
                    return;

                if (isTextInput (document.activeElement))
                    return;

                event.preventDefault();
                event.stopPropagation();
                window.cmaj_passSpacebarToHost?.(event.type, event.repeat === true);
            };

            window.addEventListener ("keydown", passSpacebarToHost, true);
            window.addEventListener ("keyup", passSpacebarToHost, true);
        })();
    )";

    if (! webView.bind ("cmaj_passSpacebarToHost",
            [hwnd, shouldPassSpaceToHost = std::move (shouldPassSpaceToHost)] (const choc::value::ValueView& args) -> choc::value::Value
            {
                if (shouldPassSpaceToHost && ! shouldPassSpaceToHost())
                    return {};

                const auto eventType = args.isArray() && args.size() != 0 ? args[0].toString() : std::string {};
                const auto isKeyUp = eventType == "keyup";
                const auto repeated = args.isArray() && args.size() > 1 && args[1].getWithDefault<bool> (false);

                if (auto parent = GetParent (hwnd))
                    PostMessage (parent, isKeyUp ? WM_KEYUP : WM_KEYDOWN,
                                 VK_SPACE, makeSpacebarPassthroughLParam (! isKeyUp, repeated));

                return {};
            }))
    {
        return false;
    }

    const auto scriptAdded = webView.addInitScript (bridgeScript);
    (void) scriptAdded;
    webView.evaluateJavascript (bridgeScript);
    return true;
  #else
    (void) webView;
    (void) shouldPassSpaceToHost;
    return true;
  #endif
}

inline void uninstallSpacebarPassthrough (choc::ui::WebView& webView)
{
  #if CHOC_WINDOWS
    webView.unbind ("cmaj_passSpacebarToHost");
  #else
    (void) webView;
  #endif
}

inline bool setViewFrame (void* view, int x, int y, uint32_t width, uint32_t height)
{
  #if CHOC_OSX || defined (__APPLE__)
    CHOC_AUTORELEASE_BEGIN
    // FEATHER: TODO(mac-validate) JUCE and AppKit have opposite y-axis
    // conventions in some host embeddings; verify this with AU/VST3 hosts.
    auto frame = choc::objc::CGRect {{ (choc::objc::CGFloat) x, (choc::objc::CGFloat) y },
                                      { (choc::objc::CGFloat) width, (choc::objc::CGFloat) height }};
    choc::objc::call<void> ((id) view, "setFrame:", frame);
    CHOC_AUTORELEASE_END
    return true;
  #elif CHOC_WINDOWS
    return MoveWindow (static_cast<HWND> (view), x, y, static_cast<int> (width), static_cast<int> (height), true);
  #else
    (void) view;
    (void) x;
    (void) y;
    (void) width;
    (void) height;
    // TODO: support linux
    return false;
  #endif
}

inline bool setViewSize (void* view, uint32_t width, uint32_t height)
{
  #if CHOC_OSX || defined (__APPLE__) || CHOC_WINDOWS
    return setViewFrame (view, 0, 0, width, height);
  #else
    (void) view;
    (void) width;
    (void) height;
    // TODO: support linux
    return false;
  #endif
}


} // namespace cmaj::plugin
