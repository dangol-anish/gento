import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-lg border px-3 py-1 text-xs font-medium transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-white/60 bg-white/70 text-foreground backdrop-blur-2xl",
        success: "border-emerald-200 bg-emerald-50/90 text-emerald-800",
        warning: "border-amber-200 bg-amber-50/90 text-amber-800",
        danger: "border-rose-200 bg-rose-50/90 text-rose-800",
        muted: "border-zinc-300 bg-zinc-100/80 text-zinc-700 backdrop-blur-2xl",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
