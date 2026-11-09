# Experiencia de producto · KORUM v8.5

> Documento que manda en **cómo se vive** KORUM: recorridos, momentos de celebración, emails, estados de pantalla, animaciones, accesibilidad, idiomas, tono y métricas. Lo que la app **hace** está en el [PRD](PRD_3_ENTORNOS_KORUM.md); cómo se **ve**, en la [skill de marca](../.agents/skills/korum-brand-design-system/SKILL.md).

---

## 1. Principios

1. **Diez segundos para aportar.** Desde que se abre el checkout hasta que se confirma el pago con Bizum: ≤ 10 s y ≤ 3 toques.
2. **Confianza cálida.** El dinero se explica con claridad (a dónde va, qué pasa si no se llega) y con orgullo de comunidad, nunca con jerga financiera.
3. **Celebrar, nunca culpabilizar.** Se celebra cada aportación y cada logro; jamás se señala a quien no aporta (Regla 03 §6).
4. **Cada pantalla tiene una siguiente acción** obvia, también cuando está vacía o hay un error.
5. **Móvil, accesible y en tu idioma** desde el primer día: castellano, catalán e inglés.

---

## 2. Personas

| Persona | Contexto | Qué necesita | Qué le hace desconfiar |
| :--- | :--- | :--- | :--- |
| **Laura, madre (38)** | Recibe el enlace en el grupo de WhatsApp de 3ºB. Móvil, prisa, Bizum. | Entender en 5 s qué se pide y pagar en 10. | Formularios largos, crear cuenta, letra pequeña. |
| **José, abuelo (68)** | Le reenvían el enlace; dona con tarjeta. | Letra legible, botones grandes, un recibo claro. | Pasos confusos, ventanas emergentes. |
| **Marta, presidenta del AMPA (44)** | Voluntaria con poco tiempo; firma desde el móvil. | Saber qué falta por hacer y firmar en 30 s. | Responsabilidad legal poco clara, papeleo. |
| **Carlos, director del centro (55)** | Prudente; le preocupa la imagen del colegio. | Control, transparencia y que nadie se sienta presionado. | Que parezca un negocio o un banco. |
| **Jordi, tesorero del club (50)** | Lleva las cuentas de un club de base. | Conciliación clara, entradas y rifas sin efectivo. | Comisiones ocultas. |
| **Pilar, comercio del barrio (47)** | Panadería o clínica dental cercana. | Visibilidad entre familias y factura al momento. | Pagar sin ver retorno. |
| **Álex, voluntario de portería (35)** | En la puerta de la fiesta, con su móvil y mala cobertura. | Verde o rojo, grande y al instante. | Apps que instalar, contraseñas. |

---

## 3. Recorridos y sus momentos *wow*

| Recorrido | Objetivo | Momento *wow* |
| :--- | :--- | :--- |
| **Familia desde WhatsApp** → ficha → checkout → pago | ≤ 60 s en total; ≤ 10 s el pago | La barra de progreso **sube en directo** con su aportación, mensaje *"¡Sois 165 familias!"* y tarjeta lista para compartir con su curso. |
| **Cofirmante** recibe *"Marta ha firmado, falta tu firma"* → enlace → código → firma | ≤ 30 s | Sello *"APROBADO"* que se estampa con una animación de tampón. |
| **Entidad nueva**: alta → primera campaña con plantilla → publicar | ≤ 5 min hasta tener campaña lista (el KYB se completa antes de cobrar, sin bloquear el borrador) | Vista previa instantánea de **su** tarjeta de WhatsApp y de **su** cartel A4 con QR, con el texto del mensaje para el grupo ya escrito. |
| **Comercio**: patrocinio → factura → directorio | ≤ 2 min | Email *"Ya eres Comercio ORO de CEIP Cervantes"* con un **cartel para su escaparate** ("Comercio amigo de…") en PDF. |
| **Portería**: PIN → escanear | ≤ 0,5 s por entrada | Pantalla entera en verde o rojo, sonido y vibración; contador de aforo en vivo; en rifas, sorteo proyectable con animación de tómbola. |
| **Logro**: campaña al 100 % → obra → fotos | Aviso en ≤ 1 min tras el último pago | Email *"¡Lo hemos conseguido!"* a todas las familias y, semanas después, *"Mirad cómo ha quedado"* con el **Antes y Después**. |
| **Campaña que no llega** | Reembolso automático, sin gestiones | Mensaje cálido: *"Esta vez no ha sido posible. Te hemos devuelto el 100 %. ¡Gracias por intentarlo con nosotros!"* |
| **Super-Admin** por la mañana | 2 min para saber cómo va todo | Panel con alertas priorizadas (💎, 🚨, conciliación, firmas atascadas, ventanas de 90 días). |

