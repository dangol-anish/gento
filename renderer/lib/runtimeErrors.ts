type RuntimeErrorDetails = { stderr?: string | null; [key: string]: unknown };

export function formatRuntimeError(code: string, message: string, details?: unknown) {
  const payload = details as RuntimeErrorDetails | undefined;

  const stderr = (payload?.stderr || "").trim();

  if (code === "PROCESS_EXIT_NON_ZERO") {
    const lastStageError = (
      (payload?.events as Array<{ type?: string; error?: { message?: string; details?: { reason?: string } } }> | undefined) ||
      []
    )
      .filter((event) => event.type === "error" && event.error)
      .at(-1)?.error;

    const stageMessage = typeof lastStageError?.message === "string" ? lastStageError.message.trim() : "";
    const stageReason = typeof lastStageError?.details?.reason === "string" ? lastStageError.details.reason.trim() : "";
    if (stageMessage || stageReason) {
      if (stageMessage && stageReason && !stageMessage.includes(stageReason)) {
        const normalizedMessage = stageMessage.replace(/[.:;]+$/, "").trim();
        return `${normalizedMessage}: ${stageReason}`;
      }
      return stageMessage || stageReason;
    }

    if (stderr.includes("No module named 'httpx'")) {
      return "Python dependency missing: httpx. Run `python3 -m pip install -r requirements.txt` and retry.";
    }
    if (stderr.includes("No module named 'PIL'")) {
      return "Python dependency missing: pillow. Run `python3 -m pip install -r requirements.txt` and retry.";
    }
    if (stderr.includes("No module named 'transformers'")) {
      return "Python dependency missing: transformers. Run `python3 -m pip install -r requirements.txt` and retry.";
    }
    if (stderr.includes("No module named 'torch'")) {
      return "Python dependency missing: torch. Run `python3 -m pip install -r requirements.txt` and retry.";
    }
    if (stderr.includes("No module named")) {
      return `Python dependency missing. Run \`python3 -m pip install -r requirements.txt\` and retry.\n${stderr
        .split("\n")
        .slice(-2)
        .join(" ")}`.trim();
    }

    if (stderr) {
      const tail = stderr
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-8)
        .join("\n");
      return tail;
    }
  }

  if (code === "PROCESS_SPAWN_FAILED") {
    const spawnMessage = typeof payload?.message === "string" ? payload.message.trim() : "";
    const combined = spawnMessage || stderr;

    if (combined) {
      const looksLikeMissingPython =
        /ENOENT/i.test(combined) ||
        /The system cannot find the file specified/i.test(combined) ||
        /not recognized as an internal or external command/i.test(combined);

      if (looksLikeMissingPython) {
        return `Python was not found. Install Python 3.11 or 3.12 (64-bit), then restart Gento.\n${combined}`;
      }

      return combined;
    }
  }

  return `[${code}] ${message}`;
}
