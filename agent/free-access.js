// Keep the Electron agent's copy inside agent/ so it remains available in
// app.asar. The licensing server uses the separately packaged lib/free-access.js
// copy from Resources/lib because that server runs outside app.asar.
export const FREE_ACCESS_CODE = "FreeForAll";
export const FREE_ACCESS_ACTIVATION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const FREE_ACCESS_EXPIRY_AT = Date.parse("2027-01-01T00:00:00.000Z");
export const FREE_ACCESS_EXPIRY_LABEL = "December 31, 2026";
export const FREE_ACCESS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const FREE_ACCESS_CODE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const FREE_ACCESS_REDEMPTION_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
export const FREE_ACCESS_ISSUED_AT_SETTING = "free_access_issued_at";

export function isFreeAccessCode(value) {
  return String(value || "").trim().toLowerCase() === FREE_ACCESS_CODE.toLowerCase();
}