---

## 4. Catálogo de emails y notificaciones

**Estado tras el Sprint 2.6:** implementadas y en es/ca/en las plantillas `auth.magicLink`, `auth.otp`, `auth.invitation` (Sprint 3.2), `contribution.receipt`, `ticket.pass`, `gate.pinRevoked`, `initiative.goalReached`, `initiative.expired`, `refund.issued`, `doubleCheck.pending`, `split.windowExpiring`, `split.windowExpired`, `sponsor.renewalNotice`, `tax.certificateReady`, `model182.reminder` y `privacy.inactivityNotice`. El resto (`initiative.achievementPhotos`, `payout.executed`, `sponsor.welcome` (Sprint 4.2b: con los enlaces del justificante y la factura), `sponsor.creditPool`, `pledge.*`, `org.kybStatus`, `support.reply`) se añade al catálogo en el sprint que escribe ese mensaje. **Sprint 3.7:** `tax.certificateReady` ya lo escribe la tarea del 2 de enero (`MODEL182_REMINDER`), y `privacy.exportReady` no se usa: la exportación se descarga al momento desde *Mi cuenta*, sin enlace por email (DECISIONES_TECNICAS §2.5). **Sprint 3.8:** `pledge.charged` (sustituye al recibo genérico en cada mes de Mi Hucha: mes N de M, donación, gestión y total), `pledge.skipped` y `pledge.failed`, en es/ca/en. **Sprint 4.2a:** `idea.quorumReached` e `idea.centerReplied`, en es/ca/en. **Sprint 4.2e:** `signer.handover`, en es/ca/en.

Reglas: solo emails **transaccionales** por defecto (los comerciales exigen consentimiento); remitente *"{Entidad} vía KORUM"*; idioma de la persona; versión HTML y de texto; botón principal único; sin adjuntos pesados (enlaces de descarga). WhatsApp se usa **solo para compartir enlaces** (`wa.me`); no se envían mensajes automáticos por WhatsApp.

