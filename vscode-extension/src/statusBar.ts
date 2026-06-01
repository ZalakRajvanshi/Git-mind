import * as vscode from "vscode";
import { GitlaneDb } from "./db";
import { dbPath, getProjectRoot } from "./env";
import * as fs from "fs";
import * as path from "path";

type GitRepo = {
  rootUri: vscode.Uri;
  state: {
    indexChanges: unknown[];
    workingTreeChanges: unknown[];
    onDidChange: vscode.Event<void>;
  };
};

type GitAPI = {
  repositories: GitRepo[];
  onDidOpenRepository: vscode.Event<GitRepo>;
};

export class StatusBar {
  private item: vscode.StatusBarItem;
  private streak = 0;
  private dbReady = false;
  private disposables: vscode.Disposable[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private dbWatcher: fs.FSWatcher | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "gitlane.showMenu";
    this.item.show();
    this.render();
  }

  async attach(): Promise<void> {
    await this.refresh();
    this.pollTimer = setInterval(() => this.refresh().catch(() => {}), 5 * 60 * 1000);
    this.watchDb();
    await this.wireGit();
  }

  /** Watches data/gitmind.db for changes (Python CLI / 6 PM tick writes) so the streak updates instantly. */
  private watchDb(): void {
    const root = getProjectRoot();
    if (!root) return;
    const file = dbPath(root);
    if (!fs.existsSync(file)) return;
    try {
      this.dbWatcher = fs.watch(file, { persistent: false }, () => {
        this.refresh().catch(() => {});
      });
    } catch {
      // best-effort
    }
  }

  private async wireGit(): Promise<void> {
    const gitExt = vscode.extensions.getExtension<{ getAPI(v: number): GitAPI }>("vscode.git");
    if (!gitExt) return;
    const git = (await gitExt.activate()).getAPI(1);
    const wire = (repoState: { onDidChange: vscode.Event<void> }) =>
      this.disposables.push(repoState.onDidChange(() => this.render()));
    git.repositories.forEach(r => wire(r.state));
    this.disposables.push(git.onDidOpenRepository(r => {
      // New repo appeared (could be from our own git init). Wire its change
      // events AND render immediately so the "git not initialized" label
      // flips to the real name + change count without waiting.
      wire(r.state);
      this.render();
    }));
    // Now that the git API is active, render once with real data.
    this.render();
  }

  async refresh(): Promise<void> {
    const root = getProjectRoot();
    if (!root || !fs.existsSync(dbPath(root))) {
      this.dbReady = false;
      this.render();
      return;
    }
    try {
      const db = new GitlaneDb(dbPath(root));
      const stats = await db.getStats();
      this.streak = stats.streak;
      this.dbReady = true;
    } catch {
      this.dbReady = false;
    }
    this.render();
  }

  /** Repo the user is actively editing in (follows the active editor). */
  private activeRepo(): GitRepo | undefined {
    const gitExt = vscode.extensions.getExtension<{ getAPI(v: number): GitAPI }>("vscode.git");
    if (!gitExt?.isActive) return undefined;
    const git = gitExt.exports.getAPI(1);
    if (git.repositories.length === 0) return undefined;
    if (git.repositories.length === 1) return git.repositories[0];

    // Multi-repo: pick the one that owns the active file.
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
      const hit = git.repositories.find(r => {
        const root = r.rootUri.fsPath;
        return active === root || active.startsWith(root + path.sep);
      });
      if (hit) return hit;
    }
    // No active file → fall back to the first workspace folder's repo, if any.
    const firstWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return git.repositories.find(r => r.rootUri.fsPath === firstWs) ?? git.repositories[0];
  }

  private repoName(repo: GitRepo): string {
    return path.basename(repo.rootUri.fsPath);
  }

  private dirtyCountFor(repo: GitRepo): number {
    return repo.state.indexChanges.length + repo.state.workingTreeChanges.length;
  }

  private render(): void {
    if (!this.dbReady) {
      this.item.text = "$(gear) Gitlane: set up";
      this.item.tooltip = "Click to pick the Gitlane project folder";
      this.item.backgroundColor = undefined;
      return;
    }

    const repo  = this.activeRepo();
    const dirty = repo ? this.dirtyCountFor(repo) : 0;
    const name  = repo ? this.repoName(repo) : undefined;

    const streakLine = this.streak > 0
      ? `🔥 ${this.streak} day streak`
      : "Working with Gitlane";

    if (dirty > 0 && name) {
      this.item.text = `≫ ${name} · ${dirty} change${dirty === 1 ? "" : "s"}`;
      this.item.tooltip = `${streakLine}\n${dirty} uncommitted change${dirty === 1 ? "" : "s"} in ${name}\n\nClick for menu`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }
    if (name) {
      this.item.text = this.streak > 0
        ? `≫ ${this.streak} day streak`
        : `≫ ${name}`;
      this.item.tooltip = `Working in ${name}\n${this.streak > 0 ? `${this.streak} day streak — nothing to commit` : "Nothing to commit"}\n\nClick for menu`;
      this.item.backgroundColor = undefined;
      return;
    }

    // No git repo detected. If a workspace folder is open, call it out so
    // the user knows the extension sees them — it's just waiting for git init.
    const ws = vscode.window.activeTextEditor
      ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
      : vscode.workspace.workspaceFolders?.[0];

    if (ws) {
      this.item.text = `≫ ${ws.name} · git not initialized`;
      this.item.tooltip =
        `${ws.name} isn't a git repository yet.\n\n` +
        `Click → "Commit now" — Gitlane will offer to initialize it for you.`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }

    this.item.text = this.streak > 0
      ? `≫ ${this.streak} day streak`
      : "≫ Gitlane ready";
    this.item.tooltip = "No folder open in VS Code\n\nClick for menu";
    this.item.backgroundColor = undefined;
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.dbWatcher?.close();
    this.disposables.forEach(d => d.dispose());
    this.item.dispose();
  }
}
