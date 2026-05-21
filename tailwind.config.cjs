/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{vue,ts}"],
  theme: {
    extend: {
      colors: {
        paper: {
          50: "#fbfaf7",
          100: "#f5f3ee",
          200: "#ebe7df",
          800: "#1b1a18",
          900: "#121210",
          950: "#0c0c0b",
        },
        ink: {
          100: "#e8e5df",
          300: "#b9b3a8",
          500: "#756f66",
          700: "#3b3833",
          900: "#1f1e1b",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
