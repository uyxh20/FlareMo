// Pure helpers for the memo date dialog: a <input type="datetime-local">
// speaks local wall-clock time without a zone, the API speaks ISO instants.

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-13T18:05" in the browser's local time, from an ISO instant. */
export function forkLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The ISO instant for a local input value, or null when it is empty or invalid. */
export function forkLocalInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
