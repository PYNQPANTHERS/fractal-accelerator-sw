from dataclasses import dataclass


@dataclass(frozen=True)
class RenderConfig:
    """One render request.

    Fields mirror the AXI register map's PL-facing config — same shape on
    both sides so the sim and real driver can be swapped behind the same
    interface ... hopefuly.
    """

    pan_x: float
    pan_y: float
    zoom: int
    fractal_type: str         # "mandelbrot" | "julia" | "burning_ship"
    julia_c_real: float = 0.0
    julia_c_imag: float = 0.0
    max_iter: int = 256
    preview: bool = False     # subsampled render (faster, slightly blocky)
