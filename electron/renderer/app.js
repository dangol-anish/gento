const statusNode = document.getElementById("status");
const runButton = document.getElementById("run-test-stage");
const statusChip = document.getElementById("status-chip");

function setStatusChip(state, label) {
  statusChip.classList.remove("status-idle", "status-running", "status-success", "status-error");
  statusChip.classList.add(state);
  statusChip.textContent = label;
}

async function runStageStub() {
  statusNode.textContent = "Running stage stub...";
  runButton.disabled = true;
  setStatusChip("status-running", "Running");

  try {
    const result = await window.gento.runStage(0, ["--example", "value"]);
    if (!result.ok) {
      statusNode.textContent = `[${result.error.code}] ${result.error.message}`;
      setStatusChip("status-error", "Error");
      return;
    }

    statusNode.textContent = `Stage ${result.data.stage}: ${result.data.message}`;
    setStatusChip("status-success", "Success");
  } catch (error) {
    statusNode.textContent = `Unexpected failure: ${error.message}`;
    setStatusChip("status-error", "Error");
  } finally {
    runButton.disabled = false;
  }
}

function registerStageEvents() {
  window.gento.onStageEvent((payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.type === "progress") {
      statusNode.textContent = payload.message || `Running stage ${payload.stage}`;
      setStatusChip("status-running", "Running");
      return;
    }

    if (payload.type === "complete") {
      statusNode.textContent = payload.message || `Stage ${payload.stage} complete.`;
      setStatusChip("status-success", "Success");
      return;
    }

    if (payload.type === "error") {
      statusNode.textContent = `[Error] ${payload.message}`;
      setStatusChip("status-error", "Error");
      return;
    }

    if (payload.type === "log") {
      statusNode.textContent = payload.message;
    }
  });
}

runButton.addEventListener("click", () => {
  runStageStub();
});
