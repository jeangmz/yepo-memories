# Guía de operación

## Propósito

`Recuerdos con amor` reúne fotos, vídeos y mensajes dedicados a Jafet González. El contenido público se compone exclusivamente de recuerdos revisados por una persona administradora.

## Experiencia pública

- Diseño oscuro, responsive y mobile-first.
- Hero con la imagen de Jafet, frase configurable y galería tipo collage.
- Filtros para fotos y vídeos.
- Visor de medios con zoom, desplazamiento y navegación entre recuerdos.
- Galería inicialmente limitada y acción **Ver más** para cargar el resto.
- Formulario con contador de 300 caracteres y vista previa de archivos.

El contenido del homenaje se administra desde `src/data/site.ts`: nombre, frase e imagen principal.

## Publicación de recuerdos

1. Una persona comparte entre uno y cinco archivos, con nombre y mensaje opcionales.
2. Las imágenes se comprimen en el navegador a WebP; los vídeos aceptados son MP4.
3. Turnstile valida la interacción y la Edge Function `submit-memory` autoriza URLs firmadas temporales.
4. El recuerdo queda en revisión privada.
5. Una persona administradora lo aprueba o rechaza desde `/gestion-yepo`.
6. Al aprobarlo, los archivos pasan a los buckets públicos y aparecen en la galería.

Límites: imágenes de entrada de hasta 15 MB, optimizadas a WebP de hasta 2048 px y 3 MB; vídeos MP4 de hasta 30 MB y 60 MB por envío.

## Seguridad

- Supabase aplica Row Level Security a todas las tablas públicas.
- Solo existen hasta tres administradores, limitado por un trigger de PostgreSQL.
- Los archivos en revisión se guardan en `pending-images` y `pending-videos`, ambos privados.
- Los archivos publicados se guardan en `gallery-images` y `gallery-videos`.
- El navegador no puede crear registros ni subir archivos privados directamente; la autorización procede de `submit-memory` después de validar Turnstile.
- No hay registro público de cuentas. Las cuentas administradoras se gestionan manualmente en Supabase Auth y `admin_users`.

## Gestión privada

La ruta `/gestion-yepo` requiere una sesión válida y la presencia de la cuenta en `admin_users`. Conocer la ruta no concede acceso. Desde allí se revisan, aprueban o rechazan los aportes.

## Variables de entorno

Cloudflare Pages utiliza:

```env
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_PUBLISHABLE_KEY=
PUBLIC_TURNSTILE_SITE_KEY=
```

Supabase guarda `TURNSTILE_SECRET_KEY` para la Edge Function y la clave de Turnstile para la protección CAPTCHA de Auth. Ninguna clave privada se expone al cliente.
