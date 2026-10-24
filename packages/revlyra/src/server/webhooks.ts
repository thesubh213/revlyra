import { createHmac } from 'node:crypto';
import type { RevlyraConfig } from '../config';

export class WebhookDispatcher {
  private readonly url?: string;
  private readonly secret?: string;

  constructor(config: RevlyraConfig) {
    this.url = config.webhooks.url;
    this.secret = config.webhooks.secret;
  }

  get enabled(): boolean {
    return Boolean(this.url && this.secret);
  }

  async emit(event: string, data: Record<string, unknown>): Promise<void> {
    if (!this.enabled || !this.url || !this.secret) return;
    let url: URL;
    try {
      url = new URL(this.url);
    } catch {
      return;
    }
    const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) return;

    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ event, timestamp, data });
    const signature = createHmac('sha256', this.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'revlyra-webhooks/0.1',
            'x-revlyra-event': event,
            'x-revlyra-signature': `t=${timestamp},v1=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) return;
      } catch {
        // Retry with a short backoff.
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
