import { getSandbox } from "@cloudflare/sandbox";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@flue/runtime/cloudflare";
import type {
  RepoSandboxCheckoutProbe,
  RepoSandboxDestroyer,
  RepoSandboxRunner,
} from "./repo-sandbox-types.ts";

type SandboxEnv = {
  Sandbox?: DurableObjectNamespace;
};

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 180);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`
    : text;
}

function sandboxFor(sandboxId: string) {
  const env = getCloudflareContext().env as SandboxEnv;
  if (!env.Sandbox) {
    throw new Error("Cloudflare Sandbox binding `Sandbox` is not configured.");
  }
  const safeSandboxId = safeId(sandboxId);
  const workspace = `/workspace/mimir/${safeSandboxId}`;
  return {
    sandbox: getSandbox(env.Sandbox, safeSandboxId),
    workspace,
    checkoutPath: `${workspace}/repo`,
    archivePath: `${workspace}/repo.tar.gz`,
    markerPath: `${workspace}/.mimir-checkout`,
  };
}

export const repoSandboxNeedsArchive: RepoSandboxCheckoutProbe = async ({ checkoutKey, sandboxId }) => {
  const { sandbox, markerPath } = sandboxFor(sandboxId);
  const marker = await sandbox.exists(markerPath);
  if (!marker.exists) return true;
  const existingKey = (await sandbox.readFile(markerPath, { encoding: "utf-8" })).content;
  return existingKey !== checkoutKey;
};

export const destroyRepoSandbox: RepoSandboxDestroyer = async (sandboxId) => {
  const { sandbox } = sandboxFor(sandboxId);
  await sandbox.destroy();
};

export const runRepoSandboxCommand: RepoSandboxRunner = async ({
  archive,
  checkoutKey,
  command,
  timeoutMs,
  maxOutputChars,
  sandboxId,
}) => {
  const { sandbox, workspace, checkoutPath, archivePath, markerPath } = sandboxFor(sandboxId);

  await sandbox.mkdir(workspace, { recursive: true });
  const marker = await sandbox.exists(markerPath);
  const existingKey = marker.exists
    ? (await sandbox.readFile(markerPath, { encoding: "utf-8" })).content
    : null;

  if (existingKey !== checkoutKey) {
    if (!archive) throw new Error("Repo archive is required to prepare sandbox checkout.");
    await sandbox.exec(`rm -rf ${shellQuote(checkoutPath)} && mkdir -p ${shellQuote(checkoutPath)}`, {
      timeout: 30_000,
    });
    await sandbox.writeFile(archivePath, toBase64(archive), { encoding: "base64" });
    await sandbox.exec(
      `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(checkoutPath)} --strip-components 1`,
      { timeout: 30_000 },
    );
    await sandbox.writeFile(markerPath, checkoutKey);
  }

  const result = await sandbox.exec(command, { cwd: checkoutPath, timeout: timeoutMs });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return { output: truncate(output, maxOutputChars) };
};
