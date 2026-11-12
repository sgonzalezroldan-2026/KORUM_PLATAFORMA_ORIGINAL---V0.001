# Regla 03 · UX Mobile-First, Diseño Dual, Idiomas, Accesibilidad y Textos

> Experiencia completa (recorridos, emails, estados vacíos, animaciones, métricas): [docs/EXPERIENCIA_DE_PRODUCTO.md](../../docs/EXPERIENCIA_DE_PRODUCTO.md). Marca: [korum-brand-design-system](../skills/korum-brand-design-system/SKILL.md).

## 0. Equilibrio de marca: solidez colegial + emoción comunitaria

- **Presencia colegial en las zonas de dinero y firmas.** El logotipo de KORUM (*Escudo Varsity Heritage*) y todo lo que toca dinero, firmas o custodia (cabecera global, hucha de la iniciativa `WLT-ESC-XXX`, desglose de 4 líneas, checkout, Mi Hucha, pizarra TCO, certificados, facturas, pases y carteles QR) usan `#101F38`, `#047857`, `#F59E0B` y `tabular-nums`, sin estética de banco ni de fintech fría.
- **Tono de patio y cuaderno vivo en la comunidad.** Portada del centro o club, tarjetas de iniciativas, retos por curso o categoría, buzón de ideas y galería Antes/Después usan fondo cálido (`.korum-paper-dots`), hojas pautadas (`.korum-notebook-sheet`), pósits con washi tape, sellos de mérito (`.korum-stamp-badge`), pegatinas `.die-cut-sticker` y titulares en `Fredoka` (`.font-joy`).
- La inspiración universitaria es de **estilo**: prohibido reproducir escudos, nombres, colores distintivos o lemas de instituciones o marcas reales.

## 1. Móvil en una sola columna (`.mobile-stack`)

- En móvil (`< 768px`), **todas las pantallas de familias y comercios** (iniciativas, ficha, buzón de ideas, logros, comercios amigos, Mi Hucha, FAQ y soporte) y la portería apilan sus bloques en **una sola columna** (`grid-template-columns: 1fr`).
- Prohibidas las columnas laterales comprimidas en un contenedor móvil. Comprobación: `document.documentElement.scrollWidth <= 430` a `430×932`.

## 2. Listados, fichas públicas y viralidad

- **Filtros ocultos por defecto** en el portal de familias y en el cuadro de mandos de la entidad; se despliegan con `🔍 Filtrar` y muestran un contador si hay filtros activos.
- **En la pestaña pública "Iniciativas y taquilla" solo aparecen iniciativas `FUNDRAISING`** (etiqueta visible «Recaudando»), destacando las que tienen *Matching 2x* activo.
- **Contador `💛 X aportaciones`** bajo la barra de progreso: `+1` por cada aportación completada de una persona o comercio y por el Auto-Impulso de KORUM (que no suma a ningún curso).
- **Ficha pública sin la barra de 6 estados:** solo la **hucha de la iniciativa (`WLT-ESC-XXX`)** y la **fecha límite**.
- **Tarjetas para WhatsApp y redes (`next/og`):** todo enlace de iniciativa o curso genera su imagen en servidor (logo del centro, `%` de avance, días restantes y reto del curso o equipo). Detalle en [korum-seo-discoverability](../skills/korum-seo-discoverability/SKILL.md).
- **Comercios amigos por categoría, sin importes en público:** `🥇 Categoría ORO`, `🥈 Categoría PLATA`, `🥉 Categoría BRONCE`, siempre en ese orden.

## 3. Textos oficiales (no se cambian sin aprobación del usuario)

- **Email en el checkout de invitado:** sin registro ni contraseña, un único campo: `📧 Tu email para enviarte al instante tu recibo o tus entradas QR`.
- **Aportación voluntaria a KORUM en el checkout** (prohibida la palabra "propina"). El check aparece **desmarcado**; el importe se elige con un selector desde `0 €`:
  - **Título:** `🛡️ Apoyar a KORUM con una aportación voluntaria (+X,XX €)`
  - **Descripción si `organization.ley49 === true` y está verificada:** `Es opcional y no cambia nada de tu donación. Con ella sostienes el servicio que garantiza a todas las familias: (1) que el 100% de tu donación llega al centro sin descuentos bancarios, (2) la devolución automática si no se alcanza la meta y (3) la emisión automática de tu Certificado Fiscal de donación (Ley 49/2002).`
  - **Descripción en el resto de casos:** igual, terminando en `(3) la emisión automática de tu Justificante Nominativo de Aportación.`
- **Pie del desglose público:** `💡 Transparencia total: el importe total ya incluye el coste de la pasarela de pago, el servicio de la plataforma, la gestión y la devolución del 100% si la iniciativa no se consigue, para que al centro le quede exactamente lo necesario para pagar los costes reales.`
- **Aviso al retirar el saldo de Mi Hucha** (solo en modo `REGULATED_WALLET`): `⚠️ ¿Seguro que quieres retirar el saldo de tu Hucha? Te devolveremos el 100% directamente a tu medio de pago original (tarjeta o Bizum). Tu saldo quedará a 0,00 € y no podrás pagar con la Hucha hasta recargarla, pero podrás seguir participando con Bizum o tarjeta.`
- Las versiones en catalán e inglés de estos textos se revisan por una persona nativa antes de publicarse y se guardan en los catálogos de traducción como textos legales versionados.

