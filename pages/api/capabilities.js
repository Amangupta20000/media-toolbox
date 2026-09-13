import fs from "node:fs/promises";
import { paths } from "../../lib/config.js";

export default async function handler(_request, response) {
  try {
    const value = await fs.readFile(paths.capabilities, "utf8");
    const payload = JSON.parse(value);
    if (payload.status !== "ready") return response.status(503).json({ ...payload, error: "The processing worker is not ready." });
    return response.status(200).json(payload);
  } catch {
    response.status(503).json({ status: "starting", checkedAt: null, pdf: {}, image: {}, video: {}, error: "The processing worker is not ready." });
  }
}
