'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
const yauzl = require('yauzl');
const { identifyPdf } = require('./identification');
const run = promisify(execFile);
const fail = (status, message) => Object.assign(new Error(message), { status });
const OFFICE = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pps', 'ppsx', 'odt', 'ods', 'odp', 'rtf'];
const TEXT = ['txt', 'csv', 'md', 'json', 'xml', 'html', 'css', 'yaml', 'yml', 'svg'];
const IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic'];
function previewKind(version) {
  if (!version.archivoDisponible) return version.canvaUrl ? 'canva' : 'none';
  if (version.extension === 'pdf' || OFFICE.includes(version.extension)) return 'pdf';
  if (IMAGES.includes(version.extension)) return 'image';
  if (TEXT.includes(version.extension)) return 'text';
  if (version.mime?.startsWith('video/')) return 'video';
  if (version.mime?.startsWith('audio/')) return 'audio';
  return 'none';
}
async function readBody(object, limit) {
  if (!object.Body) throw fail(503, 'No se pudo leer el archivo.');
  const chunks = []; let bytes = 0;
  for await (const chunk of object.Body) {
    bytes += chunk.length;
    if (bytes > limit) { object.Body.destroy?.(); throw fail(413, 'Vista previa demasiado grande.'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
// No se descomprime al disco ni se permiten recursos externos, macros o ZIPs desproporcionados al convertir Office.
async function validateOffice(bytes, extension) {
  if (!['docx', 'xlsx', 'pptx', 'ppsx', 'odt', 'ods', 'odp'].includes(extension)) return;
  await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(fail(422, 'El documento Office está dañado.'));
    let size = 0, entries = 0, settled = false;
    const bad = () => { if (!settled) { settled = true; zip.close(); reject(fail(422, 'Este archivo contiene recursos que no admiten vista previa segura. Descarga el original.')); } };
    zip.on('error', bad);
    zip.on('entry', entry => {
      size += entry.uncompressedSize; entries++;
      if (size > 150 * 1024 * 1024 || entries > 10000 || (entry.generalPurposeBitFlag & 1) || /vbaProject|embeddings\//i.test(entry.fileName)) return bad();
      if (!/\.rels$|^content\.xml$/i.test(entry.fileName)) return zip.readEntry();
      if (entry.uncompressedSize > 10 * 1024 * 1024) return bad();
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError) return bad();
        const chunks = [];
        stream.on('error', bad);
        stream.on('data', data => chunks.push(data));
        stream.on('end', () => {
          if (settled) return;
          const xml = Buffer.concat(chunks).toString('utf8');
          if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']|(?:xlink:href|src)\s*=\s*["'](?:https?:|file:|ftp:|\\\\)/i.test(xml)) return bad();
          zip.readEntry();
        });
      });
    });
    zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
    zip.readEntry();
  }));
}
class PreviewService {
  constructor(config, storage) { this.config = config; this.storage = storage; this.pending = new Map(); this.running = 0; }
  async cached(key) {
    try { return await readBody(await this.storage.get(key), this.config.maxBytes * 5); }
    catch (error) { if (['NoSuchKey', 'NotFound'].includes(error.name) || error.$metadata?.httpStatusCode === 404) return null; throw error; }
  }
  async generate(key, build, mime) {
    const cached = await this.cached(key);
    if (cached) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.running >= 2) throw fail(503, 'Se están preparando otras vistas previas. Intenta de nuevo en unos segundos.');
    const job = (async () => {
      this.running++;
      try { const bytes = await build(); await this.storage.put(key, bytes, mime); return bytes; }
      finally { this.running--; this.pending.delete(key); }
    })();
    this.pending.set(key, job);
    return job;
  }
  async pdf(version) {
    if (version.extension === 'pdf') return readBody(await this.storage.get(version.identificacion?.modo === 'interna' ? version.identificacion.storageKey : version.storageKey), this.config.maxBytes * 5);
    const previewBase = version.identificacion?.codigo ? `${version.storageKey}.g-${version.identificacion.codigo}` : version.storageKey;
    return this.generate(`${previewBase}.preview.pdf`, async () => {
      const inputKey = version.identificacion?.modo === 'interna' ? version.identificacion.storageKey : version.storageKey;
      const input = await readBody(await this.storage.get(inputKey), this.config.maxBytes * 5);
      await validateOffice(input, version.extension);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genika-preview-'));
      try {
        const filename = path.join(directory, `documento.${version.extension}`);
        const profile = path.join(directory, 'profile');
        await fs.mkdir(path.join(profile, 'user'), { recursive: true });
        await fs.writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>`);
        await fs.writeFile(filename, input);
        await run(this.config.LIBREOFFICE_PATH, [`-env:UserInstallation=${pathToFileURL(profile).href}`,
          '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', directory, filename],
        { timeout: this.config.PREVIEW_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
        const output = path.join(directory, 'documento.pdf');
        if ((await fs.stat(output)).size > this.config.maxBytes * 5) throw fail(413, 'La vista previa supera el límite permitido.');
        const bytes = await fs.readFile(output);
        return version.identificacion ? await identifyPdf(bytes, version.identificacion) : bytes;
      } catch (error) {
        if (error.status) throw error;
        throw fail(error.code === 'ENOENT' ? 503 : 422, error.code === 'ENOENT' ?
          'El conversor de Office no está disponible. Puedes descargar el archivo original.' :
          'No se pudo convertir este archivo. Puedes descargar el original.');
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }, 'application/pdf');
  }
  async content(version) {
    const kind = previewKind(version);
    if (kind === 'pdf') return { bytes: await this.pdf(version), mime: 'application/pdf' };
    if (kind === 'none' || kind === 'canva') throw fail(415, 'Este formato no admite vista previa interna.');
    const bytes = await readBody(await this.storage.get(version.storageKey), this.config.maxBytes);
    if (kind === 'image') return { bytes: await sharp(bytes, { limitInputPixels: 40e6 }).rotate().resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true }).png().toBuffer(), mime: 'image/png' };
    if (kind === 'text') return { bytes: bytes.subarray(0, 256 * 1024), mime: 'text/plain; charset=utf-8' };
    return { bytes, mime: version.mime };
  }
  async thumbnail(version) {
    const kind = previewKind(version);
    if (!['image', 'pdf'].includes(kind)) throw fail(415, 'Este archivo no tiene miniatura.');
    const previewBase = version.identificacion?.codigo ? `${version.storageKey}.g-${version.identificacion.codigo}` : version.storageKey;
    const key = `${previewBase}.thumb.jpg`;
    const cached = await this.cached(key);
    if (cached) return cached;
    const pdf = kind === 'pdf' ? await this.pdf(version) : null;
    return this.generate(key, async () => {
      if (kind === 'image') return sharp(await readBody(await this.storage.get(version.storageKey), this.config.maxBytes), { limitInputPixels: 40e6 })
        .rotate().resize(640, 420, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genika-thumb-'));
      try {
        await fs.writeFile(path.join(directory, 'input.pdf'), pdf);
        await run(this.config.PDFTOPPM_PATH, ['-f', '1', '-singlefile', '-scale-to', '640', '-jpeg', path.join(directory, 'input.pdf'), path.join(directory, 'thumb')],
          { timeout: this.config.PREVIEW_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
        return await fs.readFile(path.join(directory, 'thumb.jpg'));
      } catch { throw fail(422, 'No se pudo generar la miniatura de este archivo.'); }
      finally { await fs.rm(directory, { recursive: true, force: true }); }
    }, 'image/jpeg');
  }
}
module.exports = { PreviewService, previewKind, validateOffice, readBody };
