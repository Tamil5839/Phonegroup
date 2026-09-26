/**
 * Six-character room codes in Crockford-style base32 (no I, L, O, U), so a
 * code read aloud or typed from the screen is hard to get wrong.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;
export const PEER_ID_PREFIX = 'frozenmoment-v1-';

export function generateRoomCode(random: () => number = cryptoRandom): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return code;
}

/** Accepts lowercase, spaces, dashes and look-alike letters. Returns null if invalid. */
export function normalizeRoomCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function peerIdForRoom(code: string): string {
  return PEER_ID_PREFIX + code;
}

/** "ABC123" → "ABC 123" for display. */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function cryptoRandom(): number {
  const v = crypto.getRandomValues(new Uint32Array(1))[0];
  return v / 0x1_0000_0000;
}
