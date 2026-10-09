// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jaramiyo. See LICENSE.
// Independent DDS/BC and RSC7 implementation. No external codec source.
import JSZip from 'jszip';
import { deflateSync, inflateSync } from 'fflate';

const MiB = 1024 * 1024;
const LIMITS = { file: 128 * MiB, resource: 256 * MiB, side: 8192, pixels: 16777216, textures: 2048 };
const SYSTEM_ADDRESS = 0x50000000, GRAPHICS_ADDRESS = 0x60000000;
const FOURCC = (s) => [...s].reduce((n, c, i) => n + c.charCodeAt(0) * 2 ** (i * 8), 0) >>> 0;
const FORMATS = {
  DXT1: { code: FOURCC('DXT1'), block: 8 }, DXT3: { code: FOURCC('DXT3'), block: 16 }, DXT5: { code: FOURCC('DXT5'), block: 16 },
  BC4: { code: FOURCC('ATI1'), block: 8 }, BC5: { code: FOURCC('ATI2'), block: 16 }, BC7: { code: FOURCC('BC7 '), block: 16 },
  A8B8G8R8: { code: 32, pixel: 4, masks: [0xff, 0xff00, 0xff0000, 0xff000000], flags: 0x41 },
  A8R8G8B8: { code: 21, pixel: 4, masks: [0xff0000, 0xff00, 0xff, 0xff000000], flags: 0x41 },
  X8R8G8B8: { code: 22, pixel: 4, masks: [0xff0000, 0xff00, 0xff, 0], flags: 0x40 },
  R5G6B5: { code: 23, pixel: 2, masks: [0xf800, 0x7e0, 0x1f, 0], flags: 0x40 },
  A1R5G5B5: { code: 25, pixel: 2, masks: [0x7c00, 0x3e0, 0x1f, 0x8000], flags: 0x41 },
  L8: { code: 50, pixel: 1, masks: [0xff, 0, 0, 0], flags: 0x20000 }, A8: { code: 28, pixel: 1, masks: [0, 0, 0, 0xff], flags: 0x2 },
};
const ALIASES = { BC1: 'DXT1', BC2: 'DXT3', BC3: 'DXT5', RGBA: 'A8B8G8R8', RGBA8: 'A8B8G8R8', BGRA8: 'A8R8G8B8', DDS: 'DXT5' };
const LABELS = { DXT1: 'BC1', DXT3: 'BC2', DXT5: 'BC3', A8B8G8R8: 'RGBA8', A8R8G8B8: 'BGRA8' };
const DXGI_FORMATS = { 28: 'A8B8G8R8', 29: 'A8B8G8R8', 70: 'DXT1', 71: 'DXT1', 72: 'DXT1', 73: 'DXT3', 74: 'DXT3', 75: 'DXT3', 76: 'DXT5', 77: 'DXT5', 78: 'DXT5', 79: 'BC4', 80: 'BC4', 82: 'BC5', 83: 'BC5', 87: 'A8R8G8B8', 88: 'X8R8G8B8', 91: 'A8R8G8B8', 93: 'X8R8G8B8', 97: 'BC7', 98: 'BC7', 99: 'BC7' };
const ENCODABLE = new Set(['DXT1', 'DXT3', 'DXT5', 'A8B8G8R8', 'A8R8G8B8']);
let sequence = 0;
const reject = (message) => { throw new Error(message); };
const canonical = (format) => ALIASES[String(format || 'BC3').toUpperCase()] || String(format || 'BC3').toUpperCase();
const label = (format) => LABELS[format] || format;
const identity = () => globalThis.crypto?.randomUUID?.() || `jara-texture-${++sequence}`;
const align16 = (n) => Math.ceil(n / 16) * 16;
const textureName = (value) => String(value.textureName || value.name || 'texture').replace(/\.(dds|png|webp|jpe?g|bmp|ytd)$/i, '');
const downloadName = (name) => name.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 180) || 'texture';

export const TEXTURE_SUPPORT = Object.freeze({
  import: ['YTD RSC7 v13', 'DDS', 'PNG', 'JPEG', 'WebP', 'BMP'],
  export: ['YTD RSC7 v13', 'DDS BC1', 'DDS BC3', 'DDS RGBA8', 'PNG', 'WebP'],
  limitations: 'YTD Legacy RSC7 versión 13 y texturas 2D. FXAP y Enhanced/Gen9 no están admitidos. BC7 se conserva sin vista previa ni recodificación. Máximo 16 megapíxeles por textura y 128 MB por archivo.',
});
function validSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) reject('Las dimensiones de la textura no son válidas.');
  if (width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.pixels) reject('La textura supera el límite de 16 megapíxeles u 8192 px por lado.');
}
function pixelsOf(rgba, width, height) {
  validSize(width, height);
  if (!ArrayBuffer.isView(rgba) || rgba.BYTES_PER_ELEMENT !== 1 || rgba.byteLength !== width * height * 4) reject('Los píxeles RGBA no coinciden con las dimensiones.');
  return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}
