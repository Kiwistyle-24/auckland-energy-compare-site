// Extract text lines from a PDF in the browser with the site's own copy of pdf.js (vendor/pdfjs, no CDN).
// The file is read locally; nothing is uploaded and no text is logged.
import { itemsToLines, InvoiceError } from './genesis-invoice.js';

let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = await import('../vendor/pdfjs/pdf.min.js');
    lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  }
  return lib;
}

/** ArrayBuffer of a PDF -> array of pages, each an array of text lines. */
export async function pdfPages(buffer) {
  const { getDocument } = await pdfjs();
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  } catch (e) {
    throw new InvoiceError(e?.name === 'PasswordException' ? 'This PDF is password-protected, so it cannot be read.' : 'This file could not be opened as a PDF (it may be damaged).', 'bad_pdf');
  }
  try {
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, 20); i++) pages.push(itemsToLines((await (await doc.getPage(i)).getTextContent()).items));
    return pages;
  } finally { doc.destroy(); }
}
