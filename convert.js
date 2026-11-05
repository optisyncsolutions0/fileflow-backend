// Document and archive conversions for FileFlow.
// Heavy lifting is done by LibreOffice (office formats), tools/convert_tool.py
// (PDF via pdf2docx/PyMuPDF, archives) and a few pure-JS libraries.
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mammoth from 'mammoth';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { convert as htmlToText } from 'html-to-text';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_TOOL = path.join(__dirname, 'tools', 'convert_tool.py');
const PYTHON = process.env.PYTHON || 'python3';
const SOFFICE = process.env.SOFFICE || 'soffice';
const TOOL_TIMEOUT_MS = 3 * 60 * 1000;

const WORD = ['docx', 'doc', 'odt', 'rtf'];
const TEXT = ['txt', 'md', 'html'];
const SHEET = ['xlsx', 'xls', 'ods', 'csv'];
const SLIDE = ['pptx', 'ppt', 'odp'];
const ARCHIVE = ['zip', 'tar', 'gz', 'tgz', '7z'];
const IMAGE_OUT = ['jpg', 'png'];

export const DOCUMENT_INPUTS = ['pdf', ...WORD, ...TEXT, ...SHEET, ...SLIDE];
export const ARCHIVE_INPUTS = ARCHIVE;

export class UserError extends Error {}

export function normalizeExt(ext) {
  ext = (ext || '').toLowerCase();
  if (ext === 'htm') return 'html';
  if (ext === 'jpeg') return 'jpg';
  if (ext === 'markdown') return 'md';
  return ext;
}

// Which targets each input type can be converted to.
export function allowedTargets(ext) {
  ext = normalizeExt(ext);
  let list = [];
  if (ext === 'pdf') list = ['docx', 'odt', 'rtf', 'txt', 'html', 'md', 'jpg', 'png'];
  else if (WORD.includes(ext) || TEXT.includes(ext)) list = ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'md', 'jpg', 'png'];
  else if (SHEET.includes(ext)) list = ['pdf', 'xlsx', 'csv', 'html', 'jpg', 'png'];
  else if (SLIDE.includes(ext)) list = ['pdf', 'jpg', 'png'];
  else if (ARCHIVE.includes(ext)) list = ['zip', 'tar', 'gz', '7z'];
  const same = ext === 'tgz' ? 'gz' : ext;
  return list.filter((t) => t !== same);
}

// ---------- process helpers ----------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error(`${cmd} is not installed on the server`));
      if (err.killed) return reject(new UserError('Conversion took too long. Try a smaller file.'));
      const userMsg = /USER_ERROR: (.*)/.exec(stderr || '');
      if (userMsg) return reject(new UserError(userMsg[1].trim()));
      reject(new Error(`${cmd} failed: ${(stderr || stdout || err.message).slice(-2000)}`));
    });
  });
}

const py = (...args) => run(PYTHON, [PY_TOOL, ...args]);

// LibreOffice uses a lot of memory, so run one conversion at a time.
let officeQueue = Promise.resolve();
function withOfficeLock(fn) {
  const next = officeQueue.then(fn, fn);
  officeQueue = next.catch(() => {});
  return next;
}

let officeCalls = 0;
async function office(input, filter, outExt, work, infilter) {
  return withOfficeLock(async () => {
    const id = ++officeCalls;
    const outDir = path.join(work, `office-${id}`);
    const profile = path.join(work, `lo-profile-${id}`);
    fs.mkdirSync(outDir, { recursive: true });
    const profileUrl = 'file://' + (profile.startsWith('/') ? '' : '/') + profile.replace(/\\/g, '/');
    const args = [
      '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck',
      `-env:UserInstallation=${profileUrl}`,
      ...(infilter ? [`--infilter=${infilter}`] : []),
      '--convert-to', filter, '--outdir', outDir, input,
    ];
    await run(SOFFICE, args);
    const base = path.parse(input).name;
    const out = path.join(outDir, `${base}.${outExt}`);
    if (!fs.existsSync(out)) {
      throw new UserError('This file could not be read. It may be damaged or password-protected.');
    }
    return out;
  });
}

// ---------- building blocks ----------

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function htmlPage(body, title) {
  if (/<html[\s>]/i.test(body)) return body;
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    '<style>body{font-family:sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.5}' +
    'img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>' +
    `</head><body>\n${body}\n</body></html>\n`;
}

const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '');

function writeFile(work, name, content) {
  const p = path.join(work, name);
  fs.writeFileSync(p, content);
  return p;
}

const officeInFilter = (ext) => {
  if (ext === 'html') return 'HTML (StarWriter)'; // open HTML in Writer, not Writer/Web
  if (ext === 'txt') return 'Text (encoded):UTF8';
  if (ext === 'csv') return 'CSV:44,34,76';
  return undefined;
};

// Markdown is not understood by LibreOffice, so turn it into an HTML file first.
function officeReady(input, ext, work) {
  if (ext !== 'md') return { input, ext };
  const base = path.parse(input).name;
  const dir = path.join(work, 'md-html');
  fs.mkdirSync(dir, { recursive: true });
  const html = htmlPage(marked.parse(readText(input)), base);
  return { input: writeFile(dir, `${base}.html`, html), ext: 'html' };
}

async function toPdf(input, ext, work) {
  if (ext === 'pdf') return input;
  ({ input, ext } = officeReady(input, ext, work));
  const filter = SHEET.includes(ext) ? 'pdf:calc_pdf_Export' : SLIDE.includes(ext) ? 'pdf:impress_pdf_Export' : 'pdf:writer_pdf_Export';
  return office(input, filter, 'pdf', work, officeInFilter(ext));
}

