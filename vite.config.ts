import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Listen on 0.0.0.0 (all interfaces) so the dev server is reachable from
    // other devices on the LAN or over a Tailscale VPN, not just localhost.
    host: true,
    port: 5173,
    strictPort: false,
    // Tailscale gives machines *.ts.net names; Vite blocks unknown Host
    // headers by default, so allow them explicitly.
    allowedHosts: ['.ts.net', 'localhost'],
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: ['.ts.net', 'localhost'],
  },
  build: {
    target: 'es2020',
  },
});
