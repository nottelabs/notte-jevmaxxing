import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Browser } from "./browser";

const WAIT_MS = 90_000;
type Ticket = { cdp: string; marker: string; expires: number };
const key = () => {
  if (!process.env.NOTTE_API_KEY) throw Error("Missing Notte configuration.");
  return createHash("sha256").update(`wiki-race-start:${process.env.NOTTE_API_KEY}`).digest();
};

// The client gets an expiring capability, never the browser's CDP credentials.
export function sealStart(ticket: Ticket) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(ticket)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function readStart(token: unknown): Ticket {
  try {
    if (typeof token !== "string" || token.length > 16_000) throw Error();
    const bytes = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const ticket = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    if (typeof ticket.cdp !== "string" || typeof ticket.marker !== "string" || !Number.isFinite(ticket.expires) || ticket.expires <= Date.now()) throw Error();
    return ticket;
  } catch { throw Error("The prepared race expired. Prepare the browsers again."); }
}

export async function prepareStart(browser: Browser, cdp: string) {
  const ticket = { cdp, marker: `__wikiStart_${randomUUID()}`, expires: Date.now() + WAIT_MS };
  const marker = JSON.stringify(ticket.marker);
  await browser.evaluate(`window[${marker}] = false`);
  return {
    token: sealStart(ticket),
    wait: async (signal: AbortSignal) => {
      while (Date.now() < ticket.expires) {
        signal.throwIfAborted();
        if (await browser.evaluate(`window[${marker}] === true`)) {
          await browser.evaluate(`delete window[${marker}]`);
          return;
        }
        await delay(500, undefined, { signal });
      }
      throw Error("The prepared race expired. Prepare the browsers again.");
    },
  };
}

export async function releaseStart(ticket: Ticket) {
  const browser = await Browser.connect(ticket.cdp);
  try {
    const marker = JSON.stringify(ticket.marker);
    const released = await browser.evaluate(`(() => {
      if (typeof window[${marker}] !== 'boolean') return false;
      window[${marker}] = true;
      return true;
    })()`);
    if (!released) throw Error("This race is no longer waiting. Prepare the browsers again.");
  } finally { browser.close(); }
}
