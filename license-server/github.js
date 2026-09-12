const VARIABLE_NAME = "AGENT_LICENSE_SERVER_URL";

function normalizedUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { return ""; }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return "";
  return parsed.origin;
}

function repositoryParts(repository) {
  const parts = String(repository || "").trim().split("/");
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part)) ? parts : null;
}

async function githubRequest(url, options, config) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "media-toolbox-license-server",
      Authorization: `Bearer ${config.githubToken}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).message || ""; } catch { /* use the HTTP status */ }
    const error = new Error(`GitHub rejected the repository variable update (${response.status})${detail ? `: ${detail}` : "."}`);
    error.statusCode = response.status === 401 || response.status === 403 ? 502 : response.status;
    throw error;
  }
  return response;
}

export async function updateAgentLicenseServerVariable({ url, config }) {
  const value = normalizedUrl(url);
  if (!value) throw new Error("Enter an HTTPS licensing-server URL without a path or query string.");
  if (!config.githubToken) {
    const error = new Error("The licensing server has no GitHub token. Set LICENSE_GITHUB_TOKEN on the SSD server.");
    error.statusCode = 503;
    throw error;
  }
  const parts = repositoryParts(config.githubRepository);
  if (!parts) {
    const error = new Error("LICENSE_GITHUB_REPOSITORY must use the owner/repository format.");
    error.statusCode = 503;
    throw error;
  }
  const [owner, repository] = parts;
  const base = `${config.githubApiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/variables`;
  const body = JSON.stringify({ name: VARIABLE_NAME, value });
  try {
    await githubRequest(`${base}/${VARIABLE_NAME}`, { method: "PATCH", body }, config);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
    await githubRequest(base, { method: "POST", body }, config);
  }
  return { ok: true, name: VARIABLE_NAME, value, repository: `${owner}/${repository}` };
}

export { VARIABLE_NAME, normalizedUrl };
