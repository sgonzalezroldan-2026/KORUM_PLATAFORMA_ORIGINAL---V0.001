# Informe de la revisión crítica de producto · SESIÓN R1 (P12)

> **Qué es:** el repaso crítico de toda la aplicación que pidió el promotor, con las rifas ya retiradas y los vales construidos. Solo es un informe: no se ha cambiado nada de la aplicación.
> **Fecha:** 2026-11-21. **Quién lo ha hecho:** el revisor de experiencia (recorrido real en el navegador, móvil y escritorio), la especialista en psicología de comunidad (textos, emails y motivación) y Claude Fable 5.2 (negocio, control y automatismos, comprobación en el código y síntesis).
> **Para qué sirve:** para que el promotor elija qué entra en el [Sprint 5.25](PLAN_IMPLEMENTACION_ATOMICO.md). Lo que no elija queda descartado de forma expresa, no como deuda.
> **Estado: decidido por el promotor el 2026-11-21** (tabla al inicio del §6). El Sprint 5.25 queda en seis entregas, de la 5.25a a la 5.25f.
> **Este documento no manda sobre ningún tema:** es una propuesta. Lo que se apruebe se escribe en la ficha del 5.25 y, si cambia una regla, en su documento de la tabla de [AGENTS.md](../AGENTS.md) §0.

---

## 1. Lo esencial en una página

La aplicación hace mucho y lo hace bien por dentro. Lo que más margen de mejora tiene no es añadir funciones, sino **ordenar lo que ya existe** para que cada persona vea primero lo que le importa.

1. **A la familia se le esconde el botón de aportar.** Quien llega desde WhatsApp a una campaña ve, en el móvil, el avance y el botón «Aportar» casi dos pantallas más abajo; antes van los retos de cuatro cursos. Reordenar la ficha y fijar el botón abajo es el cambio más barato con más efecto.
2. **A la entidad nadie le dice qué toca hoy.** El panel abre con cupos, medallas y un menú de 11 secciones. Las firmas pendientes son un número pequeño dentro del menú, y la primera campaña aparece muy abajo. Falta un bloque «Hoy toca» con una acción por línea.
3. **Una frase de la ficha de los eventos con entradas no es verdad.** Dice «Devolución del 100 % si no se logra la meta», y desde el Sprint 5.13 un evento se liquida por lo vendido: solo se devuelve si se cancela o cambia de fecha. El pago sí lo dice bien. Hay que corregirlo antes de cobrar dinero real (propuesto para el Sprint 5.15).
4. **El momento de más ilusión no se aprovecha.** Tras pagar, la invitación a compartir es una frase genérica, y el recibo por email no dice cuánto falta ni trae un botón para compartir. La entidad ya escribe un agradecimiento, pero no viaja en el email de las fotos.
5. **Nada trae a la entidad de vuelta el curso siguiente.** No hay memoria del curso para la asamblea, ni aviso al empezar el curso, ni una forma sencilla de que un AMPA contento se lo cuente a otro. Son las palancas de retención y de crecimiento más baratas.
6. **La consola enseña primero las cifras y al final lo que pide acción.** Las alertas abiertas están a más de cinco pantallas de la portada. Y no existe un resumen diario por email que evite tener que entrar.
7. **El vocabulario se cruza.** La familia lee «iniciativa» en la ficha y «campaña» en el email; el panel habla de KYB, tramo, cofirma y TCO a una voluntaria.
8. **El caso de negocio es optimista en un tercio** (ver §7): con el IVA dentro y una activación realista de la aportación voluntaria, el ingreso por entidad baja de unos 1.114 € a unos 750 € al año. Ya está previsto recalcularlo en el Sprint 5.20a; lo que añade esta revisión es qué tres cosas mueven esa cifra.

**Propuesta:** el Sprint 5.25 en **cuatro entregas** (§5). La versión mínima son las dos primeras.

---

## 2. Cómo se ha hecho y qué no se ha podido ver

- **Recorrido real** de la aplicación compilada, con datos de demostración (4 entidades, 9 iniciativas), en móvil (430 px) y en escritorio (1440 px): portada, ficha, pago de invitado, entradas, vales, Mi cuenta, alta de entidad, panel, firma, Estudio, liquidaciones, ajustes y consola. Se hicieron dos compras simuladas en una base aparte, que se borra al cerrar la sesión.
- **Lectura de los textos** (catálogo en castellano, unas 500 páginas equivalentes), de las 61 plantillas de email y de los documentos de experiencia y de negocio.
- **Comprobación en el código** de cada hallazgo que aquí se da como hecho. Lo que es opinión o suposición se dice.
- **No se ha podido ver:**
  - Capturas de pantalla (la herramienta no dejó guardarlas fuera del repositorio): no hay juicio sobre color, contraste ni estética. Eso es de la SESIÓN V1.
  - La portería y el puesto de vales con la cámara de un móvil real (queda para el piloto).
  - El catalán y la accesibilidad con teclado, que tienen sus propias revisiones (SESIÓN I1 y P21).
  - La publicación real de una campaña y el pago de un comercio, que no se ejecutaron para no alterar los datos.

---

## 3. Las nueve hipótesis del registro (P12), una a una

