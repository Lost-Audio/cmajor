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
//  CMAJOR IS PROVIDED "AS IS" WITHOUT ANY WARRANTY, AND ALL WARRANTIES, WHETHER
//  EXPRESSED OR IMPLIED, INCLUDING MERCHANTABILITY AND FITNESS FOR PURPOSE, ARE
//  DISCLAIMED.

#include "../../include/cmaj_DefaultFlags.h"

#include "cmaj_NativeFFT.h"

#if CMAJ_ENABLE_NATIVE_OVERRIDES

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <mutex>

#include "pffft/pffft.h"

namespace cmaj::native_fft
{
namespace
{
    static constexpr uint64_t minBoundComplexSize = 16;
    static constexpr size_t stackScratchBytes = 2048;

    static bool isPowerOfTwo (uint64_t n)
    {
        return n != 0 && (n & (n - 1)) == 0;
    }

    static uint32_t getLog2 (uint64_t n)
    {
        uint32_t result = 0;

        while (n > 1)
        {
            n >>= 1;
            ++result;
        }

        return result;
    }

    static bool isAligned16 (const void* p)
    {
        return (reinterpret_cast<uintptr_t> (p) & 15u) == 0;
    }

    struct SetupCache
    {
        ~SetupCache()
        {
            for (auto* setup : complexFloatSetups)
                if (setup != nullptr)
                    pffft_destroy_setup (setup);
        }

        PFFFT_Setup* getComplexFloatSetup (uint64_t n)
        {
            if (n < minBoundComplexSize || ! isPowerOfTwo (n) || n > maxBoundComplexSize)
                return {};

            auto index = getLog2 (n);
            std::lock_guard<std::mutex> lock (mutex);
            auto& setup = complexFloatSetups[index];

            if (setup == nullptr)
                setup = pffft_new_setup (static_cast<int> (n), PFFFT_COMPLEX);

            return setup;
        }

        static constexpr uint64_t maxBoundComplexSize = 65536;
        std::mutex mutex;
        std::array<PFFFT_Setup*, 17> complexFloatSetups {};
    };

    static SetupCache& getSetupCache()
    {
        static SetupCache cache;
        return cache;
    }

    struct ThreadLocalScratch
    {
        ~ThreadLocalScratch()
        {
            pffft_aligned_free (data);
        }

        float* ensure (size_t numFloats)
        {
            if (numFloats > capacity)
            {
                auto* newData = static_cast<float*> (pffft_aligned_malloc (numFloats * sizeof (float)));

                if (newData == nullptr)
                    return {};

                pffft_aligned_free (data);
                data = newData;
                capacity = numFloats;
            }

            return data;
        }

        float* data = nullptr;
        size_t capacity = 0;
    };

    static float* getThreadLocalScratch (size_t numFloats)
    {
        thread_local ThreadLocalScratch scratch;
        return scratch.ensure (numFloats);
    }

    template <uint64_t numComplexValues>
    void runComplexFFT32 (float* interleavedComplexData)
    {
        static constexpr auto dataFloats = static_cast<size_t> (2 * numComplexValues);
        static constexpr auto workFloats = dataFloats;
        static constexpr auto stackWorkBytes = workFloats * sizeof (float);
        static constexpr auto stackBounceBytes = (dataFloats + workFloats) * sizeof (float);

        auto* setup = getSetupCache().getComplexFloatSetup (numComplexValues);

        if (setup == nullptr)
            return;

        if (isAligned16 (interleavedComplexData))
        {
            if constexpr (stackWorkBytes <= stackScratchBytes)
            {
                alignas (16) float work[workFloats];
                pffft_transform_ordered (setup, interleavedComplexData, interleavedComplexData, work, PFFFT_FORWARD);
            }
            else
            {
                auto* work = getThreadLocalScratch (workFloats);

                if (work != nullptr)
                    pffft_transform_ordered (setup, interleavedComplexData, interleavedComplexData, work, PFFFT_FORWARD);
            }
        }
        else
        {
            if constexpr (stackBounceBytes <= stackScratchBytes)
            {
                alignas (16) float scratch[dataFloats + workFloats];
                auto* alignedData = scratch;
                auto* work = scratch + dataFloats;

                std::memcpy (alignedData, interleavedComplexData, dataFloats * sizeof (float));
                pffft_transform_ordered (setup, alignedData, alignedData, work, PFFFT_FORWARD);
                std::memcpy (interleavedComplexData, alignedData, dataFloats * sizeof (float));
            }
            else
            {
                auto* scratch = getThreadLocalScratch (dataFloats + workFloats);

                if (scratch != nullptr)
                {
                    auto* alignedData = scratch;
                    auto* work = scratch + dataFloats;

                    std::memcpy (alignedData, interleavedComplexData, dataFloats * sizeof (float));
                    pffft_transform_ordered (setup, alignedData, alignedData, work, PFFFT_FORWARD);
                    std::memcpy (interleavedComplexData, alignedData, dataFloats * sizeof (float));
                }
            }
        }
    }

    template <uint64_t numComplexValues>
    void* getFunctionIfSetupCanBeCreated()
    {
        if (getSetupCache().getComplexFloatSetup (numComplexValues) == nullptr)
            return {};

        auto fn = &runComplexFFT32<numComplexValues>;
        return reinterpret_cast<void*> (fn);
    }
}

void* getComplexFFT32Function (uint64_t numComplexValues)
{
    switch (numComplexValues)
    {
        case 16:    return getFunctionIfSetupCanBeCreated<16>();
        case 32:    return getFunctionIfSetupCanBeCreated<32>();
        case 64:    return getFunctionIfSetupCanBeCreated<64>();
        case 128:   return getFunctionIfSetupCanBeCreated<128>();
        case 256:   return getFunctionIfSetupCanBeCreated<256>();
        case 512:   return getFunctionIfSetupCanBeCreated<512>();
        case 1024:  return getFunctionIfSetupCanBeCreated<1024>();
        case 2048:  return getFunctionIfSetupCanBeCreated<2048>();
        case 4096:  return getFunctionIfSetupCanBeCreated<4096>();
        case 8192:  return getFunctionIfSetupCanBeCreated<8192>();
        case 16384: return getFunctionIfSetupCanBeCreated<16384>();
        case 32768: return getFunctionIfSetupCanBeCreated<32768>();
        case 65536: return getFunctionIfSetupCanBeCreated<65536>();
        default:    return {};
    }
}

const char* getPFFFTSimdArchitecture()   { return pffft_simd_arch(); }
int getPFFFTSimdSize()                   { return pffft_simd_size(); }

} // namespace cmaj::native_fft

#else

namespace cmaj::native_fft
{

void* getComplexFFT32Function (uint64_t)  { return {}; }
const char* getPFFFTSimdArchitecture()   { return "disabled"; }
int getPFFFTSimdSize()                   { return 0; }

} // namespace cmaj::native_fft

#endif
