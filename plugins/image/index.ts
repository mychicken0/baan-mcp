// image plugin: view_image returns the ORIGINAL file bytes. No resizing, no re-encoding, no quality loss.
// If a file is bigger than maxBytes it is refused (never shrunk), so what the model gets is always the real pixels.
import { readFile, stat } from "node:fs/promises";
import type { PluginFactory } from "../../src/plugin.ts";

type Kind = { mime: string; size?: [number, number] };

/** Detect the format from the file's magic bytes and read width/height from the header. */
function sniff(b: Buffer): Kind | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: "image/png", size: [b.readUInt32BE(16), b.readUInt32BE(20)] };
  if (b.length >= 10 && b.toString("latin1", 0, 4) === "GIF8") return { mime: "image/gif", size: [b.readUInt16LE(6), b.readUInt16LE(8)] };
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const t = b.toString("latin1", 12, 16);
    if (t === "VP8 ") return { mime: "image/webp", size: [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff] };
    if (t === "VP8L") { const v = b.readUInt32LE(21); return { mime: "image/webp", size: [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1] }; }
    if (t === "VP8X") return { mime: "image/webp", size: [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1] };
    return { mime: "image/webp" };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: "image/jpeg", size: [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)] };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { mime: "image/jpeg" };
  }
  return null;
}

const plugin: PluginFactory = ({ z, options }) => {
  const maxBytes = Number(options.maxBytes ?? 20 * 1024 * 1024);
  return {
    name: "image",
    tools: [
      {
        name: "view_image",
        title: "View image",
        description:
          "Show an image file (PNG, JPEG, GIF, WebP) at its original resolution and quality. The file is sent unchanged — never resized or recompressed.",
        input: { path: z.string().describe("Image file path (absolute, ~/..., or relative to the working directory)") },
        readOnly: true,
        async run({ path }, ctx) {
          const file = ctx.resolvePath(path);
          const st = await stat(file);
          if (!st.isFile()) throw new Error(`Not a file: ${file}`);
          if (st.size > maxBytes) {
            throw new Error(
              `${file} is ${(st.size / 1048576).toFixed(1)} MB, over the image plugin limit of ${(maxBytes / 1048576).toFixed(1)} MB. ` +
              `It is not resized on purpose. Raise plugins.image.maxBytes in baan.yml, or crop the image first.`,
            );
          }
          const data = await readFile(file);
          const kind = sniff(data);
          if (!kind) throw new Error(`${file} is not a PNG, JPEG, GIF or WebP image`);
          const dims = kind.size ? `${kind.size[0]}x${kind.size[1]} px, ` : "";
          return [
            { type: "text", text: `${file} (${dims}${(data.length / 1024).toFixed(0)} KB, ${kind.mime}, original — not resized)` },
            { type: "image", data: data.toString("base64"), mimeType: kind.mime },
          ];
        },
      },
    ],
  };
};

export default plugin;
