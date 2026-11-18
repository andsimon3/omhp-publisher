import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const types = ['image', 'video', 'author', 'thread', 'composition'];
const mime = new Map(Object.entries({
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
}));

async function prepare(input, catalogPath, publicUrl) {
  const origin = new URL(publicUrl);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.href !== origin.origin + '/') {
    throw new Error('Public URL must be an HTTP(S) origin without a path');
  }

  const root = await realpath(dirname(resolve(catalogPath)));
  const records = new Map();
  const assets = new Map();
  for (const kind of types) {
    const entries = input[kind] ?? [];
    if (!Array.isArray(entries)) throw new Error(`${kind} must be an array`);
    for (const entry of entries) {
      const { id, files, file, type, ...data } = entry;
      if (typeof id !== 'string' || !/^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(id) || id.endsWith('.')) {
        throw new Error(`Invalid ${kind} ID: ${id}`);
      }
      const path = `/${kind}/${encodeURIComponent(id)}`;
      if (records.has(path)) throw new Error(`Duplicate record: ${path}`);
      const requiredText = { image: 'title', video: 'title', author: 'name', thread: 'text' }[kind];
      if (requiredText && (typeof data[requiredText] !== 'string' || !data[requiredText].trim())) {
        throw new Error(`Missing ${requiredText}: ${path}`);
      }

      const media = kind === 'image' ? files : kind === 'video' ? [file] : [];
      if (!Array.isArray(media) || (kind === 'image' && media.length === 0)) {
        throw new Error(`Expected media files: ${path}`);
      }
      const sources = [];
      for (const [index, filename] of media.entries()) {
        if (typeof filename !== 'string' || !filename || isAbsolute(filename)) {
          throw new Error(`Expected a relative media filename: ${path}`);
        }
        const source = await realpath(resolve(root, filename));
        const localPath = relative(root, source);
        const extension = extname(filename).toLowerCase();
        if (localPath === '..' || localPath.startsWith('..' + sep) || isAbsolute(localPath)
          || !(await stat(source)).isFile() || !mime.get(extension)?.startsWith(kind + '/')) {
          throw new Error(`Invalid ${kind} file: ${filename}`);
        }
        const key = `media/${kind}/${id}/${index}${extension}`;
        assets.set(key, source);
        sources.push(new URL(`/media/${kind}/${encodeURIComponent(id)}/${index}${extension}`, origin).href);
      }
      if (kind === 'image') data.source = sources;
      if (kind === 'video') {
        const expected = type === 'h256' ? '.mp4' : type === 'VP9' ? '.webm' : null;
        if (extname(file).toLowerCase() !== expected) throw new Error(`Invalid video type: ${path}`);
        data.source = { type, link: sources[0] };
      }
      records.set(path, { key: `${kind}/${id}`, data });
    }
  }

  function publicLink(value, prefix) {
    if (typeof value !== 'string' || !value) throw new Error('Expected a resource URL');
    const url = new URL(value, origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`Invalid resource URL: ${value}`);
    }
    // Rebase links from the existing local demo catalog to the published origin.
    const demoHost = ['127.0.0.1:8080', '127.0.0.1:8081', 'localhost:8080', 'localhost:8081'].includes(url.host);
    const local = (value.startsWith('/') && !value.startsWith('//')) || (demoHost && records.has(url.pathname));
    if (local) {
      if ((prefix && !url.pathname.startsWith(prefix)) || !records.has(url.pathname) || url.search || url.hash) {
        throw new Error(`Unknown local resource: ${value}`);
      }
      return new URL(url.pathname, origin).href;
    }
    if (!/^https?:\/\//i.test(value)) throw new Error(`Expected an absolute URL or a local path: ${value}`);
    return url.href;
  }

  for (const { data } of records.values()) {
    if (data.authors !== undefined) {
      if (!Array.isArray(data.authors)) throw new Error('authors must be an array');
      data.authors = data.authors.map(link => publicLink(link, '/author/'));
    }
    if (data.theme !== undefined) data.theme = publicLink(data.theme);
  }

  return { records, assets };
}

