# Current Performance Conclusions

These notes capture the decisions from the pan/Performance-mode investigation.
The fuller record is in `../OPTIMISATIONS.md` and `../PAN_SMOOTHNESS.md`.

## What Changed

- 4 x 4 visible rendering is the current path.
- Larger 5x5/6x6/7x7 render margins were tested and rolled back.
- Predictive prefetch is disabled while there is no rendered margin.
- Performance mode now relies on cheaper active renders: preview quality plus
  lower active `max_iter`, then full quality after pan or wheel settle.
- Julia coupling jobs use `mark_active=False` so they do not steal active-panel
  priority from the panel the user is dragging.
- Minimap rendering is optional because minimaps are real backend jobs.
- Workload telemetry is optional and only enabled while the floating inspector
  is open.

## Key Lesson

Scheduling alone cannot make a Mandelbrot frame cheaper. It can prevent Julia
or minimaps from blocking the active panel, but the FPS ceiling rises only when
the active render itself costs less.

That maps well to the FPGA design: active navigation can use a lower iteration
budget, coarser sampling, or tile-priority/cancellation policy; the settled view
then runs the full-quality path.

## Still Useful To Investigate

- Hardware-side tile priority or cancellation for stale background work.
- Benchmark traces comparing Performance vs Live Evolution with minimaps on/off.
- Feeding Workload Inspector events from the real PS driver using PL tile id and
  tile-done / transfer-complete status.
- Whether a small FPGA-cheap render margin becomes worthwhile once tile latency
  is dominated by hardware parallelism rather than CPU simulation.
