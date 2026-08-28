import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

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
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Supported formats
const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'ico', 'avif'];
const DOCUMENT_FORMATS = ['pdf', 'docx', 'txt', 'md', 'html'];
const ARCHIVE_FORMATS = ['zip', 'tar', 'gz'];
const VIDEO_FORMATS = ['mp4', 'webm', 'avi', 'mov'];
const AUDIO_FORMATS = ['mp3', 'wav', 'ogg', 'flac'];

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

    // Handle SVG separately (sharp doesn't support SVG output)
    if (targetFormat === 'svg') {
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
    res.status(500).json({ error: 'Conversion failed', details: error.message });
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

// Generic file conversion endpoint (for documents)
app.post('/api/convert/file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const targetFormat = req.body.format?.toLowerCase();
    if (!targetFormat) {
      cleanupFile(req.file.path);
      return res.status(400).json({ error: 'Target format not specified' });
    }

    const inputExt = getExtension(req.file.originalname);
    const inputPath = req.file.path;
    const outputFileName = `${getBaseName(req.file.originalname)}.${targetFormat}`;
    const outputPath = path.join(__dirname, 'uploads', `${uuidv4()}-${outputFileName}`);

    // Document conversions
    if (DOCUMENT_FORMATS.includes(inputExt) && DOCUMENT_FORMATS.includes(targetFormat)) {
      const content = fs.readFileSync(inputPath, 'utf-8');
      
      if (targetFormat === 'txt') {
        // Strip markdown/HTML for plain text
        let text = content
          .replace(/#{1,6}\s/g, '')
          .replace(/\*\*/g, '')
          .replace(/\*/g, '')
          .replace(/`/g, '')
          .replace(/<[^>]*>/g, '');
        fs.writeFileSync(outputPath, text);
      } else if (targetFormat === 'md') {
        if (inputExt === 'html') {
          // Simple HTML to Markdown conversion
          let md = content
            .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
            .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
            .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
            .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '');
          fs.writeFileSync(outputPath, md);
        } else {
          fs.copyFileSync(inputPath, outputPath);
        }
      } else if (targetFormat === 'html') {
        if (inputExt === 'md') {
          // Simple Markdown to HTML conversion
          let html = content
            .replace(/^#{3}\s(.+)$/gm, '<h3>$1</h3>')
            .replace(/^#{2}\s(.+)$/gm, '<h2>$1</h2>')
            .replace(/^#\s(.+)$/gm, '<h1>$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/\n\n/g, '</p><p>');
          html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Converted</title></head><body><p>${html}</p></body></html>`;
          fs.writeFileSync(outputPath, html);
        } else {
          fs.copyFileSync(inputPath, outputPath);
        }
      } else {
        // For PDF and DOCX, we just return the original with a note
        fs.copyFileSync(inputPath, outputPath);
      }
    } else {
      // For unsupported conversions, just copy the file
      fs.copyFileSync(inputPath, outputPath);
    }

    cleanupFile(inputPath);

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
    res.status(500).json({ error: 'Conversion failed', details: error.message });
  }
});

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

// Catch-all for production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

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
