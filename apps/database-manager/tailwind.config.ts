import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        panel: "0 10px 30px rgba(11, 20, 27, 0.18)"
      },
      colors: {
        ink: "#0f1c24",
        mist: "#eef4f7",
        sea: "#126e82",
        reef: "#51b7a6",
        ember: "#d97706"
      },
      animation: {
        riseIn: "riseIn 280ms ease-out",
        pulseSoft: "pulseSoft 1.8s ease-in-out infinite"
      },
      keyframes: {
        riseIn: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        },
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: ".7" }
        }
      }
    }
  },
  plugins: []
};

export default config;
