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

#if JUCE_LINUX
 #define Font FontX  // Gotta love these C headers with global symbol clashes.. sigh..
 #define Time TimeX
 #define Drawable DrawableX
 #define Status StatusX
 #include <gtk/gtkx.h>
 #undef Font
 #undef Time
 #undef Drawable
 #undef Status
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>
#include "cmaj_AudioBusLayoutHelper.h"
#include "cmaj_PluginHelpers.h"
#include "cmaj_PatchWebView.h"
#include "cmaj_GeneratedCppEngine.h"
#include "../../choc/choc/audio/choc_AudioFileFormat_WAV.h"
#include "../../choc/choc/text/choc_Files.h"

#if CMAJ_USE_QUICKJS_WORKER
 #include "cmaj_PatchWorker_QuickJS.h"
#else
 #include "cmaj_PatchWorker_WebView.h"
#endif

namespace cmaj::plugin
{

//==============================================================================
/// This base class is used in creating a juce::AudioPluginInstance that either
/// JIT-compiles patches dynamically, or which is specialised to run a pre-generated
/// C++ version of a patch.
///
/// See the cmaj::plugin::JITLoaderPlugin and cmaj::plugin::GeneratedPlugin
/// types below for how to use it in these different modes.
///
template <typename DerivedType>
class JUCEPluginBase  : public juce::AudioPluginInstance,
                        private juce::MessageListener
{
public:
    JUCEPluginBase (std::shared_ptr<cmaj::Patch> patchToUse, BusesProperties buses)
        : juce::AudioPluginInstance (std::move (buses)),
          patch (std::move (patchToUse)),
          dllLoadedSuccessfully (initialiseDLL())
    {
        if (juce::MessageManager::getInstance()->isThisTheMessageThread())
            choc::messageloop::initialise();
        else
            juce::MessageManager::callAsync ([] { choc::messageloop::initialise(); });

        if (! dllLoadedSuccessfully)
        {
            setStatusMessage ("Could not load the required Cmajor DLL", true);
            return;
        }

        patch->setHostDescription (std::string (getWrapperTypeDescription (wrapperType)));

        patch->stopPlayback  = [this] { suspendProcessing (true); };
        patch->startPlayback = [this] { suspendProcessing (false); };

        patch->patchChanged = [this]
        {
            updateCachedAudioBusLayoutFromPatch();
            resizeAudioChannelPointerStorage();
            resizeSilentBusScratch (static_cast<uint32_t> (getBlockSize()));

            if (juce::MessageManager::getInstance()->isThisTheMessageThread())
                handlePatchChange();
            else
                postPatchChange();
        };

        patch->statusChanged = [this] (const auto& s) { setStatusMessageAsync (s.statusMessage, s.messageList.hasErrors()); };

        patch->handleOutputEvent = [this] (uint64_t frame, std::string_view endpointID, const choc::value::ValueView& v)
        {
            handleOutputEvent (frame, endpointID, v);
        };

        // FEATHER: Preset files belong to the native wrapper because patch code
        // and WebViews cannot safely own host file I/O.
        patch->handlePresetList   = [this] { return listPresets(); };
        patch->handlePresetSave   = [this] (const std::string& name, const choc::value::ValueView& state) { return savePreset (name, state); };
        patch->handlePresetLoad   = [this] (const std::string& name) { return loadPreset (name); };
        patch->handlePresetDelete = [this] (const std::string& name) { return deletePreset (name); };

       #if CMAJ_USE_QUICKJS_WORKER
        enableQuickJSPatchWorker (*patch);
        #else
         enableWebViewPatchWorker (*patch);
        #endif

        updateCachedAudioBusLayoutFromPatch();
    }

    ~JUCEPluginBase() override
    {
      #if JUCE_WINDOWS
        cmaj::plugin::cancelNativeWindowDestroyHookCallbacks (nativeWindowDestroyHookLifetime);
      #endif

        patch->patchChanged = [] {};
        patch->statusChanged = [] (const Patch::Status&) {};
        patch->handlePresetList = {};
        patch->handlePresetSave = {};
        patch->handlePresetLoad = {};
        patch->handlePresetDelete = {};
        // FEATHER: Park and then destroy the processor-owned WebView before the
        // parking native window member is torn down.
        destroyPatchWebView();
        patch->unload();
        patch.reset();
    }

    //==============================================================================
    void unload()
    {
        unload ({}, false);
    }

    std::function<void(const char*)> handleConsoleMessage;
    std::function<void(DerivedType&)> patchChangeCallback;

    //==============================================================================
    const juce::String getName() const override          { return patch->getName(); }

    juce::StringArray getAlternateDisplayNames() const override
    {
        juce::StringArray s;
        s.add (patch->getName());

        if (auto n = patch->getDescription(); ! n.empty())
            s.add (n);

        return s;
    }

    juce::AudioProcessorEditor* createEditor() override   { return new Editor (static_cast<DerivedType&> (*this)); }
    bool hasEditor() const override                       { return true; }

    bool acceptsMidi() const override                     { return patch->hasMIDIInput() || ! patch->isLoaded(); }
    bool producesMidi() const override                    { return patch->hasMIDIOutput(); }
    bool supportsMPE() const override                     { return acceptsMidi(); }
    bool isMidiEffect() const override                    { return patch->hasMIDIInput() && ! patch->hasAudioOutput(); }
    double getTailLengthSeconds() const override          { return 0; }

    int getNumPrograms() override                               { return 1; }
    int getCurrentProgram() override                            { return 0; }
    void setCurrentProgram (int) override                       {}
    const juce::String getProgramName (int) override            { return "None"; }
    void changeProgramName (int, const juce::String&) override  {}

    //==============================================================================
    static constexpr const char* getPluginFormatName()      { return "Cmajor"; }
    static constexpr const char* getIdentifierPrefix()      { return "Cmajor:"; }

    void fillInPluginDescription (juce::PluginDescription& d) const override
    {
        if (patch->isLoaded())
        {
            d.name                = patch->getName();
            d.descriptiveName     = patch->getDescription().empty() ? patch->getName() : patch->getDescription();
            d.category            = patch->getCategory();
            d.manufacturerName    = patch->getManufacturer();
            d.version             = patch->getVersion();
            d.lastFileModTime     = getManifestFile (*patch).getLastModificationTime();
            d.isInstrument        = patch->isInstrument();
            d.uniqueId            = static_cast<int> (std::hash<std::string>{} (patch->getUID()));
        }
        else
        {
            d.name                = "Cmajor Patch-loader";
            d.descriptiveName     = d.name;
            d.category            = {};
            d.manufacturerName    = "Cmajor Software Ltd.";
            d.version             = {};
            d.lastFileModTime     = {};
            d.isInstrument        = true;
            d.uniqueId            = {};
        }

        d.fileOrIdentifier    = createPatchID (*patch);
        d.pluginFormatName    = getPluginFormatName();
        d.lastInfoUpdateTime  = juce::Time::getCurrentTime();
        d.deprecatedUid       = d.uniqueId;
    }

    static std::string createPatchID (const PatchManifest& m)
    {
        return getIdentifierPrefix()
                 + choc::json::toString (choc::json::create ("ID", m.ID,
                                                             "name", m.name,
                                                             "location", m.getFullPathForFile (m.manifestFile)),
                                         false);
    }

    static std::string createPatchID (const Patch& p)
    {
        if (auto m = p.getManifest())
            return createPatchID (*m);

        return getIdentifierPrefix() + std::string ("{}");
    }

    static bool isCmajorIdentifier (const juce::String& fileOrIdentifier)
    {
        return fileOrIdentifier.startsWith (getIdentifierPrefix());
    }

    static juce::File getManifestFile (const Patch& p)
    {
        if (auto m = p.getManifest())
            return juce::File (m->getFullPathForFile (m->manifestFile));

        return {};
    }

    static choc::value::Value getPropertyFromPluginID (const juce::String& fileOrIdentifier, std::string_view property)
    {
        if (isCmajorIdentifier (fileOrIdentifier))
        {
            try
            {
                auto json = choc::json::parse (fileOrIdentifier.fromFirstOccurrenceOf (getIdentifierPrefix(), false, true).toStdString());
                return choc::value::Value (json[property]);
            }
            catch (...) {}
        }

        return {};
    }

    static std::string getIDFromPluginID (const juce::String& fileOrIdentifier)
    {
        return getPropertyFromPluginID (fileOrIdentifier, "ID").toString();
    }

    static std::string getNameFromPluginID (const juce::String& fileOrIdentifier)
    {
        return getPropertyFromPluginID (fileOrIdentifier, "name").toString();
    }

    //==============================================================================
    void prepareToPlay (double sampleRate, int samplesPerBlock) override
    {
        applyRateAndBlockSize (sampleRate, static_cast<uint32_t> (samplesPerBlock));

        // FEATHER: dynamic loader keeps a fixed 30s post-output rolling capture ring.
        if constexpr (! DerivedType::isFixedPatch)
            static_cast<DerivedType&> (*this).prepareOutputCapture (sampleRate);
    }

    void releaseResources() override
    {
    }

    bool isLayoutOK (const std::vector<cmaj::audio_bus_layout::BusGroup>& patchLayouts,
                     const std::vector<int>& hostBusMappings,
                     const juce::Array<juce::AudioChannelSet>& suggestedLayouts,
                     bool isInput) const
    {
        if (patchLayouts.empty())
            return suggestedLayouts.isEmpty() || suggestedLayouts.getReference(0).size() == 0;

        if (hostBusMappings.size() != patchLayouts.size())
            return false;

        for (int i = 0; i < static_cast<int> (patchLayouts.size()); ++i)
        {
            auto& patchLayout = patchLayouts[(size_t) i];
            auto hostBusIndex = hostBusMappings[(size_t) i];

            if (hostBusIndex < 0)
                continue;

            if (hostBusIndex >= suggestedLayouts.size())
                return false;

            auto suggestedSize = suggestedLayouts.getReference(hostBusIndex).size();

            // FEATHER: the dynamic patch-loader has one predeclared stereo aux input bus.
            // Patch aux channel-count mismatches are handled by the cached process routing.
            if constexpr (! DerivedType::isFixedPatch)
                if (isInput && hostBusIndex == dynamicSidechainInputBusIndex && patchLayout.isAuxiliary())
                    continue;

            // FEATHER: hosts may disable auxiliary/sidechain buses; input endpoints are
            // silence-backed and output endpoints are routed to discard scratch buffers.
            if (! cmaj::audio_bus_layout::isMainBus (patchLayout, static_cast<size_t> (i)) && suggestedSize == 0)
                continue;

            // FEATHER: adaptive main buses accept any non-empty host size; the cached
            // process mapping replicates or folds channels (see refreshAudioChannelPointers()
            // and applyOutputBusChannelAdaptation()). channelMode: "strict" opts out.
            if (suggestedSize > 0 && cmaj::audio_bus_layout::shouldAdaptChannels (patchLayout, static_cast<size_t> (i)))
                continue;

            if (static_cast<int> (patchLayout.channelCount) != suggestedSize)
                return false;
        }

        return true;
    }

    bool isBusesLayoutSupported (const BusesLayout& layout) const override
    {
        if (! patch->isLoaded())
            return true;

        if (inputAudioBusGroups.empty() && outputAudioBusGroups.empty())
            const_cast<JUCEPluginBase*> (this)->updateCachedAudioBusLayoutFromPatch();

        return isLayoutOK (inputAudioBusGroups,  inputAudioBusGroupHostBuses,  layout.inputBuses,  true)
            && isLayoutOK (outputAudioBusGroups, outputAudioBusGroupHostBuses, layout.outputBuses, false);
    }

    bool applyBusLayouts (const BusesLayout& layouts) override
    {
        auto result = juce::AudioPluginInstance::applyBusLayouts (layouts);
        applyCurrentRateAndBlockSize();
        return result;
    }

    void processBlock (juce::AudioBuffer<float>& audio, juce::MidiBuffer& midi) override
    {
        if (! patch->isPlayable() || isSuspended())
        {
            audio.clear();
            midi.clear();
            return;
        }

        juce::ScopedNoDenormals noDenormals;

        if (auto ph = getPlayHead())
            updateTimelineFromPlayhead (*ph);

        if (! refreshAudioChannelPointers (audio))
        {
            audio.clear();
            midi.clear();
            return;
        }

        auto numFrames = static_cast<choc::buffer::FrameCount> (audio.getNumSamples());

        for (auto m : midi)
            patch->addMIDIMessage (m.samplePosition, m.data, static_cast<uint32_t> (m.numBytes));

        midi.clear();

        patch->process (inputChannelPointers.data(), outputChannelPointers.data(), numFrames,
                        [&] (uint32_t frame, choc::midi::ShortMessage m)
                        {
                            midi.addEvent (m.data(), static_cast<int> (m.length()), static_cast<int> (frame));
                        });

        // FEATHER: adapt main output bus groups whose channel count differs from the
        // host bus (e.g. a mono patch on the dynamic loader's stereo output bus).
        applyOutputBusChannelAdaptation (audio, static_cast<int> (numFrames));

        // FEATHER: capture exactly the post-adaptation output that the host hears.
        if constexpr (! DerivedType::isFixedPatch)
            static_cast<DerivedType&> (*this).captureProcessedOutput (audio, static_cast<int> (numFrames));
    }

    void processBlock (juce::AudioBuffer<double>&, juce::MidiBuffer&) override { CMAJ_ASSERT_FALSE; }

    //==============================================================================
    void getStateInformation (juce::MemoryBlock& data) override
    {
        juce::MemoryOutputStream m (data, false);
        getUpdatedState().writeToStream (m);
    }

    void setStateInformation (const void* data, int size) override
    {
        juce::ScopedValueSetter<bool> deferUIUpdates (deferPatchViewUpdates, true);
        setNewState (juce::ValueTree::readFromData (data, static_cast<size_t> (size)));
    }

    Patch::PlaybackParams getPlaybackParams (double rate, uint32_t requestedBlockSize)
    {
        auto layout = getBusesLayout();

        auto inputChannels = static_cast<choc::buffer::ChannelCount> (getTotalChannels (layout.inputBuses));
        auto outputChannels = static_cast<choc::buffer::ChannelCount> (getTotalChannels (layout.outputBuses));

        // FEATHER: when an auxiliary bus is disabled by the host, the JUCE layout reports
        // fewer channels than the patch declares. Keep the patch's full bus shape prepared
        // and back missing input channels with silence in refreshAudioChannelPointers().
        if (patch->isLoaded())
        {
            inputChannels  = inputAudioChannelCount;
            outputChannels = outputAudioChannelCount;
        }

        return Patch::PlaybackParams (rate, requestedBlockSize, inputChannels, outputChannels);
    }

    void applyRateAndBlockSize (double sampleRate, uint32_t samplesPerBlock)
    {
        updateCachedAudioBusLayoutFromPatch();
        resizeAudioChannelPointerStorage();
        resizeSilentBusScratch (samplesPerBlock);

        if (dllLoadedSuccessfully)
            patch->setPlaybackParams (getPlaybackParams (sampleRate, samplesPerBlock));
    }

    void applyCurrentRateAndBlockSize()
    {
        applyRateAndBlockSize (getSampleRate(), static_cast<uint32_t> (getBlockSize()));
    }

    std::shared_ptr<Patch> patch;
    std::string statusMessage;
    bool isStatusMessageError = false;
    bool dllLoadedSuccessfully = false;

protected:
    bool deferPatchViewUpdates = false;
    bool patchViewUpdatePending = false;
    std::vector<float*> inputChannelPointers, outputChannelPointers;
    std::vector<cmaj::audio_bus_layout::BusGroup> inputAudioBusGroups, outputAudioBusGroups;
    std::vector<int> inputAudioBusGroupHostBuses, outputAudioBusGroupHostBuses;
    choc::buffer::ChannelCount inputAudioChannelCount = 0, outputAudioChannelCount = 0;
    juce::AudioBuffer<float> inputSilentBusScratch, outputDisabledBusScratch;
    std::string lastDynamicLoaderUnmappedAuxWarning;

    static constexpr int disabledHostBusIndex = -1;
    static constexpr int dynamicMainInputBusIndex = 0;
    static constexpr int dynamicSidechainInputBusIndex = 1;
    static constexpr int dynamicMainOutputBusIndex = 0;

    //==============================================================================
    static bool initialiseDLL()
    {
        if constexpr (cmaj::Library::isUsingDLL && ! DerivedType::isPrecompiled)
        {
            static bool initialised = false;

            if (initialised)
                return true;

            auto tryLoading = [&] (const juce::File& dll)
            {
                if (dll.existsAsFile())
                    initialised = cmaj::Library::initialise (dll.getFullPathName().toStdString());

                return initialised;
            };

            auto exe = juce::File::getSpecialLocation (juce::File::currentExecutableFile);
            auto dllName = cmaj::Library::getDLLName();

           #if CHOC_OSX
            auto bundleFolder = juce::File::getSpecialLocation (juce::File::currentApplicationFile);

            return tryLoading (bundleFolder.getChildFile ("Contents/Resources").getChildFile (dllName))
                        || tryLoading (exe.getSiblingFile (dllName))
                        || tryLoading (bundleFolder.getSiblingFile (dllName));
           #else
            return tryLoading (exe.getSiblingFile (dllName));
           #endif
        }
        else
        {
            return true;
        }
    }

    //==============================================================================
    static BusesProperties getBusesProperties (const EndpointDetailsList& inputs,
                                               const EndpointDetailsList& outputs)
    {
        BusesProperties layout;

        addEndpointAudioBuses (layout, true,  inputs,  "in");
        addEndpointAudioBuses (layout, false, outputs, "out");

        return layout;
    }

    static int getTotalChannels (const juce::Array<juce::AudioChannelSet>& buses)
    {
        int total = 0;

        for (auto& bus : buses)
            total += bus.size();

        return total;
    }

    static void addEndpointAudioBuses (BusesProperties& layout, bool isInput, const EndpointDetailsList& endpoints, const char* defaultName)
    {
        (void) defaultName;

        // FEATHER: use the shared bus grouping helper so generated JUCE wrappers,
        // dynamic JUCE wrappers, and CLAP wrappers interpret annotations identically.
        for (auto& bus : cmaj::audio_bus_layout::groupEndpointsByBus (endpoints))
            layout.addBus (isInput, juce::String (bus.name), juce::AudioChannelSet::canonicalChannelSet ((int) bus.channelCount), true);
    }

    void updateCachedAudioBusLayoutFromPatch()
    {
        inputAudioBusGroups.clear();
        outputAudioBusGroups.clear();
        inputAudioBusGroupHostBuses.clear();
        outputAudioBusGroupHostBuses.clear();

        if (patch->isLoaded())
        {
            inputAudioBusGroups  = cmaj::audio_bus_layout::groupEndpointsByBus (patch->getInputEndpoints());
            outputAudioBusGroups = cmaj::audio_bus_layout::groupEndpointsByBus (patch->getOutputEndpoints());
        }

        rebuildAudioBusGroupHostMappings();

        inputAudioChannelCount  = static_cast<choc::buffer::ChannelCount> (cmaj::audio_bus_layout::getTotalAudioChannels (inputAudioBusGroups));
        outputAudioChannelCount = static_cast<choc::buffer::ChannelCount> (cmaj::audio_bus_layout::getTotalAudioChannels (outputAudioBusGroups));
    }

    void rebuildAudioBusGroupHostMappings()
    {
        inputAudioBusGroupHostBuses.assign  (inputAudioBusGroups.size(),  disabledHostBusIndex);
        outputAudioBusGroupHostBuses.assign (outputAudioBusGroups.size(), disabledHostBusIndex);

        if constexpr (DerivedType::isFixedPatch)
        {
            setIdentityHostBusMapping (inputAudioBusGroupHostBuses);
            setIdentityHostBusMapping (outputAudioBusGroupHostBuses);
        }
        else
        {
            rebuildDynamicLoaderHostBusMappings();
        }
    }

    static void setIdentityHostBusMapping (std::vector<int>& mappings)
    {
        for (size_t i = 0; i < mappings.size(); ++i)
            mappings[i] = static_cast<int> (i);
    }

    void rebuildDynamicLoaderHostBusMappings()
    {
        bool hasMappedMainInput = false;
        bool hasMappedAuxInput = false;
        std::vector<std::string> unmappedAuxInputBusNames;

        for (size_t i = 0; i < inputAudioBusGroups.size(); ++i)
        {
            const auto& group = inputAudioBusGroups[i];

            if (group.isAuxiliary())
            {
                if (! hasMappedAuxInput)
                {
                    inputAudioBusGroupHostBuses[i] = dynamicSidechainInputBusIndex;
                    hasMappedAuxInput = true;
                }
                else
                {
                    unmappedAuxInputBusNames.push_back (group.name);
                }

                continue;
            }

            if (! hasMappedMainInput)
            {
                inputAudioBusGroupHostBuses[i] = dynamicMainInputBusIndex;
                hasMappedMainInput = true;
            }
        }

        bool hasMappedMainOutput = false;

        for (size_t i = 0; i < outputAudioBusGroups.size(); ++i)
        {
            if (! hasMappedMainOutput && ! outputAudioBusGroups[i].isAuxiliary())
            {
                outputAudioBusGroupHostBuses[i] = dynamicMainOutputBusIndex;
                hasMappedMainOutput = true;
            }
        }

        if (! hasMappedMainOutput && ! outputAudioBusGroups.empty())
            outputAudioBusGroupHostBuses.front() = dynamicMainOutputBusIndex;

        warnAboutUnmappedDynamicAuxInputBuses (unmappedAuxInputBusNames);
    }

    static std::string joinBusNames (const std::vector<std::string>& names)
    {
        std::string result;

        for (const auto& name : names)
        {
            if (! result.empty())
                result += ", ";

            result += name.empty() ? std::string ("<unnamed>") : name;
        }

        return result;
    }

    void warnAboutUnmappedDynamicAuxInputBuses (const std::vector<std::string>& names)
    {
        auto busNames = joinBusNames (names);

        if (busNames.empty())
        {
            lastDynamicLoaderUnmappedAuxWarning.clear();
            return;
        }

        if (busNames == lastDynamicLoaderUnmappedAuxWarning)
            return;

        lastDynamicLoaderUnmappedAuxWarning = busNames;

        auto warning = "CmajPlugin warning: dynamic loader exposes one auxiliary input bus; unmapped aux input bus groups: " + busNames;

        if (handleConsoleMessage)
            handleConsoleMessage (warning.c_str());

        std::cerr << warning << std::endl;
    }

    void resizeAudioChannelPointerStorage()
    {
        if (patch->isLoaded())
        {
            inputChannelPointers.resize  (inputAudioChannelCount);
            outputChannelPointers.resize (outputAudioChannelCount);
            return;
        }

        inputChannelPointers.resize  (static_cast<size_t> (getTotalNumInputChannels()));
        outputChannelPointers.resize (static_cast<size_t> (getTotalNumOutputChannels()));
    }

    void resizeSilentBusScratch (uint32_t numFrames)
    {
        inputSilentBusScratch.setSize  ((int) inputChannelPointers.size(),  (int) numFrames, false, false, true);
        outputDisabledBusScratch.setSize ((int) outputChannelPointers.size(), (int) numFrames, false, false, true);
    }

    bool refreshAudioChannelPointers (juce::AudioBuffer<float>& audio)
    {
        if (inputChannelPointers.empty() && outputChannelPointers.empty())
            return true;

        if (inputSilentBusScratch.getNumSamples() < audio.getNumSamples()
            || outputDisabledBusScratch.getNumSamples() < audio.getNumSamples())
            return false;

        if (inputSilentBusScratch.getNumChannels() < (int) inputChannelPointers.size()
            || outputDisabledBusScratch.getNumChannels() < (int) outputChannelPointers.size())
            return false;

        inputSilentBusScratch.clear();
        outputDisabledBusScratch.clear();

        // FEATHER: walk declared bus groups rather than active JUCE channel totals. Disabled
        // auxiliary input buses are represented by cleared scratch channels, so sidechain
        // endpoints see silence instead of missing/null bus pointers.
        auto mapInputGroups = [&] (const auto& groups, const auto& hostBusMappings)
        {
            size_t inputIndex = 0;
            int scratchIndex = 0;

            for (int bus = 0; bus < (int) groups.size(); ++bus)
            {
                const auto hostBus = bus < static_cast<int> (hostBusMappings.size()) ? hostBusMappings[(size_t) bus]
                                                                                     : disabledHostBusIndex;

                auto busBuffer = hostBus >= 0 && hostBus < getBusCount (true) ? getBusBuffer (audio, true, hostBus)
                                                                              : juce::AudioBuffer<float>();

                for (uint32_t channel = 0; channel < groups[(size_t) bus].channelCount; ++channel)
                {
                    if (channel < static_cast<uint32_t> (busBuffer.getNumChannels()))
                    {
                        if (auto* data = busBuffer.getWritePointer ((int) channel))
                        {
                            inputChannelPointers[inputIndex++] = data;
                            continue;
                        }
                    }

                    // FEATHER: adaptive main groups replicate a mono host bus into every
                    // endpoint channel, matching the pre-bus-layout upstream mono input
                    // adaptation in cmaj::Patch::connectPerformerEndpoints(). Pointer
                    // replication only - no copying or allocation on the audio thread.
                    if (busBuffer.getNumChannels() == 1
                         && cmaj::audio_bus_layout::shouldAdaptChannels (groups[(size_t) bus], (size_t) bus))
                    {
                        if (auto* data = busBuffer.getWritePointer (0))
                        {
                            inputChannelPointers[inputIndex++] = data;
                            continue;
                        }
                    }

                    inputChannelPointers[inputIndex++] = inputSilentBusScratch.getWritePointer (scratchIndex++);
                }
            }

            return inputIndex == inputChannelPointers.size();
        };

        // FEATHER: disabled auxiliary output buses still need patch-declared output pointers;
        // route them to scratch so rendered samples are discarded without allocating here.
        auto mapOutputGroups = [&] (const auto& groups, const auto& hostBusMappings)
        {
            size_t outputIndex = 0;
            int scratchIndex = 0;

            for (int bus = 0; bus < (int) groups.size(); ++bus)
            {
                const auto hostBus = bus < static_cast<int> (hostBusMappings.size()) ? hostBusMappings[(size_t) bus]
                                                                                     : disabledHostBusIndex;

                auto busBuffer = hostBus >= 0 && hostBus < getBusCount (false) ? getBusBuffer (audio, false, hostBus)
                                                                               : juce::AudioBuffer<float>();

                for (uint32_t channel = 0; channel < groups[(size_t) bus].channelCount; ++channel)
                {
                    if (channel < static_cast<uint32_t> (busBuffer.getNumChannels()))
                    {
                        if (auto* data = busBuffer.getWritePointer ((int) channel))
                        {
                            outputChannelPointers[outputIndex++] = data;
                            continue;
                        }
                    }

                    outputChannelPointers[outputIndex++] = outputDisabledBusScratch.getWritePointer (scratchIndex++);
                }
            }

            return outputIndex == outputChannelPointers.size();
        };

        if (! patch->isLoaded())
        {
            if (inputChannelPointers.size()  != static_cast<size_t> (getTotalNumInputChannels())
                || outputChannelPointers.size() != static_cast<size_t> (getTotalNumOutputChannels()))
                return false;

            size_t inputIndex = 0;

            for (int bus = 0; bus < getBusCount (true); ++bus)
            {
                auto busBuffer = getBusBuffer (audio, true, bus);

                for (int channel = 0; channel < busBuffer.getNumChannels(); ++channel)
                    inputChannelPointers[inputIndex++] = busBuffer.getWritePointer (channel);
            }

            size_t outputIndex = 0;

            for (int bus = 0; bus < getBusCount (false); ++bus)
            {
                auto busBuffer = getBusBuffer (audio, false, bus);

                for (int channel = 0; channel < busBuffer.getNumChannels(); ++channel)
                    outputChannelPointers[outputIndex++] = busBuffer.getWritePointer (channel);
            }

            return inputIndex == inputChannelPointers.size()
                && outputIndex == outputChannelPointers.size();
        }

        if (! mapInputGroups (inputAudioBusGroups, inputAudioBusGroupHostBuses))
            return false;

        return mapOutputGroups (outputAudioBusGroups, outputAudioBusGroupHostBuses);
    }

    // FEATHER: post-process channel-count adaptation for main output bus groups. This
    // restores the pre-bus-layout upstream behaviour that lived in
    // cmaj::Patch::connectPerformerEndpoints() before the per-bus mapping bypassed it:
    //   - a mono endpoint group is replicated to every host bus channel,
    //   - a multi-channel group rendered to a mono host bus is folded down by unscaled
    //     summing (upstream mapped every endpoint channel onto device channel 0, where
    //     the performer overwrote the first and added the rest),
    //   - a partial fill (1 < endpoint channels < host channels) clears the extra host
    //     channels so hosts never see stale buffer garbage (upstream cleared unused
    //     device channels in its output-clear action).
    // Equal channel counts take none of these branches, so produced audio is unchanged.
    // RT-safe: reads the cached group/host mappings and pre-mapped channel pointers;
    // no locks, no heap allocation.
    void applyOutputBusChannelAdaptation (juce::AudioBuffer<float>& audio, int numFrames)
    {
        size_t flatChannelIndex = 0;

        for (size_t bus = 0; bus < outputAudioBusGroups.size(); ++bus)
        {
            const auto& group = outputAudioBusGroups[bus];
            const auto numGroupChannels = group.channelCount;
            const auto hostBus = bus < outputAudioBusGroupHostBuses.size() ? outputAudioBusGroupHostBuses[bus]
                                                                           : disabledHostBusIndex;

            if (hostBus >= 0 && hostBus < getBusCount (false)
                 && cmaj::audio_bus_layout::shouldAdaptChannels (group, bus))
            {
                auto busBuffer = getBusBuffer (audio, false, hostBus);
                const auto numHostChannels = static_cast<uint32_t> (busBuffer.getNumChannels());

                if (numGroupChannels == 1 && numHostChannels > 1)
                {
                    for (uint32_t channel = 1; channel < numHostChannels; ++channel)
                        juce::FloatVectorOperations::copy (busBuffer.getWritePointer ((int) channel),
                                                           busBuffer.getReadPointer (0), numFrames);
                }
                else if (numHostChannels == 1 && numGroupChannels > 1
                          && flatChannelIndex + numGroupChannels <= outputChannelPointers.size())
                {
                    // Extra endpoint channels were rendered into outputDisabledBusScratch
                    // by mapOutputGroups(); their pointers are still in outputChannelPointers.
                    for (uint32_t channel = 1; channel < numGroupChannels; ++channel)
                        juce::FloatVectorOperations::add (busBuffer.getWritePointer (0),
                                                          outputChannelPointers[flatChannelIndex + channel], numFrames);
                }
                else if (numGroupChannels > 1 && numHostChannels > numGroupChannels)
                {
                    for (uint32_t channel = numGroupChannels; channel < numHostChannels; ++channel)
                        busBuffer.clear ((int) channel, 0, numFrames);
                }
            }

            flatChannelIndex += numGroupChannels;
        }
    }

    void unload (const std::string& message, bool isError)
    {
        if constexpr (! DerivedType::isPrecompiled)
        {
            if (patch->isLoaded())
                patch->unload();
            else
            {
                updateCachedAudioBusLayoutFromPatch();
                resizeAudioChannelPointerStorage();
                resizeSilentBusScratch (static_cast<uint32_t> (getBlockSize()));
            }

            setStatusMessage (message, isError);
            updatePatchWebViewForCurrentPatch (false);
        }
    }

    void handlePatchChange()
    {
        if (patch->isLoaded() && getSampleRate() > 0)
            applyCurrentRateAndBlockSize();
        else
        {
            updateCachedAudioBusLayoutFromPatch();
            resizeAudioChannelPointerStorage();
            resizeSilentBusScratch (static_cast<uint32_t> (getBlockSize()));
        }

        auto changes = juce::AudioProcessorListener::ChangeDetails::getDefaultFlags();

        auto newLatency = (int) patch->getFramesLatency();
        auto parameterInfoChanged = updateParameters();
        auto restoredPendingValues = applyPendingStateParameterValues();

        changes.latencyChanged           = newLatency != getLatencySamples();
        changes.parameterInfoChanged     = parameterInfoChanged;
        changes.programChanged           = false;
        changes.nonParameterStateChanged = true;

        if (parameterInfoChanged && ! restoredPendingValues)
            notifyCurrentParameterValuesToHost();

        setLatencySamples (newLatency);

        if (deferPatchViewUpdates)
            postPatchViewUpdate();
        else
            deliverPatchViewUpdate();

        updateHostDisplay (changes);

        if (patchChangeCallback)
            patchChangeCallback (static_cast<DerivedType&> (*this));
    }

    void setStatusMessage (const std::string& newMessage, bool isError)
    {
        if (! juce::MessageManager::getInstance()->isThisTheMessageThread())
        {
            setStatusMessageAsync (newMessage, isError);
            return;
        }

        if (statusMessage != newMessage || isStatusMessageError != isError)
        {
            statusMessage = newMessage;
            isStatusMessageError = isError;

            if (deferPatchViewUpdates)
                postPatchViewUpdate();
            else
            {
                deliverStatusMessageToPatchWebView();
                notifyEditorStatusMessageChanged();
            }
        }
    }

    void setStatusMessageAsync (std::string newMessage, bool isError)
    {
        if (juce::MessageManager::getInstance()->isThisTheMessageThread())
        {
            setStatusMessage (newMessage, isError);
            return;
        }

        auto m = std::make_unique<StatusMessageMessage>();
        m->message = std::move (newMessage);
        m->isError = isError;
        postMessage (m.release());
    }

    void deliverStatusMessageToPatchWebView()
    {
        if (patchWebView != nullptr && shouldDisplayStatusMessageInPatchView())
            patchWebView->setStatusMessage (statusMessage);
    }

    bool shouldDisplayStatusMessageInPatchView()
    {
        return ! statusMessage.empty()
            && (isStatusMessageError || ! static_cast<DerivedType&> (*this).isViewVisible());
    }

    void notifyEditorStatusMessageChanged()
    {
        if (auto e = dynamic_cast<Editor*> (getActiveEditor()))
            e->statusMessageChanged();
    }

    void notifyEditorPatchChanged()
    {
        if (auto* e = dynamic_cast<Editor*> (getActiveEditor()))
            e->onPatchChanged();
    }

    // FEATHER: Lost Audio preset v1. This is intentionally wrapper-owned file
    // I/O that reuses Patch::getFullStoredState()/setFullStoredState() as the
    // only musical-state primitive.
    static constexpr int presetSchemaVersion = 1;

    choc::value::Value listPresets() const
    {
        auto presets = choc::value::createEmptyArray();

        if (! isPresetProductAvailable())
            return presets;

        auto directory = getPresetDirectory (patch->getUID());

        if (! directory.isDirectory())
            return presets;

        auto files = directory.findChildFiles (juce::File::findFiles, false, "*.lapreset");
        auto productID = patch->getUID();

        for (auto i = 0; i < files.size(); ++i)
        {
            try
            {
                auto preset = readPresetFile (files.getReference (i));

                if (validatePresetMetadata (preset, productID).empty())
                    presets.addArrayElement (createPresetSummary (files.getReference (i), preset));
            }
            catch (...) {}
        }

        return presets;
    }

    choc::value::Value savePreset (const std::string& requestedName, const choc::value::ValueView& state) const
    {
        try
        {
            if (! isPresetProductAvailable())
                return createPresetError ("Presets are available after a patch is loaded");

            auto presetName = sanitisePresetName (requestedName);

            if (presetName.isEmpty())
                return createPresetError ("Preset name is empty");

            auto directory = getPresetDirectory (patch->getUID());

            if (! directory.exists())
            {
                auto createResult = directory.createDirectory();

                if (createResult.failed())
                    return createPresetError ((juce::String ("Could not create preset directory: ") + createResult.getErrorMessage()).toStdString());
            }

            auto savedAt = createPresetTimestamp();
            auto preset = choc::json::create ("schemaVersion", presetSchemaVersion,
                                              "name", presetName.toStdString(),
                                              "productId", patch->getUID(),
                                              "pluginVersion", patch->getVersion(),
                                              "savedAt", savedAt.toStdString(),
                                              "state", state);
            auto file = getPresetFile (patch->getUID(), presetName);

            choc::file::replaceFileWithContent (file.getFullPathName().toStdString(),
                                                choc::json::toString (preset, true));

            return choc::json::create ("ok", true,
                                       "name", presetName.toStdString(),
                                       "savedAt", savedAt.toStdString());
        }
        catch (const std::exception& e)
        {
            return createPresetError (std::string ("Could not save preset: ") + e.what());
        }
        catch (...)
        {
            return createPresetError ("Could not save preset");
        }
    }

    choc::value::Value loadPreset (const std::string& requestedName) const
    {
        try
        {
            if (! isPresetProductAvailable())
                return createPresetError ("Presets are available after a patch is loaded");

            auto presetName = sanitisePresetName (requestedName);

            if (presetName.isEmpty())
                return createPresetError ("Preset name is empty");

            auto file = getPresetFile (patch->getUID(), presetName);

            if (! file.existsAsFile())
                return createPresetError ("Preset file was not found");

            auto preset = readPresetFile (file);

            if (auto error = validatePresetMetadata (preset, patch->getUID()); ! error.empty())
                return createPresetError (error);

            if (! preset["state"].isObject())
                return createPresetError ("Preset file did not contain a state object");

            return choc::json::create ("ok", true,
                                       "name", getPresetDisplayName (file, preset),
                                       "savedAt", preset["savedAt"].toString(),
                                       "state", choc::value::Value (preset["state"]));
        }
        catch (const std::exception& e)
        {
            return createPresetError (std::string ("Could not load preset: ") + e.what());
        }
        catch (...)
        {
            return createPresetError ("Could not load preset");
        }
    }

    choc::value::Value deletePreset (const std::string& requestedName) const
    {
        try
        {
            if (! isPresetProductAvailable())
                return createPresetError ("Presets are available after a patch is loaded");

            auto presetName = sanitisePresetName (requestedName);

            if (presetName.isEmpty())
                return createPresetError ("Preset name is empty");

            auto file = getPresetFile (patch->getUID(), presetName);

            if (! file.existsAsFile())
                return createPresetError ("Preset file was not found");

            if (! file.deleteFile())
                return createPresetError ("Could not delete preset file");

            return choc::json::create ("ok", true,
                                       "name", presetName.toStdString());
        }
        catch (const std::exception& e)
        {
            return createPresetError (std::string ("Could not delete preset: ") + e.what());
        }
        catch (...)
        {
            return createPresetError ("Could not delete preset");
        }
    }

    bool isPresetProductAvailable() const
    {
        return patch != nullptr && patch->isLoaded() && patch->getUID() != "cmajor";
    }

    static juce::File getPresetDirectory (const std::string& productID)
    {
       #if JUCE_WINDOWS
        if (auto* userProfile = std::getenv ("USERPROFILE"); userProfile != nullptr && userProfile[0] != 0)
            return juce::File (juce::String (userProfile))
                    .getChildFile ("Documents")
                    .getChildFile ("LostAudio")
                    .getChildFile (juce::String (productID))
                    .getChildFile ("presets");
       #endif

        return juce::File::getSpecialLocation (juce::File::userDocumentsDirectory)
                .getChildFile ("LostAudio")
                .getChildFile (juce::String (productID))
                .getChildFile ("presets");
    }

    static juce::File getPresetFile (const std::string& productID, const juce::String& presetName)
    {
        return getPresetDirectory (productID).getChildFile (presetName).withFileExtension (".lapreset");
    }

    static juce::String sanitisePresetName (const std::string& requestedName)
    {
        auto name = juce::String (requestedName).trim();

        if (name.endsWithIgnoreCase (".lapreset"))
            name = name.dropLastCharacters (9);

        return juce::File::createLegalFileName (name).trim();
    }

    static juce::String createPresetTimestamp()
    {
        const auto now = juce::Time::getCurrentTime();
        return juce::String (now.getYear())
             + "-"
             + presetPaddedNumber (now.getMonth() + 1, 2)
             + "-"
             + presetPaddedNumber (now.getDayOfMonth(), 2)
             + "T"
             + presetPaddedNumber (now.getHours(), 2)
             + ":"
             + presetPaddedNumber (now.getMinutes(), 2)
             + ":"
             + presetPaddedNumber (now.getSeconds(), 2)
             + "."
             + presetPaddedNumber (now.getMilliseconds(), 3);
    }

    static juce::String presetPaddedNumber (int value, int width)
    {
        return juce::String (value).paddedLeft ('0', width);
    }

    static choc::value::Value readPresetFile (const juce::File& file)
    {
        return choc::json::parse (choc::file::loadFileAsString (file.getFullPathName().toStdString()));
    }

    static std::string validatePresetMetadata (const choc::value::ValueView& preset, const std::string& productID)
    {
        if (! preset.isObject())
            return "Preset file is not a JSON object";

        if (preset["schemaVersion"].getWithDefault<int32_t> (0) != presetSchemaVersion)
            return "Unsupported preset schema version";

        if (preset["productId"].toString() != productID)
            return "Preset is for a different product";

        return {};
    }

    static std::string getPresetDisplayName (const juce::File& file, const choc::value::ValueView& preset)
    {
        if (auto name = preset["name"].toString(); ! name.empty())
            return name;

        return file.getFileNameWithoutExtension().toStdString();
    }

    static choc::value::Value createPresetSummary (const juce::File& file, const choc::value::ValueView& preset)
    {
        auto tags = preset["tags"].isArray() ? choc::value::Value (preset["tags"])
                                             : choc::value::createEmptyArray();

        return choc::json::create ("name", getPresetDisplayName (file, preset),
                                   "tags", tags,
                                   "savedAt", preset["savedAt"].toString());
    }

    static choc::value::Value createPresetError (std::string message)
    {
        return choc::json::create ("ok", false,
                                   "error", std::move (message));
    }

    struct PatchViewUpdateMessage  : public juce::Message
    {
    };

    struct PatchChangedMessage  : public juce::Message
    {
    };

    void deliverPatchViewUpdate()
    {
        if (getActiveEditor() == nullptr)
            updatePatchWebViewForCurrentPatch (true);

        deliverStatusMessageToPatchWebView();
        notifyEditorPatchChanged();
        notifyEditorStatusMessageChanged();
    }

    void postPatchViewUpdate()
    {
        if (patchViewUpdatePending)
            return;

        patchViewUpdatePending = true;
        postMessage (new PatchViewUpdateMessage());
    }

    void postPatchChange()
    {
        postMessage (new PatchChangedMessage());
    }

    //==============================================================================
    juce::ValueTree createEmptyState (std::filesystem::path location) const
    {
        juce::ValueTree state (ids.Cmajor);

        if constexpr (! DerivedType::isFixedPatch)
            state.setProperty (ids.location, juce::String (location.string()), nullptr);

        return state;
    }

    juce::ValueTree getUpdatedState()
    {
        auto state = createEmptyState (patch->getManifestFile());

        if (isViewResizable() && lastEditorWidth != 0 && lastEditorHeight != 0)
        {
            state.setProperty (ids.viewWidth, lastEditorWidth, nullptr);
            state.setProperty (ids.viewHeight, lastEditorHeight, nullptr);
        }

        if (const auto& values = patch->getStoredStateValues(); ! values.empty())
        {
            juce::ValueTree stateValues (ids.STATE);

            for (auto& v : values)
            {
                juce::ValueTree value (ids.VALUE);
                value.setProperty (ids.key,   juce::String (v.first.data(),  v.first.length()), nullptr);
                auto serialised = v.second.serialise();
                value.setProperty (ids.value, juce::var (serialised.data.data(), serialised.data.size()), nullptr);
                stateValues.appendChild (value, nullptr);
            }

            state.appendChild (stateValues, nullptr);
        }

        juce::ValueTree paramList (ids.PARAMS);

        for (auto& p : patch->getParameterList())
            paramList.appendChild (juce::ValueTree (ids.PARAM,
                                                    { { ids.ID, juce::String (p->properties.endpointID) },
                                                      { ids.V, p->getCurrentValue() } }),
                                   nullptr);

        state.appendChild (paramList, nullptr);
        return state;
    }

    std::unordered_map<std::string, float> getParameterValuesFromState (const juce::ValueTree& newState) const
    {
        std::unordered_map<std::string, float> values;

        if (auto params = newState.getChildWithName (ids.PARAMS); params.isValid())
            for (auto param : params)
                if (auto endpointIDProp = param.getPropertyPointer (ids.ID))
                    if (auto endpointID = endpointIDProp->toString().toStdString(); ! endpointID.empty())
                        if (auto valProp = param.getPropertyPointer (ids.V))
                            values[endpointID] = static_cast<float> (*valProp);

        return values;
    }

    void setNewStateAsync (juce::ValueTree&& newState)
    {
        auto m = std::make_unique<NewStateMessage>();
        m->newState = std::move (newState);
        postMessage (m.release());
    }

    virtual bool prepareManifest (Patch::LoadParams&, const juce::ValueTree& newState) = 0;

    void setNewState (const juce::ValueTree& newState)
    {
        if (! dllLoadedSuccessfully)
            return;

        if (newState.isValid() && ! newState.hasType (ids.Cmajor))
            return unload ("Failed to load: invalid state", true);

        clearPendingStateParameterValues();

        Patch::LoadParams loadParams;

        try
        {
            if (! prepareManifest (loadParams, newState))
                return unload();
        }
        catch (const std::runtime_error& e)
        {
            return unload (e.what(), true);
        }

        if (isViewResizable())
        {
            if (auto w = newState.getPropertyPointer (ids.viewWidth))
                if (w->isInt())
                    lastEditorWidth = *w;

            if (auto h = newState.getPropertyPointer (ids.viewHeight))
                if (h->isInt())
                    lastEditorHeight = *h;
        }
        else
        {
            lastEditorWidth = 0;
            lastEditorHeight = 0;
        }

        stashPendingStateParameterValues (loadParams, newState);

        if (auto state = newState.getChildWithName (ids.STATE); state.isValid())
        {
            for (const auto& v : state)
            {
                if (v.hasType (ids.VALUE))
                {
                    if (auto key = v.getPropertyPointer (ids.key))
                    {
                        if (auto value = v.getPropertyPointer (ids.value))
                        {
                            if (key->isString() && key->toString().isNotEmpty() && ! value->isVoid())
                                patch->setStoredStateValue (key->toString().toStdString(), convertVarToValue (*value));
                        }
                    }
                }
            }
        }

        if (getSampleRate() > 0)
            applyCurrentRateAndBlockSize();

        patch->loadPatch (loadParams, DerivedType::isPrecompiled);
    }

    void readParametersFromState (Patch::LoadParams& loadParams, const juce::ValueTree& newState) const
    {
        auto values = getParameterValuesFromState (newState);
        loadParams.parameterValues.insert (values.begin(), values.end());
    }

    void clearPendingStateParameterValues()
    {
        if constexpr (! DerivedType::isFixedPatch)
        {
            pendingStateParameterValues.clear();
            hasPendingStateParameterValues = false;
        }
    }

    void stashPendingStateParameterValues (const Patch::LoadParams& loadParams, const juce::ValueTree& newState)
    {
        if constexpr (! DerivedType::isFixedPatch)
        {
            // FEATHER: Dynamic loader state restore is asynchronous. Keep the
            // restored parameter values until the loaded patch parameters have
            // been rebound to the fixed host-facing parameter objects.
            if (newState.getChildWithName (ids.PARAMS).isValid() && ! loadParams.parameterValues.empty())
            {
                pendingStateParameterValues = loadParams.parameterValues;
                hasPendingStateParameterValues = true;
            }
        }
    }

    bool applyPendingStateParameterValues()
    {
        if constexpr (! DerivedType::isFixedPatch)
        {
            if (! hasPendingStateParameterValues || ! patch->isLoaded())
                return false;

            auto values = std::move (pendingStateParameterValues);
            clearPendingStateParameterValues();

            bool applied = false;

            for (auto& param : patch->getParameterList())
            {
                auto found = values.find (param->properties.endpointID);

                if (found != values.end())
                {
                    param->setValue (found->second, true, 0, 0);
                    applied = true;
                }
            }

            notifyCurrentParameterValuesToHost();
            return applied;
        }
        else
        {
            return false;
        }
    }

    static choc::value::Value convertVarToValue (const juce::var& v)
    {
        if (v.isVoid() || v.isUndefined())  return {};
        if (v.isString())                   return choc::value::createString (v.toString().toStdString());
        if (v.isBool())                     return choc::value::createBool (static_cast<bool> (v));
        if (v.isInt() || v.isInt64())       return choc::value::createInt64 (static_cast<juce::int64> (v));
        if (v.isDouble())                   return choc::value::createFloat64 (static_cast<double> (v));

        if (v.isArray())
        {
            auto a = choc::value::createEmptyArray();

            for (auto& i : *v.getArray())
                a.addArrayElement (convertVarToValue (i));
        }

        if (v.isObject())
        {
            auto json = juce::JSON::toString (v, juce::JSON::FormatOptions().withSpacing (juce::JSON::Spacing::none));
            return choc::json::parse (json.toStdString());
        }

        if (v.isBinaryData())
        {
            auto* block = v.getBinaryData();
            auto  inputData = choc::value::InputData { (unsigned char *) block->begin(), (unsigned char *) block->end() };
            return choc::value::Value::deserialise (inputData);
        }

        jassertfalse;
        return {};
    }

    bool isViewResizable() const
    {
        if (auto manifest = patch->getManifest())
            for (auto& v : manifest->views)
                if (! v.isResizable())
                    return false;

        return true;
    }

    struct NewStateMessage  : public juce::Message
    {
        juce::ValueTree newState;
    };

    struct StatusMessageMessage  : public juce::Message
    {
        std::string message;
        bool isError = false;
    };

    void handleMessage (const juce::Message& message) override
    {
        if (auto newStateMessage = dynamic_cast<const NewStateMessage*> (&message))
            setNewState (const_cast<NewStateMessage*> (newStateMessage)->newState);
        else if (auto statusMessageUpdate = dynamic_cast<const StatusMessageMessage*> (&message))
            setStatusMessage (statusMessageUpdate->message, statusMessageUpdate->isError);
        else if (dynamic_cast<const PatchChangedMessage*> (&message) != nullptr)
            handlePatchChange();
        else if (dynamic_cast<const PatchViewUpdateMessage*> (&message) != nullptr)
        {
            patchViewUpdatePending = false;
            deliverPatchViewUpdate();
        }
    }

    void handleOutputEvent (uint64_t, std::string_view endpointID, const choc::value::ValueView& value)
    {
        if (endpointID == cmaj::getConsoleEndpointID())
        {
            auto text = cmaj::convertConsoleMessageToString (value);

            if (handleConsoleMessage != nullptr)
                handleConsoleMessage (text.c_str());
            else
                std::cout << text << std::flush;
        }
    }

    //==============================================================================
    void updateTimelineFromPlayhead (juce::AudioPlayHead& ph)
    {
        if (patch->wantsTimecodeEvents())
        {
            if (auto pos = ph.getPosition())
            {
                uint32_t timeout = 0;

                if (auto timeSig = pos->getTimeSignature())
                    patch->sendTimeSig (timeSig->numerator, timeSig->denominator, timeout);

                if (auto bpm = pos->getBpm())
                    patch->sendBPM (static_cast<float> (*bpm), timeout);

                patch->sendTransportState (pos->getIsRecording(),
                                           pos->getIsPlaying(),
                                           pos->getIsLooping(),
                                           timeout);

                if (auto timeSamps = pos->getTimeInSamples())
                {
                    double ppq = 0, ppqBar = 0;

                    if (auto p = pos->getPpqPosition())
                        ppq = *p;

                    if (auto p = pos->getPpqPositionOfLastBarStart())
                        ppqBar = *p;

                    patch->sendPosition (static_cast<int64_t> (*timeSamps), ppq, ppqBar, timeout);
                }
            }
        }
    }

    //==============================================================================
    struct Parameter  : public juce::HostedAudioProcessorParameter
    {
        Parameter (juce::String&& pID)
            : HostedAudioProcessorParameter (1),
              paramID (std::move (pID))
        {
        }

        ~Parameter() override
        {
            detach();
        }

        bool setPatchParam (PatchParameterPtr p)
        {
            {
                const std::scoped_lock lock (patchParamLock);

                if (patchParam == p)
                    return false;

                detachWithoutLock();
                patchParam = std::move (p);

                if (patchParam == nullptr)
                    return true;

                auto* boundParam = patchParam.get();

                patchParam->valueChanged = [this, boundParam] (float v)
                {
                    sendValueChangedMessageToListeners (boundParam->properties.convertTo0to1 (v));
                };

                patchParam->gestureStart = [this] { beginChangeGesture(); };
                patchParam->gestureEnd   = [this] { endChangeGesture(); };
            }

            return true;
        }

        void detach()
        {
            const std::scoped_lock lock (patchParamLock);
            detachWithoutLock();
        }

        void detachWithoutLock()
        {
            if (patchParam != nullptr)
            {
                patchParam->valueChanged.reset();
                patchParam->gestureStart.reset();
                patchParam->gestureEnd.reset();
            }
        }

        void forceValueChanged()
        {
            if (auto p = getPatchParam())
                p->valueChanged (p->getCurrentValue());
            else
                sendValueChangedMessageToListeners (0.0f);
        }

        juce::String getParameterID() const override                { return paramID; }
        juce::String getName (int maxLength) const override         { if (auto p = getPatchParam()) return p->properties.name.substr (0, (size_t) maxLength); return "unknown"; }
        juce::String getLabel() const override                      { if (auto p = getPatchParam()) return p->properties.unit; return {}; }
        Category getCategory() const override                       { return Category::genericParameter; }
        bool isDiscrete() const override                            { if (auto p = getPatchParam()) return p->properties.discrete; return false; }
        bool isBoolean() const override                             { if (auto p = getPatchParam()) return p->properties.boolean; return false; }
        bool isAutomatable() const override                         { if (auto p = getPatchParam()) return p->properties.automatable; return true; }
        bool isMetaParameter() const override                       { if (auto p = getPatchParam()) return p->properties.hidden; return false; }

        juce::StringArray getAllValueStrings() const override
        {
            juce::StringArray result;

            if (auto p = getPatchParam())
                for (auto& s : p->properties.valueStrings)
                    result.add (s);

            return result;
        }

        float getDefaultValue() const override       { if (auto p = getPatchParam()) return p->properties.convertTo0to1 (p->properties.defaultValue); return 0.0f; }
        float getValue() const override              { if (auto p = getPatchParam()) return p->properties.convertTo0to1 (p->getCurrentValue()); return 0.0f; }
        void setValue (float newValue) override      { if (auto p = getPatchParam()) p->setValue (p->properties.convertFrom0to1 (newValue), false, -1, 0); }

        juce::String getText (float v, int length) const override
        {
            auto p = getPatchParam();

            if (p == nullptr)
                return "0";

            juce::String result = p->properties.getValueAsString (p->properties.convertFrom0to1 (v));
            return length > 0 ? result.substring (0, length) : result;
        }

        float getValueForText (const juce::String& text) const override
        {
            if (auto p = getPatchParam())
            {
                if (auto value = p->properties.getStringAsValue (text.toStdString()))
                    return *value;

                return p->properties.defaultValue;
            }

            return 0;
        }

        int getNumSteps() const override
        {
            if (auto p = getPatchParam())
                if (auto steps = p->properties.getNumDiscreteOptions())
                    return static_cast<int> (steps);

            return AudioProcessor::getDefaultNumParameterSteps();
        }

        PatchParameterPtr getPatchParam() const
        {
            const std::scoped_lock lock (patchParamLock);
            return patchParam;
        }

        PatchParameterPtr patchParam;
        mutable std::mutex patchParamLock;
        const juce::String paramID;
    };

    void createParameterTree()
    {
        // for a precompiled plugin, we can build a complete group structure
        if constexpr (DerivedType::isPrecompiled || DerivedType::isFixedPatch)
        {
            struct ParameterTreeBuilder
            {
                Parameter* add (const PatchParameterPtr& param)
                {
                    auto newParam = std::make_unique<Parameter> (param->properties.endpointID);
                    auto rawParam = newParam.get();

                    if (! param->properties.group.empty())
                        getOrCreateGroup (tree, {}, param->properties.group).addChild (std::move (newParam));
                    else
                        tree.addChild (std::move (newParam));

                    return rawParam;
                }

                juce::AudioProcessorParameterGroup& getOrCreateGroup (juce::AudioProcessorParameterGroup& targetTree,
                                                                      const std::string& parentPath,
                                                                      const std::string& subPath)
                {
                    auto fullPath = parentPath + "/" + subPath;
                    auto& targetGroup = groups[fullPath];

                    if (targetGroup != nullptr)
                        return *targetGroup;

                    if (auto slash = subPath.find ('/'); slash != std::string::npos)
                    {
                        auto firstPathPart = subPath.substr (0, slash);
                        auto& parentGroup = getOrCreateGroup (targetTree, parentPath, firstPathPart);
                        return getOrCreateGroup (parentGroup, parentPath + "/" + firstPathPart, subPath.substr (slash + 1));
                    }

                    auto newGroup = std::make_unique<juce::AudioProcessorParameterGroup> (fullPath, subPath, "/");
                    targetGroup = newGroup.get();
                    targetTree.addChild (std::move (newGroup));
                    return *targetGroup;
                }

                std::map<std::string, juce::AudioProcessorParameterGroup*> groups;
                juce::AudioProcessorParameterGroup tree;
            };

            ParameterTreeBuilder builder;

            for (auto& p : patch->getParameterList())
            {
                auto param = builder.add (p);
                parameters.push_back (param);
                param->setPatchParam (p);
            }

            for (auto p : parameters)
                p->forceValueChanged();

            setHostedParameterTree (std::move (builder.tree));
        }
    }

    bool updateParameters()
    {
        bool changed = false;
        auto params = patch->getParameterList();

        if constexpr (DerivedType::isPrecompiled || DerivedType::isFixedPatch)
        {
            if (parameters.empty())
                createParameterTree();
        }
        else
        {
            ensureNumParameters (params.size());
        }

        for (size_t i = 0; i < params.size(); ++i)
            changed = parameters[i]->setPatchParam (params[i]) || changed;

        if constexpr (! DerivedType::isFixedPatch)
            for (size_t i = params.size(); i < parameters.size(); ++i)
                changed = parameters[i]->setPatchParam ({}) || changed;

        return changed;
    }

    void notifyCurrentParameterValuesToHost()
    {
        // FEATHER: Dynamic-loader parameters are fixed host-facing wrappers that
        // are rebound after the patch has compiled. Tell the host their current
        // values after every rebind so a pre-load normalized 0.0 cache cannot
        // overwrite restored or init defaults.
        for (auto* p : parameters)
            p->forceValueChanged();
    }

    void ensureNumParameters (size_t num)
    {
        while (parameters.size() < num)
        {
            auto p = std::make_unique<Parameter> ("P" + juce::String (parameters.size()));
            parameters.push_back (p.get());
            addHostedParameter (std::move (p));
        }
    }

    std::vector<Parameter*> parameters;
    std::unordered_map<std::string, float> pendingStateParameterValues;
    bool hasPendingStateParameterValues = false;

    static constexpr int defaultEditorWidth = 500, defaultEditorHeight = 400;

    cmaj::PatchManifest::View derivePatchViewSize() const
    {
        auto view = cmaj::PatchManifest::View
        {
            choc::json::create ("width", lastEditorWidth,
                                "height", lastEditorHeight)
        };

        if (auto manifest = patch->getManifest())
            if (auto v = manifest->findDefaultView())
                if (lastEditorWidth == 0 && lastEditorHeight == 0)
                    view = *v;

        if (view.getWidth()  == 0)  view.view.setMember ("width", defaultEditorWidth);
        if (view.getHeight() == 0)  view.view.setMember ("height", defaultEditorHeight);

        return view;
    }

    bool shouldUsePersistentPatchWebView() const
    {
        return patch->isLoaded() && cmaj::plugin::shouldUsePersistentView (*patch);
    }

    cmaj::PatchWebView& getOrCreatePatchWebView()
    {
        CMAJ_ASSERT (shouldUsePersistentPatchWebView());

        const auto nextIdentity = cmaj::plugin::getPersistentViewIdentity (*patch);

        if (patchWebView != nullptr && patchWebViewIdentity != nextIdentity)
            destroyPatchWebView();

        if (patchWebView == nullptr)
        {
            // FEATHER: Processor-owned WebView. This is reused while the same
            // patch rebuilds, and recreated only when the manifest/view identity changes.
            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE getOrCreatePatchWebView create identity=" + nextIdentity);
            patchWebView = std::make_unique<cmaj::PatchWebView> (*patch, derivePatchViewSize());
            patchWebViewIdentity = nextIdentity;
            patchWebViewSoftRecoveryAttempted = false;
            patchWebViewHardRecoveryAttempted = false;

            patchWebViewSpacebarPassthroughInstalled = cmaj::plugin::installSpacebarPassthrough (patchWebView->getWebView(),
                [this]
                {
                    return patchWebView != nullptr && ! patchWebView->isTextInputFocused();
                });
        }

        return *patchWebView;
    }

    void updatePatchWebViewForCurrentPatch (bool forceReload)
    {
        CMAJ_FEATHER_WEBVIEW_LOG ("JUCE updatePatchWebViewForCurrentPatch forceReload="
                                  + std::string (forceReload ? "true" : "false")
                                  + " playable=" + std::string (static_cast<DerivedType&> (*this).isViewVisible() ? "true" : "false"));

        if (! shouldUsePersistentPatchWebView())
        {
            destroyPatchWebView();
            return;
        }

        if (patchWebView != nullptr && patchWebViewIdentity != cmaj::plugin::getPersistentViewIdentity (*patch))
            destroyPatchWebView();

        if (patchWebView == nullptr)
            return;

        if (static_cast<DerivedType&> (*this).isViewVisible())
        {
            patchWebView->setActive (true);
            patchWebView->update (derivePatchViewSize());

            if (forceReload)
                patchWebView->reload();
            else
                patchWebView->requestViewRebuildIfNeeded();
        }
        else
        {
            patchWebView->setActive (false);

            if (shouldDisplayStatusMessageInPatchView())
                patchWebView->setStatusMessage (statusMessage);
        }

       #if FEATHER_WEBVIEW_DEBUG
        patchWebView->debugProbeDocumentState ("juce-update-force-" + std::string (forceReload ? "true" : "false"));
       #endif
    }

    enum class PatchWebViewAttachState
    {
        detached,
        attaching,
        attached,
        recovering
    };

    struct PatchWebViewAttachProbe
    {
        std::atomic<uint32_t> generation { 0 };
        std::atomic<bool> pingOK { false };
        std::atomic<bool> pingInFlight { false };
    };

    void clearPatchWebViewAttachHealthState()
    {
        patchWebViewAttachProbe->pingOK.store (false);
        patchWebViewAttachProbe->pingInFlight.store (false);
        patchWebViewAttachHealthStartMs = 0;
    }

    bool sendPatchWebViewAttachHealthPing()
    {
        if (patchWebView == nullptr)
            return false;

        if (! patchWebView->getWebView().isReady())
        {
            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE attach health waiting for webview ready");
            return false;
        }

        bool expected = false;

        if (! patchWebViewAttachProbe->pingInFlight.compare_exchange_strong (expected, true))
            return true;

        const auto generation = patchWebViewAttachProbe->generation.fetch_add (1) + 1;
        auto probe = patchWebViewAttachProbe;

        const auto accepted = patchWebView->getWebView().evaluateJavascript ("1",
            [probe, generation] (const std::string& error, const choc::value::ValueView&)
            {
                probe->pingInFlight.store (false);

                if (error.empty() && probe->generation.load() == generation)
                    probe->pingOK.store (true);
            });

        if (! accepted)
            patchWebViewAttachProbe->pingInFlight.store (false);

        return accepted;
    }

    void startPatchWebViewAttachHealthProbe (bool recoveryAttempt)
    {
        if (patchWebView == nullptr)
            return;

        CMAJ_FEATHER_WEBVIEW_LOG ("JUCE startAttachHealthProbe recovery="
                                  + std::string (recoveryAttempt ? "true" : "false"));

        installPersistentPatchWebViewSpacebarPassthrough();

        patchWebViewAttachProbe->pingOK.store (false);
        patchWebViewAttachProbe->pingInFlight.store (false);
        patchWebViewAttachHealthStartMs = juce::Time::getMillisecondCounter();
        patchWebViewAttachState = recoveryAttempt ? PatchWebViewAttachState::recovering
                                                  : PatchWebViewAttachState::attaching;

        sendPatchWebViewAttachHealthPing();

       #if FEATHER_WEBVIEW_DEBUG
        patchWebView->debugProbeDocumentState ("juce-attach-probe");
       #endif
    }

    void markPatchWebViewNativeAttached (bool recoveryAttempt)
    {
        startPatchWebViewAttachHealthProbe (recoveryAttempt);
    }

    void detachPatchWebViewFromEditor()
    {
        CMAJ_FEATHER_WEBVIEW_LOG ("JUCE detachPatchWebViewFromEditor");

        clearPatchWebViewAttachHealthState();
        patchWebViewAttachState = PatchWebViewAttachState::detached;

      #if JUCE_WINDOWS
        untrackPatchWebViewEditorNativeWindow();
      #endif

        if (patchWebView != nullptr)
            cmaj::plugin::parkChildView (patchWebViewParkingWindow, patchWebView->getWebView().getViewHandle());
    }

    void destroyPatchWebView()
    {
        CMAJ_FEATHER_WEBVIEW_LOG ("JUCE destroyPatchWebView");

        detachPatchWebViewFromEditor();

        if (patchWebView != nullptr)
        {
            cmaj::plugin::uninstallSpacebarPassthrough (patchWebView->getWebView());
            patchWebView.reset();
        }

        patchWebViewIdentity.clear();
        patchWebViewSpacebarPassthroughInstalled = false;
    }

    void installPersistentPatchWebViewSpacebarPassthrough()
    {
        if (patchWebView == nullptr || patchWebViewSpacebarPassthroughInstalled)
            return;

        patchWebViewSpacebarPassthroughInstalled = cmaj::plugin::installSpacebarPassthrough (patchWebView->getWebView(),
            [this]
            {
                return patchWebView != nullptr && ! patchWebView->isTextInputFocused();
            });
    }

  #if JUCE_WINDOWS
    void trackPatchWebViewEditorNativeWindow (HWND hwnd)
    {
        if (trackedPatchWebViewEditorWindow == hwnd)
            return;

        untrackPatchWebViewEditorNativeWindow();
        trackedPatchWebViewEditorWindow = hwnd;
        trackedPatchWebViewEditorWindowDestroyHookRegistration = cmaj::plugin::createNativeWindowDestroyHookLifetimeToken();

        cmaj::plugin::watchNativeWindowDestroy (this, hwnd, nativeWindowDestroyHookLifetime,
            trackedPatchWebViewEditorWindowDestroyHookRegistration,
            [this]
            {
                // FEATHER: Last-chance native detach before JUCE/host destroys
                // the editor HWND and takes the WebView2 child down with it.
                detachPatchWebViewFromEditor();
            });
    }

    void untrackPatchWebViewEditorNativeWindow()
    {
        auto registration = trackedPatchWebViewEditorWindowDestroyHookRegistration;

        if (trackedPatchWebViewEditorWindow != nullptr)
            cmaj::plugin::unwatchNativeWindowDestroy (this, trackedPatchWebViewEditorWindow);

        cmaj::plugin::cancelNativeWindowDestroyHookCallbacks (registration);
        trackedPatchWebViewEditorWindowDestroyHookRegistration.reset();
        trackedPatchWebViewEditorWindow = nullptr;
    }
  #endif

    cmaj::plugin::WebViewParkingWindow patchWebViewParkingWindow;
    std::unique_ptr<cmaj::PatchWebView> patchWebView;
    std::string patchWebViewIdentity;
    std::shared_ptr<PatchWebViewAttachProbe> patchWebViewAttachProbe = std::make_shared<PatchWebViewAttachProbe>();
    PatchWebViewAttachState patchWebViewAttachState = PatchWebViewAttachState::detached;
    uint32_t patchWebViewAttachHealthStartMs = 0;
    bool patchWebViewSoftRecoveryAttempted = false;
    bool patchWebViewHardRecoveryAttempted = false;
    bool patchWebViewSpacebarPassthroughInstalled = false;
    static constexpr uint32_t patchWebViewAttachHealthTimeoutMs = 3000;

  #if JUCE_WINDOWS
    std::shared_ptr<cmaj::plugin::NativeWindowDestroyHookLifetimeToken> nativeWindowDestroyHookLifetime = cmaj::plugin::createNativeWindowDestroyHookLifetimeToken();
    std::shared_ptr<cmaj::plugin::NativeWindowDestroyHookLifetimeToken> trackedPatchWebViewEditorWindowDestroyHookRegistration;
    HWND trackedPatchWebViewEditorWindow = nullptr;
  #endif

    struct PersistentWebViewHolderBase  : public juce::Component
    {
        virtual void refreshNativeAttachment (bool recoveryAttempt) = 0;
        virtual void detachNativeView() = 0;
        virtual bool isNativeViewAttached() const = 0;
    };

    static std::unique_ptr<PersistentWebViewHolderBase> createPersistentWebViewHolder (DerivedType& owner, choc::ui::WebView& webView)
    {
      #if JUCE_WINDOWS || JUCE_MAC || defined (__APPLE__)
        struct Holder  : public PersistentWebViewHolderBase
        {
            Holder (DerivedType& p, choc::ui::WebView& v)
                : owner (p),
                  nativeView (v.getViewHandle()),
                  movementWatcher (*this)
            {
            }

            ~Holder() override
            {
                detachNativeView();
            }

            void paint (juce::Graphics&) override {}

            void refreshNativeAttachment (bool recoveryAttempt) override
            {
                updateNativeParent (recoveryAttempt);
                updateNativeBounds();
            }

            void detachNativeView() override
            {
                if (nativeView == nullptr || currentPeerWindow == nullptr)
                    return;

              #if JUCE_WINDOWS
                owner.untrackPatchWebViewEditorNativeWindow();
              #endif

                currentPeerWindow = nullptr;
                owner.detachPatchWebViewFromEditor();
            }

            bool isNativeViewAttached() const override
            {
              #if JUCE_WINDOWS
                return cmaj::plugin::isNativeChildViewAttachedToParentChain (currentPeerWindow, nativeView);
              #else
                return nativeView != nullptr && currentPeerWindow != nullptr;
              #endif
            }

        private:
            struct MovementWatcher  : public juce::ComponentMovementWatcher
            {
                MovementWatcher (Holder& h) : juce::ComponentMovementWatcher (&h), holder (h) {}

                void componentMovedOrResized (bool, bool) override  { holder.updateNativeBounds(); }
                void componentPeerChanged() override                { holder.refreshNativeAttachment (false); }
                void componentVisibilityChanged() override          { holder.refreshNativeAttachment (false); }

                Holder& holder;
            };

            void updateNativeParent (bool recoveryAttempt)
            {
                if (nativeView == nullptr)
                    return;

                auto* peer = isShowing() ? getTopLevelComponent()->getPeer() : nullptr;
                auto* peerWindow = peer != nullptr ? peer->getNativeHandle() : nullptr;

                if (currentPeerWindow == peerWindow
                      && (peerWindow == nullptr || isNativeViewAttached()))
                {
                    return;
                }

                detachNativeView();
                currentPeerWindow = peerWindow;

                if (currentPeerWindow == nullptr)
                    return;

              #if JUCE_WINDOWS
                auto hwnd = static_cast<HWND> (nativeView);
                auto windowFlags = GetWindowLongPtr (hwnd, GWL_STYLE);
                using FlagType = decltype (windowFlags);

                windowFlags &= ~static_cast<FlagType> (WS_POPUP);
                windowFlags |= static_cast<FlagType> (WS_CHILD);
                SetWindowLongPtr (hwnd, GWL_STYLE, windowFlags);

                if (! cmaj::plugin::addChildView (currentPeerWindow, nativeView))
                {
                    currentPeerWindow = nullptr;
                    return;
                }

                owner.trackPatchWebViewEditorNativeWindow (static_cast<HWND> (currentPeerWindow));
              #else
                // FEATHER: TODO(mac-validate) verify this direct NSView reparent
                // against JUCE's NSViewComponent behavior in AU and VST3 hosts.
                if (! cmaj::plugin::addChildView (currentPeerWindow, nativeView))
                {
                    currentPeerWindow = nullptr;
                    return;
                }
              #endif

                owner.markPatchWebViewNativeAttached (recoveryAttempt);
            }

            void updateNativeBounds()
            {
                if (nativeView == nullptr || currentPeerWindow == nullptr)
                    return;

                if (auto* peer = getTopLevelComponent()->getPeer())
                {
                    auto area = peer->getAreaCoveredBy (*this);

                  #if JUCE_WINDOWS
                    area = (area.toFloat() * peer->getPlatformScaleFactor()).getSmallestIntegerContainer();
                  #else
                    // FEATHER: TODO(mac-validate) confirm AppKit point coordinates
                    // match JUCE's getAreaCoveredBy() output for plugin editor peers.
                  #endif

                    cmaj::plugin::setViewFrame (nativeView, area.getX(), area.getY(),
                                                static_cast<uint32_t> (std::max (1, area.getWidth())),
                                                static_cast<uint32_t> (std::max (1, area.getHeight())));

                  #if JUCE_WINDOWS
                    InvalidateRect (static_cast<HWND> (nativeView), nullptr, TRUE);
                  #endif
                }
            }

            DerivedType& owner;
            void* nativeView = nullptr;
            void* currentPeerWindow = nullptr;
            MovementWatcher movementWatcher;

            JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Holder)
        };

        return std::make_unique<Holder> (owner, webView);
      #else
        struct Holder  : public PersistentWebViewHolderBase
        {
            Holder (DerivedType& p, choc::ui::WebView& v)
                : owner (p),
                  child (choc::ui::createJUCEWebViewHolder (v))
            {
                if (child != nullptr)
                    addAndMakeVisible (*child);
            }

            ~Holder() override { detachNativeView(); }

            void resized() override
            {
                if (child != nullptr)
                    child->setBounds (getLocalBounds());
            }

            void refreshNativeAttachment (bool recoveryAttempt) override
            {
                owner.markPatchWebViewNativeAttached (recoveryAttempt);
            }

            void detachNativeView() override
            {
                child.reset();
                owner.detachPatchWebViewFromEditor();
            }

            bool isNativeViewAttached() const override
            {
                return child != nullptr && child->isShowing();
            }

            DerivedType& owner;
            std::unique_ptr<juce::Component> child;
        };

        return std::make_unique<Holder> (owner, webView);
      #endif
    }