function rawView(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  reject('No se pudo leer el archivo.');
}
async function readBytes(input) { return input?.arrayBuffer ? new Uint8Array(await input.arrayBuffer()) : rawView(input); }
const mipLimit = (width, height) => Math.floor(Math.log2(Math.max(width, height))) + 1;
const gameMipLimit = (format, width, height) => Math.max(1, Math.floor(Math.log2(Math.min(width, height) / (FORMATS[format]?.block ? 4 : 1))) + 1);
function levelBytes(format, width, height) {
  const spec = FORMATS[format]; if (!spec) reject(`Formato ${format} no admitido.`);
  return spec.block ? Math.ceil(width / 4) * Math.ceil(height / 4) * spec.block : width * height * spec.pixel;
}
function chainBytes(format, width, height, levels) {
  let length = 0;
  for (let i = 0; i < levels; i++) { length += levelBytes(format, width, height); width = Math.max(1, width >> 1); height = Math.max(1, height >> 1); }
  return length;
}
function expand565(code, palette, offset) {
  const r = code >>> 11, g = (code >>> 5) & 63, b = code & 31;
  palette[offset] = (r << 3) | (r >>> 2); palette[offset + 1] = (g << 2) | (g >>> 4); palette[offset + 2] = (b << 3) | (b >>> 2); palette[offset + 3] = 255;
}
function quantize565(r, g, b) { return (Math.round(Math.max(0, Math.min(255, r)) * 31 / 255) << 11) | (Math.round(Math.max(0, Math.min(255, g)) * 63 / 255) << 5) | Math.round(Math.max(0, Math.min(255, b)) * 31 / 255); }
function colorPalette(first, second, fourColors, table) {
  expand565(first, table, 0); expand565(second, table, 4);
  if (fourColors || first > second) {
    for (let c = 0; c < 3; c++) { table[8 + c] = Math.floor((table[c] * 2 + table[4 + c]) / 3); table[12 + c] = Math.floor((table[c] + table[4 + c] * 2) / 3); }
    table[11] = table[15] = 255;
  } else {
    for (let c = 0; c < 3; c++) { table[8 + c] = (table[c] + table[4 + c]) >>> 1; table[12 + c] = 0; }
    table[11] = 255; table[15] = 0;
  }
}
function alphaPalette(first, second, table) {
  table[0] = first; table[1] = second;
  const denominator = first > second ? 7 : 5;
  for (let i = 1; i < denominator; i++) table[i + 1] = Math.floor(((denominator - i) * first + i * second) / denominator);
  if (denominator === 5) { table[6] = 0; table[7] = 255; }
}
function alphaIndex(bytes, offset, index) {
  const bit = index * 3, byte = offset + 2 + (bit >>> 3), shift = bit & 7;
  return ((bytes[byte] | ((bytes[byte + 1] || 0) << 8)) >>> shift) & 7;
}
function decodeLevel(bytes, format, width, height) {
  if (bytes.length < levelBytes(format, width, height)) reject('Los datos de la textura están incompletos.');
  if (format === 'BC7') return null;
  const result = new Uint8Array(width * height * 4), spec = FORMATS[format];
  if (!spec.block) {
    for (let p = 0; p < width * height; p++) {
      const o = p * 4, s = p * spec.pixel;
      if (format === 'A8B8G8R8') result.set(bytes.subarray(s, s + 4), o);
      else if (format === 'A8R8G8B8' || format === 'X8R8G8B8') { result[o] = bytes[s + 2]; result[o + 1] = bytes[s + 1]; result[o + 2] = bytes[s]; result[o + 3] = format === 'X8R8G8B8' ? 255 : bytes[s + 3]; }
      else if (format === 'R5G6B5') expand565(bytes[s] | (bytes[s + 1] << 8), result, o);
      else if (format === 'A1R5G5B5') {
        const code = bytes[s] | (bytes[s + 1] << 8);
        result[o] = Math.round(((code >>> 10) & 31) * 255 / 31); result[o + 1] = Math.round(((code >>> 5) & 31) * 255 / 31); result[o + 2] = Math.round((code & 31) * 255 / 31); result[o + 3] = code & 0x8000 ? 255 : 0;
      } else if (format === 'L8') { result[o] = result[o + 1] = result[o + 2] = bytes[s]; result[o + 3] = 255; }
      else if (format === 'A8') { result[o] = result[o + 1] = result[o + 2] = 255; result[o + 3] = bytes[s]; }
    }
    return result;
  }
  const colors = new Uint8Array(16), alpha = new Uint8Array(8), green = new Uint8Array(8);
  let offset = 0;
  for (let by = 0; by < height; by += 4) for (let bx = 0; bx < width; bx += 4) {
    const colorOffset = offset + (format === 'DXT3' || format === 'DXT5' ? 8 : 0);
    if (format.startsWith('DXT')) colorPalette(bytes[colorOffset] | (bytes[colorOffset + 1] << 8), bytes[colorOffset + 2] | (bytes[colorOffset + 3] << 8), format !== 'DXT1', colors);
    if (format === 'DXT5' || format === 'BC4' || format === 'BC5') alphaPalette(bytes[offset], bytes[offset + 1], alpha);
    if (format === 'BC5') alphaPalette(bytes[offset + 8], bytes[offset + 9], green);
    for (let py = 0; py < 4 && by + py < height; py++) for (let px = 0; px < 4 && bx + px < width; px++) {
      const index = py * 4 + px, dest = ((by + py) * width + bx + px) * 4;
      if (format === 'BC4' || format === 'BC5') {
        result[dest] = alpha[alphaIndex(bytes, offset, index)]; result[dest + 1] = format === 'BC5' ? green[alphaIndex(bytes, offset + 8, index)] : result[dest]; result[dest + 2] = format === 'BC5' ? 0 : result[dest]; result[dest + 3] = 255;
      } else {
        const code = (bytes[colorOffset + 4 + (index >>> 2)] >>> ((index & 3) * 2)) & 3;
        result.set(colors.subarray(code * 4, code * 4 + 4), dest);
        if (format === 'DXT3') result[dest + 3] = ((bytes[offset + (index >>> 1)] >>> ((index & 1) * 4)) & 15) * 17;
        if (format === 'DXT5') result[dest + 3] = alpha[alphaIndex(bytes, offset, index)];
      }
    }
    offset += spec.block;
  }
  return result;
}

