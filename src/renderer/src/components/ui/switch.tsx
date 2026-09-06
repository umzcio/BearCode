import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@renderer/lib/utils'

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5'
        )}
        style={{ background: 'var(--accent-fg)' }}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