    //==============================================================================
    //==============================================================================
    struct Editor  : public juce::AudioProcessorEditor,
                     private juce::Timer
    {
        Editor (DerivedType& p)
            : juce::AudioProcessorEditor (p), owner (p)
        {
            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE Editor ctor");

            setResizeLimits (250, 160, 32768, 32768);

            lookAndFeel.setColour (juce::TextEditor::outlineColourId, juce::Colours::transparentBlack);
            lookAndFeel.setColour (juce::TextEditor::backgroundColourId, juce::Colours::transparentBlack);

            if (auto manifest = owner.patch->getManifest())
                if (auto v = manifest->findDefaultView())
                    if (auto colour = choc::text::trim (v->view["background"].toString()); ! colour.empty())
                        lookAndFeel.setColour (juce::ResizableWindow::backgroundColourId, juce::Colour::fromString (colour));

            setLookAndFeel (&lookAndFeel);

            bindPatchWebViewHolder (false);

            extraComp = owner.createExtraComponent();

            onPatchChanged (false);

            if (extraComp)
                addAndMakeVisible (*extraComp);

            statusMessageChanged();

            juce::Font::setDefaultMinimumHorizontalScaleFactor (1.0f);
        }

        ~Editor() override
        {
            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE Editor dtor");

            stopTimer();
            owner.editorBeingDeleted (this);
            setLookAndFeel (nullptr);
            detachAndResetPatchWebViewHolder();
            destroyLocalPatchWebView();
        }

        void bindPatchWebViewHolder (bool forceNewLocalView)
        {
            const auto usePersistent = owner.shouldUsePersistentPatchWebView();
            const auto persistentIdentityChanged = usePersistent
                                                && owner.patchWebView != nullptr
                                                && owner.patchWebViewIdentity != cmaj::plugin::getPersistentViewIdentity (*owner.patch);

            if (patchWebViewHolder != nullptr
                  && usingPersistentView == usePersistent
                  && ! persistentIdentityChanged
                  && !(forceNewLocalView && ! usePersistent))
            {
                return;
            }

            detachAndResetPatchWebViewHolder();

            usingPersistentView = usePersistent;

            if (usingPersistentView)
            {
                destroyLocalPatchWebView();
                auto& view = owner.getOrCreatePatchWebView();
                patchWebViewHolder = createPersistentWebViewHolder (owner, view.getWebView());
                configurePatchWebViewHolder (view);
                startTimerHz (30);
            }
            else
            {
                // FEATHER: "persistentView": false restores upstream semantics:
                // the editor owns the PatchWebView and closing the editor destroys it.
                destroyLocalPatchWebView();
                localPatchWebView = std::make_unique<cmaj::PatchWebView> (*owner.patch, owner.derivePatchViewSize());
                installSpacebarPassthrough (*localPatchWebView);
                patchWebViewHolder = choc::ui::createJUCEWebViewHolder (localPatchWebView->getWebView());
                configurePatchWebViewHolder (*localPatchWebView);
                owner.destroyPatchWebView();
                startTimerHz (30);
            }
        }

        void configurePatchWebViewHolder (cmaj::PatchWebView& view)
        {
            if (patchWebViewHolder == nullptr)
                return;

            patchWebViewHolder->setSize ((int) view.width, (int) view.height);
            patchWebViewHolder->setWantsKeyboardFocus (false);
            patchWebViewHolder->setMouseClickGrabsKeyboardFocus (false);
        }

        void installSpacebarPassthrough (cmaj::PatchWebView& view)
        {
            if (localPatchWebViewSpacebarPassthroughInstalled)
                return;

            localPatchWebViewSpacebarPassthroughInstalled = cmaj::plugin::installSpacebarPassthrough (view.getWebView(),
                [this, &view]
                {
                    return localPatchWebView.get() == std::addressof (view) && ! view.isTextInputFocused();
                });
        }

        void destroyLocalPatchWebView()
        {
            if (localPatchWebView != nullptr)
            {
                cmaj::plugin::uninstallSpacebarPassthrough (localPatchWebView->getWebView());
                localPatchWebView.reset();
            }

            localPatchWebViewSpacebarPassthroughInstalled = false;
        }

        void detachAndResetPatchWebViewHolder()
        {
            if (auto* persistentHolder = getPersistentHolder())
                persistentHolder->detachNativeView();
            else if (usingPersistentView)
                owner.detachPatchWebViewFromEditor();

            removeChildComponent (patchWebViewHolder.get());
            patchWebViewHolder.reset();
        }

        void statusMessageChanged()
        {
            owner.refreshExtraComp (extraComp.get());

            if (owner.shouldDisplayStatusMessageInPatchView())
                if (auto* view = getCurrentPatchWebView())
                    view->setStatusMessage (owner.statusMessage);
        }

        void onPatchChanged (bool forceReload = true)
        {
            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE Editor onPatchChanged forceReload="
                                      + std::string (forceReload ? "true" : "false"));

            bindPatchWebViewHolder (forceReload && ! owner.shouldUsePersistentPatchWebView());

            if (patchWebViewHolder == nullptr)
                return;

            if (owner.isViewVisible())
            {
                auto& view = getOrCreateCurrentPatchWebView (forceReload);
                view.setActive (true);
                view.update (owner.derivePatchViewSize());
                patchWebViewHolder->setSize ((int) view.width, (int) view.height);

                setResizable (view.resizable, false);

                addAndMakeVisible (*patchWebViewHolder);
                childBoundsChanged (nullptr);
            }
            else
            {
                patchWebViewHolder->setVisible (false);
                removeChildComponent (patchWebViewHolder.get());

                if (usingPersistentView)
                    owner.detachPatchWebViewFromEditor();
                else if (localPatchWebView != nullptr)
                    localPatchWebView->setActive (false);

                setSize (defaultEditorWidth, defaultEditorHeight);
                setResizable (true, false);
            }

            if (usingPersistentView)
                owner.updatePatchWebViewForCurrentPatch (forceReload);
            else if (forceReload && localPatchWebView != nullptr)
                localPatchWebView->reload();
        }

