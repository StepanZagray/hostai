// Return a monotonic deadline. Neither a wrong device date nor a clock correction
// should turn a short host cooldown into a lockout. The host still enforces limits.
export function retryAfter(response: Response): number {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return 0;
  const numeric = /^\d+$/.test(value);
  const hostDate = Date.parse(response.headers.get("Date") ?? "");
  const duration = numeric ? Number(value) * 1000 : Date.parse(value) - hostDate;
  // Without a valid host Date, an HTTP-date cannot establish a clock-independent
  // wait. Leave retry manual; a host rejection supplies another opportunity.
  if (Number.isNaN(duration) || duration <= 0) return 0;
  return performance.now() + Math.min(duration, 300_000);
}
