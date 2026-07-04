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

#include "../API/cmaj_Endpoints.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace cmaj::audio_bus_layout
{

// FEATHER: Shared interpretation of endpoint `bus`/`role` annotations for plugin wrappers.
enum class BusRole
{
    unknown,
    main,
    sidechain,
    aux
};

struct EndpointRef
{
    const EndpointDetails* endpoint = nullptr;
    uint32_t channelCount = 0;
};

struct BusGroup
{
    std::string name;
    BusRole role = BusRole::unknown;
    uint32_t channelCount = 0;
    std::vector<EndpointRef> endpoints;

    // FEATHER: true when any endpoint in the group is annotated channelMode: "strict",
    // which opts a main bus group out of host channel-count adaptation.
    bool strictChannelMode = false;

    bool isAuxiliary() const
    {
        return role == BusRole::sidechain || role == BusRole::aux || name == "Sidechain";
    }
};

inline BusRole getEndpointBusRole (const EndpointDetails& endpoint)
{
    if (endpoint.annotation.isObject())
    {
        auto role = endpoint.annotation["role"].toString();

        if (role == "main")       return BusRole::main;
        if (role == "sidechain")  return BusRole::sidechain;
        if (role == "sideChain")  return BusRole::sidechain;
        if (role == "aux")        return BusRole::aux;
    }

    return BusRole::unknown;
}

// FEATHER: endpoint annotation `channelMode: "strict"` opts a main-bus endpoint out
// of the wrappers' channel-count adaptation (mono<->multi replication/fold-down).
// The default is adaptive for main buses and strict for aux/sidechain buses.
inline bool hasStrictChannelMode (const EndpointDetails& endpoint)
{
    return endpoint.annotation.isObject()
        && endpoint.annotation["channelMode"].toString() == "strict";
}

inline bool hasAudioBusAnnotation (const EndpointDetails& endpoint)
{
    return endpoint.annotation.isObject()
        && (endpoint.annotation.hasObjectMember ("bus")
            || endpoint.annotation.hasObjectMember ("role"));
}

inline bool hasAnyAudioBusAnnotation (const EndpointDetailsList& endpoints)
{
    for (auto& endpoint : endpoints)
        if (endpoint.getNumAudioChannels() != 0 && hasAudioBusAnnotation (endpoint))
            return true;

    return false;
}

inline bool isInputEndpointList (const EndpointDetailsList& endpoints)
{
    if (! endpoints.endpoints.empty())
        return endpoints.endpoints.front().isInput;

    return true;
}

inline std::string getDefaultBusName (const EndpointDetailsList& endpoints)
{
    return isInputEndpointList (endpoints) ? "in" : "out";
}

inline std::string getEndpointBusName (const EndpointDetails& endpoint, std::string_view defaultName)
{
    if (endpoint.annotation.isObject())
    {
        auto busName = endpoint.annotation["bus"].toString();

        if (! busName.empty())
            return busName;

        auto role = getEndpointBusRole (endpoint);

        if (role == BusRole::sidechain || role == BusRole::aux)
            return "Sidechain";

        if (role == BusRole::main)
            return endpoint.isInput ? "Input" : "Output";
    }

    return std::string (defaultName);
}

inline uint32_t getTotalAudioChannels (const EndpointDetailsList& endpoints)
{
    uint32_t channelCount = 0;

    for (auto& endpoint : endpoints)
        channelCount += endpoint.getNumAudioChannels();

    return channelCount;
}

inline void addEndpointToGroup (std::vector<BusGroup>& groups,
                                const EndpointDetails& endpoint,
                                std::string_view busName,
                                BusRole role,
                                uint32_t channelCount)
{
    auto group = std::find_if (groups.begin(), groups.end(),
                               [&] (const BusGroup& g) { return g.name == busName; });

    if (group == groups.end())
        group = groups.insert (groups.end(), BusGroup { std::string (busName), role, 0, {} });
    else if (group->role == BusRole::unknown && role != BusRole::unknown)
        group->role = role;

    group->channelCount += channelCount;
    group->strictChannelMode = group->strictChannelMode || hasStrictChannelMode (endpoint); // FEATHER
    group->endpoints.push_back ({ std::addressof (endpoint), channelCount });
}

inline std::vector<BusGroup> groupEndpointsByBus (const EndpointDetailsList& endpoints)
{
    std::vector<BusGroup> groups;
    auto defaultName = getDefaultBusName (endpoints);

    if (! hasAnyAudioBusAnnotation (endpoints))
    {
        for (auto& endpoint : endpoints)
            if (auto channelCount = endpoint.getNumAudioChannels())
                addEndpointToGroup (groups, endpoint, defaultName, BusRole::main, channelCount);

        return groups;
    }

    for (auto& endpoint : endpoints)
    {
        auto channelCount = endpoint.getNumAudioChannels();

        if (channelCount == 0)
            continue;

        auto role = getEndpointBusRole (endpoint);
        addEndpointToGroup (groups, endpoint, getEndpointBusName (endpoint, defaultName), role, channelCount);
    }

    return groups;
}

inline uint32_t getTotalAudioChannels (const std::vector<BusGroup>& groups)
{
    uint32_t channelCount = 0;

    for (const auto& group : groups)
        channelCount += group.channelCount;

    return channelCount;
}

inline bool isMainBus (const BusGroup& group, size_t index)
{
    if (group.isAuxiliary())
        return false;

    return group.role == BusRole::main || index == 0;
}

// FEATHER: main bus groups adapt mismatched host channel counts by default, restoring
// the pre-bus-layout upstream behaviour (mono output replicated to every host channel,
// multi-channel groups folded to a mono host bus by unscaled summing, mono host input
// replicated into every endpoint channel). Aux/sidechain groups always stay strict and
// silence-backed, and `channelMode: "strict"` opts a main-bus endpoint out.
inline bool shouldAdaptChannels (const BusGroup& group, size_t index)
{
    return isMainBus (group, index) && ! group.strictChannelMode;
}

} // namespace cmaj::audio_bus_layout