| `templateKey` | Cuándo | A quién | Contenido y botón |
| :--- | :--- | :--- | :--- |
| `auth.magicLink` / `auth.otp` | Al iniciar sesión | Persona | Enlace o código, caducidad visible |
| `auth.invitation` | Al dar de alta una entidad (cofirmante) o el primer Super-Admin | Persona invitada | Enlace de un solo uso (72 h) para crear la contraseña; recuerda que después se activa la verificación en dos pasos |
| `contribution.receipt` | Pago confirmado | Donante | Importe, iniciativa, titular legal que recibe, qué pasa si no se llega; *Ver la iniciativa* |
| `ticket.pass` | Entrada o papeleta comprada | Comprador | QR adjunto, número de serie, fecha y lugar; *Ver mi entrada* (el calendario va como `.ics` adjunto) |
| `gate.pinRevoked` | 20 intentos fallidos de PIN en un evento | Firmantes | Que el PIN se ha revocado por seguridad y que las sesiones abiertas siguen; *Generar otro PIN* |
| `initiative.goalReached` | Campaña al 100 % | Firmantes (el aviso a donantes y *Compartir el logro* por email llegan con el Sprint 4.4; la página *Logros* y su botón de compartir ya existen desde el 3.6) | Celebración y próximos pasos; *Ir al panel* |
| `initiative.achievementPhotos` | Publicadas las fotos | Donantes | Antes y Después; *Ver cómo ha quedado* |
| `initiative.expired` | Vence sin meta | Firmantes | Opciones: redimensionar o reembolsar; *Decidir ahora* |
| `refund.issued` | Reembolso ejecutado | Donante | Importe devuelto y medio; plazo bancario orientativo |
| `doubleCheck.pending` | Se pide una firma, o falta la 2ª | Quien debe firmar | Qué se firma, código de 6 dígitos y caducidad; *Firmar ahora* (enlace de un solo uso, con el token en el fragmento `#t=`). Enlace y código se borran del mensaje al enviarse |
| `idea.quorumReached` | Una idea del buzón alcanza el quórum (por una firma, al aprobarla o al revalidar una firma) | Firmantes | Título y código `#FAM-XXXX` de la idea y que hacen falta las dos firmas; *Ir a Aprobaciones* |
| `idea.centerReplied` | La entidad responde en el chat de una idea o la desestima (como mucho uno al día por idea y tipo) | Quien propuso la idea | **Sin el texto del mensaje** (privacidad): que hay un mensaje o una decisión; *Leer en mi cuenta* |
| `signer.handover` | Se propone el relevo de una persona firmante (a quien sale), lo rechaza (a quien lo propuso) o se completa (a quien sale y a quien sigue) | Firmantes | **Sin nombres ni emails** (se ven en el panel): qué ha pasado con el puesto y, al proponerse, que hace falta su visto bueno con el código en 7 días; «si no reconoces este cambio, escribe a soporte»; *Ver el equipo que firma* |
| `payout.executed` | Liquidación hecha | Firmantes | Importe, destino y factura; *Subir fotos del Después* |
| `split.windowExpiring` / `split.windowExpired` | Faltan 15 días de la ventana de 90 / ha vencido | Firmantes | Qué hacer para liquidar a tiempo; *Liquidar ahora* |
| `sponsor.welcome` | Patrocinio confirmado | Comercio | Factura, justificante y cartel de escaparate |
| `sponsor.renewalNotice` | 30 días antes de renovar | Comercio | Importe, fecha y cómo cancelar |
| `sponsor.creditPool` | Patrocinio en la bolsa | Comercio | Plazo y opciones |
| `pledge.charged` / `pledge.skipped` | Cobro mensual de Mi Hucha o mes sin iniciativa activa | Familia | A qué iniciativa ha ido; *Pausar o cambiar* |
| `tax.certificateReady` | Enero | Donantes con NIF en entidades con Ley 49/2002 | Descargar certificado |
| `model182.reminder` | 2 de enero | Firmantes de entidades con Ley 49/2002 | Descargar el Modelo 182 |
| `org.kybStatus` | Cambia el estado del KYB | Firmantes | Qué falta o confirmación |
| `privacy.exportReady` | *(no se usa: la exportación se descarga al momento desde Mi cuenta, Sprint 3.7)* | — | — |
| `privacy.inactivityNotice` | 3 años sin actividad (`DATA_RETENTION_PURGE`) | Persona | Que su cuenta se suprimirá el día `eraseOn` si no vuelve a entrar, qué se conserva por ley y que basta con iniciar sesión para conservarla; *Entrar en mi cuenta* |
| `support.reply` | Respuesta a un ticket | Remitente | Respuesta y enlace al hilo |

---

## 5. Estados de pantalla

| Vista | Vacío | Error |
| :--- | :--- | :--- |
| Portada de la entidad sin campañas | *"Todavía no hay campañas abiertas. ¿Tienes una idea para el cole? Propónla en el Buzón."* → *Proponer idea* | *"No hemos podido cargar las campañas. Vuelve a intentarlo en unos segundos."* → *Reintentar* |
| Buzón de ideas vacío | *"Sé la primera familia en proponer una mejora."* | Igual que arriba |
| Logros vacíos | *"Aquí aparecerán las mejoras conseguidas, con su Antes y Después."* | — |
| Pago rechazado | — | *"Bizum no ha confirmado el pago. No se te ha cobrado nada."* → *Probar otra vez* / *Pagar con tarjeta* (sin perder lo introducido) |
| Panel de una entidad nueva | Guía de 3 pasos: *Crea tu primera campaña* (con plantillas) · *Invita a tu cofirmante* · *Completa el KYB* | — |
| Portería sin conexión | — | Banda ámbar: *"Sin conexión: seguimos validando con la lista descargada."* |
| Super-Admin sin alertas | *"Todo en orden. Ninguna alerta pendiente."* | — |

Carga: siempre **esqueletos** con la forma del contenido; nunca pantallas en blanco ni spinners a pantalla completa.

---

## 6. Movimiento, sonido y celebraciones

- **Duración:** 150–300 ms, curvas suaves. Nada se mueve sin motivo.
- **Celebraciones:** barra de progreso que se llena al confirmar el pago; confeti breve al llegar al 100 %; sello de tampón al aprobar una firma; pegatina que "salta" al desbloquear un reto de curso.
- **Portería:** pitido corto + vibración corta (válida); zumbido + vibración larga (no válida). Sonido desactivable.
- **`prefers-reduced-motion`:** sin confeti ni desplazamientos; solo cambios de opacidad.

---

## 7. Accesibilidad

