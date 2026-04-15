type RuntimeErrorDetails = { stderr?: string | null; [key: string]: unknown };

export function formatRuntimeError(code: string, message: string, details?: unknown) {
  const payload = details as RuntimeErrorDetails | undefined;

  if (code === "PROCESS_EXIT_NON_ZERO") {
    const stageErrorReason =
      ((payload?.events as Array<{ type?: string; error?: { details?: { reason?: string } } }> | undefined) || [])
        .filter((event) => event.type === "error")
        .map((event) => event.error?.details?.reason)
        .filter(Boolean)
        .at(-1);
    if (stageErrorReason) {
      return `Scrape failed: ${stageErrorReason}`;
    }

    const stderr = payload?.stderr || "";
    if (stderr.includes("No module named 'httpx'")) {
      return "Python dependency missing: httpx. Run `python3 -m pip install -r requirements.txt` and retry.";
    }
    if (stderr.includes("No module named 'PIL'")) {
      return "Python dependency missing: pillow. Run `python3 -m pip install -r requirements.txt` and retry.";
    }
    if (stderr.includes("No module named")) {
      return `Python dependency missing. Run \`python3 -m pip install -r requirements.txt\` and retry.\n${stderr
        .split("\n")
        .slice(-2)
        .join(" ")}`.trim();
    }
  }

  return `[${code}] ${message}`;
}

