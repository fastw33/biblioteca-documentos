'use strict';
const { z } = require('zod');
const path = require('node:path');
const { TYPES, COMPANIES } = require('./database');
const canvaUrl = z.union([z.literal(''), z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && ['canva.com', 'www.canva.com'].includes(url.hostname) &&
    !url.username && !url.password && !url.port && /^\/design\/[A-Za-z0-9_-]+(?:\/.*)?$/.test(url.pathname);
}, 'Usa un enlace HTTPS de diseño de canva.com/design/…')]);
const metadata = z.object({
  nombre: z.string().trim().min(2).max(160),
  empresa: z.enum(COMPANIES),
  tipo: z.enum(TYPES),
  descripcion: z.string().trim().max(1500).default(''),
  canvaUrl: canvaUrl.default(''),
  notaCambio: z.string().trim().max(1000).default(''),
}).strict();
// Los PATCH no aplican valores por defecto a campos omitidos.
const patchMetadata = metadata.partial().extend({
  descripcion: z.string().trim().max(1500).optional(),
  canvaUrl: canvaUrl.optional(),
  notaCambio: z.string().trim().max(1000).optional(),
  baseVersion: z.coerce.number().int().min(1).optional(),
});
const newVersion = patchMetadata.extend({ baseVersion: z.coerce.number().int().min(1) });
const listing = z.object({
  q: z.string().trim().max(160).default(''),
  empresa: z.string().trim().max(120).default(''),
  tipo: z.enum([...TYPES, '']).default(''),
  extension: z.string().regex(/^[a-z0-9]{0,12}$/).default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  orden: z.enum(['recientes', 'nombre', 'empresa']).default('recientes'),
}).strict();
const MIMES = { pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', csv: 'text/csv', txt: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  pps: 'application/vnd.ms-powerpoint', ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  rtf: 'application/rtf', md: 'text/markdown', json: 'application/json', xml: 'application/xml',
  html: 'text/html', css: 'text/css', yaml: 'application/yaml', yml: 'application/yaml',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  psd: 'image/vnd.adobe.photoshop', ai: 'application/postscript', eps: 'application/postscript',
  dwg: 'image/vnd.dwg', dxf: 'application/dxf' };
function fileInfo(file) {
  if (!file || !file.size) throw Object.assign(new Error('Selecciona un archivo con contenido.'), { status: 400 });
  // Los navegadores envían el nombre multipart en UTF-8, mientras busboy lo interpreta como latin1.
  let filename = file.originalname;
  if (/Ã|Â/.test(filename)) filename = Buffer.from(filename, 'latin1').toString('utf8');
  filename = path.win32.basename(path.posix.basename(filename)).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240);
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (!MIMES[extension]) throw Object.assign(new Error('Formato no permitido. Usa PDF, Office, OpenDocument, texto o imágenes.'), { status: 415 });
  const b = file.buffer;
  const isZip = b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const isOle = b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const valid = extension === 'pdf' ? b.subarray(0, 5).toString() === '%PDF-' :
    ['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'ppsx', 'odt', 'ods', 'odp'].includes(extension) ? isZip :
    ['doc', 'xls', 'ppt', 'pps'].includes(extension) ? isOle :
    extension === 'png' ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    ['jpg', 'jpeg'].includes(extension) ? b[0] === 255 && b[1] === 216 && b[2] === 255 :
    extension === 'webp' ? b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' :
    ['txt', 'csv', 'md', 'json', 'xml', 'html', 'css', 'yaml', 'yml', 'svg'].includes(extension) ?
      !b.includes(0) && !b.subarray(0, 2).equals(Buffer.from('MZ')) :
    !b.subarray(0, 2).equals(Buffer.from('MZ'));
  if (!valid) throw Object.assign(new Error('El contenido del archivo no corresponde a su extensión.'), { status: 415 });
  return { nombreOriginal: filename, extension, mime: MIMES[extension] };
}
module.exports = { metadata, patchMetadata, newVersion, listing, fileInfo, MIMES };
