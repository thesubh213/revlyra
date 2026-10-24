import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('graph', ctx.policy, 'graph')) return [];
  const campaign = ctx.analysis.campaign;
  if (!campaign || campaign.memberCount < 3) return [];

  const familyMultiplier = campaign.signalFamilies.length >= 2 ? 1 : 0.55;
  const severity = Math.min(0.9, campaign.score * 0.85 * familyMultiplier);

  return [
    signal(
      'GRAPH_CAMPAIGN',
      'graph',
      severity,
      campaign.signalFamilies.length >= 2 ? 0.7 : 0.4,
      'The reviewer belongs to a coordinated cluster of accounts with shared review behavior.',
      {
        campaignId: campaign.id,
        memberCount: campaign.memberCount,
        signalFamilies: campaign.signalFamilies,
        campaignScore: Number(campaign.score.toFixed(3)),
      },
    ),
  ];
}

export const graphDetector: Detector = {
  id: 'graph',
  version: '1.0.0',
  families: ['graph'],
  run,
};
