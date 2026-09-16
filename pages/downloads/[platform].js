import { AGENT_GITHUB_REPOSITORY, normalizeAgentPlatform, selectAgentAsset } from "../../lib/agent-downloads.js";

const releasesUrl = `https://github.com/${AGENT_GITHUB_REPOSITORY}/releases/latest`;

export default function AgentDownloadFallback({ error }) {
  return <main style={{ maxWidth: "42rem", margin: "4rem auto", padding: "0 1.5rem", fontFamily: "system-ui, sans-serif" }}>
    <h1>Installer download unavailable</h1>
    <p>{error}</p>
    <a href={releasesUrl}>Open the latest NativeMedia Agent release</a>
  </main>;
}

export async function getServerSideProps({ params, res }) {
  const platform = normalizeAgentPlatform(params?.platform);
  if (!platform) return { notFound: true };
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  try {
    const response = await fetch(`https://api.github.com/repos/${AGENT_GITHUB_REPOSITORY}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "NativeMedia-Agent-installer-download",
      },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);

    const release = await response.json();
    const asset = selectAgentAsset(release.assets, platform);
    if (!asset?.browser_download_url) throw new Error(`No ${platform} installer was found in the latest release.`);

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
    return { redirect: { destination: asset.browser_download_url, permanent: false } };
  } catch (error) {
    res.statusCode = 503;
    return {
      props: {
        error: `The latest ${platform} installer could not be located right now. You can open the release page and choose it manually.`,
      },
    };
  }
}