| # | Hipótesis | Veredicto | Dónde queda |
| :-: | :--- | :--- | :--- |
| 1 | El embudo de aportación no se mide | **Confirmada.** No hay analítica conectada | Ya previsto: Sprint 5.26 |
| 2 | El panel necesita una «siguiente mejor acción» | **Confirmada y prioritaria.** El panel no tiene ninguna lista de tareas | R-11 |
| 3 | Falta un cuadro de control del promotor (embudo de entidades, inactivas, campañas en riesgo) | **Confirmada a medias.** El embudo ya está en el 5.26; faltan las entidades inactivas y las campañas en riesgo. Pero lo coherente con «Super-Admin mínimo» no es una lista para que el promotor llame, sino avisos automáticos a la entidad | R-26 y R-34 |
| 4 | Faltan bucles de crecimiento | **Confirmada.** No existe ningún «llévalo a otro colegio» ni recordatorio de compartir al final de una campaña | R-07 y R-25 |
| 5 | Simplificar el alta y aplazar el KYB | **Corregida.** El KYB ya está aplazado hasta la primera publicación. Sí sobran campos: el teléfono de la cofirma es obligatorio y no se guarda | R-15 |
| 6 | Memoria del curso | **Confirmada.** No existe nada parecido | R-24 |
| 7 | Reducir soporte con autoservicio | **Confirmada a medias.** Recibos, entradas y vales ya se recuperan entrando con el email. Faltan las preguntas de siempre en la ayuda y un camino de soporte para quien pagó como invitado. El cambio de email ya está en el 5.10b | R-08 |
| 8 | Un solo glosario aplicado por pruebas | **Confirmada.** El glosario existe, pero trata «iniciativa» y «campaña» como sinónimos y ninguna prueba vigila el vocabulario | R-38 |
| 9 | Control financiero: conciliación y ratios | **Cubierta casi entera.** La alerta de conciliación ya existe y el coste de devoluciones y contracargos es la decisión 72 (Sprint 5.20a). Falta un umbral automático por entidad | R-35 |

---

## 4. Tabla común de hallazgos

**Cómo leerla.** *Impacto:* Alto, Medio o Bajo, y sobre qué. *Esfuerzo:* S (hasta 2 h), M (medio día), L (una entrega), XL (varias). *Origen:* UX (revisor de experiencia), PS (psicología y textos), N (negocio, control y automatismos). Dentro de cada bloque, de más a menos valor.

### Bloque A · Que más familias aporten y lo compartan

| ID | Pantalla o flujo | Problema o idea | Impacto | Esfuerzo | Riesgo | Recomendación |
| :-- | :--- | :--- | :--- | :-: | :--- | :--- |
| **R-01** | Ficha de una campaña en el móvil | **Medido:** la página mide 3.011 px; el avance está a 1.473 y el botón «Aportar» a 1.615, casi dos pantallas. Antes van los retos de cuatro cursos. Idea: título → avance y días → botón → reto → desglose, y un botón fijo abajo en el móvil. *(UX-01, PS-13)* | Alto · conversión | M | Bajo. No cambia ningún texto oficial, solo el orden | **Hacer en 5.25a** |
| **R-02** | Pago de invitado en el móvil | **Medido:** el campo del email queda a 1.149 px, debajo de la barra de pago; el primer toque en «Pagar» solo lleva al campo. El curso (16 opciones) va desplegado y el certificado fiscal ocupa sitio. Idea: importe → email → pagar; curso plegado («¿De qué curso eres?»); el NIF, tras un enlace. *(UX-05)* | Alto · conversión | M | Medio. El texto oficial de la aportación voluntaria no se toca; la casilla de aceptación del 5.15 queda junto al botón | **Hacer en 5.25a** |
| **R-03** | Ficha y tarjeta de un evento con entradas | **Comprobado en el código** (`initiative-detail.tsx`): dice «Devolución del 100 % si no se logra la meta», que no es verdad en un evento (decisión 30). Además, entradas y vales enseñan «Independencia total de proveedores» y «Fecha límite», que no les corresponden. *(UX-02)* | Alto · confianza y legal | S | Bajo. El texto nuevo lo valida el promotor (decisión 4 del §6) | **Sprint 5.15**, antes del 5.25: no debe llegar a cobros reales |
| **R-04** | Recibo por email | El recibo solo ofrece «Ver la iniciativa». No dice cuánto falta ni trae un botón para compartir por WhatsApp. Es el email que más se abre. *(UX-10)* | Alto · difusión | S–M | Bajo. Sigue siendo un mensaje del servicio | **Hacer en 5.25a** |
| **R-05** | Pantalla tras pagar | La invitación a compartir es una frase («Comparte la iniciativa para que se sumen más familias») y el mensaje es genérico. Idea: botón principal de WhatsApp con el reto del curso en positivo («A 3º de Primaria solo le faltan 2 familias»). *(PS-01)* | Alto · difusión | S–M | Bajo. Sin nombres ni comparación entre cursos (Regla 03 §6) | **Hacer en 5.25a** |
| **R-06** | Email «Mirad cómo ha quedado» | **Comprobado:** la entidad ya escribe un agradecimiento (`thanksMessage`), pero el email lleva una frase fija de KORUM. Idea: que hable la entidad. *(PS-08)* | Alto · vínculo con las familias | S | Bajo | **Hacer en 5.25a** |
| **R-07** | Últimas 72 horas de una campaña | No existe ningún aviso. Idea: un único email a quien **ya aportó**, con lo que falta y un botón para compartir. Nunca a quien no aportó. *(PS-11, hipótesis 4)* | Alto · campañas conseguidas | M | Medio: hay que decidir si es un aviso del servicio o publicidad | **Decisión 2 del §6**; si es que sí, 5.25a |
| **R-08** | Ayuda y soporte | **Comprobado:** las 9 preguntas de la ayuda no incluyen «no me llega el recibo», «me equivoqué de email», «quiero mi entrada otra vez» ni «cambiar el NIF». Para escribir a soporte hay que iniciar sesión, y quien pagó como invitado no lo sabe. Idea: 4 preguntas nuevas y, en el recibo, «¿Algún problema con este pago?» con entrada por enlace. *(PS-25, UX-13)* | Medio-alto · soporte | S–M | Bajo | **Hacer en 5.25a** |
| **R-09** | Portada de la entidad | 5 pestañas fijas aunque estén vacías (una entidad nueva no tiene logros ni comercios); la primera campaña empieza a unos 1.000 px. Idea: enseñar solo las pestañas con contenido y bajar la altura de la cabecera. *(UX-11)* | Medio-alto · conversión | M | Medio: el buzón de ideas y los logros dan confianza; no deben desaparecer cuando hay algo | **Hacer en 5.25a** si cabe |
| **R-10** | Recibo y cuenta | Tras pagar nadie dice que con ese mismo email se entra, sin contraseña, a ver recibos, entradas y certificados. Una línea en el recibo lo resuelve. *(PS-29)* | Medio · soporte | S | Bajo | **Hacer en 5.25a** |
| **R-52** | Mi cuenta | **Medido:** 4.669 px y 8 secciones; las entradas y los certificados comparten página con privacidad y borrado de cuenta. Idea: lo de diario arriba y «Privacidad y acceso» en otra pantalla. *(UX-12)* | Medio · claridad | M | Bajo | **Matiz para el Sprint 5.10b**, que ya añade contenido a esa página |

