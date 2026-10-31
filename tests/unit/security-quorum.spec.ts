import { describe, expect, it } from 'vitest';
import { evaluateIdeaSignatureFraud } from '@/core/security/device-quorum.service';
import { createDeviceCookieValue, DEVICE_COOKIE, hashIpSubnet, ipSubnet, readDeviceCookieId } from '@/core/security/device-signals';
import { InvalidEmailError, isDisposableEmail, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { evaluateSemanticLock } from '@/core/security/semantic-lock';
import { computeSignatureHash, ideaTargetDigest, payoutTargetDigest, verifySignatureHash } from '@/core/security/signature-hash';

const SECRET = 'secreto-de-pruebas-de-seguridad-0123456789';

describe('QA-SEC02 · email canónico', () => {
  it.each([
    ['laura.gomez+1@gmail.com', 'lauragomez@gmail.com'],
    ['Laura.Gomez@GoogleMail.com', 'lauragomez@gmail.com'],
    ['  l.a.u.r.a+x+y@gmail.com ', 'laura@gmail.com'],
    ['nombre+2@colegio.es', 'nombre@colegio.es'],
    ['nombre.apellido@colegio.es', 'nombre.apellido@colegio.es'],
    ['ana@colegio.es.', 'ana@colegio.es'],
    ['ａｎａ@gmail.com', 'ana@gmail.com']
  ])('%s → %s', (raw, canonical) => {
    expect(normalizeCanonicalEmail(raw)).toBe(canonical);
  });

  it.each(['', 'sin-arroba', 'a@b@c.es', '@colegio.es', '+solo@colegio.es', '...@gmail.com', 'ana@localhost', 'ana maria@colegio.es', 'ana\u200B@gmail.com'])('rechaza «%s»', (raw) => {
    expect(() => normalizeCanonicalEmail(raw)).toThrow(InvalidEmailError);
  });

  it('detecta dominios desechables y sus subdominios, sin confundir parecidos', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@a.b.mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@notmailinator.com')).toBe(false);
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
  });
});

describe('QA-SEC02 · regla padre y madre', () => {
  const evaluate = (deviceAccountOrder: number, ipBurstSignaturesLast10Min = 0) => evaluateIdeaSignatureFraud({ deviceAccountOrder, ipBurstSignaturesLast10Min });

  it('1ª y 2ª cuenta verificadas; la 3ª, sospechosa', () => {
    expect(evaluate(1)).toEqual({ status: 'VERIFIED', reasonKey: 'ideas.audit.firstAccount', deviceAccountOrder: 1 });
    expect(evaluate(2)).toEqual({ status: 'VERIFIED', reasonKey: 'ideas.audit.secondAccount', deviceAccountOrder: 2 });
    expect(evaluate(3)).toEqual({ status: 'SUSPICIOUS', reasonKey: 'ideas.audit.tooManyAccounts', deviceAccountOrder: 3 });
  });

  it('la ráfaga empieza justo en 6 firmas previas', () => {
    expect(evaluate(1, 5).status).toBe('VERIFIED');
    expect(evaluate(1, 6)).toMatchObject({ status: 'SUSPICIOUS', reasonKey: 'ideas.audit.ipBurst' });
  });
});

