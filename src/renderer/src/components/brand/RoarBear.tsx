import { useEffect, useState } from 'react'
import './brand.css'

/* Front-facing 8-bit grizzly head on a 22x16 grid, from
   design/bearcode-animations.html. Anti-teddy rules: small eyes under a heavy
   dark brow, wide flat nose, full-width cheeks. The thinking animation is the
   mouth: closed, cracked, full roar with teeth, on a slow chomp rhythm. Blinks
   only while the mouth is closed. Medium+ sizes only, never the 17px header. */
const ROAR_COLORS: Record<string, string> = {
  B: '#8b5e3c',
  D: '#5d3a22',
  L: '#c9a179',
  K: '#241b14',
  W: '#e8dfd0'
}
const ROAR_TOP = [
  '...BBBB.......BBBB....',
  '..BBBBB........BBBBB..',
  '..BBDDBBBBBBBBBBDDBB..',
  '.BBBBBBBBBBBBBBBBBBBB.',
  '.BBBDDDBBBBBBBDDDBBBB.',
  '.BBBBKBBBBBBBBBBKBBBB.',
  '.BBBBBBBBLLLLBBBBBBBB.',
  'BBBBBBBLLLLLLLLBBBBBBB',
  'BBBBBBLLLKKKKLLLBBBBBB',
  'BBBBBBLLLLKKLLLLBBBBBB'
]
const ROAR_MOUTHS: Record<string, string[]> = {
  closed: [
    '.BBBBBLLLLKKLLLLBBBBB.',
    '.BBBBBLLLLLLLLLLBBBBB.',
    '..BBBBBLLLLLLLLBBBBB..',
    '...BBBBBBBBBBBBBBBB...',
    '....BBBBBBBBBBBBBB....',
    '.....BBBBBBBBBBBB.....'
  ],
  mid: [
    '.BBBBBLLLKKKKLLLBBBBB.',
    '.BBBBBLLKKKKKKLLBBBBB.',
    '..BBBBBLLLLLLLLBBBBB..',
    '...BBBBBBBBBBBBBBBB...',
    '....BBBBBBBBBBBBBB....',
    '.....BBBBBBBBBBBB.....'
  ],
  wide: [
    '.BBBBBLKWKKKKWKLBBBBB.',
    '.BBBBLKKKKKKKKKKLBBBB.',
    '.BBBBBLKWKKKKWKLBBBBB.',
    '..BBBBBLLKKKKLLBBBBB..',
    '...BBBBBBLLLLBBBBBB...',
    '....BBBBBBBBBBBBBB....'
  ]
}
const ROAR_W = 22
const ROAR_H = 16
const ROAR_EYES = [
  { x: 5, y: 5 },
  { x: 16, y: 5 }
]

/* chomp rhythm: closed → mid → wide → mid, with holds */
const SEQ: [string, number][] = [
  ['closed', 900],
  ['mid', 160],
  ['wide', 620],
  ['mid', 160]
]

function roarRects(mouth: string, blink: boolean): React.JSX.Element[] {
  const rows = ROAR_TOP.concat(ROAR_MOUTHS[mouth])
  const rects: React.JSX.Element[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      let ch = row[x]
      if (ch === '.') continue
      if (blink && ROAR_EYES.some((e) => e.x === x && e.y === y)) ch = 'B'
      rects.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={ROAR_COLORS[ch]} />)
    }
  })
  return rects
}

export function RoarBear({ scale = 4 }: { scale?: number }): React.JSX.Element {
  const [mouth, setMouth] = useState('closed')
  const [blink, setBlink] = useState(false)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
    let i = 0
    let currentMouth = 'closed'
    let roarTimer: ReturnType<typeof setTimeout>
    function step(): void {
      currentMouth = SEQ[i][0]
      setMouth(currentMouth)
      roarTimer = setTimeout(() => {
        i = (i + 1) % SEQ.length
        step()
      }, SEQ[i][1])
    }
    step()

    let blinkOff: ReturnType<typeof setTimeout> | undefined
    const blinker = setInterval(
      () => {
        if (currentMouth !== 'closed') return
        setBlink(true)
        blinkOff = setTimeout(() => setBlink(false), 150)
      },
      2800 + Math.random() * 1600
    )

    return () => {
      clearTimeout(roarTimer)
      clearInterval(blinker)
      if (blinkOff) clearTimeout(blinkOff)
    }
  }, [])

  return (
    <span className="roar-bear">
      <svg width={ROAR_W * scale} height={ROAR_H * scale} viewBox={`0 0 ${ROAR_W} ${ROAR_H}`}>
        {roarRects(mouth, blink)}
      </svg>
    </span>
  )
}
