import { MAX_TICKETS_PER_ORDER } from '@/core/checkout/checkout-limits';
import type { PurgeRule, RateLimitRule } from './rate-limit';

/**
 * Límites de intentos de las entradas públicas que no tienen su propio servicio (Sprint 2.4). Cada regla lleva el prefijo de su clave, para
 * que la tarea de limpieza pueda purgar sus contadores caducados sin tocar los demás.
 */

/** Notificaciones de Paycomet con firma inválida desde una misma red: las válidas no cuentan (se devuelve el intento). */
export const WEBHOOK_INVALID_RULE: RateLimitRule & PurgeRule = { prefix: 'webhook:paycomet:ip:', limit: 60, windowMs: 60_000 };

/** Peticiones de enlace y código de firma por persona y objetivo: evita una avalancha de correos a quien firma. */
export const SIGNATURE_REQUEST_RULE: RateLimitRule & PurgeRule = { prefix: 'double-check:req:', limit: 5, windowMs: 10 * 60_000 };

/** Pedir una liquidación del Fondo de actividades (y retirarla y volver a pedirla) y reintentar su envío, por entidad (Sprint 4.2f). */
export const ACTIVITY_FUND_RULE: RateLimitRule & PurgeRule = { prefix: 'activity-fund:', limit: 10, windowMs: 60 * 60_000 };

/** Pedir (o cambiar) la liquidación de una campaña, subir su factura y reintentar su envío, por entidad (Sprint 4.4a). */
export const CAMPAIGN_PAYOUT_RULE: RateLimitRule & PurgeRule = { prefix: 'campaign-payout:', limit: 20, windowMs: 60 * 60_000 };

/** Decidir qué hacer con una campaña vencida (reembolsar o lanzar la votación), por persona y entidad (Sprint 4.4b). */
export const EXPIRED_DECISION_RULE: RateLimitRule & PurgeRule = { prefix: 'expired-decision:', limit: 10, windowMs: 60 * 60_000 };

/**
 * Votos de redimensionamiento por red (Sprint 4.4b): cada enlace ya es personal y vota una vez, pero sin tope se podrían probar enlaces sin fin. Es
 * generoso porque un colegio entero puede votar desde el mismo wifi.
 */
export const RESIZE_VOTE_RULE: RateLimitRule & PurgeRule = { prefix: 'resize-vote:ip:', limit: 60, windowMs: 15 * 60_000 };

/**
 * «Reenviarme mi enlace de voto» (Sprint 5.5b): por red (generoso: un colegio comparte wifi) y por email canónico (tres al día: nadie llena el buzón de otra
 * persona ni la bandeja de salida pidiendo su enlace una y otra vez).
 */
export const RESIZE_LINK_IP_RULE: RateLimitRule & PurgeRule = { prefix: 'resize-link:ip:', limit: 20, windowMs: 15 * 60_000 };
export const RESIZE_LINK_EMAIL_RULE: RateLimitRule & PurgeRule = { prefix: 'resize-link:email:', limit: 3, windowMs: 24 * 3_600_000 };

/** Emails de acceso (enlace, código, invitación) por destinatario: nadie puede llenar la bandeja de otra persona pidiendo enlaces. */
export const AUTH_EMAIL_RULE: RateLimitRule & PurgeRule = { prefix: 'auth:mail:', limit: 5, windowMs: 15 * 60_000 };

/**
 * Peticiones a Better Auth por red y ruta (`/api/auth/*`). Las ventanas las fija `auth-config.ts` (la más larga, 15 minutos); la clave
 * guarda el HMAC de la IP, nunca la IP en claro. La purga usa esa ventana más larga: un contador más viejo ya habría vuelto a cero.
 */
export const AUTH_REQUEST_PREFIX = 'auth:ip:';
export const AUTH_REQUEST_PURGE_RULE: PurgeRule = { prefix: AUTH_REQUEST_PREFIX, windowMs: 15 * 60_000 };

/**
 * Códigos TOTP o de respaldo probados **con una sesión ya abierta** (la de un enlace mágico, al pedir el segundo factor): por persona, para
 * que quien controle el correo no pueda probar códigos sin fin cambiando de red. Al iniciar sesión con contraseña ya los limita Better Auth.
 */
export const AUTH_SECOND_FACTOR_RULE: RateLimitRule & PurgeRule = { prefix: 'auth:2fa:', limit: 10, windowMs: 15 * 60_000 };

/** Altas de entidades por red: el formulario crea cuentas y envía invitaciones. */
export const REGISTRATION_RULE: RateLimitRule & PurgeRule = { prefix: 'register:ip:', limit: 5, windowMs: 60 * 60_000 };

/** Fallos seguidos de códigos TOTP o de respaldo con una sesión ya abierta: al octavo, 24 h de bloqueo y fuera las sesiones sin 2FA (antes de que salte el tope de 10 cada 15 min). */
export const AUTH_SECOND_FACTOR_FAILURE_RULE: RateLimitRule & PurgeRule = { prefix: 'auth:totp-fail:', limit: 8, windowMs: 24 * 3_600_000 };

