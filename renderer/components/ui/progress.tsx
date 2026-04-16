import * as React from "react";

import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
}

function Progress({ className, value = 0, ...props }: ProgressProps) {
  const sanitizedValue = Math.max(0, Math.min(100, value));

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={sanitizedValue}
      className={cn("progress-track", className)}
      {...props}
    >
      <div
        className="progress-fill"
        style={{ width: `${sanitizedValue}%` }}
      />
      <div className="progress-label">{sanitizedValue}%</div>
    </div>
  );
}

export { Progress };
