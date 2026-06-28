import type { ReviewResult } from "./review.ts";

export interface EscalationInput {
  // Changed lines across reviewable files (pre-truncation).
  totalChangedLines: number;
  // Whether the diff touches a security-sensitive surface (§5.2).
  securitySensitive: boolean;
  // The primary pass result.
  review: ReviewResult;
  // Files matching security-sensitive patterns (populated when securitySensitive is true).
  sensitiveFiles?: string[];
}

export interface EscalationDecision {
  escalate: boolean;
  // All matching triggers, for observability.
  reasons: string[];
  // Files the escalation pass should prioritise (undefined = full review).
  scopeFiles?: string[];
}

function diffThreshold(): number {
  const n = Number(process.env.ESCALATION_DIFF_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

function escalateSecurityAlways(): boolean {
  return process.env.ESCALATE_SECURITY_ALWAYS !== "false";
}

// Decide whether to re-review with the stronger model (build-spec §5). Escalate
// when ANY trigger fires; collect every matching reason so escalation rate and
// cause are observable in the run log.
// When the trigger is specific to certain files (security paths, critical findings),
// `scopeFiles` lists them so the escalation pass can focus rather than re-reviewing
// the entire diff.
export function decideEscalation(input: EscalationInput): EscalationDecision {
  const reasons: string[] = [];
  const threshold = diffThreshold();
  let scopeFiles: string[] | undefined;

  if (input.totalChangedLines > threshold) {
    reasons.push(`diff-size>${threshold} (${input.totalChangedLines} lines)`);
  }
  if (
    input.securitySensitive &&
    (escalateSecurityAlways() || input.review.findings.some((f) => f.severity !== "nit"))
  ) {
    reasons.push("security-sensitive-path");
    if (input.sensitiveFiles?.length) {
      (scopeFiles ??= []).push(...input.sensitiveFiles);
    }
  }
  if (input.review.confidence === "low") {
    reasons.push("low-confidence");
  }
  const criticalFiles = input.review.findings
    .filter((f) => f.severity === "critical")
    .map((f) => f.file);
  if (criticalFiles.length > 0) {
    reasons.push("critical-finding");
    (scopeFiles ??= []).push(...new Set(criticalFiles));
  }

  if (scopeFiles) {
    scopeFiles = [...new Set(scopeFiles)]; // deduplicate
  }

  return { escalate: reasons.length > 0, reasons, scopeFiles };
}
