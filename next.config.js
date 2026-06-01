/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {},
  serverExternalPackages: ['nodemailer', 'imapflow', 'dns', 'net'],
};

module.exports = nextConfig;
