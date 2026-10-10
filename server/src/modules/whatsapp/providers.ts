/**
 * WhatsApp providers behind one facade (ported from the Citizen Desk integration).
 *   mock      default — messages are only logged (and visible in the admin outbox)
 *   wasender  wasenderapi.com (WhatsApp Web session) — simple, but unofficial
 *   cloud     Meta WhatsApp Cloud API — official; business-initiated messages outside the 24-hour
 *             window must use an approved template (WHATSAPP_CLOUD_TEMPLATE with one body variable)
 * All retry on HTTP 429.
 */
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface SendResult { id: string | null; provider: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(url: string, body: unknown, token?: string, attempt = 1): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (r.status === 429 && attempt <= 3) {
    await sleep(2000 * attempt);
    return post(url, body, token, attempt + 1);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`WhatsApp provider ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const providers = {
  async mock(phone: string, text: string): Promise<SendResult> {
    logger.info({ to: phone, text: text.slice(0, 120) }, '[whatsapp:mock] message');
    return { id: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, provider: 'mock' };
  },
  async wasender(phone: string, text: string): Promise<SendResult> {
    const res = await post('https://wasenderapi.com/api/send-message', { to: phone, text }, env.WHATSAPP_ACCESS_TOKEN);
    return { id: res?.data?.msgId ?? res?.data?.id ?? null, provider: 'wasender' };
  },
  async cloud(phone: string, text: string, opts: { session?: boolean } = {}): Promise<SendResult> {
    const url = `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const to = phone.replace(/^\+/, '');
    // Inside the 24-hour customer window plain text is allowed; otherwise use the approved template
    const body = opts.session || !env.WHATSAPP_CLOUD_TEMPLATE
      ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }
      : {
          messaging_product: 'whatsapp', to, type: 'template',
          template: { name: env.WHATSAPP_CLOUD_TEMPLATE, language: { code: env.WHATSAPP_CLOUD_TEMPLATE_LANG }, components: [{ type: 'body', parameters: [{ type: 'text', text: text.slice(0, 1024) }] }] },
        };
    const res = await post(url, body, env.WHATSAPP_ACCESS_TOKEN);
    return { id: res?.messages?.[0]?.id ?? null, provider: 'cloud' };
  },
};

export const whatsappMode = () => env.WHATSAPP_MODE;

/** Send one text message through the configured provider. */
export function sendWhatsApp(phone: string, text: string, opts: { session?: boolean } = {}): Promise<SendResult> {
  const mode = env.WHATSAPP_MODE;
  if (mode === 'cloud') return providers.cloud(phone, text, opts);
  if (mode === 'wasender') return providers.wasender(phone, text);
  return providers.mock(phone, text);
}
