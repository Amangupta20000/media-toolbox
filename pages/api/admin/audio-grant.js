import { createAdminAudioGrant, validSession, verifyAdminAudioGrant } from "./session.js";

function json(response, status, payload) {
  return response.status(status).setHeader("Cache-Control", "no-store").json(payload);
}

function bodyOf(request) {
  if (request.body && typeof request.body === "object") return request.body;
  try { return JSON.parse(String(request.body || "{}")); } catch { return {}; }
}

export default function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed." });
  }
  const body = bodyOf(request);
  // The Local Agent calls this branch without the browser's HttpOnly cookie to
  // validate a grant that the browser minted in the Admin session.
  if (body.grant) {
    const grant = verifyAdminAudioGrant(body.grant);
    if (!grant) return json(response, 401, { authorized: false });
    return json(response, 200, { authorized: true, ...grant });
  }
  if (!validSession(request)) return json(response, 401, { error: "Admin login is required for media URL extraction." });
  const challenge = String(body.challenge || "").trim();
  const origin = String(body.origin || request.headers.origin || "").trim();
  const requestOrigin = String(request.headers.origin || "").trim();
  if (!challenge || challenge.length > 256 || !origin || (requestOrigin && origin !== requestOrigin)) return json(response, 400, { error: "The Admin media URL grant request is invalid." });
  return json(response, 200, { grant: createAdminAudioGrant({ challenge, origin }) });
}
