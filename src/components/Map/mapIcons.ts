import type { Map as MLMap } from 'maplibre-gl';

type IconPainter = (ctx: CanvasRenderingContext2D, c: number) => void;

const ICON_SPECS: Record<string, { bg: string; shape?: 'circle' | 'triangle' | 'diamond'; draw: IconPainter }> = {
  'poi-restaurant': {
    bg: '#ea580c',
    draw(ctx, c) {
      // Fork (left) + knife (right)
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Fork handle + tines
      ctx.beginPath();
      ctx.moveTo(c - 7, c - 10);
      ctx.lineTo(c - 7, c - 1);
      ctx.moveTo(c - 11, c - 10);
      ctx.lineTo(c - 11, c - 2);
      ctx.quadraticCurveTo(c - 11, c + 1, c - 7, c + 1);
      ctx.moveTo(c - 3, c - 10);
      ctx.lineTo(c - 3, c - 2);
      ctx.quadraticCurveTo(c - 3, c + 1, c - 7, c + 1);
      ctx.moveTo(c - 7, c + 1);
      ctx.lineTo(c - 7, c + 11);
      // Knife
      ctx.moveTo(c + 7, c - 10);
      ctx.lineTo(c + 7, c + 11);
      ctx.moveTo(c + 7, c - 10);
      ctx.quadraticCurveTo(c + 13, c - 4, c + 7, c + 1);
      ctx.stroke();
    },
  },
  'poi-cafe': {
    bg: '#92400e',
    draw(ctx, c) {
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Cup body
      ctx.beginPath();
      ctx.roundRect(c - 11, c - 6, 17, 13, [2, 2, 6, 6]);
      ctx.stroke();
      // Cup handle
      ctx.beginPath();
      ctx.arc(c + 6, c - 1, 4.5, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      // Saucer
      ctx.beginPath();
      ctx.moveTo(c - 12, c + 11);
      ctx.lineTo(c + 9, c + 11);
      ctx.stroke();
    },
  },
  'poi-fuel': {
    bg: '#0284c7',
    draw(ctx, c) {
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.roundRect(c - 11, c - 11, 14, 22, 2.5);
      ctx.stroke();
      ctx.fillRect(c - 8, c - 8, 8, 6);
      // Nozzle hose
      ctx.beginPath();
      ctx.moveTo(c + 3, c - 3);
      ctx.lineTo(c + 8, c - 3);
      ctx.lineTo(c + 8, c + 6);
      ctx.arc(c + 10, c + 6, 2, Math.PI, 0, true);
      ctx.lineTo(c + 12, c - 6);
      ctx.lineTo(c + 8, c - 10);
      ctx.stroke();
    },
  },
  'poi-ev_charging': {
    bg: '#059669',
    draw(ctx, c) {
      // Lightning bolt
      ctx.beginPath();
      ctx.moveTo(c + 2, c - 13);
      ctx.lineTo(c - 9, c + 1);
      ctx.lineTo(c - 1, c + 1);
      ctx.lineTo(c - 3, c + 13);
      ctx.lineTo(c + 9, c - 1);
      ctx.lineTo(c + 1, c - 1);
      ctx.closePath();
      ctx.fill();
    },
  },
  'poi-hotel': {
    bg: '#7c3aed',
    draw(ctx, c) {
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Bed frame
      ctx.beginPath();
      ctx.moveTo(c - 12, c - 8);
      ctx.lineTo(c - 12, c + 10);
      ctx.moveTo(c - 12, c + 4);
      ctx.lineTo(c + 12, c + 4);
      ctx.moveTo(c + 12, c - 2);
      ctx.lineTo(c + 12, c + 10);
      ctx.stroke();
      // Pillow + mattress
      ctx.beginPath();
      ctx.arc(c - 6, c - 2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(c - 1, c - 4, 11, 6);
    },
  },
  'poi-parking': {
    bg: '#2563eb',
    draw(ctx, c) {
      ctx.font = '800 26px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', c + 0.5, c + 1.5);
    },
  },
  'poi-pharmacy': {
    bg: '#dc2626',
    draw(ctx, c) {
      ctx.fillRect(c - 3.5, c - 11, 7, 22);
      ctx.fillRect(c - 11, c - 3.5, 22, 7);
    },
  },
  'poi-hospital': {
    bg: '#b91c1c',
    draw(ctx, c) {
      ctx.font = '800 24px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('H', c, c + 1.5);
    },
  },
  'poi-rest_area': {
    bg: '#0d9488',
    draw(ctx, c) {
      // Picnic table
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(c - 12, c - 5);
      ctx.lineTo(c + 12, c - 5);
      ctx.moveTo(c - 13, c + 3);
      ctx.lineTo(c + 13, c + 3);
      ctx.moveTo(c - 6, c - 5);
      ctx.lineTo(c - 10, c + 10);
      ctx.moveTo(c + 6, c - 5);
      ctx.lineTo(c + 10, c + 10);
      ctx.stroke();
    },
  },
  'poi-supermarket': {
    bg: '#16a34a',
    draw(ctx, c) {
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(c - 12, c - 8);
      ctx.lineTo(c - 8, c - 8);
      ctx.lineTo(c - 5, c + 4);
      ctx.lineTo(c + 9, c + 4);
      ctx.lineTo(c + 12, c - 5);
      ctx.lineTo(c - 7, c - 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c - 3, c + 10, 2.5, 0, Math.PI * 2);
      ctx.arc(c + 7, c + 10, 2.5, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  'poi-atm': {
    bg: '#0f766e',
    draw(ctx, c) {
      ctx.font = '800 23px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('₾', c, c + 1.5);
    },
  },
  'poi-attraction': {
    bg: '#c026d3',
    draw(ctx, c) {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 12 : 5.2;
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        const x = c + r * Math.cos(a);
        const y = c + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    },
  },
  'poi-car_wash': {
    bg: '#0284c7',
    draw(ctx, c) {
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(c, c - 12);
      ctx.quadraticCurveTo(c + 9, c, c + 7, c + 6);
      ctx.arc(c, c + 6, 7, 0, Math.PI);
      ctx.quadraticCurveTo(c - 9, c, c, c - 12);
      ctx.fill();
    },
  },
  'poi-car_repair': {
    bg: '#475569',
    draw(ctx, c) {
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(c - 9, c + 9);
      ctx.lineTo(c + 4, c - 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c + 6, c - 6, 5, 0.4, Math.PI * 1.6);
      ctx.stroke();
    },
  },
  'poi-toilets': {
    bg: '#64748b',
    draw(ctx, c) {
      ctx.font = '800 16px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('WC', c, c + 1);
    },
  },
  'poi-default': {
    bg: '#0a6cff',
    draw(ctx, c) {
      ctx.beginPath();
      ctx.arc(c, c, 7, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  'map-camera': {
    bg: '#dc2626',
    draw(ctx, c) {
      // Speed camera body + lens
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.roundRect(c - 12, c - 7, 24, 16, 4);
      ctx.fill();
      ctx.fillRect(c - 5, c - 11, 10, 5);
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.arc(c, c + 1, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(c, c + 1, 2.5, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  'map-hazard': {
    bg: '#d97706',
    shape: 'triangle',
    draw(ctx, c) {
      ctx.fillRect(c - 2.5, c - 6, 5, 11);
      ctx.beginPath();
      ctx.arc(c, c + 10, 2.8, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  'map-incident': {
    bg: '#dc2626',
    shape: 'diamond',
    draw(ctx, c) {
      ctx.fillRect(c - 2.5, c - 9, 5, 12);
      ctx.beginPath();
      ctx.arc(c, c + 8.5, 2.8, 0, Math.PI * 2);
      ctx.fill();
    },
  },
};

function renderBadgeIcon(spec: (typeof ICON_SPECS)[string]): { width: number; height: number; data: Uint8Array } | null {
  if (typeof document === 'undefined') return null;
  const size = 64;
  const c = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;

  ctx.fillStyle = spec.bg;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4.5;

  if (spec.shape === 'triangle') {
    ctx.beginPath();
    ctx.moveTo(c, 7);
    ctx.lineTo(size - 7, size - 9);
    ctx.lineTo(7, size - 9);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();
  } else if (spec.shape === 'diamond') {
    ctx.beginPath();
    ctx.moveTo(c, 6);
    ctx.lineTo(size - 6, c);
    ctx.lineTo(c, size - 6);
    ctx.lineTo(6, c);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(c, c, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  spec.draw(ctx, c);

  const img = ctx.getImageData(0, 0, size, size);
  return { width: size, height: size, data: new Uint8Array(img.data.buffer) };
}

/** Register high-visibility POI, camera, hazard, and incident badge icons on the MapLibre instance. */
export function registerMapIcons(map: MLMap): void {
  for (const [id, spec] of Object.entries(ICON_SPECS)) {
    if (map.hasImage(id)) continue;
    const img = renderBadgeIcon(spec);
    if (img) map.addImage(id, img, { pixelRatio: 2 });
  }
}
