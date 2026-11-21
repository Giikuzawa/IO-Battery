'use strict';
const assert = require('node:assert/strict');
const P = require('../renderer/protocols.js');
const H = require('../renderer/hid.js');

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name, '\n      ', e.message);
    process.exitCode = 1;
  }
}

// ───────── подставное HID-устройство ─────────
class FakeHid extends EventTarget {
  constructor(props, respond) {
    super();
    Object.assign(this, props);
    this.opened = false;
    this.respond = respond; // (reportId, Uint8Array) => Uint8Array[] | null
    this.sent = [];
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(id, data) {
    assert.ok(this.opened, 'устройство должно быть открыто перед отправкой');
    this.sent.push([id, Uint8Array.from(data)]);
    const answers = this.respond?.(id, Uint8Array.from(data)) ?? [];
    for (const a of answers) {
      setTimeout(() => {
        const ev = new Event('inputreport');
        ev.reportId = a.id;
        ev.data = new DataView(Uint8Array.from(a.bytes).buffer);
        this.dispatchEvent(ev);
      }, 1);
    }
  }
}

const rep = (id, bytes) => ({ reportId: id, items: [{ reportSize: 8, reportCount: bytes }] });

// ───────── дескрипторы как в отчёте пользователя ─────────
const mouseDesc = () => ({
  vendorId: 0x3554, productId: 0xfb40, productName: 'IO Aurora Pro 8K Receiver',
  collections: [
    { usagePage: 1, usage: 2, inputReports: [rep(0, 7)], outputReports: [], featureReports: [] },
    { usagePage: 0xff02, usage: 2, inputReports: [rep(8, 16)], outputReports: [rep(8, 16)], featureReports: [] },
    { usagePage: 0xff04, usage: 2, inputReports: [], outputReports: [], featureReports: [rep(0, 7)] },
  ],
});
const kbdDesc = () => ({
  vendorId: 0x0c45, productId: 0xfefe, productName: 'IO Type 68 Pro 2.4G',
  collections: [
    { usagePage: 1, usage: 6, inputReports: [rep(0, 8)], outputReports: [rep(0, 1)], featureReports: [] },
    { usagePage: 0xff59, usage: 0x61, inputReports: [rep(0, 64)], outputReports: [rep(0, 64)], featureReports: [] },
    { usagePage: 0xff60, usage: 0x61, inputReports: [rep(0, 32)], outputReports: [rep(0, 32)], featureReports: [] },
  ],
});

// ───────── эмуляция прошивок ─────────
function compxFirmware({ percent = 80, charging = 0, mv = 4012, online = 1, silent = false } = {}) {
  return (id, data) => {
    if (silent || id !== 8) return null;
    const r = new Uint8Array(16);
    r[0] = data[0];
    if (data[0] === 3) r[5] = online;
    if (data[0] === 4) { r[5] = percent; r[6] = charging; r[7] = mv >> 8; r[8] = mv & 255; }
    let sum = 8; for (let i = 0; i < 15; i++) sum += r[i];
    r[15] = (0x55 - sum) & 255;
    return [{ id: 8, bytes: r }];
  };
}

function hfdFirmware(size, { level = 73, charge = 0 } = {}) {
  const info = new Uint8Array(48);
  info[4] = 0x45; info[5] = 0x0c; info[6] = 0xfe; info[7] = 0xfe;
  info[8] = 0x38; info[9] = 1; info[17] = level; info[18] = charge;
  return (id, data) => {
    if (data[0] !== 0xaa || data[1] !== 0x10) return null;
    const addr = data[3] | (data[4] << 8);
    const len = data[2];
    const r = new Uint8Array(size);
    r[0] = 0x55; r[1] = 0x10; r[2] = len; r[3] = addr & 255; r[4] = addr >> 8;
    r.set(info.subarray(addr, addr + len), 8);
    return [{ id: 0, bytes: r }];
  };
}

(async () => {
  console.log('Протоколы');

  await t('Compx: кадр запроса заряда = 04 00 … 49', () => {
    const f = P.compxFrame(4);
    assert.equal(f.length, 16);
    assert.equal(f[0], 4);
    assert.equal(f[15], 0x49);
    assert.ok(P.compxChecksumOk(f));
  });

  await t('Compx: разбор — проценты, зарядка, милливольты', () => {
    const r = new Uint8Array(16); r[0] = 4; r[5] = 80; r[6] = 1; r[7] = 0x0f; r[8] = 0xac;
    assert.deepEqual(P.compxParseBattery(r), { percent: 80, charging: true, millivolts: 4012 });
  });

  await t('Compx: альтернативное поле процентов (байт 9 = 1)', () => {
    const r = new Uint8Array(16); r[0] = 4; r[9] = 1; r[10] = 55;
    assert.equal(P.compxParseBattery(r).percent, 55);
  });

  await t('Compx: 0 % при ненулевом напряжении берётся из кривой', () => {
    const r = new Uint8Array(16); r[0] = 4; r[7] = 0x0f; r[8] = 0xac; // 4012 мВ
    assert.equal(P.compxParseBattery(r).percent, 79);
  });

  await t('Compx: мусор отвергается (чужая команда, >100, статус 1, коротко)', () => {
    const bad = (mut) => { const r = new Uint8Array(16); r[0] = 4; mut(r); return P.compxParseBattery(r); };
    assert.equal(bad((r) => { r[0] = 3; }), null);
    assert.equal(bad((r) => { r[5] = 101; }), null);
    assert.equal(bad((r) => { r[1] = 1; }), null);
    assert.equal(P.compxParseBattery(new Uint8Array(5)), null);
  });

  await t('Кривая напряжения: края и середина', () => {
    assert.equal(P.percentFromCurve(3000), 0);
    assert.equal(P.percentFromCurve(4200), 100);
    assert.equal(P.percentFromCurve(3800), 40);
  });

  await t('HFD: размер 32 → два пакета (addr 0 и 24), последний помечен', () => {
    const q = P.hfdInfoRequests(32);
    assert.equal(q.length, 2);
    assert.deepEqual(q.map((x) => x.addr), [0, 24]);
    assert.equal(q[0].frame[0], 0xaa); assert.equal(q[0].frame[1], 0x10);
    assert.equal(q[0].frame[2], 24); assert.equal(q[0].frame[6], 0);
    assert.equal(q[1].frame[3], 24); assert.equal(q[1].frame[6], 1);
  });

  await t('HFD: размер 64 → один пакет на 48 байт', () => {
    const q = P.hfdInfoRequests(64);
    assert.equal(q.length, 1);
    assert.equal(q[0].frame[2], 48);
    assert.equal(q[0].frame[6], 1);
  });

  await t('HFD: правила «нет данных» (0 % без зарядки — не показываем)', () => {
    assert.deepEqual(P.hfdBattery({ batteryLevel: 0, chargeStatus: 0 }, '2.4g'), { percent: null, charging: false });
    assert.deepEqual(P.hfdBattery({ batteryLevel: 150, chargeStatus: 0 }, '2.4g'), { percent: null, charging: false });
    assert.deepEqual(P.hfdBattery({ batteryLevel: 61, chargeStatus: 1 }, '2.4g'), { percent: 61, charging: true });
    assert.deepEqual(P.hfdBattery({ batteryLevel: 0, chargeStatus: 1 }, 'usb'), { percent: null, charging: true });
  });

  console.log('Поиск интерфейсов (по дескрипторам из отчёта)');

  await t('Мышь: выбирается интерфейс с output и input report 8', () => {
    const f = H.findCompx([mouseDesc()]);
    assert.equal(f.length, 1);
    assert.equal(f[0].collection.usagePage, 0xff02);
    assert.equal(f[0].link, '2.4g');
  });

  await t('Клавиатура 0C45:FEFE: выбирается FF60 (кадр 32 Б), а не FF59', () => {
    const f = H.findHfd([kbdDesc()]);
    assert.equal(f.length, 1);
    assert.equal(f[0].collection.usagePage, 0xff60);
    assert.equal(f[0].frameBytes, 32);
    assert.equal(f[0].link, '2.4g');
  });

  await t('Чужие устройства игнорируются', () => {
    const other = { vendorId: 0x046d, productId: 0xc52b, productName: 'USB Receiver', collections: kbdDesc().collections };
    assert.equal(H.findHfd([other]).length, 0);
    assert.equal(H.findCompx([other]).length, 0);
  });

  console.log('Обмен с подставными прошивками');

  await t('Мышь 2.4G: ONLINE + BATTERY → 80 %, зарядка', async () => {
    const dev = new FakeHid(mouseDesc(), compxFirmware({ percent: 80, charging: 1 }));
    const [entry] = H.findCompx([dev]);
    const res = await H.readCompx(entry, { timeoutMs: 50, attempts: 2, pauseMs: 1 });
    assert.deepEqual(res, { ok: true, percent: 80, charging: true, millivolts: 4012, asleep: false });
    assert.equal(dev.opened, false, 'устройство должно быть закрыто после чтения');
    assert.deepEqual(dev.sent.map((s) => s[1][0]), [3, 4]);
    assert.ok(dev.sent.every(([id, d]) => id === 8 && P.compxChecksumOk(d)));
  });

  await t('Мышь спит (ONLINE=0) → значение помечено asleep', async () => {
    const dev = new FakeHid(mouseDesc(), compxFirmware({ percent: 45, online: 0 }));
    const [entry] = H.findCompx([dev]);
    const res = await H.readCompx(entry, { timeoutMs: 50, attempts: 1 });
    assert.equal(res.ok, true); assert.equal(res.percent, 45); assert.equal(res.asleep, true);
  });

  await t('Мышь молчит → ok:false и закрытое устройство', async () => {
    const dev = new FakeHid(mouseDesc(), compxFirmware({ silent: true }));
    const [entry] = H.findCompx([dev]);
    const res = await H.readCompx(entry, { timeoutMs: 20, attempts: 2, pauseMs: 1 });
    assert.equal(res.ok, false); assert.equal(dev.opened, false);
  });

  await t('Мышь вернула 0 % без зарядки → «нет данных», а не 0 %', async () => {
    const dev = new FakeHid(mouseDesc(), compxFirmware({ percent: 0, mv: 0 }));
    const [entry] = H.findCompx([dev]);
    const res = await H.readCompx(entry, { timeoutMs: 50, attempts: 1 });
    assert.equal(res.ok, false);
  });

  await t('Клавиатура (кадр 32 Б): два пакета → 73 %', async () => {
    const dev = new FakeHid(kbdDesc(), hfdFirmware(32, { level: 73 }));
    const [entry] = H.findHfd([dev]);
    const res = await H.readHfd(entry, { timeoutMs: 50, attempts: 2, pauseMs: 1 });
    assert.deepEqual(res, { ok: true, percent: 73, charging: false });
    assert.equal(dev.sent.length, 2);
    assert.equal(dev.opened, false);
  });

  await t('Клавиатура: зарядка по кабелю', async () => {
    const dev = new FakeHid(kbdDesc(), hfdFirmware(32, { level: 90, charge: 1 }));
    const [entry] = H.findHfd([dev]);
    const res = await H.readHfd(entry, { timeoutMs: 50, attempts: 1 });
    assert.equal(res.percent, 90); assert.equal(res.charging, true);
  });

  await t('Клавиатура молчит (спит) → ok:false', async () => {
    const dev = new FakeHid(kbdDesc(), () => null);
    const [entry] = H.findHfd([dev]);
    const res = await H.readHfd(entry, { timeoutMs: 20, attempts: 2, pauseMs: 1 });
    assert.equal(res.ok, false);
  });

  await t('Параллельные чтения одного устройства выстраиваются в очередь', async () => {
    const dev = new FakeHid(kbdDesc(), hfdFirmware(32, { level: 50 }));
    const [entry] = H.findHfd([dev]);
    const [a, b] = await Promise.all([
      H.readHfd(entry, { timeoutMs: 50, attempts: 1 }),
      H.readHfd(entry, { timeoutMs: 50, attempts: 1 }),
    ]);
    assert.equal(a.percent, 50); assert.equal(b.percent, 50);
  });

  console.log(`\nПройдено: ${passed}${process.exitCode ? ' (есть падения)' : ''}`);
})();
