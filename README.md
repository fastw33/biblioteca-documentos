# Repositorio de documentos Genika — API

Servicio independiente en Node.js, Express y **Mongoose** (el ODM usado en los otros servicios Mongo de Genika). Centraliza brochures, formatos, ofertas, presentaciones y manuales. FrontWms incluye la pantalla **Documentos**, inmediatamente encima de Radicaciones, en `/biblioteca-documentos`.

La configuración local reutiliza únicamente la conexión al servidor y las credenciales existentes:

| Recurso | Destino exclusivo de esta API |
| --- | --- |
| MongoDB | Base `repositorio_documentos`, colecciones `documentos` y `documentos_auditoria` |
| S3 / MinIO | Bucket `genika-repositorio-documentos`, prefijo `documentos/` |
| Autenticación | JWT HS256 emitido por WMS, con el mismo `JWT_SECRET` |
| URL local | `http://127.0.0.1:3016/api/documentos` |

`dbName` selecciona expresamente la base nueva aunque la URI de conexión contenga el nombre de una base anterior. Todos los modelos pertenecen a esa conexión y todas las operaciones de archivos, incluidas las miniaturas y conversiones, especifican el bucket propio. No se escriben datos en las bases o buckets de Leads, WMS o Radicaciones. No se crean usuarios ni se cambian permisos de WMS.

## Inicio local

Requiere Node 24, Mongo disponible y S3/MinIO activo. Ya se generó `.env` para este equipo; está excluido de Git y Docker.

```powershell
npm install
# Solo para una configuración nueva; nunca sobreescribe un .env existente:
npm run config:genika
# Crea índices y crea el bucket si no existe:
npm run setup
npm start
```

`config:genika` lee por defecto los `.env` de `../Sistemas Genika/Sistema de Leads/backend` y `../Sistemas Genika/wmsBack`. Se pueden indicar rutas con `--source` y `--identity`, y un nombre de bucket nuevo con `--bucket`. No imprime secretos ni modifica los proyectos de origen. Para otro entorno, partir de `.env.example` y configurar los destinos propios de esta API.

`setup` únicamente provisiona la base seleccionada y el bucket configurado. Si el bucket ya existe, solo comprueba acceso; no altera su política. Los buckets nuevos de MinIO no tienen política pública y en AWS se activa Block Public Access. Las descargas pasan por la API autenticada.

## Autenticación y permisos

Todas las rutas `/api/documentos` requieren `Authorization: Bearer <JWT de WMS>`, también catálogos, estadísticas y descargas. Se comprueban la firma HS256, expiración, identidad `id_usuario` y cambio obligatorio de contraseña. No existe un login adicional, tokens en la URL ni acceso con `x-internal-service-key`.

Los usuarios autenticados pueden listar, consultar, descargar, revisar historial/auditoría y subir documentos. **Solo el autor o `permisos.esAdmin` puede modificar sus metadatos o agregar versiones.** El autor se obtiene del JWT, nunca de datos enviados por el cliente. La expiración sigue siendo la del JWT emitido por WMS; la API no revoca sesiones por su cuenta ni consulta el estado actual del usuario en la base de WMS.

## Documentos y Canva

Cada registro requiere `nombre`, `empresa` y `tipo`. Se admiten `descripcion` y `canvaUrl` opcionales.

- `tipo`: `brochure`, `formato`, `oferta`, `presentacion`, `manual`, `otro`.
- Archivos: PDF, Office (incluidos DOCM/XLSM/PPTM y PPS/PPSX), OpenDocument, RTF, texto y datos, imágenes, audio, video, ZIP/RAR/7Z, PSD/AI/EPS y DWG/DXF. La lista exacta se obtiene en `/catalogos` mediante `extensionesPermitidas`.
- Máximo local: **30 MB**, configurable con `MAX_FILE_MB`.
- Un archivo por petición; nombre y tipo MIME se normalizan y se comprueba la firma básica de los principales formatos. Esta validación no sustituye un análisis antivirus.
- El nombre original se conserva para descargar; el objeto S3 recibe una clave aleatoria para evitar sobrescrituras.
- No hay deduplicación: los documentos con el mismo nombre son registros independientes.