/**
 * Pagos iniciados por red (checkout de familias, patrocinios y renovaciones de comercios y primera aportación mensual de Mi Hucha; Sprint 3.4, corregido en el Sprint 5.4). Es un **freno contra programas automáticos**, no una barrera para
 * personas: un acto con toda la comunidad conectada a la misma wifi del colegio (alguien pide aportar en directo y cientos de familias pagan a la vez) tiene que
 * poder cobrar sin que nadie vea un error. Con 30 cada 15 minutos (el valor original) la aportación 31 de una red compartida se rechazaba justo en el mejor
 * momento. Una donación no retiene nada, así que no hay nada que proteger con un tope bajo; y en taquilla el aforo ya lo cuida `CHECKOUT_SEATS_RULE`
 * (plazas retenidas por red y evento), que es lo que evita bloquear un evento sin pagar. 600 cada 15 minutos son 40 por minuto desde una misma red: un
 * salón de actos entero, y aun así corta un guion que lance miles de intentos.
 */
export const CHECKOUT_RULE: RateLimitRule & PurgeRule = { prefix: 'checkout:ip:', limit: 600, windowMs: 15 * 60_000 };

/**
 * Plazas de taquilla retenidas por red **y por evento** (auditoría del Sprint 3.4): el límite de pagos solo cuenta pedidos (entonces 30, hoy 600), y
 * 30 pedidos de 20 entradas ya dejaban agotado cualquier evento de colegio sin pagar nada. Cada compra consume tantas unidades como plazas retiene. El tope real es
 * `seatHoldLimit(ticketMax)`: un cuarto del aforo, nunca menos que una compra máxima (20, para que una red compartida como el wifi del colegio
 * pueda comprar) y nunca más que el propio aforo: en una rifa de 40 papeletas, una sola red no puede retenerlas todas.
 */
export const CHECKOUT_SEATS_RULE: RateLimitRule & PurgeRule = { prefix: 'checkout:seats:', limit: MAX_TICKETS_PER_ORDER, windowMs: 15 * 60_000 };
export function seatHoldLimit(ticketMax: number): number {
  const capacity = Math.max(1, Math.floor(ticketMax));
  return Math.min(capacity, Math.max(CHECKOUT_SEATS_RULE.limit, Math.ceil(capacity / 4)));
}

/**
 * Firmas de ideas por persona (Sprint 3.6): firmar es un clic y cada firma escribe en la auditoría; el tope impide que una cuenta robada o un
 * guion rellene el buzón de filas. Es muy superior a lo que firma una familia (unas pocas ideas abiertas a la vez).
 */
export const IDEA_SIGN_RULE: RateLimitRule & PurgeRule = { prefix: 'idea:sign:user:', limit: 40, windowMs: 10 * 60_000 };

/** Propuestas de ideas por red: el límite por persona (3 al día) lo aplica el servicio; este frena a quien abre cuentas nuevas desde una misma red. */
export const IDEA_PROPOSAL_RULE: RateLimitRule & PurgeRule = { prefix: 'idea:propose:ip:', limit: 12, windowMs: 60 * 60_000 };

/**
 * Exportaciones de datos personales por persona (Mi cuenta, Sprint 3.7): cada descarga descifra NIF y recorre todo su historial, y deja una
 * solicitud RGPD. Diez al día cubren de sobra el JSON y el PDF de varias pruebas; más que eso es un guion o una cuenta robada.
 */
export const ACCOUNT_EXPORT_RULE: RateLimitRule & PurgeRule = { prefix: 'privacy:export:user:', limit: 10, windowMs: 24 * 3_600_000 };

/** Intentos de suprimir la cuenta por persona: cada uno abre una solicitud y, si está bloqueado, deja rastro en la auditoría. */
export const ACCOUNT_ERASURE_RULE: RateLimitRule & PurgeRule = { prefix: 'privacy:erase:user:', limit: 5, windowMs: 24 * 3_600_000 };

/** Mensajes al centro por el chat anónimo de una idea, por persona (Sprint 3.9): el tope por idea lo aplica el servicio; este frena un guion. */
export const IDEA_CHAT_RULE: RateLimitRule & PurgeRule = { prefix: 'idea:chat:user:', limit: 20, windowMs: 60 * 60_000 };

/** Consultas de soporte por persona (Sprint 3.9): cada una crea una fila que alguien tiene que leer y un email de acuse. */
export const SUPPORT_TICKET_RULE: RateLimitRule & PurgeRule = { prefix: 'support:user:', limit: 5, windowMs: 60 * 60_000 };
/** Y un tope diario, para que no se pueda repartir un guion en una consulta cada 12 minutos. */
export const SUPPORT_TICKET_DAILY_RULE: RateLimitRule & PurgeRule = { prefix: 'support:day:user:', limit: 12, windowMs: 24 * 3_600_000 };

