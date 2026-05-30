import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "#3B82F6",
          hover: "#2563EB",
          light: "#60A5FA",
        },
        surface: {
          base: "#0F172A",
          card: "#1E293B",
          border: "#334155",
          hover: "#263548",
        },
        brand: {
          50: "#f0f5ff",
          100: "#e0ebff",
          200: "#c7d9ff",
          300: "#a3c0ff",
          400: "#789dff",
          500: "#5278ff",
          600: "#3b5af5",
          700: "#2d44d8",
          800: "#2839ae",
          900: "#273589",
          950: "#1a2154",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