### Bloque B · Que la entidad trabaje menos y sepa qué hacer

| ID | Pantalla o flujo | Problema o idea | Impacto | Esfuerzo | Riesgo | Recomendación |
| :-- | :--- | :--- | :--- | :-: | :--- | :--- |
| **R-11** | Panel: portada | **Comprobado:** no hay lista de tareas. Idea: bloque «Hoy toca» arriba, una línea por tarea y un botón: firma pendiente, campaña que cierra en 7 días y le falta, vencida sin decidir (con los días que quedan), comercio por moderar, fotos del Después sin subir, documentos por enviar, invitación de la cofirma sin aceptar, PIN de un evento cercano sin crear. Medallas y cupos, plegados debajo. Sin nada pendiente: «Todo al día». *(UX-03, PS-03, hipótesis 2)* | Alto · tiempo de la entidad y firmas a tiempo | L | Medio: decidir el orden de prioridad | **Hacer en 5.25b** |
| **R-12** | Panel: menú | **Comprobado:** 11 secciones; «Campañas vencidas» y «Fondo de actividades» se ven aunque estén vacías. Versión corta: ocultarlas cuando no hay nada y ordenar por uso. Versión larga: un solo apartado «Dinero» (liquidaciones, vencidas y fondo). *(UX-06)* | Alto · claridad | S–M la corta · L la larga | La larga cambia direcciones, enlaces de emails y pruebas | **Hacer en 5.25b** la corta; la larga, **probar en el piloto** si hace falta |
| **R-13** | Aprobaciones | **Medido:** 7.384 px en el móvil; las ideas que piden acción van mezcladas con las que solo recogen firmas, todas desplegadas. Idea: «Te toca a ti» abierto y «En marcha» plegado. *(UX-07)* | Alto · tiempo de la entidad | M | Bajo | **Hacer en 5.25b** |
| **R-14** | Firmar | **Medido:** 6 acciones y salir al correo (ir a Aprobaciones, buscar, pedir enlace, abrir el email, copiar el código, firmar). El enlace y el código viajan en el mismo email. Idea: firmar dentro del panel con el código de la aplicación de verificación, que quien firma ya usa para entrar. *(UX-04)* | Alto · tiempo y abandonos | M–L | **Alto: es seguridad.** Necesita al auditor de seguridad | **Decisión 3 del §6** |
| **R-15** | Alta de la entidad | **Comprobado:** unos 25 campos; el **teléfono de la cofirma es obligatorio y no se guarda**; provincia, municipio y código postal son tres campos; el idioma y la casilla de buscadores son ajustes, no datos del alta. *(UX-08, PS-02, hipótesis 5)* | Alto · altas completadas | S–M | Bajo | El teléfono, **matiz para el Sprint 5.10c** (ya toca el alta y es pedir un dato que no se usa); el resto, **5.25b** |
| **R-16** | Emails a quienes firman | **Comprobado:** «¡Meta conseguida!» termina en «El siguiente paso es la liquidación» e «Ir al panel», sin decir cuántas firmas ni cuánto se tarda. «Falta tu firma en {entidad}» no dice qué se firma. El aviso de relevo suena a despido. *(PS-05, PS-18, PS-19)* | Alto · firmas a tiempo | S | Bajo. El aviso de relevo es de seguridad: se suaviza, no se quita | **Hacer en 5.25b** |
| **R-17** | Lenguaje del panel | **Contado:** «liquidación» 76 veces, «cofirma» 19, «KYB» 12, «tramo» 12, «TCO» 5. Idea: «documentos de la entidad» por KYB, «segunda firma» por cofirma, «cobrar lo recaudado» junto a liquidación. *(PS-04)* | Alto · soporte y confianza | M | Medio: cambia textos que las pruebas y las condiciones ya usan | **Hacer en 5.25b**, con la decisión 5 del §6 |
| **R-18** | Estudio | Tres botones «Nueva…» en el Estudio y dos más en el panel; las campañas cerradas salen antes que las activas; el reto y la placa, desplegados. Idea: un botón con tres opciones, activas primero, reto plegado. *(UX-14)* | Medio-alto · tiempo | M | Bajo | **Hacer en 5.25b** |
| **R-19** | Estudio: meta alcanzable | El Estudio ya calcula cuántas aportaciones hacen falta para la pasarela, pero no lo usa para orientar. Idea: al fijar la meta, «Con aportaciones de 25 € necesitáis unas 230; vuestra última campaña tuvo 166». Una campaña que no llega no deja ingreso y cuesta devoluciones. *(N)* | Medio-alto · campañas conseguidas | M | Bajo. Es orientación, no bloquea | **Hacer en 5.25b** |
| **R-20** | Pizarra del Estudio | Cinco líneas con «tramo 4 %», «beca exenta» y «neto garantizado» a la vez. Idea: una frase («Recibiréis 5.610 €; la plataforma, 144 €; la pasarela, 79 €») y el detalle plegado. *(UX-15)* | Medio · comprensión | M | Medio: la pizarra tiene que seguir cuadrando al céntimo | **Probar en el piloto** con dos o tres voluntarias antes de tocar |
| **R-21** | Ajustes de la entidad | **Medido:** 6.154 px, 39 controles y 7 botones de guardar. *(UX-16)* | Medio | M | Bajo | **Probar en el piloto**: se entra poco |
| **R-22** | Demasiados emails a quienes firman | Una campaña vencida genera hasta 5 recordatorios, más los de ventana, fondo y eventos. Idea: un resumen diario. *(PS-17)* | Medio · ruido | M | Medio: agrupar puede esconder un aviso con plazo | **Probar en el piloto**: con «Hoy toca» (R-11) puede no hacer falta |
| **R-23** | Portería | No se pudo comprobar si el enlace y el PIN se pueden enviar a los voluntarios con un botón. *(UX-26)* | Medio | S–M | Bajo | **Probar en el piloto** |

