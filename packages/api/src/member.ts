/** Builds the guard for one of the closed string sets the wire carries. */
export function memberOf<T extends readonly string[]>(
  values: T,
): (value: unknown) => value is T[number] {
  return (value): value is T[number] =>
    typeof value === 'string' && (values as readonly string[]).includes(value);
}
