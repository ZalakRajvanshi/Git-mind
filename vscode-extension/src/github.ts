const API = "https://api.github.com";

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { "Accept": "application/vnd.github.v3+json" };
  if (token) h["Authorization"] = `token ${token}`;
  return h;
}

export interface RawCommit { sha: string; repo: string; message: string; date: string; }

async function ghGet(path: string, token?: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { headers: headers(token) });
  if (!res.ok) {
    if (res.status === 404 || res.status === 409) return null;
    throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function listOwnRepos(token?: string, username?: string): Promise<Array<{ name: string }>> {
  const endpoint = token ? "/user/repos?per_page=100&sort=updated&affiliation=owner"
                         : `/users/${username}/repos?per_page=100&sort=updated`;
  const data = await ghGet(endpoint, token);
  return Array.isArray(data) ? data : [];
}

export async function getCommitsForRepo(
  token: string | undefined,
  username: string,
  repo: string,
  sinceDays: number,
): Promise<RawCommit[]> {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const data = await ghGet(
    `/repos/${username}/${repo}/commits?author=${username}&since=${since}&per_page=50`,
    token,
  );
  if (!Array.isArray(data)) return [];
  return data.map((c: any) => ({
    sha:     c.sha.slice(0, 7),
    repo,
    message: (c.commit?.message ?? "").split("\n")[0],
    date:    (c.commit?.author?.date ?? "").slice(0, 10),
  }));
}

export async function fetchAllRecent(
  token: string | undefined,
  username: string,
  sinceDays = 7,
): Promise<RawCommit[]> {
  const repos = await listOwnRepos(token, username);
  const all: RawCommit[] = [];
  for (const r of repos) {
    const commits = await getCommitsForRepo(token, username, r.name, sinceDays);
    all.push(...commits);
  }
  all.sort((a, b) => b.date.localeCompare(a.date));
  return all;
}

/**
 * Look up a specific repo on the user's GitHub. Returns null if missing,
 * 404'd, or the request errored — caller treats that as "create a new one."
 * With a token this finds private repos too; without, only public.
 */
export async function getRepoIfExists(
  token: string | undefined,
  username: string,
  repo: string,
): Promise<{ name: string; clone_url: string; html_url: string; private: boolean } | null> {
  try {
    const res = await fetch(`${API}/repos/${username}/${repo}`, { headers: headers(token) });
    if (!res.ok) return null;
    const data: any = await res.json();
    return {
      name:      data.name,
      clone_url: data.clone_url,
      html_url:  data.html_url,
      private:   data.private,
    };
  } catch {
    return null;
  }
}

export async function createRepo(
  token: string,
  name: string,
  isPrivate: boolean,
): Promise<{ ok: true; clone_url: string } | { ok: false; error: string }> {
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
  });
  if (res.status === 201) {
    const data: any = await res.json();
    return { ok: true, clone_url: data.clone_url };
  }
  if (res.status === 422) return { ok: false, error: `Repo '${name}' already exists on GitHub.` };
  const text = await res.text();
  return { ok: false, error: `GitHub API ${res.status}: ${text}` };
}
