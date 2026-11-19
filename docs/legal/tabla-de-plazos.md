# Tabla única de plazos de conservación

> **Documento:** `tabla-de-plazos` (interno) · **Versión:** 2026-11-18 · **Estado:** VALIDADO por el promotor (2026-11-18) · **Idioma:** castellano
> **Qué es:** la lista completa de cuánto tiempo se guarda cada dato personal en KORUM, qué pasa cuando vence su plazo y si la aplicación ya lo hace. **Manda sobre cualquier otro documento que hable de plazos:** [CUMPLIMIENTO §6](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) la resume y remite aquí, la [política de privacidad §8](politica-de-privacidad.md) es su versión para el público y el código la aplica (`src/core/privacy/retention-policy.ts`).
> **Quién la valida:** el promotor (decisión 41). No se publica: es un documento interno que se enseña a la Agencia Española de Protección de Datos si lo pide, y a una entidad que lo solicite al amparo de su [contrato de encargo](contrato-de-encargo.md).

---

## 1. Cómo leerla

- **Dato:** qué se guarda, con palabras de la calle. Los nombres técnicos van en el [glosario de la evaluación de impacto](evaluacion-de-impacto.md).
- **Responde:** **KORUM** si es responsable del dato; **Entidad** si lo es la entidad y KORUM lo guarda por su cuenta, como encargado ([reparto de CUMPLIMIENTO §5.1](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md)). Si aparecen las dos, la fila dice qué parte es de cada una.
- **Plazo:** cuánto tiempo se guarda el dato de forma que identifique a alguien.
- **Después:** qué pasa al vencer. *Borrado* es que la fila o el fichero desaparece. *Se anonimiza* o *se vacía* es que la fila sigue (porque sostiene una cuenta, un recuento o un apunte contable) pero ya no dice de quién es.
- **Estado:**
  - **Hecho** quiere decir que la aplicación ya lo borra o lo anonimiza sola.
  - **Sprint X** quiere decir que todavía no: está decidido y lo construye ese sprint del [plan](../PLAN_IMPLEMENTACION_ATOMICO.md). La nota entre paréntesis cuenta qué hace hoy la aplicación.

## 2. Las cinco reglas de las que salen los plazos

1. **Lo que mueve dinero o lleva firma se guarda 6 años desde el cierre del ejercicio.** Es el plazo del Código de Comercio (art. 30) para los libros y justificantes: 6 años desde el último apunte de los libros, que en la práctica es el cierre del ejercicio. Hay otros dos plazos legales más cortos: 4 años de prescripción tributaria (Ley General Tributaria, art. 66) y 5 de las acciones personales (Código Civil, art. 1964.2). **Se aplica el más largo, 6 años, para no tener que distinguir.** Se cuenta por años naturales: un dato de 2026 vence el 1 de enero de 2033.
2. **Lo que no se puede borrar, se anonimiza.** El libro mayor (el registro contable de cada movimiento de dinero) y el registro de auditoría no admiten cambios ni borrados: lo impide la propia base de datos. Al vencer el plazo se quita lo personal y quedan los importes y las fechas, sin nadie detrás.
3. **El texto libre que escribe una persona dura poco.** Un mensaje puede contar más de lo que parece. Se guarda lo justo para atenderlo: 1 o 2 años.
4. **Lo que solo sirve para comparar dura 12 meses.** Los códigos seudónimos de la conexión y la huella del navegador, y los rastros de seguridad.
5. **Lo que no llegó a ser nada se borra pronto.** Un pago que no se completó o una invitación que nadie aceptó: 30 días. Un alta que nunca verificó su email: 7 días.

Un dato que alguien necesita para defenderse en una reclamación ya abierta se conserva, bloqueado, hasta que la reclamación termine, aunque su plazo haya vencido (RGPD, art. 17.3.e).

## 3. La tabla