### Bloque C · Que las entidades vuelvan y traigan a otras

| ID | Pantalla o flujo | Problema o idea | Impacto | Esfuerzo | Riesgo | Recomendación |
| :-- | :--- | :--- | :--- | :-: | :--- | :--- |
| **R-24** | Memoria del curso | No existe. Idea: una página y un PDF de una hoja, listos para la asamblea: lo conseguido, cuántas aportaciones, los logros con su Antes y Después, las ideas del buzón que llegaron a campaña, los comercios amigos por nombre y el equipo que firma. Con un botón para compartirla con las familias y otro para el relevo de firmantes. El mayor riesgo de abandono es el cambio de junta. *(PS-06, hipótesis 6)* | Alto · retención | L | Medio: sin importes por curso ni nombres de familias | **Hacer en 5.25c** |
| **R-25** | «Llévalo a otro colegio o club» | No existe. Idea: (1) tras conseguir una meta, en el email a quienes firman y en la página del logro, «¿Conocéis otro AMPA o club al que le vendría bien?», con un mensaje listo que enlaza a «Así lo consiguió {entidad}» y al alta; (2) una línea discreta en el pie de cada portada: «¿Lo quieres en tu colegio o club?»; (3) el alta anota de dónde viene, para medirlo. *(PS-12, N, hipótesis 4)* | Alto · crecimiento | M | Bajo sin incentivo. Con incentivo, decisión 6 del §6 | **Hacer en 5.25c** |
| **R-26** | Avisos automáticos a la entidad | **Comprobado:** ninguna plantilla avisa del ritmo de una campaña, ni del inicio de curso (los cupos se renuevan en silencio), ni a quien se dio de alta y no publicó. Idea: (a) a mitad de plazo y a 7 días, si la campaña va por debajo del ritmo, un email con el mensaje para compartir ya escrito; (b) al empezar el curso, «Vuestros 1.000 € exentos se han renovado»; (c) a los 7 y 21 días del alta sin campaña, las plantillas. Como mucho uno por semana y entidad. *(N, hipótesis 3)* | Alto · campañas conseguidas y activación | M–L | Medio: más emails; por eso el tope | **Hacer en 5.25d** |
| **R-27** | Campaña que no llega | A la entidad se le dice «ha terminado sin llegar a la meta»; a la familia, «Te hemos devuelto tu pago», sin más. Idea: textos que no suenen a fracaso y que digan qué se puede hacer. *(PS-09)* | Alto · confianza | S | Bajo | **Matiz para el Sprint 5.17**, que reescribe esos emails |
| **R-28** | Encuesta de una pregunta | No existe. Idea: tras pagar, en pantalla, «¿Qué te animó a aportar?»; a la entidad, al cerrar, «¿Cómo ha ido?». *(PS-07)* | Medio · aprendizaje | M | Bajo | **Matiz para el Sprint 5.26** |
| **R-29** | Aniversario del logro | Idea: un año después, «Hace un año ayudaste a…». *(PS-28)* | Medio | M | Medio: misma duda legal que R-07 | **Probar en el piloto**, según la decisión 2 |

