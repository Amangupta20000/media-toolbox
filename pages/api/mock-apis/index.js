import { listMockProjects, saveMockProject } from "../../../lib/mock-api-storage.js";

export const config = { api: { bodyParser: { sizeLimit: "1mb" }, responseLimit: "2mb" } };

function allowCors(response, request) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", request?.headers?.["access-control-request-headers"] || "Content-Type, X-Mock-Scenario");
  response.setHeader("Access-Control-Expose-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

export default async function handler(request, response) {
  allowCors(response, request);
  if (request.method === "OPTIONS") return response.status(204).end();
  try {
    if (request.method === "GET") return response.status(200).json({ items: await listMockProjects() });
    if (request.method === "POST") return response.status(201).json({ project: await saveMockProject(request.body) });
    response.setHeader("Allow", "GET, POST, OPTIONS");
    return response.status(405).json({ error: "Method not allowed", code: "method_not_allowed" });
  } catch (error) {
    return response.status(Number(error?.status) || 400).json({ error: error?.message || "The Mock API project could not be saved.", ...(error?.code ? { code: error.code } : {}) });
  }
}
