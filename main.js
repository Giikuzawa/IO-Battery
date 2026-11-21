'use strict';
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, screen, session, clipboard,
} = require('electron');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.setAppUserModelId('io.battery.tray');

const WIDTH = 380;
const SOLID_BG = '#14171c';
// Для portable-сборки electron-builder process.execPath указывает на временную распаковку,
// настоящий путь к файлу лежит в PORTABLE_EXECUTABLE_FILE
const AUTOSTART_EXE = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

// Системный материал окна (Acrylic) доступен на Windows 11 22H2 и новее (сборка 22621+)
const materialSupported =
  process.platform === 'win32' && parseInt(String(os.release()).split('.')[2], 10) >= 22621;
let materialOn = false;

function applyMaterial(on) {
  if (!win || !materialSupported || typeof win.setBackgroundMaterial !== 'function') return false;
  materialOn = !!on;
  win.setBackgroundMaterial(materialOn ? 'acrylic' : 'none');
  win.setBackgroundColor(materialOn ? '#00000000' : SOLID_BG);
  return materialOn;
}
let win = null;
let tray = null;
let quitting = false;
let lastHideAt = 0;

// ───────────── окно-панель ─────────────
function createWindow() {
  win = new BrowserWindow({
    width: WIDTH,
    height: 440,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: SOLID_BG,
    title: 'IO Battery',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Окно скрыто почти всё время, но опрос устройств должен идти по таймеру
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('blur', () => {
    if (!win.webContents.isDevToolsOpened()) hidePanel();
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hidePanel();
    }
  });
}

function hidePanel() {
  if (win?.isVisible()) {
    win.hide();
    lastHideAt = Date.now();
  }
}

function placePanel() {
  if (!win) return;
  const point = tray ? tray.getBounds() : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x: point.x, y: point.y });
  const wa = display.workArea;
  const [w, h] = win.getSize();
  const taskbarOnTop = wa.y > display.bounds.y && wa.height < display.bounds.height && wa.y - display.bounds.y > 0;
  const x = Math.round(wa.x + wa.width - w - 12);
  const y = taskbarOnTop ? wa.y + 12 : Math.round(wa.y + wa.height - h - 12);
  win.setPosition(x, Math.max(wa.y, y));
}

function showPanel() {
  placePanel();
  win.show();
  win.focus();
  win.webContents.send('panel:shown');
}

function togglePanel() {
  if (win.isVisible()) return hidePanel();
  // Клик по трею сначала снимает фокус (blur → hide), а затем приходит click: не открываем заново
  if (Date.now() - lastHideAt < 250) return;
  showPanel();
}

// ───────────── трей ─────────────
function placeholderIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x8a; buf[i * 4 + 1] = 0x8a; buf[i * 4 + 2] = 0x8a; buf[i * 4 + 3] = 0xff; // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(placeholderIcon());
  tray.setToolTip('IO Battery: читаю устройства…');
  tray.on('click', togglePanel);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Показать панель', click: () => showPanel() },
      { label: 'Обновить сейчас', click: () => win?.webContents.send('refresh') },
      { type: 'separator' },
      { label: 'Выход', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

// ───────────── права WebHID ─────────────
function setupHidPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'hid');
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'hid'));
  // Без этого navigator.hid.getDevices() вернёт пустой список: выдаём доступ сами, без окон выбора
  ses.setDevicePermissionHandler((details) => details.deviceType === 'hid');
  // Запасной путь: кнопка «Добавить вручную» вызывает requestDevice
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const first = details.deviceList?.[0];
    callback(first ? first.deviceId : undefined);
  });
}

// ───────────── Bluetooth: заряд, который уже знает Windows ─────────────
const { FULL: BT_FULL, QUICK: BT_QUICK } = require('./bt-scripts.js');

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout || '').trim();
        const start = text.indexOf('[');
        if (start >= 0) {
          try {
            const parsed = JSON.parse(text.slice(start));
            return resolve({ ok: true, items: Array.isArray(parsed) ? parsed : [parsed] });
          } catch { /* ниже вернём ошибку */ }
        }
        const reason = err ? (err.killed ? 'таймаут PowerShell' : String(err.message || err).split('\n')[0].slice(0, 160)) : 'пустой ответ';
        resolve({ ok: false, error: reason, items: [] });
      },
    );
  });
}

const FULL_SCAN_MS = 30 * 60 * 1000; // когда найдено хоть что-то
const EMPTY_SCAN_MS = 10 * 60 * 1000; // когда не найдено ничего: ищем реже, но не бросаем
const bt = { known: [], fullAt: 0, running: null };

async function btFullScan() {
  const r = await runPowerShell(BT_FULL, 120000);
  bt.fullAt = Date.now();
  if (!r.ok) return r;
  const items = r.items.filter((x) => x && x.name && Number.isInteger(x.pct));
  bt.known = items.map((x) => ({ id: x.id, name: x.name, ids: [].concat(x.ids ?? [x.id]) }));
  return { ok: true, items, mode: 'full' };
}

