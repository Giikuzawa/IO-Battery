(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ───────── хранилище ─────────
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* не критично */ } },
  };
  const settings = Object.assign({ intervalSec: 120, threshold: 20, notify: true, debug: false, material: true }, store.get('settings', {}));
  const lastKnown = store.get('last', {}); // ключ → {percent, charging, ts}
  const saveSettings = () => store.set('settings', settings);

  // ───────── журнал ─────────
  const logLines = [];
  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    logLines.push(`${t} ${msg}`);
    if (logLines.length > 400) logLines.shift();
    if (settings.debug) {
      const el = $('log');
      el.textContent = logLines.join('\n');
      el.scrollTop = el.scrollHeight;
    }
  }

  // ───────── имена и группы ─────────
  const cleanHidName = (n) =>
    String(n || '').replace(/\s*\b2\.4\s?G(Hz)?\b/gi, '').replace(/\s*\b(Receiver|Dongle)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  const cleanBtName = (n) =>
    String(n || '').replace(/\s*(Hands-?Free( AG)?|AVRCP Transport|Stereo|A2DP.*)$/i, '').trim();
  const groupKey = (n) =>
    String(n).toLowerCase().replace(/[^a-z0-9а-я]/g, '').replace(/(bt\d*|24g|receiver|dongle)$/, '');
  function guessIcon(name, hint) {
    if (hint === 'mouse') return '🖱️';
    if (hint === 'keyboard') return '⌨️';
    if (/headphone|headset|buds|airpods|monitor|wh-|wf-|наушник/i.test(name)) return '🎧';
    if (/controller|gamepad|dualsense|dualshock|xbox|joy-?con|геймпад/i.test(name)) return '🎮';
    if (/mouse|мыш|trackball|trackpad/i.test(name)) return '🖱️';
    if (/key|type|board|клав/i.test(name)) return '⌨️';
    return '🔋';
  }
  const LINK_LABEL = { '2.4g': '2.4G', usb: 'USB', bt: 'Bluetooth' };
  const LINK_PRIORITY = { '2.4g': 3, usb: 3, bt: 1 };

  // ───────── чтение всех источников ─────────
  let busy = false;
  let lastRefreshAt = 0;
  let firstRun = true;

  async function readHidSources(readings) {
    const devices = await navigator.hid.getDevices();
    if (firstRun || settings.debug) {
      log(`HID-устройств доступно: ${devices.length}`);
      HidIO.describe(devices).forEach((l) => log(l));
    }
    const seen = new Set();
    const jobs = [];
    const add = (entry, reader) => {
      const key = `${entry.kind}:${entry.vid}:${entry.pid}`;
      if (seen.has(key)) return;
      seen.add(key);
      jobs.push(
        (async () => {
          log(`${entry.name} (${entry.link}) …`);
          let res;
          try {
            res = await reader(entry, { log });
          } catch (e) {
            res = { ok: false, error: `${e.name}: ${e.message}` };
          }
          log(`  итог: ${JSON.stringify(res)}`);
          readings.push({
            key, source: entry.kind, name: cleanHidName(entry.name), link: entry.link,
            icon: guessIcon(entry.name, entry.mouse ? 'mouse' : 'keyboard'), res,
          });
        })(),
      );
    };
    HidIO.findCompx(devices).forEach((e) => add(e, HidIO.readCompx));
    HidIO.findHfd(devices).forEach((e) => add(e, HidIO.readHfd));
    await Promise.all(jobs);
  }

  // Bluetooth читается в фоне: холодный PowerShell может думать секунды, HID ждать его не должен
  let btItems = [];
  let btBusy = false;
  let btAt = 0;

  function btReadings() {
    const byName = new Map();
    for (const it of btItems) {
      const name = cleanBtName(it.name);
      if (!name) continue;
      const prev = byName.get(name);
      // Один и тот же аппарат может иметь несколько узлов: берём подключённый
      if (!prev || (it.connected === true && prev.connected !== true)) byName.set(name, it);
    }
    return [...byName].map(([name, it]) => ({
      key: `bt:${name}`, source: 'bt', name, link: 'bt', icon: guessIcon(name),
      res: { ok: true, percent: it.pct, charging: false, btConnected: it.connected !== false },
    }));
  }

  function kickBluetooth(force) {
    if (btBusy || (!force && Date.now() - btAt < 100000)) return;
    btBusy = true;
    const t0 = Date.now();
    window.api.readBluetooth(!!force).then((bt) => {
      btAt = Date.now();
      if (!bt.ok) { log(`Bluetooth: ${bt.error}`); return; }
      if (bt.mode === 'quick') {
        // Быстрый опрос обновляет значения; устройство, которое не ответило, остаётся с прошлым значением как «не подключено»
        const fresh = new Map(bt.items.map((i) => [i.id, i]));
        btItems = btItems.map((prev) => fresh.get(prev.id) ?? { ...prev, connected: false });
      } else {
        btItems = bt.items;
      }
      log(`Bluetooth (${bt.mode || '?'}): найдено ${bt.items.length} за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      bt.items.forEach((it) => log(`  «${it.name}» ${it.pct}% (connected=${it.connected})`));
      publish();
    }).catch((e) => log(`Bluetooth: ошибка ${e.message}`)).finally(() => { btBusy = false; });
  }

  // ───────── слияние в карточки ─────────
  function toEntries(readings) {
    const now = Date.now();
    return readings.map((r) => {
      const known = lastKnown[r.key];
      let percent = null, charging = false, live = false, ts = null, note = '';
      if (r.res.ok && !r.res.asleep && r.res.btConnected !== false) {
        percent = r.res.percent; charging = !!r.res.charging; live = true; ts = now;
        lastKnown[r.key] = { percent, charging, ts };
      } else if (r.res.ok) {
        // значение есть, но устройство спит или не подключено
        percent = r.res.percent; charging = !!r.res.charging; ts = known?.ts ?? now;
        note = r.res.asleep ? 'спит' : 'не подключено';
        lastKnown[r.key] = { percent, charging, ts: known?.ts ?? now };
      } else if (known) {
        percent = known.percent; charging = known.charging; ts = known.ts;
        note = r.res.error || 'нет связи';
      } else {
        note = r.res.error || 'нет данных';
      }
      return { ...r, percent, charging, live, ts, note };
    });
  }

  function mergeGroups(entries) {
    const groups = new Map();
    for (const e of entries) {
      const k = groupKey(e.name);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const out = [];
    for (const list of groups.values()) {
      list.sort((a, b) =>
        (b.live - a.live) || ((b.percent !== null) - (a.percent !== null)) ||
        (LINK_PRIORITY[b.link] - LINK_PRIORITY[a.link]) || ((b.ts ?? 0) - (a.ts ?? 0)));
      const primary = list[0];
      const hid = list.find((x) => x.source !== 'bt');
      out.push({
        name: (hid ?? primary).name, icon: primary.icon, primary,
        others: list.slice(1).filter((x) => x.percent !== null),
        all: list,
      });
    }
    out.sort((a, b) => (a.primary.percent ?? 999) - (b.primary.percent ?? 999));
    return out;
  }

  // ───────── отрисовка ─────────
  const fit = () => window.api.resize(Math.ceil(document.body.getBoundingClientRect().height));
  const fmtTime = (ts) => (ts ? new Date(ts).toTimeString().slice(0, 5) : '');

  function render(groups) {
    const list = $('list');
    list.textContent = '';
    $('empty').hidden = groups.length > 0 || !$('settings').hidden;
    for (const g of groups) {
      const p = g.primary;
      const row = document.createElement('div');
      const lvl = p.percent === null ? '' : p.percent < 20 ? 'low' : p.percent < 50 ? 'mid' : '';
      row.className = `row ${lvl} ${p.live ? '' : 'stale'}`.trim();

      const subParts = [LINK_LABEL[p.link] ?? p.link];
      if (p.charging) subParts.push('заряжается');
      if (!p.live) subParts.push(p.percent === null ? p.note : `${p.note || 'нет связи'}, значение от ${fmtTime(p.ts)}`);
      for (const o of g.others) subParts.push(`${LINK_LABEL[o.link]} ${o.percent}%`);

      const ico = document.createElement('div'); ico.className = 'ico'; ico.textContent = g.icon;
      const mid = document.createElement('div');
      const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = g.name; nm.title = g.name;
      const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = subParts.join(' · ');
      const bar = document.createElement('div'); bar.className = 'bar';
      const fill = document.createElement('i'); fill.style.width = `${p.percent ?? 0}%`;
      bar.appendChild(fill);
      mid.append(nm, sub, bar);
      const pct = document.createElement('div'); pct.className = 'pct';
      pct.innerHTML = p.percent === null ? '—' : `${p.percent}<small>%</small>`;
      if (p.charging) { const b = document.createElement('span'); b.className = 'bolt'; b.textContent = '⚡'; pct.appendChild(b); }
      row.append(ico, mid, pct);
      list.appendChild(row);
    }
    $('status').textContent = lastRefreshAt ? `Обновлено в ${fmtTime(lastRefreshAt)}` : '—';
    fit();
  }

  // ───────── трей и уведомления ─────────
  const notified = new Set();
  function updateTray(groups) {
    const shown = groups.filter((g) => g.primary.percent !== null);
    const worst = shown[0]?.primary ?? null;
    const icon = TrayIcon.draw({ percent: worst ? worst.percent : null, charging: !!worst?.charging });
    const lines = shown.map((g) => `${g.name}: ${g.primary.percent}%${g.primary.charging ? ' ⚡' : ''}${g.primary.live ? '' : ' (нет связи)'}`);
    window.api.updateTray({ icon, tooltip: lines.length ? lines.join('\n') : 'IO Battery: устройства не найдены' });
  }

  function checkLow(groups) {
    if (!settings.notify) return;
    for (const g of groups) {
      const p = g.primary;
      const k = groupKey(g.name);
      if (p.percent === null || !p.live) continue;
      if (p.charging || p.percent > settings.threshold + 5) { notified.delete(k); continue; }
      if (p.percent <= settings.threshold && !notified.has(k)) {
        notified.add(k);
        window.api.notify('Низкий заряд', `${g.name}: ${p.percent}%`);
      }
    }
  }

  // ───────── цикл обновления ─────────
  let lastHid = [];
  function publish() {
    const groups = mergeGroups(toEntries([...lastHid, ...btReadings()]));
    store.set('last', lastKnown);
    render(groups);
    updateTray(groups);
    checkLow(groups);
  }

  async function refresh(reason) {
    if (busy) return;
    busy = true;
    $('btnRefresh').classList.add('spin');
    log(`── обновление (${reason}) ──`);
    try {
      const hid = [];
      await readHidSources(hid).catch((e) => log(`HID: ${e.message}`));
      lastHid = hid;
      lastRefreshAt = Date.now();
      publish();
      kickBluetooth(reason === 'вручную');
    } finally {
      firstRun = false;
      busy = false;
      $('btnRefresh').classList.remove('spin');
    }
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => { await refresh('таймер'); schedule(); }, settings.intervalSec * 1000);
  }
  let debounce = null;
  const refreshSoon = (reason) => { clearTimeout(debounce); debounce = setTimeout(() => refresh(reason), 2000); };

  // ───────── настройки и кнопки ─────────
  async function pickManually() {
    try {
      const filters = [0x3554, 0x25a7, 0x0c45, 0x05ac, 0x342d].map((vendorId) => ({ vendorId }));
      const got = await navigator.hid.requestDevice({ filters });
      log(`requestDevice: выбрано ${got.length}`);
    } catch (e) { log(`requestDevice: ${e.message}`); }
    refresh('ручной выбор');
  }

  function toggleSettings(show) {
    $('settings').hidden = !show;
    $('list').hidden = show;
    $('empty').hidden = true;
    if (!show) refresh('закрыты настройки'); else fit();
  }

  async function initUi() {
    $('setInterval').value = String(settings.intervalSec);
    $('setThreshold').value = settings.threshold;
    $('setNotify').checked = settings.notify;
    $('setDebug').checked = settings.debug;
    $('debugBox').hidden = !settings.debug;
    $('setAutostart').checked = await window.api.getAutostart();

    const mat = await window.api.getMaterial();
    if (mat.supported) {
      $('rowMaterial').hidden = false;
      $('setMaterial').checked = settings.material;
      const applyMat = async (on) => {
        const applied = await window.api.setMaterial(on);
        document.documentElement.classList.toggle('material', !!applied);
      };
      await applyMat(settings.material);
      $('setMaterial').onchange = async (e) => { settings.material = e.target.checked; saveSettings(); await applyMat(settings.material); };
    }

    $('btnRefresh').onclick = () => refresh('вручную');
    $('btnSettings').onclick = () => toggleSettings($('settings').hidden);
    $('btnPick').onclick = pickManually;
    $('btnPick2').onclick = pickManually;
    $('btnQuit').onclick = () => window.api.quit();
    $('btnCopyLog').onclick = () => window.api.copy(logLines.join('\n'));
    $('setInterval').onchange = (e) => { settings.intervalSec = Number(e.target.value); saveSettings(); schedule(); };
    $('setThreshold').onchange = (e) => {
      settings.threshold = Math.max(5, Math.min(50, Number(e.target.value) || 20)); e.target.value = settings.threshold; saveSettings();
    };
    $('setNotify').onchange = (e) => { settings.notify = e.target.checked; saveSettings(); };
    $('setAutostart').onchange = async (e) => { e.target.checked = await window.api.setAutostart(e.target.checked); };
    $('setDebug').onchange = (e) => {
      settings.debug = e.target.checked; saveSettings(); $('debugBox').hidden = !settings.debug;
      if (settings.debug) { $('log').textContent = logLines.join('\n'); fit(); }
    };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.hide(); });
  }

  // ───────── старт ─────────
  initUi().then(() => {
    if (!navigator.hid) {
      $('status').textContent = 'WebHID недоступен в этой сборке Electron';
      log('navigator.hid отсутствует');
    } else {
      navigator.hid.addEventListener('connect', (e) => { log(`HID connect ${e.device.productName}`); refreshSoon('подключение'); });
      navigator.hid.addEventListener('disconnect', (e) => { log(`HID disconnect ${e.device.productName}`); refreshSoon('отключение'); });
    }
    window.api.onRefresh(() => refresh('из меню трея'));
    window.api.onShown(() => { if (Date.now() - lastRefreshAt > 15000) refresh('панель открыта'); });
    refresh('запуск').then(schedule);
  });
})();
