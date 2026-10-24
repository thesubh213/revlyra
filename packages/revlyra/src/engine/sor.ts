import type { AnalysisResult } from '@revlyra/core';
import { sha256Hex } from '@revlyra/core';
import type { RevlyraConfig } from '../config';
import type { ReviewRecord } from '../store/types';

export interface StatementOfReasons {
  spec: 'revlyra.sor/0.1';
  id: string;
  issuedFrom: string;
  territory: RevlyraConfig['governance']['sorTerritory'];
  review: { id: string; itemId: string; reviewerId: string; rating: number; submittedAt: string };
  decision: {
    decision: AnalysisResult['decision'];
    visibility: string;
    riskScore: number;
    band: string;
    confidence: number;
  };
  grounds: Array<{
    basis: string;
    codes: string[];
    facts: Array<{
      code: string;
      family: string;
      severity: number;
      confidence: number;
      explanation: string;
    }>;
  }>;
  automation: { used: boolean; tools: string[]; confidence: number; humanReviewRequired: boolean };
  redress: {
    internalComplaint: string;
    appealWindowDays: number;
    outOfCourtDisputeBody?: string;
    regulatorContent: string;
  };
  limitations: string;
  evidenceDigest: string;
}

const VISIBILITY: Record<AnalysisResult['decision'], string> = {
  allow: 'published (no integrity constraint)',
  label: 'published with integrity label',
  downrank: 'visibility demoted and excluded from the trust-weighted rating',
  hold: 'suspended pending human review',
  escalate: 'suspended pending human review and account/campaign investigation',
  remove: 'removed',
};

function groundsFor(result: AnalysisResult): StatementOfReasons['grounds'] {
  if (result.reasons.length === 0) {
    return [
      {
        basis:
          'Automated integrity assessment found no patterns associated with coordinated or fabricated content above the labelling threshold.',
        codes: [],
        facts: [],
      },
    ];
  }
  const byFamily = new Map<string, typeof result.reasons>();
  for (const reason of result.reasons) {
    const list = byFamily.get(reason.family) ?? [];
    list.push(reason);
    byFamily.set(reason.family, list);
  }
  return Array.from(byFamily.entries()).map(([family, reasons]) => ({
    basis:
      family === 'policy'
        ? 'Consumer-protection and safety policy in the operator terms (16 CFR Part 465 / platform policy)'
        : 'Integrity rules against engineered or coordinated review patterns in the operator terms',
    codes: reasons.map((reason) => reason.code),
    facts: reasons.map((reason) => ({
      code: reason.code,
      family: reason.family,
      severity: reason.severity,
      confidence: reason.confidence,
      explanation: reason.message,
    })),
  }));
}

