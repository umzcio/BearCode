import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@renderer/lib/utils'

function TooltipProvider({
  delayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>): React.JSX.Element {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>): React.JSX.Element {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-fit max-w-xs origin-[var(--radix-tooltip-content-transform-origin)] rounded-md px-2.5 py-1.5 text-xs text-balance shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className
        )}
        style={{
          background: 'var(--tooltip-bg)',
          color: 'var(--tooltip-fg)',
          boxShadow: '0 0 0 1px var(--tooltip-border), var(--shadow-raised)',
          ...props.style
        }}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px]"
          style={{ fill: 'var(--tooltip-bg)' }}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
