/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Next 14 key (Next 15 renamed it to `serverExternalPackages`). The old
    // top-level key was silently ignored, so nodemailer and imapflow were being
    // bundled by webpack instead of loaded from node_modules at runtime.
    serverComponentsExternalPackages: ['nodemailer', 'imapflow'],
    // The word lists in config/*.txt (spam words, angry/claims phrases, chains,
    // booking subjects) are read with fs at runtime; ship them with every
    // serverless function (Next 14.2: still under `experimental`).
    outputFileTracingIncludes: {
      '/**': ['./config/*.txt'],
    },
  },
};

module.exports = nextConfig;
