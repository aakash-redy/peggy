import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // This is the "GPS" that tells Vite: 
      // Whenever you see "@", look inside the "src" folder.
      "@": path.resolve(__dirname, "./src"),
    },
  },
})