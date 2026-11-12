// "Compress" tool for FileFlow: make any file smaller.
// Images: sharp. PDF: Ghostscript (PyMuPDF clean-up as a fallback).
// Word/Excel/PowerPoint: shrink the pictures inside. Archives: repack at
// maximum compression. Anything else: packed into a .zip.
// Video and audio are compressed in the browser (ffmpeg.wasm), not here.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import sharp from 'sharp';
import JSZip from 'jszip';
import { run, py, office, UserError, normalizeExt } from './convert.js';

const GS = process.env.GHOSTSCRIPT || 'gs';
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

export const LEVELS = {
  light: { quality: 85, box: 0, officeBox: 0, pdf: '/printer', gifColours: 256, lossless: true },
  balanced: { quality: 72, box: 2560, officeBox: 2000, pdf: '/ebook', gifColours: 128, lossless: false },
  strong: { quality: 55, box: 1600, officeBox: 1280, pdf: '/screen', gifColours: 64, lossless: false },
};

const SHARP_IMAGES = ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff'];
const OFFICE_ZIP = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];
const OFFICE_OLD = {
  doc: ['docx', 'docx:MS Word 2007 XML', 'Word'],
  rtf: ['docx', 'docx:MS Word 2007 XML', 'Word'],
  xls: ['xlsx', 'xlsx:Calc MS Excel 2007 XML', 'Excel'],
  ppt: ['pptx', 'pptx:Impress MS PowerPoint 2007 XML', 'PowerPoint'],
};
export const MEDIA_FORMATS = [
  'mp4', 'webm', 'avi', 'mov', 'mkv', 'm4v', 'flv', 'wmv', 'ogv',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'ac3',
];

// ---------- images ----------

async function compressImage(input, ext, L, work, base, qualityOverride) {
  const q = qualityOverride || L.quality;
  const meta = await sharp(input).metadata().catch(() => {
    throw new UserError('This image is damaged or not a real image file.');
  });
  const animated = (meta.pages || 1) > 1 && (ext === 'gif' || ext === 'webp');
  let img = sharp(input, { animated, limitInputPixels: 268402689 });
  if (!animated) img = img.rotate(); // apply phone-camera orientation before metadata is removed
  if (L.box && !qualityOverride) {
    img = img.resize({ width: L.box, height: L.box, fit: 'inside', withoutEnlargement: true });
  }
  let outExt = ext;
  let note = '';
  switch (ext) {
    case 'jpg':
      img = img.jpeg({ quality: q, mozjpeg: true });
      break;
    case 'png':
      img = L.lossless || qualityOverride
        ? img.png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 })
        : img.png({ palette: true, quality: q, compressionLevel: 9, effort: 10 });
      break;
    case 'webp':
      img = img.webp({ quality: q, effort: 6 });
      break;
    case 'avif':
      img = img.avif({ quality: Math.max(30, q - 25), effort: 6 });
      break;
    case 'gif':
      img = img.gif({ colours: L.gifColours, effort: 10 });
      break;
    case 'tiff':
      img = L.lossless || meta.hasAlpha
        ? img.tiff({ compression: 'deflate', predictor: 'horizontal' })
        : img.tiff({ compression: 'jpeg', quality: q });
      break;
    default:
      throw new UserError(`${ext.toUpperCase()} images cannot be compressed.`);
  }
  const out = path.join(work, `${base}-compressed.${outExt}`);
  await img.toFile(out);
  return { path: out, filename: `${base}-compressed.${outExt}`, note };
}

// sharp cannot read BMP, so Pillow turns it into a (lossless, much smaller) PNG
async function compressBmp(input, work, base) {
  const filename = `${base}-compressed.png`;
  const out = path.join(work, filename);
  await py('bmp2png', input, out);
  return { path: out, filename, note: 'Saved as PNG: the same picture in a much smaller format.' };
}

// ---------- PDF ----------

async function compressPdf(input, L, work, base) {
  const out = path.join(work, `${base}-compressed.pdf`);
  try {
    await run(GS, [
      '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-dPDFSETTINGS=${L.pdf}`,
      '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dSAFER',
      '-dDetectDuplicateImages=true', '-dCompressFonts=true',
      `-sOutputFile=${out}`, input,
    ]);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('Ghostscript produced no output');
  } catch (error) {
    if (error instanceof UserError) throw error;
    console.warn('Ghostscript failed, falling back to PyMuPDF:', error.message.slice(0, 300));
    await py('pdfopt', input, out); // raises a clear message for damaged / password-protected PDFs
  }
  return { path: out, filename: `${base}-compressed.pdf`, note: '' };
}

// ---------- Word / Excel / PowerPoint ----------