Se puede guardar **archivo + enlace de Canva** o **solo el enlace**. `canvaUrl` acepta HTTPS de `canva.com/design/…` y `www.canva.com/design/…`. Para diseños sin archivo se devuelve `archivoDisponible: false`, `extension: "canva"` y `bytes: 0`; no se escribe ningún objeto en S3. La descarga de un diseño sin archivo responde `409`.

Guardar un enlace no concede permisos ni genera un enlace de edición: debe pegarse el enlace compartido apropiado de Canva. La edición continúa en Canva según sus permisos. La API no exporta, sincroniza ni usa las credenciales de Canva. Los enlaces compartidos pueden dar acceso al diseño a quienes los reciban.

**Un enlace no congela el contenido de Canva.** La galería puede mostrar el diseño incrustado si sus permisos permiten visualizarlo. Para publicar una nueva versión solo por enlace, duplicar el diseño en Canva y usar el nuevo ID, o cargar una exportación PDF como archivo. La API rechaza una nueva versión sin archivo cuando se reutiliza el mismo ID de diseño, aunque cambien los parámetros del enlace. El archivo exportado sí queda conservado de manera independiente en cada versión. Las acciones realizadas dentro de Canva, incluidas sus propias exportaciones, no las audita esta API; se registra la apertura mediante su botón.

## Versiones y auditoría

La versión inicial es `1`. `POST /:id/versiones` agrega una nueva versión, siempre con `baseVersion` igual a la versión vigente y un archivo o un nuevo enlace de Canva. Los campos de nombre, empresa, categoría y descripción pueden omitirse para conservar sus valores. `notaCambio` permite explicar la modificación. El formulario de FrontWms la solicita al editar o versionar.

Cada versión se guarda dentro de `documentos.versiones`, con número, fecha, usuario (ID y nombre), nota, metadatos y referencia a su archivo original. `versionActual` y los campos superiores representan solo la última versión. El listado principal no incluye el historial, por lo que un documento aparece una sola vez. Los documentos anteriores a esta actualización conservan su contenido como versión 1 al recibir la primera actualización.

Los archivos de versiones publicadas nunca se borran ni se sobrescriben al subir otra versión. `PATCH` también crea una versión de los datos sin duplicar ni modificar el archivo anterior. Se puede enviar `baseVersion` en PATCH para detectar un formulario desactualizado; FrontWms lo hace. El cambio del historial y la versión actual es una única operación atómica en Mongo, sin exigir replica set. Si hay una carga concurrente, se responde `409` y solo se limpia el objeto que no alcanzó a publicarse.

`GET /:id/descarga?version=N` descarga una versión concreta; omitir `version` descarga la vigente. Por defecto entrega la copia identificada como Genika cuando existe. Antes de entregar bytes se guarda una entrada en `documentos_auditoria`: persona, fecha, versión, variante (`genika` u `original`), archivo, IP, user agent y request ID. El resultado evoluciona de `iniciada` a `completada` o `interrumpida` según la transferencia del servidor; no confirma que el usuario guardara el archivo en su disco. Si no puede escribirse la auditoría inicial, no se entrega el archivo. Las vistas previas y miniaturas **no** crean descargas ficticias. Las fechas de la interfaz usan `America/Bogota`.

## Identificación y metadata Genika

Cada nueva carga y versión recibe un identificador propio, empresa, fecha, persona que la subió y hashes SHA-256. La propiedad `identificacion` distingue:

| Modo | Comportamiento |
| --- | --- |
| `interna` | PDF, DOCX/XLSX/PPTX, DOCM/XLSM/PPTM/PPSX y PNG/JPG/JPEG válidos: se conserva el original y se crea una copia con metadata Genika, que es la descarga predeterminada. |
| `registro` | Formatos sin escritor interno, documentos firmados o archivos no procesables: se conserva y entrega el archivo exacto. La procedencia se registra en Mongo y en metadata de los objetos S3; el motivo se informa en la identificación. |
| `enlace` | Referencia Canva registrada en Genika. No modifica el diseño remoto ni sus propiedades. |

