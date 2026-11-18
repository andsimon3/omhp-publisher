import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/ui.css', ['ui.css', 'text/css']],
  ['/ui-client.js', ['ui-client.js', 'text/javascript']],
]);

function run(args, profile, response) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ...(profile ? { AWS_PROFILE: profile } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  const send = data => response.write(JSON.stringify(data) + '\n');
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', output => send({ output }));
  }
  child.on('error', error => send({ output: error.message }));
  return new Promise(resolve => child.once('close', code => {
    send({ code });
    response.end();
    resolve(code);
  }));
}

async function addEntry(request, response) {
  const maxBytes = 256 * 1024 * 1024;
  let size = 0;
  async function* limitedBody() {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('Файлы должны занимать не более 256 МБ.');
      yield chunk;
    }
  }
  if (Number(request.headers['content-length']) > maxBytes) {
    throw new Error('Файлы должны занимать не более 256 МБ.');
  }
  const form = await new Request('http://localhost/run', {
    method: 'POST',
    headers: { 'Content-Type': request.headers['content-type'] },
    body: Readable.toWeb(Readable.from(limitedBody())),
    duplex: 'half',
  }).formData();
  const field = name => {
    const value = form.get(name);
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('Проверьте поля формы.');
    return value.trim();
  };
  const action = field('action');
  const catalog = field('catalog');
  const id = field('id');
  if (!catalog || !id) throw new Error('Укажите каталог и ID.');
  if (action === 'addThread') {
    const text = field('text');
    const theme = field('theme');
    return run([action, catalog, id, text, ...(theme ? [theme] : [])], undefined, response);
  }
  if (!['addImage', 'addVideo'].includes(action)) throw new Error('Неизвестный тип записи.');
  const title = field('title');
  const files = form.getAll('media');
  const video = action === 'addVideo';
  if (!title || !files.length || (video && files.length !== 1)
    || files.some(file => typeof file === 'string' || !file.size)) {
    throw new Error('Укажите название и выберите файлы.');
  }
  const extensions = files.map(file => extname(file.name).toLowerCase());
  const allowed = video ? ['.mp4', '.webm'] : ['.svg', '.png', '.gif', '.jpg', '.jpeg', '.webp', '.avif'];
  if (extensions.some(extension => !allowed.includes(extension))) {
    throw new Error('Выбран неподдерживаемый формат файла.');
  }
  const root = dirname(await realpath(catalog));
  const directory = await mkdtemp(join(root, 'publisher-media-'));
  let saved = false;
  try {
    const paths = [];
    for (const [index, file] of files.entries()) {
      const path = join(directory, index + extensions[index]);
      await writeFile(path, Buffer.from(await file.arrayBuffer()), { flag: 'wx' });
      paths.push(relative(root, path));
    }
    if (video) paths.push(extensions[0] === '.mp4' ? 'h256' : 'VP9');
    saved = (await run([action, catalog, id, title, ...paths], undefined, response)) === 0;
  } finally {
    if (!saved) await rm(directory, { recursive: true, force: true });
  }
}

const previewTypes = new Map(Object.entries({
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm',
}));

async function localFile(root, filename) {
  if (typeof filename !== 'string' || !filename || isAbsolute(filename)) return null;
  try {
    const source = await realpath(resolve(root, filename));
    const local = relative(root, source);
    if (local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) return null;
    return (await stat(source)).isFile() ? source : null;
  } catch {
    return null;
  }
}

async function inventory(catalog) {
  const path = await realpath(catalog);
  const root = dirname(path);
  const input = JSON.parse(await readFile(path, 'utf8'));
  const entries = [];
  for (const kind of ['image', 'video', 'thread', 'author', 'composition']) {
    const records = input[kind] ?? [];
    if (!Array.isArray(records)) throw new Error(`Поле ${kind} должно быть массивом.`);
    for (const item of records) {
      const paths = kind === 'image' ? (Array.isArray(item.files) && item.files.length ? item.files : [null])
        : kind === 'video' ? [item.file] : [];
      const files = await Promise.all(paths.map(async filename => {
        const source = await localFile(root, filename);
        const type = source && previewTypes.get(extname(filename).toLowerCase());
        return { path: typeof filename === 'string' ? filename : '', available: Boolean(source), type };
      }));
      entries.push({ kind, id: item.id, title: item.title ?? item.name ?? item.text, files });
    }
  }
  return entries;
}

