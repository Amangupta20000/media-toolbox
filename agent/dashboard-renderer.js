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
  let licenseServerNotice = "";
  let licenseServerNoticeKind = "";

  function showNotice(message) {
    const notice = el("notice");
    notice.textContent = message || "";
    notice.classList.toggle("hidden", !message);
  }

  function renderUpdate(value = {}) {
    const panel = el("agent-update-panel");
    const title = el("agent-update-title");
    const message = el("agent-update-message");
    const action = el("agent-update-action");
    const progress = el("agent-update-progress");
    const progressBar = el("agent-update-progress-bar");
    if (!panel || !title || !message || !action || !progress || !progressBar) return;
    const status = value.status || "unavailable";
    const fullRequired = status === "full-required" || value.updateType === "full";
    const runtime = value.kind === "runtime" && !fullRequired;
    const visible = ["checking", "available", "up-to-date", "downloading", "downloaded", "error", "manual", "full-required"].includes(status);
    panel.classList.toggle("hidden", !visible);
    panel.classList.toggle("update-error", status === "error" || status === "manual");
    panel.classList.toggle("update-full-required", status === "full-required");
    panel.classList.toggle("update-ready", status === "downloaded");
    progress.classList.toggle("hidden", status !== "downloading");
    progressBar.style.width = `${Math.max(0, Math.min(100, Number(value.progress) || 0))}%`;
    if (status === "checking") {
      title.textContent = runtime ? "Checking for verified processing updates" : "Checking for agent updates";
      message.textContent = runtime ? "Checking the latest signed runtime package…" : "Checking the latest signed release…";
      action.textContent = "Checking…";
      action.dataset.action = "";
      action.disabled = true;
    } else if (status === "available") {
      title.textContent = runtime ? `Verified processing update available${value.version ? ` · v${value.version}` : ""}` : `Full agent update available${value.version ? ` · v${value.version}` : ""}`;
      message.textContent = runtime ? "Download the verified processing package. The Electron application will not be replaced." : "Download the full signed agent update. The application will be replaced after you restart and install it.";
      action.textContent = "Update now";
      action.dataset.action = "download";
      action.disabled = false;
    } else if (status === "downloading") {
      title.textContent = runtime ? `Downloading verified processing update${value.version ? ` · v${value.version}` : ""}` : `Downloading full agent update${value.version ? ` · v${value.version}` : ""}`;
      message.textContent = `${Math.max(0, Math.min(100, Math.round(Number(value.progress) || 0)))}% downloaded. Keep the dashboard open until the download completes.`;
      action.textContent = "Downloading…";
      action.dataset.action = "";
      action.disabled = true;
    } else if (status === "downloaded") {
      title.textContent = runtime ? `Verified processing update ready${value.version ? ` · v${value.version}` : ""}` : `Full agent update ready${value.version ? ` · v${value.version}` : ""}`;
      message.textContent = runtime ? "The runtime package passed SHA-256 and Ed25519 verification. Restart the agent to activate it." : "The update is downloaded and will be verified before installation. Restart the agent to finish.";
      action.textContent = "Restart and install";
      action.dataset.action = "install";
      action.disabled = false;
    } else if (status === "up-to-date") {
      title.textContent = runtime ? `Verified processing runtime is up to date${value.version ? ` · v${value.version}` : ""}` : `Agent is up to date${value.version ? ` · v${value.version}` : ""}`;
      message.textContent = runtime ? "This installation already has the latest verified processing runtime." : "This installation already has the latest agent release.";
      action.textContent = "Check again";
      action.dataset.action = "check";
      action.disabled = false;
    } else if (status === "manual") {
      title.textContent = "Update manually from GitHub Releases";
      message.textContent = value.error || "Automatic macOS updates require an Apple Developer ID signed build.";
      action.textContent = "Open latest release";
      action.dataset.action = "open-release";
      action.disabled = false;
    } else if (status === "full-required") {
      title.textContent = `Full agent update required${value.version ? ` · v${value.version}` : ""}`;
      message.textContent = value.error || "This release changes the desktop application and cannot be installed by the in-app runtime updater. Download and install the latest release from GitHub Releases.";
      action.textContent = "Download full installer";
      action.dataset.action = "open-release";
      action.disabled = false;
    } else {
      title.textContent = "Agent update check failed";
      message.textContent = value.error || "The latest release could not be checked. Check your internet connection and try again.";
      action.textContent = "Check again";
      action.dataset.action = "check";
      action.disabled = false;
    }
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
    el("authorization-message").textContent = !authorization.legalAccepted ? "Accept the Privacy Policy and Terms & Conditions below before starting processing or logging in." : mode === "locked" ? (authorization.activationReloginAvailable ? "The activation session is logged out. Log in again to continue; its original expiry time is unchanged." : authorization.activationSessionLimitReached ? "The real activation time is exhausted by the active browser sessions. End a session to restore the real remaining time." : authorization.trialAvailable ? "A five-minute trial is available and starts on the first local processing session." : "Admin login or a valid activation code is required for processing.") : mode === "trial" ? "Your one-time trial is active on this installation." : mode === "activation" ? "This installation is authorized by a signed license." : "Unlimited local processing is unlocked until logout.";
    el("countdown").textContent = mode === "admin" ? "Unlimited" : formatRemaining(authorization.remainingMs);
    const showActivationTimer = mode !== "admin" && Boolean(authorization.activationId);
    el("timer-info").classList.toggle("hidden", !showActivationTimer);
    el("original-countdown").classList.toggle("hidden", !showActivationTimer);
    el("timer-rule").classList.toggle("hidden", !showActivationTimer || !el("timer-rule").dataset.open);
    if (showActivationTimer) el("original-countdown").textContent = `Original time remaining: ${formatRemaining(authorization.activationOriginalRemainingMs)}`;
    const badge = el("mode-badge"); badge.textContent = labels[mode] || "Locked"; badge.className = `badge ${mode}`;
    const legalAccepted = Boolean(authorization.legalAccepted);
    el("legal-consent").classList.toggle("hidden", legalAccepted);
    if (legalAccepted) el("legal-consent-checkbox").checked = false;
    el("accept-legal-button").disabled = legalAccepted || !el("legal-consent-checkbox").checked;
    el("locked-help").classList.toggle("hidden", mode !== "locked" || !authorization.trialAvailable);
    document.querySelectorAll("#login-form input, #login-form button, #activation-form textarea, #activation-form button, #license-request-form input, #license-request-form button").forEach((control) => { control.disabled = !legalAccepted; });
    const activationReloginAvailable = Boolean(authorization.activationReloginAvailable);
    const activationSessionVisible = mode === "activation" || (mode === "locked" && activationReloginAvailable);
    el("activation-code-block").classList.toggle("hidden", activationSessionVisible);
    el("activation-session-access").classList.toggle("hidden", !activationSessionVisible);
    if (activationSessionVisible) {
      const sessionActive = mode === "activation";
      el("activation-session-title").textContent = sessionActive ? "Activation session active" : "Activation session logged out";
      el("activation-session-message").textContent = sessionActive
        ? "Logging out ends this agent's browser sessions, but the activation expiry time will continue running."
        : `Log in again to resume processing. Time remaining: ${formatRemaining(authorization.remainingMs)}. The one-time code is not needed again.`;
      el("activation-session-button").textContent = sessionActive ? "Log out activation" : "Log in again";
      el("activation-session-button").disabled = !legalAccepted;
    }
    el("admin-access").classList.toggle("hidden", mode === "admin");
    el("logout-access").classList.toggle("hidden", mode !== "admin");
    const trialButton = el("start-trial-button");
    const trialVisible = mode === "locked" && Boolean(authorization.trialAvailable) && !authorization.activationId;
    trialButton.classList.toggle("hidden", !trialVisible);
    trialButton.disabled = !legalAccepted || !trialVisible;
    trialButton.title = legalAccepted ? "Start the one-time five-minute trial on this installation." : "Accept the Privacy Policy and Terms & Conditions first.";
    trialButton.textContent = legalAccepted ? "Start 5-minute trial" : "Accept terms to start trial";
    el("admin-control-button").textContent = mode === "admin" ? "Admin access" : "Admin login";
    el("admin-control-button").classList.toggle("active", mode === "admin");
    renderLicenseRequest();
    renderLicenseOwnerPanel(state);
    renderSessions(state.sessions || []);
    renderCapabilities(state.capabilities || {});
    renderLicenseServer(licenseServerState, currentState?.authorization?.mode === "admin");
  }

  function setLicenseServerNotice(message, kind = "") {
    licenseServerNotice = String(message || "");
    licenseServerNoticeKind = kind;
    const notice = el("license-server-notice");
    if (!notice) return;
    notice.textContent = licenseServerNotice;
    notice.className = `license-server-notice ${licenseServerNoticeKind} ${licenseServerNotice ? "" : "hidden"}`.trim();
  }

  function renderLicenseServer(value = {}, visible = false) {
    licenseServerState = value || {};
    const panel = el("license-server-panel");
    const ownerMachine = value.ownerConfigured === true;
    // Admin should be able to inspect the licensing endpoint from any
    // installation. Only the owner installation can start or stop the SSD
    // server; the manager still enforces the SSD check in the main process.
    if (panel) panel.classList.toggle("hidden", !visible);
    if (!visible) return;
    const badge = el("license-server-badge");
    const message = el("license-server-message");
    const startButton = el("start-license-server");
    const stopButton = el("stop-license-server");
    if (!badge || !message || !startButton || !stopButton) return;
    setLicenseServerNotice(licenseServerNotice, licenseServerNoticeKind);
    const healthy = Boolean(value.healthy);
    const publicConfigured = Boolean(value.publicUrl);
    const publicHealthy = value.publicHealthy === null || value.publicHealthy === undefined ? null : Boolean(value.publicHealthy);
    const mounted = Boolean(value.ssdMounted);
    const fullyReachable = healthy && (!publicConfigured || publicHealthy !== false);
    const autoStartStatus = value.autoStartStatus || "";
    const waitingForSsd = ownerMachine && autoStartStatus === "waiting-for-ssd";
    const starting = ownerMachine && autoStartStatus === "starting";
    badge.textContent = !ownerMachine ? "Owner machine not configured" : waitingForSsd ? "Waiting for licensing SSD" : starting ? "Starting" : !mounted ? "SSD not mounted" : !healthy ? "Stopped" : fullyReachable ? "Running" : "Public endpoint unavailable";
    badge.className = `badge ${!ownerMachine ? "warning" : waitingForSsd || starting ? "warning" : !mounted || !healthy ? "error" : fullyReachable ? "ready" : "warning"}`;
    message.textContent = !ownerMachine
      ? "This Admin session can inspect the licensing endpoint, but this installation is not configured as the owner machine. Connect the licensing SSD on the owner computer to start the server."
      : waitingForSsd
      ? "Waiting for the licensing SSD. The server will start automatically when the configured storage path becomes available."
      : starting
      ? "Starting the licensing server automatically. The dashboard will update when it is ready."
      : healthy && !value.managed
      ? "The licensing service is reachable, but it was started outside this agent. Stop that process first, then start it here so this dashboard can manage it."
      : healthy
      ? `The licensing service is reachable at ${value.url || "http://127.0.0.1:4900"}. Tailscale Funnel can forward to it using its saved configuration.`
      : value.error || (mounted ? "The licensing service is not running. Click Start licensing server after the SSD is mounted." : "Connect the Sandisk Exf licensing SSD, then click Start licensing server.");
    el("license-server-url").textContent = value.url || "http://127.0.0.1:4900";
    el("license-server-local-status").textContent = healthy ? "Connected" : "Unavailable";
    el("license-server-storage").textContent = value.dataDir || "/Volumes/Sandisk Exf/MediaToolboxLicensing";
    el("license-server-public-url").textContent = value.publicUrl || "Configured by Tailscale Funnel";
    el("license-server-public-status").textContent = !publicConfigured ? "Not configured" : publicHealthy === true ? "Connected" : publicHealthy === false ? "Unavailable" : "Checking";
    const dataDir = value.dataDir || "/Volumes/Sandisk Exf/MediaToolboxLicensing";
    const command = `LICENSE_DATA_DIR=${shellQuote(dataDir)} npm run license-server`;
    const commandElement = el("license-server-command");
    if (commandElement) commandElement.textContent = command;
    startButton.disabled = healthy || starting || !ownerMachine || !mounted || value.available === false;
    startButton.textContent = healthy ? "Licensing server running" : starting ? "Starting licensing server" : ownerMachine ? "Start licensing server" : "Available on owner machine";
    const serverRunning = healthy || Boolean(value.managed) || starting;
    const managedByAgent = Boolean(value.managed);
    // Keep the control visible while an owner server is running so the
    // dashboard never looks as if Stop is missing. An externally started
    // process is deliberately not killable from here; only the child spawned
    // by this agent can be stopped safely.
    stopButton.classList.toggle("hidden", !ownerMachine || !serverRunning);
    stopButton.disabled = !managedByAgent;
    stopButton.textContent = managedByAgent ? "Stop server" : "Stop unavailable";
    stopButton.title = managedByAgent ? "Stop the licensing server managed by this agent." : "This licensing server was started outside this agent. Stop that process first.";
  }

  function shellQuote(value) {
    return `'${String(value || "").replace(/'/g, "'\\''")}'`;
  }

  async function refreshLicenseServer() {
    if (!api.getLicenseServerState || currentState?.authorization?.mode !== "admin") return;
    try {
      renderLicenseServer(await api.getLicenseServerState(), true);
    } catch (error) {
      renderLicenseServer({ healthy: false, ssdMounted: false, error: error.message || "The licensing server status could not be checked." }, true);
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
    // Admin can request a license for another user from this dashboard. An
    // active activation already has access, so keep the request form focused
    // on locked, trial, and Admin states.
    block.classList.toggle("hidden", mode === "activation");
    if (!originInput.value && licenseRequestConfig?.suggestedOrigins?.length) originInput.value = licenseRequestConfig.suggestedOrigins[0];
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

  const auditLabels = {
    "request.created": "Activation requested",
    "request.approved": "Request approved",
    "request.declined": "Request declined",
    "request.expired": "Request expired",
    "license.redeemed": "License redeemed",
    "license.expired": "Code expired",
    "device.activity": "Device activity",
    "admin.login": "Admin login",
    "admin.login.failed": "Failed admin login",
    "admin.logout": "Admin logout",
    "admin.session.expired": "Admin session expired",
  };

  function auditDetailText(item) {
    const details = item.details || {};
    return Object.entries(details)
      .filter(([key, value]) => value !== null && value !== undefined && value !== "" && key !== "userAgent")
      .map(([key, value]) => `${key}: ${value}`)
      .join(" · ");
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
    const adminAuthenticated = state.authorization?.mode === "admin";
    const licenseAdminAuthenticated = Boolean(state.licenseAdmin?.authenticated);
    panel.classList.toggle("hidden", !adminAuthenticated);
    const auditPanel = el("license-audit-panel");
    if (auditPanel) auditPanel.classList.toggle("hidden", !adminAuthenticated);
    if (!adminAuthenticated) return;
    el("license-owner-status").textContent = licenseAdminAuthenticated ? "Owner session active" : state.licenseAdminError ? "Licensing server unavailable" : "Licensing server login required";
    renderLicenseOwnerRequests(state.licenseRequests || []);
    renderLicenseAudit(state.licenseAudit || [], state.licenseAuditStoragePath || "");
  }

  function renderLicenseAudit(items = [], storagePath = "") {
    const target = el("license-audit-events");
    const storage = el("license-audit-storage");
    if (!target) return;
    if (!items.length) {
      target.innerHTML = '<div class="empty">No audit events yet.</div>';
    } else {
      target.innerHTML = items.map((item) => `<div class="license-audit-row"><div><strong>${escapeHtml(auditLabels[item.event] || item.event || "Audit event")}</strong><small>${item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"} · ${escapeHtml(item.origin || "No browser origin")}${item.requestId ? ` · Request ${escapeHtml(String(item.requestId).slice(0, 8))}` : ""}</small><small>${escapeHtml(auditDetailText(item) || "No additional details")}</small></div></div>`).join("");
    }
    if (storage) storage.textContent = storagePath ? `Stored in ${storagePath}.` : "";
  }

  async function refreshLicenseOwnerRequests() {
    const button = el("refresh-license-requests");
    if (button) button.disabled = true;
    try {
      const [value, audit] = await Promise.all([api.getLicenseRequests(), api.getLicenseAudit ? api.getLicenseAudit() : Promise.resolve({})]);
      renderLicenseOwnerRequests(value.items || []);
      renderLicenseAudit(audit.items || [], audit.storagePath || "");
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

  function renderDiagnostics(value = null) {
    const target = el("diagnostics");
    if (!target) return;
    if (!value) {
      target.innerHTML = '<div class="empty">Run the self-test to check this installation.</div>';
      return;
    }
    const checkedAt = value.checkedAt ? new Date(value.checkedAt).toLocaleString() : "now";
    target.innerHTML = `<div class="diagnostics-summary ${value.ok ? "pass" : "fail"}"><strong>${value.ok ? "Self-test completed" : "Self-test found a blocking issue"}</strong><span>Checked ${escapeHtml(checkedAt)}</span></div>${(value.items || []).map((item) => `<div class="diagnostic-row ${escapeHtml(item.status || "warn")}"><span class="diagnostic-status" aria-hidden="true">${item.status === "pass" ? "✓" : item.status === "fail" ? "!" : "~"}</span><div><strong>${escapeHtml(item.label || "Check")}</strong><small>${escapeHtml(item.detail || "No details available.")}</small></div></div>`).join("")}`;
  }

  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

  async function refresh() { try { const state = await api.getState(); render(state); if (state.authorization?.mode === "admin") await refreshLicenseServer(); } catch (error) { showNotice(error.message || "The agent dashboard could not read its state."); } }

  async function refreshUpdateState() {
    if (!api.getUpdateState) return;
    try { renderUpdate(await api.getUpdateState()); } catch (error) { renderUpdate({ status: "error", error: error.message || "The latest agent release could not be checked." }); }
  }

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
      const value = await api.getLicenseServerState();
      renderLicenseServer(value, true);
      setLicenseServerNotice(value.healthy ? "The licensing server is reachable." : (value.error || "The licensing server is not running."), value.healthy ? "success" : "error");
    } catch (error) {
      renderLicenseServer({ healthy: false, ssdMounted: false, error: error.message || "The licensing server status could not be checked." }, true);
      setLicenseServerNotice(error.message || "The licensing server status could not be checked.", "error");
    } finally { button.disabled = false; }
  });
  el("start-license-server").addEventListener("click", async () => {
    const button = el("start-license-server");
    button.disabled = true;
    setLicenseServerNotice("");
    try {
      const value = await api.startLicenseServer();
      renderLicenseServer(value, true);
      setLicenseServerNotice("The SSD licensing server is running. The saved Tailscale Funnel can now reach it.", "success");
    } catch (error) {
      setLicenseServerNotice(error.message || "The licensing server could not be started.", "error");
      await refreshLicenseServer();
    }
  });
  el("copy-license-server-command").addEventListener("click", async () => {
    const command = el("license-server-command")?.textContent || "";
    if (!command) return;
    try {
      if (api.copyText) await api.copyText(command);
      else await navigator.clipboard.writeText(command);
      setLicenseServerNotice("Start command copied. Run it from the MediaToolbox project folder if the packaged start button cannot be used.", "success");
    } catch (error) {
      setLicenseServerNotice(error.message || "The start command could not be copied.", "error");
    }
  });
  el("stop-license-server").addEventListener("click", async () => {
    const button = el("stop-license-server");
    if (!confirm("Stop the local SSD licensing server? Public license requests will return 502 until it is started again.")) return;
    button.disabled = true;
    try {
      const value = await api.stopLicenseServer();
      renderLicenseServer(value, true);
      setLicenseServerNotice("The licensing server was stopped.", "success");
    } catch (error) {
      setLicenseServerNotice(error.message || "The licensing server could not be stopped.", "error");
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
  el("refresh-license-audit")?.addEventListener("click", refreshLicenseOwnerRequests);
  el("close-admin-modal").addEventListener("click", closeAdminModal);
  el("admin-modal").addEventListener("click", (event) => { if (event.target.matches("[data-close-admin-modal]")) closeAdminModal(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !el("admin-modal").classList.contains("hidden")) closeAdminModal(); });
  el("login-form").addEventListener("submit", async (event) => { event.preventDefault(); showNotice(""); const button = event.currentTarget.querySelector("button"); button.disabled = true; try { const state = await api.login(el("username").value, el("password").value); render(state); el("password").value = ""; closeAdminModal(); if (state.authorization?.mode === "admin") refreshLicenseServer(); if (state.licenseAdminError) showNotice(`Local Admin access is active, but license requests are unavailable: ${state.licenseAdminError}`); else if (state.licenseAdmin?.authenticated) showNotice("Admin access enabled. License requests loaded below."); } catch (error) { showNotice(error.message || "Admin login failed."); } finally { button.disabled = false; } });
  el("logout-button").addEventListener("click", async () => { try { render(await api.logout()); closeAdminModal(); showNotice(""); } catch (error) { showNotice(error.message || "Logout failed."); } });
  el("activation-session-button").addEventListener("click", async () => {
    const button = el("activation-session-button");
    button.disabled = true;
    showNotice("");
    try {
      const relogin = Boolean(currentState?.authorization?.activationReloginAvailable);
      render(relogin ? await api.loginActivation() : await api.logoutActivation());
      showNotice(relogin ? "Activation session resumed. Its original expiry time was preserved." : "Activation session logged out. Browser sessions were ended.");
    } catch (error) {
      showNotice(error.message || "The activation session could not be changed.");
      button.disabled = false;
    }
  });
  el("timer-info").addEventListener("click", () => {
    const rule = el("timer-rule");
    if (!rule || el("timer-info").classList.contains("hidden")) return;
    const open = rule.dataset.open === "true";
    rule.dataset.open = open ? "" : "true";
    rule.classList.toggle("hidden", open);
  });
  el("refresh-sessions").addEventListener("click", async () => {
    const button = el("refresh-sessions");
    button.disabled = true;
    try {
      render(await api.getState());
      showNotice("Connected sessions refreshed.");
    } catch (error) {
      showNotice(error.message || "Connected sessions could not be refreshed.");
    } finally { button.disabled = false; }
  });
  el("agent-update-action").addEventListener("click", async () => {
    const button = el("agent-update-action");
    const updateAction = button.dataset.action;
    if (!updateAction) return;
    button.disabled = true;
    try {
      if (updateAction === "open-release") {
        await api.openReleasePage();
        return;
      }
      const nextState = updateAction === "download" ? await api.downloadUpdate() : updateAction === "install" ? await api.installUpdate() : await api.checkForUpdates();
      renderUpdate(nextState);
      if (updateAction === "check" && nextState.status === "up-to-date") showNotice("The agent is up to date.");
    } catch (error) {
      renderUpdate({ status: "error", error: error.message || "The agent update could not be completed." });
    } finally { button.disabled = false; }
  });
  el("check-updates-bottom")?.addEventListener("click", async () => {
    const button = el("check-updates-bottom");
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const nextState = await api.checkForUpdates();
      renderUpdate(nextState);
      showNotice(nextState.status === "available" ? `Agent update available${nextState.version ? ` · v${nextState.version}` : ""}.` : nextState.status === "up-to-date" ? "The agent is up to date." : nextState.error || "Update status checked.");
    } catch (error) {
      renderUpdate({ status: "error", error: error.message || "The agent update check failed." });
      showNotice(error.message || "The agent update check failed.");
    } finally {
      button.disabled = false;
      button.textContent = "Check for updates";
    }
  });
  el("run-self-test").addEventListener("click", async () => {
    const button = el("run-self-test");
    button.disabled = true;
    el("diagnostics").innerHTML = '<div class="empty">Running self-test…</div>';
    try {
      renderDiagnostics(await api.runDiagnostics());
      showNotice("Agent self-test completed.");
    } catch (error) {
      el("diagnostics").innerHTML = `<div class="diagnostics-summary fail"><strong>Self-test failed</strong><span>${escapeHtml(error.message || "The diagnostics could not be completed.")}</span></div>`;
      showNotice(error.message || "The agent self-test could not be completed.");
    } finally { button.disabled = false; }
  });
  el("activation-form").addEventListener("submit", async (event) => { event.preventDefault(); showNotice(""); const button = event.currentTarget.querySelector("button"); button.disabled = true; try { render(await api.activate(el("activation-code").value)); el("activation-code").value = ""; } catch (error) { showNotice(error.message || "Activation failed."); } finally { button.disabled = false; } });
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
  if (api.onUpdateState) api.onUpdateState(renderUpdate);
  refreshUpdateState();
  setInterval(async () => { if (currentState?.authorization?.mode !== "admin") await refresh(); }, 1000);
  setInterval(refreshLicenseServer, 5000);
}());
