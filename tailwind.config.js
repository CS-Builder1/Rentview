/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // RentView brand: teal (operations-first, calm, not "money green").
        // Full scale so screens can use brand-50 washes through brand-900 ink.
        brand: {
          50: "#f0fdfa",
          100: "#ccfbf1",
          200: "#99f6e4",
          300: "#5eead4",
          400: "#2dd4bf",
          500: "#14b8a6",
          600: "#0d9488",
          700: "#0f766e",
          800: "#115e59",
          900: "#134e4a",
          950: "#042f2e",
          DEFAULT: "#0f766e",
          light: "#14b8a6",
          dark: "#115e59",
        },
        // Semantic surfaces so screens don't hardcode slate steps.
        // Light values; pair with dark: variants (slate 900/950) in components.
        canvas: "#f8fafc", // page background (slate-50)
        surface: "#ffffff", // cards, sheets
        "canvas-dark": "#020617", // page background dark (slate-950)
        "surface-dark": "#0f172a", // cards dark (slate-900)
        "surface-dark-raised": "#1e293b", // elevated dark (slate-800)
      },
      borderRadius: {
        card: "1rem", // rounded-2xl equivalent, used by Card
        sheet: "1.5rem", // bottom sheets
      },
    },
  },
  plugins: [],
};