### 3.1 Dinero, contabilidad y facturas

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Registro contable de cada movimiento de dinero (el libro mayor) | KORUM | 6 años desde el cierre del ejercicio | No se borra ni se puede cambiar. No lleva nombre ni email. Algunos apuntes llevan el identificador de una cuenta: siguen unidos a ella mientras exista y quedan sin nadie detrás cuando se suprime | Hecho |
| Aportaciones y compras: email, grupo elegido, importe, medio de pago (sin sus números) y número de pedido | KORUM | 6 años desde el cierre del ejercicio | Se quitan los emails y la aportación deja de estar unida a la cuenta de la persona, si la hizo con una. Quedan el importe, la fecha y el grupo, sin nadie detrás. Los cobros de una aportación mensual siguen unidos a la cuenta mientras exista (apartado 3.11) | Los emails, hecho. La separación de la cuenta, Sprint 5.10b (hoy sigue unida mientras la cuenta exista) |
| Avisos automáticos que PAYCOMET envía con cada cobro | KORUM | 6 años desde el cierre del ejercicio | Borrado | Hecho |
| Avisos de pago rechazados porque su firma no era válida | KORUM | 90 días | Borrado | Hecho |
| Facturas emitidas por KORUM (destinatario, concepto, importes) y su PDF | KORUM | 6 años desde el cierre del ejercicio | Se borra el PDF y se vacían el nombre y el NIF del destinatario. Quedan el número, los importes y la huella, para no romper la cadena de facturas | Sprint 5.20b (hoy se conservan sin plazo) |
| Liquidación de una campaña o del Fondo de actividades: importes, cuenta destino de la entidad, quién la pidió y quién la firmó | Entidad (las firmas) y KORUM (el pago) | 6 años desde el cierre del ejercicio | No se suprime a petición (RGPD, art. 17.3.b y e): es el justificante de una salida de dinero firmada. Las firmas no se pueden cambiar: siguen unidas a la cuenta de quien firmó mientras exista y quedan sin nadie detrás cuando se suprime. Lo mismo vale para quién pidió la liquidación | Hecho |
| Destino escrito del Fondo de actividades y su justificante | Entidad | Como la liquidación | No se puede cambiar ni borrar: forma parte de lo firmado. Por eso no debe llevar datos personales ([contrato de encargo](contrato-de-encargo.md), cláusula 5) | Hecho |
| Factura o presupuesto previo (proforma) del proveedor, subido y no adjuntado a ninguna liquidación | Entidad | 30 días | Borrado | Hecho |
| Factura o proforma del proveedor adjunta a una liquidación | Entidad | 6 años desde el cierre del ejercicio en que se adjunta | Borrado | Sprint 5.10b (hoy se borra a los 6 años justos de adjuntarse, algo antes de lo que marca la regla 1) |
| Datos de pago de un proveedor (titular, IBAN y NIF, cifrados) | Entidad | No se recogen en producción: el pago directo al proveedor está apagado | — | Sprint 5.19 (retira la opción) |
| Códigos de un solo uso para firmar (enlace y clave) | KORUM | 7 días después de usarse, caducar o anularse | Borrado | Hecho |
| Código seudónimo de la conexión guardado con cada firma | KORUM | 12 meses | Se vacía; la firma se conserva | Hecho |

### 3.2 Donativos con certificado fiscal

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| NIF (cifrado), nombre y provincia de quien pide certificado, unidos a su donativo | Entidad | 6 años desde el cierre del ejercicio del donativo. Desde el Sprint 5.22, ese ejercicio será el del año en que la campaña se consigue (decisión 28) | Borrado. Quedan el importe y la fecha | Hecho |
| Los mismos datos, si la persona suprime su cuenta antes | Entidad | Se conservan hasta su plazo, porque la entidad debe poder acreditar el donativo (RGPD, art. 17.3.b). Los de una donación que no da derecho a certificado se borran en el acto | Como la fila anterior | Hecho |
| NIF, provincia y código postal guardados en la cuenta para no volver a escribirlos | KORUM | Mientras exista la cuenta | Borrado al suprimirla | Hecho |
| Certificado fiscal y justificante de aportación | Entidad | No se guardan como fichero: se generan cada vez a partir de los datos anteriores | Dejan de poder generarse con el NIF cuando este se borra | Hecho |
| Fichero del Modelo 182 | Entidad | No se guarda en KORUM: se genera cuando una persona firmante lo descarga | — | Hecho |

