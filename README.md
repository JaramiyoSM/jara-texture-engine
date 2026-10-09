# Jara texture engine

Independent JavaScript texture engine by [Jaramiyo](https://jaramiyo.com/), licensed under MIT. This repository contains the texture engine only. The Jara-tools website, interface and branding are a separate private project.

Motor JavaScript independiente de texturas, creado por Jaramiyo y publicado bajo MIT. Aquí se publica solo el motor. La web, interfaz e identidad de Jara-tools forman un proyecto privado separado.

## Capabilities

- Read and write DDS BC1, BC2, BC3 and RGBA/BGRA.
- Read additional BC4/BC5 and simple Legacy pixel formats.
- Preserve BC7 encoded data as DDS DX10 without decoding or recompression.
- Read and write 2D GTA V **Legacy RSC7 v13 YTD dictionaries**.
- Optional image resizing, mipmaps and ZIP texture packs.
- Browser images and previews use canvas; raw DDS/YTD operations also run in Node.

This is an original implementation. It imports JSZip and fflate, and incorporates no gta-v-preview or CodeWalker source code. Their file-format descriptions were consulted as interoperability references.

## Usage

Install the dependencies with `npm install`, then import from `texture.js`:

```js
import {encodeDDS, decodeDDS, buildYtdFromDDS} from './texture.js';
const pixels = new Uint8Array(256 * 256 * 4).fill(255);
const dds = encodeDDS(pixels, 256, 256, {format: 'BC3', mipmaps: true});
const decoded = decodeDDS(dds);
const ytdBlob = await buildYtdFromDDS([{name: 'my_texture', dds}]);
```

Other exports: `inspectTextureFile(file)`, `optimizeTexture(texture, options)`, `createYtd(textures)`, `writeYtd`, `exportTexturePack(textures)`, `disposeTexture(texture)`, `TEXTURE_SUPPORT`.

`optimizeTexture` defaults to preserving aspect ratio. Its explicit `fitForYtd: true` option reduces each dimension to a power of two, with a minimum of 4 pixels. This can change proportions; inspect the result. The Jara-tools interface enables this option for Legacy YTD compatibility.

## Limits and validation

128 MiB input files, 256 MiB decompressed resources, 8192 pixels per side, 16 million pixels per texture and 2048 dictionary entries. New block-compressed YTD textures require sides divisible by 4; mipmaps require power-of-two dimensions. New compressed mip chains end at 4 pixels to respect Legacy stride.

Encrypted/Escrow, Enhanced/Gen9, non-2D textures and padded DDS rows are unsupported. BC7 is preserved only. This engine does not compile peds or weapon models. Keep originals, inspect exports and test them on your FiveM server; no universal in-game certification is claimed.

`npm test` runs hand-authored block fixtures, malformed-resource checks, BC7 preservation, bounded compression error and rectangular-image sizing checks. No game assets or proprietary website code are included.

## Format references

- [Microsoft DDS format](https://learn.microsoft.com/en-us/windows/win32/direct3ddds/dx-graphics-dds-pguide)
- [Microsoft block compression](https://learn.microsoft.com/en-us/windows/win32/direct3d10/d3d10-graphics-programming-guide-resources-block-compression)
- [CodeWalker texture format structures](https://github.com/dexyfex/CodeWalker/blob/master/CodeWalker.Core/GameFiles/Resources/Texture.cs)

Copyright (c) 2026 Jaramiyo. See [LICENSE](LICENSE). JSZip and fflate retain their own licenses.
