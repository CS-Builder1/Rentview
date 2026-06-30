/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // RentView brand: teal (operations-first, calm, not "money green")
        brand: {
          DEFAULT: "#0f766e",
          light: "#14b8a6",
          dark: "#115e59",
        },
      },
    },
  },
  plugins: [],
};
