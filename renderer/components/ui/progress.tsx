import * as React from "react";

import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
}

function Progress({ className, value = 0, ...props }: ProgressProps) {
  return (
    <div className={cn("relative h-2.5 w-full overflow-hidden rounded-full border border-white/60 bg-white/50 backdrop-blur-xl", className)} {...props}>
      <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export { Progress };
