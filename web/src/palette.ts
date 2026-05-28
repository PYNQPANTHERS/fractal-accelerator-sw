/**
 * 16-entry palette for 4-bit fractal indices.
 *
 * Index 0 is the in-set colour (points that never escaped) — kept deep
 * and dark so the silhouette reads against the UI chrome. Indices 1..15
 * walk from cool indigo through teal to a warm cream highlight, which
 * gives the boundary a "molten" feel that pairs with the amber accent.
 */

const STOPS: Array<[number, number, number]> = [
  [0x05, 0x07, 0x12], // 0  in-set, near-black navy
  [0x0c, 0x14, 0x2e],
  [0x18, 0x28, 0x52],
  [0x1f, 0x3d, 0x74],
  [0x21, 0x57, 0x88],
  [0x24, 0x73, 0x92],
  [0x2e, 0x8e, 0x95],
  [0x4a, 0xa6, 0x93],
  [0x73, 0xb8, 0x8a],
  [0xa1, 0xc6, 0x7e],
  [0xcd, 0xc9, 0x73],
  [0xe6, 0xb9, 0x65],
  [0xee, 0xa1, 0x52],
  [0xf2, 0x86, 0x44],
  [0xf2, 0xd5, 0xa0],
  [0xfa, 0xee, 0xd6], // 15 outermost highlight
]

/** Flat RGBA bytes for indices 0..15. */
export const PALETTE_RGBA: Uint8ClampedArray = (() => {
  const out = new Uint8ClampedArray(16 * 4)
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = STOPS[i]
    out[i * 4 + 0] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 0xff
  }
  return out
})()