// Original color fitting: principal direction, quantization, and two rounds
// of least-squares endpoint refinement after closest-palette assignment.
function encodeColor(block, target, offset, allowTransparency, scratch) {
  let transparent = false, count = 0;
  const mean = [0, 0, 0];
  for (let i = 0; i < 16; i++) { const p = i * 4; if (allowTransparency && block[p + 3] < 128) { transparent = true; continue; } for (let c = 0; c < 3; c++) mean[c] += block[p + c]; count++; }
  if (!count) { target.fill(0, offset, offset + 4); target.fill(255, offset + 4, offset + 8); return; }
  for (let c = 0; c < 3; c++) mean[c] /= count;
  const covariance = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 16; i++) {
    const p = i * 4; if (transparent && block[p + 3] < 128) continue;
    const r = block[p] - mean[0], g = block[p + 1] - mean[1], b = block[p + 2] - mean[2];
    covariance[0] += r * r; covariance[1] += g * g; covariance[2] += b * b; covariance[3] += r * g; covariance[4] += r * b; covariance[5] += g * b;
  }
  let axis = covariance[0] >= covariance[1] && covariance[0] >= covariance[2] ? [1, 0, 0] : covariance[1] >= covariance[2] ? [0, 1, 0] : [0, 0, 1];
  for (let iteration = 0; iteration < 3; iteration++) {
    const x = covariance[0] * axis[0] + covariance[3] * axis[1] + covariance[4] * axis[2], y = covariance[3] * axis[0] + covariance[1] * axis[1] + covariance[5] * axis[2], z = covariance[4] * axis[0] + covariance[5] * axis[1] + covariance[2] * axis[2];
    const size = Math.hypot(x, y, z); if (!size) break; axis = [x / size, y / size, z / size];
  }
  let min = Infinity, max = -Infinity, low = mean, high = mean;
  for (let i = 0; i < 16; i++) {
    const p = i * 4; if (transparent && block[p + 3] < 128) continue;
    const projection = block[p] * axis[0] + block[p + 1] * axis[1] + block[p + 2] * axis[2];
    if (projection < min) { min = projection; low = [block[p], block[p + 1], block[p + 2]]; }
    if (projection > max) { max = projection; high = [block[p], block[p + 1], block[p + 2]]; }
  }
  let first = quantize565(...high), second = quantize565(...low), bestError = Infinity, bestFirst = first, bestSecond = second, bestBits = 0;
  const table = scratch.colors, choices = scratch.choices;
  for (let iteration = 0; iteration < 3; iteration++) {
    if ((transparent && first > second) || (!transparent && first < second)) [first, second] = [second, first];
    if (!transparent && first === second) { if (first < 65535) first++; else second--; }
    colorPalette(first, second, !transparent, table);
    let total = 0, bits = 0;
    for (let i = 0; i < 16; i++) {
      const p = i * 4;
      if (transparent && block[p + 3] < 128) { choices[i] = 3; bits = (bits | (3 << (2 * i))) >>> 0; continue; }
      let smallest = Infinity, selected = 0;
      for (let k = 0; k < (transparent ? 3 : 4); k++) { const q = k * 4, distance = (block[p] - table[q]) ** 2 + (block[p + 1] - table[q + 1]) ** 2 + (block[p + 2] - table[q + 2]) ** 2; if (distance < smallest) { smallest = distance; selected = k; } }
      choices[i] = selected; bits = (bits | (selected << (2 * i))) >>> 0; total += smallest;
    }
    if (total < bestError) { bestError = total; bestFirst = first; bestSecond = second; bestBits = bits; }
    if (iteration === 2 || total === 0) break;
    let aa = 0, ab = 0, bb = 0; const ar = [0, 0, 0], br = [0, 0, 0];
    for (let i = 0; i < 16; i++) {
      const p = i * 4; if (transparent && block[p + 3] < 128) continue;
      const choice = choices[i], a = choice === 0 ? 1 : choice === 1 ? 0 : transparent ? 0.5 : choice === 2 ? 2 / 3 : 1 / 3, b = 1 - a;
      aa += a * a; ab += a * b; bb += b * b;
      for (let c = 0; c < 3; c++) { ar[c] += a * block[p + c]; br[c] += b * block[p + c]; }
    }
    const determinant = aa * bb - ab * ab; if (determinant < 1e-8) break;
    first = quantize565(...ar.map((value, c) => (value * bb - br[c] * ab) / determinant)); second = quantize565(...br.map((value, c) => (value * aa - ar[c] * ab) / determinant));
  }
  target[offset] = bestFirst & 255; target[offset + 1] = bestFirst >>> 8; target[offset + 2] = bestSecond & 255; target[offset + 3] = bestSecond >>> 8;
  for (let b = 0; b < 4; b++) target[offset + 4 + b] = (bestBits >>> (b * 8)) & 255;
}
function encodeAlpha(block, target, offset, table) {
  let low = 255, high = 0;
  for (let i = 3; i < 64; i += 4) { low = Math.min(low, block[i]); high = Math.max(high, block[i]); }
  target[offset] = high; target[offset + 1] = low; alphaPalette(high, low, table); target.fill(0, offset + 2, offset + 8);
  for (let i = 0; i < 16; i++) {
    let selected = 0, difference = Infinity;
    for (let k = 0; k < 8; k++) { const distance = Math.abs(block[i * 4 + 3] - table[k]); if (distance < difference) { difference = distance; selected = k; } }
    const bit = i * 3, byte = offset + 2 + (bit >>> 3), shift = bit & 7; target[byte] |= (selected << shift) & 255; if (shift > 5) target[byte + 1] |= selected >>> (8 - shift);
  }
}
function encodeLevel(pixels, width, height, format) {
  if (format === 'A8B8G8R8') return pixels.slice();
  if (format === 'A8R8G8B8') { const result = pixels.slice(); for (let i = 0; i < result.length; i += 4) { result[i] = pixels[i + 2]; result[i + 2] = pixels[i]; } return result; }
  const output = new Uint8Array(levelBytes(format, width, height)), block = new Uint8Array(64), scratch = { colors: new Uint8Array(16), choices: new Uint8Array(16), alpha: new Uint8Array(8) };
  let offset = 0;
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
    for (let j = 0; j < 16; j++) { const source = (Math.min(height - 1, y + (j >>> 2)) * width + Math.min(width - 1, x + (j & 3))) * 4; block.set(pixels.subarray(source, source + 4), j * 4); }
    if (format === 'DXT5') encodeAlpha(block, output, offset, scratch.alpha);
    if (format === 'DXT3') for (let j = 0; j < 8; j++) output[offset + j] = Math.round(block[j * 8 + 3] / 17) | (Math.round(block[j * 8 + 7] / 17) << 4);
    encodeColor(block, output, offset + (format === 'DXT1' ? 0 : 8), format === 'DXT1', scratch); offset += FORMATS[format].block;
  }
  return output;
}
function scalePixels(pixels, width, height, nextWidth, nextHeight) {
  if (width === nextWidth && height === nextHeight) return pixels.slice();
  const output = new Uint8Array(nextWidth * nextHeight * 4);
  // Area filtering of premultiplied colors preserves transparent edges.
  for (let y = 0; y < nextHeight; y++) for (let x = 0; x < nextWidth; x++) {
    const x0 = x * width / nextWidth, x1 = (x + 1) * width / nextWidth, y0 = y * height / nextHeight, y1 = (y + 1) * height / nextHeight;
    let r = 0, g = 0, b = 0, alpha = 0, weight = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
      const area = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy)), p = (Math.min(height - 1, sy) * width + Math.min(width - 1, sx)) * 4, a = pixels[p + 3] * area;
      r += pixels[p] * a; g += pixels[p + 1] * a; b += pixels[p + 2] * a; alpha += a; weight += area;
    }
    const dest = (y * nextWidth + x) * 4;
    output[dest] = alpha ? Math.round(r / alpha) : 0; output[dest + 1] = alpha ? Math.round(g / alpha) : 0; output[dest + 2] = alpha ? Math.round(b / alpha) : 0; output[dest + 3] = Math.round(alpha / weight);
  }
  return output;
}
function wrapDDS(format, width, height, levels, payload) {
  validSize(width, height);
  if (!Number.isInteger(levels) || levels < 1 || levels > mipLimit(width, height)) reject('La cantidad de mipmaps no es válida.');
  const spec = FORMATS[format], dx10 = format === 'BC7';
  if (!spec || payload.length !== chainBytes(format, width, height, levels)) reject('Los datos DDS no coinciden con sus dimensiones y mipmaps.');
  const output = new Uint8Array((dx10 ? 148 : 128) + payload.length), header = new DataView(output.buffer), u32 = (offset, value) => header.setUint32(offset, value >>> 0, true);
  u32(0, FOURCC('DDS ')); u32(4, 124); u32(8, 0x1007 | (spec.block ? 0x80000 : 8) | (levels > 1 ? 0x20000 : 0)); u32(12, height); u32(16, width); u32(20, spec.block ? levelBytes(format, width, height) : width * spec.pixel); u32(28, levels); u32(76, 32); u32(80, spec.block ? 4 : spec.flags);
  if (spec.block) u32(84, dx10 ? FOURCC('DX10') : spec.code);
  else { u32(88, spec.pixel * 8); spec.masks.forEach((mask, i) => u32(92 + i * 4, mask)); }
  u32(108, 0x1000 | (levels > 1 ? 0x400008 : 0)); if (dx10) { u32(128, 98); u32(132, 3); u32(140, 1); }
  output.set(payload, dx10 ? 148 : 128); return output;
}
function parseDDS(bytes) {
  if (bytes.length < 128) reject('DDS incompleto: falta la cabecera.'); if (bytes.length > LIMITS.file) reject('El archivo supera el límite de 128 MB.');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u32 = (offset) => header.getUint32(offset, true);
  if (u32(0) !== FOURCC('DDS ') || u32(4) !== 124 || u32(76) !== 32) reject('La cabecera DDS no es válida.');
  const width = u32(16), height = u32(12); validSize(width, height);
  if ((u32(112) & 0x20fe00) || u32(24) > 1) reject('Solo se admiten DDS 2D; no cubemaps ni volúmenes.');
  const levels = u32(28) || 1; if (levels > mipLimit(width, height)) reject('La cantidad de mipmaps DDS no es válida.');
  let format, start = 128;
  if (u32(80) & 4) {
    const code = u32(84);
    if (code === FOURCC('DX10')) { if (bytes.length < 148) reject('DDS DX10 incompleto.'); if (u32(132) !== 3 || u32(140) !== 1 || (u32(136) & 4)) reject('Solo se admiten DDS DX10 2D de una textura.'); format = DXGI_FORMATS[u32(128)]; start = 148; }
    else { format = Object.keys(FORMATS).find((name) => FORMATS[name].block && FORMATS[name].code === code); if (code === FOURCC('BC4U')) format = 'BC4'; if (code === FOURCC('BC5U')) format = 'BC5'; }
    if (!format) reject('Este formato comprimido DDS no está admitido.');
  } else {
    const masks = [92, 96, 100, 104].map(u32);
    format = Object.keys(FORMATS).find((name) => FORMATS[name].masks && FORMATS[name].pixel * 8 === u32(88) && FORMATS[name].masks.every((mask, i) => mask === masks[i]));
    if (!format) reject('El orden de canales de este DDS no está admitido.');
  }
  const length = chainBytes(format, width, height, levels); if (bytes.length - start < length) reject('DDS incompleto: faltan datos de los mipmaps.');
  if (!FORMATS[format].block && (u32(8) & 8) && u32(20) !== width * FORMATS[format].pixel) reject('El DDS usa un stride de canales no admitido; exporta con filas compactas.');
  const allLevels = bytes.subarray(start, start + length); return { width, height, levels, format, data: allLevels.subarray(0, levelBytes(format, width, height)), allLevels };
}
export function encodeDDS(rgba, width, height, { format = 'BC3', mipmaps = true, levels } = {}) {
  let pixels = pixelsOf(rgba, width, height); const codec = canonical(format);
  if (!ENCODABLE.has(codec)) reject(`No se puede codificar el formato ${format}.`);
  const count = levels ?? (mipmaps ? gameMipLimit(codec, width, height) : 1); if (!Number.isInteger(count) || count < 1 || count > mipLimit(width, height)) reject('La cantidad de mipmaps no es válida.');
  const payload = new Uint8Array(chainBytes(codec, width, height, count)); let w = width, h = height, offset = 0;
  for (let i = 0; i < count; i++) {
    const encoded = encodeLevel(pixels, w, h, codec); payload.set(encoded, offset); offset += encoded.length;
    if (i < count - 1) { const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1); pixels = scalePixels(pixels, w, h, nw, nh); w = nw; h = nh; }
  }
  return wrapDDS(codec, width, height, count, payload);
}
export function decodeDDS(input) {
  const parsed = parseDDS(rawView(input)); return { ...parsed, codec: parsed.format, format: label(parsed.format), rgba: decodeLevel(parsed.data, parsed.format, parsed.width, parsed.height) };
}