## 4. Cómo se habla de KORUM y del dinero (precisión legal)

- KORUM es una **plataforma tecnológica**: no es un banco, no está regulada como entidad financiera y **no custodia fondos**. Los cobros, retenciones y devoluciones los ejecuta **PAYCOMET**, entidad de pago autorizada por el Banco de España (usar exactamente la redacción que Paycomet apruebe en el contrato).
- **Prohibido** en textos públicos: "cuenta bancaria" referido a KORUM o a las huchas, "banco", "regulado por el Banco de España" referido a KORUM, "exención CNMV", "garantizado por ley", sellos o logotipos de organismos públicos.
- En público, "Escrow" se dice **"hucha de la iniciativa"** o **"el dinero queda retenido en Paycomet hasta lograr la meta"**. "Escrow" se mantiene solo como término interno en código y documentación técnica.

## 5. Selectores de participación por vertical

Con el reto colectivo activo (`rewardEnabled: true`), el desplegable carga la plantilla oficial del vertical (o los grupos personalizados de la entidad):

- **Escolar (`SCHOOL`): 13 cursos + 2 de comunidad.**
  - *Infantil (3):* `Infantil 3 años (I3)`, `Infantil 4 años (I4)`, `Infantil 5 años (I5)`.
  - *Primaria (6):* `1º de Primaria` … `6º de Primaria`.
  - *ESO (4):* `1º de ESO` … `4º de ESO`.
  - *Comunidad ampliada (2):* `Vecino / Amigo del Barrio`, `Antiguo Alumno / Familiar`.
- **Deportiva (`SPORTS_CLUB`): equipos + afición.**
  - *Base (5):* `Prebenjamín`, `Benjamín`, `Alevín`, `Infantil`, `Cadete`.
  - *Superiores (3):* `Juvenil / Júnior`, `Sénior / Primer Equipo`, `Escuela / Veteranos`.
  - *Comunidad del club (2):* `Socio / Afición`, `Antiguo Jugador / Familiar`.
- **Cultural (`CULTURAL`): grupos configurables** con esta plantilla por defecto: `Alumnado / Integrantes`, `Familias`, `Profesorado / Monitores`, `Socios / Amigos`, `Antiguos Miembros`.

## 6. Retos por curso sin presión social

- Se muestran **solo en positivo**: «3ºB ya suma 28 familias · reto: 35». Prohibido señalar a personas, mostrar quién no ha aportado, ordenar cursos de último a primero o mostrar importes por curso.
- La tarjeta de WhatsApp de un curso celebra lo conseguido («¡Solo faltan 7 familias para la tarde de cine!») sin nombres ni comparaciones con otros cursos.
- Cada entidad puede desactivar los retos por curso.

## 7. Idiomas (castellano, catalán e inglés)

- Ningún texto visible en el código: todo en `messages/{es,ca,en}.json` con claves semánticas (`checkout.guarantee.title`). Plurales y variables con formato ICU.
- Importes, fechas y números con `Intl` según el idioma (`25,00 €` en `es`/`ca`; `€25.00` en `en`).
- El idioma se elige por URL (`/`, `/ca`, `/en`), con selector visible en la cabecera y el pie, y se recuerda en la cuenta (`User.locale`). **No hay redirección automática por el idioma del navegador ni cookie de idioma**: la misma URL muestra siempre el mismo idioma (SEO, enlaces compartidos y privacidad). Los emails salen en el idioma de la persona.
- El contenido que escribe la entidad (títulos, descripciones) se muestra en su `contentLocale`; puede añadir traducciones opcionales (`translationsJson`).

## 8. Accesibilidad (WCAG 2.2 AA, obligatoria)

- Todo elemento interactivo es accesible con teclado, tiene foco visible (`:focus-visible`) y nombre accesible; las imágenes tienen `alt` (vacío si son decorativas).
- Contraste mínimo 4.5:1 en texto normal y 3:1 en texto grande y componentes; objetivos táctiles de al menos 44×44 px.
- Los estados no se comunican solo con color o emoji: van acompañados de texto.
- Las animaciones respetan `prefers-reduced-motion`. Los errores de formulario se anuncian (`aria-live`) y se asocian al campo.
- Los tests E2E incluyen una comprobación automática con axe (0 incidencias serias o críticas).

## 9. Tablas del Super-Admin

- Todas las tablas del Super-Admin (`Rendimiento por centro`, `Top 10 iniciativas`, `Listado global de iniciativas` e `Iniciativas en la ficha 360º`) se **ordenan de mayor a menor y viceversa (`↕`) al pulsar el título de cualquier columna**.
- Las tablas de iniciativas incluyen siempre la columna `💛 Aportaciones`.
- La tabla `Rendimiento por centro` incluye siempre `Cerradas (Año / Hist.)` y `Comercios (Act. / Hist.)`.