- **WCAG 2.2 AA** en toda la aplicación (Regla 03 §8). La Ley Europea de Accesibilidad se aplica a servicios de comercio electrónico desde junio de 2025.
- Página de **declaración de accesibilidad** con un canal para comunicar problemas.
- Tamaño de texto base de 16 px, ampliable al 200 % sin romper el diseño; objetivos táctiles de 44 px.
- Prueba manual con lector de pantalla (VoiceOver y TalkBack) en el checkout y en la portería en el Sprint 5.5.

---

## 8. Idiomas

- **Idiomas de lanzamiento:** castellano (`es`, por defecto), catalán (`ca`) e inglés (`en`).
- **Proceso:** el texto nace en castellano en `messages/es.json`; el catalán y el inglés se escriben de forma nativa (no traducción literal) y los textos legales los revisa una persona nativa.
- **Vocabulario fijo:**

| Concepto | es | ca | en |
| :--- | :--- | :--- | :--- |
| Mi Hucha | Mi Hucha | La meva Guardiola | My Piggy Bank |
| AMPA / AFA | AMPA | AFA | Parents' Association |
| Recaudando (`FUNDRAISING`) | Recaudando | Recaptant | Fundraising |
| Logro conseguido (`GOAL_REACHED`) | ¡Conseguido! | Aconseguit! | Goal reached! |
| Comercios amigos | Comercios amigos | Comerços amics | Local partners |
| Gastos de gestión digital | Gastos de gestión digital | Despeses de gestió digital | Digital handling fee |
| Aportación voluntaria a KORUM | Aportación voluntaria | Aportació voluntària | Optional contribution |

- **Ampliación futura:** valenciano (como variante de `ca`), euskera y gallego, cuando haya entidades que lo pidan; la arquitectura ya lo permite.

---

## 9. Métricas y analítica

- **Métrica principal:** campañas que alcanzan su meta por mes.
- **Embudo de aportación:** vista de la ficha → apertura del checkout → pago completado (objetivo de conversión del piloto: ≥ 35 % desde la apertura del checkout) y tiempo mediano hasta pagar (≤ 15 s).
- **Otras:** % de campañas logradas, tiempo mediano de la doble firma, tasa de activación de la aportación voluntaria (sustituye al 75 % supuesto del business case), entidades activas, retención anual de entidades, aportaciones por campaña, satisfacción de las entidades (encuesta de 1 pregunta tras cada campaña).
- **Cómo se mide:** eventos de Plausible **sin datos personales** (`checkout_open`, `payment_success`, `share_click`, `idea_signed`) y consultas a nuestra base de datos para todo lo económico. El Super-Admin ve estas métricas en su panel.

---

## 10. Tono y microcopy

- **De tú, cálido, breve, concreto.** Una idea por frase. Verbos de acción en los botones (*Aportar 25 €*, *Firmar ahora*).
- **Sí:** *"Con tu aportación, 3ºB está más cerca de su tarde de cine."* · *"Si no llegamos a la meta, te devolvemos el 100 %."*
- **No:** *"Faltan las aportaciones de 7 familias de 3ºB."* · *"Tu deuda"* · *"propina"* · jerga como *"split transfer"* o *"escrow"* en público.
- Números siempre con su unidad y formato del idioma; fechas relativas cuando ayudan (*"quedan 5 días"*).

---

## 11. Plantillas de campaña (alta en 5 minutos)

Cada plantilla trae título, descripción, categoría, reto sugerido y una imagen de portada. La entidad solo ajusta presupuesto y fechas.

| Plantilla | Vertical | Formato | Categoría |
| :--- | :--- | :--- | :--- |
| Ventiladores para las aulas | Escolar | Presupuesto | Infraestructura y confort |
| Toldos y sombra en el patio | Escolar | Presupuesto | Patios y deporte |
| Pizarras digitales | Escolar | Presupuesto | Tecnología y recursos |
| Biblioteca de aula | Escolar | Presupuesto | Tecnología y recursos |
| Viaje de fin de curso | Escolar | Presupuesto | Comunidad y viajes (exenta) |
| Marcador LED del pabellón | Deportiva | Presupuesto | Patios y deporte |
| Equipaciones para las categorías base | Deportiva | Presupuesto | Patios y deporte |
| Instrumentos para la banda o la escuela de música | Cultural | Presupuesto | Tecnología y recursos |
| Fiesta solidaria con rifa | Todas | Taquilla / rifa | Taquilla y rifas |
| Becas para que nadie se quede fuera | Todas | Presupuesto | Solidaridad y becas (exenta) |
