// Deliberately conservative. Run on RAW input before extraction and on every
// serialized candidate/source before persistence. Never echo rejected content.
const secrets = [
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{25,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b(?:passwords?|passwd|contrase[nñ]as?|claves?|private keys?|secreto(?: de sesi[oó]n)?|session secrets?|credit card|card number|n[uú]mero de tarjeta|banking credentials|api[ _-]?key|secret|token|refresh_token|access_token|oauth|authentication code|c[oó]digo de (?:autenticaci[oó]n|verificaci[oó]n)|security answers?|respuestas? de seguridad|pin|cvv|cvc)\b\s*(?:is|es|[:=]|son)?\s*\S+/i,
  /\b(?:ya29\.[A-Za-z0-9_-]{10,}|ek_[A-Za-z0-9_-]{12,}|1\/\/[A-Za-z0-9_-]{20,})/i,
  /\bBearer\s+\S+/i,
  /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/i,
  /\b(?:verification|authentication|one[- ]time|otp|2fa|verificaci[oó]n|autenticaci[oó]n)\b.{0,35}\b\d{4,8}\b/i,
];
const cardDigits = /\b(?:\d[ -]?){13,19}\b/;
export function containsSecret(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // UUIDs are internal opaque IDs, not card numbers; credential-labelled UUIDs
  // remain blocked by the label patterns before this card-only normalization.
  return secrets.some(pattern => pattern.test(text)) || cardDigits.test(text.replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, ''));
}
