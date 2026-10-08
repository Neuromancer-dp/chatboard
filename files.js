// Attachment handling: what can be uploaded, and pulling readable text out of
// documents so (text-only or vision) models can actually see their contents.

const fs = require('fs');
const path = require('path');

const MAX_TEXT = 300000; // chars stored per file; context trimming happens later

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const TEXT_EXT = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml', '.toml', '.ini', '.xml',
  '.py', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.go',
  '.rs', '.rb', '.php', '.swift', '.sh', '.sql', '.css', '.scss', '.lua', '.r', '.tex', '.srt',
];

function kindOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'doc';
  if (TEXT_EXT.includes(ext)) return 'text';
  return null;
}

let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

async function extractPdf(file) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  let text = '';
  try {
    for (let i = 1; i <= doc.numPages && text.length < MAX_TEXT; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((it) => (it.str || '') + (it.hasEOL ? '\n' : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (pageText) text += `${text ? '\n\n' : ''}[page ${i}]\n${pageText}`;
      page.cleanup();
    }
    return { text, pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}

async function extractDocx(file) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ path: file });
  return { text: value.replace(/\n{3,}/g, '\n\n').trim(), pages: 0 };
}

async function extractText(file, kind) {
  let result = { text: '', pages: 0 };
  if (kind === 'pdf') result = await extractPdf(file);
  else if (kind === 'doc') result = await extractDocx(file);
  else if (kind === 'text') result = { text: fs.readFileSync(file, 'utf8').replace(/\0/g, ''), pages: 0 };
  return { ...result, text: result.text.slice(0, MAX_TEXT) };
}

module.exports = { kindOf, extractText, IMAGE_EXT, TEXT_EXT };
