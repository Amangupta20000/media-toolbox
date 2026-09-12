(function () {
  "use strict";
  const api = window.mediaToolboxAgent;
  const el = (id) => document.getElementById(id);
  let currentState;

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
    el("authorization-message").textContent = mode === "locked" ? "Admin login or a valid activation code is required for processing." : mode === "trial" ? "Your one-time trial is active on this installation." : mode === "activation" ? "This device is authorized by a signed license." : "Unlimited local processing is unlocked until logout.";
    el("countdown").textContent = mode === "admin" ? "Unlimited" : formatRemaining(authorization.remainingMs);
    const badge = el("mode-badge"); badge.textContent = labels[mode] || "Locked"; badge.className = `badge ${mode}`;
    el("admin-access").classList.toggle("hidden", mode === "admin");
    el("logout-access").classList.toggle("hidden", mode !== "admin");
    el("device-id").textContent = authorization.deviceId || "—";
    el("trusted-origins").textContent = authorization.trustedOrigins?.length ? authorization.trustedOrigins.join(", ") : "None";
    el("agent-version").textContent = state.agentVersion || "—";
    el("protocol").textContent = `${state.protocol || "http"} · v${state.protocolVersion || "1"}`;
    renderSessions(state.sessions || []);
    renderCapabilities(state.capabilities || {});
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

  el("login-form").addEventListener("submit", async (event) => { event.preventDefault(); showNotice(""); const button = event.currentTarget.querySelector("button"); button.disabled = true; try { render(await api.login(el("username").value, el("password").value)); el("password").value = ""; } catch (error) { showNotice(error.message || "Admin login failed."); } finally { button.disabled = false; } });
  el("logout-button").addEventListener("click", async () => { try { render(await api.logout()); } catch (error) { showNotice(error.message || "Logout failed."); } });
  el("activation-form").addEventListener("submit", async (event) => { event.preventDefault(); showNotice(""); const button = event.currentTarget.querySelector("button"); button.disabled = true; try { render(await api.activate(el("activation-code").value)); el("activation-code").value = ""; } catch (error) { showNotice(error.message || "Activation failed."); } finally { button.disabled = false; } });
  el("copy-device").addEventListener("click", async () => { try { await api.copyDeviceId(currentState.authorization.deviceId); showNotice("Device ID copied."); setTimeout(() => showNotice(""), 1800); } catch (error) { showNotice(error.message || "The device ID could not be copied."); } });
  el("end-all").addEventListener("click", async () => { if (!confirm("End all connected browser sessions?")) return; try { render(await api.endAllSessions()); } catch (error) { showNotice(error.message || "Sessions could not be ended."); } });
  refresh();
  setInterval(async () => { if (currentState?.authorization?.mode !== "admin") await refresh(); }, 1000);
}());
