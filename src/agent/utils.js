export const now = () => new Date().toISOString();
export const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
export function stable(value) {
  if(Array.isArray(value))return value.map(stable);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
export async function sha256(data) {
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(typeof data==='string'?data:JSON.stringify(stable(data)));
  const buf=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,'0')).join('');
}
export function take(result){if(!result.ok){const e=Error(result.error.message);e.code=result.error.code;throw e}return result.data}
export function id(){return globalThis.crypto.randomUUID()}

/**
 * Today on the owner's computer: the date, weekday, local time and time zone (Sitetend runs on that computer,
 * so its clock and time zone are the owner's). Given to the model so it can tell past dates from future ones.
 */
export function today(at = new Date()) {
  const fixed = globalThis.process?.env?.SITETEND_TODAY;   // tests and evaluations can pin the date (YYYY-MM-DD)
  if (fixed && /^\d{4}-\d{2}-\d{2}$/.test(fixed)) at = new Date(fixed + 'T12:00:00');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const part = o => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(at);
  return { date: part({ year: 'numeric', month: '2-digit', day: '2-digit' }), weekday: part({ weekday: 'long' }), time: part({ hour: '2-digit', minute: '2-digit', hour12: false }), timeZone: tz };
}
/** One line for a system prompt. */
export function todayLine(t = today()) {
  return `Today is ${t.weekday}, ${t.date} (${t.time}, time zone ${t.timeZone}) on the website owner's computer. ` +
    'Use it to judge dates in the materials: an end date before today has passed (a job "until August 2026" is over once that month is gone), ' +
    'a start date after today has not begun (do not present it as current), and "now", "this year" or "next week" in a material mean the time that material was written if it says, otherwise today.';
}
