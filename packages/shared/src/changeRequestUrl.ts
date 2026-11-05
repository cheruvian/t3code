/**
 * The two strings are what `pullRequestHostOf` and the project's `repositoryIdentity` produce
 * from a git remote — lower case, no port, the full path below the host — because links are
 * matched against those. Anything else matches nothing.
 */
export interface ChangeRequestLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly authority?: string;
}

function isHostOf(hostname: string, apex: string, label?: string): boolean {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== undefined && hostname.split(".").includes(label);
}

export function parseChangeRequestUrl(targetUrl: string): ChangeRequestLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  if (host === "git.cafe" || host === "staging.git.cafe") {
    const match = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  if (isHostOf(host, "github.com", "github")) {
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (match) return claim(host, match);
  }
  const forgejo = /^\/([^/]+(?:\/[^/]+)+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (forgejo) {
    const link = claim(host, forgejo);
    return link === null ? null : { ...link, authority: url.host.toLowerCase() };
  }
  const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (gitlab) return claim(host, gitlab);
  if (isHostOf(host, "bitbucket.org", "bitbucket")) {
    const match = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  if (isHostOf(host, "dev.azure.com") || host.endsWith(".visualstudio.com")) {
    const match = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  return null;
}

function claim(host: string, match: RegExpExecArray | null): ChangeRequestLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}
