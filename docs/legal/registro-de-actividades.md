# Registro de actividades de tratamiento

> **Documento:** `registro-de-actividades` (interno) · **Versión:** 2026-11-18 · **Estado:** VALIDADO por el promotor (2026-11-18) · **Idioma:** castellano
> **Qué es:** la lista de todo lo que KORUM hace con datos personales, que el artículo 30 del Reglamento General de Protección de Datos (RGPD) obliga a tener por escrito. Tiene dos partes: lo que KORUM hace como responsable (art. 30.1) y lo que hace por cuenta de las entidades, como encargado (art. 30.2).
> **Quién lo valida:** el promotor (decisión 41). No se publica. Se enseña a la Agencia Española de Protección de Datos si lo pide. El [contrato de encargo](contrato-de-encargo.md) (cláusula 4) se compromete a llevarlo.
> **De dónde sale:** de la [evaluación de impacto](evaluacion-de-impacto.md) (apartados 1.3 a 1.5 y 2.1), de la [tabla única de plazos](tabla-de-plazos.md) y del contrato de encargo (Anexos II y III). Si uno de ellos cambia, este registro se actualiza a la vez. Los números de los tratamientos (T1 a T16) son los mismos del apartado 1.3 de la evaluación; el T13 se divide aquí en dos filas (13a y 13b) porque tiene dos responsables.

---

## Lo esencial

1. Es la lista, exigida por la ley, de todo lo que KORUM hace con datos personales.
2. Tiene dos partes: lo que KORUM hace por su cuenta (apartado 2) y lo que hace por cuenta de las entidades (apartado 3).
3. **Validado por el promotor el 2026-11-18**, junto con la evaluación de impacto (decisión 62 de [CUMPLIMIENTO §8](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md)).
4. Las palabras («responsable», «encargado», «interés legítimo», «código seudónimo») están explicadas en el glosario de la [evaluación de impacto](evaluacion-de-impacto.md).
5. En la columna «Base legal», la letra que acompaña al artículo 6.1 del RGPD (por ejemplo, 6.1.b) es la razón que admite la ley: **a)** consentimiento, **b)** contrato, **c)** obligación legal y **f)** interés legítimo.

## 1. Datos comunes

| Dato | Valor |
| :--- | :--- |
| **Quién lleva este registro** | [[RAZÓN SOCIAL]], NIF [[NIF]], [[DOMICILIO SOCIAL]] («KORUM») |
| **Contacto de privacidad** | [[EMAIL DE PRIVACIDAD]] |
| **Delegado de protección de datos** | No designado: KORUM no está obligada |
| **Dónde se tratan los datos** | En la Unión Europea (la base de datos y los ficheros, en Fráncfort) |
| **Transferencias fuera del Espacio Económico Europeo** | No hay transferencias deliberadas: los datos se alojan en la Unión Europea. Los proveedores de grupos con sede en Estados Unidos podrían acceder desde allí; ese caso se cubre con el Marco de Privacidad de Datos UE-EE. UU. o con las cláusulas contractuales tipo de la Comisión Europea |
| **Medidas de seguridad** | Las del Anexo II del [contrato de encargo](contrato-de-encargo.md), que valen para todos los tratamientos |
| **Plazos de conservación** | Los de la [tabla única de plazos](tabla-de-plazos.md). En cada tratamiento se indica su apartado |
| **Proveedores (encargados de KORUM)** | Vercel (alojamiento), Supabase (base de datos y ficheros), Brevo (emails), Sentry (errores técnicos, sin datos personales), Plausible (estadísticas de visitas) y el proveedor de facturación |

## 2. Lo que KORUM trata como responsable (art. 30.1)

| # | Tratamiento | Para qué | De quién | Qué datos | Base legal | A quién se comunican | Plazos |
| :-: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| T1 | Cuentas y acceso | Identificar a la persona y darle acceso a lo suyo | Personas con cuenta | Nombre, email, idioma, sesiones, contraseña (solo su huella), verificación en dos pasos y llaves de acceso | Ejecución de lo contratado (art. 6.1.b) | Proveedores | Tabla §3.3 |
| T2 | Aportaciones, compras y devoluciones | Registrar el pago, enviar el recibo o la entrada, avisar del resultado y devolver el dinero | Familias, socios, vecinos y comercios que aportan o compran | Email, importe, fecha, medio de pago (sin sus números), grupo elegido, versión de las condiciones aceptadas | Ejecución de lo contratado (6.1.b) y obligaciones contables y fiscales (6.1.c) | PAYCOMET; proveedores | Tabla §3.1, §3.6 y §3.7 |
| T3 | Prevención del fraude y seguridad | Que cada familia firme una vez; detectar abusos; proteger las cuentas; poder demostrar quién firmó | Quien firma una idea, quien paga y quien entra en una cuenta | Cookie del dispositivo, código seudónimo de la conexión, rastros de seguridad y registro de auditoría. Con consentimiento, huella del navegador | Interés legítimo (6.1.f); la huella, consentimiento (6.1.a) | Proveedores; cada entidad, la parte del registro de auditoría que es su registro de actividad | Tabla §3.4 y §3.10 |
| T4 | Facturación de KORUM | Emitir sus facturas y registrarlas ante la Agencia Tributaria | Entidades, comercios y compradores | Nombre o razón social, NIF, concepto e importes | Obligación legal (6.1.c) | Agencia Tributaria; proveedor de facturación | Tabla §3.1 |
| T5 | Soporte de KORUM y solicitudes de derechos | Contestar las consultas y atender los derechos de las personas | Quien escribe a KORUM | Email, asunto, mensaje y respuesta; tipo, fechas, resultado y notas de la solicitud, con un código seudónimo del email | Ejecución de lo que se pide (6.1.b) y obligación legal (6.1.c) | Proveedores | Tabla §3.3 y §3.5 |
| T6 | Comprobación de cada entidad y relación con sus personas firmantes | Saber que la entidad existe y puede recibir pagos; avisar a quienes firman de lo que requiere su firma, de los cambios del servicio y de las facturas | Personas firmantes y quien representa a la entidad | Nombre, email, teléfono y cargo; documento de identidad de quien representa; resto de la documentación del titular | Interés legítimo (6.1.f; LOPDGDD, art. 19) | PAYCOMET, para dar de alta a la entidad; proveedores | Tabla §3.9 |
| T7 | Aportación mensual (Mi Hucha), apagada en el lanzamiento | Cobrar cada mes la donación que la persona programa | Quien la activa | Importe, meses, estado, versión aceptada e identificador de la tarjeta que da PAYCOMET (cifrado) | Ejecución de lo contratado (6.1.b) | PAYCOMET | Tabla §3.11 |
| T13a | Comercios: su pago, sus facturas y su contacto | Gestionar la aportación del comercio, facturarle y enviarle los avisos del servicio | Comercios que son autónomos y personas de contacto | Nombre, teléfono, email, dirección, NIF y domicilio fiscal | Ejecución de lo contratado (6.1.b), obligaciones de facturación (6.1.c) e interés legítimo para la persona de contacto (6.1.f; LOPDGDD, art. 19) | La entidad a la que apoya; PAYCOMET; proveedores | Tabla §3.8 |
| T14 | Estadísticas de visitas | Saber cuánto se usa la web, sin identificar a nadie | Quien visita la web | La dirección IP y el tipo de navegador, solo para calcular un código diario que no se guarda. Se conservan cifras agregadas | Interés legítimo (6.1.f) | Plausible | No se guardan datos personales |
| T15 | Equipo de KORUM | Dar acceso a la consola y registrar lo que hace cada persona | Personas del equipo | Nombre, email y registro de sus accesos | Ejecución de su contrato con KORUM (6.1.b) e interés legítimo en la seguridad (6.1.f) | Las entidades, cuando piden la lista de accesos a sus datos | Tabla §3.10 |