describe('señales del dispositivo', () => {
  it('la cookie es la acordada y solo vale sin alterar', () => {
    expect(DEVICE_COOKIE.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
    const value = createDeviceCookieValue(SECRET);
    const [id, signature] = value.split('.') as [string, string];
    expect(readDeviceCookieId(SECRET, value)).toBe(id);
    expect(readDeviceCookieId(SECRET, `${id}.${'0'.repeat(signature.length)}`)).toBeNull();
    expect(readDeviceCookieId(`${SECRET}-otro`, value)).toBeNull();
    expect(readDeviceCookieId(SECRET, `${value}.extra`)).toBeNull();
    expect(readDeviceCookieId(SECRET, undefined)).toBeNull();
  });

  it.each([
    ['83.45.12.200', '83.45.12.0/24'],
    ['::ffff:83.45.12.200', '83.45.12.0/24'],
    ['::ffff:532d:0cc8', '83.45.12.0/24'],
    ['2001:db8:abcd:12::1', '2001:0db8:abcd::/48'],
    ['2001:0DB8:ABCD:0012:0000:0000:0000:0001', '2001:0db8:abcd::/48'],
    ['fe80::1%eth0', 'fe80:0000:0000::/48'],
    ['::1', '0000:0000:0000::/48']
  ])('subred de %s', (ip, subnet) => {
    expect(ipSubnet(ip)).toBe(subnet);
  });

  it('una IP no válida no da subred pero sí cuenta en un grupo común, y el hash no contiene la IP', () => {
    expect(ipSubnet('no-es-una-ip')).toBeNull();
    expect(hashIpSubnet(SECRET, '1.2.3.4, 5.6.7.8')).toBe(hashIpSubnet(SECRET, null));
    expect(hashIpSubnet(SECRET, 'unknown')).toBe(hashIpSubnet(SECRET, undefined));
    const hash = hashIpSubnet(SECRET, '83.45.12.200');
    expect(hash).toBe(hashIpSubnet(SECRET, '83.45.12.7'));
    expect(hash).not.toBe(hashIpSubnet(SECRET, '83.45.13.7'));
    expect(hash).not.toContain('83.45');
  });
});

describe('QA-SEC04 · candado semántico', () => {
  it.each([
    'Taller solidario sin cobrar', 'Obra de teatro', 'Aprovechar sobras', 'Maniobra de evacuación', 'Mano de obra solidaria', 'Taller de pintura', 'OBRA DE TEATRO de Navidad', 'Obra de teatro y otra obra de teatro',
    'Taller solidari sense cobrar', 'Obra de teatre', 'Aprofitar sobres', "Obres d'art dels alumnes", "Mà d'obra solidària",
    'Charity workshop without charging', 'School theatre play', 'Use leftovers', 'Pintar un mural con las familias', 'Obra social del colegio', 'Obra solidaria de Navidad', 'Obra de títeres', 'Obra benéfica', 'Obres socials', 'Obra de dansa', 'Banana split en el taller de cocina', 'Fan zone para la final', 'Fiesta para fans'
  ])('«%s» no se bloquea', (text) => {
    expect(evaluateSemanticLock(text)).toEqual({ isBlocked: false, matchedTerm: null });
  });

  it.each([
    ['18 ventiladores', 'ventiladores'], ['Toldos patio', 'toldos'], ['18Ventiladores', 'ventiladores'], ['Climatización del aula', 'climatizacion'], ['AIRE  ACONDICIONADO', 'aire acondicionado'], ['Aire-acondicionado', 'aire acondicionado'],
    ['Césped artificial', 'cesped artificial'], ['Obras del gimnasio', 'obras'], ['Obra de teatro y 18 ventiladores', 'ventiladores'], ['Reforma para la obra de teatro', 'reforma'],
    ['18 ventiladors', 'ventiladors'], ['Tendals pati', 'tendals'], ['Calefacció del gimnàs', 'calefaccio'], ['Obres al pati', 'obres'], ['Façana nova', 'facana'],
    ['18 fans for the classroom', 'fans'], ['Air conditioning', 'air conditioning'], ['New whiteboards', 'whiteboards'], ['Heating repair', 'heating'],
    ['ven\u200Btiladores', 'ventiladores'],
    // La lista blanca no abre una vía para colar equipamiento.
    ['10 fans del gimnasio', 'fans'], ['Fans de techo para las aulas', 'fans'], ['Fan de pie para el comedor', 'fan'], ['Fans of three speeds for classrooms', 'fans'], ['Split between classrooms', 'split'], ['Reforma educativa del gimnasio', 'reforma'],
    // Equipamiento añadido por decisión del promotor (31-10-2026); «pintar» queda fuera a propósito para no chocar con talleres de pintura.
    ['Ventilación de aulas', 'ventilacion'], ['Radiadores nuevos', 'radiadores'], ['Mobiliario de aula', 'mobiliario'], ['Altavoces para el patio', 'altavoces'], ['Portería nueva', 'porteria'],
    ['Ventilació de les aules', 'ventilacio'], ['Mobiliari escolar', 'mobiliari'], ['Altaveus', 'altaveus'], ['Pistes esportives', 'pistes esportives'],
    ['School furniture', 'furniture'], ['New radiators', 'radiators'], ['AC units', 'ac units'], ['Refurbishment of the gym', 'refurbishment'], ['Sports court', 'sports court'],
    // Plurales y equivalentes.
    ['Aires acondicionados para las aulas', 'aires acondicionados'], ['Pérgolas para el patio', 'pergolas'], ['Fachadas del centro', 'fachadas'], ['Marcadores LED', 'marcadores led'], ['Reformar el gimnasio', 'reformar'], ['Rehabilitación del gimnasio', 'rehabilitacion'], ['Remodelación del patio', 'remodelacion'],
    ['Climatització de les aules', 'climatitzacio'], ['Aires condicionats', 'aires condicionats'], ['Façanes', 'facanes'], ['Gespa artificial', 'gespa artificial'], ['Asfaltat del pati', 'asfaltat'], ['Tauletes per a 6è', 'tauletes'],
    ['New computers for the classroom', 'computers'], ['Air conditioners', 'air conditioners'], ['Aircon', 'aircon'], ['Pergolas', 'pergolas'], ['Artificial turf', 'artificial turf'], ['LED scoreboard', 'scoreboard'], ['Facade repair', 'facade']
  ])('«%s» se bloquea por «%s»', (text, term) => {
    expect(evaluateSemanticLock(text)).toEqual({ isBlocked: true, matchedTerm: term });
  });

  it('el resultado no cambia al repetir: la expresión regular no arrastra estado', () => {
    for (let i = 0; i < 3; i += 1) expect(evaluateSemanticLock('18 ventiladores').isBlocked).toBe(true);
  });
});

describe('QA-SEC03 · huella de la firma', () => {
  const payout = { organizationId: 'ORG', netPaidCents: 2_700, korumFeeSettledCents: 200, destinationType: 'ORGANIZATION' as const, beneficiaryName: 'AFA', beneficiaryIban: 'ES00', providerCif: null, providerInvoiceFileId: null };
  const signedAt = new Date('2026-11-01T10:00:00.000Z');
  const input = { organizationId: 'ORG', targetType: 'ESCROW_PAYOUT' as const, targetId: 1, targetDigest: payoutTargetDigest(SECRET, payout, 'split-a'), signerUserId: 'u1', signerRole: 'DIRECTOR' as const, membershipId: 7, signedAt, otpVerifiedAt: signedAt };

  it('se verifica la huella correcta', () => {
    expect(verifySignatureHash(SECRET, input, computeSignatureHash(SECRET, input))).toBe(true);
  });

  it('cambiar el importe o la cuenta destino cambia lo firmado', () => {
    expect(payoutTargetDigest(SECRET, { ...payout, netPaidCents: 2_701 }, 'split-a')).not.toBe(input.targetDigest);
    expect(payoutTargetDigest(SECRET, payout, 'split-b')).not.toBe(input.targetDigest);
    expect(payoutTargetDigest(SECRET, { ...payout, beneficiaryIban: 'ES01' }, 'split-a')).not.toBe(input.targetDigest);
  });

  it('cualquier campo alterado invalida la firma', () => {
    const hash = computeSignatureHash(SECRET, input);
    const changes = [{ organizationId: 'OTRA' }, { targetId: 2 }, { targetDigest: 'otro' }, { signerUserId: 'u2' }, { signerRole: 'COSIGNER' as const }, { membershipId: 8 }, { signedAt: new Date(signedAt.getTime() + 1) }, { otpVerifiedAt: null }, { targetType: 'IDEA_APPROVAL' as const }];
    for (const change of changes) expect(verifySignatureHash(SECRET, { ...input, ...change }, hash)).toBe(false);
  });

  it('los campos no se confunden al separarlos', () => {
    const base = { organizationId: 'ORG', category: 'b', description: 'c' };
    expect(ideaTargetDigest(SECRET, { ...base, title: 'a","b' })).not.toBe(ideaTargetDigest(SECRET, { ...base, title: 'a', category: 'b","b' }));
  });
});
