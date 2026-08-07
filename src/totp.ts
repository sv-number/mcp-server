// Second factor, computed locally. RFC 6238 over RFC 4226, HMAC-SHA1 by default.
// The secret stays in this process: nothing about it goes over the network.

import { createHmac } from "node:crypto";

function decodeBase32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`"${char}" is not part of a base32 secret.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, options: { digits?: number; period?: number;
                                                algorithm?: string; at?: number } = {}) {
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
  const algorithm = (options.algorithm ?? "sha1").toLowerCase();
  const seconds = options.at ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(seconds / period);

  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, decodeBase32(secret)).update(message).digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16)
               | (digest[offset + 2] << 8) | digest[offset + 3];
  const code = (binary % 10 ** digits).toString().padStart(digits, "0");

  return { code, secondsLeft: period - (seconds % period) };
}
