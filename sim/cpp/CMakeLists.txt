cmake_minimum_required(VERSION 3.16)
project(fractal_sim CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Optimise by default. -O2 is the sane release default; debug builds can
# override by passing -DCMAKE_BUILD_TYPE=Debug.
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra -Wpedantic)

add_executable(fractal_sim
    src/main.cpp
    src/protocol.cpp
)

target_include_directories(fractal_sim PRIVATE vendor)