async function toDocx(input, ext, work) {
  if (ext === 'docx') return input;
  if (ext === 'pdf') {
    const out = path.join(work, `${path.parse(input).name}.docx`);
    await py('pdf2docx', input, out);
    return out;
  }
  ({ input, ext } = officeReady(input, ext, work));
  return office(input, 'docx:MS Word 2007 XML', 'docx', work, officeInFilter(ext));
}

async function toHtml(input, ext, work) {
  const title = path.parse(input).name;
  if (ext === 'html') return readText(input);
  if (ext === 'md') return htmlPage(marked.parse(readText(input)), title);
  if (ext === 'txt') {
    const paras = readText(input).split(/\r?\n\s*\r?\n/).map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`);
    return htmlPage(paras.join('\n'), title);
  }
  if (ext === 'pdf') {
    const out = path.join(work, `${title}.html`);
    await py('pdf2html', input, out);
    return readText(out);
  }
  if (SHEET.includes(ext)) {
    const out = await office(input, 'html:HTML (StarCalc)', 'html', work, officeInFilter(ext));
    return readText(out);
  }
  const docx = await toDocx(input, ext, work);
  const { value } = await mammoth.convertToHtml({ path: docx });
  return htmlPage(value, title);
}

async function toText(input, ext, work) {
  if (ext === 'txt') return readText(input);
  if (ext === 'pdf') {
    const out = path.join(work, 'text.txt');
    await py('pdf2txt', input, out);
    return readText(out);
  }
  if (WORD.includes(ext)) {
    const docx = await toDocx(input, ext, work);
    const { value } = await mammoth.extractRawText({ path: docx });
    return value;
  }
  const html = await toHtml(input, ext, work);
  return htmlToText(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] });
}

async function toMarkdown(input, ext, work) {
  if (ext === 'txt') return readText(input);
  if (ext === 'pdf') {
    const out = path.join(work, 'text.md');
    await py('pdf2md', input, out);
    return readText(out);
  }
  let html = await toHtml(input, ext, work);
  // Markdown tables need a header row and single-line cells
  html = html
    .replace(/<(td|th)([^>]*)>\s*<p>([\s\S]*?)<\/p>\s*<\/\1>/g, '<$1$2>$3</$1>')
    .replace(/(<table[^>]*>\s*(?:<tbody>)?\s*<tr>)([\s\S]*?)(<\/tr>)/g,
      (m, open, row, close) => open + row.replace(/<td/g, '<th').replace(/<\/td>/g, '</th>') + close);
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  td.use(gfm);
  td.remove(['style', 'script', 'title']);
  return td.turndown(html);
}

async function toImages(input, ext, target, work, base) {
  const pdf = await toPdf(input, ext, work);
  const dir = path.join(work, 'pages');
  fs.mkdirSync(dir, { recursive: true });
  const files = (await py('pdf2img', pdf, dir, target)).split(/\r?\n/).filter(Boolean);
  if (files.length === 1) return { path: files[0], filename: `${base}.${target}` };
  const zip = new JSZip();
  files.forEach((f) => zip.file(path.basename(f), fs.readFileSync(f)));
  const out = path.join(work, `${base}-pages.zip`);
  fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { path: out, filename: `${base}-${target}-pages.zip` };
}

// ---------- entry point ----------

/**
 * Convert `input` (with extension `ext`) to `target`.
 * Returns { path, filename } of the converted file.
 */
export async function convertFile(input, ext, target, work) {
  ext = normalizeExt(ext);
  target = normalizeExt(target);
  const base = path.parse(input).name;

  if (!allowedTargets(ext).includes(target)) {
    const from = ext ? ext.toUpperCase() : 'this file type';
    throw new UserError(`Converting ${from} to ${target.toUpperCase()} is not supported.`);
  }

  if (ARCHIVE.includes(ext)) {
    const outName = target === 'gz' ? `${base}.tar.gz` : `${base}.${target}`;
    const out = path.join(work, outName);
    await py('archive', input, ext, out, target);
    return { path: out, filename: outName };
  }

  const done = (p) => ({ path: p, filename: `${base}.${target}` });
  const text = (content) => done(writeFile(work, `${base}-out.${target}`, content));

  switch (target) {
    case 'pdf':
      return done(await toPdf(input, ext, work));
    case 'docx':
      return done(await toDocx(input, ext, work));
    case 'odt':
    case 'rtf': {
      let src = input;
      let srcExt = ext;
      if (ext === 'pdf') { src = await toDocx(input, ext, work); srcExt = 'docx'; }
      ({ input: src, ext: srcExt } = officeReady(src, srcExt, work));
      return done(await office(src, target, target, work, officeInFilter(srcExt)));
    }
    case 'html':
      return text(htmlPage(await toHtml(input, ext, work), base));
    case 'txt':
      return text(await toText(input, ext, work));
    case 'md':
      return text(await toMarkdown(input, ext, work));
    case 'xlsx':
      return done(await office(input, 'xlsx:Calc MS Excel 2007 XML', 'xlsx', work, officeInFilter(ext)));
    case 'csv':
      return done(await office(input, 'csv:Text - txt - csv (StarCalc):44,34,76,1', 'csv', work, officeInFilter(ext)));
    case 'jpg':
    case 'png':
      return toImages(input, ext, target, work, base);
    default:
      throw new UserError(`Converting to ${target.toUpperCase()} is not supported.`);
  }
}