Los PDF usan el mismo criterio de Radicaciones: sustitución de Info y XMP, autor `Genika | Empresa`, creador/productor `Genika`, nombre del recurso, ID y versión. Se mantienen páginas y campos de formulario. Los Office modernos actualizan propiedades estándar y agregan propiedades `Genika*`, conservando contenido y propiedades personalizadas del formato. Las imágenes PNG/JPEG reciben XMP sin recodificar sus píxeles; se conservan orientación y perfiles. No se garantiza eliminar otros grupos de metadata EXIF de las imágenes.

El original nunca se sobrescribe. Las copias identificadas tienen claves nuevas en **el bucket de esta API**; cada versión conserva su copia y su hash. `?original=true` permite al autor o administrador descargar el original de conservación, y esa descarga también se audita. Un cambio de nombre/empresa/categoría genera una nueva versión y una nueva copia identificada desde el mismo original. La ficha de FrontWms muestra el estado, referencia y acceso al original para quienes tienen permiso. Las versiones anteriores a esta función no se reescriben en segundo plano.

No se llama a las rutas de emisión de Radicaciones: no se generan consecutivos, marcas gráficas ni registros en su base o bucket. La identificación de biblioteca no es una firma digital. Para comprobar un archivo, `POST /api/documentos/verificar` recibe un multipart con `archivo`, calcula SHA-256 y busca coincidencias exactas con originales o copias Genika de las versiones guardadas. La metadata por sí sola es editable; la comparación del hash detecta un archivo diferente. Esta consulta requiere JWT, no escribe documentos ni objetos y devuelve como máximo coincidencias de 25 documentos, indicando si cada versión es la vigente.

`GET /:id/identificacion?version=N` devuelve la identificación sin claves privadas de almacenamiento. La descarga devuelve además `X-Genika-Identificacion` y `X-Genika-Metadata`. El procesamiento PDF/Office/imágenes se ejecuta en workers aislados, con límite de memoria, 30 segundos y tres tareas simultáneas; si no puede aplicar metadata informa `modo: registro` y conserva el archivo. Las copias de Office convertidas a PDF para vista previa también se identifican como Genika.

## Vistas previas

- Galería de miniaturas para imágenes, PDF y documentos Office convertibles.
- Visor PDF paginado para PDF, Word, Excel, PowerPoint y OpenDocument sin macros.
- Imágenes normalizadas para visualización, texto seguro (primeros 256 KB) y reproductores de audio/video según los códecs del navegador.
- Canva incrustado según sus permisos, con botón de apertura externa auditada.
- Los formatos sin visor interno, archivos con macros, archivos cifrados o dañados conservan su descarga original y muestran una ficha de formato.

La conversión Office se hace localmente con LibreOffice, sin enviar archivos a servicios externos. Las miniaturas PDF usan Poppler (`pdftoppm`). Las vistas generadas se almacenan con sufijos `.preview.pdf` y `.thumb.jpg` en el **mismo bucket de esta API**, sin alterar el original. Las peticiones del visor están autenticadas y no exponen claves S3. Hay un máximo de dos generaciones simultáneas; los clientes pueden reintentar un `503` por ocupación.

Los DOCX creados desde una plantilla de Word pueden conservar una referencia a un `.dotx` externo. Para la vista previa se desvincula esa plantilla únicamente en una copia temporal, usando el contenido, estilos e imágenes incluidos en el DOCX. El archivo original, la copia Genika descargable y sus versiones se conservan. Los demás recursos externos, macros y objetos incrustados siguen bloqueados para conversión.

Configurar `LIBREOFFICE_PATH`, `PDFTOPPM_PATH` y `PREVIEW_TIMEOUT_MS` si los ejecutables no están en PATH. En este equipo LibreOffice se extrajo dentro de `.runtime/libreoffice` y se configuró su ruta en `.env`, sin modificar otros proyectos ni la instalación de Office. El `Dockerfile` incluye LibreOffice, Poppler y fuentes para producción.

