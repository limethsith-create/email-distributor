/** @type {import('next').NextConfig} */

// Browser-side protection for every page and API answer. Client links carry
// their token in the address (/c/{token}), so no page ever sends a Referer;
// no other site may frame a page (clickjacking); scripts and styles stay as
// Next.js serves them (no script-src here: Next injects inline scripts).
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig = {
  // Loaded from node_modules at runtime, not bundled by webpack.
  serverExternalPackages: ['nodemailer', 'imapflow'],
  // The word lists in config/*.txt (spam words, angry/claims phrases, chains,
  // booking subjects) are read with fs at runtime; ship them with every
  // serverless function.
  outputFileTracingIncludes: {
    '/**': ['./config/*.txt'],
  },
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

module.exports = nextConfig;
