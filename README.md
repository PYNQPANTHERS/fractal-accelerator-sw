## fractal-accelerator-sw

PS-side driver, server, and web UI for the fractal accelerator.

PL fabric lives in `fractal-accelerator-rtl`. This repo is the ARM-side Python + browser code.

## Demo concept

Two-panel Mandelbrot/Julia explorer in the style of [Mandelbrot Maps](https://jmaio.github.io/mandelbrot-maps/), but with rendering accelerated by the FPGA.

- **Mandelbrot panel** (big, pannable, zoomable) — has a draggable c-marker.
- **Julia panel** (big, pannable, zoomable) — renders the Julia set for the c at the marker position.
- **Each panel has a small minimap** below it — cached overview, viewport box, click to navigate-- doesnt zoom in can only pan, but obviously just pans as you pan on the main panel -minimaps obviosuly render once on first render then can just be saved . 

PS schedules 2 main jobs (2 main  set panels )  at different priorities -- possible scope for switching between inetrleavng the requests for continuous Julia rendering, and rendering the correspodning julia once user has stopped panning or panning slows down.


# sim

will prototype with some sort of simulator that can parallel the hardware / PS dev we want to do

# main jupyter driver

i would say this has to be done in cpp, for sending fast from arm. 

## possible  Layout 
this can change if better naming / splits 

```
docs/      contracts
driver/    pynq wrapper for ps
server/    WebSocket server, PS-side job scheduler
web/       browser frontend 
sim/
```

