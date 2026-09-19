const ADMIN_TOKEN_HEADER = "x-media-toolbox-admin-token";

function licenseServerUrl() {
  return String(process.env.NEXT_PUBLIC_LICENSE_SERVER_URL || "").trim().replace(/\/$/, "");
}

export function adminTokenFromRequest(request) {
  const value = request?.headers?.[ADMIN_TOKEN_HEADER] || request?.headers?.["X-Media-Toolbox-Admin-Token"] || "";
  return String(Array.isArray(value) ? value[0] : value).trim();
}

export async function isValidLicenseAdminToken(token) {
  const value = String(token || "").trim();
  const baseUrl = licenseServerUrl();
  if (!value || !baseUrl || typeof fetch !== "function") return false;
  try {
    const response = await fetch(`${baseUrl}/v1/admin/audit-log?limit=1`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${value}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}
