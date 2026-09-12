(function () {
  "use strict";
  const api = window.mediaToolboxAgent;
  const el = (id) => document.getElementById(id);
  let currentState;
  let licenseRequestConfig = null;
  let licenseRequest = null;
  let licenseRequestPollTimer = null;
  let licenseRequestPollBusy = false;
  let selectedLicenseDurationMs = 600000;
  let licenseServerState = {};

  function showNotice(message) {
    const notice = el("notice");
    notice.textContent = message || "";
    notice.classList.toggle("hidden", !message);
  }

  function formatRemaining(value) {
    if (value === null || value === undefined) return "—";
    const seconds = Math.max(0, Math.ceil(Number(value) / 1000));
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  function render(state) {
    currentState = state || {};
    const authorization = state.authorization || {};
    const mode = authorization.mode || "locked";
    const labels = { admin: "Admin access", activation: "Activated license", trial: "Trial active", locked: "Locked" };
    const pill = el("connection-pill");
    pill.textContent = state.running ? "Agent running" : "Agent stopped";
    pill.classList.toggle("ready", Boolean(state.running));
    el("authorization-title").textContent = labels[mode] || "Locked";
    el("authorization-message").textContent = !authorization.legalAccepted ? "Accept the Privacy Policy and Terms & Conditions below before starting processing or logging in." : mode === "locked" ? (authorization.trialAvailable ? "A five-minute trial is available and starts on the first local processing session." : "Admin login or a valid activation code is required for processing.") : mode === "trial" ? "Your one-time trial is active on this installation." : mode === "activation" ? "This installation is authorized by a signed license." : "Unlimited local processing is unlocked until logout.";
    el("countdown").textContent = mode === "admin" ? "Unlimited" : formatRemaining(authorization.remainingMs);
    const badge = el("mode-badge"); badge.textContent = labels[mode] || "Locked"; badge.className = `badge ${mode}`;
    const legalAccepted = Boolean(authorization.legalAccepted);
    el("legal-consent").classList.toggle("hidden", legalAccepted);
    if (legalAccepted) el("legal-consent-checkbox").checked = false;
    el("accept-legal-button").disabled = legalAccepted || !el("legal-consent-checkbox").checked;
    document.querySelectorAll("#login-form input, #login-form button, #activation-form textarea, #activation-form button, #license-request-form input, #license-request-form button").forEach((control) => { control.disabled = !legalAccepted; });
    el("admin-access").classList.toggle("hidden", mode === "admin");
    el("logout-access").classList.toggle("hidden", mode !== "admin");
    const trialButton = el("start-trial-button");
    const trialVisible = mode === "locked" && Boolean(authorization.trialAvailable);
    trialButton.classList.toggle("hidden", !trialVisible);
    trialButton.disabled = !legalAccepted || !trialVisible;
    trialButton.title = legalAccepted ? "Start the one-time five-minute trial on this installation." : "Accept the Privacy Policy and Terms & Conditions first.";
    trialButton.textContent = legalAccepted ? "Start 5-minute trial" : "Accept terms to start trial";
    el("admin-control-button").textContent = mode === "admin" ? "Admin access" : "Admin login";
    el("admin-control-button").classList.toggle("active", mode === "admin");
    el("device-id").textContent = authorization.deviceId || "—";
    el("trusted-origins").textContent = authorization.trustedOrigins?.length ? authorization.trustedOrigins.join(", ") : "None";
    el("agent-version").textContent = state.agentVersion || "—";
    el("protocol").textContent = `${state.protocol || "http"} · v${state.protocolVersion || "1"}`;
    renderLicenseRequest();
    renderLicenseOwnerPanel(state);
    renderSessions(state.sessions || []);
    renderCapabilities(state.capabilities || {});
    renderLicenseServer(licenseServerState);
  }

  function renderLicenseServer(value = {}) {
    licenseServerState = value || {};
    const badge = el("license-server-badge");
    const message = el("license-server-message");
    const startButton = el("start-license-server");
    const stopButton = el("stop-license-server");
    if (!badge || !message || !startButton || !stopButton) return;
    const healthy = Boolean(value.healthy);
    const mounted = Boolean(value.ssdMounted);
    badge.textContent = healthy ? "Running" : mounted ? "Stopped" : "SSD not mounted";
    badge.className = `badge ${healthy ? "ready" : "error"}`;
    message.textContent = healthy
      ? `The licensing service is reachable at ${value.url || "http://127.0.0.1:4900"}. Tailscale Funnel can forward to it using its saved configuration.`
      : value.error || (mounted ? "The licensing service is not running. Click Start licensing server after the SSD is mounted." : "Connect the Sandisk Exf licensing SSD, then click Start licensing server.");
    el("license-server-url").textContent = value.url || "http://127.0.0.1:4900";
    el("license-server-storage").textContent = value.dataDir || "/Volumes/Sandisk Exf/MediaToolboxLicensing";
    el("license-server-public-url").textContent = value.publicUrl || "Configured by Tailscale Funnel";
    startButton.disabled = healthy || !mounted || value.available === false;
    startButton.textContent = healthy ? "Licensing server running" : "Start licensing server";
    stopButton.classList.toggle("hidden", !value.managed);
    stopButton.disabled = !value.managed;
  }

  async function refreshLicenseServer() {
    if (!api.getLicenseServerState) return;
    try {
      renderLicenseServer(await api.getLicenseServerState());
    } catch (error) {
      renderLicenseServer({ healthy: false, ssdMounted: false, error: error.message || "The licensing server status could not be checked." });
    }
  }

  function persistLicenseRequest() {
    try {
      if (licenseRequest) localStorage.setItem("media-toolbox-agent-license-request", JSON.stringify(licenseRequest));
      else localStorage.removeItem("media-toolbox-agent-license-request");
    } catch { /* dashboard storage may be unavailable */ }
  }

  function setLicenseRequest(value) {
    licenseRequest = value;
    persistLicenseRequest();
    renderLicenseRequest();
  }

  function renderLicenseRequest() {
    const block = el("license-request-block");
    const status = el("license-request-status");
    const button = el("request-activation-button");
    const originInput = el("license-origin");
    if (!block || !status || !button || !originInput) return;
    const mode = currentState?.authorization?.mode || "locked";
    const legalAccepted = Boolean(currentState?.authorization?.legalAccepted);
    const available = Boolean(licenseRequestConfig?.available);
    block.classList.toggle("hidden", mode !== "locked");
    if (!originInput.value && licenseRequestConfig?.suggestedOrigins?.length) originInput.value = licenseRequestConfig.suggestedOrigins[0];
    if (mode !== "locked") return;
    if (!available) {
      button.disabled = true;
      status.className = "license-request-status";
      status.textContent = "Online license requests are not configured in this agent release.";
      return;
    }
    if (!legalAccepted) {
      button.disabled = true;
      status.className = "license-request-status";
      status.textContent = "Accept the Privacy Policy and Terms & Conditions above before requesting a code.";
      return;
    }
    if (!licenseRequest) {
      button.disabled = false;
      button.textContent = "Request activation code";
      status.className = "license-request-status hidden";
      status.textContent = "";
      return;
    }
    if (licenseRequest.status === "pending") {
      button.disabled = true;
      button.textContent = "Request pending";
      status.className = "license-request-status";
      status.textContent = `Waiting for owner approval for ${licenseRequest.origin || originInput.value}…`;
      return;
    }
    if (licenseRequest.status === "approved" && licenseRequest.code) {
      button.disabled = true;
      button.textContent = "Request approved";
      status.className = "license-request-status approved";
      status.innerHTML = `<strong>Approved.</strong> The owner issued a one-time code for <code>${escapeHtml(licenseRequest.origin || originInput.value)}</code>.<div class="license-request-code"><code>${escapeHtml(licenseRequest.code)}</code><button class="button secondary" id="copy-request-code" type="button">Copy code</button><button class="button primary" id="activate-request-code" type="button">Activate now</button></div>`;
      el("copy-request-code").addEventListener("click", copyRequestedCode);
      el("activate-request-code").addEventListener("click", activateRequestedCode);
      return;
    }
    if (licenseRequest.status === "declined" || licenseRequest.status === "expired") {
      button.disabled = false;
      button.textContent = "Request activation code";
      status.className = "license-request-status";
      status.textContent = `This request was ${licenseRequest.status}. You can submit a new request.`;
      return;
    }
    button.disabled = false;
    button.textContent = "Request activation code";
    status.className = "license-request-status";
    status.textContent = "No active activation request.";
  }

  function formatLicenseDuration(durationMs) {
    const value = Number(durationMs);
    const option = (licenseRequestConfig?.allowedDurations || []).find((entry) => Number(entry.durationMs) === value);
    if (option) return option.label;
    if (value === 600000) return "10 minutes";
    if (value === 1800000) return "30 minutes";
    if (value === 7200000) return "2 hours";
    if (value === 21600000) return "6 hours";
    if (value === 86400000) return "1 day";
    return "Unsupported duration";
  }

  function renderLicenseOwnerRequests(items = []) {
    const target = el("license-owner-requests");
    if (!target) return;
    if (!items.length) {
      target.innerHTML = '<div class="empty">No license requests yet.</div>';
      return;
    }
    target.innerHTML = items.map((item) => `<div class="license-owner-row"><div><strong>${escapeHtml(item.requesterLabel || "Website user")}</strong><small>${escapeHtml(item.origin || "")}</small><small>${formatLicenseDuration(item.durationMs)} · Created ${new Date(item.createdAt).toLocaleString()} · expires ${new Date(item.expiresAt).toLocaleString()}</small><small>Status: ${escapeHtml(item.status || "unknown")}</small></div>${item.status === "pending" ? `<div class="panel-actions"><button class="button primary" data-license-request-action="approve" data-license-request-id="${escapeHtml(item.id)}" type="button">Approve</button><button class="button secondary" data-license-request-action="decline" data-license-request-id="${escapeHtml(item.id)}" type="button">Decline</button></div>` : ""}</div>`).join("");
    target.querySelectorAll("[data-license-request-action]").forEach((button) => button.addEventListener("click", () => decideLicenseOwnerRequest(button.dataset.licenseRequestId, button.dataset.licenseRequestAction, button)));
  }

  function renderLicenseOwnerPanel(state) {
    const panel = el("license-owner-panel");
    if (!panel) return;
    const authenticated = Boolean(state.licenseAdmin?.authenticated);
    panel.classList.toggle("hidden", !authenticated);
    if (!authenticated) return;
    el("license-owner-status").textContent = "Owner session active";
    renderLicenseOwnerRequests(state.licenseRequests || []);
  }

  async function refreshLicenseOwnerRequests() {
    const button = el("refresh-license-requests");
    if (button) button.disabled = true;
    try {
      const value = await api.getLicenseRequests();
      renderLicenseOwnerRequests(value.items || []);
      showNotice("License requests refreshed.");
    } catch (error) {
      showNotice(error.message || "The license requests could not be loaded.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function decideLicenseOwnerRequest(requestId, action, button) {
    if (button) button.disabled = true;
    try {
      if (action === "approve") await api.approveLicenseRequest(requestId);
      else await api.declineLicenseRequest(requestId);
      await refreshLicenseOwnerRequests();
      showNotice(action === "approve" ? "License request approved." : "License request declined.");
    } catch (error) {
      showNotice(error.message || "The license request could not be updated.");
      if (button) button.disabled = false;
    }
  }

  function stopLicenseRequestPolling() {
    if (licenseRequestPollTimer) window.clearInterval(licenseRequestPollTimer);
    licenseRequestPollTimer = null;
  }

  async function pollLicenseRequest() {
    if (licenseRequestPollBusy || !licenseRequest?.requestId || !licenseRequest?.requestToken || licenseRequest.status !== "pending") return;
    licenseRequestPollBusy = true;
    try {
      const next = await api.getActivationRequestStatus(licenseRequest.requestId, licenseRequest.requestToken);
      setLicenseRequest({ ...licenseRequest, ...next, origin: next.origin || licenseRequest.origin });
      if (["approved", "declined", "expired", "redeemed"].includes(next.status)) {
        stopLicenseRequestPolling();
        if (next.status === "approved") showNotice("The owner approved your activation request. Activate the code below.");
      }
    } catch (error) {
      showNotice(error.message || "The activation request could not be checked.");
    } finally { licenseRequestPollBusy = false; }
  }

  function startLicenseRequestPolling() {
    stopLicenseRequestPolling();
    pollLicenseRequest();
    licenseRequestPollTimer = window.setInterval(pollLicenseRequest, 3000);
  }

  async function copyRequestedCode() {
    if (!licenseRequest?.code) return;
    try {
      if (api.copyText) await api.copyText(licenseRequest.code);
      else await navigator.clipboard.writeText(licenseRequest.code);
      showNotice("Activation code copied.");
    } catch (error) { showNotice(error.message || "The activation code could not be copied."); }
  }

  async function activateRequestedCode() {
    if (!licenseRequest?.code) return;
    const button = el("activate-request-code");
    if (button) button.disabled = true;
    try {
      render(await api.activate(licenseRequest.code));
      setLicenseRequest({ ...licenseRequest, status: "redeemed", code: null });
      stopLicenseRequestPolling();
      showNotice("Activation completed. This agent is authorized for ten minutes.");
    } catch (error) {
      showNotice(error.message || "The activation code could not be activated.");
      if (button) button.disabled = false;
    }
  }

  function renderSessions(items) {
    const target = el("sessions");
    if (!items.length) { target.innerHTML = '<div class="empty">No connected browser sessions.</div>'; return; }
    target.innerHTML = items.map((session) => `<div class="session"><div><strong>${escapeHtml(session.clientLabel || "Website session")}</strong><small>${escapeHtml(session.origin || "")}</small><small>Connected ${new Date(session.createdAt).toLocaleString()}</small></div><button class="button secondary" data-session-id="${escapeHtml(session.id)}" type="button">End session</button></div>`).join("");
    target.querySelectorAll("[data-session-id]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; try { render(await api.endSession(button.dataset.sessionId)); } catch (error) { showNotice(error.message || "The session could not be ended."); button.disabled = false; } }));
  }

  function renderCapabilities(capabilities) {
    const target = el("capabilities");
    const entries = [["FFmpeg", capabilities.video?.ffmpeg], ["Image engine", capabilities.image?.sharp || capabilities.image?.imagemagick], ["HEIC / libheif", capabilities.image?.heic || capabilities.image?.libheif], ["MKVToolNix", capabilities.video?.mkvmerge], ["Untrunc", capabilities.video?.untrunc]];
    target.innerHTML = entries.map(([label, ready]) => `<div class="capability ${ready ? "ready" : ""}"><strong>${label}</strong><span>${ready ? "Available" : "Unavailable"}</span></div>`).join("");
  }

  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

  async function refresh() { try { render(await api.getState()); } catch (error) { showNotice(error.message || "The agent dashboard could not read its state."); } }

  function closeAdminModal() {
    el("admin-modal").classList.add("hidden");
    document.body.classList.remove("modal-open");
  }

  function openAdminModal() {
    el("admin-modal").classList.remove("hidden");
    document.body.classList.add("modal-open");
    if (currentState?.authorization?.mode !== "admin") window.setTimeout(() => el("password").focus(), 0);
  }

  el("legal-consent-checkbox").addEventListener("change", (event) => { el("accept-legal-button").disabled = !event.currentTarget.checked; });
  el("legal-consent-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = el("accept-legal-button");
    button.disabled = true;
    showNotice("");
    try {
      render(await api.acceptLegal());
      showNotice("Privacy Policy and Terms & Conditions accepted. You can now start processing or log in.");
    } catch (error) {
      showNotice(error.message || "The legal documents could not be accepted.");
      button.disabled = false;
    }
  });
  el("start-trial-button").addEventListener("click", async () => {
    const button = el("start-trial-button");
    button.disabled = true;
    showNotice("");
    try {
      render(await api.startTrial());
      showNotice("Your five-minute trial has started.");
    } catch (error) {
      showNotice(error.message || "The trial could not be started.");
      button.disabled = false;
    }
  });
  el("check-license-server").addEventListener("click", async () => {
    const button = el("check-license-server");
    button.disabled = true;
    try {
      await refreshLicenseServer();
      showNotice(licenseServerState.healthy ? "The licensing server is reachable." : (licenseServerState.error || "The licensing server is not running."));
    } finally { button.disabled = false; }
  });
  el("start-license-server").addEventListener("click", async () => {
    const button = el("start-license-server");
    button.disabled = true;
    showNotice("");
    try {
      renderLicenseServer(await api.startLicenseServer());
      showNotice("The SSD licensing server is running. The saved Tailscale Funnel can now reach it.");
    } catch (error) {
      showNotice(error.message || "The licensing server could not be started.");
      await refreshLicenseServer();
    }
  });
  el("stop-license-server").addEventListener("click", async () => {
    const button = el("stop-license-server");
    if (!confirm("Stop the local SSD licensing server? Public license requests will return 502 until it is started again.")) return;
    button.disabled = true;
    try {
      renderLicenseServer(await api.stopLicenseServer());
      showNotice("The licensing server was stopped.");
    } catch (error) {
      showNotice(error.message || "The licensing server could not be stopped.");
      await refreshLicenseServer();
    }
  });
  document.querySelectorAll("[data-license-duration]").forEach((button) => button.addEventListener("click", () => {
    selectedLicenseDurationMs = Number(button.dataset.licenseDuration);
    el("license-duration").value = String(selectedLicenseDurationMs);
    document.querySelectorAll("[data-license-duration]").forEach((option) => {
      const selected = Number(option.dataset.licenseDuration) === selectedLicenseDurationMs;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
  }));
  el("license-request-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = el("request-activation-button");
    button.disabled = true;
    showNotice("");
    try {
      const value = await api.requestActivationCode(el("license-origin").value, selectedLicenseDurationMs);
      setLicenseRequest({ ...value, origin: el("license-origin").value.trim() });
      startLicenseRequestPolling();
      showNotice("Activation request sent. The owner must approve it from the web licensing dashboard.");
    } catch (error) {
      showNotice(error.message || "The activation request could not be created.");
      button.disabled = false;
    }
  });
  el("admin-control-button").addEventListener("click", openAdminModal);
  el("refresh-license-requests").addEventListener("click", refreshLicenseOwnerRequests);
  el("close-admin-modal").addEventListener("click", closeAdminModal);
  el("admin-modal").addEventListener("click", (event) => { if (event.target.matches("[data-close-admin-modal]")) closeAdminModal(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !el("admin-modal").classList.contains("hidden")) closeAdminModal(); });
  el("login-form").addEventListener("submit", async (event) => { event.preventDefault(); showNotice(""); const button = event.currentTarget.querySelector("button"); button.disabled = true; try { const state = await api.login(el("username").value, el("password").value); render(state); el("password").value = ""; closeAdminModal(); if (state.licenseAdminError) showNotice(`Local Admin access is active, but license requests are unavailable: ${state.licenseAdminError}`); else if (state.licenseAdmin?.authenticated) showNotice("Admin access enabled. License requests loaded below."); } catch (error) { showNotice(error.message || "Admin login failed."); } finally { button.disabled = false; } });
  el("logout-button").addEventListener("click", async () => { try { render(await api.logout()); closeAdminModal(); } catch (error) { showNotice(error.message || "Logout failed."); } });
  el("activation-form").addEventListener("submit", async (event) => { event.preventDefault(); showNotice(""); const button = event.currentTarget.querySelector("button"); button.disabled = true; try { render(await api.activate(el("activation-code").value)); el("activation-code").value = ""; } catch (error) { showNotice(error.message || "Activation failed."); } finally { button.disabled = false; } });
  el("copy-device").addEventListener("click", async () => { try { await api.copyDeviceId(currentState.authorization.deviceId); showNotice("Device ID copied."); setTimeout(() => showNotice(""), 1800); } catch (error) { showNotice(error.message || "The device ID could not be copied."); } });
  el("end-all").addEventListener("click", async () => { if (!confirm("End all connected browser sessions?")) return; try { render(await api.endAllSessions()); } catch (error) { showNotice(error.message || "Sessions could not be ended."); } });
  try {
    const savedRequest = localStorage.getItem("media-toolbox-agent-license-request");
    if (savedRequest) licenseRequest = JSON.parse(savedRequest);
  } catch { licenseRequest = null; }
  if (api.getLicenseRequestConfig) {
    api.getLicenseRequestConfig().then((value) => { licenseRequestConfig = value || {}; renderLicenseRequest(); if (licenseRequest?.status === "pending") startLicenseRequestPolling(); }).catch((error) => showNotice(error.message || "The licensing server configuration could not be read."));
  }
  refreshLicenseServer();
  refresh();
  setInterval(async () => { if (currentState?.authorization?.mode !== "admin") await refresh(); }, 1000);
  setInterval(refreshLicenseServer, 5000);
}());
