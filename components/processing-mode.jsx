"use client";

import Link from "next/link";
import { Globe2, Laptop, Server, Settings2 } from "lucide-react";
import { browserSupportsTool } from "./browser-processing.js";

const labels = {
  local: ["Local agent", "Reliable processing on this device", Laptop],
  browser: ["Browser mode", "Some features may be unavailable or less reliable", Globe2],
  server: ["Server mode", "Files would be processed by a server", Server],
};

export function ProcessingMode({ value, onChange, onChangeView, locations, tool = "", compact = false }) {
  // Show Server mode only when the deployment reports a configured and ready
  // online worker. An unavailable server should not appear as a dead-end
  // option, and a visible server option is always selectable.
  const serverAvailable = Boolean(locations?.server?.available && (locations?.server?.connected || locations?.server?.ready));
  const browserAvailable = browserSupportsTool(tool);
  const modes = ["local", ...(browserAvailable ? ["browser"] : []), ...(serverAvailable ? ["server"] : [])];
  const ready = (mode) => Boolean(locations?.[mode]?.connected || locations?.[mode]?.ready);
  const localUnavailable = !Boolean(locations?.local?.available && ready("local"));
  const availableModeLabels = ["local", ...(browserAvailable ? ["browser"] : []), ...(serverAvailable ? ["server"] : [])].map((mode) => labels[mode][0]);
  return <div className={`processing-mode ${compact ? "compact" : ""}`}>
    <div className="processing-mode-heading"><span><Settings2 size={16} /> Processing location</span><small>{availableModeLabels.join(" + ")}</small></div>
    <div className="processing-mode-current" aria-live="polite"><span>Processing with: <strong>{labels[value]?.[0] || "Choose an option"}</strong></span>{onChangeView && <button type="button" onClick={onChangeView}>Change</button>}</div>
    <div className="processing-mode-options">
      {modes.map((mode) => {
        const [label, detail, Icon] = labels[mode];
        const available = Boolean(locations?.[mode]?.available && ready(mode));
        return <button type="button" key={mode} className={`processing-mode-option ${value === mode ? "selected" : ""} ${!available ? "unavailable" : ""}`} disabled={!available} onClick={() => onChange(mode)}>
          <Icon size={18} /><span><strong>{label}</strong><small>{available ? detail : mode === "local" ? "Start and authorize the agent" : mode === "browser" ? "This tool cannot run in the browser" : "Connect to the server to continue"}</small></span><em>{value === mode ? "Selected" : available ? "Available" : "Unavailable"}</em>
        </button>;
      })}
    </div>
    <div className="processing-mode-help" aria-live="polite">
      {localUnavailable && browserAvailable && value === "browser" && <span>Local agent is unavailable; Browser mode is limited to quick conversions in this tool.</span>}
      {localUnavailable && (!browserAvailable || value !== "browser") && <><span>Local agent requires Admin login or activation. </span><Link href="/local-agent">Open Local agent setup</Link></>}
      {!localUnavailable && <span aria-hidden="true">&nbsp;</span>}
    </div>
  </div>;
}
