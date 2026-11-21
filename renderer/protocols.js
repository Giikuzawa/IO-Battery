/*
 * Протоколы чтения заряда. Чистые функции без обращения к железу.
 *
 * Восстановлено из клиентского кода хаба производителя (WebHID):
 *  - COMPX: мыши IO Aurora / Nova, Red Square Kiro (VID 0x3554).
 *  - HFD:   клавиатуры IO Type 68/84, Typex, RSQ Alumix (VID 0x0C45/0x05AC/0x342D).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Proto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');

  // ───────────────────────── COMPX (мыши) ─────────────────────────
  // Output/input report ID = 8, полезная нагрузка 16 байт:
  //   [0]=cmd [1]=0 [2..3]=addr [4]=len [5..14]=data [15]=checksum
  //   checksum = (0x55 − (reportId + Σ bytes[0..14])) & 0xFF
  const COMPX = {
    VIDS: [0x3554, 0x25a7],
    REPORT_ID: 8,
    FRAME: 16,
    CMD: { HANDSHAKE: 1, ONLINE: 3, BATTERY: 4 },
    // PID → тип подключения (из таблицы моделей хаба)
    PIDS: {
      0xf511: 'usb', 0xf5d5: '2.4g', 0xfb08: '2.4g', 0xfb09: 'usb', 0xfb3f: 'usb',
      0xfb40: '2.4g', 0xfb5a: '2.4g', 0xf57c: '2.4g', 0xf57d: 'usb', 0xf57e: '2.4g',
    },
    // Запасной пересчёт «напряжение → процент», если устройство прислало 0 %, но напряжение ненулевое.
    // Общая таблица для Li-Po/Li-ion (21 точка = 0…100 % с шагом 5 %, мВ), приблизительная.
    CURVE: [3270, 3610, 3690, 3710, 3730, 3750, 3770, 3790, 3800, 3820, 3840,
            3850, 3870, 3910, 3950, 3980, 4020, 4080, 4110, 4150, 4200],
  };

  function compxFrame(cmd) {
    const f = new Uint8Array(COMPX.FRAME);
    f[0] = cmd & 255;
    let sum = COMPX.REPORT_ID;
    for (let i = 0; i < 15; i++) sum += f[i];
    f[15] = (0x55 - sum) & 255;
    return f;
  }

  function compxChecksumOk(r) {
    if (r.length < 16) return false;
    let sum = COMPX.REPORT_ID;
    for (let i = 0; i < 16; i++) sum += r[i];
    return (sum & 255) === 0x55;
  }

  // Ответ на команду: первый байт эхо команды, второй — статус (0 ок, 1 «не поддерживается»)
  const compxIsAnswer = (cmd) => (r) => r.length >= 8 && r[0] === cmd && (r[1] === 0 || r[1] === 1);

  function percentFromCurve(mv, curve = COMPX.CURVE) {
    if (curve.length < 2) return null;
    if (mv <= curve[0]) return 0;
    if (mv >= curve[curve.length - 1]) return 100;
    for (let i = 1; i < curve.length; i++) {
      if (mv > curve[i]) continue;
      const span = curve[i] - curve[i - 1];
      const frac = span > 0 ? (mv - curve[i - 1]) / span : 0;
      return Math.round(((i - 1 + frac) * 100) / (curve.length - 1));
    }
    return 100;
  }

  // → {percent, charging, millivolts|null} или null, если ответ странный
  function compxParseBattery(r) {
    if (!r || r.length < 11 || r[0] !== COMPX.CMD.BATTERY) return null;
    if (r[1] === 1) return null; // команда не поддерживается
    const charging = r[6] === 1;
    if (r[9] === 1) {
      if (r[10] > 100) return null;
      return { percent: r[10], charging, millivolts: null };
    }
    if (r[5] > 100) return null;
    const mv = (r[7] << 8) | r[8];
    let percent = r[5];
    if (percent === 0 && mv > 0) percent = percentFromCurve(mv);
    return { percent, charging, millivolts: mv > 0 ? mv : null };
  }

  const compxParseOnline = (r) => (r && r.length > 5 && r[0] === COMPX.CMD.ONLINE ? r[5] === 1 : null);

  // ───────────────────────── HFD (клавиатуры) ─────────────────────────
  // Кадр размера frameBytes (= размер output-отчёта интерфейса):
  //   [0]=0xAA [1]=cmd [2]=len [3..4]=addr(LE) [5..7]=заголовок, [6]=1 у последнего пакета, [8..]=данные
  // Ответ: [0]=0x55 [1]=cmd [2]=len/type [3..4]=addr(LE) [8..]=данные
  const HFD = {
    VIDS: [0x0c45, 0x05ac, 0x342d],
    PAGES: [0xff68, 0xff80, 0xff60, 0xff00, 0xff01, 0xff1b],
    CMD_INFO: 0x10,
    HEADER: 8,
    INFO_SIZE: 48,
    // [vid, pid] клавиатур этого семейства из таблицы моделей хаба
    IDS: [[0x0c45, 0xfefe], [0x0c45, 0x0256], [0x05ac, 0x0256], [0x05ac, 0x024f], [0x0c45, 0x8016],
          [0x0c45, 0x8009], [0x0c45, 0x80d6], [0x0c45, 0x80ca], [0x0c45, 0x80c9], [0x0c45, 0x80d9],
          [0x0c45, 0x80d7], [0x0c45, 0x80cc], [0x0c45, 0x80ac], [0x0c45, 0x80af], [0x0c45, 0x80a2]],
    NAME_RE: /^(IO\s|Type\s?\d|Typex|Alumix|RSQ)/i,
    DONGLE_PIDS: [0xfefe],
  };

  function hfdFrame(size, { cmd, len = 0, addr = 0, lastPacket = true, data = null }) {
    const f = new Uint8Array(size);
    f[0] = 0xaa;
    f[1] = cmd & 255;
    f[2] = len & 255;
    f[3] = addr & 255;
    f[4] = (addr >> 8) & 255;
    f[6] = lastPacket ? 1 : 0;
    if (data) f.set(data.subarray(0, size - HFD.HEADER), HFD.HEADER);
    return f;
  }

  // GET_DEVICE_INFO (48 байт) режется на пакеты по (size − 8) байт
  function hfdInfoRequests(size) {
    const g = size - HFD.HEADER;
    if (g <= 0) throw new RangeError('frame too small: ' + size);
    const n = Math.max(1, Math.ceil(HFD.INFO_SIZE / g));
    const out = [];
    for (let a = 0; a < n; a++) {
      const addr = a * g;
      const len = a === n - 1 ? HFD.INFO_SIZE - a * g : g;
      out.push({ addr, frame: hfdFrame(size, { cmd: HFD.CMD_INFO, len, addr, lastPacket: a === n - 1 }) });
    }
    return out;
  }

  function hfdParseResponse(r) {
    if (!r || r.length < 8 || r[0] !== 0x55) return null;
    return { cmd: r[1], lenOrType: r[2], addr: r[3] | (r[4] << 8), payload: r.subarray(8) };
  }

  const hfdIsAnswer = (cmd, addr) => (r) => {
    const p = hfdParseResponse(r);
    return !!p && p.cmd === cmd && p.addr === addr;
  };

  function hfdAssemble(responses, total = HFD.INFO_SIZE) {
    const out = new Uint8Array(total);
    let i = 0;
    for (const r of responses) {
      const p = r.subarray(HFD.HEADER);
      const k = Math.min(p.length, total - i);
      out.set(p.subarray(0, k), i);
      i += k;
      if (i >= total) break;
    }
    return { bytes: out, length: i };
  }

  function hfdDecodeInfo(b) {
    const u16 = (i) => b[i] | (b[i + 1] << 8);
    const ver = (lo, hi) => (((lo & 15) + ((lo & 240) >> 4) * 10) + hi * 100) / 100;
    return {
      vendorId: u16(4), productId: u16(6), version: ver(b[8], b[9]),
      workMode: b[16], batteryLevel: b[17], chargeStatus: b[18], currentProfile: b[19],
    };
  }

  // → {percent|null, charging} ; null = «данных нет» (никогда не рисуем выдуманный 0 %)
  function hfdBattery(info, link) {
    const { batteryLevel: lvl, chargeStatus: chg } = info;
    if (!Number.isInteger(lvl) || lvl < 0 || lvl > 100) return { percent: null, charging: false };
    const charging = chg === 1;
    if (lvl === 0 && chg === 0) return { percent: null, charging: false };
    if (lvl === 0 && link === 'usb' && chg === 1) return { percent: null, charging: true };
    return { percent: lvl, charging };
  }

  return {
    hex, COMPX, HFD,
    compxFrame, compxChecksumOk, compxIsAnswer, compxParseBattery, compxParseOnline, percentFromCurve,
    hfdFrame, hfdInfoRequests, hfdParseResponse, hfdIsAnswer, hfdAssemble, hfdDecodeInfo, hfdBattery,
  };
});
