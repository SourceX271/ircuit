#!/usr/bin/env node
/**
 * 生成 Ircuit 的应用图标源图（1024×1024 PNG）。
 *
 * ## 为什么不用图像库
 *
 * 图标只是一个圆角方块加一个 `#`，为它引入 canvas / sharp 这类原生依赖不划算，
 * 也会让三平台构建多一份不确定性。这里直接按 PNG 规范手写编码：
 * 用 zlib（Node 内置）压缩像素数据，自己算 CRC32。
 *
 * 图形阶段用有符号距离场（SDF）做抗锯齿，因此任意尺寸下边缘都是干净的。
 *
 * ## 用法
 *
 *     node scripts/dev/generate-icon.mjs
 *     pnpm exec tauri icon .cache/icon-source.png
 *
 * 仓库里不保存图标二进制：改图标就改本脚本。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;

/** 底板：内缩 40px 的圆角方块，圆角半径 224px。 */
const INSET = 40;
const HALF_SIDE = (SIZE - 2 * INSET) / 2;
const CORNER_RADIUS = 224;

/** `#` 的笔画半宽与四条笔画端点。 */
const STROKE_HALF = 44;
const SEGMENTS = [
  [392, 272, 328, 752], // 左竖
  [664, 272, 600, 752], // 右竖
  [272, 396, 752, 372], // 上横
  [272, 640, 752, 616], // 下横
];

/** 与 BrandMark 一致的渐变端色。 */
const GRADIENT_FROM = [79, 124, 255];
const GRADIENT_TO = [124, 58, 237];
const GLYPH_COLOR = [255, 255, 255];

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 6; // 颜色类型：真彩 + Alpha
  header[10] = 0; // 压缩方法
  header[11] = 0; // 过滤方法
  header[12] = 0; // 非隔行

  // 每行前置一个过滤器字节（0 = None）。
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const target = y * (1 + stride);
    raw[target] = 0;
    rgba.copy(raw, target + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ 图形

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 圆角矩形的有符号距离：内部为负。 */
function roundedBoxDistance(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const qx = Math.abs(px - cx) - (halfWidth - radius);
  const qy = Math.abs(py - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/** 点到线段的距离。 */
function segmentDistance(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const projection = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * projection, pay - bay * projection);
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const center = SIZE / 2;
  const gradientSpan = 2 * (SIZE - 2 * INSET);

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      // 距离场直接当覆盖率用，得到一像素宽的抗锯齿过渡带。
      const boxAlpha = clamp01(
        0.5 - roundedBoxDistance(px, py, center, center, HALF_SIDE, HALF_SIDE, CORNER_RADIUS),
      );
      if (boxAlpha <= 0) continue;

      let distance = Infinity;
      for (const [ax, ay, bx, by] of SEGMENTS) {
        distance = Math.min(distance, segmentDistance(px, py, ax, ay, bx, by));
      }
      const glyphAlpha = clamp01(0.5 - (distance - STROKE_HALF));

      const t = clamp01((px - INSET + (py - INSET)) / gradientSpan);
      const offset = (y * SIZE + x) * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const base = GRADIENT_FROM[channel] + (GRADIENT_TO[channel] - GRADIENT_FROM[channel]) * t;
        rgba[offset + channel] = Math.round(base + (GLYPH_COLOR[channel] - base) * glyphAlpha);
      }
      rgba[offset + 3] = Math.round(boxAlpha * 255);
    }
  }

  return rgba;
}

// ------------------------------------------------------------------ 入口

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputPath = process.argv[2] ?? resolve(repoRoot, '.cache', 'icon-source.png');

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, encodePng(SIZE, SIZE, render()));

console.log(`图标源图已生成: ${outputPath}`);
