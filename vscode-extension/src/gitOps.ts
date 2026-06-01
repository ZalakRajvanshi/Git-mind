import { spawn } from "child_process";

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", d => stdout += d.toString());
    p.stderr.on("data", d => stderr += d.toString());
    p.on("close", code => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.on("error", err => resolve({ code: 1, stdout: "", stderr: err.message }));
  });
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const r = await run("git", ["rev-parse", "--is-inside-work-tree"], repoPath);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function init(repoPath: string): Promise<{ ok: boolean; err: string }> {
  const r = await run("git", ["init", "-b", "main"], repoPath);
  if (r.code !== 0) {
    // Older git versions don't support -b; fall back.
    const r2 = await run("git", ["init"], repoPath);
    return { ok: r2.code === 0, err: r2.stderr || r2.stdout };
  }
  return { ok: true, err: "" };
}

export async function unstagedFiles(repoPath: string): Promise<string[]> {
  const r = await run("git", ["status", "--short"], repoPath);
  return r.stdout.split("\n").filter(Boolean).map(l => l.slice(2).trim());
}

export async function stagedFiles(repoPath: string): Promise<string[]> {
  const r = await run("git", ["diff", "--staged", "--name-only"], repoPath);
  return r.stdout.split("\n").filter(Boolean);
}

export async function stageAll(repoPath: string): Promise<{ ok: boolean; err: string }> {
  const r = await run("git", ["add", "-A"], repoPath);
  return { ok: r.code === 0, err: r.stderr || r.stdout };
}

export async function unstage(repoPath: string, file: string): Promise<void> {
  await run("git", ["reset", "HEAD", file], repoPath);
}

export async function stagedDiff(repoPath: string): Promise<string> {
  const r = await run("git", ["diff", "--staged", "--stat"], repoPath);
  return r.stdout.slice(0, 600);
}

export async function currentBranch(repoPath: string): Promise<string> {
  const r = await run("git", ["branch", "--show-current"], repoPath);
  return r.stdout || "main";
}

export async function hasRemote(repoPath: string): Promise<boolean> {
  const r = await run("git", ["remote"], repoPath);
  return r.stdout.trim().length > 0;
}

export async function commit(repoPath: string, message: string): Promise<{ ok: boolean; out: string }> {
  const r = await run("git", ["commit", "-m", message], repoPath);
  return { ok: r.code === 0, out: r.code === 0 ? r.stdout : (r.stderr || r.stdout) };
}

export async function push(repoPath: string): Promise<{ ok: boolean; out: string }> {
  let r = await run("git", ["push"], repoPath);
  if (r.code === 0) return { ok: true, out: r.stdout || "Pushed" };
  r = await run("git", ["push", "--set-upstream", "origin", "HEAD"], repoPath);
  return { ok: r.code === 0, out: r.code === 0 ? (r.stdout || "Pushed") : (r.stderr || "Push failed") };
}

/**
 * Wire up origin and push. Handles the common scenario 2 gotcha: the user
 * created the GitHub repo with "Initialize with README" checked, so the
 * remote already has a commit our local doesn't. A plain push -u is then
 * rejected as non-fast-forward.
 *
 * On non-fast-forward: fetch origin + rebase local on top of the existing
 * remote history (with --allow-unrelated-histories for the empty-local case),
 * then retry the push. If the rebase hits conflicts, surface them clearly.
 */
export async function setOriginAndPush(repoPath: string, cloneUrl: string): Promise<{ ok: boolean; out: string }> {
  await run("git", ["remote", "remove", "origin"], repoPath);
  const add = await run("git", ["remote", "add", "origin", cloneUrl], repoPath);
  if (add.code !== 0) return { ok: false, out: add.stderr };

  let push = await run("git", ["push", "-u", "origin", "HEAD"], repoPath);
  if (push.code === 0) return { ok: true, out: push.stdout || "Pushed" };

  const errBlob = `${push.stderr}\n${push.stdout}`;
  const isNonFastForward = /non-fast-forward|fetch first|updates were rejected/i.test(errBlob);
  if (!isNonFastForward) {
    return { ok: false, out: push.stderr || push.stdout };
  }

  // Remote has commits we don't have (typically the README from GitHub's
  // "initialize this repository" option). Pull-rebase, then re-push.
  const branchInfo = await run("git", ["branch", "--show-current"], repoPath);
  const branch = branchInfo.stdout.trim() || "main";

  const fetch = await run("git", ["fetch", "origin"], repoPath);
  if (fetch.code !== 0) {
    return { ok: false, out: `Fetch failed:\n${fetch.stderr || fetch.stdout}` };
  }

  const rebase = await run(
    "git",
    ["pull", "--rebase", "--allow-unrelated-histories", "origin", branch],
    repoPath,
  );
  if (rebase.code !== 0) {
    return {
      ok: false,
      out:
        `The GitHub repo has files we don't have locally and they couldn't be merged automatically.\n` +
        `Resolve the conflicts in your editor, then run: git rebase --continue && git push -u origin HEAD\n\n` +
        `${rebase.stderr || rebase.stdout}`,
    };
  }

  push = await run("git", ["push", "-u", "origin", "HEAD"], repoPath);
  if (push.code === 0) return { ok: true, out: push.stdout || "Pushed after pulling existing GitHub content" };
  return { ok: false, out: push.stderr || push.stdout };
}

/**
 * How many local commits are ahead of the remote tracking branch. Used to
 * detect "nothing new to commit, but local has unpushed commits."
 *
 * If origin/<branch> doesn't exist (never fetched — e.g. bogus remote URL
 * never reached, or first push never happened), fall back to counting ALL
 * local commits — none of them have been pushed.
 */
export async function commitsAhead(repoPath: string): Promise<number> {
  const branchInfo = await run("git", ["branch", "--show-current"], repoPath);
  const branch = branchInfo.stdout.trim();
  if (!branch) return 0;
  const r = await run("git", ["rev-list", "--count", `origin/${branch}..HEAD`], repoPath);
  if (r.code === 0) return parseInt(r.stdout.trim(), 10) || 0;
  const all = await run("git", ["rev-list", "--count", "HEAD"], repoPath);
  if (all.code !== 0) return 0;
  return parseInt(all.stdout.trim(), 10) || 0;
}

/**
 * Returns the origin URL if it looks like an unfilled template
 * (YOUR_USERNAME, <username>, <your_…>, etc.) rather than a real GitHub repo.
 * These come from scaffolders or copy-pasted README snippets and silently
 * break every push until fixed.
 */
export async function placeholderRemoteUrl(repoPath: string): Promise<string | null> {
  const r = await run("git", ["remote", "get-url", "origin"], repoPath);
  if (r.code !== 0) return null;
  const url = r.stdout.trim();
  if (!url) return null;
  const placeholders = [
    /your[_-]?username/i,
    /<[^>]*username[^>]*>/i,
    /<your[_-]/i,
    /example\.com/i,
    /user\/repo\.git/i,
  ];
  return placeholders.some(p => p.test(url)) ? url : null;
}

export async function setRemoteUrl(repoPath: string, url: string): Promise<{ ok: boolean; err: string }> {
  const r = await run("git", ["remote", "set-url", "origin", url], repoPath);
  return { ok: r.code === 0, err: r.stderr || r.stdout };
}

export async function remoteUrl(repoPath: string): Promise<string> {
  const r = await run("git", ["remote", "get-url", "origin"], repoPath);
  let url = r.stdout;
  if (url.endsWith(".git")) url = url.slice(0, -4);
  if (url.startsWith("git@github.com:")) {
    url = "https://github.com/" + url.slice("git@github.com:".length);
  }
  return url;
}
