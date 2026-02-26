// ---------------------------------------------------------------------------
// AL Profile Analyzer — Web UI
// ---------------------------------------------------------------------------

/**
 * Switch between views: dropzone, loading, results, error.
 * Hides all views and shows only the specified one.
 * Also toggles the "New Analysis" button visibility.
 */
function showView(viewId) {
  const views = ["dropzone", "loading", "results", "error"];
  for (const id of views) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle("hidden", id !== viewId);
    }
  }

  const newAnalysisBtn = document.getElementById("new-analysis");
  if (newAnalysisBtn) {
    newAnalysisBtn.classList.toggle("hidden", viewId !== "results");
  }
}

/**
 * Format microsecond timings into human-readable strings.
 */
function formatTime(us) {
  const abs = Math.abs(us);
  if (abs >= 1_000_000) return (us / 1_000_000).toFixed(1) + "s";
  if (abs >= 1_000) return (us / 1_000).toFixed(1) + "ms";
  return Math.round(us) + "\u00B5s";
}

/**
 * Render analysis results into the results container.
 * Stub implementation — later tasks will replace this with proper rendering.
 */
function renderResults(data) {
  const results = document.getElementById("results");
  if (results) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(data, null, 2);
    results.innerHTML = "";
    results.appendChild(pre);
  }
}

/**
 * Handle dropped or selected files: validate, build FormData, upload.
 */
async function handleFiles(files) {
  let profileFile = null;
  let sourceFile = null;

  for (const file of files) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".alcpuprofile")) {
      profileFile = file;
    } else if (name.endsWith(".zip")) {
      sourceFile = file;
    }
  }

  if (!profileFile) {
    document.getElementById("error-message").textContent =
      "No .alcpuprofile file found in dropped files";
    showView("error");
    return;
  }

  const formData = new FormData();
  formData.append("profile", profileFile);
  if (sourceFile) {
    formData.append("source", sourceFile);
  }

  // Show loading state
  showView("loading");

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      let message = "Analysis failed";
      try {
        const errorData = await response.json();
        if (errorData.error) {
          message = errorData.error;
        }
      } catch {
        // Could not parse error JSON — use generic message
      }
      document.getElementById("error-message").textContent = message;
      showView("error");
      return;
    }

    const data = await response.json();
    renderResults(data);
    showView("results");
  } catch (err) {
    document.getElementById("error-message").textContent =
      err.message || "Network error — could not reach the server";
    showView("error");
  }
}

// ---------------------------------------------------------------------------
// Event handlers — set up on DOMContentLoaded
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const newAnalysisBtn = document.getElementById("new-analysis");
  const tryAgainBtn = document.getElementById("try-again");

  // --- Drag-and-drop ---
  dropzone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", (e) => {
    if (!dropzone.contains(e.relatedTarget)) {
      dropzone.classList.remove("dragover");
    }
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFiles(files);
    }
  });

  // --- Click to browse ---
  dropzone.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      handleFiles(fileInput.files);
    }
    // Reset so the same file can be re-selected
    fileInput.value = "";
  });

  // --- Reset buttons ---
  newAnalysisBtn.addEventListener("click", () => {
    showView("dropzone");
  });

  tryAgainBtn.addEventListener("click", () => {
    showView("dropzone");
  });
});
