"use client";

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { FiX } from "react-icons/fi";

type ToastVariant = "default" | "success" | "error";

export type ToastInput = {
  title?: string;
  message: string;
  variant?: ToastVariant;
  durationMs?: number;
};

type ToastRecord = ToastInput & {
  id: string;
  variant: ToastVariant;
  durationMs: number;
};

type ToastApi = {
  push: (toast: ToastInput) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

function variantAccent(variant: ToastVariant) {
  if (variant === "success") return "bg-emerald-500/80";
  if (variant === "error") return "bg-rose-500/80";
  return "bg-white/30";
}

function normalizeToast(input: ToastInput): ToastRecord {
  const variant = input.variant ?? "default";
  const durationMs =
    typeof input.durationMs === "number"
      ? input.durationMs
      : variant === "error"
        ? 4500
        : 2600;
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: input.title,
    message: input.message,
    variant,
    durationMs,
  };
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timeouts = useRef<Map<string, number>>(new Map());

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const handle = timeouts.current.get(id);
    if (handle) {
      window.clearTimeout(handle);
      timeouts.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const normalized = normalizeToast(toast);
      setToasts((prev) => [normalized, ...prev].slice(0, 3));
      const timeout = window.setTimeout(() => remove(normalized.id), normalized.durationMs);
      timeouts.current.set(normalized.id, timeout);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title: string, message?: string) =>
        push({ title, message: message ?? "", variant: "success" }),
      error: (title: string, message?: string) =>
        push({ title, message: message ?? "", variant: "error" }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto anim-enter overflow-hidden rounded-2xl border border-border/60 bg-background/80 shadow-lg backdrop-blur-2xl"
          >
            <div className="flex items-start gap-3 p-3">
              <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${variantAccent(toast.variant)}`} />
              <div className="min-w-0 flex-1">
                {toast.title ? (
                  <p className="truncate text-sm font-medium text-foreground">{toast.title}</p>
                ) : null}
                {toast.message ? (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{toast.message}</p>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                className="rounded-lg p-1 text-muted-foreground hover:text-foreground"
                onClick={() => remove(toast.id)}
              >
                <FiX className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  return (
    api ?? {
      push: () => {},
      success: () => {},
      error: () => {},
    }
  );
}