// The flag word is a table of page counts, not a byte count. This decoder
// accepts every documented category, including files produced by other tools.
function resourceSize(flags) {
  const fields = [[27, 1, 1], [26, 1, 2], [25, 1, 4], [24, 1, 8], [17, 127, 16], [11, 63, 32], [7, 15, 64], [5, 3, 128], [4, 1, 256]];
  return fields.reduce((units, [shift, mask, multiplier]) => units + ((flags >>> shift) & mask) * multiplier, 0) * 512 * 2 ** (flags & 15);
}
function openResource(bytes) {
  if (bytes.length >= 4 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'FXAP') reject('Este archivo está cifrado con FiveM escrow (FXAP).');
  if (bytes.length >= 4 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RSC8') reject('Gen9 / Enhanced (RSC8) no está admitido.');
  if (bytes.length < 16) reject('El YTD está incompleto: falta la cabecera RSC7.');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== FOURCC('RSC7')) reject('El archivo no es un YTD RSC7 válido.');
  const version = header.getUint32(4, true); if (version !== 13) reject(`La versión YTD ${version} no está admitida. Utiliza RSC7 versión 13.`);
  const systemSize = resourceSize(header.getUint32(8, true)), graphicsSize = resourceSize(header.getUint32(12, true));
  if (systemSize < 64 || systemSize + graphicsSize > LIMITS.resource) reject('Las páginas del YTD no son válidas o superan 256 MB.');
  const expected = systemSize + graphicsSize;
  let expanded;
  try { expanded = inflateSync(bytes.subarray(16), { out: new Uint8Array(expected + 1) }); }
  catch { if (bytes.length - 16 !== expected) reject('El YTD está incompleto o su compresión no es válida.'); expanded = bytes.subarray(16); }
  if (expanded.length !== expected) reject('El tamaño descomprimido del YTD no coincide con sus páginas.');
  const system = expanded.subarray(0, systemSize), graphics = expanded.subarray(systemSize), view = new DataView(system.buffer, system.byteOffset, system.length);
  const region = (pointer, length, base = SYSTEM_ADDRESS) => {
    const data = base === SYSTEM_ADDRESS ? system : graphics, offset = pointer - base;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > data.length) reject('El YTD contiene punteros inválidos o datos incompletos.');
    return data.subarray(offset, offset + length);
  };
  const pointerAt = (offset, base = SYSTEM_ADDRESS) => {
    if (offset < 0 || offset + 8 > system.length || view.getUint32(offset + 4, true) !== 0) reject('El YTD contiene un puntero de 64 bits inválido.');
    const pointer = view.getUint32(offset, true); region(pointer, 0, base); return pointer;
  };
  const count = view.getUint16(0x38, true), hashCount = view.getUint16(0x28, true);
  if (count > LIMITS.textures || count !== hashCount || view.getUint16(0x3a, true) < count || view.getUint16(0x2a, true) < count) reject('El diccionario YTD no es válido o contiene demasiadas texturas.');
  if (!count) return { entries: [], systemSize, graphicsSize, root: system.slice(0, 64) };
  const pointerTable = pointerAt(0x30) - SYSTEM_ADDRESS, hashTable = pointerAt(0x20) - SYSTEM_ADDRESS;
  region(SYSTEM_ADDRESS + pointerTable, count * 8); region(SYSTEM_ADDRESS + hashTable, count * 4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const address = pointerAt(pointerTable + i * 8), start = address - SYSTEM_ADDRESS;
    const struct = region(address, 0x90).slice(), texture = new DataView(struct.buffer);
    const nameAddress = pointerAt(start + 0x28), nameOffset = nameAddress - SYSTEM_ADDRESS;
    const end = system.indexOf(0, nameOffset);
    if (end < nameOffset || end - nameOffset > 255) reject('El nombre de una textura YTD está incompleto o supera 255 caracteres.');
    const name = new TextDecoder().decode(system.subarray(nameOffset, end));
    const width = texture.getUint16(0x50, true), height = texture.getUint16(0x52, true), levels = texture.getUint8(0x5d);
    validSize(width, height);
    if (texture.getUint16(0x54, true) !== 1) reject(`La textura ${name} no es 2D.`);
    if (levels < 1 || levels > mipLimit(width, height)) reject(`Mipmaps inválidos en ${name}.`);
    const formatCode = texture.getUint32(0x58, true), format = Object.keys(FORMATS).find((key) => FORMATS[key].code === formatCode);
    let encoded = null;
    if (format) encoded = region(pointerAt(start + 0x70, GRAPHICS_ADDRESS), chainBytes(format, width, height, levels), GRAPHICS_ADDRESS);
    entries.push({ name, width, height, levels, codec: format, format: format ? label(format) : `0x${formatCode.toString(16)}`, encoded, struct, hash: view.getUint32(hashTable + i * 4, true) });
  }
  return { entries, systemSize, graphicsSize, root: system.slice(0, 64) };
}
function browserCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}
function imageBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, failure) => canvas.toBlob((blob) => blob ? resolve(blob) : failure(new Error('No se pudo codificar la imagen.')), type, quality));
}
function scaledSize(width, height, maxSize) {
  const maximum = maxSize == null ? Math.max(width, height) : Number(maxSize);
  if (!Number.isFinite(maximum) || maximum < 1 || maximum > LIMITS.side) reject('El tamaño máximo debe estar entre 1 y 8192 px.');
  const ratio = Math.min(1, maximum / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
async function previewURL(rgba, width, height) {
  if (!rgba) return null;
  const next = scaledSize(width, height, 512), canvas = browserCanvas(next.width, next.height), ctx = canvas?.getContext('2d');
  if (!ctx || typeof ImageData === 'undefined') return null;
  const pixels = scalePixels(rgba, width, height, next.width, next.height);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), next.width, next.height), 0, 0);
  return URL.createObjectURL(await imageBlob(canvas, 'image/png'));
}
export async function inspectTextureFile(file) {
  if (!file?.arrayBuffer) reject('Selecciona un archivo de textura.');
  if (file.size > LIMITS.file) reject('El archivo supera el límite de 128 MB.');
  const bytes = await readBytes(file); if (bytes.length > LIMITS.file) reject('El archivo supera el límite de 128 MB.');
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  if (extension === 'ytd') {
    const resource = openResource(bytes), textures = [];
    for (const entry of resource.entries) {
      // Preview an existing mip when possible; large imported resources need
      // only a small canvas and no full-resolution RGBA allocation to inspect.
      let preview = null, w = entry.width, h = entry.height, level = 0, offset = 0;
      if (entry.encoded && entry.codec !== 'BC7') {
        while (Math.max(w, h) > 512 && level < entry.levels - 1) { offset += levelBytes(entry.codec, w, h); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); level++; }
        preview = await previewURL(decodeLevel(entry.encoded.subarray(offset), entry.codec, w, h), w, h);
      }
      textures.push({ id: identity(), name: entry.name, textureName: entry.name, width: entry.width, height: entry.height, format: entry.format, codec: entry.codec, levels: entry.levels,
        bytes: entry.encoded?.length || 0, memoryBytes: entry.encoded?.length || 0, previewUrl: preview, sourceFile: file, sourceType: 'ytd', canOptimize: !!entry.encoded && entry.codec !== 'BC7',
        warning: !entry.encoded ? `Formato ${entry.format} no admitido.` : entry.codec === 'BC7' ? 'BC7 se conserva sin cambios; no se previsualiza ni se recodifica.' : null,
        resourceMemory: resource.systemSize + resource.graphicsSize, _encoded: entry.encoded, _struct: entry.struct, _hash: entry.hash, _ytdRoot: resource.root });
    }
    return textures;
  }
  if (extension === 'dds' || (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(0, true) === FOURCC('DDS '))) {
    const texture = decodeDDS(bytes), name = textureName(file);
    return [{ ...texture, id: identity(), name, textureName: name, bytes: bytes.length, memoryBytes: texture.allLevels.length, sourceFile: file, sourceType: 'dds',
      _encoded: texture.allLevels, previewUrl: await previewURL(texture.rgba, texture.width, texture.height), canOptimize: texture.codec !== 'BC7', warning: texture.codec === 'BC7' ? 'BC7 se conserva sin cambios; no se recodifica.' : null }];
  }
  if (!/^(png|jpe?g|webp|bmp|gif)$/.test(extension) && !/^image\//.test(file.type || '')) reject('Formato no admitido. Añade YTD, DDS, PNG, JPG o WebP.');
  if (typeof createImageBitmap === 'undefined') reject('Este entorno no dispone de decodificación de imágenes.');
  const bitmap = await createImageBitmap(file);
  try {
    validSize(bitmap.width, bitmap.height); const size = scaledSize(bitmap.width, bitmap.height, 512), canvas = browserCanvas(size.width, size.height), ctx = canvas?.getContext('2d');
    if (!ctx) reject('No se pudo abrir un canvas para la imagen.');
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    return [{ id: identity(), name: textureName(file), textureName: textureName(file), width: bitmap.width, height: bitmap.height, format: extension.toUpperCase(), levels: 1, bytes: file.size,
      memoryBytes: bitmap.width * bitmap.height * 4, previewUrl: URL.createObjectURL(await imageBlob(canvas, 'image/png')), sourceFile: file, sourceType: 'image', canOptimize: true }];
  } finally { bitmap.close(); }
}
async function loadPixels(texture, size) {
  if (texture.rgba) return scalePixels(pixelsOf(texture.rgba, texture.width, texture.height), texture.width, texture.height, size.width, size.height);
  if (texture._encoded) {
    const codec = canonical(texture.codec || texture.format);
    if (codec === 'BC7') reject('La recodificación de BC7 no está disponible. Puedes exportar sus datos originales.');
    return scalePixels(decodeLevel(texture._encoded, codec, texture.width, texture.height), texture.width, texture.height, size.width, size.height);
  }
  if (!texture.sourceFile || typeof createImageBitmap === 'undefined') reject('Faltan los píxeles de la textura.');
  const bitmap = await createImageBitmap(texture.sourceFile);
  try {
    const canvas = browserCanvas(size.width, size.height), ctx = canvas?.getContext('2d'); if (!ctx) reject('No se pudo crear el canvas.');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    return new Uint8Array(ctx.getImageData(0, 0, size.width, size.height).data);
  } finally { bitmap.close(); }
}
export async function optimizeTexture(texture, { maxSize, format = 'BC3', quality = 0.85, mipmaps = true, fitForYtd = false } = {}) {
  validSize(texture.width, texture.height);
  const size = scaledSize(texture.width, texture.height, maxSize);
  // Explicit opt-in: Legacy mipmapped dictionaries require power-of-two sides.
  // Keep ordinary DDS/image optimization at its original aspect ratio by default.
  if (fitForYtd) {
    size.width = Math.max(4, 2 ** Math.floor(Math.log2(size.width)));
    size.height = Math.max(4, 2 ** Math.floor(Math.log2(size.height)));
  }
  const pixels = await loadPixels(texture, size), codec = canonical(format);
  let blob, rgba, encoded = null, levels = 1, extension = 'dds';
  if (['PNG', 'WEBP', 'JPG', 'JPEG'].includes(codec)) {
    const canvas = browserCanvas(size.width, size.height), ctx = canvas?.getContext('2d'); if (!ctx) reject('La exportación de imágenes requiere un navegador con canvas.');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), size.width, size.height), 0, 0);
    const mime = codec === 'PNG' ? 'image/png' : codec === 'WEBP' ? 'image/webp' : 'image/jpeg', value = Number(quality), q = Number.isFinite(value) ? Math.max(0, Math.min(1, value > 1 ? value / 100 : value)) : 0.85;
    blob = await imageBlob(canvas, mime, q); if (blob.type !== mime) reject(`Este navegador no puede exportar ${codec}.`);
    const bitmap = await createImageBitmap(blob);
    try { ctx.clearRect(0, 0, size.width, size.height); ctx.drawImage(bitmap, 0, 0); rgba = new Uint8Array(ctx.getImageData(0, 0, size.width, size.height).data); } finally { bitmap.close(); }
    extension = codec === 'PNG' ? 'png' : codec === 'WEBP' ? 'webp' : 'jpg';
  } else {
    const bytes = encodeDDS(pixels, size.width, size.height, { format: codec, mipmaps }), parsed = decodeDDS(bytes);
    blob = new Blob([bytes], { type: 'application/octet-stream' }); rgba = parsed.rgba; encoded = parsed.allLevels; levels = parsed.levels;
  }
  const name = textureName(texture);
  return { ...texture, ...size, id: texture.id || identity(), textureName: name, name: `${downloadName(name)}.${extension}`, format: label(codec), codec, levels, blob,
    rgba, _encoded: encoded, previewUrl: await previewURL(rgba, size.width, size.height), bytes: blob.size, memoryBytes: encoded?.length ?? pixels.length,
    originalBytes: texture.originalBytes ?? texture.bytes ?? texture.sourceFile?.size ?? pixels.length, optimized: true, canOptimize: true, warning: null };
}