async function btQuickPoll() {
  const text = bt.known.map((k) => [k.id, ...k.ids].join('\t')).join('\n');
  const payload = Buffer.from(text, 'utf8').toString('base64');
  const r = await runPowerShell(BT_QUICK.replace('__ENTRIES_B64__', payload), 60000);
  if (!r.ok) return r;
  const names = new Map(bt.known.map((k) => [k.id, k.name]));
  const items = r.items
    .filter((x) => x && Number.isInteger(x.pct) && names.has(x.id))
    .map((x) => ({ id: x.id, name: names.get(x.id), pct: x.pct, connected: x.connected }));
  if (items.length === 0) {
    // Пустой ответ при известных устройствах: это сбой или они исчезли. Список не затираем,
    // а при следующем опросе сделаем полный обзор.
    bt.fullAt = 0;
    return { ok: false, error: 'быстрый опрос ничего не вернул, повторю полным обзором', items: [] };
  }
  return { ok: true, items, mode: 'quick' };
}

// Выбор режима: полный обзор нужен при первом запуске, раз в полчаса и по ручному обновлению
// (если прошлый обзор был больше минуты назад); в остальное время хватает быстрого опроса.
function chooseBtMode({ force, known, fullAt, now }) {
  const age = now - fullAt;
  if (known === 0) return fullAt !== 0 && age < EMPTY_SCAN_MS && !force ? 'idle' : 'full';
  if (age > FULL_SCAN_MS) return 'full';
  if (force && age > 60000) return 'full';
  return 'quick';
}

function readBluetooth(force) {
  // Для тестов: IOBAT_FAKE_BT_SEQ='[{ответ1},{ответ2},…]', каждый вызов отдаёт следующий ответ (последний повторяется)
  if (process.env.IOBAT_FAKE_BT_SEQ) {
    try {
      globalThis.__fakeSeq ??= JSON.parse(process.env.IOBAT_FAKE_BT_SEQ);
      const next = globalThis.__fakeSeq.length > 1 ? globalThis.__fakeSeq.shift() : globalThis.__fakeSeq[0];
      return Promise.resolve(next);
    } catch { /* игнор */ }
  }
  // Для разработки и тестов: IOBAT_FAKE_BT='[{"name":"…","id":"…","pct":50,"connected":true}]'
  if (process.env.IOBAT_FAKE_BT) {
    try { return Promise.resolve({ ok: true, items: JSON.parse(process.env.IOBAT_FAKE_BT), mode: 'fake' }); } catch { /* игнор */ }
  }
  if (process.platform !== 'win32') return Promise.resolve({ ok: true, items: [], mode: 'skip' });
  if (bt.running) return bt.running; // повторные запросы не плодят процессы PowerShell
  const mode = chooseBtMode({ force, known: bt.known.length, fullAt: bt.fullAt, now: Date.now() });
  if (mode === 'idle') return Promise.resolve({ ok: true, items: [], mode });
  bt.running = (mode === 'full' ? btFullScan() : btQuickPoll()).finally(() => { bt.running = null; });
  return bt.running;
}

// ───────────── IPC ─────────────
function setupIpc() {
  ipcMain.handle('bt:read', (_e, force) => readBluetooth(!!force));

  ipcMain.on('tray:update', (_e, { icon, tooltip }) => {
    try {
      if (icon) tray.setImage(nativeImage.createFromDataURL(icon));
      if (tooltip) tray.setToolTip(String(tooltip).slice(0, 120));
    } catch { /* иконка не критична */ }
  });

  ipcMain.on('notify', (_e, { title, body }) => {
    if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
  });

  ipcMain.on('resize', (_e, height) => {
    const h = Math.max(220, Math.min(700, Math.round(Number(height) || 440)));
    if (!win) return;
    win.setSize(WIDTH, h);
    if (win.isVisible()) placePanel();
  });

  ipcMain.handle('material:get', () => ({ supported: materialSupported, enabled: materialOn }));
  ipcMain.handle('material:set', (_e, on) => applyMaterial(on));

  ipcMain.handle('autostart:get', () => app.getLoginItemSettings({ path: AUTOSTART_EXE }).openAtLogin);
  ipcMain.handle('autostart:set', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on, path: AUTOSTART_EXE });
    return app.getLoginItemSettings({ path: AUTOSTART_EXE }).openAtLogin;
  });

  ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.on('win:hide', () => hidePanel());
  ipcMain.on('app:quit', () => { quitting = true; app.quit(); });
}

app.on('second-instance', () => {
  if (win) showPanel();
});

app.whenReady().then(() => {
  setupHidPermissions();
  setupIpc();
  createWindow();
  createTray();
  if (process.argv.includes('--show')) win.once('ready-to-show', showPanel);
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());
