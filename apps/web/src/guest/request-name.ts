// Match the request inbox's UTF-16 character restrictions before creating credentials.
export function requestNameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return "Enter a name before requesting access.";
  if (name.length > 40) return "Use 40 characters or fewer.";
  if (name.split("").some((unit) => /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/u.test(unit)))
    return "This name contains unsupported characters. Remove emoji or invisible formatting and try again.";
  return null;
}
