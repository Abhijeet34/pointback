// Reads colours off a browser's own screenshot, never off a canvas: Brave randomises getImageData,
// and a ratio read back that way moved by up to 0.1. Decodes the 8-bit, non-interlaced RGB and RGBA
// PNGs that Page.captureScreenshot writes, with zlib alone.
import { inflateSync } from "node:zlib";

/** The decoded image, with `pixel(x, y)` answering [r, g, b]. */
export function decodePng(buffer) {
  let offset = 8;
  const idat = [];
  let width = 0;
  let height = 0;
  let channels = 0;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      channels = { 2: 3, 6: 4 }[colour];
      if (depth !== 8 || !channels || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}`);
      }
    } else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const corner = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      const paeth = () => {
        const p = left + up - corner;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        return a <= b && a <= c ? left : b <= c ? up : corner;
      };
      const predicted = [0, left, up, (left + up) >> 1, paeth()][filter];
      pixels[y * stride + i] = (line[i] + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => [
      ...pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3),
    ],
  };
}

const linear = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** WCAG 2 contrast ratio between two sRGB pixels. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