// Jenkins one-at-a-time hashing is part of the dictionary's file format.
function nameHash(name) {
  let hash = 0;
  for (const character of name.toLowerCase()) { hash = (hash + character.charCodeAt(0)) >>> 0; hash = (hash + (hash << 10)) >>> 0; hash ^= hash >>> 6; }
  hash = (hash + (hash << 3)) >>> 0; hash ^= hash >>> 11; return (hash + (hash << 15)) >>> 0;
}
function allocateSegment(lengths) {
  let used = 0;
  const positions = lengths.map((length) => { used = align16(used); const position = used; used += length; return position; });
  // One power-of-two page guarantees no object crosses a page boundary.
  // The smallest writer page is 8 KiB (flag category 16), as used by Legacy.
  const shift = Math.max(0, Math.ceil(Math.log2(Math.max(1, used) / 8192))), size = 8192 * 2 ** shift;
  if (shift > 15 || size > LIMITS.resource) reject('El diccionario necesita demasiadas páginas o supera 256 MB.');
  return { positions, size, flags: 0x20000 | shift };
}
function dictionaryDDS(dds, preserve) {
  const compressed = !!FORMATS[dds.format].block;
  if (compressed && (dds.width % 4 || dds.height % 4)) reject('Para exportar YTD, las texturas BC deben medir múltiplos de 4.');
  if (dds.levels > 1 && ((dds.width & (dds.width - 1)) || (dds.height & (dds.height - 1)))) reject('Para un YTD con mipmaps, ambos lados deben ser potencias de 2.');
  const levels = preserve ? dds.levels : Math.min(dds.levels, gameMipLimit(dds.format, dds.width, dds.height));
  return { ...dds, levels, allLevels: dds.allLevels.subarray(0, chainBytes(dds.format, dds.width, dds.height, levels)) };
}
export async function buildYtdFromDDS(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > LIMITS.textures) reject('Añade entre 1 y 2048 texturas para crear el YTD.');
  const entries = [], names = new Set(), hashes = new Set();
  for (const input of inputs) {
    const name = textureName(input), lowerName = name.toLowerCase(), hash = nameHash(name);
    if (!name || name.length > 255 || /[^\x20-\x7e]/.test(name)) reject('Los nombres de las texturas YTD deben ser ASCII y tener entre 1 y 255 caracteres.');
    if (names.has(lowerName) || hashes.has(hash)) reject(`Nombre o hash de textura repetido: ${name}.`);
    names.add(lowerName); hashes.add(hash);
    const dds = dictionaryDDS(parseDDS(await readBytes(input.dds)), !!input._struct);
    if (input._struct && input._struct.byteLength !== 0x90) reject(`Metadatos de textura inválidos: ${name}.`);
    if (input._ytdRoot && input._ytdRoot.byteLength !== 0x40) reject('Metadatos del diccionario inválidos.');
    entries.push({ name, hash, dds, struct: input._struct, root: input._ytdRoot, string: new TextEncoder().encode(name + '\0') });
  }
  entries.sort((a, b) => a.hash - b.hash);
  const count = entries.length, gpu = allocateSegment(entries.map((entry) => entry.dds.allLevels.length));
  const cpu = allocateSegment([64, 32, count * 4, count * 8, ...entries.map(() => 144), ...entries.map((entry) => entry.string.length)]);
  if (cpu.size + gpu.size > LIMITS.resource) reject('Las páginas del diccionario superan 256 MB. Reduce el número o tamaño de las texturas.');
  const bytes = new Uint8Array(cpu.size + gpu.size), system = bytes.subarray(0, cpu.size), graphics = bytes.subarray(cpu.size), view = new DataView(bytes.buffer, 0, cpu.size);
  const [root, pageInfo, hashTable, pointerTable] = cpu.positions;
  const putPointer = (where, value) => { view.setUint32(where, value, true); view.setUint32(where + 4, 0, true); };
  const savedRoot = entries.find((entry) => entry.root)?.root;
  if (savedRoot) system.set(savedRoot, root);
  else { view.setUint32(root + 4, 1, true); view.setUint32(root + 0x18, 1, true); }
  putPointer(root + 8, SYSTEM_ADDRESS + pageInfo); system[pageInfo + 8] = 1; system[pageInfo + 9] = 1;
  for (const [offset, table] of [[0x20, hashTable], [0x30, pointerTable]]) { putPointer(root + offset, SYSTEM_ADDRESS + table); view.setUint16(root + offset + 8, count, true); view.setUint16(root + offset + 10, count, true); }
  for (let i = 0; i < count; i++) {
    const entry = entries[i], dds = entry.dds, struct = cpu.positions[4 + i], string = cpu.positions[4 + count + i], spec = FORMATS[dds.format];
    if (entry.struct) system.set(entry.struct, struct);
    else { view.setUint32(struct + 4, 1, true); view.setUint16(struct + 0x30, 1, true); view.setUint32(struct + 0x40, 1, true); }
    const changed = !entry.struct || view.getUint16(struct + 0x50, true) !== dds.width || view.getUint16(struct + 0x52, true) !== dds.height || view.getUint32(struct + 0x58, true) !== spec.code;
    if (changed) view.setUint32(struct + 0x40, view.getUint32(struct + 0x40, true) & 31, true);
    view.setUint32(hashTable + i * 4, entry.hash, true); putPointer(pointerTable + i * 8, SYSTEM_ADDRESS + struct); putPointer(struct + 0x28, SYSTEM_ADDRESS + string); system.set(entry.string, string);
    view.setUint16(struct + 0x50, dds.width, true); view.setUint16(struct + 0x52, dds.height, true); view.setUint16(struct + 0x54, 1, true);
    view.setUint16(struct + 0x56, spec.block ? dds.width * spec.block / 16 : dds.width * spec.pixel, true); view.setUint32(struct + 0x58, spec.code, true); view.setUint8(struct + 0x5d, dds.levels);
    putPointer(struct + 0x70, GRAPHICS_ADDRESS + gpu.positions[i]); graphics.set(dds.allLevels, gpu.positions[i]);
  }
  const compressed = deflateSync(bytes, { level: 6 }), output = new Uint8Array(16 + compressed.length), header = new DataView(output.buffer);
  header.setUint32(0, FOURCC('RSC7'), true); header.setUint32(4, 13, true); header.setUint32(8, cpu.flags, true); header.setUint32(12, (gpu.flags | 0xd0000000) >>> 0, true); output.set(compressed, 16);
  const validation = openResource(output);
  if (validation.entries.length !== count || validation.entries.some((entry, i) => entry.encoded.length !== entries[i].dds.allLevels.length)) reject('La verificación del diccionario YTD generado falló.');
  return new Blob([output], { type: 'application/octet-stream' });
}
async function textureDDS(texture) {
  if (texture.blob && /\.dds$/i.test(texture.name || '')) return readBytes(texture.blob);
  const codec = canonical(texture.codec || texture.format);
  if (texture._encoded && FORMATS[codec]) return wrapDDS(codec, texture.width, texture.height, texture.levels || 1, texture._encoded);
  if (texture.sourceType === 'ytd' && !texture.rgba && !texture.blob) reject(`No se puede conservar ${texture.name}: su formato no está admitido.`);
  if (texture.sourceType === 'dds' && texture.sourceFile) return readBytes(texture.sourceFile);
  const pixels = await loadPixels(texture, { width: texture.width, height: texture.height });
  return encodeDDS(pixels, texture.width, texture.height, { format: 'BC3', mipmaps: true });
}
export async function createYtd(textures) {
  if (!Array.isArray(textures)) reject('Añade texturas para crear el YTD.');
  const inputs = [];
  for (const texture of textures) inputs.push({ ...texture, name: textureName(texture), dds: await textureDDS(texture) });
  return buildYtdFromDDS(inputs);
}
export const writeYtd = createYtd;
function escapeXML(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character])); }
export async function exportTexturePack(textures) {
  if (!textures?.length) reject('Añade texturas antes de exportar.');
  const zip = new JSZip(), files = new Set(), manifest = [], xml = [];
  for (const texture of textures) {
    const bytes = await textureDDS(texture), dds = parseDDS(bytes), name = textureName(texture), safe = downloadName(name);
    let filename = safe + '.dds', count = 2; while (files.has(filename.toLowerCase())) filename = `${safe}_${count++}.dds`;
    files.add(filename.toLowerCase()); zip.file(filename, bytes);
    manifest.push({ name, file: filename, width: dds.width, height: dds.height, format: label(dds.format), mipmaps: dds.levels, bytes: bytes.length });
    const format = { BC4: 'ATI1', BC5: 'ATI2' }[dds.format] || dds.format;
    xml.push(`  <Item>\n    <Name>${escapeXML(name)}</Name>\n    <Unk32 value="0" />\n    <Usage>DEFAULT</Usage>\n    <UsageFlags>0</UsageFlags>\n    <ExtraFlags value="0" />\n    <Width value="${dds.width}" />\n    <Height value="${dds.height}" />\n    <MipLevels value="${dds.levels}" />\n    <Format>D3DFMT_${format}</Format>\n    <FileName>${escapeXML(filename)}</FileName>\n  </Item>`);
  }
  zip.file('jara-textures.ytd.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<TextureDictionary>\n${xml.join('\n')}\n</TextureDictionary>\n`);
  zip.file('manifest.json', JSON.stringify({ generator: 'Jara Tools', schema: 1, textures: manifest }, null, 2));
  zip.file('LEEME.txt', 'Jara Tools: texturas DDS y diccionario XML.\n\nDescomprime los archivos e importa jara-textures.ytd.xml en CodeWalker para generar un YTD. Conserva siempre tus originales y verifica el recurso en FiveM. BC1 utiliza transparencia de un bit; BC3 conserva alfa gradual.\n');
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
export function disposeTexture(texture) { if (texture?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(texture.previewUrl); }
