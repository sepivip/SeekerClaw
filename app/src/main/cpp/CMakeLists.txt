cmake_minimum_required(VERSION 3.22.1)
project("native-lib")

add_library(${CMAKE_PROJECT_NAME} SHARED
        native-lib.cpp)

# Include node headers
include_directories(${CMAKE_SOURCE_DIR}/../../../libnode/include/node/)

# Import prebuilt libnode
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode
        PROPERTIES IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/../../../libnode/bin/${ANDROID_ABI}/libnode.so)

target_link_libraries(${CMAKE_PROJECT_NAME}
        libnode
        android
        log)

# BAT-1187: emit 16 KB-aligned ELF LOAD segments for our own JNI shim.
# Android 16 / 16 KB-page devices cannot load a 4 KB-aligned .so; Google Play
# blocks updates without 16 KB support from Feb 1 2027 (a SEPARATE, later gate
# than the Aug 31 2026 API-36 deadline this change is primarily for).
# NDK r28+ does this by default; we pin r27 (see ndkVersion in build.gradle.kts),
# so the flags are explicit. Verify with:
#   llvm-readelf -l libnative-lib.so   → every LOAD Align must read 0x4000
# NOTE: this fixes OUR library only. The prebuilt libnode.so (nodejs-mobile
# v18.20.4) is still 4 KB-aligned and is deliberately out of scope here —
# tracked as the autumn 16 KB ticket.
target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
        "-Wl,-z,max-page-size=16384"
        "-Wl,-z,common-page-size=16384")
