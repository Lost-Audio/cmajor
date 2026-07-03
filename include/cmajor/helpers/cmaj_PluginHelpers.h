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
#include <filesystem>
#include <functional>
#include <istream>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace cmaj::plugin
{

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
// FEATHER: Thread-local CBT destroy watching lets a parked WebView detach before
// the host/JUCE editor native window is destroyed. This mirrors the reference
// implementation without depending on JUCE's WebBrowserComponent.
struct NativeWindowDestroyHookEntry
{
    void* owner = nullptr;
    std::function<void()> onDestroy;
};

struct NativeWindowDestroyHookRegistry
{
    HHOOK hook = nullptr;
    std::unordered_map<HWND, std::vector<NativeWindowDestroyHookEntry>> trackedWindows;
};

inline NativeWindowDestroyHookRegistry& getNativeWindowDestroyHookRegistry()
{
    static thread_local NativeWindowDestroyHookRegistry registry;
    return registry;
}

inline void maybeRemoveNativeWindowDestroyHook()
{
    auto& registry = getNativeWindowDestroyHookRegistry();

    if (registry.hook != nullptr && registry.trackedWindows.empty())
    {
        UnhookWindowsHookEx (registry.hook);
        registry.hook = nullptr;
    }
}

inline LRESULT CALLBACK nativeWindowDestroyHookProc (int code, WPARAM wParam, LPARAM lParam)
{
    auto& registry = getNativeWindowDestroyHookRegistry();

    if (code == HCBT_DESTROYWND)
    {
        auto destroyedWindow = reinterpret_cast<HWND> (wParam);
        auto found = registry.trackedWindows.find (destroyedWindow);

        if (found != registry.trackedWindows.end())
        {
            auto callbacks = std::move (found->second);
            registry.trackedWindows.erase (found);

            for (auto& entry : callbacks)
                if (entry.onDestroy)
                    entry.onDestroy();

            maybeRemoveNativeWindowDestroyHook();
        }
    }

    return CallNextHookEx (registry.hook, code, wParam, lParam);
}

inline void watchNativeWindowDestroy (void* owner, HWND hwnd, std::function<void()> onDestroy)
{
    if (owner == nullptr || hwnd == nullptr)
        return;

    auto& registry = getNativeWindowDestroyHookRegistry();

    if (registry.hook == nullptr)
        registry.hook = SetWindowsHookEx (WH_CBT, nativeWindowDestroyHookProc, nullptr, GetCurrentThreadId());

    if (registry.hook == nullptr)
        return;

    auto& entries = registry.trackedWindows[hwnd];

    auto existing = std::find_if (entries.begin(), entries.end(),
                                  [owner] (const auto& entry) { return entry.owner == owner; });

    if (existing != entries.end())
    {
        existing->onDestroy = std::move (onDestroy);
        return;
    }

    entries.push_back ({ owner, std::move (onDestroy) });
}

inline void unwatchNativeWindowDestroy (void* owner, HWND hwnd)
{
    if (owner == nullptr || hwnd == nullptr)
        return;

    auto& registry = getNativeWindowDestroyHookRegistry();
    auto found = registry.trackedWindows.find (hwnd);

    if (found == registry.trackedWindows.end())
        return;

    auto& entries = found->second;
    entries.erase (std::remove_if (entries.begin(), entries.end(),
                                   [owner] (const auto& entry) { return entry.owner == owner; }),
                   entries.end());

    if (entries.empty())
        registry.trackedWindows.erase (found);

    maybeRemoveNativeWindowDestroyHook();
}

inline void unwatchAllNativeWindowDestroy (void* owner)
{
    if (owner == nullptr)
        return;

    auto& registry = getNativeWindowDestroyHookRegistry();

    for (auto i = registry.trackedWindows.begin(); i != registry.trackedWindows.end();)
    {
        auto& entries = i->second;
        entries.erase (std::remove_if (entries.begin(), entries.end(),
                                       [owner] (const auto& entry) { return entry.owner == owner; }),
                       entries.end());

        if (entries.empty())
            i = registry.trackedWindows.erase (i);
        else
            ++i;
    }

    maybeRemoveNativeWindowDestroyHook();
}
#endif

//==============================================================================
inline bool addChildView (void* parent, void* child)
{
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

#if CHOC_WINDOWS
struct SpacebarPassthroughState
{
    WNDPROC previousWndProc = nullptr;
    std::function<bool()> shouldPassSpaceToHost;
};

inline std::unordered_map<HWND, SpacebarPassthroughState>& getSpacebarPassthroughStates()
{
    static std::unordered_map<HWND, SpacebarPassthroughState> states;
    return states;
}

inline LRESULT CALLBACK spacebarPassthroughWndProc (HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    auto& states = getSpacebarPassthroughStates();
    const auto state = states.find (hwnd);

    if (state != states.end())
    {
        const auto isSpaceKeyMessage = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN
                                     || msg == WM_KEYUP   || msg == WM_SYSKEYUP)
                                    && wParam == VK_SPACE;

        if (isSpaceKeyMessage && state->second.shouldPassSpaceToHost && state->second.shouldPassSpaceToHost())
        {
            if (auto parent = GetParent (hwnd))
                PostMessage (parent, msg, wParam, lParam);

            return 0;
        }

        if (state->second.previousWndProc != nullptr)
            return CallWindowProc (state->second.previousWndProc, hwnd, msg, wParam, lParam);
    }

    return DefWindowProc (hwnd, msg, wParam, lParam);
}
#endif

inline void installSpacebarPassthrough (void* view, std::function<bool()> shouldPassSpaceToHost)
{
    if (view == nullptr)
        return;

  #if CHOC_WINDOWS
    auto hwnd = static_cast<HWND> (view);
    auto& state = getSpacebarPassthroughStates()[hwnd];
    state.shouldPassSpaceToHost = std::move (shouldPassSpaceToHost);

    if (state.previousWndProc == nullptr)
        state.previousWndProc = reinterpret_cast<WNDPROC> (SetWindowLongPtr (hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR> (spacebarPassthroughWndProc)));
  #else
    (void) view;
    (void) shouldPassSpaceToHost;
  #endif
}

inline void uninstallSpacebarPassthrough (void* view)
{
    if (view == nullptr)
        return;

  #if CHOC_WINDOWS
    auto hwnd = static_cast<HWND> (view);
    auto& states = getSpacebarPassthroughStates();
    auto state = states.find (hwnd);

    if (state != states.end())
    {
        if (state->second.previousWndProc != nullptr)
            SetWindowLongPtr (hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR> (state->second.previousWndProc));

        states.erase (state);
    }
  #else
    (void) view;
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
