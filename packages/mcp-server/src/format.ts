// Actual stores amounts as integers (cents). Tools hand the model plain
// decimal numbers in the budget's currency, which is what people reason in.

export function toMoney(cents: number | null | undefined): number {
  return Math.round(cents ?? 0) / 100;
}

export function fromMoney(amount: number): number {
  return Math.round(amount * 100);
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isMonth(value: string): boolean {
  return MONTH.test(value);
}

export function isDay(value: string): boolean {
  return DAY.test(value) && !Number.isNaN(Date.parse(value));
}

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** "2026-03" + 2 → "2026-05"; negative offsets go back. */
export function addMonths(month: string, offset: number): string {
  const [year, mon] = month.split('-').map(Number);
  const index = year * 12 + (mon - 1) + offset;
  const newYear = Math.floor(index / 12);
  const newMonth = (index % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, '0')}`;
}

export function monthsBetween(start: string, end: string): string[] {
  const result: string[] = [];
  for (let month = start; month <= end; month = addMonths(month, 1)) {
    result.push(month);
    if (result.length > 600) break;
  }
  return result;
}

export function lastDayOfMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  const day = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function addDays(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