        cmaj::PatchWebView& getOrCreateCurrentPatchWebView (bool forceReload)
        {
            if (usingPersistentView)
                return owner.getOrCreatePatchWebView();

            (void) forceReload;

            if (localPatchWebView == nullptr)
            {
                bindPatchWebViewHolder (true);
                CMAJ_ASSERT (localPatchWebView != nullptr);
            }

            return *localPatchWebView;
        }

        cmaj::PatchWebView* getCurrentPatchWebView() const
        {
            return usingPersistentView ? owner.patchWebView.get() : localPatchWebView.get();
        }

        PersistentWebViewHolderBase* getPersistentHolder() const
        {
            return dynamic_cast<PersistentWebViewHolderBase*> (patchWebViewHolder.get());
        }

        void recreatePersistentPatchWebViewAfterHardRecovery()
        {
            if (! usingPersistentView)
                return;

            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE Editor hardRecovery recreate persistent PatchWebView");

            detachAndResetPatchWebViewHolder();
            owner.destroyPatchWebView();

            auto& view = owner.getOrCreatePatchWebView();
            patchWebViewHolder = createPersistentWebViewHolder (owner, view.getWebView());
            configurePatchWebViewHolder (view);

            if (owner.isViewVisible())
                addAndMakeVisible (*patchWebViewHolder);

            resized();

            if (auto* persistentHolder = getPersistentHolder())
                persistentHolder->refreshNativeAttachment (true);
        }

