
# ofc all base driver stuff todo also but: 

"""FPGA driver — PS-side interface to the PL fabric. Jupyter side.

# Preemption hook (TODO)

The PL already supports mid-render abort: job_queue_handler.flush and
comparator.sched_reset are plumbed end-to-end. To use it from PS:

  - AXI-Lite ctrl bit: abort_render (write-1-strobe)
  - AXI-Lite status bit: engine_idle

The driver should expose `cancel()` that writes abort, waits for idle,
then returns. Server scheduler calls cancel() when a new active-drag
push arrives for an in-flight panel. Policy lives server-side; mechanism
lives here.
"""
