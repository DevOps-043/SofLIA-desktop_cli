import http from 'node:http';
import * as os from 'node:os';
import { SofliaWorkerApiClient } from './api-client.js';
import { loadConfig, saveConfig } from './config.js';
import { getConfigPath } from './paths.js';

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

function getAppVersion(): string {
  return process.env.npm_package_version || 'dev';
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SofLIA - Engine Render Worker</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1419; color: #f8fafc; }
    main { width: min(560px, calc(100vw - 32px)); border: 1px solid rgba(148, 163, 184, .24); border-radius: 12px; background: #151a21; padding: 24px; box-shadow: 0 20px 60px rgba(0, 0, 0, .35); }
    h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: 0; }
    p { margin: 0 0 20px; color: #a8b3c2; line-height: 1.5; }
    label { display: grid; gap: 8px; margin-top: 14px; font-size: 13px; font-weight: 700; color: #dbe4f0; }
    input { width: 100%; box-sizing: border-box; border: 1px solid rgba(148, 163, 184, .28); border-radius: 8px; background: #0f1419; color: #fff; padding: 12px; font: inherit; outline: none; }
    input:focus { border-color: #1f5af6; box-shadow: 0 0 0 3px rgba(31, 90, 246, .22); }
    button { width: 100%; margin-top: 18px; border: 0; border-radius: 8px; background: #1f5af6; color: white; padding: 12px 14px; font: inherit; font-weight: 800; cursor: pointer; }
    button:disabled { opacity: .6; cursor: wait; }
    .status { margin-top: 16px; border-radius: 8px; padding: 12px; background: rgba(148, 163, 184, .12); color: #dbe4f0; font-size: 13px; white-space: pre-wrap; }
    .ok { background: rgba(34, 197, 94, .14); color: #bbf7d0; }
    .bad { background: rgba(239, 68, 68, .14); color: #fecaca; }
  </style>
</head>
<body>
  <main>
    <h1>SofLIA - Engine Render Worker</h1>
    <p>Pega el codigo temporal generado en SofLIA - Engine. Esta pantalla guarda el token localmente y deja el worker online.</p>
    <form id="link-form">
      <label>
        API URL
        <input id="apiUrl" name="apiUrl" value="http://localhost:3000" autocomplete="url" required />
      </label>
      <label>
        Codigo
        <input id="code" name="code" placeholder="SLIA-482913" pattern="SLIA-[0-9]{6}" autocomplete="one-time-code" required />
      </label>
      <button id="submit" type="submit">Vincular worker</button>
    </form>
    <div id="status" class="status">Esperando codigo...</div>
  </main>
  <script>
    const form = document.getElementById('link-form');
    const statusBox = document.getElementById('status');
    const submit = document.getElementById('submit');

    async function refreshStatus() {
      const response = await fetch('/api/status');
      const status = await response.json();
      if (status.configured) {
        document.getElementById('apiUrl').value = status.apiUrl;
        statusBox.className = 'status ok';
        statusBox.textContent = 'Worker configurado. Estado: ' + status.message;
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      statusBox.className = 'status';
      statusBox.textContent = 'Vinculando...';
      const payload = {
        apiUrl: document.getElementById('apiUrl').value,
        code: document.getElementById('code').value,
      };
      try {
        const response = await fetch('/api/link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'No se pudo vincular');
        statusBox.className = 'status ok';
        statusBox.textContent = 'Worker vinculado y online. Ya puedes dejar corriendo: node dist/cli.js start';
      } catch (error) {
        statusBox.className = 'status bad';
        statusBox.textContent = error.message || String(error);
      } finally {
        submit.disabled = false;
      }
    });

    refreshStatus().catch(() => {});
  </script>
</body>
</html>`;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function startLocalUiServer(options: { port?: number } = {}): Promise<void> {
  const port = options.port || 41741;
  const host = '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}:${port}`);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        try {
          const config = await loadConfig();
          const client = new SofliaWorkerApiClient(config.apiUrl, config.token);
          await client.heartbeat('ONLINE');
          sendJson(res, 200, { configured: true, apiUrl: config.apiUrl, message: 'ONLINE' });
        } catch {
          sendJson(res, 200, { configured: false, message: 'Sin configurar' });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/link') {
        const body = await readJsonBody(req);
        const apiUrl = normalizeApiUrl(String(body.apiUrl || ''));
        const code = String(body.code || '').trim().toUpperCase();
        if (!apiUrl || !/^SLIA-\d{6}$/.test(code)) {
          sendJson(res, 400, { error: 'API URL y codigo SLIA-000000 son requeridos.' });
          return;
        }

        const client = new SofliaWorkerApiClient(apiUrl);
        const result = await client.linkWorker({
          code,
          deviceName: os.hostname() || 'SofLIA Render Worker',
          platform: process.platform,
          arch: process.arch,
          appVersion: getAppVersion(),
        });

        await saveConfig({ apiUrl, token: result.workerToken });
        const authenticatedClient = new SofliaWorkerApiClient(apiUrl, result.workerToken);
        await authenticatedClient.heartbeat('ONLINE');

        sendJson(res, 200, {
          success: true,
          workerId: result.worker.id,
          configPath: getConfigPath(),
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  console.log(`UI local disponible en http://${host}:${port}`);
  console.log('Deja esta terminal abierta mientras usas la pantalla.');
}
