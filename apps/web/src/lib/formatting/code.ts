const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateSessionCode(length = 6): string {
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[O0]/g, "O")
    .replace(/[IL1]/g, "I")
    .slice(0, 6);
}

export function isValidCode(code: string): boolean {
  return /^[A-Z2-9]{6}$/.test(normalizeCode(code).replace(/[OIL]/g, "X")) || /^[A-Z2-9]{6}$/.test(code.replace(/\s/g, "").toUpperCase());
}

export function sanitizeCodeInput(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_]/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}
