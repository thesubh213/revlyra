import { analyzeReview, getPolicyPreset } from '../../packages/core/dist/index.js';
import { generateSyntheticCorpus } from '../synthetic/generator.mjs';

const policy = getPolicyPreset(process.env.REVLYRA_EVAL_POLICY ?? 'balanced');
const cases = generateSyntheticCorpus({
  cleanCount: Number(process.env.REVLYRA_EVAL_CLEAN ?? 200),
});

const predictions = cases.map((item) => {
  const result = analyzeReview(item.review, item.context, { policy });
  const positive = result.score >= 0.75;
  return {
    fake: item.fake,
    attack: item.attack,
    score: result.score,
    decision: result.decision,
    positive,
    codes: result.signals.map((signal) => signal.code),
    safetyRouted: result.safety?.routed ?? false,
    top: result.reasons[0]?.code ?? null,
  };
});

const positives = predictions.filter((item) => item.fake);
const negatives = predictions.filter((item) => !item.fake);
const truePositives = positives.filter((item) => item.positive).length;
const falseNegatives = positives.length - truePositives;
const falsePositives = negatives.filter((item) => item.positive).length;
const trueNegatives = negatives.length - falsePositives;

const precision = truePositives / Math.max(1, truePositives + falsePositives);
const recall = truePositives / Math.max(1, truePositives + falseNegatives);
const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
const fpr = falsePositives / Math.max(1, negatives.length);
const accuracy = (truePositives + trueNegatives) / predictions.length;

function auc(values) {
  const sorted = [...values].sort((a, b) => a.score - b.score);
  const positivesCount = sorted.filter((item) => item.fake).length;
  const negativesCount = sorted.length - positivesCount;
  if (positivesCount === 0 || negativesCount === 0) return 0;
  let rankSum = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].fake) rankSum += index + 1;
  }
  return (
    (rankSum - (positivesCount * (positivesCount + 1)) / 2) / (positivesCount * negativesCount)
  );
}

function averagePrecision(values) {
  const sorted = [...values].sort((a, b) => b.score - a.score);
  let tp = 0;
  let fp = 0;
  let previousRecall = 0;
  let area = 0;
  for (const item of sorted) {
    if (item.fake) tp += 1;
    else fp += 1;
    const currentRecall = tp / Math.max(1, positives.length);
    const currentPrecision = tp / Math.max(1, tp + fp);
    area += (currentRecall - previousRecall) * currentPrecision;
    previousRecall = currentRecall;
  }
  return area;
}

const byAttack = new Map();
for (const item of positives) {
  if (!item.attack) continue;
  const entry = byAttack.get(item.attack) ?? { total: 0, caught: 0 };
  entry.total += 1;
  if (item.positive) entry.caught += 1;
  byAttack.set(item.attack, entry);
}

// Expected-code checks (independent of the score-threshold gate): each new
// detector class must actually emit its reason code on the corpus rows that
// model it, and routed safety reviews must reach a human channel instead of a
// silent auto-removal.
const EXPECTED_CODES = {
  prompt_injection: ['TEXT_PROMPT_INJECTION'],
  conditional_incentive: ['POLICY_CONDITIONAL_INCENTIVE', 'POLICY_INCENTIVE_LANGUAGE'],
  suppression_offer: ['POLICY_REVIEW_SUPPRESSION_OFFER'],
  insider_undisclosed: ['POLICY_UNDISCLOSED_INSIDER'],
  safety_clean: ['SAFETY_REVIEW'],
};

const integrityChecks = {
  expectedCodes: [],
  safetyRouting: { total: 0, routed: 0, autoRemoved: 0 },
  failures: [],
};

for (const [attack, acceptedCodes] of Object.entries(EXPECTED_CODES)) {
  const rows = predictions.filter((item) => item.attack === attack);
  let matched = 0;
  for (const row of rows) {
    const hit = acceptedCodes.some((code) => row.codes.includes(code));
    if (hit) matched += 1;
    else integrityChecks.failures.push(`${attack}: missing ${acceptedCodes.join('|')}`);
  }
  integrityChecks.expectedCodes.push({
    attack,
    total: rows.length,
    matched,
  });
}