### 3.3 Cuentas y acceso

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Cuenta: nombre, email, idioma y fecha de la última actividad | KORUM | Mientras la persona la use | Con 3 años sin actividad se le avisa por email; si no vuelve en 30 días, la cuenta se suprime (apartado 5). No se aplica a quien firma por una entidad ni a quien tiene una aportación mensual en marcha | Hecho |
| Alta que nunca verificó su email | KORUM | 7 días | Borrado | Sprint 5.10b (hoy se trata como una cuenta sin actividad) |
| Cuenta creada al invitar a alguien a firmar, que nunca aceptó (el nombre y el email los escribió otra persona) | Entidad | 30 días sin invitación abierta | Borrado | Hecho |
| Sesiones abiertas, con el código seudónimo de la conexión y el tipo de navegador | KORUM | 30 días desde la última visita | Borrado | Hecho |
| Enlaces y códigos de acceso por email | KORUM | Hasta que caducan: minutos, y 72 horas las invitaciones a firmar | Borrado en la tarea semanal siguiente | Hecho |
| Contraseña (solo su huella), verificación en dos pasos y llaves de acceso | KORUM | Mientras exista la cuenta o hasta que la persona las quite | Borrado | Hecho |
| Contadores que frenan los abusos (por ejemplo, demasiados intentos de entrar), ligados a un código seudónimo de la conexión | KORUM | Entre 1 minuto y 24 horas, según el límite | Borrado diario | Hecho |
| Consentimientos (quién, para qué, cuándo y con qué versión del texto) | KORUM | Mientras estén vigentes y 3 años más | Borrado | Hecho |
| Solicitudes de derechos (tipo, fechas, resultado, notas de quien la atiende y un código seudónimo del email) | KORUM | 3 años desde que se cierran | Borrado | Sprint 5.10b (hoy se conservan sin plazo) |

Los 3 años de las dos últimas filas son el plazo en que prescriben las infracciones más graves de la normativa de protección de datos (LOPDGDD, art. 72): durante ese tiempo KORUM tiene que poder demostrar que pidió el permiso y que atendió la solicitud.

### 3.4 Buzón de ideas

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Quién propuso una idea y quién la firmó (email, cuenta y dispositivo) | KORUM | Mientras dure la idea y 1 año más | Se anonimiza. El recuento de firmas no cambia | Hecho |
| Título de la idea, categoría y número de firmas | Entidad | Mientras la entidad esté en KORUM | Se conserva sin autor: es el historial del buzón de la entidad | Hecho |
| Descripción de la idea (texto libre de la familia) | Entidad | Mientras dure la idea y 1 año más | Se vacía | Sprint 5.10b (hoy se conserva) |
| Mensajes de la familia en la conversación de una idea | Entidad | Mientras dure la idea y 1 año más, o hasta que la persona suprima su cuenta | Borrado | Hecho |
| Respuestas de la entidad en esa conversación | Entidad | Como los mensajes de la familia | Borrado: sin la pregunta no se entienden y pueden aludir a una familia | Sprint 5.10b (hoy se conservan) |
| Dispositivo reconocido por la cookie del buzón y las cuentas vistas en él | KORUM | 13 meses sin usarse (lo que dura la cookie) | Borrado | Hecho |
| Código seudónimo de la conexión, en cada firma | KORUM | 12 meses | Se vacía | Hecho |
| Huella del navegador, solo con consentimiento | KORUM | 12 meses sin usarse el dispositivo en el buzón, o hasta que la persona retire el consentimiento | Se vacía | Hecho |
| Marca que impide firmar dos veces la misma idea a quien suprimió su cuenta | KORUM | Mientras dure la idea y 1 año más | Se sustituye por una marca sin relación con nadie | Hecho |

