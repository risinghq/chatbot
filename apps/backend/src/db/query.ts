/**
 * A date query parameter that is not a real calendar date or timestamp.
 * `middleware/error.ts` answers it as 400.
 */
export class InvalidDateError extends Error {
  constructor(
    readonly field: string,
    expected: string,
  ) {
    super(`${field} must be ${expected}`);
  }
}

// America/Lima is UTC-5 with no daylight saving, so a Lima day is a fixed 24h window.
const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Lima midnight that opens the calendar day `YYYY-MM-DD`, or undefined if it is not a real date. */
function limaMidnight(date: string): number | undefined {
  const match = DATE_ONLY.exec(date);
  if (!match) return undefined;

  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const utc = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day;

  return isRealDate ? utc.getTime() + LIMA_OFFSET_MS : undefined;
}

/** `[start, end]` ms of the Lima calendar day `YYYY-MM-DD`, or of the day containing `now`. */
export function limaDayBounds(
  date?: string,
  now: number = Date.now(),
): [number, number] {
  let start: number | undefined;
  if (date === undefined) {
    start =
      Math.floor((now - LIMA_OFFSET_MS) / DAY_MS) * DAY_MS + LIMA_OFFSET_MS;
  } else {
    start = limaMidnight(date);
    if (start === undefined) throw new InvalidDateError("date", "YYYY-MM-DD");
  }
  return [start, start + DAY_MS - 1];
}

/** The Lima calendar date `YYYY-MM-DD` of a ms timestamp. */
export function limaDateString(timestamp: number): string {
  return new Date(timestamp - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Every Lima calendar date from the one holding `startMs` to the one holding `endMs`. */
export function limaDates(startMs: number, endMs: number): string[] {
  const dates: string[] = [];
  for (let at = limaDayBounds(undefined, startMs)[0]; at <= endMs; at += DAY_MS)
    dates.push(limaDateString(at));
  return dates;
}

/** SQL for the Lima calendar date `YYYY-MM-DD` of a ms timestamp column. */
export function limaDateSql(column: string): string {
  return `strftime('%Y-%m-%d', (${column} - ${LIMA_OFFSET_MS}) / 1000, 'unixepoch')`;
}

/** Convert Unix timestamp (ms) to ISO string */
export function toISOString(timestamp: number | null): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

/**
 * One end of a query range in ms. A `YYYY-MM-DD` value opens or closes that Lima
 * day. An ISO timestamp with a zone is taken as the exact instant.
 */
export function limaRangeEdge(
  value: string,
  edge: "start" | "end",
  field: string,
): number {
  if (DATE_ONLY.test(value)) {
    const start = limaMidnight(value);
    if (start !== undefined)
      return edge === "start" ? start : start + DAY_MS - 1;
  } else if (
    ISO_WITH_ZONE.test(value) &&
    limaMidnight(value.slice(0, 10)) !== undefined
  ) {
    const instant = Date.parse(value);
    if (!Number.isNaN(instant)) return instant;
  }
  throw new InvalidDateError(
    field,
    "YYYY-MM-DD or an ISO timestamp with a zone",
  );
}
