const token = document.querySelector('meta[name="omhp-token"]').content;
const log = document.getElementById('log');
const status = document.getElementById('status');
const buttons = document.querySelectorAll('button');
let busy = false;
const editor = document.getElementById('editor');
const entry = document.getElementById('entry');
const entryStatus = document.getElementById('entry-status');
const type = entry.elements.action;
const files = entry.elements.media;
const catalog = document.querySelector('#build [name="catalog"]');

function updateType() {
  const thread = type.value === 'addThread';
  const video = type.value === 'addVideo';
  for (const [id, name, hidden] of [
    ['entry-title', 'title', thread], ['entry-files', 'media', thread],
    ['entry-text', 'text', !thread], ['entry-theme', 'theme', !thread],
  ]) {
    document.getElementById(id).hidden = hidden;
    entry.elements[name].disabled = hidden;
  }
  files.value = '';
  files.multiple = !video;
  files.accept = video ? '.mp4,.webm' : '.svg,.png,.gif,.jpg,.jpeg,.webp,.avif';
}
type.addEventListener('change', updateType);
updateType();
document.getElementById('open-editor').onclick = () => {
  entryStatus.textContent = '';
  editor.showModal();
};
document.getElementById('cancel-editor').onclick = () => editor.close();


for (const form of document.forms) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !event.submitter) return;
    const adding = form === entry;
    const data = new FormData(form);
    const action = adding ? data.get('action') : event.submitter.value;
    if (adding) data.set('catalog', catalog.value);
    const fields = Object.fromEntries(data);
    const message = adding ? entryStatus : status;
    if (action === 'upload' && !confirm('Загрузить сборку в ' + fields.destination + '?')) return;
    busy = true;
    buttons.forEach(button => { button.disabled = true; });
    log.textContent = '';
    message.textContent = 'Операция выполняется…';
    try {
      const response = await fetch('/run', {
        method: 'POST',
        headers: adding ? { 'X-OMHP-Token': token }
          : { 'X-OMHP-Token': token, 'Content-Type': 'application/json' },
        body: adding ? data : JSON.stringify({ ...fields, action }),
      });
      if (!response.ok) throw new Error(await response.text());
      let pending = '';
      let succeeded = false;
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop();
        for (const line of lines) {
          const entry = JSON.parse(line);
          if (entry.output) log.textContent = (log.textContent + entry.output).slice(-100000);
          if (entry.code === 0) succeeded = true;
        }
        log.scrollTop = log.scrollHeight;
      }
      message.textContent = succeeded ? 'Готово.' : log.textContent.trim() || 'Операция завершилась с ошибкой.';
      if (succeeded && adding) {
        entry.reset();
        updateType();
        editor.close();
        status.textContent = 'Запись добавлена.';
        loadInventory();
      }
      if (succeeded && action === 'build') document.querySelector('#upload [name="output"]').value = fields.output;
    } catch (error) {
      message.textContent = error.message;
    } finally {
      busy = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  });
}


const inventory = document.getElementById('inventory');
const inventoryStatus = document.getElementById('inventory-status');
const kinds = { image: 'Изображение', video: 'Видео', thread: 'Тред', author: 'Автор', composition: 'Композиция' };
let inventoryRequest;

async function loadInventory() {
  inventoryRequest?.abort();
  const request = new AbortController();
  inventoryRequest = request;
  inventory.replaceChildren();
  inventoryStatus.textContent = 'Читаем каталог…';
  try {
    const catalogPath = catalog.value.trim();
    const params = new URLSearchParams({ catalog: catalogPath });
    const response = await fetch('/inventory?' + params, {
      method: 'POST', headers: { 'X-OMHP-Token': token }, signal: request.signal,
    });
    if (!response.ok) throw new Error(await response.text());
    const entries = await response.json();
    if (request.signal.aborted) return;
    for (const entry of entries) {
      const row = document.createElement('li');
      const heading = document.createElement('strong');
      heading.textContent = `${kinds[entry.kind]} · ${entry.title || entry.id || 'Без названия'}`;
      row.append(heading);
      for (const file of entry.files) {
        const line = document.createElement('div');
        line.className = file.available ? 'file' : 'file missing';
        if (file.type) {
          const video = file.type.startsWith('video/');
          const preview = document.createElement(video ? 'video' : 'img');
          preview.className = 'thumbnail';
          if (video) {
            preview.preload = 'metadata';
            preview.muted = true;
            preview.playsInline = true;
            preview.setAttribute('aria-label', 'Кадр видео');
          } else {
            preview.loading = 'lazy';
            preview.alt = '';
          }
          const query = new URLSearchParams({ catalog: catalogPath, file: file.path, token });
          preview.src = '/preview?' + query + (video ? '#t=0.1' : '');
          line.append(preview);
        }
        const name = document.createElement('span');
        name.textContent = file.available ? file.path : `${file.path || 'Файл не указан'} — недоступен`;
        line.append(name);
        row.append(line);
      }
      inventory.append(row);
    }
    inventoryStatus.textContent = entries.length ? '' : 'Каталог пуст.';
  } catch (error) {
    if (!request.signal.aborted) inventoryStatus.textContent = error.message;
  }
}

document.getElementById('refresh-inventory').addEventListener('click', loadInventory);
catalog.addEventListener('change', loadInventory);
loadInventory();
