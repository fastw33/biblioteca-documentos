# Despliegue de Biblioteca en Coolify

Repositorio: `https://github.com/fastw33/biblioteca-documentos.git`.

| Configuración | Valor |
| --- | --- |
| Dominio de la API | `https://biblioteca.appfastway.com` |
| Base de API | `https://biblioteca.appfastway.com/api/documentos` |
| Rama de producción | `main` |
| Rama de QA | `Qa` |
| Build pack | **Railpack** |
| Tipo | Aplicación web dinámica, no sitio estático |
| Base directory | `/` |
| Node | `24`, mediante `railpack.json` y `RAILPACK_NODE_VERSION` |
| Install command | Detección de npm con `package-lock.json` (`npm ci`) |
| Build command | Vacío; esta API no necesita transpilación |
| Start command | `node src/server.js` (también funciona `npm start`) |
| Exposed port | `3016` |
| Health check | `GET /health`, puerto `3016`, respuesta `200` |

## Variables de entorno

El archivo `.env.production` generado localmente contiene las credenciales reales reutilizadas del entorno de producción de Genika. Está ignorado por Git y Docker. No copiarlo al repositorio ni usarlo en la compilación de la imagen.

Para generarlo en una instalación nueva, ejecutar `node scripts/configure-production.js`; lee la configuración de producción de `GestorDocumental` del equipo y conserva las credenciales. Se puede indicar `--source <ruta>` para otra ubicación. Nunca sobrescribe un `.env.production` existente.

Pegar su contenido en **Environment Variables > Developer view** de la aplicación de **Biblioteca**. Guardar únicamente en esa aplicación. `RAILPACK_NODE_VERSION=24` debe estar disponible durante build; las credenciales y conexiones se marcan como runtime-only y literal para conservar caracteres como `$`. La plantilla pública sin secretos es `.env.production.example`.

Este servicio usa las variables **`MONGO_URI`**, **`MONGO_DB_NAME`**, **`JWT_SECRET`** y **`CORS_ORIGINS`**. No utiliza las variables MySQL, cookies, CSRF o sesiones del ejemplo de Externalclientes. `JWT_SECRET` debe contener el mismo valor que emite los tokens WMS, aunque otro servicio lo llame `WMS_JWT_SECRET`.

Destinos obligatorios de producción:

- Base Mongo: `repositorio_documentos`.
- Bucket S3/MinIO: `genika-repositorio-documentos`.
- Prefijo: `documentos/`.
- CORS: `https://portalclientes.fastwaysas.com`, `https://www.appfastway.com`, `https://qa.appfastway.com`.

La API rechaza en producción nombres de base o bucket distintos. `INITIALIZE_STORAGE_ON_START=true` crea **solo ese bucket** si falta y comprueba su acceso antes de servir HTTP. Si ya existe, lo conserva. Mongo crea las colecciones e índices únicamente en la base nueva. Las credenciales necesitan permiso sobre esos destinos.

La nueva base y el nuevo bucket locales no se trasladan automáticamente al servidor. Los hosts configurados en `.env.production` son los servicios internos de producción; al desplegar, esta API debe compartir la red de Coolify en la que esos hosts se resuelven. No usar `127.0.0.1` para Mongo o MinIO dentro del contenedor. Si Coolify los tiene en otra red, conectar la aplicación a esa red desde su configuración.

## Railpack y dependencias

`railpack.json` agrega LibreOffice Writer/Calc/Impress, Poppler y fuentes **a la imagen final**, necesarios para las vistas previas. No hace falta configurar Nixpacks ni `NIXPACKS_NODE_VERSION`. Al seleccionar Railpack en Coolify, revisar que el plan detecte Node 24 y los paquetes de runtime.

La alternativa **Dockerfile** también usa Node 24 con las mismas dependencias y usuario sin privilegios. En ese caso elegir Dockerfile en lugar de Railpack y conservar dominio, puerto y variables. Ninguna de las dos opciones requiere montar el `.env` como archivo: el proceso lee las variables inyectadas por Coolify.

`npm start` admite un `.env` local opcional y no sobreescribe las variables ya inyectadas. `npm run setup` también admite variables de runtime; no es necesario ejecutarlo por separado si `INITIALIZE_STORAGE_ON_START=true`.

## Comprobación del despliegue

1. Seleccionar Deploy y esperar a que finalice el build y arranque el contenedor.
2. Comprobar `https://biblioteca.appfastway.com/health`: debe responder `{"status":"ok"}`.
3. Comprobar `/api/documentos` sin token: debe responder `401`.
4. Con JWT de WMS, llamar `/api/documentos/ready`: debe responder `200` solo si Mongo y el bucket están accesibles.
5. Cargar un documento de prueba, revisar su metadata Genika y descargarlo. Confirmar versión y auditoría en la base exclusiva.

El health check público comprueba el proceso; no reemplaza el check de dependencias autenticado. Permitir en el proxy al menos 30 MB más el sobrecosto multipart y un tiempo de respuesta suficiente para las conversiones (hasta 60 segundos).

## FrontWms

Configurar antes de compilar el front:

```dotenv
VITE_DOCUMENTOS_API_URL=https://biblioteca.appfastway.com/api/documentos
```

Esta variable es pública. No incluir claves S3, Mongo ni el secreto JWT en variables `VITE_*`. Publicar la API no recompila ni despliega FrontWms automáticamente.