## 3. Lo que KORUM trata por cuenta de las entidades, como encargado (art. 30.2)

**Los responsables** son las entidades dadas de alta en la plataforma. Su lista, con su nombre, su titular legal y sus personas de contacto, está en la propia plataforma (consola de KORUM, «Entidades») y se puede extraer en cualquier momento. Cada una ha aceptado el [contrato de encargo](contrato-de-encargo.md), con su versión y su fecha.

| # | Tratamiento por cuenta de la entidad | Qué hace KORUM | De quién | Qué datos | Plazos |
| :-: | :--- | :--- | :--- | :--- | :--- |
| T8 | Buzón de ideas: moderación y conversación | Guarda las ideas y los mensajes y se los enseña a la entidad con un código, sin el email | Familias y socios | Textos de ideas y mensajes | Tabla §3.4 |
| T9 | Consultas de las familias a la entidad | Guarda la consulta y la respuesta, y envía la respuesta a la persona | Familias y socios | Texto de la consulta y de la respuesta | Tabla §3.5 |
| T10 | Certificados fiscales y Modelo 182 | Guarda los datos fiscales, genera el certificado y el fichero de la declaración | Donantes y comercios que piden certificado | NIF, nombre y apellidos, provincia e importe del donativo | Tabla §3.2 |
| T11 | Cargos de las personas firmantes, voluntarios y portería | Guarda quién firma y con qué cargo, envía las invitaciones, registra los relevos y las firmas; registra las lecturas de la portería y los canjes | Personas firmantes, voluntarios y asistentes | Cargo, invitaciones y relevos; nombre que el voluntario da a su móvil; qué entrada o vale se leyó y cuándo | Tabla §3.6 y §3.9 |
| T12 | Imágenes y textos publicados | Aloja y publica lo que la entidad sube, sin los datos ocultos de las imágenes | Quien aparezca en ellos | Imágenes y textos | Tabla §3.12 |
| T13b | Comercios: lo que la entidad hace con sus datos | Enseña a la entidad los datos del comercio para que lo revise, lo contacte, se lo agradezca y, en su caso, le facture; envía los mensajes de la entidad | Comercios y sus personas de contacto | Nombre, importe, contacto y, según el caso, datos de facturación o fiscales | Tabla §3.8 |
| T16 | Mensajes enviados en nombre de la entidad | Envía por email el texto que escribe la entidad, sin que esta vea el email de quien lo recibe | Familias y comercios | Email del destinatario y texto del mensaje | Tabla §3.5 |

**Transferencias fuera del Espacio Económico Europeo, proveedores y medidas de seguridad:** las transferencias y las medidas son las del apartado 1. Los proveedores autorizados para estos datos son los del Anexo III del contrato de encargo: Vercel, Supabase y Brevo, que los alojan o los envían, y Sentry, que solo recibe errores técnicos ya limpios de datos personales. Plausible y el proveedor de facturación no tratan datos de las entidades.

**Al terminar el contrato con una entidad:** KORUM le entrega lo que la ley le obliga a conservar a ella y guarda una copia bloqueada (sin uso, solo para una reclamación o una autoridad) hasta que vence el plazo de cada dato en la tabla §3.9 (LOPDGDD, art. 33.4).

## 4. Cómo se mantiene

- Este registro se revisa **a la vez que la evaluación de impacto**: una vez al año y siempre que se añada un tratamiento, un dato o un proveedor.
- El sprint que añade un tratamiento o un dato personal añade su fila aquí y en la tabla de plazos antes de cerrarse.
- Antes de publicar el contrato de encargo (Sprint 5.10a) se comprueba que este registro, el contrato y la política de privacidad dicen lo mismo.
