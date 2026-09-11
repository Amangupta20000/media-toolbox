"use client";

import Link from "next/link";
import { Globe2, Laptop, Server, Settings2 } from "lucide-react";

const labels = {
  browser: ["Browser", "Private in this browser", Globe2],
  local: ["Local agent", "Files stay on this device", Laptop],
  server: ["Server", "Runs on the connected worker", Server],
};

export function ProcessingMode({ value, onChange, locations, allowBrowser = false, compact = false }) {
  const modes = (allowBrowser ? ["browser", "local", "server"] : ["local", "server"]).filter((mode) => mode !== "server" || locations?.server?.available);
  const ready = (mode) => mode === "browser" || Boolean(locations?.[mode]?.connected);
  return <div className={`processing-mode ${compact ? "compact" : ""}`}>
    <div className="processing-mode-heading"><span><Settings2 size={16} /> Processing location</span><small>Choose where this job runs</small></div>
    <div className="processing-mode-options">
      {modes.map((mode) => {
        const [label, detail, Icon] = labels[mode];
        const available = ready(mode);
        return <button type="button" key={mode} className={`processing-mode-option ${value === mode ? "selected" : ""} ${!available ? "unavailable" : ""}`} disabled={!available} onClick={() => onChange(mode)}>
          <Icon size={18} /><span><strong>{label}</strong><small>{available ? detail : mode === "local" ? "Start and pair the agent" : "API is unavailable"}</small></span><em>{value === mode ? "Selected" : available ? "Available" : "Unavailable"}</em>
        </button>;
      })}
    </div>
    {(!locations?.local?.connected || !locations?.server?.connected) && <div className="processing-mode-help"><span>{locations?.local?.connected ? "" : "Local agent is not paired. "}</span>{!locations?.local?.connected && <Link href="/local-agent">Set up Local agent</Link>}<span>{!locations?.local?.connected && !locations?.server?.connected ? " · " : ""}</span>{!locations?.server?.connected && <span>Server processing is unavailable.</span>}</div>}
  </div>;
}
