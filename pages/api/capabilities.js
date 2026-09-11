import fs from "node:fs/promises";
import { paths } from "../../lib/config.js";

export default async function handler(_request, response) {
  try {
    const value = await fs.readFile(paths.capabilities, "utf8");
    response.status(200).json(JSON.parse(value));
  } catch {
    response.status(200).json({ status: "starting", checkedAt: null, image: {}, video: {} });
  }
}
