/* eslint-disable react-refresh/only-export-components -- badgeVariants is the
   canonical shadcn export for applying badge styling to other elements. */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@renderer/lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors [&_svg]:pointer-events-none [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        destructive: 'bg-destructive text-destructive-foreground',
        outline: 'border-border text-foreground'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>): React.JSX.Element {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
