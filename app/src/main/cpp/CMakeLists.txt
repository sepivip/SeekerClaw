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
