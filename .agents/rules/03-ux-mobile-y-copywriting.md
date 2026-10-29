# Regla 03 · UX Mobile-First, Diseño Dual (Confianza + Emoción), Multi-Verticalidad y Copywriting

## 0. Equilibrio Psicológico de Marca: Seriedad Corporativa + Emoción Comunitaria
- **Presencia Colegial y Solvencia de Centro:** El logotipo de **KORUM** (*Escudo Varsity Heritage* inspirado en sudaderas y uniformes universitarios de Stanford/Yale/Santa Isabel + wordmark con doble perfil en oro deportivo) y todas las zonas donde intervienen dinero, firmas o custodia (`Cabecera Global`, `Hucha Escrow WLT-ESC-XXX`, `Desglose de 4 Líneas`, `Checkout`, `Mi Hucha`, `Pizarra TCO`, `Certificados AEAT`, `Facturas Veri*factu`, `Pases y Carteles QR`) deben proyectar máxima seriedad y solvencia institucional de centro educativo de prestigio (`#101F38`, `#047857`, `#F59E0B`, `tabular-nums`), eliminando toda estética bancaria o fintech fría.
- **Tono Emocional de Patio y Cuaderno Vivo:** En el lienzo comunitario de Familias (`Hero del Centro/Club`, `Tarjetas de Iniciativas`, `Retos por Curso/Categoría`, `Buzón de Ideas` y `Galería Antes y Después`), el diseño apela a la memoria escolar mediante fondo cálido (`.korum-paper-dots`), hojas de libreta pautada (`.korum-notebook-sheet`), pósits con washi tape, sellos entintados de mérito (`.korum-stamp-badge` *"★ Aprobado en Patio"* / *"¡CONSEGUIDO!"*), pegatinas `.die-cut-sticker` y titulares cercanos en `Fredoka` (`.font-joy`).

## 1. Visualización Móvil 100% Vertical Sin Apilamientos (`.mobile-stack`)
- En vista móvil (`< 768px` o dentro del simulador `.mobile-simulator-wrap` de `430px`), **todas las pantallas de Familias y Comercios** (`Iniciativas`, `Ficha de Iniciativa`, `Buzón de Ideas`, `Logros`, `Comercios Amigos`, `Mi Hucha` y `FAQ y Soporte`), así como la vista móvil `/school/[orgSlug]/porteria`, deben apilar sus bloques en **1 sola columna vertical (`grid-template-columns: 1fr !important`)**.
- Está prohibido dejar columnas laterales (`lg:col-span-7` + `lg:col-span-5`) comprimidas en horizontal dentro de un contenedor móvil.

## 2. Minimalismo en Listados, Fichas Públicas y Viralidad WhatsApp
- **Filtros ocultos siempre por defecto:** Tanto en el portal público de Familias como en el Cuadro de Mandos del Centro, las barras de filtros deben permanecer ocultas al cargar y desplegarse únicamente al pulsar el botón `🔍 Filtrar` (mostrando contador numérico si hay filtros activos).
- **Solo iniciativas en estado `Recaudando`:** En la pestaña pública `Iniciativas y Taquilla` solo deben mostrarse campañas cuyo estado sea estrictamente `Recaudando` (destacando visualmente si tienen activo un bono *Matching 2x*).
- **Contador de aportaciones totales:** Debajo de la barra de progreso de cada iniciativa debe mostrarse `💛 X aportaciones`, sumando `+1` por cada transacción completada.
- **Sin barra de 6 estados en la ficha pública:** Solo se deja constancia limpia de la **Hucha Escrow (`WLT-ESC-XXX`)** y la **Fecha límite**.
- **Tarjetas Virales OpenGraph para WhatsApp (`next/og`):** Todo enlace compartido de una iniciativa o curso debe exponer metadatos OpenGraph dinámicos con imagen autogenerada en servidor (logo del centro, `%` de avance, días restantes y reto del curso/equipo).
- **Comercios Amigos ordenados por categoría (sin importes en público):** Solo se muestra su distinción (`🥇 Categoría ORO`, `🥈 Categoría PLATA`, `🥉 Categoría BRONCE`), ordenando siempre **primero los Oro, luego los Plata y finalmente los Bronce**.

