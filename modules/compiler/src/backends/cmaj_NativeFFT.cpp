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
#include "../../include/cmaj_ErrorHandling.h"

#include "cmaj_NativeFFT.h"

#if CMAJ_ENABLE_NATIVE_OVERRIDES

#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>

#include "pffft/pffft.h"

namespace cmaj::native_fft
{
namespace
{
    static constexpr uint64_t minBoundComplexSize = 16;
    static constexpr uint64_t maxBoundComplexSize = 1024;

   #ifndef CMAJ_NATIVE_FFT_RT_CONTRACT_CHECK
    #define CMAJ_NATIVE_FFT_RT_CONTRACT_CHECK 0
   #endif

   #if CMAJ_NATIVE_FFT_RT_CONTRACT_CHECK
    static thread_local bool insideRenderPath = false;

    struct RenderPathRTContract
    {
        void enter()
        {
            CMAJ_ASSERT (! insideRenderPath);
            insideRenderPath = true;
            ++calls;
        }

        void exit() noexcept
        {
            insideRenderPath = false;
        }

        void assertSatisfied() const
        {
            CMAJ_ASSERT (lockAttempts.load() == 0);
            CMAJ_ASSERT (heapAllocations.load() == 0);
        }

        void assertNotInRenderPath() const
        {
            CMAJ_ASSERT (! insideRenderPath);
        }

        std::atomic<uint64_t> calls { 0 };
        std::atomic<uint64_t> lockAttempts { 0 };
        std::atomic<uint64_t> heapAllocations { 0 };
    };

    static RenderPathRTContract renderPathRTContract;

    struct RenderPathScope
    {
        RenderPathScope()
        {
            renderPathRTContract.enter();
            renderPathRTContract.assertSatisfied();
        }

        ~RenderPathScope()
        {
            renderPathRTContract.exit();
        }
    };
   #endif

    static bool isAligned16 (const void* p)
    {
        return (reinterpret_cast<uintptr_t> (p) & 15u) == 0;
    }

    struct PFFFTSetupDeleter
    {
        void operator() (PFFFT_Setup* setup) const
        {
            if (setup != nullptr)
                pffft_destroy_setup (setup);
        }
    };

    template <uint64_t numComplexValues>
    struct PreparedComplexFFT32
    {
        static PFFFT_Setup* prepare()
        {
            static_assert (numComplexValues >= minBoundComplexSize && numComplexValues <= maxBoundComplexSize);
            static_assert ((numComplexValues & (numComplexValues - 1)) == 0);

           #if CMAJ_NATIVE_FFT_RT_CONTRACT_CHECK
            renderPathRTContract.assertNotInRenderPath();
           #endif

            std::call_once (setupOnce, []
            {
                ownedSetup.reset (pffft_new_setup (static_cast<int> (numComplexValues), PFFFT_COMPLEX));
                setup = ownedSetup.get();
            });

            return setup;
        }

        static PFFFT_Setup* getPreparedSetup() noexcept
        {
            return setup;
        }

        static inline std::once_flag setupOnce;
        static inline std::unique_ptr<PFFFT_Setup, PFFFTSetupDeleter> ownedSetup;
        static inline PFFFT_Setup* setup = nullptr;
    };

    template <uint64_t numComplexValues>
    void runComplexFFT32 (float* interleavedComplexData)
    {
        static constexpr auto dataFloats = static_cast<size_t> (2 * numComplexValues);
        static_assert (numComplexValues <= maxBoundComplexSize);

       #if CMAJ_NATIVE_FFT_RT_CONTRACT_CHECK
        RenderPathScope renderPathScope;
       #endif

        auto* setup = PreparedComplexFFT32<numComplexValues>::getPreparedSetup();
        CMAJ_ASSERT (setup != nullptr);

        if (isAligned16 (interleavedComplexData))
        {
            // FEATHER: nullptr work tells PFFFT to use its bounded internal stack buffer; no render-path heap.
            pffft_transform_ordered (setup, interleavedComplexData, interleavedComplexData, nullptr, PFFFT_FORWARD);
        }
        else
        {
            alignas (16) float alignedData[dataFloats];

            std::memcpy (alignedData, interleavedComplexData, dataFloats * sizeof (float));
            pffft_transform_ordered (setup, alignedData, alignedData, nullptr, PFFFT_FORWARD);
            std::memcpy (interleavedComplexData, alignedData, dataFloats * sizeof (float));
        }
    }

    template <uint64_t numComplexValues>
    void* getFunctionIfSetupCanBeCreated()
    {
        if (PreparedComplexFFT32<numComplexValues>::prepare() == nullptr)
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
