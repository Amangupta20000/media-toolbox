import { applyMockRequest } from "../../../../lib/mock-api.js";
import { getMockProject, saveMockProject } from "../../../../lib/mock-api-storage.js";

export const config = { api: { bodyParser: { sizeLimit: "256kb" }, responseLimit: "512kb" } };

function allowCors(response, request) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", request?.headers?.["access-control-request-headers"] || "Content-Type, X-Mock-Scenario");
  response.setHeader("Access-Control-Expose-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
}

function requestPath(request) {
  const segments = Array.isArray(request.query.path) ? request.query.path : request.query.path ? [request.query.path] : [];
  const path = `/${segments.map((segment) => encodeURIComponent(String(segment))).join("/")}`;
  const query = typeof request.url === "string" && request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
  return `${path}${query}`;
}

function requestHeaders(request) {
  return Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
}

function responseBody(response, body) {
  if (body === null || body === undefined) return response.end();
  return response.json(body);
}

export default async function handler(request, response) {
  allowCors(response, request);
  const projectId = Array.isArray(request.query.projectId) ? request.query.projectId[0] : request.query.projectId;
  try {
    const project = await getMockProject(projectId);
    const result = applyMockRequest(project, {
      method: request.method,
      pathname: requestPath(request),
      headers: requestHeaders(request),
      body: request.body,
    });
    if (!["GET", "OPTIONS"].includes(String(request.method).toUpperCase())) {
      await saveMockProject(result.project, { expectedId: projectId });
    }
    Object.entries(result.headers || {}).forEach(([key, value]) => response.setHeader(key, value));
    response.status(result.status);
    return responseBody(response, result.body);
  } catch (error) {
    Object.entries(error?.headers || {}).forEach(([key, value]) => response.setHeader(key, value));
    return response.status(Number(error?.status) || 400).json({ error: error?.message || "The Mock API request failed.", ...(error?.code ? { code: error.code } : {}) });
  }
}
