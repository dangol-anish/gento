const statusNode = document.getElementById("status");
const runButton = document.getElementById("run-test-stage");

async function runStageStub() {
  statusNode.textContent = "Running stage stub...";
  runButton.disabled = true;

  try {
    const result = await window.gento.runStage(0, ["--example", "value"]);
    if (!result.ok) {
      statusNode.textContent = `[${result.error.code}] ${result.error.message}`;
      return;
    }

    statusNode.textContent = `Stage ${result.data.stage}: ${result.data.message}`;
  } catch (error) {
    statusNode.textContent = `Unexpected failure: ${error.message}`;
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => {
  runStageStub();
});
