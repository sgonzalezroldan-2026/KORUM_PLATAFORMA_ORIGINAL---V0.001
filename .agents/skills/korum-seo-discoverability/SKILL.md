---
name: korum-seo-discoverability
description: SEO técnico y descubribilidad de KORUM en buscadores (Google, Bing), asistentes de IA (ChatGPT, Claude, Perplexity, Gemini y las respuestas con IA de Google) y vistas previas en redes y mensajería (WhatsApp, Telegram, Facebook, Instagram, LinkedIn, X). Cubre metadatos, robots.txt, sitemap, hreflang es/ca/en, datos estructurados JSON-LD, llms.txt, tarjetas next/og e indexación respetuosa con la privacidad. Cargar al construir cualquier página pública o cualquier pieza de metadatos.
---

# Skill · SEO, buscadores de IA y vistas previas sociales

Objetivo: que quien busque *"cómo recaudar dinero para el AMPA"*, *"ventiladores para el colegio"*, *"rifa solidaria club deportivo"* o pregunte a un asistente de IA por plataformas de mecenazgo escolar encuentre KORUM; y que cada enlace compartido en WhatsApp se vea impecable. **Sin exponer nunca datos personales ni de menores.**

## 1. Qué se indexa y qué no

| Ruta | Indexar | Notas |
| :--- | :--- | :--- |
| `/` y páginas de marketing (`/para-colegios`, `/para-clubes`, `/para-entidades-culturales`, `/para-comercios`, `/como-funciona`, `/precios`, `/seguridad-y-transparencia`, `/preguntas-frecuentes`, `/guias/*`) | Sí | Páginas pilar del SEO, en los 3 idiomas |
| `/registro-comunidad` | Sí | Página de conversión |
| `/[orgSlug]` (portada de la entidad) | Sí, si `organization.publicIndexing` | La entidad lo decide en el alta; por defecto sí |
| `/[orgSlug]/iniciativas/[id]` en `FUNDRAISING`, `GOAL_REACHED` o `CLOSED` | Sí, si la entidad indexa | Las cerradas alimentan *Logros*: contenido duradero |
| `/[orgSlug]/ideas` y detalle de ideas | **No** (`noindex`) | Propuestas de familias: privacidad |
| Checkout, Mi Hucha, Mi cuenta, entradas, `/login` | **No** | |
| `/panel/*`, `/admin/*`, portería | **No** + `Disallow` | Privado |
| URLs con `?grupo=` u otros parámetros de compartir | Canónica sin parámetros | La imagen social sí cambia por curso |
| Páginas legales | Sí | Prioridad baja en el sitemap |

## 2. Metadatos de cada página (`generateMetadata`)

- `title` ≤ 60 caracteres con patrón `{Página} · KORUM` (portada de entidad: `{Nombre de la entidad} · Iniciativas y logros · KORUM`).
- `description` ≤ 155 caracteres, escrita para personas, con el beneficio concreto.
- `alternates.canonical` absoluta (`NEXT_PUBLIC_APP_URL`) y `alternates.languages` con `es`, `ca`, `en` y `x-default` (→ `es`).
- `openGraph`: `type`, `url`, `title`, `description`, `siteName: 'KORUM'`, `locale` (`es_ES`, `ca_ES`, `en_GB`) y `images` (1200×630, con `alt`).
- `twitter`: `card: 'summary_large_image'`.
- `robots`: `{ index: false, follow: false }` en las rutas privadas de la tabla.
- `<html lang>` siempre con el idioma de la página.
- Etiquetas de verificación de Google Search Console y Bing Webmaster Tools leídas de los ajustes `seo.verification.google` y `seo.verification.bing` de la consola del Super-Admin.

## 3. Datos estructurados (JSON-LD, solo información pública)

- **Landing:** `Organization` (nombre, logo, `sameAs` con redes oficiales) + `WebSite`.
- **Preguntas frecuentes:** `FAQPage` (aunque Google ya no muestre siempre el resultado enriquecido, ayuda a buscadores y asistentes de IA a entender las respuestas).
- **Portada de entidad:** `EducationalOrganization`, `SportsOrganization` u `Organization` según el vertical, con nombre, localidad y logo. Nunca personas.
- **Eventos de taquilla:** `Event` con `startDate`, `location`, `eventStatus` y `offers` (precio, disponibilidad, URL de compra).
- **Migas de pan:** `BreadcrumbList` en todas las páginas con jerarquía.
- Validar con la prueba de resultados enriquecidos de Google en la Puerta 4 de los sprints de marketing.

