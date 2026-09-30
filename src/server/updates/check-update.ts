const RELEASE_API = "https://api.github.com/repos/STurGeon-zhx/feishu-material-review-tool/releases/latest";
const PACKAGE_STEM = "飞书客户素材审核工具-win-x64";

type Version = readonly [number, number, number];

export type UpdateResult =
  | { status: "unavailable"; currentVersion: string }
  | { status: "up_to_date"; currentVersion: string; latestVersion: string }
  | { status: "update_available"; currentVersion: string; latestVersion: string; releaseUrl: string; downloadUrl: string | null };

function parseVersion(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(latest: Version, current: Version): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== current[index]) return latest[index] > current[index];
  }
  return false;
}

export async function checkUpdate(currentVersion: string, fetcher: typeof fetch = fetch): Promise<UpdateResult> {
  const response = await fetcher(RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "feishu-material-review-tool",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return { status: "unavailable", currentVersion };
  if (!response.ok) throw new Error(`版本检查失败（GitHub HTTP ${response.status}）`);

  const release = await response.json() as {
    tag_name?: unknown;
    html_url?: unknown;
    assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
  };
  const current = parseVersion(currentVersion);
  const latest = typeof release.tag_name === "string" ? parseVersion(release.tag_name) : null;
  if (!current || !latest || typeof release.html_url !== "string"
    || !release.html_url.startsWith("https://github.com/STurGeon-zhx/feishu-material-review-tool/releases/")) {
    return { status: "unavailable", currentVersion };
  }
  const latestVersion = release.tag_name as string;
  if (!isNewer(latest, current)) return { status: "up_to_date", currentVersion, latestVersion };

  const asset = release.assets?.find((item) =>
    item.name === `${PACKAGE_STEM}-${latestVersion}.zip` || item.name === `${PACKAGE_STEM}.zip`);
  const downloadUrl = typeof asset?.browser_download_url === "string"
    && asset.browser_download_url.startsWith("https://github.com/STurGeon-zhx/feishu-material-review-tool/releases/download/")
    ? asset.browser_download_url : null;
  return { status: "update_available", currentVersion, latestVersion, releaseUrl: release.html_url, downloadUrl };
}
