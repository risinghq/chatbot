import devtoolsJson from "vite-plugin-devtools-json";
import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: adapter(),
      inspector: {
        toggleKeyCombo: "control-shift",
        holdMode: true,
        showToggleButton: "always",
      },
    }),
    devtoolsJson(),
  ],

  server: {
    allowedHosts: [".trycloudflare.com", ".ngrok-free.app"],
  },
});
