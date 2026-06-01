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

export async function setOriginAndPush(repoPath: string, cloneUrl: string): Promise<{ ok: boolean; out: string }> {
  await run("git", ["remote", "remove", "origin"], repoPath);
  const add = await run("git", ["remote", "add", "origin", cloneUrl], repoPath);
  if (add.code !== 0) return { ok: false, out: add.stderr };
  const push = await run("git", ["push", "-u", "origin", "HEAD"], repoPath);
  return { ok: push.code === 0, out: push.code === 0 ? push.stdout : (push.stderr || push.stdout) };
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
