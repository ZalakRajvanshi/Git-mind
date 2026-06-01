import * as vscode from "vscode";
import { StatusBar } from "./statusBar";
import { runCommitFlow } from "./commitFlow";
import { ensureProjectRoot, readEnv, loadSettingsJson, dbPath } from "./env";
import { GitlaneDb } from "./db";
import { answerQuestion, modelFromSettings } from "./groq";
import { fetchAllRecent } from "./github";
import { setContext } from "./state";
import { generateCommitMessageCommand } from "./scmCommand";

let statusBar: StatusBar | undefined;

export function activate(context: vscode.ExtensionContext): void {
  setContext(context);
  statusBar = new StatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Status bar's project label follows the active editor + the open folders.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => statusBar?.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => statusBar?.refresh()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitlane.commitNow",             runCommitFlow),
    vscode.commands.registerCommand("gitlane.generateCommitMessage", generateCommitMessageCommand),
    vscode.commands.registerCommand("gitlane.ask",                   askQuestion),
    vscode.commands.registerCommand("gitlane.openDashboard",         openDashboard),
    vscode.commands.registerCommand("gitlane.showMenu",              showMenu),
  );

  // Off the activation hot path: project-root prompt (first run only) + initial refresh.
  statusBar.attach().catch(err => console.error("[gitlane] status bar attach failed:", err));
  void ensureProjectRoot();
}

export function deactivate(): void {
  statusBar?.dispose();
}

function openDashboard(): void {
  const url = vscode.workspace.getConfiguration("gitlane").get<string>("dashboardUrl", "http://localhost:7123");
  vscode.env.openExternal(vscode.Uri.parse(url));
}

async function askQuestion(): Promise<void> {
  const root = await ensureProjectRoot();
  if (!root) return;

  const env = readEnv(root);
  if (!env.GROQ_API_KEY) {
    vscode.window.showErrorMessage("GROQ_API_KEY missing from the project's .env file.");
    return;
  }

  const settings = loadSettingsJson(root);
  const username = (settings.github_username as string) || "";
  if (!username) {
    vscode.window.showErrorMessage("github_username missing from settings.json in the project folder.");
    return;
  }

  const question = await vscode.window.showInputBox({ prompt: "Ask Gitlane anything about your work" });
  if (!question) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Gitlane", cancellable: false },
    async progress => {
      progress.report({ message: "Fetching commits + thinking…" });
      try {
        const commits = await fetchAllRecent(env.GITHUB_TOKEN, username, 7);
        const db = new GitlaneDb(dbPath(root));
        const memory = await db.getMemory();
        const answer = await answerQuestion(
          { apiKey: env.GROQ_API_KEY!, model: modelFromSettings(root) },
          username,
          memory,
          question,
          commits,
        );
        const doc = await vscode.workspace.openTextDocument({
          content: `Q: ${question}\n\n${answer}`, language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Gitlane: ${e.message || e}`);
      }
    },
  );
}

async function showMenu(): Promise<void> {
  const items: vscode.QuickPickItem[] = [
    { label: "$(git-commit) Commit now",  description: "Stage, scan secrets, generate message, push" },
    { label: "$(question) Ask Gitlane",   description: "What did I work on this week?" },
    { label: "$(browser) Open dashboard", description: "Browser dashboard (requires Python server running)" },
    { label: "$(gear) Pick project folder", description: "Change the Gitlane project location" },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Gitlane" });
  if (!pick) return;
  if (pick.label.includes("Commit now"))            return runCommitFlow();
  if (pick.label.includes("Ask Gitlane"))           return askQuestion();
  if (pick.label.includes("Open dashboard"))        return openDashboard();
  if (pick.label.includes("Pick project folder")) {
    await vscode.workspace.getConfiguration().update("gitlane.projectRoot", "", vscode.ConfigurationTarget.Global);
    await ensureProjectRoot();
    await statusBar?.refresh();
  }
}
