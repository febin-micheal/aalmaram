import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Inside docker-compose the API is another service; running `npm run dev` on the host it
// is on localhost. Either way the browser only ever talks to the Vite origin.
const apiTarget = process.env.VITE_PROXY_TARGET ?? 'http://backend:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Inside docker the bind mount does not deliver inotify events reliably.
    watch: { usePolling: true },
    // Proxying rather than calling http://localhost:8000 directly is what makes the
    // admin session authenticate the explorer. The session cookie is scoped to
    // `localhost` (cookies ignore ports), so the browser already sends it to :5173;
    // the proxy passes it through to Django. `changeOrigin: false` keeps the Host
    // header as localhost:5173 so the cookie is never re-scoped on the way back.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      // Handy for the "open in admin" links, and for logging in from the app.
      '/admin': { target: apiTarget, changeOrigin: false },
      '/static': { target: apiTarget, changeOrigin: false },
    },
  },
})
