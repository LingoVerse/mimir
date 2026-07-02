export interface RepoSandboxRunInput {
  archive?: Uint8Array;
  checkoutKey: string;
  command: string;
  timeoutMs: number;
  maxOutputChars: number;
  sandboxId: string;
}

export interface RepoSandboxRunResult {
  output: string;
}

export type RepoSandboxRunner = (input: RepoSandboxRunInput) => Promise<RepoSandboxRunResult>;

export type RepoSandboxCheckoutProbe = (input: {
  checkoutKey: string;
  sandboxId: string;
}) => Promise<boolean>;

export type RepoSandboxDestroyer = (sandboxId: string) => Promise<void>;
