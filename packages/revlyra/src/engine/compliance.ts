import type { Store } from '../store';
import type { ReviewRecord } from '../store/types';

export interface TransparencyReportOptions {
  sinceDays?: number;
  now?: string;
}

export interface TransparencyFairnessGroup {
  key: string;
  reviewed: number;
  flaggedShare: number;
  overturnShare: number | null;
}

export interface TransparencyReport {
  spec: 'revlyra.transparency/0.1';
  generatedAt: string;
  period: { from: string; to: string; days: number };
  reviews: {
    analyzed: number;
    byDecision: Record<string, number>;
    heldOrEscalated: number;
    safetyRouted: number;
  };
  signals: { topCodes: Array<{ code: string; family: string; count: number }> };
  humanOversight: {
    automationShare: number;
    feedback: Record<string, number>;
    appeals: {
      open: number;
      upheld: number;
      overturned: number;
      overturnRate: number | null;
      medianResolutionDays: number | null;
      slaBreaches: number;
    };
  };
  notices: Record<string, number>;
  fairness: {
    note: string;
    byLanguage: TransparencyFairnessGroup[];
    byLengthBand: TransparencyFairnessGroup[];
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function groupBy(
  rows: ReviewRecord[],
  keyFn: (row: ReviewRecord) => string | null,
  overturns: Set<string>,
): TransparencyFairnessGroup[] {
  const groups = new Map<string, { total: number; flagged: number; overturned: number }>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const entry = groups.get(key) ?? { total: 0, flagged: 0, overturned: 0 };
    entry.total += 1;
    if (row.decision && row.decision !== 'allow') entry.flagged += 1;
    if (overturns.has(row.id)) entry.overturned += 1;
    groups.set(key, entry);
  }
  return Array.from(groups.entries())
    .map(([key, entry]) => ({
      key,
      reviewed: entry.total,
      flaggedShare: entry.total > 0 ? Number((entry.flagged / entry.total).toFixed(3)) : 0,
      overturnShare:
        entry.overturned > 0 ? Number((entry.overturned / entry.total).toFixed(3)) : null,
    }))
    .sort((a, b) => b.reviewed - a.reviewed);
}

export async function buildTransparencyReport(
  store: Store,
  tenantId: string,
  options: TransparencyReportOptions = {},
): Promise<TransparencyReport> {
  const now = options.now ? new Date(options.now) : new Date();
  const to = now.toISOString();
  const sinceDays = options.sinceDays ?? 90;
  const from = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();

  const [decisions, signals, feedback, appeals, notices, recentReviews] = await Promise.all([
    store.decisionCounts(tenantId, from),
    store.signalCodeCounts(tenantId, from, 30),
    store.listFeedback(tenantId, undefined, 5000),
    store.listAppeals(tenantId),
    store.listNotices(tenantId, { limit: 500 }),
    store.listRecentReviews(tenantId, 10_000),
  ]);

  const reviews = recentReviews.filter((row) => row.submittedAt >= from);
  const byDecision: Record<string, number> = {};
  for (const row of decisions) byDecision[row.decision] = row.count;
  const heldOrEscalated = (byDecision.hold ?? 0) + (byDecision.escalate ?? 0);
  const safetyRouted = signals.find((signal) => signal.code === 'SAFETY_REVIEW')?.count ?? 0;

  const feedbackLabels: Record<string, number> = {};
  for (const record of feedback)
    feedbackLabels[record.label] = (feedbackLabels[record.label] ?? 0) + 1;

  const overturnedAppeals = appeals.filter((appeal) => appeal.status === 'overturned');
  const reviewedReviewIds = new Set(feedback.map((record) => record.reviewId));
  const resolutionDays = appeals
    .filter((appeal) => appeal.resolvedAt)
    .map(
      (appeal) =>
        (new Date(appeal.resolvedAt!).getTime() - new Date(appeal.createdAt).getTime()) /
        86_400_000,
    );
  const slaBreaches = appeals.filter(
    (appeal) => appeal.resolvedAt && appeal.slaDueAt && appeal.resolvedAt > appeal.slaDueAt,
  ).length;

  const automationShare = Number(
    (
      1 -
      Math.min(
        1,
        reviewedReviewIds.size /
          Math.max(
            1,
            decisions.reduce((sum, row) => sum + row.count, 0),
          ),
      )
    ).toFixed(3),
  );

  const noticeCounts: Record<string, number> = {};
  for (const notice of notices) {
    noticeCounts[notice.status] = (noticeCounts[notice.status] ?? 0) + 1;
    if (notice.substantiated) noticeCounts.substantiated = (noticeCounts.substantiated ?? 0) + 1;
  }

  const overturnIds = new Set(overturnedAppeals.map((appeal) => appeal.reviewId));

  return {
    spec: 'revlyra.transparency/0.1',
    generatedAt: now.toISOString(),
    period: { from, to, days: sinceDays },
    reviews: {
      analyzed: decisions.reduce((sum, row) => sum + row.count, 0),
      byDecision,
      heldOrEscalated,
      safetyRouted,
    },
    signals: { topCodes: signals },
    humanOversight: {
      automationShare,
      feedback: feedbackLabels,
      appeals: {
        open: appeals.filter((appeal) => appeal.status === 'open').length,
        upheld: appeals.filter((appeal) => appeal.status === 'upheld').length,
        overturned: overturnedAppeals.length,
        overturnRate:
          appeals.filter((appeal) => appeal.status !== 'open').length > 0
            ? Number(
                (
                  overturnedAppeals.length /
                  appeals.filter((appeal) => appeal.status !== 'open').length
                ).toFixed(3),
              )
            : null,
        medianResolutionDays:
          median(resolutionDays) === null ? null : Number(median(resolutionDays)!.toFixed(1)),
        slaBreaches,
      },
    },
    notices: noticeCounts,
    fairness: {
      note: 'Fraud flags and appeal overturns by coarse group; sustained disparities above ~5% overturn share should trigger a weight/threshold review (fairness policy).',
      byLanguage: groupBy(
        reviews,
        (row) => (row.language && row.language !== 'und' ? row.language : null),
        overturnIds,
      ),
      byLengthBand: groupBy(
        reviews,
        (row) => {
          const length = (row.text ?? '').length;
          if (length < 80) return '<80 chars';
          if (length < 300) return '80-299 chars';
          if (length < 1000) return '300-999 chars';
          return '>=1000 chars';
        },
        overturnIds,
      ),
    },
  };
}

const DECISION_TONE: Record<string, string> = {
  allow: 'var(--ok, #3f6)',
  label: 'var(--warn, #fa3)',
  downrank: '#e578',
  hold: '#e75',
  escalate: '#f55',
  remove: '#f55',
};

export function renderTransparencyHtml(report: TransparencyReport): string {
  const section = (title: string, body: string): string => `
    <section class="card"><h2>${title}</h2>${body}</section>`;
  const decisions = Object.entries(report.reviews.byDecision)
    .sort((a, b) => b[1] - a[1])
    .map(([decision, count]) => {
      const share = Math.round((count / Math.max(1, report.reviews.analyzed)) * 100);
      return `<li><b style="color:${DECISION_TONE[decision] ?? '#8af'}">${decision}</b> — ${count} (${share}%)</li>`;
    })
    .join('');
  const codes = report.signals.topCodes
    .map((item) => `<span class="pill">${item.code} ×${item.count}</span>`)
    .join(' ');
  const appeals = report.humanOversight.appeals;
  const fairnessRows = (items: TransparencyFairnessGroup[]) =>
    items
      .slice(0, 12)
      .map(
        (item) =>
          `<tr><td>${item.key}</td><td>${item.reviewed}</td><td>${(item.flaggedShare * 100).toFixed(1)}%</td><td>${
            item.overturnShare === null ? '—' : `${(item.overturnShare * 100).toFixed(1)}%`
          }</td></tr>`,
      )
      .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Revlyra transparency report</title>
  <style>
    body { background:#0b1020; color:#dbe2ee; font: 15px/1.55 -apple-system, Segoe UI, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
    h1 { font-size: 1.5rem; } h2 { font-size: 1.05rem; color:#9fb3d1; margin-top:0; }
    .card { background:#121a2e; border:1px solid #22304d; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    .pill { display:inline-block; background:#1b2740; border:1px solid #2c3d61; border-radius: 999px; padding: .15rem .6rem; margin: .15rem .25rem .15rem 0; font-size: .85rem; }
    table { width: 100%; border-collapse: collapse; } th, td { text-align:left; padding: .3rem .5rem; border-bottom: 1px solid #22304d; font-size: .9rem; }
    .disclaimer { color:#93a4c3; font-size: .85rem; }
  </style></head><body>
  <h1>Revlyra transparency report</h1>
  <p class="disclaimer">${report.spec} · generated ${report.generatedAt} · window ${report.period.from.slice(0, 10)} → ${report.period.to.slice(0, 10)} (${report.period.days} days)</p>
  ${section('Decisions', `<ul>${decisions}</ul><p class="disclaimer">Held/escalated: ${report.reviews.heldOrEscalated} · safety-routed: ${report.reviews.safetyRouted}</p>`)}
  ${section('Top integrity signals', codes || '<p class="disclaimer">No signals in period.</p>')}
  ${section(
    'Human oversight',
    `
    <p>Automation share (approx): <b>${report.humanOversight.automationShare}</b></p>
    <p>Feedback labels: ${
      Object.entries(report.humanOversight.feedback)
        .map(([label, count]) => `${label} (${count})`)
        .join(' · ') || '—'
    }</p>
    <p>Appeals: open ${appeals.open} · upheld ${appeals.upheld} · overturned ${appeals.overturned} · overturn rate ${appeals.overturnRate ?? '—'} · median resolution ${appeals.medianResolutionDays ?? '—'} d · SLA breaches ${appeals.slaBreaches}</p>`,
  )}
  ${section(
    'Notices (DSA Art. 16)',
    Object.keys(report.notices).length
      ? Object.entries(report.notices)
          .map(([status, count]) => `${status}: ${count}`)
          .join(' · ')
      : '<span class="disclaimer">None in period.</span>',
  )}
  ${section(
    'Fairness monitoring',
    `
    <p class="disclaimer">${report.fairness.note}</p>
    <table><tr><th></th><th>reviewed</th><th>flagged share</th><th>overturn share</th></tr>
    <tr><td colspan="4"><b>By language</b></td></tr>${fairnessRows(report.fairness.byLanguage)}
    <tr><td colspan="4"><b>By review length</b></td></tr>${fairnessRows(report.fairness.byLengthBand)}</table>`,
  )}
  <p class="disclaimer">This aggregate report supports DSA Art. 15/24-style transparency and UK DMCCA "reasonable and proportionate steps" evidence. It is not a legal determination.</p>
  </body></html>`;
}
