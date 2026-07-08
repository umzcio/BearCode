// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import {
  IconGear,
  IconShield,
  IconPalette,
  IconPlug,
  IconGrid,
  IconScroll,
  IconBlocks,
  IconBrain,
  IconLink,
  IconGlobe,
  IconKeyboard,
  IconChat
} from './icons'

afterEach(cleanup)

const NAV_ICONS = {
  IconGear,
  IconShield,
  IconPalette,
  IconPlug,
  IconGrid,
  IconScroll,
  IconBlocks,
  IconBrain,
  IconLink,
  IconGlobe,
  IconKeyboard,
  IconChat
}

describe('settings nav icons', () => {
  for (const [name, Icon] of Object.entries(NAV_ICONS)) {
    it(`${name} renders an svg`, () => {
      const { container } = render(<Icon />)
      expect(container.querySelector('svg')).toBeTruthy()
    })
  }
})
