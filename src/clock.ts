export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (YYYY-MM-DD) of a moment in the given IANA time zone. */
export function localDate(d: Date, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(d);
}
