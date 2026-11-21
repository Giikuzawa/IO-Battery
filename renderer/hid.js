/*
 * Работа с устройствами через WebHID. Принимает только стандартные объекты
 * HIDDevice, поэтому логику можно гонять в тестах на подставном устройстве.
 *
 * Принцип «мягкого» опроса: устройство открываем только на время чтения,
 * один вопрос — один ответ (с парой повторов), ничего не записываем в настройки.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./protocols.js'));
  else root.HidIO = factory(root.Proto);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ───────── разбор дескриптора ─────────
  function reportBytes(rep) {
    const bits = (rep?.items ?? []).reduce((s, it) => s + (it.reportCount ?? 0) * (it.reportSize ?? 0), 0);
    return Math.ceil(bits / 8);
  }

  function flatten(cols, out = []) {
    for (const c of cols ?? []) {
      out.push(c);
      flatten(c.children, out);
    }
    return out;
  }

  const collectionsOf = (device) => flatten(device.collections);
  const hasReport = (list, id) => (list ?? []).some((r) => (r.reportId ?? 0) === id);

  function describe(devices) {
    const lines = [];
    for (const d of devices) {
      lines.push(`${h4(d.vendorId)}:${h4(d.productId)} «${d.productName}»`);
      for (const c of collectionsOf(d)) {
        lines.push(
          `   page ${h4(c.usagePage)} usage ${h4(c.usage)} ` +
            `in=[${(c.inputReports ?? []).map((r) => `${r.reportId ?? 0}:${reportBytes(r)}`).join(',')}] ` +
            `out=[${(c.outputReports ?? []).map((r) => `${r.reportId ?? 0}:${reportBytes(r)}`).join(',')}] ` +
            `feat=[${(c.featureReports ?? []).map((r) => `${r.reportId ?? 0}:${reportBytes(r)}`).join(',')}]`,
        );
      }
    }
    return lines;
  }
  const h4 = (n) => '0x' + Number(n).toString(16).toUpperCase().padStart(4, '0');

  // ───────── поиск устройств ─────────
  function findCompx(devices) {
    const found = [];
    for (const d of devices) {
      if (!P.COMPX.VIDS.includes(d.vendorId)) continue;
      const col = collectionsOf(d).find(
        (c) => hasReport(c.outputReports, P.COMPX.REPORT_ID) && hasReport(c.inputReports, P.COMPX.REPORT_ID),
      );
      if (!col) continue;
      const link = P.COMPX.PIDS[d.productId] ?? (/receiver|dongle|2\.4/i.test(d.productName) ? '2.4g' : 'usb');
      found.push({
        kind: 'compx', mouse: true, device: d, collection: col,
        vid: d.vendorId, pid: d.productId, name: d.productName || 'Мышь', link,
      });
    }
    return found;
  }

  function findHfd(devices) {
    const found = [];
    for (const d of devices) {
      if (!P.HFD.VIDS.includes(d.vendorId)) continue;
      const known = P.HFD.IDS.some(([v, p]) => v === d.vendorId && p === d.productId);
      if (!known && !P.HFD.NAME_RE.test(d.productName ?? '')) continue;
      const cols = collectionsOf(d)
        .filter((c) => P.HFD.PAGES.includes(c.usagePage) && c.outputReports?.length && c.inputReports?.length)
        .sort((a, b) => P.HFD.PAGES.indexOf(a.usagePage) - P.HFD.PAGES.indexOf(b.usagePage));
      const col = cols[0];
      if (!col) continue;
      const out = col.outputReports[0];
      const frameBytes = reportBytes(out);
      if (frameBytes < 16) continue;
      found.push({
        kind: 'hfd', mouse: false, device: d, collection: col,
        reportId: out.reportId ?? 0, frameBytes,
        vid: d.vendorId, pid: d.productId, name: d.productName || 'Клавиатура',
        link: P.HFD.DONGLE_PIDS.includes(d.productId) || /2\.4/i.test(d.productName ?? '') ? '2.4g' : 'usb',
      });
    }
    return found;
  }

  // ───────── обмен ─────────
  async function ensureOpen(device) {
    if (!device.opened) await device.open();
  }

  /**
   * Отправляет один кадр и ждёт подходящий ответ.
   * @returns {Uint8Array|null} ответ или null, если устройство промолчало
   */
  async function exchange(device, reportId, frame, match, { timeoutMs = 500, attempts = 3, pauseMs = 150, log } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let cleanup = () => {};
      const answer = new Promise((resolve) => {
        const onReport = (e) => {
          if (e.reportId !== reportId) return;
          const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
          log?.(`  ← #${attempt} ${P.hex(d.subarray(0, 24))}${d.length > 24 ? ' …' : ''}`);
          if (match(d)) {
            cleanup();
            resolve(d.slice());
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, timeoutMs);
        cleanup = () => {
          clearTimeout(timer);
          device.removeEventListener('inputreport', onReport);
        };
        device.addEventListener('inputreport', onReport);
      });
      try {
        log?.(`  → #${attempt} id=${reportId} ${P.hex(frame.subarray(0, 24))}${frame.length > 24 ? ' …' : ''}`);
        await device.sendReport(reportId, frame);
      } catch (err) {
        cleanup();
        throw err;
      }
      const res = await answer;
      if (res) return res;
      if (attempt < attempts) await sleep(pauseMs);
    }
    return null;
  }

  // Один и тот же HIDDevice нельзя читать двумя потоками одновременно
  const locks = new WeakMap();
  function withLock(device, fn) {
    const prev = locks.get(device) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(device, next.catch(() => {}));
    return next;
  }

  // ───────── чтение: мышь ─────────
  async function readCompx(entry, opts = {}) {
    return withLock(entry.device, async () => {
      const { device } = entry;
      const id = P.COMPX.REPORT_ID;
      await ensureOpen(device);
      try {
        let online = true;
        if (entry.link === '2.4g') {
          opts.log?.('  мышь: ONLINE');
          const on = await exchange(device, id, P.compxFrame(P.COMPX.CMD.ONLINE), P.compxIsAnswer(P.COMPX.CMD.ONLINE), opts);
          if (on) online = P.compxParseOnline(on) !== false;
        }
        opts.log?.('  мышь: BATTERY');
        const raw = await exchange(device, id, P.compxFrame(P.COMPX.CMD.BATTERY), P.compxIsAnswer(P.COMPX.CMD.BATTERY), opts);
        if (!raw) return { ok: false, error: 'нет ответа от приёмника' };
        const b = P.compxParseBattery(raw);
        if (!b) return { ok: false, error: 'неожиданный ответ' };
        if (b.percent === 0 && !b.charging) return { ok: false, error: 'устройство вернуло 0 %' };
        return { ok: true, percent: b.percent, charging: b.charging, millivolts: b.millivolts, asleep: !online };
      } finally {
        await device.close().catch(() => {});
      }
    });
  }

  // ───────── чтение: клавиатура ─────────
  async function readHfd(entry, opts = {}) {
    return withLock(entry.device, async () => {
      const { device, reportId, frameBytes } = entry;
      await ensureOpen(device);
      try {
        const reqs = P.hfdInfoRequests(frameBytes);
        const answers = [];
        for (const { addr, frame } of reqs) {
          opts.log?.(`  клавиатура: GET_DEVICE_INFO addr=${addr}`);
          const raw = await exchange(device, reportId, frame, P.hfdIsAnswer(P.HFD.CMD_INFO, addr), opts);
          if (!raw) return { ok: false, error: 'нет ответа (клавиатура спит?)' };
          answers.push(raw);
        }
        const { bytes, length } = P.hfdAssemble(answers);
        if (length < 20) return { ok: false, error: 'короткий ответ' };
        const info = P.hfdDecodeInfo(bytes);
        opts.log?.(`  info: vid=${h4(info.vendorId)} pid=${h4(info.productId)} fw=${info.version} level=${info.batteryLevel} charge=${info.chargeStatus}`);
        const b = P.hfdBattery(info, entry.link);
        if (b.percent === null) return { ok: false, error: 'клавиатура не сообщила уровень', charging: b.charging };
        return { ok: true, percent: b.percent, charging: b.charging };
      } finally {
        await device.close().catch(() => {});
      }
    });
  }

  return { reportBytes, collectionsOf, describe, findCompx, findHfd, exchange, readCompx, readHfd };
});
