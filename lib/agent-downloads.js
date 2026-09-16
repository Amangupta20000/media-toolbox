export const AGENT_GITHUB_REPOSITORY = "Amangupta20000/media-toolbox";

export const AGENT_DOWNLOAD_PATHS = Object.freeze({
  macos: "/downloads/macos",
  windows: "/downloads/windows",
  linux: "/downloads/linux",
});

const platformAliases = {
  mac: "macos",
  macos: "macos",
  darwin: "macos",
  win: "windows",
  windows: "windows",
  win32: "windows",
  linux: "linux",
};

export function normalizeAgentPlatform(value) {
  return platformAliases[String(value || "").trim().toLowerCase()] || null;
}

function assetScore(name, platform) {
  const lowerName = name.toLowerCase();
  if (platform === "macos") {
    if (lowerName.includes("universal")) return 0;
    if (lowerName.includes("arm64")) return 1;
    if (lowerName.includes("x64")) return 2;
    return 3;
  }
  if (platform === "windows") {
    if (lowerName.includes("setup")) return 0;
    if (lowerName.includes("installer")) return 1;
    return 2;
  }
  return lowerName.includes("appimage") ? 0 : 1;
}

export function selectAgentAsset(assets, platform) {
  const normalizedPlatform = normalizeAgentPlatform(platform);
  if (!normalizedPlatform || !Array.isArray(assets)) return null;

  const extension = {
    macos: ".dmg",
    windows: ".exe",
    linux: ".appimage",
  }[normalizedPlatform];

  return assets
    .filter((asset) => asset && typeof asset.name === "string" && asset.name.toLowerCase().endsWith(extension))
    .sort((left, right) => assetScore(left.name, normalizedPlatform) - assetScore(right.name, normalizedPlatform))[0] || null;
}
