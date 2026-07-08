// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingPlaceholder } from './SettingPlaceholder'

describe('SettingPlaceholder', () => {
  beforeEach(() => {
    // jsdom does not implement matchMedia; RoarBear reads it for reduced-motion.
    ;(window as unknown as { matchMedia: unknown }).matchMedia = vi
      .fn()
      .mockReturnValue({ matches: false })
  })

  it('renders the title and description', () => {
    render(
      <SettingPlaceholder
        title="Skills"
        description="Manage and install skills — coming in a future update."
      />
    )
    expect(screen.getByText('Skills')).toBeTruthy()
    expect(screen.getByText('Manage and install skills — coming in a future update.')).toBeTruthy()
  })
})
