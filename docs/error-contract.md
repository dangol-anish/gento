# Error Contract

This document defines the canonical error and response contract for all runtime boundaries in Gento:

- Electron main process IPC handlers
- Electron preload bridge
- Renderer calls to backend APIs
- Python stage scripts emitting JSON events

Keeping this contract strict prevents ambiguous failures and ad-hoc error handling.

## 1) Standard IPC Response Envelope

All `ipcMain.handle(...)` endpoints must return this shape:

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

or

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Human-readable message",
    "details": {
      "optional": "context"
    }
  }
}
```

Rules:

1. `ok` is required and always boolean.
2. If `ok` is `true`, `error` must be `null`.
3. If `ok` is `false`, `data` must be `null` and `error` must be present.
4. `message` should be user-safe; avoid stack traces in user-visible text.
5. `details` may include structured diagnostics for logs and debugging.

## 2) Python Stage Event Envelope

Python stages communicate to Electron using line-delimited JSON events on stdout.

Error event shape:

```json
{
  "type": "error",
  "stage": 0,
  "error": {
    "code": "STAGE_EXECUTION_FAILED",
    "message": "Failed to parse chapter page",
    "details": {
      "url": "https://..."
    }
  }
}
```

Rules:

1. `type` must be one of: `progress`, `complete`, `error`.
2. `stage` must always be included.
3. Error payload must always include `code` and `message`.
4. Non-JSON logs should go to stderr, not stdout.

## 3) Canonical Error Codes

Error codes are defined in:

- `shared/error-codes.json`

Current code set:

- `INVALID_REQUEST`: malformed payload, missing required input, invalid argument type.
- `INVALID_STAGE`: stage value is out of accepted range or format.
- `STAGE_EXECUTION_FAILED`: stage logic failed after validation.
- `PROCESS_SPAWN_FAILED`: process creation failed (executable missing, permission error, etc.).
- `PROCESS_EXIT_NON_ZERO`: child process exited with non-zero code.
- `INTERNAL_ERROR`: unexpected exception or unclassified failure.

Never hardcode new codes in random files. Add new codes only in `shared/error-codes.json` first.

## 4) Code Selection Guidelines

Use `INVALID_REQUEST` when:

- A payload is missing required fields.
- A parameter type is wrong.
- A string input is empty where non-empty is required.

Use `INVALID_STAGE` when:

- Stage value is negative.
- Stage value is not an integer.
- Stage number is not implemented/supported.

Use `STAGE_EXECUTION_FAILED` when:

- Stage started correctly but business logic fails.
- Recoverable stage-level operational errors occur.

Use process-level errors when subprocess orchestration is implemented:

- `PROCESS_SPAWN_FAILED`: failure before process starts.
- `PROCESS_EXIT_NON_ZERO`: process started but terminated unsuccessfully.

Use `INTERNAL_ERROR` only as fallback for unexpected exceptions.

## 5) Message and Details Standards

Message standards:

- Short and clear.
- Explain what failed, not implementation internals.
- Stable wording where practical for predictable UI behavior.

Details standards:

- Use JSON-safe values only.
- Include actionable context (`stage`, `path`, `argName`, `receivedType`, `exitCode`).
- Do not include secrets (API keys, full tokens, credentials).

## 6) Example Mapping

Input validation failure:

- Code: `INVALID_REQUEST`
- Message: `args must be an array.`
- Details: `{ "receivedArgsType": "string" }`

Stage crash:

- Code: `STAGE_EXECUTION_FAILED`
- Message: `Stage execution failed.`
- Details: nested internal error summary

Unexpected exception:

- Code: `INTERNAL_ERROR`
- Message: exception message sanitized for user display

## 7) Evolution Rules

When adding new runtime modules:

1. Use shared helpers (`createSuccess`, `createError`, Python `AppError`).
2. Reuse existing codes whenever possible.
3. Add tests around failure paths once test harness is added.
4. Update this document if any contract field or code semantics change.