### 3.5 Soporte y comunicaciones

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Consulta a KORUM: email, asunto, mensaje y respuesta | KORUM | 2 años desde que se resuelve; si nunca se resuelve, desde que se abre. O hasta que la persona suprima su cuenta | Se vacían el email y los textos. Quedan el código, el tema y las fechas, para las estadísticas | Hecho |
| Consulta a la entidad sobre una campaña o un evento, y su respuesta | Entidad | Igual | Igual | Hecho |
| Consulta que una persona firmante escribe a KORUM en nombre de su entidad | KORUM | 2 años. Si esa persona suprime su cuenta se quita su email y el texto se conserva: es de la entidad | Se vacía | Hecho |
| Emails enviados: destinatario y contenido | KORUM (la entidad, en los que KORUM envía en su nombre) | 12 meses | Se vacían. Queda constancia de que se envió | Hecho |
| Texto de un email directo de KORUM a una entidad | KORUM | 12 meses | Se vacía | Sprint 5.10c (hoy se vacía al enviarse) |

### 3.6 Entradas, vales y portería

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Entrada o vale: email de quien compró y código QR | KORUM | Como su compra: 6 años desde el cierre del ejercicio | Se quita el email | Hecho para las entradas. Los vales llegan en el Sprint 5.14 |
| Lecturas de la portería (qué entrada, cuándo y si se admitió) y canjes de vales | Entidad | 1 año desde que se liquida el evento o la venta | Borrado | Hecho para las entradas (Sprint 5.13); los vales, en el 5.14c (hoy se conservan con el evento) |
| Nombre que un voluntario da a su móvil | Entidad | 90 días desde que caduca su sesión de portería | Se vacía | Hecho |
| Sesión de portería de un móvil (sin datos de la persona) | Entidad | Como las lecturas | Borrado | Hecho (Sprint 5.13) |

### 3.7 Votación de un proyecto más pequeño

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Email copiado en el voto | KORUM | 1 año desde que se cierra la votación, o hasta que la persona suprima su cuenta | Se anonimiza. El voto y el recuento se conservan | Hecho |
| Quién lanzó la votación (una persona firmante) | Entidad | Como el registro de auditoría (apartado 3.10) | Se desvincula de la cuenta | Sprint 5.10b (hoy se conserva sin plazo) |
| Relación entre el voto y la aportación desde la que se votó | KORUM | Mientras la aportación conserve su email (6 años desde el cierre del ejercicio) | Se suelta. Sirve para poder demostrar qué eligió cada persona si reclama su dinero | Sprint 5.17 (hoy se suelta al año, a la vez que el email) |

### 3.8 Comercios

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Comercio que empezó un pago y no lo completó (contacto y NIF cifrado) | KORUM | 30 días | Borrado, con su cobro fallido | Hecho |
| Contacto de un comercio con patrocinio (persona, teléfono, email, dirección y web) | KORUM, y la entidad desde que lo recibe | Mientras dure su distintivo y 1 año más | Se vacía | Sprint 5.16c (hoy se conserva sin plazo) |
| Contacto de un comercio que dona | KORUM, y la entidad desde que lo recibe | 5 años desde su última donación (decisión 52) | Se vacía | Sprint 5.16c (hoy se conserva sin plazo) |
| Datos de facturación del comercio (razón social, NIF cifrado y domicilio fiscal) | KORUM | 6 años desde el cierre del ejercicio de su último cobro | Se vacían | Sprint 5.16c (hoy se conservan sin plazo) |
| Logotipo y ventaja publicados | Entidad | Mientras dure su distintivo | Dejan de mostrarse; el fichero se borra | Sprint 5.24a (hoy dejan de mostrarse, pero el fichero no se limpia) |