        void timerCallback() override
        {
            if (usingPersistentView)
                owner.tickPatchWebViewAttachHealth (*this);
            else if (localPatchWebView != nullptr)
                installSpacebarPassthrough (*localPatchWebView);
        }

        void childBoundsChanged (Component*) override
        {
            if (! isResizing && patchWebViewHolder != nullptr && patchWebViewHolder->isVisible())
                setSize (std::max (50, patchWebViewHolder->getWidth()),
                         std::max (50, patchWebViewHolder->getHeight() + DerivedType::extraCompHeight));
        }

        void resized() override
        {
            isResizing = true;
            juce::AudioProcessorEditor::resized();

            auto r = getLocalBounds();

            if (patchWebViewHolder != nullptr && patchWebViewHolder->isVisible())
            {
                patchWebViewHolder->setBounds (r.removeFromTop (getHeight() - DerivedType::extraCompHeight));
                r.removeFromTop (4);

                if (getWidth() > 0 && getHeight() > 0)
                {
                    owner.lastEditorWidth = patchWebViewHolder->getWidth();
                    owner.lastEditorHeight = patchWebViewHolder->getHeight();
                }

                if (auto* persistentHolder = getPersistentHolder())
                    persistentHolder->refreshNativeAttachment (false);
            }

            if (extraComp)
                extraComp->setBounds (r);

            isResizing = false;
        }

