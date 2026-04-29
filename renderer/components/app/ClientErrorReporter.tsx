"use client";

import { useEffect } from "react";

function safeSerialize(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function ClientErrorReporter() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const report = (error: unknown, context: Record<string, unknown>) => {
      if (!window.gento?.reportError) {
        return;
      }
      void window.gento.reportError(safeSerialize(error), {
        ...context,
        href: window.location.href,
        userAgent: navigator.userAgent,
      });
    };

    const onError = (event: ErrorEvent) => {
      report(
        {
          name: event.error?.name ?? "Error",
          message: event.message,
          stack: event.error?.stack,
        },
        {
          kind: "window.error",
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      );
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      report(
        reason instanceof Error
          ? { name: reason.name, message: reason.message, stack: reason.stack }
          : reason,
        { kind: "window.unhandledrejection" },
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}

