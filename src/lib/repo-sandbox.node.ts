import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  RepoSandboxCheckoutProbe,
  RepoSandboxDestroyer,
  RepoSandboxRunner,
} from "./repo-sandbox-types.ts";

const execFileAsync = promisify(execFile);

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`
    : text;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 180);
}

function ttlMs(): number {
  const raw = Number(process.env.REPO_SANDBOX_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1_000;
}

async function cleanupStaleSandboxes(root: string): Promise<void> {
  const cutoff = Date.now() - ttlMs();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dir = join(root, entry.name);
          const info = await stat(dir).catch(() => null);
          if (info && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
        }),
    );
  } catch {
    // Missing root is fine; next mkdir creates it.
  }
}

function paths(sandboxId: string): { sandboxRoot: string; archivePath: string; checkoutPath: string; markerPath: string } {
  const sandboxRoot = join(tmpdir(), "mimir-repo-sandboxes", safeId(sandboxId));
  return {
    sandboxRoot,
    archivePath: join(sandboxRoot, "repo.tar.gz"),
    checkoutPath: join(sandboxRoot, "repo"),
    markerPath: join(sandboxRoot, ".mimir-checkout"),
  };
}

export const repoSandboxNeedsArchive: RepoSandboxCheckoutProbe = async ({ checkoutKey, sandboxId }) => {
  const { markerPath } = paths(sandboxId);
  const existingKey = await readFile(markerPath, "utf8").catch(() => null);
  return existingKey !== checkoutKey;
};

export const destroyRepoSandbox: RepoSandboxDestroyer = async (sandboxId) => {
  const { sandboxRoot } = paths(sandboxId);
  await rm(sandboxRoot, { recursive: true, force: true });
};

export const runRepoSandboxCommand: RepoSandboxRunner = async ({
  archive,
  checkoutKey,
  command,
  timeoutMs,
  maxOutputChars,
  sandboxId,
}) => {
  const root = join(tmpdir(), "mimir-repo-sandboxes");
  await cleanupStaleSandboxes(root);
  const { sandboxRoot, archivePath, checkoutPath, markerPath } = paths(sandboxId);
  await mkdir(sandboxRoot, { recursive: true });

  const existingKey = await readFile(markerPath, "utf8").catch(() => null);
  if (existingKey !== checkoutKey) {
    if (!archive) throw new Error("Repo archive is required to prepare sandbox checkout.");
    await rm(checkoutPath, { recursive: true, force: true });
    await mkdir(checkoutPath, { recursive: true });
    await writeFile(archivePath, archive);
    await execFileAsync(
      "tar",
      ["--no-same-owner", "-xzf", archivePath, "-C", checkoutPath, "--strip-components", "1"],
      { timeout: 30_000 },
    );
    await writeFile(markerPath, checkoutKey);
  }

  try {
    const executable = command.trim().split(/\s+/, 1)[0];
    if (executable) {
      await execFileAsync("/usr/bin/env", ["sh", "-c", `command -v ${executable}`], {
        timeout: 5_000,
      });
    }
    const result = await execFileAsync("/bin/sh", ["-c", command], {
      cwd: checkoutPath,
      timeout: timeoutMs,
      maxBuffer: maxOutputChars * 4,
    });
    return { output: truncate([result.stdout, result.stderr].filter(Boolean).join("\n"), maxOutputChars) };
  } finally {
    const now = new Date();
    await utimes(sandboxRoot, now, now).catch(() => undefined);
  }
};
