import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { encodeDDS, decodeDDS, buildYtdFromDDS, inspectTextureFile, createYtd, optimizeTexture } from './texture.js';

// Fixtures are assembled directly from format field positions, with no call
// to Jara's encoder. They exercise standard data rather than our own roundtrip.
function fixture(fourcc, payload, dxgi = null) {
  const bytes = new Uint8Array((dxgi == null ? 128 : 148) + payload.length);
  const view = new DataView(bytes.buffer);
  const uint = (where, value) => view.setUint32(where, value, true);
  bytes.set(new TextEncoder().encode('DDS ')); uint(4, 124); uint(8, 0x81007); uint(12, 4); uint(16, 4); uint(20, payload.length); uint(28, 1); uint(76, 32); uint(80, 4); uint(108, 0x1000);
  bytes.set(new TextEncoder().encode(dxgi == null ? fourcc : 'DX10'), 84);
  if (dxgi != null) { uint(128, dxgi); uint(132, 3); uint(140, 1); }
  bytes.set(payload, dxgi == null ? 128 : 148);
  return bytes;
}
function repack(bytes, edit) {
  const raw = new Uint8Array(inflateRawSync(bytes.subarray(16)));
  edit(raw, new DataView(raw.buffer));
  const compressed = deflateRawSync(raw), output = new Uint8Array(16 + compressed.length);
  output.set(bytes.subarray(0, 16)); output.set(compressed, 16); return output;
}
const inputFile = (bytes) => new File([bytes], 'fixture.ytd');

test('hand-authored BC1 block uses all four colors and correct RGB565 channels', () => {
  // Red 0xf800 and blue 0x001f; byte 0xe4 contains indices 0,1,2,3.
  const bytes = fixture('DXT1', Uint8Array.from([0, 248, 31, 0, 228, 228, 228, 228]));
  const pixels = decodeDDS(bytes).rgba;
  assert.deepEqual([...pixels.subarray(0, 16)], [255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255, 85, 0, 170, 255]);
});

test('hand-authored BC1 transparent mode and BC2 forced four-color mode differ', () => {
  const color = Uint8Array.from([31, 0, 0, 248, 255, 255, 255, 255]);
  assert.deepEqual([...decodeDDS(fixture('DXT1', color)).rgba.subarray(0, 4)], [0, 0, 0, 0]);
  const bc2 = new Uint8Array(16); bc2.fill(255, 0, 8); bc2.set(color, 8);
  assert.deepEqual([...decodeDDS(fixture('DXT3', bc2)).rgba.subarray(0, 4)], [170, 0, 85, 255]);
});

test('hand-authored BC3 six-alpha mode and 48-bit index boundaries decode correctly', () => {
  // alpha0=10 <= alpha1=20: table [10,20,12,14,16,18,0,255].
  const block = new Uint8Array(16); block[0] = 10; block[1] = 20; block[8] = 255; block[9] = 255; block[10] = 255; block[11] = 255;
  let indices = 0n; for (let i = 0; i < 16; i++) indices |= BigInt(i % 8) << BigInt(i * 3);
  for (let i = 0; i < 6; i++) block[2 + i] = Number((indices >> BigInt(i * 8)) & 255n);
  const alpha = [...decodeDDS(fixture('DXT5', block)).rgba].filter((_, i) => i % 4 === 3);
  assert.deepEqual(alpha, [10, 20, 12, 14, 16, 18, 0, 255, 10, 20, 12, 14, 16, 18, 0, 255]);
});

test('BC7 DX10 preserves exact encoded bytes through a native YTD', async () => {
  const payload = Uint8Array.from([64, 7, 29, 33, 41, 53, 67, 79, 83, 97, 101, 109, 127, 137, 149, 157]);
  const dds = fixture('', payload, 98);
  assert.equal(decodeDDS(dds).rgba, null);
  const ytd = await buildYtdFromDDS([{ name: 'preserved_bc7', dds }]);
  const textures = await inspectTextureFile(inputFile(ytd));
  assert.equal(textures[0].canOptimize, false); assert.deepEqual(textures[0]._encoded, payload);
  const rebuilt = await createYtd(textures);
  assert.deepEqual((await inspectTextureFile(inputFile(rebuilt)))[0]._encoded, payload);
});

test('YTD validates region, pointer width, list capacity and texture type before decode', async () => {
  const rgba = new Uint8Array(8 * 8 * 4); rgba.fill(255);
  const ytd = new Uint8Array(await (await buildYtdFromDDS([{ name: 'validation', dds: encodeDDS(rgba, 8, 8) }])).arrayBuffer());
  const cases = [
    (raw, view) => view.setUint32(0x34, 1, true),
    (raw, view) => view.setUint32(0x30, 0x60000000, true),
    (raw, view) => view.setUint16(0x3a, 0, true),
    (raw, view) => { const table = view.getUint32(0x30, true) - 0x50000000; const struct = view.getUint32(table, true) - 0x50000000; view.setUint16(struct + 0x54, 6, true); },
    (raw, view) => { const table = view.getUint32(0x30, true) - 0x50000000; const struct = view.getUint32(table, true) - 0x50000000; view.setUint32(struct + 0x70, 0x60001fff, true); },
  ];
  for (const edit of cases) await assert.rejects(inspectTextureFile(inputFile(repack(ytd, edit))), /puntero|válido|válidos|2D/);
});

test('encoder gradient compression has bounded color error', () => {
  for (const format of ['BC1', 'BC3']) {
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) rgba.set([x * 8, y * 8, (x + y) * 4, 255], (y * 32 + x) * 4);
    const decoded = decodeDDS(encodeDDS(rgba, 32, 32, { format, mipmaps: false })).rgba;
    let error = 0;
    for (let i = 0; i < rgba.length; i++) if (i % 4 !== 3) error += (rgba[i] - decoded[i]) ** 2;
    assert.ok(Math.sqrt(error / (32 * 32 * 3)) < 8, `RMSE too high for ${format}`);
  }
});

test('image-formatted texture from a YTD can be exported back to a native dictionary', async () => {
  const rgba = new Uint8Array(16 * 16 * 4); rgba.fill(255);
  const blob = await createYtd([{ name: 'image_preview.png', sourceType: 'ytd', width: 16, height: 16, rgba, format: 'PNG', codec: 'PNG', blob: new Blob(['placeholder']) }]);
  const textures = await inspectTextureFile(inputFile(blob));
  assert.equal(textures[0].name, 'image_preview'); assert.equal(textures[0].format, 'BC3');
});

test('explicit YTD size adjustment handles rectangular images while normal optimization preserves size', async () => {
  const rgba = new Uint8Array(300 * 600 * 4); rgba.fill(255);
  const source = { name: 'rectangular', width: 300, height: 600, rgba };
  const ordinary = await optimizeTexture(source, { maxSize: 1024 });
  assert.deepEqual([ordinary.width, ordinary.height], [300, 600]);
  await assert.rejects(createYtd([ordinary]), /potencias de 2/);
  const adjusted = await optimizeTexture(source, { maxSize: 1024, fitForYtd: true });
  assert.deepEqual([adjusted.width, adjusted.height], [256, 512]);
  const reopened = await inspectTextureFile(inputFile(await createYtd([adjusted])));
  assert.deepEqual([reopened[0].width, reopened[0].height], [256, 512]);
});
