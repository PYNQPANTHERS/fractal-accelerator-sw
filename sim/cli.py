"""Command-line entry to the simulator.

Renders one tile and writes its bytes to stdout. Useful for manual checks
and as the protocol skin the PS driver will speak to when sim is wired in
via subprocess pipe.

Example:
    python -m sim.cli --pan-x -0.5 --pan-y 0 --zoom 2 --tile 0 > tile.bin

ie python in binary mode 
"""

import argparse
import sys

from sim.renderer import RenderConfig, render_tile


def main() -> None:
    parser = argparse.ArgumentParser(description="Render one tile of a fractal.")
    parser.add_argument("--pan-x", type=float, required=True)
    parser.add_argument("--pan-y", type=float, required=True)
    parser.add_argument("--zoom", type=int, required=True)
    parser.add_argument("--fractal", default="mandelbrot",
                        choices=["mandelbrot", "julia", "burning_ship"])
    parser.add_argument("--julia-c-real", type=float, default=0.0)
    parser.add_argument("--julia-c-imag", type=float, default=0.0)
    parser.add_argument("--tile", type=int, required=True, help="0..15")

    args = parser.parse_args()

    config = RenderConfig(
        pan_x=args.pan_x,
        pan_y=args.pan_y,
        zoom=args.zoom,
        fractal_type=args.fractal,
        julia_c_real=args.julia_c_real,
        julia_c_imag=args.julia_c_imag,
    )

    payload = render_tile(config, args.tile)
    sys.stdout.buffer.write(payload)


if __name__ == "__main__":
    main()
