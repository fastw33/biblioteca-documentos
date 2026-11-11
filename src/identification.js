'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { PDFDocument, PDFDict, PDFName, PDFRef } = require('pdf-lib');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const crc32 = require('buffer-crc32');
const { actor } = require('./auth');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
const xml = value => clean(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const OFFICE = ['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'ppsx'];
const INTERNAL = ['pdf', 'png', 'jpg', 'jpeg', ...OFFICE];
const NS = 'urn:genika:biblioteca:1.0';
const fail = message => Object.assign(new Error(message), { identificationReason: message });

function createIdentity(document, user, numero, originalSha256) {
  return { codigo: randomUUID(), origen: 'Genika', aplicacion: 'Biblioteca de documentos',
    documentoId: String(document._id), version: numero, empresa: document.empresa,
    nombre: document.nombre, categoria: document.tipo, subidoPor: actor(user),
    fecha: new Date(), sha256Original: originalSha256, modo: 'registro' };
}
function xmp(identity) {
  const author = `Genika | ${identity.empresa}`;
  const timestamp = new Date(identity.fecha).toISOString();
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Genika"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:genika="${NS}">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(identity.nombre)}</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>${xml(author)}</rdf:li></rdf:Seq></dc:creator>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Biblioteca Genika | ${xml(identity.empresa)} | Versión ${identity.version}</rdf:li></rdf:Alt></dc:description>
<dc:identifier>${xml(identity.codigo)}</dc:identifier><pdf:Producer>Genika</pdf:Producer><pdf:Keywords>Genika, ${xml(identity.categoria)}, ${xml(identity.empresa)}</pdf:Keywords>
<xmp:CreatorTool>Genika</xmp:CreatorTool><xmp:CreateDate>${timestamp}</xmp:CreateDate><xmp:ModifyDate>${timestamp}</xmp:ModifyDate><xmp:MetadataDate>${timestamp}</xmp:MetadataDate>
<genika:DocumentoId>${xml(identity.documentoId)}</genika:DocumentoId><genika:Version>${identity.version}</genika:Version>
<genika:Empresa>${xml(identity.empresa)}</genika:Empresa><genika:SubidoPor>${xml(identity.subidoPor.nombre)}</genika:SubidoPor>
<genika:OriginalSHA256>${xml(identity.sha256Original)}</genika:OriginalSHA256>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}
async function identifyPdf(bytes, identity) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  // Mismo tratamiento Info + XMP que Radicaciones. Se conserva el diseño y no se emite un radicado.
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : object?.dict;
    if (!(dict instanceof PDFDict)) continue;
    if (dict.has(PDFName.of('ByteRange')) || dict.get(PDFName.of('Type'))?.toString() === '/Sig')
      throw fail('firma_digital_conservada');
  }
  const oldInfo = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (oldInfo instanceof PDFDict) for (const key of oldInfo.keys()) oldInfo.delete(key);
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : object?.dict;
    if (!(dict instanceof PDFDict)) continue;
    const metadata = dict.get(PDFName.of('Metadata'));
    dict.delete(PDFName.of('Metadata'));
    if (metadata instanceof PDFRef) pdf.context.delete(metadata);
    if (dict.get(PDFName.of('Type')) === PDFName.of('Metadata')) pdf.context.delete(ref);
  }
  pdf.setTitle(identity.nombre);
  pdf.setAuthor(`Genika | ${identity.empresa}`);
  pdf.setSubject(`Biblioteca Genika | ${identity.empresa} | Versión ${identity.version}`);
  pdf.setKeywords(['Genika', identity.empresa, identity.categoria, identity.codigo]);
  pdf.setCreator('Genika'); pdf.setProducer('Genika');
  pdf.setCreationDate(new Date(identity.fecha)); pdf.setModificationDate(new Date(identity.fecha));
  const stream = pdf.context.stream(Buffer.from(xmp(identity), 'utf8'), { Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML') });
  pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(stream));
  return Buffer.from(await pdf.save({ updateFieldAppearances: false }));
}
function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  return Buffer.concat([length, name, data, crc32(Buffer.concat([name, data]))]);
}
function identifyPng(bytes, identity) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail('imagen_no_compatible');
  const chunks = [bytes.subarray(0, 8)]; let offset = 8, inserted = false, ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw fail('imagen_no_compatible');
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw fail('imagen_no_compatible');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const content = bytes.subarray(offset + 4, end - 4);
    if (!crc32(content).equals(bytes.subarray(end - 4, end))) throw fail('imagen_no_compatible');
    if (!inserted && ['IDAT', 'IEND'].includes(type)) {
      // iTXt sin compresión: conserva los datos de imagen, transparencia, perfiles y orientación.
      chunks.push(pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0'), Buffer.from(xmp(identity), 'utf8')])));
      chunks.push(pngChunk('tEXt', Buffer.from('Software\0Genika')));
      inserted = true;
    }
    if (!['tEXt', 'zTXt', 'iTXt'].includes(type)) chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !inserted || offset !== bytes.length) throw fail('imagen_no_compatible');
  return Buffer.concat(chunks);
}
function identifyJpeg(bytes, identity) {
  if (bytes[0] !== 255 || bytes[1] !== 216) throw fail('imagen_no_compatible');
  const header = Buffer.from('http://ns.adobe.com/xap/1.0/\0');
  const payload = Buffer.concat([header, Buffer.from(xmp(identity), 'utf8')]);
  if (payload.length + 2 > 65535) throw fail('metadata_imagen_fuera_de_limites');
  const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 225; marker.writeUInt16BE(payload.length + 2, 2);
  const chunks = [bytes.subarray(0, 2), marker, payload]; let offset = 2;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 255) throw fail('imagen_no_compatible');
    while (bytes[offset] === 255) offset++;
    const type = bytes[offset++];
    if (type === 218 || type === 217) { chunks.push(bytes.subarray(start)); return Buffer.concat(chunks); }
    if (type === 1 || (type >= 208 && type <= 215)) { chunks.push(bytes.subarray(start, offset)); continue; }
    if (offset + 2 > bytes.length) throw fail('imagen_no_compatible');
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) throw fail('imagen_no_compatible');
    const oldXmp = type === 225 && bytes.subarray(offset + 2, end).toString('ascii', 0, 40).startsWith('http://ns.adobe.com/');
    if (!oldXmp) chunks.push(bytes.subarray(start, end));
    offset = end;
  }
  throw fail('imagen_no_compatible');
}