### Bloque D · Que KORUM controle con menos trabajo

| ID | Pantalla o flujo | Problema o idea | Impacto | Esfuerzo | Riesgo | Recomendación |
| :-- | :--- | :--- | :--- | :-: | :--- | :--- |
| **R-30** | Consola: portada | **Medido:** 6.515 px; el detalle de las alertas, los repartos por resolver y la salud de precios está a partir de 5.432 px, debajo de seis tablas. Idea: «Requiere tu atención» primero (con la cola de documentos por revisar dentro) y el negocio debajo. *(UX-17, UX-18)* | Alto · tiempo del promotor | S–M | Bajo | **Hacer en 5.25d** |
| **R-31** | Resumen diario al Super-Admin | No existe. Idea: un email por la mañana: «Todo en orden» o la lista de lo que pide acción (alertas críticas, documentos esperando más de 48 h, consultas sin responder, avisos 💎 y 🚨). Así la consola solo se abre cuando hace falta. *(N)* | Medio-alto · tiempo del promotor | M | Bajo | **Hacer en 5.25d** |
| **R-32** | Avisos de funciones apagadas | La salud de precios enseña como crítico que Mi Hucha pierde 0,34 € por cargo, aunque saldrá apagada. *(UX-18)* | Medio | S | Bajo | **Matiz para el Sprint 5.15** |
| **R-33** | Mi Hucha visible | Se ve en la portada, en la ayuda y en su página. Al apagarla hay que quitarla de los cuatro sitios a la vez. *(UX-23)* | Medio | S | Medio: dejar un enlace roto | **Matiz para el Sprint 5.15** |
| **R-34** | Entidades inactivas y campañas en riesgo | No hay lista. *(UX-19, hipótesis 3)* | Medio · crecimiento | M | Bajo | **Matiz para el Sprint 5.26** (dos listas más en su pantalla); la acción la hacen los avisos de R-26 |
| **R-35** | Control financiero | La conciliación ya avisa y el coste de devoluciones y contracargos es la decisión 72. Falta un aviso automático cuando una entidad supera un porcentaje de contracargos o de devoluciones. *(N, hipótesis 9)* | Medio · riesgo de dinero | S–M | Bajo | **Matiz para el Sprint 5.20a** |
| **R-36** | Caso de negocio | Ver §7. *(N)* | Alto · decisiones de precio | S | — | **Matiz para los Sprints 5.20a y 5.26** |
| **R-37** | Hora de los emails | Con el plan gratuito del alojamiento las tareas corren una vez al día: «¡Lo hemos conseguido!» sale a las 01:45 de la madrugada siguiente. Con el plan de pago, cada minuto. *(N)* | Medio · experiencia | S | Bajo | **Matiz para el Sprint 6.1a**, donde ya está previsto el cambio de plan: comprobar además que ningún aviso a familias sale de madrugada |

### Bloque E · Vocabulario, textos y matices para sprints ya planificados

| ID | Pantalla o flujo | Problema o idea | Impacto | Esfuerzo | Riesgo | Recomendación |
| :-- | :--- | :--- | :--- | :-: | :--- | :--- |
| **R-38** | Vocabulario | **Contado en el portal de familias:** «iniciativa» 53 veces y «campaña» 19; «aportación» 40 y «donación» 14; «centro» 30 y «entidad» 48. Idea: una palabra por cosa y una prueba automática que lo vigile. *(PS-24, UX-20, hipótesis 8)* | Medio-alto · confianza y soporte | M | Bajo | **Hacer en 5.25b**, con la decisión 5 del §6 |
| **R-39** | «Hucha» | La palabra nombra cuatro cosas: la de la entidad, la de la iniciativa, Mi Hucha y, de lejos, el Fondo de actividades. *(PS-30, UX-20)* | Medio | S | Medio: es nombre de marca | **No tocar ahora.** Se decide el día que se encienda Mi Hucha |
| **R-40** | Vales agotados | «Aportar sin producto» es un término interno. Idea: «Aportar sin recibir vales». *(PS-16)* | Medio · claridad | S | Bajo; las condiciones siguen diciendo lo mismo | **Hacer en 5.25a** |
| **R-41** | Buzón de ideas | La introducción es una frase de 60 palabras; el aviso de una firma en revisión suena a sospecha; la casilla de protección habla de «código seudónimo». *(PS-22, PS-23)* | Medio · participación | S | Medio: es antifraude y privacidad | **Matiz para el Sprint 5.10c**, que ya toca esos textos |
| **R-42** | Comercios | La página no contesta «¿qué gano?»; el botón abre el pago de la primera campaña sin dejar elegir; el formulario tiene 10 campos; el email de bienvenida mezcla tres cosas. *(PS-20, PS-21, UX-24)* | Medio · comercios | M | — | **Matiz para el Sprint 5.16b** |
| **R-43** | Precios | La página no menciona los vales. *(UX-21)* | Medio · transparencia | S | Bajo | **Matiz para el Sprint 5.18** |
| **R-44** | Liquidaciones | Enseña a la vez el destino «a la entidad» y «al proveedor». *(UX-25)* | Medio | S | — | **Ya previsto en el Sprint 5.19** |
| **R-45** | Landing | 6.678 px y tres botones principales en la primera pantalla; el subtítulo tiene 45 palabras. *(UX-29, PS-26)* | Medio | S | — | **Matiz para el Sprint 5.29** |
| **R-46** | Retos por curso | Se ven cuatro cursos a la vez (14, 21, 33 y 28 familias de 35): cumple la regla, pero uno se compara. Sin nadie aún, «ningún grupo ha empezado» desanima. *(UX-28, PS-31, PS-32)* | Bajo-medio · clima | S | Medio | **Matiz para el Sprint 5.27** |
| **R-47** | Emojis y cabecera del móvil | Emojis en botones del panel y de firma; la cabecera ocupa dos filas. *(PS-27, UX-31)* | Bajo | S | — | **Matiz para la SESIÓN V1** |
| **R-48** | Detalles | «Cargando…» donde debería haber un esqueleto; la ficha 360º dice «documentos verificados» y lista los cinco como «Falta». *(UX-22, UX-30)* | Bajo | S | — | **Sprint 5.24b** (deuda menor) |
| **R-49** | Pago de vales | Con un solo vale, el fijo de 0,45 € pesa un 22 %. Idea: partir de 5 vales. *(UX-27)* | Bajo-medio | S | Bajo | **Probar en el piloto** |
| **R-50** | Textos oficiales largos | El pie del desglose tiene 40 palabras y la aportación voluntaria enumera tres ventajas. Son textos oficiales de la Regla 03. *(PS-14, PS-15)* | Medio | S | Alto: no se tocan sin tu aprobación | **No tocar.** Medir en el piloto y decidir con datos |
| **R-51** | Votar un proyecto más pequeño | La idea es buena, pero difícil de entender para una familia. *(PS-10)* | Medio | M | — | **Probar en el piloto** |

