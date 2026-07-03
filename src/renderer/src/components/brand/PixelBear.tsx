import { useEffect, useState } from 'react'
import './brand.css'

/* 8-bit walking grizzly on a 26x13 grid, from design/bearcode-animations.html.
   Legend: . empty · B body · D feet/shade · L muzzle · K black.
   Silhouette cues: shoulder hump above head height, small ear, short downward
   muzzle, stocky legs. Two-frame walk at 220ms with a sub-pixel bob; blinks
   every 3 to 5s. */
const BEAR_COLORS: Record<string, string> = {
  B: '#8b5e3c',
  D: '#6b4326',
  L: '#c9a179',
  K: '#241b14'
}
const BEAR_BODY = [
  '......BBBBBB......BB......',
  '....BBBBBBBBBB...BBBBBBB..',
  '...BBBBBBBBBBBBBBBBBBBBBB.',
  '..BBBBBBBBBBBBBBBBBBBBKBB.',
  '..BBBBBBBBBBBBBBBBBBBBBLLK',
  '.BBBBBBBBBBBBBBBBBBBBBLL..',
  '.BBBBBBBBBBBBBBBBBBBBBB...',
  '.BBBBBBBBBBBBBBBBBBBB.....',
  '.BBBBBBBBBBBBBBBBBBB......',
  '..BBBBBBBBBBBBBBBBB.......'
]
const BEAR_FRAMES = [
  BEAR_BODY.concat([
    '...BBBB.......BBBB........',
    '...BBBB.......BBBB........',
    '...DDDDD......DDDDD.......'
  ]),
  BEAR_BODY.concat([
    '..BBBB.........BBBB.......',
    '..BBBB.........BBBB.......',
    '..DDDDD........DDDDD......'
  ])
]
const BEAR_W = 26
const BEAR_H = 13
const BEAR_EYE = { x: 22, y: 3 }

function frameRects(frame: string[], blink: boolean): React.JSX.Element[] {
  const rects: React.JSX.Element[] = []
  frame.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      let ch = row[x]
      if (ch === '.') continue
      if (blink && x === BEAR_EYE.x && y === BEAR_EYE.y) ch = 'B'
      rects.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={BEAR_COLORS[ch]} />)
    }
  })
  return rects
}

export function PixelBear({ scale = 5 }: { scale?: number }): React.JSX.Element {
  const [frame, setFrame] = useState(0)
  const [blink, setBlink] = useState(false)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
    const walk = setInterval(() => setFrame((f) => 1 - f), 220)
    let blinkOff: ReturnType<typeof setTimeout> | undefined
    const blinker = setInterval(
      () => {
        setBlink(true)
        blinkOff = setTimeout(() => setBlink(false), 160)
      },
      3200 + Math.random() * 1500
    )
    return () => {
      clearInterval(walk)
      clearInterval(blinker)
      if (blinkOff) clearTimeout(blinkOff)
    }
  }, [])

  return (
    <span className="pixel-bear">
      <svg width={BEAR_W * scale} height={BEAR_H * scale} viewBox={`0 0 ${BEAR_W} ${BEAR_H}`}>
        <g transform={frame === 1 ? 'translate(0 -0.5)' : undefined}>
          {frameRects(BEAR_FRAMES[frame], blink)}
        </g>
      </svg>
    </span>
  )
}
