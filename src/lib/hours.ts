// Business hours: 9:00 to 17:00 AEST (UTC+10), Monday to Friday. Southbag does not observe daylight
// saving, so AEST is UTC+10 all year, including the months when Sydney itself is on AEDT.

const OFFSET = 10 * 3600000;
export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 17;

/** The wall clock in AEST as if it were UTC (use getUTC* on the result). */
const aest = (ms: number) => new Date(ms + OFFSET);

export function isBusinessHours(ms: number): boolean {
  const t = aest(ms);
  const day = t.getUTCDay();
  const hour = t.getUTCHours();
  return day >= 1 && day <= 5 && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

/** The next moment business hours open after `ms` (or `ms` itself if they're open now). */
export function nextOpening(ms: number): number {
  if (isBusinessHours(ms)) return ms;
  const t = aest(ms);
  let day = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), OPEN_HOUR) - OFFSET;
  if (day <= ms) day += 86400000;
  while (!isBusinessHours(day)) day += 86400000;
  return day;
}

const minutes = (min: number, max: number) => (min + Math.random() * (max - min)) * 60000;

/**
 * When a push received at `ms` gets processed: a few minutes later in business hours, otherwise a
 * few minutes after the next business day opens (and the after-hours fee applies).
 */
export function processingTime(ms: number): { dueAt: number; afterHours: boolean } {
  if (isBusinessHours(ms)) {
    const dueAt = ms + minutes(2, 6);
    // Anything that would finish after closing waits for the next business day.
    return isBusinessHours(dueAt) ? { dueAt, afterHours: false } : { dueAt: nextOpening(dueAt) + minutes(3, 15), afterHours: false };
  }
  return { dueAt: nextOpening(ms) + minutes(3, 25), afterHours: true };
}

/** "Thursday 16 October, 9:14 am AEST". */
export function aestText(ms: number): string {
  const t = aest(ms);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const h = t.getUTCHours();
  const m = String(t.getUTCMinutes()).padStart(2, '0');
  return `${days[t.getUTCDay()]} ${t.getUTCDate()} ${months[t.getUTCMonth()]}, ${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'} AEST`;
}

/** Hour (0-23) and weekday (0 = Sunday) in AEST for a unix-seconds timestamp. */
export function aestClock(seconds: number): { hour: number; minute: number; day: number } {
  const t = aest(seconds * 1000);
  return { hour: t.getUTCHours(), minute: t.getUTCMinutes(), day: t.getUTCDay() };
}