const safetyRows = predictions.filter((item) => item.attack === 'safety_clean');
integrityChecks.safetyRouting.total = safetyRows.length;
for (const row of safetyRows) {
  if (row.safetyRouted) integrityChecks.safetyRouting.routed += 1;
  else integrityChecks.failures.push('safety_clean: not routed through the human safety channel');
  if (row.decision === 'remove') integrityChecks.safetyRouting.autoRemoved += 1;
}

const report = {
  cases: predictions.length,
  attackCases: positives.length,
  cleanCases: negatives.length,
  threshold: 0.75,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  f1: Number(f1.toFixed(4)),
  falsePositiveRate: Number(fpr.toFixed(4)),
  accuracy: Number(accuracy.toFixed(4)),
  rocAuc: Number(auc(predictions).toFixed(4)),
  prAuc: Number(averagePrecision(predictions).toFixed(4)),
  perAttack: Object.fromEntries(
    [...byAttack.entries()].map(([attack, entry]) => [
      attack,
      {
        total: entry.total,
        caught: entry.caught,
        recall: Number((entry.caught / entry.total).toFixed(4)),
      },
    ]),
  ),
  integrityChecks: integrityChecks,
};

if (process.argv.includes('--json') || process.env.REVLYRA_EVAL_JSON === '1') {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Revlyra synthetic evaluation');
  console.log('-----------------------------');
  console.log(
    `cases          ${report.cases} (${report.attackCases} attack, ${report.cleanCases} clean)`,
  );
  console.log(`precision      ${report.precision}`);
  console.log(`recall         ${report.recall}`);
  console.log(`F1             ${report.f1}`);
  console.log(`false pos rate ${report.falsePositiveRate}`);
  console.log(`accuracy       ${report.accuracy}`);
  console.log(`ROC-AUC        ${report.rocAuc}`);
  console.log(`PR-AUC         ${report.prAuc}`);
  console.log('');
  console.log('Per attack:');
  for (const [attack, entry] of Object.entries(report.perAttack)) {
    console.log(`  ${attack.padEnd(18)} ${entry.caught}/${entry.total}  recall ${entry.recall}`);
  }
  console.log('');
  console.log('Integrity checks (code assertions):');
  for (const check of report.integrityChecks.expectedCodes) {
    console.log(`  ${check.attack.padEnd(24)} ${check.matched}/${check.total} emit expected code`);
  }
  console.log(
    `  safety routing           ${report.integrityChecks.safetyRouting.routed}/${report.integrityChecks.safetyRouting.total} routed, ${report.integrityChecks.safetyRouting.autoRemoved} auto-removed`,
  );
}

const failures = [];
if (recall < 0.85) failures.push(`recall ${recall.toFixed(3)} < 0.85`);
if (fpr > 0.03) failures.push(`FPR ${fpr.toFixed(3)} > 0.03`);
if (Number.isFinite(f1) && f1 < 0.85) failures.push(`F1 ${f1.toFixed(3)} < 0.85`);
if (report.integrityChecks.safetyRouting.total > 0) {
  if (report.integrityChecks.safetyRouting.routed !== report.integrityChecks.safetyRouting.total) {
    failures.push('safety_clean rows were not routed to the human channel');
  }
  if (report.integrityChecks.safetyRouting.autoRemoved > 0) {
    failures.push('safety_clean rows were auto-removed');
  }
}
for (const badCase of report.integrityChecks.failures) {
  failures.push(`integrity check: ${badCase}`);
}
if (failures.length > 0) {
  console.error(`\nEVAL GATE FAILED: ${failures.slice(0, 10).join('; ')}`);
  process.exitCode = 1;
}
