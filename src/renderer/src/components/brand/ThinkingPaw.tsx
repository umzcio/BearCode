import { useMemo } from 'react'
import './brand.css'

/* 8-bit grizzly paw print on a 26x24 grid, from design/bearcode-animations.html.
   Digits 1-5 are toe pad + claw grouped so each digit pulses as one unit; P is
   the palm. The pulse is opacity-only so the pixels never shimmer. */
const PAW_ROWS = [
  '............3.............',
  '......2.....3......4......',
  '......2............4......',
  '.......2....33....4.......',
  '...........3333...........',
  '.......22..3333..44.......',
  '.1....2222.3333.4444....5.',
  '.1....2222..33..4444....5.',
  '..1...2222......4444...5..',
  '.......22........44.......',
  '..11..................55..',
  '.1111................5555.',
  '.1111................5555.',
  '.1111................5555.',
  '..11..................55..',
  '..........................',
  '......PPPPPPPPPPPPPP......',
  '.....PPPPPPPPPPPPPPPP.....',
  '....PPPPPPPPPPPPPPPPPP....',
  '....PPPPPPPPPPPPPPPPPP....',
  '....PPPPPPPPPPPPPPPPPP....',
  '.....PPPPPPPPPPPPPPPP.....',
  '......PPPPPPPPPPPPPP......',
  '........PPPPPPPPPP........'
]
const PAW_DELAYS: Record<string, number> = {
  '1': 0,
  '2': 0.13,
  '3': 0.26,
  '4': 0.39,
  '5': 0.52,
  P: 0.72
}
const PAW_W = 26
const PAW_H = 24

function buildGroups(): Record<string, { x: number; y: number }[]> {
  const groups: Record<string, { x: number; y: number }[]> = {}
  PAW_ROWS.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]
      if (ch === '.') continue
      ;(groups[ch] = groups[ch] || []).push({ x, y })
    }
  })
  return groups
}

export function ThinkingPaw({ size = 17 }: { size?: number }): React.JSX.Element {
  const groups = useMemo(() => buildGroups(), [])
  return (
    <span className="paw">
      <svg
        width={size}
        height={Math.round((size * PAW_H) / PAW_W)}
        viewBox={`0 0 ${PAW_W} ${PAW_H}`}
      >
        {Object.keys(PAW_DELAYS).map((ch) => (
          <g
            key={ch}
            className="pad"
            style={{ animationDelay: `${PAW_DELAYS[ch]}s` }}
            fill="#e0b568"
          >
            {(groups[ch] || []).map((p) => (
              <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width="1" height="1" />
            ))}
          </g>
        ))}
      </svg>
    </span>
  )
}