## Rutas

| Método | Ruta | Función |
| --- | --- | --- |
| GET | `/health` | Estado del proceso, sin datos sensibles; pública |
| GET | `/api/documentos/ready` | Comprueba Mongo y el bucket; protegida |
| POST | `/api/documentos` | Archivo multipart o registro JSON solo de Canva |
| GET | `/api/documentos` | Lista paginada y filtros |
| GET | `/api/documentos/catalogos` | Empresas existentes, categorías, extensiones y límite de carga |
| GET | `/api/documentos/resumen` | Cantidad de documentos, empresas, bytes y categorías |
| GET | `/api/documentos/:id` | Consulta metadatos |
| GET | `/api/documentos/:id/versiones` | Historial completo, fechas, usuarios y notas |
| POST | `/api/documentos/:id/versiones` | Publica otra versión sin borrar las anteriores |
| GET | `/api/documentos/:id/descarga?version=N` | Descarga auditada de la copia Genika o archivo conservado |
| GET | `/api/documentos/:id/descarga?version=N&original=true` | Original de conservación, solo autor/administrador |
| GET | `/api/documentos/:id/identificacion?version=N` | Estado y referencia Genika de una versión |
| POST | `/api/documentos/verificar` | Compara SHA-256 del archivo con originales y versiones Genika |
| GET | `/api/documentos/:id/vista-previa?version=N` | Vista previa protegida de una versión |
| GET | `/api/documentos/:id/miniatura?version=N` | Miniatura JPG protegida |
| GET | `/api/documentos/:id/auditoria?page=1&limit=20` | Actividad paginada de descargas y Canva |
| POST | `/api/documentos/:id/canva` | Registra apertura y devuelve enlace; body `{ "version": N }` |
| PATCH | `/api/documentos/:id` | Versiona cambios de nombre, empresa, categoría, descripción o Canva |

No hay endpoint de borrado. Los PATCH no modifican el autor ni el archivo original; tampoco permiten quitar el único enlace de un registro sin archivo. Una versión nueva solo de Canva deja su archivo previo accesible en el historial, sin presentar esa exportación anterior como contenido del nuevo diseño.

Filtros de listado: `q` (nombre, empresa, descripción y nombre original), `empresa`, `tipo`, `extension`, `page` (desde 1), `limit` (1–100, por defecto 24), `orden` (`recientes`, `nombre` o `empresa`). El orden por empresa usa empresa y nombre A–Z con comparación española y orden numérico natural antes de paginar. Empresa y categoría usan coincidencia exacta; la búsqueda de texto ignora mayúsculas y trata los caracteres como texto literal.

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "limit": 24,
  "pages": 0
}
```

Los registros incluyen `_id`, metadatos, `archivoDisponible`, `versionActual`, `subidoPor`, `fechaCambio`, `vistaPrevia`, `identificacion`, información del autor original y `puedeEditar`. `bytes` y `sha256` describen el original; `identificacion.bytes` y `identificacion.sha256` describen la descarga identificada o conservada. El historial devuelve `numero`, `fecha`, `subidoPor` y `notaCambio` para cada versión. Nunca se incluyen `storageKey`, credenciales ni URL pública de S3. Los errores devuelven `message` y, cuando aplica, `errors` por campo y `requestId`.

Estados: `400` datos incorrectos, `401` sesión inválida, `403` sin permiso, `404` no encontrado, `409` sin archivo descargable, `413` tamaño excedido, `415` formato incorrecto, `429` demasiadas solicitudes y `503` servicio no disponible. Límites: 180 solicitudes/minuto/IP, 15 cargas/minuto/IP y 3 cargas simultáneas por proceso.

Ejemplos listos para un cliente REST en [docs/solicitudes.http](docs/solicitudes.http). Para integrar FrontWms después, enviar el token de su sesión como Bearer y descargar con `fetch`/Axios autenticado; no colocar el token en enlaces.

## Verificación

```powershell
npm run check
npm test
# Opcional, con Mongo y MinIO reales activos:
npm run test:live
```

`npm test` usa Mongo temporal **en un proceso aislado**, con base llamada `repositorio_documentos`, y almacenamiento simulado. No toca Mongo ni MinIO operativos. Cubre autorización, validación, búsqueda, permisos, Canva, descarga, auditoría, versiones concurrentes, conservación de originales, limpieza por fallo y aislamiento del bucket.

`test:live` usa exclusivamente los nombres de base y bucket indicados arriba; genera un actor aleatorio, sube un TXT, lo descarga, verifica acceso anónimo bloqueado en MinIO y elimina únicamente sus propios registros y objetos temporales. No modifica documentos de otros usuarios.

QA de Office: `scripts/generate-preview-fixtures.py` crea archivos de prueba (requiere python-docx, python-pptx y openpyxl). Después, `node --env-file=.env scripts/preview-check.js` verifica Word, PowerPoint y Excel contra Mongo/MinIO reales y limpia únicamente sus registros y archivos temporales. QA de la interfaz: ejecutar `npm run test:documentos` desde FrontWms con Vite activo. Usa Mongo temporal y almacenamiento simulado, y guarda capturas locales en `FrontWms/.runtime/documentos`.

## FrontWms

En desarrollo, Vite envía `/documentos-api` a `http://127.0.0.1:3016`; la ruta funciona con la sesión de WMS. El menú **Biblioteca** está encima de Radicaciones, dentro del layout protegido. Ofrece búsqueda, categorías, filtros, vista previa, identificación Genika, descargas, historial, auditoría, carga inicial y publicación de versiones.

