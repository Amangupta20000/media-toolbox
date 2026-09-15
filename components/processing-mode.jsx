"use client";

import Link from "next/link";
import { Laptop, Server, Settings2 } from "lucide-react";

const labels = {
  local: ["Local agent", "Files stay on this device", Laptop],
  server: ["Server mode", "Files would be processed by a server", Server],
};

export function ProcessingMode({ value, onChange, locations, compact = false }) {
  // Show Server mode only when the deployment reports a configured and ready
  // online worker. An unavailable server should not appear as a dead-end
  // option, and a visible server option is always selectable.
  const serverAvailable = Boolean(locations?.server?.available && (locations?.server?.connected || locations?.server?.ready));
  const modes = ["local", ...(serverAvailable ? ["server"] : [])];
  const ready = (mode) => Boolean(locations?.[mode]?.connected || locations?.[mode]?.ready);
  const localUnavailable = !Boolean(locations?.local?.available && ready("local"));
  return <div className={`processing-mode ${compact ? "compact" : ""}`}>
    <div className="processing-mode-heading"><span><Settings2 size={16} /> Processing location</span><small>{serverAvailable ? "Local agent + server" : "Local agent only"}</small></div>
    <div className="processing-mode-options">
      {modes.map((mode) => {
        const [label, detail, Icon] = labels[mode];
        const available = Boolean(locations?.[mode]?.available && ready(mode));
        return <button type="button" key={mode} className={`processing-mode-option ${value === mode ? "selected" : ""} ${!available ? "unavailable" : ""}`} disabled={!available} onClick={() => onChange(mode)}>
          <Icon size={18} /><span><strong>{label}</strong><small>{available ? detail : mode === "local" ? "Start and authorize the agent" : "Connect to the server to continue"}</small></span><em>{value === mode ? "Selected" : available ? "Available" : "Unavailable"}</em>
        </button>;
      })}
    </div>
    <div className="processing-mode-help" aria-live="polite">
      {localUnavailable && <><span>Local agent requires Admin login or activation. </span><Link href="/local-agent">Open Local agent setup</Link></>}
      {!localUnavailable && <span aria-hidden="true">&nbsp;</span>}
    </div>
  </div>;
}
