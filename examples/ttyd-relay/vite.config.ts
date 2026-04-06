import { defineConfig } from "vite";
import { devWsPlugin } from "./src/dev-ws-plugin";

export default defineConfig({
  plugins: [devWsPlugin()],
});
