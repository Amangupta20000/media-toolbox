export function formatAccessDuration(remainingMs) {
  const milliseconds = Number(remainingMs);
  const totalSeconds = Number.isFinite(milliseconds)
    ? Math.max(0, Math.ceil(milliseconds / 1000))
    : 0;

  if (!totalSeconds) return "Expired";

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${String(seconds).padStart(2, "0")}s`);

  return parts.join(" ");
}
