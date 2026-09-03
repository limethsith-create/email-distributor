/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 14 key (Next 15 renamed it to `serverExternalPackages`). The old
  // top-level key was silently ignored, so nodemailer and imapflow were being
  // bundled by webpack instead of loaded from node_modules at runtime.
  experimental: {
    serverComponentsExternalPackages: ['nodemailer', 'imapflow'],
  },
};

module.exports = nextConfig;