export async function startUi() {
  const token = randomBytes(24).toString('hex');
  let busy = false;
  const server = createServer(async (request, response) => {
    const address = '127.0.0.1:' + server.address().port;
    const origin = 'http://' + address;
    const path = request.url?.split('?')[0];
    response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    const reject = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(message);
    };
    if (request.headers.host !== address) return reject(403, 'Неверный адрес.');
    try {
      if (request.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(new URL(file, import.meta.url), 'utf8');
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return response.end(file === 'index.html' ? content.replace('__TOKEN__', token) : content);
      }
      if (request.method === 'GET' && path === '/preview') {
        const params = new URL(request.url, origin).searchParams;
        if (params.get('token') !== token) return reject(403, 'Запрос отклонён.');
        const catalog = await realpath(params.get('catalog') ?? '');
        const filename = params.get('file') ?? '';
        const type = previewTypes.get(extname(filename).toLowerCase());
        const entries = await inventory(catalog);
        if (!type || !entries.some(entry => entry.files.some(file => file.path === filename && file.available))) {
          return reject(404, 'Файл недоступен.');
        }
        const source = await localFile(dirname(catalog), filename);
        if (!source) return reject(404, 'Файл недоступен.');
        const { size } = await stat(source);
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (range && (start > end || start >= size)) {
          response.setHeader('Content-Range', `bytes */${size}`);
          return reject(416, 'Неверный диапазон.');
        }
        response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        response.setHeader('Content-Type', type);
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Length', Math.max(0, end - start + 1));
        if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        response.writeHead(range ? 206 : 200);
        if (!size) return response.end();
        const stream = createReadStream(source, { start, end });
        stream.on('error', error => response.destroy(error));
        response.once('close', () => stream.destroy());
        stream.pipe(response);
        return;
      }
      if (request.method !== 'POST' || !['/run', '/inventory'].includes(path)) return reject(404, 'Страница не найдена.');
      if (request.headers.origin !== origin || request.headers['x-omhp-token'] !== token) {
        return reject(403, 'Запрос отклонён.');
      }
      if (path === '/inventory') {
        const catalog = new URL(request.url, origin).searchParams.get('catalog')?.trim();
        if (!catalog || catalog.includes('\0')) return reject(400, 'Укажите JSON-каталог.');
        const entries = await inventory(catalog);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify(entries));
      }
      if (busy) return reject(409, 'Дождитесь завершения текущей операции.');
      busy = true;
      try {
        if (request.headers['content-type']?.startsWith('multipart/form-data;')) {
          await addEntry(request, response);
          return;
        }
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 16384) throw new Error('Слишком длинный запрос.');
        }
        const data = JSON.parse(body);
        const fields = new Map([
          ['build', ['catalog', 'output', 'publicUrl']],
          ['preview', ['output', 'destination']],
          ['upload', ['output', 'destination']],
        ]).get(data?.action);
        if (!fields
          || fields.some(field => typeof data[field] !== 'string' || !data[field].trim() || data[field].includes('\0'))
          || (data.profile != null && (typeof data.profile !== 'string' || data.profile.includes('\0')))) {
          throw new Error('Проверьте поля формы.');
        }
        const args = [data.action === 'preview' ? 'upload' : data.action, ...fields.map(field => data[field].trim())];
        if (data.action === 'preview') args.push('--dry-run');
        await run(args, data.profile?.trim(), response);
      } finally {
        busy = false;
      }
    } catch (error) {
      if (!response.headersSent) reject(400, error.message);
      else response.end();
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port;
    console.log('OMHP Publisher: ' + url);
    const [command, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
    spawn(command, args, { stdio: 'ignore' }).on('error', () => {});
  });
}