        void paint (juce::Graphics& g) override
        {
            g.fillAll (getLookAndFeel().findColour (juce::ResizableWindow::backgroundColourId));
        }

        //==============================================================================
        DerivedType& owner;

        std::unique_ptr<juce::Component> patchWebViewHolder, extraComp;
        std::unique_ptr<cmaj::PatchWebView> localPatchWebView;

        juce::LookAndFeel_V4 lookAndFeel;
        bool isResizing = false;
        bool usingPersistentView = true;
        bool localPatchWebViewSpacebarPassthroughInstalled = false;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Editor)
    };

    void tickPatchWebViewAttachHealth (Editor& editor)
    {
        if (! shouldUsePersistentPatchWebView() || patchWebView == nullptr)
            return;

        auto* holder = editor.getPersistentHolder();

        if (holder == nullptr)
            return;

        // FEATHER: Reapply native parent/bounds regularly. This is intentionally
        // cheap, and covers peer creation races plus DPI changes after reparenting.
        holder->refreshNativeAttachment (false);

        if (patchWebViewAttachState == PatchWebViewAttachState::detached)
            return;

        if (patchWebViewAttachState == PatchWebViewAttachState::attached)
        {
            if (! holder->isNativeViewAttached())
                startPatchWebViewAttachHealthProbe (true);

            return;
        }

        if (! patchWebView->getWebView().isReady())
        {
            // FEATHER: WebView2 may take several seconds to finish creating its
            // CoreWebView. Hard recovery before that point just destroys the
            // in-flight browser and can prevent the document from ever loading.
            patchWebViewAttachHealthStartMs = juce::Time::getMillisecondCounter();
            return;
        }

        sendPatchWebViewAttachHealthPing();

        if (patchWebViewAttachProbe->pingOK.load() && holder->isNativeViewAttached())
        {
            patchWebViewAttachState = PatchWebViewAttachState::attached;
            patchWebViewSoftRecoveryAttempted = false;
            patchWebViewHardRecoveryAttempted = false;
            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE attach state attached");

           #if FEATHER_WEBVIEW_DEBUG
            patchWebView->debugProbeDocumentState ("juce-attached");
           #endif
            return;
        }

        if (patchWebViewAttachHealthStartMs == 0)
            return;

        const auto elapsedMs = juce::Time::getMillisecondCounter() - patchWebViewAttachHealthStartMs;

        if (elapsedMs < patchWebViewAttachHealthTimeoutMs)
            return;

        if (! patchWebViewSoftRecoveryAttempted)
        {
            patchWebViewSoftRecoveryAttempted = true;
            patchWebViewAttachState = PatchWebViewAttachState::recovering;
            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE attach soft recovery");
            holder->detachNativeView();
            holder->refreshNativeAttachment (true);
            return;
        }

        if (! patchWebViewHardRecoveryAttempted)
        {
            patchWebViewHardRecoveryAttempted = true;
            patchWebViewAttachState = PatchWebViewAttachState::recovering;
            CMAJ_FEATHER_WEBVIEW_LOG ("JUCE attach hard recovery");
            editor.recreatePersistentPatchWebViewAfterHardRecovery();
            return;
        }

        startPatchWebViewAttachHealthProbe (true);
    }

    int lastEditorWidth = 0, lastEditorHeight = 0;

    //==============================================================================
    struct IDs
    {
        const juce::Identifier Cmajor     { "Cmajor" },
                               PARAMS     { "PARAMS" },
                               PARAM      { "PARAM" },
                               ID         { "ID" },
                               V          { "V" },
                               STATE      { "STATE" },
                               VALUE      { "VALUE" },
                               location   { "location" },
                               key        { "key" },
                               value      { "value" },
                               viewWidth  { "viewWidth" },
                               viewHeight { "viewHeight" };
    } ids;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (JUCEPluginBase)
};


