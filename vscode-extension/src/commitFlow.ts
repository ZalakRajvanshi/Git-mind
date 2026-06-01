import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ensureProjectRoot, readEnv, loadSettingsJson, dbPath } from "./env";
import { GitlaneDb } from "./db";
import { generateCommitMessage, modelFromSettings } from "./groq";
import { createRepo, getRepoIfExists } from "./github";
import { scanFile, autofixFile, ensureGitignore, appendToGitignore, BLOCKED_FILENAMES, Finding } from "./scanner";
import * as git from "./gitOps";
import { getLastRepoPath, setLastRepoPath } from "./state";

/**
 * Pick which workspace folder to commit into. Priority:
 *   1. Active editor's workspace folder (you committed where you're typing)
 *   2. Last folder you committed to in this workspace
 *   3. Quick-pick over all workspace folders, with last-used marked
 *
 * Single-folder workspaces skip the picker entirely.
 */
async function pickRepoPath(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Open a folder in VS Code to use Gitlane.");
    return;
  }
  if (folders.length === 1) {
    setLastRepoPath(folders[0].uri.fsPath);
    return folders[0].uri.fsPath;
  }

  // The folder of the file you're currently editing wins.
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const owner = vscode.workspace.getWorkspaceFolder(activeUri);
    if (owner) {
      setLastRepoPath(owner.uri.fsPath);
      return owner.uri.fsPath;
    }
  }

  // Otherwise show the picker, with the last-used folder marked.
  const last = getLastRepoPath();
  const items = folders.map(f => ({
    label: f.name + (f.uri.fsPath === last ? "  $(history) last used" : ""),
    description: f.uri.fsPath,
    path: f.uri.fsPath,
  }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Which workspace folder?" });
  if (pick?.path) setLastRepoPath(pick.path);
  return pick?.path;
}

export async function runCommitFlow(): Promise<void> {
  const projectRoot = await ensureProjectRoot();
  if (!projectRoot) return;

  const repoPath = await pickRepoPath();
  if (!repoPath) return;

  const env = readEnv(projectRoot);
  if (!env.GROQ_API_KEY) {
    vscode.window.showErrorMessage(
      "GROQ_API_KEY missing from .env in the Gitlane project folder.",
    );
    return;
  }

  // Brand-new folder that hasn't been git-init'd yet: offer to do it now so
  // the rest of the flow (auto .gitignore, secret scan, auto-create GitHub
  // repo on push) works on first-touch projects.
  if (!(await git.isGitRepo(repoPath))) {
    const folderName = path.basename(repoPath);
    const choice = await vscode.window.showInformationMessage(
      `"${folderName}" isn't a git repository yet. Initialize one and continue?`,
      { modal: true }, "Initialize git",
    );
    if (choice !== "Initialize git") return;
    const r = await git.init(repoPath);
    if (!r.ok) {
      vscode.window.showErrorMessage(`git init failed: ${r.err}`);
      return;
    }
    // VS Code's git extension auto-detects the new .git within a tick — the
    // status bar refreshes itself via onDidOpenRepository (see statusBar.ts).
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Gitlane", cancellable: false },
      async progress => {
        progress.report({ message: "Checking repo…" });
        const created = ensureGitignore(repoPath);
        if (created) vscode.window.showInformationMessage("Created .gitignore with safe defaults.");

        const unstaged = await git.unstagedFiles(repoPath);
        if (unstaged.length === 0) {
          // Maybe the user committed earlier and just hasn't pushed yet.
          if (await git.hasRemote(repoPath)) {
            const ahead = await git.commitsAhead(repoPath);
            if (ahead > 0) {
              const pushChoice = await vscode.window.showInformationMessage(
                `Nothing new to commit, but you have ${ahead} commit${ahead === 1 ? "" : "s"} not pushed yet. Push now?`,
                { modal: false }, "Push",
              );
              if (pushChoice === "Push") {
                progress.report({ message: "Pushing…" });
                const p = await git.push(repoPath);
                if (!p.ok) {
                  vscode.window.showErrorMessage(`Push failed: ${p.out}`);
                  return;
                }
                const url = await git.remoteUrl(repoPath);
                vscode.window.showInformationMessage(`🚀 Pushed${url ? `: ${url}` : ""}.`);
              }
              return;
            }
          }
          vscode.window.showInformationMessage("Nothing to commit.");
          return;
        }

        progress.report({ message: "Staging + scanning for secrets…" });
        const stage = await git.stageAll(repoPath);
        if (!stage.ok) {
          vscode.window.showErrorMessage(`git add failed: ${stage.err}`);
          return;
        }

        let staged = await git.stagedFiles(repoPath);
        const blocked: string[] = [];
        const findings: Record<string, Finding[]> = {};
        for (const fname of staged) {
          if (BLOCKED_FILENAMES.has(path.basename(fname))) {
            blocked.push(fname);
            continue;
          }
          const fs_ = scanFile(path.join(repoPath, fname));
          if (fs_.length) findings[fname] = fs_;
        }

        if (blocked.length) {
          appendToGitignore(repoPath, blocked.map(f => path.basename(f)));
          for (const f of blocked) await git.unstage(repoPath, f);
          vscode.window.showWarningMessage(
            `Auto-unstaged + added to .gitignore: ${blocked.join(", ")}`,
          );
          staged = await git.stagedFiles(repoPath);
        }

        const findingFiles = Object.keys(findings);
        if (findingFiles.length) {
          const summary = findingFiles.map(f => `  • ${f} (${findings[f].length})`).join("\n");
          const choice = await vscode.window.showWarningMessage(
            `Sensitive values found in:\n${summary}\n\nMove them to .env and replace with env-var references?`,
            { modal: true }, "Auto-fix", "Unstage these files",
          );
          if (choice === "Auto-fix") {
            progress.report({ message: "Moving secrets to .env…" });
            appendToGitignore(repoPath, [".env"]);
            const envFile = path.join(repoPath, ".env");
            if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, "");
            for (const f of findingFiles) {
              autofixFile(path.join(repoPath, f), findings[f], envFile);
            }
            await git.stageAll(repoPath);
            await git.unstage(repoPath, ".env");
            staged = await git.stagedFiles(repoPath);
          } else if (choice === "Unstage these files") {
            for (const f of findingFiles) await git.unstage(repoPath, f);
            staged = await git.stagedFiles(repoPath);
          } else {
            return;
          }
        }

        if (staged.length === 0) {
          vscode.window.showInformationMessage("Nothing left to commit.");
          return;
        }

        const description = await vscode.window.showInputBox({
          prompt: "What did you change? (one line — Gitlane writes the full message)",
          placeHolder: "e.g. add password reset flow",
        });
        if (description === undefined) return;

        progress.report({ message: "Generating commit message…" });
        const diff = await git.stagedDiff(repoPath);
        const settings = loadSettingsJson(projectRoot);
        const username = (settings.github_username as string) || "";
        const model = modelFromSettings(projectRoot);
        const message = await generateCommitMessage(
          { apiKey: env.GROQ_API_KEY!, model },
          staged,
          diff || description,
        );

        const action = await vscode.window.showInformationMessage(
          `Commit message:\n\n${message}`,
          { modal: true }, "Commit + Push", "Commit only", "Edit message",
        );
        if (!action) return;

        let finalMsg = message;
        if (action === "Edit message") {
          const edited = await vscode.window.showInputBox({ value: message, prompt: "Edit commit message" });
          if (!edited) return;
          finalMsg = edited;
        }

        progress.report({ message: "Committing…" });
        const c = await git.commit(repoPath, finalMsg);
        if (!c.ok) {
          vscode.window.showErrorMessage(`Commit failed: ${c.out}`);
          return;
        }

        // Mirror the Python flow: write today's log to the shared DB so the
        // 6 PM digest + dashboard see the activity.
        try {
          const db = new GitlaneDb(dbPath(projectRoot));
          await db.upsertDay("committed", finalMsg, [path.basename(repoPath)]);
        } catch {
          // non-fatal
        }

        if (action === "Commit only") {
          vscode.window.showInformationMessage("✅ Committed (local).");
          return;
        }

        progress.report({ message: "Pushing…" });
        if (!(await git.hasRemote(repoPath))) {
          if (!env.GITHUB_TOKEN) {
            vscode.window.showErrorMessage("No GitHub remote and no GITHUB_TOKEN to create one. Committed locally.");
            return;
          }

          const defaultName = path.basename(repoPath).toLowerCase().replace(/[ _]/g, "-");

          // Auto-detect: do you already have a GitHub repo whose name matches
          // this folder? If yes, offer to link instead of trying to create one
          // (which would 422 with "already exists").
          if (username) {
            progress.report({ message: `Checking github.com/${username}/${defaultName}…` });
            const existing = await getRepoIfExists(env.GITHUB_TOKEN, username, defaultName);
            if (existing) {
              const choice = await vscode.window.showInformationMessage(
                `Found existing GitHub repo "${username}/${existing.name}". Link this folder to it and push?`,
                { modal: true }, "Link and push", "Create a different repo",
              );
              if (!choice) return;
              if (choice === "Link and push") {
                progress.report({ message: "Linking + pushing…" });
                const sp = await git.setOriginAndPush(repoPath, existing.clone_url);
                if (!sp.ok) {
                  vscode.window.showErrorMessage(`Linked but push failed: ${sp.out}`);
                  return;
                }
                vscode.window.showInformationMessage(`🚀 Pushed: ${existing.html_url}`);
                return;
              }
              // "Create a different repo" → fall through
            }
          }

          // Either no auto-match, no username, or user chose to create a new one.
          const name = await vscode.window.showInputBox({
            prompt: "Name for the new GitHub repo:",
            value: defaultName,
          });
          if (!name) return;
          const visibility = await vscode.window.showQuickPick(["private", "public"], { placeHolder: "Visibility" });
          if (!visibility) return;
          const r = await createRepo(env.GITHUB_TOKEN, name, visibility === "private");
          if (!r.ok) {
            vscode.window.showErrorMessage(`GitHub: ${r.error}`);
            return;
          }
          const sp = await git.setOriginAndPush(repoPath, r.clone_url);
          if (!sp.ok) {
            vscode.window.showErrorMessage(`Repo created but push failed: ${sp.out}`);
            return;
          }
          vscode.window.showInformationMessage(
            `🚀 Pushed: https://github.com/${username}/${name}`,
          );
          return;
        }

        const p = await git.push(repoPath);
        if (!p.ok) {
          vscode.window.showErrorMessage(`Push failed: ${p.out}`);
          return;
        }
        const url = await git.remoteUrl(repoPath);
        vscode.window.showInformationMessage(`🚀 Pushed${url ? `: ${url}` : ""}.`);
      },
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(`Gitlane: ${e.message || e}`);
  }
}