Los datos de un comercio que es una sociedad no son datos personales. Sí lo son los de un autónomo y los de la persona de contacto, y por eso tienen plazo.

### 3.9 Entidades, personas firmantes y documentos

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Cargo de una persona firmante (quién firma y con qué cargo) | Entidad | Mientras lo ocupa | Se da de baja al relevarla. Sus firmas se conservan (apartado 3.1) | Hecho |
| Email y móvil de contacto que dio en el alta quien lleva la gestión principal | KORUM | Mientras ocupa el cargo | En el relevo, el email pasa a ser el de la persona nueva y el móvil se borra | Hecho |
| Historial de relevos (quién propuso, quién salió y quién entró) | Entidad | 6 años desde el cierre del ejercicio | Se desvincula de las cuentas y se vacía el nombre escrito de la persona invitada. Ese nombre se anonimiza antes si la persona suprime su cuenta | Sprint 5.10b (hoy se conserva sin plazo; el nombre sí se anonimiza al suprimir la cuenta) |
| Documentación del titular, incluido el documento de identidad de quien representa a la entidad | KORUM | Mientras la entidad esté en KORUM y 6 años más. El documento que se sustituye por otro, 6 años desde que se sustituye | Borrado | Hecho |
| Datos y contenidos de la entidad tras su baja (una suspensión no es una baja: mientras dura, todo se conserva igual) | Entidad | 30 días para descargar una copia, contados desde que termina lo que tenía en marcha; después se cierra el acceso | Se borra o se anonimiza lo que no tenga un plazo legal en esta tabla. De lo que la entidad está obligada a conservar (datos fiscales de sus donantes y su registro de actividad), KORUM guarda una copia bloqueada (guardada sin uso, solo para una reclamación o una autoridad) hasta que vence el plazo que cada uno de esos datos tiene en esta tabla: 6 años desde el cierre del ejercicio. Base: LOPDGDD, art. 33.4, con el bloqueo del art. 32 ([contrato de encargo](contrato-de-encargo.md), cláusula 14) | Sprint 5.10d (hoy la aplicación no tiene baja de entidad) |

### 3.10 Seguridad y auditoría

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Registro de auditoría de lo que mueve dinero o lleva firma (quién, qué y cuándo) | KORUM, y la entidad en su registro de actividad | 6 años desde el cierre del ejercicio | Se desvincula de la cuenta. La anotación se conserva, sin persona | Sprint 5.10b (hoy se conserva sin plazo) |
| Código seudónimo de la conexión y tipo de navegador de cada anotación del registro | KORUM | 12 meses | Se vacían | Hecho |
| Rastros de seguridad: intentos fallidos de entrar y accesos denegados | KORUM | 12 meses (decisión 35) | Se desvinculan de la cuenta | Sprint 5.10b (hoy siguen el plazo del registro) |
| Accesos del equipo de KORUM a los datos de una entidad | KORUM | 6 años, como el registro | Como el registro. Falta que las búsquedas de la consola que cruzan varias entidades anoten de qué entidad son | Hecho el registro; Sprint 5.10c (búsquedas) y 5.10b (separación de la cuenta a los 6 años) |
| Aperturas de un documento del titular | KORUM | 6 años, como el registro | Como el registro | Hecho el registro; Sprint 5.10b (separación de la cuenta a los 6 años) |
| Alertas de operación y lista de tareas pendientes del sistema (llevan, como mucho, el identificador de una cuenta, sin nombre ni email) | KORUM | 12 meses desde que la alerta se resuelve o la tarea termina | Borrado | Sprint 5.10b (hoy se conservan sin plazo) |

### 3.11 Mi Hucha (apagada en el lanzamiento)

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Aportación mensual: importe, meses, estado y versión de las condiciones aceptadas | KORUM | Mientras exista la cuenta: es el historial de la persona en *Mi cuenta* | Al suprimirse la cuenta queda sin nadie detrás. Cada cobro mensual es una aportación y sigue su fila del apartado 3.1 | Hecho |
| Identificador de la tarjeta que da PAYCOMET (cifrado) | KORUM | Mientras la aportación esté activa o en pausa (6 meses de pausa como mucho) | Se anula en el acto y se pide a PAYCOMET que la borre; si no responde, se reintenta cada semana | Hecho |