//==============================================================================
/// This class is a juce::AudioPluginInstance which runs a JIT-compiled engine.
class JITLoaderPlugin  : public JUCEPluginBase<JITLoaderPlugin>
{
public:
    JITLoaderPlugin (std::shared_ptr<Patch> patchToUse)
        : JUCEPluginBase<JITLoaderPlugin> (patchToUse, getBusLayout())
    {
        // for a JIT plugin, we can't recreate parameter objects without hosts crashing, so
        // will just create a big flat list and re-use its parameter objects when things change
        ensureNumParameters (100);
    }

    static constexpr bool isPrecompiled = false;
    static constexpr bool isFixedPatch = false;

    void loadPatch (const std::filesystem::path& fileToLoad)
    {
        setNewStateAsync (createEmptyState (fileToLoad));
    }

    void loadPatch (const PatchManifest& manifest)
    {
        if (dllLoadedSuccessfully)
        {
            Patch::LoadParams loadParams;
            loadParams.manifest = manifest;
            patch->loadPatch (loadParams, false);
        }
    }

    bool prepareManifest (Patch::LoadParams& loadParams, const juce::ValueTree& newState) override
    {
        if (! newState.isValid())
            return false;

        auto location = newState.getProperty (ids.location).toString().toStdString();

        if (location.empty())
            return false;

        loadParams.manifest.initialiseWithFile (location);

        // FEATHER: A host state blob can restore a different patch into an
        // already-live dynamic loader, so PARAMS in state are authoritative.
        readParametersFromState (loadParams, newState);

        return true;
    }

