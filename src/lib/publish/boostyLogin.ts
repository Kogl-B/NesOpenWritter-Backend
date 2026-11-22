import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseBoostySession, type BoostySession } from './boostySession.js';

const CHROME = process.env.BOOSTY_CHROME || 'google-chrome';
const LOGIN_MS = 3 * 60 * 1000;

let opened = false;

function cancelled(): Error {
  return new Error('Вход в Boosty отменён');
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function cdp<T>(ws: WebSocket, method: string, params?: object): Promise<T> {
  const id = Math.floor(Math.random() * 1_000_000) + 1;
  const result = await new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const data = JSON.parse(String(event.data)) as { id?: number; result?: T; error?: { message?: string } };
      if (data.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (data.error) reject(new Error(data.error.message || 'Браузер не ответил'));
      else resolve(data.result as T);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return result;
}

async function readOpenPage(port: number): Promise<BoostySession | null> {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) }).then((res) => res.json()) as Array<{
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page = list.find((item) => item.type === 'page' && item.url?.includes('boosty.to') && item.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 2_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket')); }, { once: true });
  });
  try {
    const stored = await cdp<{ result?: { value?: string } }>(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const raw = localStorage.getItem('auth');
        if (!raw) return '';
        const deviceId = localStorage.getItem('_clientId') || localStorage.getItem('_clentId') || '';
        return JSON.stringify({ auth: JSON.parse(raw), deviceId });
      })()`,
      returnByValue: true,
    });
    const value = stored.result?.value;
    if (typeof value === 'string' && value) {
      try {
        return parseBoostySession(value);
      } catch {
        /* идентификатор устройства может появиться следом */
      }
    }
    const cookieResult = await cdp<{ cookies?: Array<{ name: string; value: string }> }>(ws, 'Network.getCookies', {
      urls: ['https://boosty.to/'],
    });
    const jar: Record<string, string> = {};
    for (const cookie of cookieResult.cookies ?? []) jar[cookie.name] = cookie.value;
    if (!jar.auth || !jar._clientId) return null;
    return parseBoostySession(JSON.stringify({ auth: jar.auth, deviceId: jar._clientId }));
  } catch {
    return null;
  } finally {
    ws.close();
  }
}

function stopChrome(child: ReturnType<typeof spawn>, dir: string) {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  spawn('pkill', ['-f', dir], { stdio: 'ignore' }).unref();
}

/** Открывает окно Chrome. Когда в нём появляется сессия Boosty, окно закрывается. */
export async function loginBoostyInteractive(signal: AbortSignal): Promise<BoostySession> {
  if (opened) throw new Error('Окно входа в Boosty уже открыто');
  opened = true;
  const dir = await mkdtemp(join(tmpdir(), 'boosty-login-'));
  const child = spawn(CHROME, [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'https://boosty.to/',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  let exited = false;
  child.once('exit', () => { exited = true; });
  try {
    const started = Date.now();
    let port = '';
    while (!port) {
      if (signal.aborted) throw cancelled();
      if (exited) throw new Error('Не удалось открыть окно браузера');
      if (Date.now() - started > 20_000) throw new Error('Не удалось открыть окно браузера');
      try {
        port = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]?.trim() ?? '';
      } catch {
        port = '';
      }
      if (!port) await wait(300, signal);
    }
    const deadline = Date.now() + LOGIN_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) throw cancelled();
      if (exited) throw new Error('Окно закрыто до входа в Boosty');
      const session = await readOpenPage(Number(port)).catch(() => null);
      if (session) return session;
      await wait(1000, signal);
    }
    throw new Error('Вход в Boosty не завершён. Войдите в открытом окне и попробуйте ещё раз.');
  } finally {
    opened = false;
    stopChrome(child, dir);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