async function build(catalogPath, output, publicUrl) {
  const input = JSON.parse(await readFile(catalogPath, 'utf8'));
  const { records, assets } = await prepare(input, catalogPath, publicUrl);

  const writeJson = async (key, value) => {
    const path = join(output, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  };
  await mkdir(output);
  try {
    await writeJson('index.html', { name: input.name ?? 'OMHP static host' });
    for (const [key, source] of assets) {
      const target = join(output, key);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    for (const { key, data } of records.values()) await writeJson(key, data);
    await writeJson('mediamap', [...records.keys()]);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  console.log(`Built ${records.size} records and ${assets.size} media files in ${output}`);
}

async function addRecord(kind, catalogPath, entry) {
  const path = await realpath(catalogPath);
  const lockPath = path + '.lock';
  const lock = await open(lockPath, 'wx');
  let temp;
  try {
    const input = JSON.parse(await readFile(path, 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a catalog object');
    const entries = input[kind] ?? [];
    if (!Array.isArray(entries)) throw new Error(`${kind} must be an array`);
    input[kind] = [...entries, entry];
    await prepare(input, path, 'https://catalog.invalid');
    temp = await mkdtemp(join(dirname(path), '.omhp-catalog-'));
    const next = join(temp, 'catalog.json');
    const { mode } = await stat(path);
    await writeFile(next, JSON.stringify(input, null, 2) + '\n', { mode: mode & 0o777 });
    await rename(next, path);
    console.log(`Added ${kind}/${entry.id} to ${catalogPath}`);
  } finally {
    try {
      if (temp) await rm(temp, { recursive: true, force: true });
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

async function upload(output, destination, dryRun) {
  if (!/^s3:\/\/[a-z0-9][a-z0-9.-]*(?:\/[^?#]*)?$/.test(destination)) {
    throw new Error('Expected s3://bucket or s3://bucket/prefix');
  }
  const prefix = destination.replace(/\/+$/, '');
  const files = [];
  for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected symbolic link in build directory');
    if (entry.isFile()) files.push(relative(output, join(entry.parentPath ?? entry.path, entry.name)));
  }
  if (!files.includes('mediamap') || !files.includes('index.html')) {
    throw new Error('Expected an OMHP build directory');
  }
  const paths = JSON.parse(await readFile(join(output, 'mediamap'), 'utf8'));
  const metadata = paths.map(path => decodeURIComponent(path.slice(1)));
  const assets = files.filter(key => key.startsWith('media' + sep));
  const keys = [...assets, ...metadata, 'index.html', 'mediamap'];
  const available = new Set(files);
  if (!keys.every(key => available.has(key))) throw new Error('Missing files in OMHP build');
  for (const key of keys) {
    const contentType = key.startsWith('media' + sep)
      ? mime.get(extname(key)) : 'application/json; charset=utf-8';
    if (!contentType) throw new Error(`Unknown file type: ${key}`);
    const args = ['s3', 'cp', join(resolve(output), key), `${prefix}/${key.split(sep).join('/')}`,
      '--content-type', contentType, '--no-progress', '--no-follow-symlinks'];
    if (dryRun) args.push('--dryrun');
    const result = spawnSync('aws', args, { stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') throw new Error('AWS CLI is required for upload');
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Upload failed for ${key}`);
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'ui' && args.length === 0) {
    const { startUi } = await import('./ui.mjs');
    await startUi();
  } else if (command === 'addImage' && args.length >= 4) {
    const [catalog, id, title, ...files] = args;
    await addRecord('image', catalog, { id, title, files });
  } else if (command === 'addVideo' && args.length === 5) {
    const [catalog, id, title, file, type] = args;
    await addRecord('video', catalog, { id, title, file, type });
  } else if (command === 'addThread' && (args.length === 3 || args.length === 4)) {
    const [catalog, id, text, theme] = args;
    await addRecord('thread', catalog, { id, text, ...(theme ? { theme } : {}) });
  } else if (command === 'build' && args.length === 3) await build(...args);
  else if (command === 'upload' && (args.length === 2 || (args.length === 3 && args[2] === '--dry-run'))) {
    await upload(args[0], args[1], args.length === 3);
  } else {
    throw new Error('Usage: node cli.mjs build <catalog.json> <new-output-dir> <public-origin>\n'
      + '       node cli.mjs upload <output-dir> <s3://bucket[/prefix]> [--dry-run]\n       node cli.mjs ui\n'
      + '       node cli.mjs addImage <catalog.json> <id> <title> <file> [file ...]\n'
      + '       node cli.mjs addVideo <catalog.json> <id> <title> <file> <h256|VP9>\n'
      + '       node cli.mjs addThread <catalog.json> <id> <text> [theme]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
