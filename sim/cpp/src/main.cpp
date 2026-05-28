// fractal_sim
//
// Long-running simulator binary. Reads JSON commands from stdin, writes
// framed binary responses to stdout, logs diagnostics to stderr.


#include <iostream>
#include <string>

int main() {

    std::cerr << "fractal_sim: ready" << std::endl;

    // Block on stdin until EOF (driver closes pipe, we exit cleanly).
    std::string line;
    while (std::getline(std::cin, line)) {
        std::cerr << "fractal_sim: received " << line.size() << " bytes" << std::endl;
    }

    std::cerr << "fractal_sim: stdin closed, exiting" << std::endl;
    return 0;
}
