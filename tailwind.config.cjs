/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{vue,ts}"],
  theme: {
    extend: {
      colors: {
        paper: {
          50: "#fdfbf6",
          100: "#f7f2e8",
          200: "#ebe2d3",
          700: "#332f29",
          800: "#27231f",
          900: "#1d1a17",
          950: "#151310",
        },
        ink: {
          100: "#eee7dc",
          300: "#c3b8a7",
          400: "#9d9181",
          500: "#786e61",
          600: "#5e554a",
          700: "#443d35",
          800: "#332e28",
          900: "#26221d",
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