## 4. `robots.txt`, `sitemap.xml` e indexación rápida

- `src/app/robots.ts`: `Allow: /`; `Disallow: /panel/`, `/admin/`, `/api/` (excepto `Allow: /api/og/`, para que las redes puedan leer las imágenes); referencia al sitemap.
- `src/app/sitemap.ts`: dinámico, con páginas de marketing, entidades con `publicIndexing` e iniciativas públicas; `lastModified` real y `alternates` por idioma. Si supera 50.000 URL, se divide (`generateSitemaps`).
- **IndexNow** (Bing y otros buscadores): aviso automático al publicar o cerrar una iniciativa pública, con la clave guardada en `PlatformSecret` `seo.indexNowKey`.

## 5. Buscadores y asistentes de IA

- **Contenido renderizado en servidor:** todo texto importante está en el HTML inicial (Server Components); nada esencial depende de JavaScript en el cliente.
- **`/llms.txt`** (`src/app/llms.txt/route.ts`): resumen en Markdown de qué es KORUM, para quién es, cómo funciona el dinero (Paycomet, todo o nada, devolución del 100 %) y enlaces a las páginas pilar en los 3 idiomas.
- **Respuestas citables:** las páginas pilar responden en el primer párrafo a una pregunta concreta, con datos verificables (comisiones, plazos, qué pasa si no se llega a la meta) y fecha de actualización visible.
- **Política de rastreadores de IA**, editable en el ajuste `seo.aiCrawlers` de la consola (porque los nombres de los bots cambian):
  - **Rastreadores de búsqueda y respuesta** (p. ej. `OAI-SearchBot`, `ChatGPT-User`, `Claude-SearchBot`, `Claude-User`, `PerplexityBot`, `Perplexity-User`): **permitidos** en marketing y en las páginas públicas de entidades que indexan.
  - **Rastreadores de entrenamiento** (p. ej. `GPTBot`, `ClaudeBot`, `Google-Extended`, `CCBot`, `Applebot-Extended`, `Meta-ExternalAgent`): **permitidos solo en las páginas de marketing**; bloqueados en `/[orgSlug]` para respetar a las comunidades escolares. El Super-Admin puede cambiar ambas listas.

## 6. Vistas previas en WhatsApp y redes (`next/og`)

- Imagen de **1200×630**, PNG o JPEG de **menos de 300 KB** (WhatsApp descarta las pesadas), URL absoluta con HTTPS y `og:image:alt`.
- Iniciativa: logo de la entidad, título, `%` de avance, días restantes y, si viene `?grupo=`, el reto de ese curso o equipo (en positivo, ver Regla 03 §6). Nunca nombres de personas.
- WhatsApp y Facebook guardan en caché la imagen: la URL lleva versión (`?v={updatedAt}`) para que el avance se vea actualizado.
- Probar cada plantilla con los depuradores de compartición de Facebook y LinkedIn y enviando el enlace por WhatsApp en la Puerta 4.

## 7. Rendimiento, idiomas y privacidad

- Core Web Vitals dentro del presupuesto de [korum-nextjs-multitenant-ui](../korum-nextjs-multitenant-ui/SKILL.md) §5: también es un factor de posicionamiento.
- Contenido de marketing **escrito de forma nativa** en castellano, catalán e inglés (no traducción literal), con palabras clave propias de cada idioma (*AMPA* / *AFA*, *rifa* / *rifa solidària*).
- Prohibido indexar datos personales: nombres de donantes, autores de ideas, emails, fotos con menores identificables (las fotos Antes/Después se suben con una casilla de confirmación de que no aparecen menores reconocibles).

## 8. Lista de comprobación por página pública

- [ ] `title`, `description`, canónica y `hreflang` correctos en los 3 idiomas.
- [ ] Imagen social de 1200×630 < 300 KB con `alt`.
- [ ] JSON-LD válido y sin datos personales.
- [ ] Indexación según la tabla del §1 (y `publicIndexing` de la entidad).
- [ ] Incluida o excluida del sitemap según corresponda.
- [ ] Encabezados jerárquicos (un único `h1`) y enlaces internos descriptivos.
- [ ] LCP < 2,5 s en móvil.
