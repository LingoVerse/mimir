import type { ReviewResult } from './review.ts';

export interface EscalationInput {
  // Changed lines across reviewable files (pre-truncation).
  totalChangedLines: number;
  // Whether the diff touches a security-sensitive surface (§5.2).
  securitySensitive: boolean;
  // The primary pass result.
  review: ReviewResult;
}

export interface EscalationDecision {
  escalate: boolean;
  // All matching triggers, for observability.
  reasons: string[];
}

function diffThreshold(): number {
  const n = Number(process.env.ESCALATION_DIFF_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

// Decide whether to re-review with the stronger model (build-spec §5). Escalate
// when ANY trigger fires; collect every matching reason so escalation rate and
// cause are observable in the run log.
export function decideEscalation(input: EscalationInput): EscalationDecision {
  const reasons: string[] = [];
  const threshold = diffThreshold();

  if (input.totalChangedLines > threshold) {
    reasons.push(`diff-size>${threshold} (${input.totalChangedLines} lines)`);
  }
  if (input.securitySensitive) {
    reasons.push('security-sensitive-path');
  }
  if (input.review.confidence === 'low') {
    reasons.push('low-confidence');
  }
  if (input.review.findings.some((f) => f.severity === 'critical')) {
    reasons.push('critical-finding');
  }

  return { escalate: reasons.length > 0, reasons };
}
