import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        parchment: "#F2E8D5",
        vellum: "#FAF4E6",
        ink: "#1C1610",
        sepia: "#594A3C",
        frame: "#2A2118",
        inset: "#A8967A",
        gridline: "#C8B9A0",
        crimson: "#9E2A2B",
        verdigris: "#2B5B6C",
        sage: "#4F6D5A",
        gold: "#B5892E",
        "gold-deep": "#7D5C19",
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        script: ["var(--font-script)", "cursive"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
