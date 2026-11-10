/**
 * The one error type the local module refuses with: a named cause (`code`) and one line of detail, printed as
 * `steak-pi local: REFUSED (<code>): <detail>`. It lives in its own module so the profile, the limits and the store can
 * all use it without importing each other in a circle.
 */
export class LocalError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) { super(detail); this.code = code; }
}
