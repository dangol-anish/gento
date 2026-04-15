const fs = require("fs");
const path = require("path");

function loadStageEventContract() {
  const contractPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "shared",
    "stage-event-contract.json",
  );

  const fallback = {
    event_types: {
      progress: { required_fields: ["stage", "message"] },
      complete: { required_fields: ["stage"] },
      error: { required_fields: ["stage", "error"] },
    },
    response_envelope: { required_fields: ["ok", "data", "error"] },
  };

  try {
    const raw = fs.readFileSync(contractPath, "utf-8");
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

const StageEventContract = Object.freeze(loadStageEventContract());

function hasRequiredFields(obj, requiredFields) {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  return requiredFields.every((field) => Object.prototype.hasOwnProperty.call(obj, field));
}

function isValidResponseEnvelope(payload) {
  const requiredFields = StageEventContract.response_envelope.required_fields;
  if (!hasRequiredFields(payload, requiredFields)) {
    return false;
  }

  if (typeof payload.ok !== "boolean") {
    return false;
  }

  if (payload.ok) {
    return payload.error === null;
  }

  return payload.data === null && payload.error && typeof payload.error === "object";
}

module.exports = {
  StageEventContract,
  isValidResponseEnvelope,
};