### 3.12 Imágenes públicas

| Dato | Responde | Plazo | Después | Estado |
| :--- | :--- | :--- | :--- | :--- |
| Logotipo, portada, imagen de campaña y fotos de antes y después | Entidad | Mientras la entidad las tenga publicadas | Al retirarlas dejan de mostrarse y el fichero se borra del almacén | Sprint 5.24a (hoy dejan de mostrarse, pero el fichero retirado no se limpia) |
| Imagen en la que una familia reconoce a su hijo o a su hija | Entidad | Se retira en 72 horas como máximo desde que lo pide | La retira la entidad y, si no, KORUM | Sprint 5.24a (hoy la entidad puede retirarla, sin plazo ni aviso) |

Las imágenes se publican sin sus datos ocultos (ni fecha, ni lugar, ni dispositivo).

### 3.13 En el dispositivo de cada persona

No están en los servidores de KORUM, pero se informa de ellos en la [política de cookies](politica-de-cookies.md):

| Qué | Plazo |
| :--- | :--- |
| Cookie de sesión | 30 días desde la última visita |
| Cookies temporales de acceso (verificación en dos pasos y llaves de acceso) | Unos minutos, solo mientras se entra |
| Cookie del buzón de ideas | 13 meses |
| Cookie de la portería | Hasta que caduca el PIN; como mucho, 48 horas |
| Lista de entradas y lecturas sin cobertura, en el móvil del voluntario | Hasta que se cierra la portería; como mucho, 3 días |
| Borrador de un pago y paso pendiente de una firma | Hasta que se cierra la pestaña |

### 3.14 Proveedores y copias de seguridad

| Dónde | Qué guarda | Plazo | Estado |
| :--- | :--- | :--- | :--- |
| Copias de seguridad de la base de datos | Todo lo anterior, tal como estaba el día de la copia | 30 días como máximo. Un dato borrado desaparece de las copias cuando estas rotan; si hubiera que restaurar una, se vuelven a aplicar las supresiones hechas desde su fecha, con una lista que se guarda fuera de la copia | Sprint 6.1a (se configura y se prueba con el proveedor real); el procedimiento para volver a aplicar las supresiones, Sprint 6.1c |
| Registro de errores (Sentry) | El error técnico, sin datos personales (se limpian antes de enviarlo) | 90 días | Sprint 6.1a (se configura en la cuenta real) |
| Registros técnicos del alojamiento (Vercel) y de la base de datos (Supabase) | Peticiones recibidas, con la dirección IP | 30 días como máximo | Sprint 6.1a |
| Envío de emails (Brevo) | Destinatario y resultado de cada envío | 12 meses como máximo, igual que la fila de emails enviados | Sprint 6.1b |
| Estadísticas de visitas (Plausible) | Recibe la dirección IP y el tipo de navegador de cada visita para calcular un código diario, que no conserva. Guarda solo cifras agregadas | No guarda datos personales | Sprint 5.26 (y su contrato de encargo, Sprint 6.1a) |
| Registro de las facturas de KORUM ante la Agencia Tributaria (proveedor de facturación) | El nombre y el NIF del destinatario de cada factura | Los de la factura: 6 años desde el cierre del ejercicio | Sprint 5.23 (y su contrato de encargo, Sprint 6.1a) |
| PAYCOMET | Los datos del pago y de la tarjeta | Los fija PAYCOMET, que es responsable de ellos | — |

## 4. Cómo se aplica

