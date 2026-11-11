'use strict';
const yauzl = require('yauzl');
const yazl = require('yazl');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');

const MAX_EXPANDED = 150 * 1024 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true, parseTagValue: false });
const builder = new XMLBuilder({ ignoreAttributes: false, preserveOrder: true });
const localName = name => name.split(':').pop();
const templateTypes = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/attachedTemplate',
]);
const fail = () => Object.assign(new Error('Este archivo contiene recursos que no admiten vista previa segura. Descarga el original.'), { status: 422 });

function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw fail();
  return parser.parse(xml);
}
function detachTemplate(xml, allowed) {
  const nodes = parseXml(xml);
  const root = nodes.find(node => Object.keys(node).some(key => localName(key) === 'Relationships'));
  const rootKey = root && Object.keys(root).find(key => localName(key) === 'Relationships');
  if (!rootKey || !Array.isArray(root[rootKey])) throw fail();
  let changed = false;
  root[rootKey] = root[rootKey].filter(node => {
    const key = Object.keys(node).find(key => localName(key) === 'Relationship');
    if (!key) return true;
    const attrs = node[':@'] || {};
    const mode = attrs['@_TargetMode'];
    if (mode !== undefined && !['External', 'Internal'].includes(mode)) throw fail();
    if (mode === 'External') {
      if (!allowed || !templateTypes.has(attrs['@_Type'])) throw fail();
      changed = true;
      return false; // Nunca se abre ni se descarga la plantilla externa.
    }
    if (/^(?:https?:|file:|ftp:|\\\\)/i.test(attrs['@_Target'] || '')) throw fail();
    return true;
  });
  return changed ? builder.build(nodes) : null;
}
function detachSettings(xml) {
  const nodes = parseXml(xml);
  const root = nodes.find(node => Object.keys(node).some(key => localName(key) === 'settings'));
  const key = root && Object.keys(root).find(name => localName(name) === 'settings');
  if (!key || !Array.isArray(root[key])) throw fail();
  root[key] = root[key].filter(node => !Object.keys(node).some(name => localName(name) === 'attachedTemplate'));
  return builder.build(nodes);
}
async function visitZip(bytes, visit) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(fail());
    let size = 0, settled = false;
    const names = new Set();
    const stop = () => { if (!settled) { settled = true; zip.close(); reject(fail()); } };
    zip.on('error', stop);
    zip.on('entry', entry => {
      size += entry.uncompressedSize;
      if (size > MAX_EXPANDED || names.size >= 10000 || names.has(entry.fileName) ||
          (entry.generalPurposeBitFlag & 1) || /vbaProject|embeddings\//i.test(entry.fileName)) return stop();
      names.add(entry.fileName);
      const read = () => new Promise((done, failed) => zip.openReadStream(entry, (error, stream) => {
        if (error) return failed(fail());
        let count = 0;
        const chunks = [];
        stream.on('error', failed);
        stream.on('data', chunk => {
          count += chunk.length;
          if (count > entry.uncompressedSize || count > MAX_EXPANDED) stream.destroy(fail());
          else chunks.push(chunk);
        });
        stream.on('end', () => done(Buffer.concat(chunks)));
      }));
      Promise.resolve().then(() => visit(entry, read)).then(() => { if (!settled) zip.readEntry(); }, stop);
    });
    zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
    zip.readEntry();
  }));
}
async function rewriteZip(bytes, replacements) {
  const zip = new yazl.ZipFile();
  const result = new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    zip.outputStream.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_EXPANDED) zip.outputStream.destroy(fail());
      else chunks.push(chunk);
    });
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  // Adjuntar el manejo de rechazo antes de recorrer el ZIP.
  result.catch(() => {});
  try {
    await visitZip(bytes, async (entry, read) => {
      if (entry.fileName.endsWith('/')) zip.addEmptyDirectory(entry.fileName);
      else zip.addBuffer(replacements.get(entry.fileName) || await read(), entry.fileName);
    });
    zip.end();
  } catch (error) { zip.outputStream.destroy(); throw error; }
  return result;
}

// Devuelve una copia apta para convertir; nunca modifica el original ni la copia Genika guardada.
async function validateOffice(bytes, extension) {
  if (!['docx', 'xlsx', 'pptx', 'ppsx', 'odt', 'ods', 'odp'].includes(extension)) return bytes;
  const replacements = new Map();
  let settings;
  await visitZip(bytes, async (entry, read) => {
    if (!/\.rels$|^content\.xml$|^word\/settings\.xml$/.test(entry.fileName)) return;
    if (entry.uncompressedSize > 10 * 1024 * 1024) throw fail();
    const xml = (await read()).toString('utf8');
    if (entry.fileName.endsWith('.rels')) {
      const safe = detachTemplate(xml, extension === 'docx' && entry.fileName === 'word/_rels/settings.xml.rels');
      if (safe !== null) replacements.set(entry.fileName, Buffer.from(safe));
    } else {
      parseXml(xml);
      if (/(?:xlink:href|src)\s*=\s*["'](?:https?:|file:|ftp:|\\\\)/i.test(xml)) throw fail();
      if (entry.fileName === 'word/settings.xml') settings = xml;
    }
  });
  if (!replacements.size) return bytes;
  if (!settings) throw fail();
  replacements.set('word/settings.xml', Buffer.from(detachSettings(settings)));
  return rewriteZip(bytes, replacements);
}
module.exports = { validateOffice };
