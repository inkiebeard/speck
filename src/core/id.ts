const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Random alphanumeric string, used as the stable external id for an entity
 * (see EntityManager). Uses crypto.getRandomValues when available (uniform
 * over ALPHABET, no modulo bias) and falls back to Math.random-based
 * generation otherwise.
 */
export function generateId(length = 12): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let id = '';
    for (let i = 0; i < length; i++) id += ALPHABET[bytes[i] % ALPHABET.length];
    return id;
  }
  let id = '';
  while (id.length < length) {
    id += Math.random().toString(36).substring(2);
  }
  return id.substring(0, length);
}
