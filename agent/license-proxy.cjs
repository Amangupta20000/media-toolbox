const DEFAULT_LICENSE_PROXY_URL = "https://native-media-agent.vercel.app/api/license";

function licenseProxyUrl() {
  return String(process.env.AGENT_LICENSE_SERVER_PROXY_URL || DEFAULT_LICENSE_PROXY_URL).trim().replace(/\/$/, "");
}

module.exports = { DEFAULT_LICENSE_PROXY_URL, licenseProxyUrl };