**Descartado en esta revisión:** la dirección «localhost:3000» que se veía en el alta y en los enlaces de compartir, y cuatro errores de carga en la pantalla de acceso. Los dos son efectos del montaje de esta revisión, no fallos de la aplicación.

---

## 5. Propuesta para el Sprint 5.25

La ficha del plan preveía de una a tres entregas de 5–7 h. **La recomendación son cuatro entregas de 6–8 h** (entre 24 y 32 horas), porque los hallazgos de más valor son de cuatro tipos distintos. Todas con Claude Sonnet 5.5 en esfuerzo alto y la auditoría del revisor de experiencia y del verificador de pruebas; ninguna mueve dinero.

| Entrega | Qué resuelve | Hallazgos | Duración |
| :--- | :--- | :--- | :-: |
| **5.25a · Que más familias aporten y lo compartan** | Ficha reordenada con botón fijo, pago en una pantalla, recibo y pantalla final que invitan a compartir, agradecimiento de la entidad, ayuda completa | R-01, R-02, R-04, R-05, R-06, R-08, R-09, R-10, R-40 (y R-07 si se aprueba) | 6–8 h |
| **5.25b · Que la entidad sepa qué hacer hoy** | «Hoy toca», menú corto, aprobaciones ordenadas, alta más breve, emails a firmantes que dicen qué hacer, lenguaje llano, Estudio más directo y meta alcanzable | R-11, R-12 (corta), R-13, R-15, R-16, R-17, R-18, R-19, R-38 | 6–8 h |
| **5.25c · Que vuelvan y traigan a otras** | Memoria del curso y «llévalo a otro colegio o club» | R-24, R-25 | 6–8 h |
| **5.25d · Avisos automáticos y consola** | Avisos a la entidad (ritmo, inicio de curso, alta sin campaña), consola con lo urgente arriba y resumen diario al Super-Admin | R-26, R-30, R-31 | 6–8 h |

- **Versión mínima:** 5.25a y 5.25b (12–16 h). Son las que tocan lo que una familia y una voluntaria ven cada día.
- **Fuera del 5.25, antes:** R-03 (la frase falsa de las entradas), en el Sprint 5.15.
- **Entrega aparte, solo si se aprueba:** R-14 (firmar dentro del panel), con Claude Opus 5.5 y el auditor de seguridad, 4–6 h.
- **Matices repartidos en sprints que ya existen** (no añaden sesiones): 5.10b, 5.10c, 5.15, 5.16b, 5.17, 5.18, 5.20a, 5.24b, 5.26, 5.27, 5.29, SESIÓN V1 y 6.1a. Están anotados en sus fichas.
- **Para el piloto:** R-20 a R-23, R-29, R-49, R-50 y R-51.

---

## 6. Decisiones que necesito de ti

> **Contestadas por el promotor el 2026-11-21.** Lo que sigue conserva la pregunta tal como se le planteó; esta tabla dice qué decidió y dónde queda.
>
> | # | Decisión del promotor | Dónde queda |
> | :-: | :--- | :--- |
> | 1 | Las cuatro entregas | Sprints 5.25a a 5.25d |
> | 2 | El email de las últimas 72 horas se envía como aviso del servicio | Decisión 82 de [CUMPLIMIENTO §8](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md); Sprint 5.25a |
> | 3 | Firmar las ideas dentro del panel; liberar dinero no cambia | Sprint 5.25f, con el auditor de seguridad |
> | 4 | **Distinto de lo propuesto:** en los eventos con entradas no se pone ninguna frase de devolución; las condiciones de devolución son las de la ley y las que acepta quien compra. Los demás cambios de texto, aprobados | Decisión 83; Sprint 5.15 |
> | 5 | Las familias leen siempre «iniciativa»; en el panel, palabras llanas | Sprint 5.25b |
> | 6 | **Distinto de lo recomendado:** sí hay premio. La entidad que recomienda a otra recibe sola un importe exento para una siguiente campaña, se le avisa, y la consola lo informa y permite controlar el importe | Decisión 84; Sprints 5.25c (código y alta) y 5.25e (exención y consola) |
>
> El Sprint 5.25 queda en **seis entregas** (entre 34 y 46 horas). Sus fichas, con el alcance cerrado, están en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md).

