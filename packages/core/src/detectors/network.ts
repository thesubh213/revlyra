import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('network', ctx.policy, 'network')) return [];
  const features = ctx.features;
  const signals: Signal[] = [];

  const deviceReuse = features['net.deviceReuse'] ?? 0;
  if (deviceReuse >= 0.4) {
    signals.push(
      signal(
        'NET_DEVICE_REUSE',
        'network',
        Math.min(0.75, 0.25 + deviceReuse * 0.55),
        0.6,
        'Several reviewer accounts share the same device identifier.',
        { accountsOnDevice: features['net.accountsOnDevice'] ?? 0 },
      ),
    );
  }

  const subnetReuse = features['net.subnetReuse'] ?? 0;
  if (subnetReuse >= 0.5) {
    signals.push(
      signal(
        'NET_SHARED_SUBNET',
        'network',
        Math.min(0.55, 0.18 + subnetReuse * 0.35),
        0.4,
        'Many reviewer accounts recently originated from the same subnet. Shared networks and carrier NAT can produce this legitimately.',
        { accountsOnSubnet: features['net.accountsOnSubnet'] ?? 0 },
      ),
    );
  }

  if ((features['net.headless'] ?? 0) > 0) {
    signals.push(
      signal(
        'NET_UA_HEADLESS',
        'network',
        0.4,
        0.55,
        'The request user agent indicates an automated or headless browser.',
        { headless: true },
      ),
    );
  }

  if ((features['net.datacenter'] ?? 0) > 0) {
    signals.push(
      signal(
        'NET_DATACENTER_ASN',
        'network',
        0.25,
        0.45,
        'The request originated from a datacenter network, which is unusual for consumer reviews.',
        { datacenter: true },
      ),
    );
  }

  if ((features['net.localeMismatch'] ?? 0) > 0) {
    signals.push(
      signal(
        'NET_LOCALE_MISMATCH',
        'network',
        0.2,
        0.35,
        'The reviewer locale does not match the review language.',
        { localeMismatch: true },
      ),
    );
  }

  return signals;
}

export const networkDetector: Detector = {
  id: 'network',
  version: '1.0.0',
  families: ['network'],
  run,
};