async function shrinkOfficeZip(input, L, outPath) {
  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(input));
  } catch {
    throw new UserError('This file could not be read. It may be damaged or password-protected.');
  }
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const m = /\.(jpe?g|png)$/i.exec(name);
    if (!m || !/(^|\/)(media|Pictures)\//.test(name)) continue;
    const original = await entry.async('nodebuffer');
    try {
      let img = sharp(original).withMetadata(); // keep orientation so pictures do not turn
      if (L.officeBox) img = img.resize({ width: L.officeBox, height: L.officeBox, fit: 'inside', withoutEnlargement: true });
      const smaller = await (/png$/i.test(m[1])
        ? img.png(L.lossless ? { compressionLevel: 9, effort: 10 } : { palette: true, quality: L.quality + 10, compressionLevel: 9, effort: 10 })
        : img.jpeg({ quality: L.quality, mozjpeg: true })
      ).toBuffer();
      if (smaller.length < original.length) zip.file(name, smaller, { createFolders: false });
    } catch {
      // leave pictures we cannot read untouched
    }
  }
  // OpenDocument files need "mimetype" stored uncompressed (it is already the first entry)
  if (zip.files.mimetype) zip.file('mimetype', await zip.files.mimetype.async('nodebuffer'), { compression: 'STORE', createFolders: false });
  fs.writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
}

async function compressOffice(input, ext, L, work, base) {
  let src = input;
  let outExt = ext;
  let note = '';
  if (OFFICE_OLD[ext]) {
    const [modern, filter, app] = OFFICE_OLD[ext];
    src = await office(input, filter, modern, work);
    outExt = modern;
    note = `Saved as ${modern.toUpperCase()}, the newer ${app} format, which is much smaller and opens in the same apps.`;
  }
  const filename = `${base}-compressed.${outExt}`;
  const out = path.join(work, filename);
  await shrinkOfficeZip(src, L, out);
  return { path: out, filename, note };
}

// ---------- archives ----------

function sizeGuard() {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > MAX_UNPACKED_BYTES) return cb(new UserError('This archive is too large to compress (over 2 GB unpacked).'));
      cb(null, chunk);
    },
  });
}

async function regzip(input, out, gunzipFirst) {
  try {
    await pipeline(
      fs.createReadStream(input),
      ...(gunzipFirst ? [zlib.createGunzip(), sizeGuard()] : []),
      zlib.createGzip({ level: 9 }),
      fs.createWriteStream(out),
    );
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('This archive is damaged and could not be compressed.');
  }
}

async function compressArchive(input, ext, work, base) {
  if (ext === 'zip' || ext === '7z') {
    const filename = `${base}-compressed.${ext}`;
    const out = path.join(work, filename);
    await py('archive', input, ext, out, ext, 'best');
    return { path: out, filename, note: '' };
  }
  // tar -> tar.gz; gz / tgz -> recompressed at the highest gzip level
  const filename = ext === 'gz' ? `${base.replace(/(\.[^.]+)?$/, '-compressed$1')}.gz` : `${base}-compressed.tar.gz`;
  const out = path.join(work, filename);
  await regzip(input, out, ext !== 'tar');
  const note = ext === 'tar' ? 'Saved as .tar.gz (a compressed TAR file).' : '';
  return { path: out, filename, note };
}

// ---------- everything else ----------

async function zipFile(input, ext, work, base) {
  const filename = `${base}${ext ? '.' + ext : ''}.zip`;
  const out = path.join(work, filename);
  await py('zipone', input, out, `${base}${ext ? '.' + ext : ''}`);
  return {
    path: out,
    filename,
    note: 'Packed into a .zip file. Unzip it to get your original file back, unchanged.',
  };
}

/**
 * Make `input` smaller. Returns { path, filename, note }.
 * `level` is light | balanced | strong. `qualityOverride` keeps the old
 * image Quick Tools slider working.
 */
export async function compressFile(input, ext, level, work, { qualityOverride } = {}) {
  ext = normalizeExt(ext);
  const L = LEVELS[level] || LEVELS.balanced;
  const base = path.parse(input).name;
  if (MEDIA_FORMATS.includes(ext)) {
    throw new UserError('Video and audio are compressed in your browser. Reload the page and try again.');
  }
  if (SHARP_IMAGES.includes(ext)) return compressImage(input, ext, L, work, base, qualityOverride);
  if (ext === 'bmp') return compressBmp(input, work, base);
  if (ext === 'pdf') return compressPdf(input, L, work, base);
  if (OFFICE_ZIP.includes(ext) || OFFICE_OLD[ext]) return compressOffice(input, ext, L, work, base);
  if (['zip', '7z', 'tar', 'gz', 'tgz'].includes(ext)) return compressArchive(input, ext, work, base);
  return zipFile(input, ext, work, base);
}