### Decisión 1 · Cuánto entra en el Sprint 5.25

- **Qué pasa hoy:** el plan reserva de una a tres entregas; el informe encuentra trabajo de valor para cuatro.
- **Opciones:** (a) la versión mínima, 5.25a y 5.25b, unas 12–16 horas; (b) las cuatro entregas, 24–32 horas; (c) elegir hallazgo por hallazgo.
- **Recomendación: (b).** La (a) mejora el día a día; la memoria del curso, la recomendación entre entidades y los avisos automáticos son lo que hace que una entidad repita y traiga a otra, que es de lo que vive el negocio.

### Decisión 2 · Un email a quien ya aportó, en las últimas 72 horas

- **Qué pasa hoy:** quien aporta recibe su recibo y, si se consigue, «¡Lo hemos conseguido!». Mientras tanto, nada.
- **Ejemplo:** Laura aportó 25 € a los ventiladores. Quedan 3 días y falta un 8 %. Hoy no se entera. Con el aviso recibiría: «Faltan 3 días y un 8 % para los ventiladores. Si no se llega, te devolvemos tus 25 €. Ya has hecho tu parte; si te apetece, compártelo».
- **Opciones:**
  - (a) Enviarlo como aviso del servicio: informa de qué va a pasar con su dinero. Una sola vez, solo si la campaña está entre el 50 % y el 99 %.
  - (b) Enviarlo solo a quien marque una casilla opcional en el pago («Avisadme del avance de lo que apoyo»).
  - (c) No enviarlo.
- **Recomendación: (a).** Habla del destino de su propia aportación, igual que los dos emails que ya se envían a quienes donaron, y no añade otra casilla a un pago que en el 5.15 ya gana una obligatoria. La especialista en psicología prefiere la (b) por prudencia. Es una decisión con lado legal: la validas tú.

### Decisión 3 · Firmar las ideas dentro del panel

- **Qué pasa hoy:** para firmar, quien firma pide un enlace, abre su correo, copia un código de 6 dígitos y vuelve. Son 6 pasos. El enlace y el código llegan en el mismo email.
- **Ejemplo:** Marta ya ha entrado al panel con su contraseña y el código de su aplicación de verificación. Para aprobar la idea de los micrófonos tiene que salir al correo y volver.
- **Opciones:**
  - (a) Dejarlo como está.
  - (b) Para aprobar ideas (no mueve dinero), firmar en el panel tecleando el código de la aplicación de verificación. Para liberar dinero, seguir como hoy.
  - (c) Lo mismo también para liberar dinero.
- **Recomendación: (b),** en una entrega aparte y con el auditor de seguridad. Va en la línea de tu principio de menos fricción donde no hay dinero. La (c) no la propongo sin que el auditor la estudie.

### Decisión 4 · La frase de garantía de los eventos con entradas

- **Qué pasa hoy:** la ficha de un evento dice «Devolución del 100 % si no se logra la meta». No es verdad: un evento se celebra y se liquida por lo vendido.
- **Propuesta de textos:** en un evento, «🔒 Devolución del 100 % si el evento se cancela»; en una venta de vales se mantiene el actual («Devolución del 100 % en 14 días si no gastas ningún vale»); en una campaña se mantiene el actual. En entradas y vales se quita «Independencia total de proveedores» y «Fecha límite» pasa a ser «Venta hasta el…».
- **Recomendación:** aprobar esos textos y corregirlo en el Sprint 5.15.

### Decisión 5 · Una palabra para cada cosa

- **Qué pasa hoy:** la familia lee «iniciativa» en la ficha y «campaña» en algunos emails; el panel usa las dos.
- **Opciones:**
  - (a) Para las familias, siempre «iniciativa», que es la palabra de los textos oficiales («hucha de la iniciativa», «si la iniciativa no se consigue»); en el panel, «campaña» para las de presupuesto, «evento» y «venta de vales».
  - (b) «Campaña» en todas partes, cambiando los textos oficiales.
  - (c) Dejarlo.
- **Recomendación: (a),** con una prueba automática que impida que «campaña» vuelva a los textos de las familias. En el panel, además: «documentos de la entidad» en vez de KYB y «segunda firma» en vez de cofirma. «Liquidación» se queda, porque es la palabra de las condiciones, acompañada de «cobrar lo recaudado» la primera vez.

### Decisión 6 · ¿Premiar a la entidad que recomienda?

- **Qué pasa hoy:** no hay forma de recomendar ni premio.
- **Ejemplo:** el AMPA del Cervantes recomienda KORUM al AMPA de otro colegio, que publica su primera campaña. Con premio, las dos ganarían 500 € más de importe exento ese curso. A KORUM le cuesta, como mucho, la comisión de esos 500 €: unos 25 € por entidad.
- **Opciones:** (a) recomendación sin premio; (b) con premio en importe exento, nunca en dinero.
- **Recomendación: (a) ahora,** y decidir el premio con los datos del piloto. Si entonces las recomendaciones traen altas, 25 € por entidad nueva es una captación muy barata.

