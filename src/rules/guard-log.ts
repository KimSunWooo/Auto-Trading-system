/** Lower-rail rejects: keep a trail without throwing. */
export function guardLog(event: string, detail: string) {
  console.warn(`[QuantGuard] ${event} · ${detail}`);
}