    static BusesProperties getBusLayout()
    {
        // FEATHER: this dynamic patch-loader layout is fixed at processor construction.
        // It predeclares one optional aux input bus and maps a loaded patch's first
        // aux/sidechain input group onto it; more exotic layouts need generated plugins.
        BusesProperties layout;
        layout.addBus (true,  "Input",     juce::AudioChannelSet::stereo(), true);
        layout.addBus (true,  "Sidechain", juce::AudioChannelSet::stereo(), false);
        layout.addBus (false, "Output",    juce::AudioChannelSet::stereo(), true);
        return layout;
    }

    bool isViewVisible()
    {
        return patch->isPlayable();
    }

private:
    // FEATHER: loader-only rolling output capture; generated plugins stay unchanged.
    struct OutputCaptureSnapshot;

public:
    struct OutputCaptureSaveResult
    {
        bool ok = false;
        juce::File file;
        juce::String message;
        int numFrames = 0;
        int numChannels = 0;
        double sampleRate = 0.0;
    };

    void prepareOutputCapture (double sampleRate)
    {
        outputCaptureEnabled.store (false, std::memory_order_release);
        outputCaptureSnapshotRequested.store (true, std::memory_order_release);
        waitForOutputCaptureWriterToStop();

        const auto numChannels = getTotalNumOutputChannels();
        const auto numSamples = sampleRate > 0.0 ? static_cast<int> (std::ceil (sampleRate * outputCaptureLengthSeconds))
                                                 : 0;

        outputCaptureRing.setSize (std::max (0, numChannels), std::max (0, numSamples), false, false, false);
        outputCaptureRing.clear();
        outputCaptureSampleRate = sampleRate;
        outputCaptureWriteFrame.store (0, std::memory_order_release);

        outputCaptureEnabled.store (numChannels > 0 && numSamples > 0, std::memory_order_release);
        outputCaptureSnapshotRequested.store (false, std::memory_order_release);
    }

    void captureProcessedOutput (juce::AudioBuffer<float>& audio, int numFrames) noexcept
    {
        if (numFrames <= 0
             || ! outputCaptureEnabled.load (std::memory_order_acquire)
             || outputCaptureSnapshotRequested.load (std::memory_order_acquire))
            return;

        outputCaptureWriterActive.store (true, std::memory_order_release);

        if (outputCaptureSnapshotRequested.load (std::memory_order_acquire)
             || ! outputCaptureEnabled.load (std::memory_order_acquire))
        {
            outputCaptureWriterActive.store (false, std::memory_order_release);
            return;
        }

        auto outputBus = getBusBuffer (audio, false, dynamicMainOutputBusIndex);
        const auto ringChannels = outputCaptureRing.getNumChannels();
        const auto ringFrames = outputCaptureRing.getNumSamples();

        if (outputBus.getNumChannels() != ringChannels || ringFrames <= 0)
        {
            outputCaptureWriterActive.store (false, std::memory_order_release);
            return;
        }

        const auto writeFrame = outputCaptureWriteFrame.load (std::memory_order_relaxed);
        const auto framesToCopy = std::min (numFrames, ringFrames);
        const auto sourceStartFrame = numFrames - framesToCopy;
        auto ringFrame = static_cast<int> ((writeFrame + static_cast<uint64_t> (sourceStartFrame))
                                            % static_cast<uint64_t> (ringFrames));
        auto sourceFrame = sourceStartFrame;
        auto remaining = framesToCopy;

        while (remaining > 0)
        {
            const auto chunk = std::min (remaining, ringFrames - ringFrame);

            for (int channel = 0; channel < ringChannels; ++channel)
                juce::FloatVectorOperations::copy (outputCaptureRing.getWritePointer (channel, ringFrame),
                                                   outputBus.getReadPointer (channel, sourceFrame),
                                                   chunk);

            sourceFrame += chunk;
            remaining -= chunk;
            ringFrame = 0;
        }

        outputCaptureWriteFrame.store (writeFrame + static_cast<uint64_t> (numFrames), std::memory_order_release);
        outputCaptureWriterActive.store (false, std::memory_order_release);
    }

    OutputCaptureSaveResult saveLastOutputCapture()
    {
        OutputCaptureSaveResult result;

        if (auto snapshot = createOutputCaptureSnapshot (result))
            return writeOutputCaptureSnapshot (*snapshot);

        return result;
    }

    void saveLastOutputCaptureAsync (std::function<void(OutputCaptureSaveResult)> completion)
    {
        OutputCaptureSaveResult result;
        auto snapshot = createOutputCaptureSnapshot (result);

        if (snapshot == nullptr)
        {
            completion (std::move (result));
            return;
        }

        auto snapshotToWrite = std::shared_ptr<OutputCaptureSnapshot> (std::move (snapshot));

        std::thread ([snapshotToWrite, completion = std::move (completion)]() mutable
        {
            auto writeResult = writeOutputCaptureSnapshot (*snapshotToWrite);

            juce::MessageManager::callAsync ([completion = std::move (completion),
                                              writeResult = std::move (writeResult)]() mutable
            {
                completion (std::move (writeResult));
            });
        }).detach();
    }

    struct ExtraEditorComponent  : public juce::Component,
                                   public juce::FileDragAndDropTarget,
                                   private juce::Timer
    {
        ExtraEditorComponent (JITLoaderPlugin& p) : plugin (p)
        {
            messageBox.setMultiLine (true);
            messageBox.setReadOnly (true);

            unloadButton.onClick = [this] { plugin.unload(); };
            saveCaptureButton.onClick = [this] { saveCapture(); };
            captureStatus.setJustificationType (juce::Justification::centredLeft);

            addAndMakeVisible (messageBox);
            addAndMakeVisible (unloadButton);
            addAndMakeVisible (saveCaptureButton);
            addAndMakeVisible (captureStatus);
        }

        void resized() override
        {
            auto r = getLocalBounds().reduced (4);
            auto buttonRow = r.removeFromTop (30);
            unloadButton.setBounds (buttonRow.removeFromRight (80));
            buttonRow.removeFromRight (4);
            saveCaptureButton.setBounds (buttonRow.removeFromRight (124));
            buttonRow.removeFromRight (8);
            captureStatus.setBounds (buttonRow);
            messageBox.setBounds (r);
        }

        void refresh()
        {
            unloadButton.setVisible (plugin.patch->isLoaded());
            saveCaptureButton.setVisible (plugin.patch->isLoaded());
            saveCaptureButton.setEnabled (plugin.patch->isLoaded() && ! saveCaptureInProgress);
            captureStatus.setVisible (plugin.patch->isLoaded() && captureStatus.getText().isNotEmpty());
            messageBox.setVisible (! plugin.patch->isPlayable());

           #if JUCE_MAJOR_VERSION == 8
            juce::Font f (juce::FontOptions (18.0f));
           #else
            juce::Font f (18.0f);
           #endif

            f.setTypefaceName (juce::Font::getDefaultMonospacedFontName());
            messageBox.setFont (f);

            auto text = plugin.statusMessage;

            if (text.empty())
                text = "Cmajor " + std::string (cmaj::Library::getVersion()) + "\n\nDrag-and-drop a .cmajorpatch file here to load it";

            messageBox.setText (text);
        }

        void saveCapture()
        {
            saveCaptureInProgress = true;
            saveCaptureButton.setEnabled (false);
            showCaptureStatus ("Saving capture...", false, false);

            juce::Component::SafePointer<ExtraEditorComponent> safeThis (this);

            plugin.saveLastOutputCaptureAsync ([safeThis] (OutputCaptureSaveResult result)
            {
                if (auto* c = safeThis.getComponent())
                    c->captureSaveFinished (std::move (result));
            });
        }

        void captureSaveFinished (OutputCaptureSaveResult result)
        {
            saveCaptureInProgress = false;
            saveCaptureButton.setEnabled (plugin.patch->isLoaded());

            if (result.ok)
                showCaptureStatus ("Saved: " + result.file.getFullPathName(), false, true);
            else
                showCaptureStatus (result.message, true, true);
        }

        void showCaptureStatus (const juce::String& text, bool isError, bool autoClear)
        {
            captureStatus.setText (text, juce::dontSendNotification);
            captureStatus.setTooltip (text);
            captureStatus.setColour (juce::Label::textColourId, isError ? juce::Colours::red
                                                                         : juce::Colours::lightgreen);
            captureStatus.setVisible (text.isNotEmpty() && plugin.patch->isLoaded());

            if (autoClear)
                startTimer (6000);
            else
                stopTimer();
        }

        void timerCallback() override
        {
            captureStatus.setText ({}, juce::dontSendNotification);
            captureStatus.setTooltip ({});
            captureStatus.setVisible (false);
            stopTimer();
        }

        void paintOverChildren (juce::Graphics& g) override
        {
            if (isDragOver)
                g.fillAll (juce::Colours::lightgreen.withAlpha (0.3f));
        }

        bool isInterestedInFileDrag (const juce::StringArray& files) override
        {
            return files.size() == 1 && files[0].endsWith (".cmajorpatch");
        }

        void fileDragEnter (const juce::StringArray&, int, int) override       { setDragOver (true); }
        void fileDragExit (const juce::StringArray&) override                  { setDragOver (false); }

        void filesDropped (const juce::StringArray& files, int, int) override
        {
            setDragOver (false);

            if (isInterestedInFileDrag (files))
                plugin.loadPatch (files[0].toStdString());
        }

        void setDragOver (bool b)
        {
            if (isDragOver != b)
            {
                isDragOver = b;
                repaint();
            }
        }

        //==============================================================================
        JITLoaderPlugin& plugin;
        bool isDragOver = false;
        bool saveCaptureInProgress = false;

        juce::TextEditor messageBox;
        juce::TextButton unloadButton { "Unload" };
        juce::TextButton saveCaptureButton { "Save last 30s" };
        juce::Label captureStatus;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ExtraEditorComponent)
    };

    static constexpr int extraCompHeight = 50;

    std::unique_ptr<ExtraEditorComponent> createExtraComponent()
    {
        return std::make_unique<ExtraEditorComponent> (*this);
    }

    void refreshExtraComp (juce::Component* c)
    {
        if (auto v = dynamic_cast<ExtraEditorComponent*> (c))
            v->refresh();
    }