---

## 7. Los números del negocio

Cálculo propio sobre el centro tipo del [caso de negocio](BUSINESS_CASE_Y_ROADMAP.md) §2 (450 familias, dos campañas, un evento y tres comercios), con el IVA dentro de las comisiones (decisión 21) y Mi Hucha apagada. Es una estimación para orientar, no un dato medido.

| Fuente | Caso de negocio | Con IVA dentro y activación del 30 % |
| :--- | :-: | :-: |
| Aportación voluntaria (320 aportaciones × 1,80 €) | 432 € (al 75 %) | 173 € |
| Comisión por tramos | 400 € | 331 € |
| Gestión de comercios | 150 € | 150 € |
| Gastos de gestión digital, menos la pasarela | 120 € | 93 € |
| Mi Hucha | 12 € | 0 € |
| **Total por entidad y año** | **1.114 €** | **unos 750 €** |

- Con 45 entidades el primer año, eso son unos 33.600 € de ingreso frente a 42.200 € de costes previstos: el primer año no sale en positivo, y harían falta unas 57 entidades activas para cubrirlo.
- **Qué mueve la cifra, por orden:**
  1. **Cuántas campañas llegan a la meta.** Una que no llega no deja ingreso y cuesta devoluciones. De ahí R-01, R-02, R-07, R-19 y R-26.
  2. **Cuánta gente marca la aportación voluntaria.** Cada 10 puntos son unos 58 € por entidad y año. El texto es oficial y la casilla va desmarcada: no se toca, pero hay que medirlo desde el primer día del piloto (Sprint 5.26).
  3. **Que la entidad repita y traiga a otra.** De ahí R-24, R-25 y R-26.
- El recálculo completo del caso de negocio ya está previsto en el Sprint 5.20a.

---

## 8. Lo que funciona y no debe tocarse

1. **El pago de invitado:** tres toques, un solo email, importe sugerido ya marcado y la aportación voluntaria desmarcada. Solo cambia el orden de los campos.
2. **El recibo:** claro, breve y con la garantía bien dicha.
3. **Los retos por curso en positivo** y la imagen para WhatsApp «sin nombres ni comparaciones».
4. **El arco de los emails a quienes donaron:** «¡Lo hemos conseguido!» y, semanas después, «Mirad cómo ha quedado».
5. **El pase de vales:** lo que queda, el QR, la devolución con su fecha y el envío por WhatsApp. Es la pantalla más clara de la aplicación.
6. **La pantalla final de la firma:** qué se firma, cuándo caduca y un solo campo.
7. **La fila de cifras de Liquidaciones** y su cuenta atrás.
8. **«De un vistazo» en la consola** y las tablas que se ordenan. Solo falta subir lo que pide acción.
9. **El contenido de la ficha pública** (hucha, fecha, desglose de cuatro líneas y su pie): respeta las reglas. El problema es el orden, no lo que dice.
10. **La frase del Auto-Impulso** y la respuesta de la ayuda sobre el anonimato en el buzón («solo ven un código como #FAM-1234»).

---

## 9. Textos de ejemplo

Son propuestas para que se vea el tono. Ninguno cambia un texto oficial de la Regla 03, y todos se revisan al construir cada entrega.

- **Tras pagar (R-05), botón de WhatsApp:** «He aportado a «Ventiladores para Primaria» del CEIP Cervantes. A 3º de Primaria solo le faltan 2 familias para su tarde de cine. ¿Te sumas?»
- **Recibo (R-04):** «Ya va el 98 %: faltan 100 € y quedan 33 días. Si conoces a alguien a quien le importe, compártelo.»
- **Últimas 72 horas (R-07):** «Faltan 3 días y un 8 % para «Ventiladores para Primaria». Si no se llega, te devolvemos tus 25 €. Ya has hecho tu parte; si te apetece, compártelo.»
- **Meta conseguida, a quienes firman (R-16):** «Queda un paso: liberar el dinero. Hacen falta vuestras dos firmas, son unos 2 minutos cada una y tenéis 29 días. Empieza tú: [Firmar ahora].»
- **Asunto de la firma (R-16):** «Falta tu firma para liberar el dinero de «Toldos del patio»», en lugar de «Falta tu firma en CEIP Cervantes».
- **Campaña que no llega, a la familia (R-27):** ««Pizarras para ESO» no ha llegado a su meta. Tus 25 € vuelven a tu tarjeta; no tienes que hacer nada. Gracias por intentarlo con nosotros.»
- **Campaña que no llega, a la entidad (R-27):** ««Pizarras para ESO» ha reunido 8.400 € de 12.000 €. Las familias ya han dicho cuánto quieren esto. Tenéis dos caminos: proponerles un proyecto más pequeño o devolver el dinero.»
- **«Hoy toca» (R-11):** «Firmar la idea de los micrófonos (1 minuto)» · «Los ventiladores cierran en 7 días y faltan 100 €: compartid el enlace» · «Subir las fotos del Después de los toldos (2 minutos)». Sin nada pendiente: «Todo al día».
- **Recomendación entre entidades (R-25):** «¿Conocéis otro AMPA o club al que le vendría bien? Enviadles cómo lo habéis conseguido.»
- **Vales agotados (R-40):** «Aportar sin recibir vales», en lugar de «Aportar sin producto».