- **Tarea semanal de plazos** (`DATA_RETENTION_PURGE`). Recorre la tabla paso a paso, por lotes. Cada paso es independiente: si uno falla, los demás siguen, la tarea se reintenta y, si el fallo continúa, se abre una alerta en la consola. Nunca toca un apunte contable, un importe, una factura ni una firma: de ellos solo quita lo personal.
- **Limpieza diaria** (`OPS_HOUSEKEEPING`). Contadores de intentos, avisos de pago rechazados y códigos de firma caducados.
- **Supresión a petición.** La persona la pide desde *Mi cuenta* y se hace en el acto (apartado 5).
- **Cuentas sin actividad.** La tarea semanal envía el aviso a los 3 años y suprime la cuenta 30 días después si la persona no ha vuelto.
- **Solicitudes de derechos.** Vencen al mes. Una solicitud fuera de plazo abre una alerta crítica en la consola.
- **Los números de la tarea semanal viven en un solo sitio del código** (`src/core/privacy/retention-policy.ts`). Hoy quedan cinco plazos fuera de ese archivo (la documentación del titular, la factura de proveedor sin adjuntar, los avisos de pago rechazados, los códigos de firma y la duración de la sesión); el Sprint 5.10b los reúne en él, para que un plazo de esta tabla se cambie en un único lugar.

## 5. Qué pasa cuando una persona suprime su cuenta

| Se borra del todo | Sigue, pero sin su nombre | Se conserva porque la ley lo exige |
| :--- | :--- | :--- |
| Sesiones, contraseña, verificación en dos pasos, llaves de acceso y códigos pendientes | Nombre y email de la cuenta | Importes y fechas de sus aportaciones, sin nadie detrás (la contabilidad no se puede borrar) |
| Tarjetas guardadas, también en PAYCOMET | Email de sus compras, entradas y votos | NIF, nombre y provincia de sus donativos con certificado, hasta que vence su plazo |
| Mensajes que escribió en las conversaciones de sus ideas | Autoría de sus ideas y de sus firmas (queda una marca que impide firmar dos veces) | Sus firmas en liquidaciones, si firmó por una entidad en el pasado |
| Textos de sus consultas de soporte | Destinatario y contenido de los emails que se le enviaron | |
| NIF, provincia y código postal de la cuenta; huella del navegador | Su nombre en el historial de relevos | |

No se puede suprimir la cuenta de quien firma por una entidad (antes tiene que ocupar su cargo otra persona) ni la de una persona del equipo de KORUM con acceso a la consola.

## 6. Qué valida el promotor y qué falta por construir

### 6.1 Lo que se valida

La tabla anterior (CUMPLIMIENTO §6) tenía 22 filas; esta tiene 80. **El promotor validó los plazos el 2026-11-18** (decisión 61 de [CUMPLIMIENTO §8](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md)): confirmó los que ya estaban y aprobó, como estaban, los que eran una propuesta nueva. La tabla siguiente queda como registro de lo que se le pidió:

