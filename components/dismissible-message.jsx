"use client";

import { useState } from "react";
import { X } from "lucide-react";

export function DismissibleMessage({ children, className = "", resetKey = "", role = "alert", ariaLabel = "Dismiss message" }) {
  const [dismissedKey, setDismissedKey] = useState(null);
  const currentKey = String(resetKey);

  if (dismissedKey === currentKey) return null;

  return <div className={`${className} dismissible-message`.trim()} role={role}>
    {children}
    <button className="message-dismiss" type="button" onClick={() => setDismissedKey(currentKey)} aria-label={ariaLabel} title={ariaLabel}><X size={15} /></button>
  </div>;
}
