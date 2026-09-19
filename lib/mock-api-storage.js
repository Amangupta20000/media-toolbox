import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { MockApiError, normalizeMockProject, isSafeMockId } from "./mock-api.js";

export function mockApisDirectory(root = path.join(config.dataDir, "Results", "mock-apis")) { return root; }
export function mockApiProjectPath(id, root = mockApisDirectory()) {
  if (!isSafeMockId(id)) throw new MockApiError("The mock API project ID is invalid.", 400, "invalid_project_id");
  return path.join(root, id, "mock-api.json");
}

async function readProjectFile(file) {
  try { return normalizeMockProject(JSON.parse(await fs.readFile(file, "utf8"))); } catch (error) {
    if (error?.code === "ENOENT") throw new MockApiError("Mock API project not found.", 404, "not_found");
    if (error instanceof MockApiError) throw error;
    throw new MockApiError("The mock API project could not be read.", 500, "storage_error");
  }
}

export async function listMockProjects(root = mockApisDirectory()) {
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; return []; }
  const projects = await Promise.all(entries.filter((entry) => entry.isDirectory() && isSafeMockId(entry.name)).map(async (entry) => {
    try { return await readProjectFile(path.join(root, entry.name, "mock-api.json")); } catch { return null; }
  }));
  return projects.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getMockProject(id, root = mockApisDirectory()) { return readProjectFile(mockApiProjectPath(id, root)); }

export async function saveMockProject(input, { root = mockApisDirectory(), expectedId } = {}) {
  const normalized = normalizeMockProject(input, { id: expectedId || input?.id });
  const project = { ...normalized, updatedAt: new Date().toISOString() };
  const file = mockApiProjectPath(project.id, root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
  return project;
}

export async function deleteMockProject(id, root = mockApisDirectory()) {
  const directory = path.dirname(mockApiProjectPath(id, root));
  try { await fs.rm(directory, { recursive: true, force: false }); } catch (error) { if (error?.code === "ENOENT") throw new MockApiError("Mock API project not found.", 404, "not_found"); throw error; }
  return true;
}
