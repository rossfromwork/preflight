const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Matches loopback, RFC-1918 private ranges, and link-local (169.254/16).
// Covers both bare IPv6 (::1) and bracket-wrapped ([::1]) forms since
// Node.js URL.hostname returns the bracketed form for IPv6 addresses.
const BLOCKED_HOST_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[?::1\]?$|0\.0\.0\.0$|localhost$)/i;

export function validateSsrfUrl(label: string, url: URL): void {
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `${label}: scheme "${url.protocol}" is not allowed; use http: or https:`,
    );
  }
  if (BLOCKED_HOST_RE.test(url.hostname)) {
    throw new Error(
      `${label}: host "${url.hostname}" resolves to a private or loopback address`,
    );
  }
}