/** Consultas que la entidad escribe a KORUM desde su panel (Sprint 4.4c), por entidad: son prioritarias y alguien las tiene que leer, así que el tope es propio. */
export const SUPPORT_ORG_TICKET_RULE: RateLimitRule & PurgeRule = { prefix: 'support:org:', limit: 5, windowMs: 60 * 60_000 };
export const SUPPORT_ORG_TICKET_DAILY_RULE: RateLimitRule & PurgeRule = { prefix: 'support:day:org:', limit: 12, windowMs: 24 * 3_600_000 };

/** Emails directos de KORUM a una entidad desde la consola (Sprint 5.3): el texto es libre y sale con el nombre de la plataforma, así que tiene tope por entidad y día. */
export const CONSOLE_DIRECT_EMAIL_RULE: RateLimitRule & PurgeRule = { prefix: 'console:direct-email:org:', limit: 3, windowMs: 24 * 3_600_000 };
/** Y un tope global por persona y día: una sesión de Super-Admin robada no puede escribir a todas las entidades a la vez (auditoría de seguridad del 5.3, I3). */
export const CONSOLE_DIRECT_EMAIL_PERSON_RULE: RateLimitRule & PurgeRule = { prefix: 'console:direct-email:user:', limit: 20, windowMs: 24 * 3_600_000 };

/**
 * Subidas de documentos del titular por entidad (Sprint 4.2c): cada sustitución se conserva 6 años, así que una cuenta firmante robada o un guion no
 * puede llenar el almacén. Treinta a la hora cubren de sobra subir y corregir los cinco documentos varias veces.
 */
export const KYB_UPLOAD_RULE: RateLimitRule & PurgeRule = { prefix: 'kyb:upload:org:', limit: 30, windowMs: 60 * 60_000 };

/** Logotipo y portada por entidad (Sprint 4.2e, auditoría M5): cada subida escribe en el almacén. Veinte a la hora dan para probar varias imágenes. */
export const ENTITY_IMAGE_UPLOAD_RULE: RateLimitRule & PurgeRule = { prefix: 'brand:upload:org:', limit: 20, windowMs: 60 * 60_000 };

/**
 * Portería (Sprint 4.5, QA-SEC09). La ruta del PIN y las del escáner están expuestas a Internet y no exigen cuenta, así que un límite **global por red**
 * actúa antes de escribir nada más que su propio contador. Es generoso porque los voluntarios de un colegio comparten wifi, y sin IP válida todos caen
 * en el mismo grupo (`unknown-ip`).
 */
/** Intentos de entrar con un PIN, contando **todos** los eventos: recorrer identificadores de evento desde una red no puede llenar la auditoría. */
export const GATE_ENTRY_RULE: RateLimitRule & PurgeRule = { prefix: 'gate:entry:ip:', limit: 60, windowMs: 15 * 60_000 };
/** Peticiones de portería con sesión (lector, aforo, lista, sorteo, pantallas), también las de un token ya revocado que insiste. */
export const GATE_REQUEST_RULE: RateLimitRule & PurgeRule = { prefix: 'gate:req:ip:', limit: 1_200, windowMs: 60_000 };
/** Marca de «ya anotado en la auditoría» de un bloqueo: solo el primero de cada ventana deja fila (`AuditLog` no se puede purgar). */
export const GATE_BLOCK_NOTICE_RULE: RateLimitRule & PurgeRule = { prefix: 'gate:notice:', limit: 1, windowMs: 15 * 60_000 };
/** Marca de «ya anotado» de una sesión de portería cerrada que sigue intentando entrar: una fila por sesión y 6 horas, no una por petición. */
export const GATE_REJECTED_NOTICE_RULE: RateLimitRule & PurgeRule = { prefix: 'gate:rejected:', limit: 1, windowMs: 6 * 3_600_000 };

/**
 * PIN de portería creados o cambiados por persona firmante y entidad (Sprint 5.5b, M5 del 4.5). Cada PIN nuevo cierra las sesiones de la puerta y deja una fila
 * de auditoría (que no se purga): una cuenta firmante robada no puede echar a los voluntarios una y otra vez ni llenar la auditoría. Diez a la hora dan de sobra
 * para el día del evento (un cambio por si el PIN se filtra, otro por un voluntario que se va).
 */
export const GATE_PIN_SET_RULE: RateLimitRule & PurgeRule = { prefix: 'gate:pin-set:', limit: 10, windowMs: 60 * 60_000 };

/** Invitaciones a nuevos Super-Admin y comprobaciones de conexión de la consola (Sprint 5.4): dan acceso total o llaman a proveedores con sus credenciales, así que llevan tope. */
export const SUPERADMIN_INVITE_RULE: RateLimitRule & PurgeRule = { prefix: 'console:superadmin-invite:', limit: 5, windowMs: 24 * 3_600_000 };
export const CONNECTION_TEST_RULE: RateLimitRule & PurgeRule = { prefix: 'console:connection-test:', limit: 10, windowMs: 10 * 60_000 };