| Plazo | Para qué dato | Qué se pide al promotor |
| :--- | :--- | :--- |
| 7 días | Alta que nunca verificó su email | Decidir: propuesta nueva |
| 30 días | Pago de comercio sin completar; invitación a firmar sin aceptar; factura de proveedor sin adjuntar | Confirmar: ya está en el código |
| 30 días | Copia de los datos de una entidad tras su baja | Decidir: propuesta nueva |
| 30 días como máximo | Copias de seguridad y registros del alojamiento | Decidir: propuesta nueva |
| 90 días | Nombre del móvil del voluntario; avisos de pago rechazados | Confirmar: ya está en el código |
| 90 días | Errores técnicos, en el proveedor | Confirmar: se configura en el Sprint 6.1a |
| 12 meses | Alertas de operación y tareas del sistema, desde que se resuelven o terminan | Decidir: propuesta nueva |
| 12 meses | Códigos seudónimos de la conexión, huella del navegador (12 meses sin usarse) y contenido de los emails | Confirmar: ya está en el código |
| 12 meses | Rastros de seguridad; email directo de KORUM a una entidad | Nada: ya decidido (decisión 35, los rastros; punto `L-054` de CUMPLIMIENTO §9, el email directo) |
| 1 año tras el fin de la idea | Autoría y firmas de una idea, y mensajes de la familia | Confirmar: ya está en el código |
| 1 año tras el fin de la idea | Descripción de la idea y respuestas de la entidad | Decidir: propuesta nueva |
| 1 año tras la liquidación | Lecturas de portería y canjes de vales | Nada: ya validado con la política de privacidad |
| 1 año tras cerrarse la votación | Email copiado en el voto | Confirmar: ya está en el código |
| 1 año tras caducar el distintivo | Contacto de un comercio con patrocinio | Nada: ya validado con la política de privacidad |
| 2 años | Consultas de soporte | Confirmar: ya está en el código |
| 3 años | Cuenta sin actividad; consentimientos | Confirmar: ya está en el código |
| 3 años | Solicitudes de derechos | Decidir: propuesta nueva |
| 5 años | Contacto de un comercio que dona | Nada: ya decidido (decisión 52) |
| 6 años desde el cierre del ejercicio | Todo lo que mueve dinero o lleva firma | Confirmar: lo fija el Código de Comercio |
| 6 años desde el cierre del ejercicio | Registro de auditoría, historial de relevos y aportaciones hechas con una cuenta (después se desvinculan de la cuenta); destinatario de las facturas (después se vacía) | Decidir: propuesta nueva |

### 6.2 Lo que falta por construir

Todo lo que no está hecho tiene sprint:

| Qué cambia | Sprint |
| :--- | :-: |
| Rastros de seguridad desvinculados de la cuenta a los 12 meses (decisión 35) | 5.10b |
| Registro de auditoría, historial de relevos, quién lanzó una votación y aportaciones hechas con una cuenta: desvinculados de la cuenta a los 6 años | 5.10b |
| Alertas de operación y tareas del sistema, borradas a los 12 meses | 5.10b |
| Factura de proveedor adjunta: 6 años desde el cierre del ejercicio | 5.10b |
| Todos los plazos, reunidos en un solo archivo del código | 5.10b |
| Altas sin verificar, borradas a los 7 días | 5.10b |
| Descripción de las ideas y respuestas de la entidad en su conversación, a 1 año del fin de la idea | 5.10b |
| Solicitudes de derechos, 3 años desde que se cierran | 5.10b |
| El comentario del código que cita esta tabla deja de decir «a validar por el abogado» | 5.10b |
| Email directo de KORUM a una entidad, 12 meses | 5.10c |
| Las búsquedas de la consola que cruzan varias entidades anotan de qué entidad son | 5.10c |
| Baja de una entidad: copia de sus datos durante 30 días y cierre. Suspensión: la entidad consulta su panel, pero no publica, cambia, firma ni mueve dinero; no se borra nada | 5.10d |
| Lecturas y sesiones de portería, 1 año desde la liquidación | 5.13 (hecho) |
| Canjes de vales, 1 año desde la liquidación | 5.14c |
| Contacto y datos de facturación de los comercios | 5.16c |
| Relación entre el voto y la aportación | 5.17 |
| Datos de pago de proveedores: se retira la opción | 5.19 |
| Facturas de KORUM: se vacía el destinatario a los 6 años | 5.20b |
| Ejercicio del donativo: el del año en que la campaña se consigue | 5.22 |
| Retirada de una imagen en 72 horas y limpieza de los ficheros retirados | 5.24a |
| Copias de seguridad y plazos en las cuentas de los proveedores | 6.1a y 6.1b |
| Procedimiento para volver a aplicar las supresiones tras restaurar una copia | 6.1c |

## 7. Revisión

Esta tabla se revisa **una vez al año** y siempre que la plataforma empiece a tratar un dato nuevo (por ejemplo, al encender Mi Hucha). El sprint que añade un dato personal añade su fila aquí, con su plazo, antes de cerrarse.