## 3. Textos Oficiales Validados y Precisión Legal `ley49` (Copywriting Inmutable)
- **Email ligero en Checkout de Invitado:** Cuando el usuario no ha iniciado sesión (`isLoggedIn === false`), el modal de Checkout mantiene el pago en 10 segundos sin registro ni contraseña, solicitando únicamente `📧 Tu email para enviarte al instante tu recibo Escrow / entradas QR`.
- **Texto del Check de Garantía en el Checkout (Prohibido usar la palabra "propina"):**
  - **Título:** `🛡️ Activar aportación de garantía KORUM (+X,XX €)`
  - **Descripción (Condicional según `organization.ley49` para rigor tributario ante AEAT):**
    - Si `organization.ley49 === true`: `Tu aportación voluntaria incluye 3 garantías: (1) El 100% de tu donación llega íntegra al centro sin descuentos bancarios, (2) Garantía de reembolso automático Escrow si no se logra la meta, y (3) Emisión automática de tu Certificado Fiscal IRPF (Ley 49/2002).`
    - Si `organization.ley49 === false`: `Tu aportación voluntaria incluye 3 garantías: (1) El 100% de tu donación llega íntegra al centro sin descuentos bancarios, (2) Garantía de reembolso automático Escrow si no se logra la meta, y (3) Emisión automática de tu Justificante Oficial Nominativo de Aportación.`
- **Texto al pie del Desglose Público de Presupuesto:**
  - `💡 Transparencia total: El importe total solicitado ya incluye el coste financiero de la cuenta bancaria Escrow, el soporte de la plataforma, la gestión y las garantías de devolución del 100% en caso de no conseguirse la iniciativa, para que al colegio le quede limpio el importe exacto necesario para pagar los costes reales de ejecución.`
- **Texto de Advertencia al Reembolsar Saldo de Mi Hucha al Medio de Pago Original:**
  - `⚠️ ¿Estás seguro de que deseas retirar el saldo disponible de tu Hucha? Se reembolsará el 100% directamente a tu medio de pago original (tarjeta/Bizum). Una vez devuelto el dinero, tu saldo quedará a 0,00 € y ya no podrás realizar el pago a iniciativas con tu Hucha hasta recargarla de nuevo, pero sí podrás seguir participando a través de otros medios de pago como Bizum o tarjeta.`

## 4. Selectores de Participación Multi-Verticales (Colegios vs. Clubes Deportivos)
Siempre que una iniciativa o taquilla tenga activo el Reto Colectivo (`rewardEnabled: true`), el desplegable de participación carga la plantilla oficial correspondiente al vertical de la organización (o sus grupos personalizados):
- **Plantilla Escolar Oficial (`SCHOOL` — 13 niveles + 2 Comunidad Ampliada):**
  - *Educación Infantil (3):* `Infantil 3 años (I3)`, `Infantil 4 años (I4)`, `Infantil 5 años (I5)`.
  - *Educación Primaria (6):* `1º de Primaria`, `2º de Primaria`, `3º de Primaria`, `4º de Primaria`, `5º de Primaria`, `6º de Primaria`.
  - *Educación Secundaria - ESO (4):* `1º de ESO`, `2º de ESO`, `3º de ESO`, `4º de ESO`.
  - *Comunidad Ampliada (2):* `Vecino / Amigo del Barrio`, `Antiguo Alumno / Familiar`.
- **Plantilla Deportiva Oficial (`SPORTS_CLUB` — Equipos Base + Afición):**
  - *Categorías Base (5):* `Prebenjamín`, `Benjamín`, `Alevín`, `Infantil`, `Cadete`.
  - *Categorías Superiores (3):* `Juvenil / Júnior`, `Sénior / Primer Equipo`, `Escuela / Veteranos`.
  - *Comunidad del Club (2):* `Socio / Afición`, `Antiguo Jugador / Familiar`.

## 5. Tablas Interactivas del Super-Admin
- Todas las tablas del Super-Admin (`Rendimiento por Centro`, `Top 10 Iniciativas`, `Listado Global de Iniciativas` y `Tabla de Iniciativas en Ficha 360º`) deben permitir **ordenar de mayor a menor y viceversa (`↕`) haciendo clic en el título de cualquiera de sus columnas**.
- Las tablas de iniciativas (`Top 10`, `Global` y `Ficha 360º`) deben incluir siempre la columna `💛 Aportaciones`.
- La tabla de `Rendimiento por Centro` debe incluir siempre las columnas `Cerradas (Año / Hist.)` y `Comercios (Act. / Hist.)`.

