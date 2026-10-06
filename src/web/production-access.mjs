import { timingSafeEqual } from 'node:crypto';

// The dedicated OAuth2 Proxy verifies Google sessions. Its upstream password
// is mounted only in that proxy and this application, on an isolated network.
export function productionAccess({ origin, ownerEmail, proxyPassword } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password
    || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(ownerEmail ?? '')
    || !/^[A-Za-z0-9_-]{43,128}$/.test(proxyPassword ?? '')) {
    throw new TypeError('Invalid production access configuration.');
  }
  const email = ownerEmail.toLowerCase();
  const expected = Buffer.from(`Basic ${Buffer.from(`${email}:${proxyPassword}`).toString('base64')}`);
  return Object.freeze({ origin, ownerEmail: email,
    authorize(request) {
      const value = request.headers.authorization;
      // OAuth2 Proxy with prefer_email_to_user=true puts the verified email in
      // X-Forwarded-User and omits X-Forwarded-Email. Require that exact contract
      // together with the private Basic credential, never an email-only fallback.
      if (typeof value !== 'string' || request.headers['x-forwarded-user'] !== email) return false;
      const actual = Buffer.from(value);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  });
}
