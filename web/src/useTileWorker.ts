/**
 * Hosts a single Web Worker that owns the tile-unpack pipeline.
 * Routes returned ImageBitmaps to the correct panel's TilePainter via
 * a panel→painter lookup callback.
 *
 * The main thread's job per tile is now:
 *   payload.buffer  → worker.postMessage(..., [transfer])  (~0 ms)
 *   on bitmap reply → painter.paintBitmap(seq, id, bitmap) (~0.05 ms)
 *
 * Everything between — the nibble unpack and the createImageBitmap
 * decode — happens off the main thread.
 */
import { useEffect, useMemo, useRef } from 'react'
import { PALETTE_RGBA } from './palette'
import type { Panel, TileFrame } from './protocol'
import type { TilePainter } from './tilePainter'
import type { WorkerOutbound } from './tileWorker'

export interface TileWorkerHandle {
  /** Queue one tile for off-thread unpack+decode. */
  enqueue: (tile: TileFrame) => void
}

export function useTileWorker(
  getPainter: (panel: Panel) => TilePainter | undefined,
): TileWorkerHandle {
  // Stable ref for getPainter so the worker effect doesn't re-spawn.
  const getPainterRef = useRef(getPainter)
  getPainterRef.current = getPainter
  const workerRef = useRef<Worker | null>(null)
  const jobIdRef = useRef(0)

  useEffect(() => {
    // Vite/ESM worker spawn. `type: 'module'` lets the worker `import`
    // from neighbouring modules (e.g. protocol.ts for TILE_PX).
    const w = new Worker(new URL('./tileWorker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = w

    // Send the palette once at startup. The worker holds a copy.
    w.postMessage({
      type: 'init',
      palette: new Uint8ClampedArray(PALETTE_RGBA),
    })

    w.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
      const msg = ev.data
      if (msg.type !== 'bitmap') return
      const painter = getPainterRef.current(msg.panel as Panel)
      if (!painter) {
        // No painter for that panel (yet). Drop the bitmap to free GPU mem.
        msg.bitmap.close()
        return
      }
      painter.paintBitmap(msg.frameSeq, msg.tileId, msg.bitmap)
    }

    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [])

  return useMemo<TileWorkerHandle>(
    () => ({
      enqueue: (tile: TileFrame) => {
        const w = workerRef.current
        if (!w) return
        const jobId = ++jobIdRef.current
        // Detach the payload's underlying buffer for transfer. The
        // Uint8Array we constructed in parseMessage shares the source
        // ArrayBuffer; copy it so this worker owns a transferable buffer.
        // The copy is ~32 KB / chunk — cheap.
        const copy = new Uint8Array(tile.payload).buffer
        w.postMessage(
          {
            type: 'tile',
            jobId,
            panel: tile.panel,
            tileId: tile.tileId,
            frameSeq: tile.frameSeq,
            payload: copy,
          },
          [copy],
        )
      },
    }),
    [],
  )
}
