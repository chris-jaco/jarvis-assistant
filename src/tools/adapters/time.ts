import { Temporal } from '@js-temporal/polyfill';
import { ToolError } from '../types.js';
export function validateTimezone(timezone: string): string {
  try { Temporal.Now.zonedDateTimeISO(timezone); return timezone; } catch { throw new Error('USER_TIMEZONE must be a valid IANA timezone'); }
}
export function instant(value: string, timezone: string): string {
  try {
    if (/Z$|[+-]\d\d:\d\d$/.test(value)) return Temporal.Instant.from(value).toString();
    return Temporal.PlainDateTime.from(value).toZonedDateTime(timezone, { disambiguation: 'reject' }).toInstant().toString();
  } catch { throw new ToolError('INVALID_INPUT'); }
}
export function range(start: string, end: string, timezone: string) {
  const timeMin = instant(start, timezone), timeMax = instant(end, timezone);
  if (Temporal.Instant.compare(timeMin, timeMax) >= 0 || Temporal.Instant.from(timeMax).epochMilliseconds - Temporal.Instant.from(timeMin).epochMilliseconds > 366 * 86400_000) throw new ToolError('INVALID_INPUT');
  return { timeMin, timeMax };
}