La vista se agrupa por empresa de manera predeterminada. Se puede cambiar a última actualización o nombre desde el selector de orden. Cuando hay varias páginas, los encabezados de empresa indican cuántos documentos de esa empresa aparecen en la página actual. Tarjetas, filtros, formularios y visor se adaptan a móvil, tablet y escritorio.

Para producción definir **antes de compilar** `VITE_DOCUMENTOS_API_URL=https://<dominio-real>/api/documentos` y permitir el origen de FrontWms en `CORS_ORIGINS` de esta API. Esta variable es pública y no debe contener secretos. El proxy de desarrollo no se incluye en los archivos compilados.

## Despliegue

La configuración de **Railpack + Node 24** está en `railpack.json`, e incluye LibreOffice, Poppler y fuentes en la imagen final. El `Dockerfile` alternativo también usa Node 24 y ejecuta el proceso como usuario sin privilegios. `npm start` lee las variables de Coolify sin exigir un archivo `.env`. El archivo local `.env` es opcional y nunca sobreescribe variables existentes.

Dominio de producción: **https://biblioteca.appfastway.com**. La guía completa con puerto, health checks, variables, redes, CORS y configuración de FrontWms está en [docs/COOLIFY.md](docs/COOLIFY.md). `.env.production.example` es una plantilla pública sin secretos; `.env.production` contiene la configuración privada y permanece fuera de Git y de la imagen.

En producción la API exige la base `repositorio_documentos` y el bucket `genika-repositorio-documentos`. `INITIALIZE_STORAGE_ON_START=true` crea ese bucket si falta, y lo comprueba antes de servir HTTP. Dentro de Docker, `127.0.0.1` apunta al contenedor: configurar los hosts reales de Mongo y MinIO y la red de Coolify que los comunica.

Para exponer la API configurar `HOST=0.0.0.0`, `CORS_ORIGINS` con los orígenes reales de FrontWms y TLS en el proxy. Si hay un único proxy confiable, `TRUST_PROXY_HOPS=1`; el valor local es 0. El proxy debe permitir el límite de archivo más el pequeño sobrecosto multipart. `GET /health` comprueba el proceso; `/api/documentos/ready` valida también dependencias y requiere JWT.

La aplicación no modifica la configuración ni inicia servicios de WMS, Mongo o MinIO. Los cambios de FrontWms se conservan en su proyecto local; no se publicó un sitio ni se modificó un despliegue remoto.
