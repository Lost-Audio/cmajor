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

#pragma once

#include <cstddef>
#include <memory>
#include <string_view>
#include <unordered_map>

#include "../AST/cmaj_AST.h"
#include "cmaj_NativeFFT.h"

namespace cmaj::native_overrides
{

using FunctionMap = std::unordered_map<const AST::Function*, void*>;
using MatcherFn = void* (*) (const AST::Function&);

struct Entry
{
    std::string_view qualifiedGenericName;
    MatcherFn matcher = nullptr;
};

inline bool isComplexStructWithFloatMembers (const AST::TypeBase& type, bool is64Bit)
{
    if (auto structType = type.skipConstAndRefModifiers().getAsStructType())
    {
        if (structType->memberTypes.size() != 2)
            return false;

        auto& realType = AST::castToTypeBaseRef (structType->memberTypes[0]).skipConstAndRefModifiers();
        auto& imagType = AST::castToTypeBaseRef (structType->memberTypes[1]).skipConstAndRefModifiers();

        return is64Bit ? (realType.isPrimitiveFloat64() && imagType.isPrimitiveFloat64())
                       : (realType.isPrimitiveFloat32() && imagType.isPrimitiveFloat32());
    }

    return false;
}

inline void* matchComplexFFT (const AST::Function& function)
{
    if (function.getNumParameters() != 1)
        return {};

    auto& paramType = AST::castToTypeBaseRef (function.getParameter (0).declaredType);

    if (! paramType.isReference())
        return {};

    auto& dataType = paramType.skipConstAndRefModifiers();

    if (! dataType.isFixedSizeArray() || dataType.getNumDimensions() != 1)
        return {};

    auto elementType = dataType.getArrayOrVectorElementType();

    if (elementType == nullptr)
        return {};

    auto& element = elementType->skipConstAndRefModifiers();

    if (element.isPrimitiveComplex64() || isComplexStructWithFloatMembers (element, true))
        return {};

    if (! (element.isPrimitiveComplex32() || isComplexStructWithFloatMembers (element, false)))
        return {};

    return native_fft::getComplexFFT32Function (dataType.getArrayOrVectorSize (0));
}

inline size_t registerNativeOverrides (const AST::Program& program, FunctionMap& overrides)
{
    static constexpr Entry entries[]
    {
        { "std::frequency::complexFFT", matchComplexFFT },
    };

    size_t numOverrides = 0;

    program.visitAllFunctions (true, [&] (AST::Function& function)
    {
        auto originalGenericFunction = AST::castToFunction (function.originalGenericFunction);

        if (originalGenericFunction == nullptr)
            return;

        auto qualifiedName = originalGenericFunction->getFullyQualifiedReadableName();

        for (auto& entry : entries)
        {
            if (qualifiedName == entry.qualifiedGenericName)
            {
                if (auto implementation = entry.matcher (function))
                {
                    overrides[std::addressof (function)] = implementation;
                    ++numOverrides;
                }

                return;
            }
        }
    });

    return numOverrides;
}

} // namespace cmaj::native_overrides
