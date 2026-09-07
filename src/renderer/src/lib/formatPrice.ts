// Prices arrive as computed floats and can carry binary-float noise
// (3.9600000000000004, 0.19999999999999998). Display them rounded to at most
// 4 decimal places with trailing zeros stripped.
export function formatPricePer1M(n: number): string {
  const rounded = Number(n.toFixed(4))
  if (rounded === 0 && n > 0) return '<0.0001'
  return String(rounded)
}
