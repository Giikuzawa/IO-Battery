/* Иконка трея: цветной квадрат с числом процентов. Рисуется на canvas, в main уходит dataURL. */
(function () {
  'use strict';
  function color(percent) {
    if (percent === null || percent === undefined) return '#8a8f98';
    if (percent < 20) return '#f87171';
    if (percent < 50) return '#fbbf24';
    return '#4ade80';
  }

  function draw({ percent, charging }) {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = color(percent);
    const r = 7;
    g.beginPath();
    g.moveTo(r, 0); g.lineTo(size - r, 0); g.quadraticCurveTo(size, 0, size, r);
    g.lineTo(size, size - r); g.quadraticCurveTo(size, size, size - r, size);
    g.lineTo(r, size); g.quadraticCurveTo(0, size, 0, size - r);
    g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0);
    g.fill();
    g.fillStyle = '#10141a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const text = percent === null || percent === undefined ? '–' : String(percent);
    g.font = `700 ${text.length >= 3 ? 17 : 22}px "Segoe UI", Arial, sans-serif`;
    g.fillText(text, size / 2, size / 2 + 1);
    if (charging) {
      g.fillStyle = '#10141a';
      g.beginPath(); g.arc(size - 6, 6, 4, 0, Math.PI * 2); g.fill();
    }
    return c.toDataURL('image/png');
  }

  window.TrayIcon = { draw, color };
})();
