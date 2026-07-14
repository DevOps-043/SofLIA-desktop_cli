import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
});

await server.listen();
const info = server.config.server;
const port = info.port || 5173;
const rendererUrl = `http://127.0.0.1:${port}`;

const electron = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SOFLIA_RENDERER_DEV_URL: rendererUrl,
  },
});

electron.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  electron.kill('SIGINT');
});

process.on('SIGTERM', () => {
  electron.kill('SIGTERM');
});
