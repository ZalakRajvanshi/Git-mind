import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const PROJECT_ROOT_KEY = "gitlane.projectRoot";

export function getProjectRoot(): string {
  return vscode.workspace.getConfiguration().get<string>(PROJECT_ROOT_KEY, "").trim();
}

export async function setProjectRoot(p: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(PROJECT_ROOT_KEY, p, vscode.ConfigurationTarget.Global);
}

export function projectRootIsValid(p: string): boolean {
  if (!p) return false;
  return fs.existsSync(path.join(p, "main.py"))
      || fs.existsSync(path.join(p, "data", "gitmind.db"));
}

/**
 * Scan the user's usual places for a Gitlane install (a folder with main.py
 * + the agent/ module + or a data/gitmind.db). We try the common Windows /
 * macOS / Linux home locations the user is likely to have cloned it into.
 * Returns the first match, or undefined.
 *
 * The goal is to make the picker dialog never fire — the user is the same
 * person who cloned Gitlane somewhere, so 90% of the time we can just find it.
 */
export function autoDetectGitlaneInstall(): string | undefined {
  const home = os.homedir();
  const candidates = [
    // The exact location this conversation's author uses
    path.join(home, "OneDrive", "Desktop", "Projects", "gitmind_v2", "gitmind_v2"),
    path.join(home, "OneDrive", "Desktop", "gitmind_v2", "gitmind_v2"),
    path.join(home, "Desktop", "Projects", "gitmind_v2", "gitmind_v2"),
    path.join(home, "Desktop", "gitmind_v2", "gitmind_v2"),
    path.join(home, "gitmind_v2", "gitmind_v2"),
    path.join(home, "Projects", "gitmind_v2", "gitmind_v2"),

    // Common rename-to-"Gitlane" / "gitlane" locations
    path.join(home, "OneDrive", "Desktop", "Projects", "Gitlane"),
    path.join(home, "OneDrive", "Desktop", "Projects", "gitlane"),
    path.join(home, "OneDrive", "Desktop", "Gitlane"),
    path.join(home, "OneDrive", "Desktop", "gitlane"),
    path.join(home, "Desktop", "Projects", "Gitlane"),
    path.join(home, "Desktop", "Projects", "gitlane"),
    path.join(home, "Desktop", "Gitlane"),
    path.join(home, "Desktop", "gitlane"),
    path.join(home, "Projects", "Gitlane"),
    path.join(home, "Projects", "gitlane"),
    path.join(home, "Gitlane"),
    path.join(home, "gitlane"),

    // GitHub Desktop / IDE conventional locations
    path.join(home, "Documents", "GitHub", "Gitlane"),
    path.join(home, "Documents", "GitHub", "gitlane"),
    path.join(home, "OneDrive", "Documents", "GitHub", "Gitlane"),
    path.join(home, "OneDrive", "Documents", "GitHub", "gitlane"),
    path.join(home, "source", "repos", "Gitlane"),  // Visual Studio default
    path.join(home, "source", "repos", "gitlane"),
  ];

  for (const c of candidates) {
    if (projectRootIsValid(c)) return c;
  }
  return undefined;
}

export async function ensureProjectRoot(): Promise<string | undefined> {
  const current = getProjectRoot();
  if (current && projectRootIsValid(current)) return current;

  // Silent auto-detect: if we can find the install on this machine, just use
  // it. No dialog, no questions. This is the same machine that cloned Gitlane,
  // so 90% of the time we get it right and the user notices nothing.
  const auto = autoDetectGitlaneInstall();
  if (auto) {
    await setProjectRoot(auto);
    return auto;
  }

  const proceed = await vscode.window.showInformationMessage(
    "Gitlane needs to know where you cloned its source code (the folder with main.py). " +
    "This is the GITLANE PROJECT itself, not the project you want to commit. " +
    "You only pick this once.",
    { modal: false },
    "Pick Gitlane source folder", "Later",
  );
  if (proceed !== "Pick Gitlane source folder") return undefined;

  // Default the picker to the user's home so they don't accidentally land
  // inside their current project folder.
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(os.homedir()),
    openLabel: "Use as Gitlane source",
    title: "Pick the folder where you cloned github.com/ZalakRajvanshi/Gitlane (contains main.py)",
  });
  if (!picked || picked.length === 0) return undefined;

  const candidate = picked[0].fsPath;
  if (!projectRootIsValid(candidate)) {
    vscode.window.showErrorMessage(
      `That folder doesn't contain main.py — it's not the Gitlane source. ` +
      `Pick the folder you cloned from github.com/ZalakRajvanshi/Gitlane, not the project you want to commit.`,
    );
    return undefined;
  }
  await setProjectRoot(candidate);
  return candidate;
}

export interface EnvVars {
  GROQ_API_KEY?: string;
  GITHUB_TOKEN?: string;
}

export function readEnv(projectRoot: string): EnvVars {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return {};
  const out: EnvVars = {};
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "GROQ_API_KEY") out.GROQ_API_KEY = val;
    if (key === "GITHUB_TOKEN") out.GITHUB_TOKEN = val;
  }
  return out;
}

export function dbPath(projectRoot: string): string {
  return path.join(projectRoot, "data", "gitmind.db");
}

export function loadSettingsJson(projectRoot: string): Record<string, unknown> {
  const f = path.join(projectRoot, "settings.json");
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; }
}