async function readZip(bytes, maxBytes) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(fail('contenedor_office_no_compatible'));
    const entries = new Map(); let total = 0, settled = false;
    const stop = reason => { if (!settled) { settled = true; zip.close(); reject(fail(reason)); } };
    zip.on('error', () => stop('contenedor_office_no_compatible'));
    zip.on('entry', entry => {
      total += entry.uncompressedSize;
      if (total > Math.min(maxBytes * 5, 150 * 1024 * 1024) || entries.size >= 10000 || (entry.generalPurposeBitFlag & 1)) return stop('contenedor_office_fuera_de_limites');
      if (/^_xmlsignatures\//i.test(entry.fileName)) return stop('firma_digital_conservada');
      if (entries.has(entry.fileName)) return stop('contenedor_office_ambiguo');
      if (entry.fileName.endsWith('/')) { entries.set(entry.fileName, null); return zip.readEntry(); }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError) return stop('contenedor_office_no_compatible');
        let size = 0; const chunks = [];
        stream.on('error', () => stop('contenedor_office_no_compatible'));
        stream.on('data', chunk => { size += chunk.length; if (size > entry.uncompressedSize || size > maxBytes * 5) { stream.destroy(); stop('contenedor_office_fuera_de_limites'); } else chunks.push(chunk); });
        stream.on('end', () => { if (!settled) { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); } });
      });
    });
    zip.on('end', () => { if (!settled) { settled = true; resolve(entries); } });
    zip.readEntry();
  }));
}
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false });
const builder = new XMLBuilder({ ignoreAttributes: false, format: false, suppressEmptyNode: true });
function parseXml(bytes) {
  const value = bytes?.toString('utf8');
  if (!value || /<!DOCTYPE|<!ENTITY/i.test(value) || XMLValidator.validate(value) !== true) throw fail('propiedades_office_no_compatibles');
  return parser.parse(value);
}
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
async function identifyOffice(bytes, identity, maxBytes) {
  const entries = await readZip(bytes, maxBytes);
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(identity.nombre)}</dc:title><dc:creator>Genika | ${xml(identity.empresa)}</dc:creator><dc:subject>Biblioteca Genika | Versión ${identity.version}</dc:subject><dc:identifier>${identity.codigo}</dc:identifier><cp:lastModifiedBy>Genika</cp:lastModifiedBy><cp:keywords>Genika, ${xml(identity.empresa)}, ${xml(identity.categoria)}</cp:keywords><cp:revision>${identity.version}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${new Date(identity.fecha).toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date(identity.fecha).toISOString()}</dcterms:modified></cp:coreProperties>`;
  const app = entries.has('docProps/app.xml') ? parseXml(entries.get('docProps/app.xml')) : { Properties: { '@_xmlns': 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties' } };
  if (!app.Properties || typeof app.Properties !== 'object') throw fail('propiedades_office_no_compatibles');
  app.Properties.Application = 'Genika'; app.Properties.Company = identity.empresa;
  const custom = entries.has('docProps/custom.xml') ? parseXml(entries.get('docProps/custom.xml')) : { Properties: {
    '@_xmlns': 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties', '@_xmlns:vt': 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
  } };
  if (!custom.Properties || typeof custom.Properties !== 'object') throw fail('propiedades_office_no_compatibles');
  custom.Properties['@_xmlns:vt'] = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
  const previous = array(custom.Properties.property).filter(p => !String(p['@_name']).startsWith('Genika'));
  let pid = Math.max(1, ...previous.map(p => Number(p['@_pid']) || 1));
  const fields = { GenikaOrigen: 'Genika', GenikaDocumentoId: identity.documentoId, GenikaIdentificador: identity.codigo,
    GenikaVersion: String(identity.version), GenikaEmpresa: identity.empresa, GenikaSubidoPor: identity.subidoPor.nombre,
    GenikaFecha: new Date(identity.fecha).toISOString(), GenikaOriginalSHA256: identity.sha256Original };
  custom.Properties.property = [...previous, ...Object.entries(fields).map(([name, value]) => ({
    '@_fmtid': '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}', '@_pid': ++pid, '@_name': name, 'vt:lpwstr': clean(value),
  }))];
  const types = parseXml(entries.get('[Content_Types].xml'));
  const rels = parseXml(entries.get('_rels/.rels'));
  if (!types.Types || !rels.Relationships) throw fail('contenedor_office_no_compatible');
  const specs = [
    ['core', 'application/vnd.openxmlformats-package.core-properties+xml', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'],
    ['app', 'application/vnd.openxmlformats-officedocument.extended-properties+xml', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties'],
    ['custom', 'application/vnd.openxmlformats-officedocument.custom-properties+xml', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties'],
  ];
  let overrides = array(types.Types.Override), relationships = array(rels.Relationships.Relationship);
  for (const [part, contentType, type] of specs) {
    overrides = overrides.filter(item => item['@_PartName'] !== `/docProps/${part}.xml`);
    overrides.push({ '@_PartName': `/docProps/${part}.xml`, '@_ContentType': contentType });
    relationships = relationships.filter(item => item['@_Type'] !== type);
    const used = new Set(relationships.map(item => item['@_Id']));
    let id = `genika_${part}`; while (used.has(id)) id += '_';
    relationships.push({ '@_Id': id, '@_Type': type, '@_Target': `docProps/${part}.xml` });
  }
  types.Types.Override = overrides; rels.Relationships.Relationship = relationships;
  entries.set('docProps/core.xml', Buffer.from(core));
  entries.set('docProps/app.xml', Buffer.from(builder.build(app)));
  entries.set('docProps/custom.xml', Buffer.from(builder.build(custom)));
  entries.set('[Content_Types].xml', Buffer.from(builder.build(types)));
  entries.set('_rels/.rels', Buffer.from(builder.build(rels)));
  const zip = new yazl.ZipFile();
  const result = new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    zip.outputStream.on('data', chunk => { size += chunk.length; if (size > maxBytes * 5) { zip.outputStream.destroy(); reject(fail('archivo_identificado_fuera_de_limites')); } else chunks.push(chunk); });
    zip.outputStream.on('error', reject); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, content] of entries) if (content === null) zip.addEmptyDirectory(name); else zip.addBuffer(content, name);
  zip.end(); return result;
}
async function identifyBytes(bytes, identity, extension, maxBytes) {
  if (!INTERNAL.includes(extension)) return { bytes, identity: { ...identity, modo: 'registro', motivo: 'formato_sin_metadata_interna', sha256: digest(bytes), bytes: bytes.length } };
  try {
    const output = extension === 'pdf' ? await identifyPdf(bytes, identity) : extension === 'png' ? identifyPng(bytes, identity) :
      ['jpg', 'jpeg'].includes(extension) ? identifyJpeg(bytes, identity) : await identifyOffice(bytes, identity, maxBytes);
    if (output.length > maxBytes) throw fail('metadata_supera_limite_archivo');
    return { bytes: output, identity: { ...identity, modo: 'interna', sha256: digest(output), bytes: output.length } };
  } catch (error) {
    return { bytes, identity: { ...identity, modo: 'registro', motivo: error.identificationReason || 'metadata_interna_no_disponible', sha256: digest(bytes), bytes: bytes.length } };
  }
}
let activeWorkers = 0;
async function processIdentification(bytes, identity, extension, maxBytes) {
  if (!INTERNAL.includes(extension)) return identifyBytes(bytes, identity, extension, maxBytes);
  if (activeWorkers >= 3) throw Object.assign(new Error('Hay varios archivos identificándose. Intenta nuevamente.'), { status: 503 });
  activeWorkers++;
  return new Promise(resolve => {
    let settled = false;
    const fallback = { bytes, identity: { ...identity, modo: 'registro', motivo: 'limite_procesamiento_metadata', sha256: digest(bytes), bytes: bytes.length } };
    const worker = new Worker(path.join(__dirname, 'identification-worker.js'), {
      workerData: { bytes, identity, extension, maxBytes },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      worker.terminate().finally(() => { activeWorkers--; });
      resolve(result ? { ...result, bytes: Buffer.from(result.bytes) } : fallback);
    };
    const timer = setTimeout(() => finish(null), 30000);
    worker.once('message', finish); worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}
function publicIdentity(value) {
  if (!value) return undefined;
  const plain = value.toObject ? value.toObject() : { ...value };
  delete plain.storageKey;
  return plain;
}
function objectMetadata(identity, variant) {
  return { origen: 'Genika', documento_id: identity.documentoId, version: String(identity.version),
    identificador: identity.codigo, variante: variant, sha256_original: identity.sha256Original,
    sha256: identity.sha256 || identity.sha256Original };
}
async function persistIdentifiedFile({ config, storage, bytes, document, info, user, numero, storageKey, originalExists = false }) {
  const hash = digest(bytes);
  const identity = createIdentity(document, user, numero, hash);
  const result = await processIdentification(bytes, identity, info.extension, config.maxBytes);
  const keys = [];
  try {
    if (!originalExists) { keys.push(storageKey); await storage.put(storageKey, bytes, info.mime, objectMetadata(identity, 'original')); }
    if (result.identity.modo === 'interna') {
      const identifiedKey = `${storageKey}.genika-v${numero}-${identity.codigo}.${info.extension}`;
      keys.push(identifiedKey);
      await storage.put(identifiedKey, result.bytes, info.mime, objectMetadata(result.identity, 'genika'));
      result.identity.storageKey = identifiedKey;
    }
    return { keys, file: { ...info, storageKey, archivoDisponible: true, bytes: bytes.length, sha256: hash, identificacion: result.identity } };
  } catch (error) {
    await Promise.allSettled(keys.map(key => storage.remove(key)));
    throw error;
  }
}
module.exports = { createIdentity, identifyBytes, identifyPdf, identifyOffice, publicIdentity, objectMetadata, persistIdentifiedFile, digest, readZip, xmp };
