import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import os from 'os';
import { convertFile, allowedTargets, normalizeExt, UserError, DOCUMENT_INPUTS, ARCHIVE_INPUTS } from './convert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
}

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Never use the client's file name on disk (it could contain "../")
    const ext = getExtension(file.originalname).replace(/[^a-z0-9]/g, '').slice(0, 8);
    cb(null, `${uuidv4()}${ext ? '.' + ext : ''}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Supported formats
const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'ico', 'avif'];
const DOCUMENT_FORMATS = DOCUMENT_INPUTS;
const ARCHIVE_FORMATS = ARCHIVE_INPUTS;
// Video and audio are converted in the browser (ffmpeg.wasm), not on this server.
const VIDEO_FORMATS = ['mp4', 'webm', 'avi', 'mov', 'mkv', 'm4v', 'flv', 'wmv', 'ogv'];
const AUDIO_FORMATS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'ac3'];

// Get file extension
function getExtension(filename) {
  return path.extname(filename).slice(1).toLowerCase();
}

// Get file name without extension
function getBaseName(filename) {
  return path.basename(filename, path.extname(filename));
}

// Clean up uploaded file
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}

// API Routes

// Get supported formats
app.get('/api/formats', (req, res) => {
  res.json({
    image: IMAGE_FORMATS,
    document: DOCUMENT_FORMATS,
    archive: ARCHIVE_FORMATS,
    video: VIDEO_FORMATS,
    audio: AUDIO_FORMATS
  });
});

// Which targets a given input extension can be converted to, e.g. /api/targets?from=pdf
app.get('/api/targets', (req, res) => {
  res.json({ from: normalizeExt(req.query.from), targets: allowedTargets(req.query.from) });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Image conversion endpoint
app.post('/api/convert/image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const targetFormat = req.body.format?.toLowerCase();
    if (!targetFormat) {
      cleanupFile(req.file.path);
      return res.status(400).json({ error: 'Target format not specified' });
    }

    const inputPath = req.file.path;
    const outputFileName = `${getBaseName(req.file.originalname)}.${targetFormat}`;
    const outputPath = path.join(__dirname, 'uploads', `${uuidv4()}-${outputFileName}`);

    if (targetFormat === 'pdf') {
      // Image to PDF: one page, sized to the image
      const png = await sharp(inputPath).rotate().png().toBuffer();
      const pdfDoc = await PDFDocument.create();
      const image = await pdfDoc.embedPng(png);
      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      fs.writeFileSync(outputPath, await pdfDoc.save());
    } else if (targetFormat === 'svg') {
      // Handle SVG separately (sharp doesn't support SVG output)
      // Just copy the file if it's already SVG
      if (getExtension(req.file.originalname) === 'svg') {
        fs.copyFileSync(inputPath, outputPath);
      } else {
        cleanupFile(inputPath);
        return res.status(400).json({ error: 'Cannot convert to SVG format' });
      }
    } else if (targetFormat === 'ico') {
      // Convert to ICO using sharp
      await sharp(inputPath)
        .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toFile(outputPath.replace('.ico', '.png'));
      
      // Rename to .ico (sharp saves as png but we name it ico)
      const pngPath = outputPath.replace('.ico', '.png');
      if (fs.existsSync(pngPath)) {
        fs.renameSync(pngPath, outputPath);
      }
    } else {
      // Standard image conversion with sharp
      let sharpInstance = sharp(inputPath);
      
      // Handle format-specific options
      switch (targetFormat) {
        case 'jpg':
        case 'jpeg':
          sharpInstance = sharpInstance.jpeg({ quality: 90 });
          break;
        case 'png':
          sharpInstance = sharpInstance.png({ compressionLevel: 9 });
          break;
        case 'webp':
          sharpInstance = sharpInstance.webp({ quality: 90 });
          break;
        case 'gif':
          sharpInstance = sharpInstance.gif();
          break;
        case 'tiff':
          sharpInstance = sharpInstance.tiff({ compression: 'lzw' });
          break;
        case 'avif':
          sharpInstance = sharpInstance.avif({ quality: 80 });
          break;
        default:
          sharpInstance = sharpInstance.toFormat(targetFormat);
      }

      await sharpInstance.toFile(outputPath);
    }

    // Cleanup input file
    cleanupFile(inputPath);

    // Send the converted file
    res.download(outputPath, outputFileName, (err) => {
      cleanupFile(outputPath);
      if (err) {
        console.error('Download error:', err);
      }
    });

  } catch (error) {
    console.error('Conversion error:', error);
    if (req.file) {
      cleanupFile(req.file.path);
    }
    res.status(500).json({ error: 'Conversion failed. The image may be damaged or in an unsupported format.' });
  }
});

// Image resize endpoint
app.post('/api/convert/resize', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const width = parseInt(req.body.width) || null;
    const height = parseInt(req.body.height) || null;
    const format = req.body.format || getExtension(req.file.originalname);

    const inputPath = req.file.path;
    const outputFileName = `${getBaseName(req.file.originalname)}-resized.${format}`;
    const outputPath = path.join(__dirname, 'uploads', `${uuidv4()}-${outputFileName}`);

    let sharpInstance = sharp(inputPath).resize(width, height, {
      fit: req.body.fit || 'cover',
      position: req.body.position || 'center'
    });

    sharpInstance = sharpInstance.toFormat(format);
    await sharpInstance.toFile(outputPath);

    cleanupFile(inputPath);

    res.download(outputPath, outputFileName, (err) => {
      cleanupFile(outputPath);
      if (err) {
        console.error('Download error:', err);
      }
    });

  } catch (error) {
    console.error('Resize error:', error);
    if (req.file) {
      cleanupFile(req.file.path);
    }
    res.status(500).json({ error: 'Resize failed', details: error.message });
  }
});

// Image metadata endpoint
app.get('/api/image/info', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const metadata = await sharp(req.file.path).metadata();
    cleanupFile(req.file.path);

    res.json({
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      space: metadata.space,
      channels: metadata.channels,
      depth: metadata.depth,
      density: metadata.density,
      hasAlpha: metadata.hasAlpha,
      orientation: metadata.orientation
    });

  } catch (error) {
    console.error('Metadata error:', error);
    if (req.file) {
      cleanupFile(req.file.path);
    }
    res.status(500).json({ error: 'Failed to get metadata', details: error.message });
  }
});

// Generic file conversion endpoint (documents, spreadsheets, slides, archives)
const WORK_ROOT = path.join(os.tmpdir(), 'fileflow-jobs');
fs.mkdirSync(WORK_ROOT, { recursive: true });

function safeBaseName(filename) {
  const base = getBaseName(path.basename(filename || 'file'))
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 100);
  return base || 'file';
}

app.post('/api/convert/file', upload.single('file'), async (req, res) => {
  let work;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const targetFormat = normalizeExt(req.body.format);
    if (!targetFormat) {
      cleanupFile(req.file.path);
      return res.status(400).json({ error: 'Target format not specified' });
    }

    // .tar.gz files show up as "gz"; treat them as tgz
    let inputExt = normalizeExt(getExtension(req.file.originalname));
    if (/\.tar\.gz$/i.test(req.file.originalname)) inputExt = 'tgz';

    // Put the upload in its own folder with a clean, readable name
    work = fs.mkdtempSync(path.join(WORK_ROOT, 'job-'));
    fs.mkdirSync(path.join(work, 'in'));
    const baseName = safeBaseName(req.file.originalname.replace(/\.tar\.gz$/i, '.tgz'));
    const inputPath = path.join(work, 'in', `${baseName}.${inputExt || 'bin'}`);
    try {
      fs.renameSync(req.file.path, inputPath);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(req.file.path, inputPath);
      cleanupFile(req.file.path);
    }

    const started = Date.now();
    const result = await convertFile(inputPath, inputExt, targetFormat, work);
    console.log(`Converted ${inputExt} -> ${targetFormat} in ${Date.now() - started}ms`);

    const jobDir = work;
    work = undefined; // cleaned up after the download finishes
    res.download(result.path, result.filename, (err) => {
      fs.rm(jobDir, { recursive: true, force: true }, () => {});
      if (err) console.error('Download error:', err);
    });
  } catch (error) {
    if (req.file) cleanupFile(req.file.path);
    if (work) fs.rm(work, { recursive: true, force: true }, () => {});
    if (error instanceof UserError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed. Please try again, or contact support if it keeps happening.' });
  }
});

// Remove any job folders left behind (e.g. after a crash) once they are an hour old
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const dir of [WORK_ROOT, path.join(__dirname, 'uploads')]) {
    fs.readdir(dir, (err, names) => {
      if (err) return;
      for (const name of names) {
        if (name === '.gitkeep') continue;
        const p = path.join(dir, name);
        fs.stat(p, (e, st) => {
          if (!e && st.mtimeMs < cutoff) fs.rm(p, { recursive: true, force: true }, () => {});
        });
      }
    });
  }
}, 15 * 60 * 1000).unref();

// PDF operations
app.post('/api/pdf/info', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    const info = {
      pageCount: pdfDoc.getPageCount(),
      title: pdfDoc.getTitle(),
      author: pdfDoc.getAuthor(),
      subject: pdfDoc.getSubject(),
      keywords: pdfDoc.getKeywords(),
      creator: pdfDoc.getCreator(),
      producer: pdfDoc.getProducer(),
      creationDate: pdfDoc.getCreationDate(),
      modificationDate: pdfDoc.getModificationDate()
    };

    cleanupFile(req.file.path);
    res.json(info);

  } catch (error) {
    console.error('PDF info error:', error);
    if (req.file) {
      cleanupFile(req.file.path);
    }
    res.status(500).json({ error: 'Failed to read PDF info', details: error.message });
  }
});

// Compress image endpoint
app.post('/api/convert/compress', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const quality = parseInt(req.body.quality) || 80;
    const format = req.body.format || getExtension(req.file.originalname);

    const inputPath = req.file.path;
    const outputFileName = `${getBaseName(req.file.originalname)}-compressed.${format}`;
    const outputPath = path.join(__dirname, 'uploads', `${uuidv4()}-${outputFileName}`);

    let sharpInstance = sharp(inputPath);

    // Apply format-specific compression
    switch (format) {
      case 'jpg':
      case 'jpeg':
        sharpInstance = sharpInstance.jpeg({ quality, mozjpeg: true });
        break;
      case 'png':
        sharpInstance = sharpInstance.png({ compressionLevel: 9, adaptiveFiltering: true });
        break;
      case 'webp':
        sharpInstance = sharpInstance.webp({ quality });
        break;
      case 'avif':
        sharpInstance = sharpInstance.avif({ quality });
        break;
      default:
        sharpInstance = sharpInstance.toFormat(format, { quality });
    }

    await sharpInstance.toFile(outputPath);
    cleanupFile(inputPath);

    res.download(outputPath, outputFileName, (err) => {
      cleanupFile(outputPath);
      if (err) {
        console.error('Download error:', err);
      }
    });

  } catch (error) {
    console.error('Compression error:', error);
    if (req.file) {
      cleanupFile(req.file.path);
    }
    res.status(500).json({ error: 'Compression failed', details: error.message });
  }
});

app.get('/', (req, res) => {
  res.status(200).send('FileFlow Backend is awake and running!');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(PORT, () => {
  console.log(`File Converter server running on port ${PORT}`);
  console.log(`Supported image formats: ${IMAGE_FORMATS.join(', ')}`);
  console.log(`Supported document formats: ${DOCUMENT_FORMATS.join(', ')}`);
});

export default app;
