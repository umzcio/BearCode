export type CubicBezier = readonly [number, number, number, number]

export function readCssTimeMs(
  name: `--${string}`,
  root: Element = document.documentElement
): number | null {
  const value = getComputedStyle(root).getPropertyValue(name).trim()
  const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/.exec(value)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return null
  return match[2] === 's' ? amount * 1000 : amount
}

export function readCssCubicBezier(
  name: `--${string}`,
  root: Element = document.documentElement
): CubicBezier | null {
  const value = getComputedStyle(root).getPropertyValue(name).trim()
  const match = /^cubic-bezier\((.*)\)$/.exec(value)
  if (!match) return null
  const parts = match[1].split(',').map((part) => part.trim())
  if (parts.length !== 4 || parts.some((part) => part === '')) return null
  const values = parts.map(Number)
  if (values.length !== 4 || values.some((part) => !Number.isFinite(part))) return null
  if (values[0] < 0 || values[0] > 1 || values[2] < 0 || values[2] > 1) return null
  return values as unknown as CubicBezier
}

function sampleCurve(t: number, first: number, second: number): number {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t
}

function sampleSlope(t: number, first: number, second: number): number {
  return (
    3 * (1 - t) * (1 - t) * first + 6 * (1 - t) * t * (second - first) + 3 * t * t * (1 - second)
  )
}

export function evaluateCubicBezier(curve: CubicBezier, progress: number): number {
  const x = Math.min(1, Math.max(0, progress))
  if (x === 0 || x === 1) return x
  const [x1, y1, x2, y2] = curve

  let parameter = x
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const error = sampleCurve(parameter, x1, x2) - x
    if (Math.abs(error) < 1e-7) return sampleCurve(parameter, y1, y2)
    const slope = sampleSlope(parameter, x1, x2)
    if (Math.abs(slope) < 1e-7) break
    parameter -= error / slope
  }

  let low = 0
  let high = 1
  parameter = x
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const sampled = sampleCurve(parameter, x1, x2)
    if (Math.abs(sampled - x) < 1e-7) break
    if (sampled < x) low = parameter
    else high = parameter
    parameter = (low + high) / 2
  }
  return sampleCurve(parameter, y1, y2)
}