export function buildStatementOfReasons(input: {
  review: ReviewRecord;
  result: AnalysisResult;
  config: RevlyraConfig;
}): StatementOfReasons {
  const { review, result, config } = input;
  const safety = result.safety;
  const digest = sha256Hex(
    JSON.stringify({
      reviewId: review.id,
      decision: result.decision,
      score: result.score,
      signals: result.signals.map((signal) => [
        signal.code,
        Number(signal.severity.toFixed(3)),
        Number(signal.confidence.toFixed(3)),
      ]),
      model: result.modelVersion,
      policy: result.policyVersion,
    }),
  );

  const grounds = groundsFor(result);
  if (safety?.routed) {
    grounds.push({
      basis:
        'Public-safety routing rule: reviews reporting physical-safety incidents are handled in a dedicated human channel and are never suppressed by presentation filters',
      codes: ['SAFETY_REVIEW'],
      facts: safety.categories.map((category) => ({
        code: 'SAFETY_REVIEW',
        family: 'policy',
        severity: 0.75,
        confidence: 0.75,
        explanation: `Safety category: ${category}`,
      })),
    });
  }

  return {
    spec: 'revlyra.sor/0.1',
    id: `sor_${digest.slice(0, 16)}`,
    issuedFrom: 'automated integrity engine (Revlyra)',
    territory: config.governance.sorTerritory,
    review: {
      id: review.id,
      itemId: review.itemId,
      reviewerId: review.reviewerId,
      rating: review.rating,
      submittedAt: review.submittedAt,
    },
    decision: {
      decision: result.decision,
      visibility: safety?.routed
        ? `${VISIBILITY[result.decision]} (safety routing: human safety channel)`
        : VISIBILITY[result.decision],
      riskScore: Number(result.score.toFixed(4)),
      band: result.band,
      confidence: Number(result.confidence.toFixed(4)),
    },
    grounds,
    automation: {
      used: true,
      tools: [
        `common integrity detectors@${result.policyVersion}`,
        `calibrated fusion model@${result.modelVersion}`,
      ],
      confidence: Number(result.confidence.toFixed(4)),
      humanReviewRequired:
        result.decision === 'hold' ||
        result.decision === 'escalate' ||
        result.decision === 'remove',
    },
    redress: {
      internalComplaint: 'POST /v1/appeals (free of charge; handled by qualified human staff)',
      appealWindowDays: config.governance.appealSlaDays,
      ...(config.governance.outOfCourtDisputeBody
        ? { outOfCourtDisputeBody: config.governance.outOfCourtDisputeBody }
        : {}),
      regulatorContent:
        config.governance.sorTerritory === 'EU'
          ? 'Complaints may be raised with the designated Digital Services Coordinator.'
          : 'Complaints may be raised with the competent consumer-protection regulator.',
    },
    limitations:
      'A high risk score means the pattern observed is unusual given tenant data; it is not proof that a review is fake. Risk calibration is tenant-dependent and reviewed against appeal outcomes.',
    evidenceDigest: digest,
  };
}

export function renderStatementOfReasonsMarkdown(sor: StatementOfReasons): string {
  const lines: string[] = [];
  lines.push(`# Statement of Reasons (${sor.spec})`);
  lines.push('');
  lines.push(`**Statement id:** ${sor.id}  `);
  lines.push(
    `**Review:** ${sor.review.id} (item ${sor.review.itemId}, reviewer ${sor.review.reviewerId})  `,
  );
  lines.push(`**Territory:** ${sor.territory}  `);
  lines.push(`**Decision:** ${sor.decision.decision} — visibility: ${sor.decision.visibility}  `);
  lines.push(
    `**Risk score:** ${sor.decision.riskScore} (band ${sor.decision.band}, confidence ${sor.decision.confidence})  `,
  );
  lines.push('');
  lines.push('## Grounds');
  for (const ground of sor.grounds) {
    lines.push(`- **${ground.basis}**`);
    for (const fact of ground.facts) {
      lines.push(
        `  - ${fact.code} (${fact.family}; severity ${Number(fact.severity.toFixed(2))}, confidence ${Number(fact.confidence.toFixed(2))}): ${fact.explanation}`,
      );
    }
  }
  lines.push('');
  lines.push('## Automation');
  lines.push(`- Tools: ${sor.automation.tools.join(', ')}`);
  lines.push(
    `- Human review ${sor.automation.humanReviewRequired ? 'required before further action' : 'not required for this step'}`,
  );
  lines.push('');
  lines.push('## Redress');
  lines.push(
    `- Internal complaint: ${sor.redress.internalComplaint} (response window ${sor.redress.appealWindowDays} days)`,
  );
  if (sor.redress.outOfCourtDisputeBody) {
    lines.push(`- Out-of-court dispute body: ${sor.redress.outOfCourtDisputeBody}`);
  }
  lines.push(`- ${sor.redress.regulatorContent}`);
  lines.push('');
  lines.push(`Calibration limitations: ${sor.limitations}`);
  lines.push('');
  lines.push(`Integrity digest: ${sor.evidenceDigest}`);
  return `${lines.join('\n')}\n`;
}
