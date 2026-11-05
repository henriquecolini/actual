import { fromMoney, toMoney } from '#format';

// Rule conditions and schedules store amounts as integer cents, either a
// number or {num1, num2} for "between". Tools show and accept decimals.

type Amount = number | { num1: number; num2: number };

export function amountToMoney(value: unknown): unknown {
  if (typeof value === 'number') return toMoney(value);
  if (value && typeof value === 'object' && 'num1' in value) {
    const { num1, num2 } = value as { num1: number; num2: number };
    return { num1: toMoney(num1), num2: toMoney(num2) };
  }
  return value;
}

export function amountFromMoney(value: Amount): Amount {
  if (typeof value === 'number') return fromMoney(value);
  return { num1: fromMoney(value.num1), num2: fromMoney(value.num2) };
}

type Condition = { field: string; value?: unknown; [key: string]: unknown };

export function conditionsToMoney<T extends Condition>(conditions: T[]): T[] {
  return conditions.map(c =>
    c.field === 'amount' ? { ...c, value: amountToMoney(c.value) } : c,
  );
}

export function conditionsFromMoney<T extends Condition>(conditions: T[]): T[] {
  return conditions.map(c =>
    c.field === 'amount' && c.value != null
      ? { ...c, value: amountFromMoney(c.value as Amount) }
      : c,
  );
}

type Action = { field?: string; op: string; value?: unknown };

/** "set-split-amount" actions carry cents too. */
export function actionsToMoney<T extends Action>(actions: T[]): T[] {
  return actions.map(a =>
    a.op === 'set-split-amount' && typeof a.value === 'number'
      ? { ...a, value: toMoney(a.value) }
      : a,
  );
}

export function actionsFromMoney<T extends Action>(actions: T[]): T[] {
  return actions.map(a =>
    a.op === 'set-split-amount' && typeof a.value === 'number'
      ? { ...a, value: fromMoney(a.value) }
      : a,
  );
}
