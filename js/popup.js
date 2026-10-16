"use strict";

const statusEl = document.getElementById("sync-status");
const errorEl = document.getElementById("error-message");
const btnSync = document.getElementById("btn-sync");
const btnOptions = document.getElementById("btn-open-options");
const btnLibraries = document.getElementById("btn-libraries");

function showError(msg) {
  errorEl.style.display = "block";
  errorEl.textContent = msg;
}

function hideError() {
  errorEl.style.display = "none";
  errorEl.textContent = "";
}

async function refreshStatus() {
  hideError();
  statusEl.textContent = "Checking...";
  try {
    const config = await browser.runtime.sendMessage({ type: "check-config" });
    if (!config.server || !config.token) {
      statusEl.textContent = "Not configured. Open Settings to login.";
      return;
    }
    const st = await browser.runtime.sendMessage({ type: "get-sync-status" });
    const when = st.lastSync ? new Date(st.lastSync).toLocaleString() : "never";
    statusEl.textContent = `Last sync: ${when} (${st.blocked} locally hidden, every ${st.intervalMin} min)`;
    if (st.lastSyncError) showError(`Last sync failed: ${st.lastSyncError}`);
  } catch (e) {
    showError(e.message || String(e));
    statusEl.textContent = "Status unavailable";
  }
}

btnSync.addEventListener("click", async () => {
  hideError();
  btnSync.textContent = "Syncing...";
  try {
    const r = await browser.runtime.sendMessage({ type: "sync-now" });
    if (r && r.skipped) statusEl.textContent = "Sync already running...";
    await refreshStatus();
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    btnSync.textContent = "Sync Now";
  }
});

btnOptions.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

btnLibraries.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "open-libraries" }).finally(() => window.close());
});

document.addEventListener("DOMContentLoaded", refreshStatus);
