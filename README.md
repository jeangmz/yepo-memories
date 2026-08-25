# Recuerdos con amor

Galería memorial para compartir recuerdos de **Jafet González**. La experiencia es mobile-first, de tema oscuro y con moderación privada antes de publicar cualquier contenido.

## Plataforma

- Astro + Alpine.js + Tailwind CSS
- Supabase: Auth, PostgreSQL, Storage y Edge Functions
- Cloudflare: Pages y Turnstile

## Configuración de producción

Cloudflare Pages requiere estas variables de entorno públicas:

```env
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_PUBLISHABLE_KEY=
PUBLIC_TURNSTILE_SITE_KEY=
```

Las claves privadas permanecen exclusivamente en Supabase. Nunca se incluyen en Cloudflare Pages ni en el navegador.

## Funcionamiento

- Cada aporte admite hasta cinco archivos y un mensaje de 300 caracteres.
- Las imágenes se convierten a WebP de hasta 2048 px y se limitan a 3 MB; los vídeos MP4 se limitan a 30 MB.
- Turnstile protege el envío de recuerdos y el inicio de sesión.
- Los archivos se cargan mediante URLs firmadas de corta duración.
- Solo los recuerdos aprobados aparecen en la galería pública.

La guía operativa y de seguridad está en [docs/documentacion.md](docs/documentacion.md).