private:
    struct OutputCaptureSnapshot
    {
        choc::buffer::ChannelArrayBuffer<float> audio;
        double sampleRate = 0.0;
    };

    struct OutputCaptureSnapshotGate
    {
        explicit OutputCaptureSnapshotGate (JITLoaderPlugin& p)
            : plugin (p),
              wasSuspended (p.isSuspended())
        {
            plugin.outputCaptureSnapshotRequested.store (true, std::memory_order_release);
            plugin.suspendProcessing (true);
        }

        ~OutputCaptureSnapshotGate()
        {
            plugin.suspendProcessing (wasSuspended);
            plugin.outputCaptureSnapshotRequested.store (false, std::memory_order_release);
        }

        JITLoaderPlugin& plugin;
        bool wasSuspended = false;
    };

    bool waitForOutputCaptureWriterToStop() const
    {
        for (int i = 0; i < 100; ++i)
        {
            if (! outputCaptureWriterActive.load (std::memory_order_acquire))
                return true;

            std::this_thread::sleep_for (std::chrono::milliseconds (1));
        }

        return ! outputCaptureWriterActive.load (std::memory_order_acquire);
    }

    std::unique_ptr<OutputCaptureSnapshot> createOutputCaptureSnapshot (OutputCaptureSaveResult& result)
    {
        if (! outputCaptureEnabled.load (std::memory_order_acquire))
        {
            result.message = "Capture is not prepared yet";
            return {};
        }

        OutputCaptureSnapshotGate snapshotGate (*this);

        if (! waitForOutputCaptureWriterToStop())
        {
            result.message = "Capture is busy";
            return {};
        }

        const auto numChannels = outputCaptureRing.getNumChannels();
        const auto capacityFrames = outputCaptureRing.getNumSamples();
        const auto writeFrame = outputCaptureWriteFrame.load (std::memory_order_acquire);
        const auto filledFrames = static_cast<int> (std::min<uint64_t> (writeFrame, static_cast<uint64_t> (capacityFrames)));

        result.sampleRate = outputCaptureSampleRate;
        result.numChannels = numChannels;
        result.numFrames = filledFrames;

        if (numChannels <= 0 || capacityFrames <= 0 || outputCaptureSampleRate <= 0.0)
        {
            result.message = "Capture is not prepared yet";
            return {};
        }

        if (filledFrames <= 0)
        {
            result.message = "No captured audio yet";
            return {};
        }

        auto snapshot = std::make_unique<OutputCaptureSnapshot>();
        snapshot->sampleRate = outputCaptureSampleRate;
        snapshot->audio = choc::buffer::ChannelArrayBuffer<float> (static_cast<choc::buffer::ChannelCount> (numChannels),
                                                                   static_cast<choc::buffer::FrameCount> (filledFrames),
                                                                   false);

        const auto oldestFrame = writeFrame - static_cast<uint64_t> (filledFrames);
        const auto firstSourceFrame = static_cast<int> (oldestFrame % static_cast<uint64_t> (capacityFrames));
        const auto firstChunk = std::min (filledFrames, capacityFrames - firstSourceFrame);
        const auto secondChunk = filledFrames - firstChunk;
        auto destView = snapshot->audio.getView();

        for (int channel = 0; channel < numChannels; ++channel)
        {
            auto* dest = destView.getChannel (static_cast<choc::buffer::ChannelCount> (channel)).data.data;

            if (firstChunk > 0)
                juce::FloatVectorOperations::copy (dest,
                                                   outputCaptureRing.getReadPointer (channel, firstSourceFrame),
                                                   firstChunk);

            if (secondChunk > 0)
                juce::FloatVectorOperations::copy (dest + firstChunk,
                                                   outputCaptureRing.getReadPointer (channel, 0),
                                                   secondChunk);
        }

        return snapshot;
    }

    static OutputCaptureSaveResult writeOutputCaptureSnapshot (const OutputCaptureSnapshot& snapshot)
    {
        OutputCaptureSaveResult result;
        result.sampleRate = snapshot.sampleRate;
        result.numChannels = static_cast<int> (snapshot.audio.getNumChannels());
        result.numFrames = static_cast<int> (snapshot.audio.getNumFrames());

        try
        {
            if (result.sampleRate <= 0.0 || result.numChannels <= 0 || result.numFrames <= 0)
            {
                result.message = "Capture snapshot is empty";
                return result;
            }

            auto directory = getOutputCaptureDirectory();

            if (! directory.exists())
            {
                auto createResult = directory.createDirectory();

                if (createResult.failed())
                {
                    result.message = "Could not create capture directory: " + createResult.getErrorMessage();
                    return result;
                }
            }

            auto file = createOutputCaptureFile (directory);
            choc::audio::WAVAudioFileFormat<true> wav;
            choc::audio::AudioFileProperties properties;
            properties.bitDepth = choc::audio::BitDepth::float32;
            properties.sampleRate = result.sampleRate;
            properties.numChannels = static_cast<uint32_t> (result.numChannels);

            auto writer = wav.createWriter (file.getFullPathName().toStdString(), properties);

            if (writer == nullptr)
            {
                result.message = "Could not create WAV writer";
                return result;
            }

            if (! writer->appendFrames (snapshot.audio.getView()) || ! writer->flush())
            {
                file.deleteFile();
                result.message = "Could not write capture WAV";
                return result;
            }

            result.ok = true;
            result.file = file;
            result.message = file.getFullPathName();
            return result;
        }
        catch (const std::exception& e)
        {
            result.message = juce::String ("Could not save capture: ") + e.what();
            return result;
        }
        catch (...)
        {
            result.message = "Could not save capture";
            return result;
        }
    }

    static juce::File getOutputCaptureDirectory()
    {
       #if JUCE_WINDOWS
        if (auto* userProfile = std::getenv ("USERPROFILE"); userProfile != nullptr && userProfile[0] != 0)
            return juce::File (juce::String (userProfile))
                    .getChildFile ("Documents")
                    .getChildFile ("LostAudio")
                    .getChildFile ("Captures");
       #endif

        return juce::File::getSpecialLocation (juce::File::userDocumentsDirectory)
                .getChildFile ("LostAudio")
                .getChildFile ("Captures");
    }

    static juce::File createOutputCaptureFile (const juce::File& directory)
    {
        const auto now = juce::Time::getCurrentTime();
        const auto timestamp = juce::String (now.getYear())
                             + paddedNumber (now.getMonth() + 1, 2)
                             + paddedNumber (now.getDayOfMonth(), 2)
                             + "_"
                             + paddedNumber (now.getHours(), 2)
                             + paddedNumber (now.getMinutes(), 2)
                             + paddedNumber (now.getSeconds(), 2)
                             + "_"
                             + paddedNumber (now.getMilliseconds(), 3);
        const auto stem = juce::String ("cmaj_capture_") + timestamp;

        for (int i = 0; i < 10000; ++i)
        {
            auto suffix = i == 0 ? juce::String() : "_" + juce::String (i);
            auto file = directory.getChildFile (stem + suffix + ".wav");

            if (! file.exists())
                return file;
        }

        return directory.getChildFile (stem + "_overflow.wav");
    }

    static juce::String paddedNumber (int value, int width)
    {
        return juce::String (value).paddedLeft ('0', width);
    }

    static constexpr double outputCaptureLengthSeconds = 30.0;

    juce::AudioBuffer<float> outputCaptureRing;
    std::atomic<uint64_t> outputCaptureWriteFrame { 0 };
    std::atomic<bool> outputCaptureEnabled { false };
    std::atomic<bool> outputCaptureWriterActive { false };
    std::atomic<bool> outputCaptureSnapshotRequested { false };
    double outputCaptureSampleRate = 0.0;
};

//==============================================================================
/// This class is a juce::AudioPluginInstance which runs a JIT-compiled engine.
class SinglePatchJITPlugin  : public JUCEPluginBase<SinglePatchJITPlugin>
{
public:
    SinglePatchJITPlugin (std::shared_ptr<cmaj::Patch> patchToUse,
                          std::filesystem::path manifestLocationToUse)
        : JUCEPluginBase<SinglePatchJITPlugin> (patchToUse, preloadBusLayout (*patchToUse, manifestLocationToUse)),
          manifestLocation (std::move (manifestLocationToUse))
    {
        setNewStateAsync (createEmptyState (manifestLocation));
    }

    bool prepareManifest (Patch::LoadParams& loadParams, const juce::ValueTree& newState) override
    {
        if (! newState.isValid())
            return false;

        loadParams.manifest.initialiseWithFile (manifestLocation);
        readParametersFromState (loadParams, newState);
        return true;
    }

    static BusesProperties preloadBusLayout (cmaj::Patch& p, std::filesystem::path location)
    {
        cmaj::PatchManifest m;
        m.initialiseWithFile (location);
        p.preload (m);

        return getBusesProperties (p.getInputEndpoints(),
                                   p.getOutputEndpoints());
    }

    static constexpr bool isPrecompiled = false;
    static constexpr bool isFixedPatch = true;

    std::filesystem::path manifestLocation;

    static constexpr int extraCompHeight = 0;
    static bool isViewVisible()  { return true; }
    std::unique_ptr<juce::Component> createExtraComponent() { return {}; }
    void refreshExtraComp (juce::Component*) {}
};

//==============================================================================
/// This class is a juce::AudioPluginInstance which loads a generated C++ patch
template <typename GeneratedInfoClass>
class GeneratedPlugin  : public JUCEPluginBase<GeneratedPlugin<GeneratedInfoClass>>
{
public:
    using super = JUCEPluginBase<GeneratedPlugin<GeneratedInfoClass>>;

    GeneratedPlugin (std::shared_ptr<cmaj::Patch> patchToUse)
        : super (std::move (patchToUse), getBusLayout())
    {
        this->patch->createEngine = +[] { return cmaj::createEngineForGeneratedCppProgram<typename GeneratedPlugin::PerformerClass>(); };

        this->applyRateAndBlockSize (44100, 128);
        super::setNewState (this->createEmptyState ({}));
    }

    bool prepareManifest (Patch::LoadParams& loadParams, const juce::ValueTree& newState) override
    {
        loadParams.manifest.needsToBuildSource = false;

        loadParams.manifest.initialiseWithVirtualFile (std::string (PatchClass::filename),
            [] (const std::string& f) -> std::shared_ptr<std::istream>
            {
                for (auto& file : PatchClass::files)
                    if (f == file.name)
                        return std::make_shared<std::istringstream> (std::string (file.content), std::ios::binary);

                return {};
            },
            [] (const std::string& name) -> std::string { return name; },
            [] (const std::string&) -> std::filesystem::file_time_type { return {}; },
            [] (const std::string& f)
            {
                for (auto& file : PatchClass::files)
                    if (f == file.name)
                        return true;

                return false;
            });

        this->readParametersFromState (loadParams, newState);
        return true;
    }

    static auto getBusLayout()
    {
        auto programDetailsJSON = choc::json::parse (PerformerClass::programDetailsJSON);

        return super::getBusesProperties (cmaj::EndpointDetailsList::fromJSON (programDetailsJSON["inputs"], true),
                                          cmaj::EndpointDetailsList::fromJSON (programDetailsJSON["outputs"], false));
    }

    using PatchClass = GeneratedInfoClass;
    using PerformerClass = typename PatchClass::PerformerClass;
    static constexpr bool isPrecompiled = true;
    static constexpr bool isFixedPatch = true;

    static constexpr int extraCompHeight = 0;
    static bool isViewVisible()  { return true; }
    std::unique_ptr<juce::Component> createExtraComponent() { return {}; }
    void refreshExtraComp (juce::Component*) {}
};


} // namespace cmaj::plugin
