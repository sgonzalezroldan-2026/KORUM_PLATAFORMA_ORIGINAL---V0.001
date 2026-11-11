/**
 * Sonido y vibración de la puerta (QA-S04). Un pase bueno suena corto y agudo; una alerta (pase ya usado, firma inválida…) suena grave, dos veces, y vibra
 * en un patrón largo, para que se note aunque el móvil esté en el bolsillo o haya ruido. Todo con Web Audio, sin ficheros. Los navegadores solo dejan
 * sonar tras un gesto de la persona: el contexto se crea al activar el lector.
 */

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context) return context;
  const Ctor: AudioContextCtor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/** Se llama desde un gesto (pulsar «Activar el lector»): en iOS el audio no suena hasta entonces. */
export function unlockGateAudio(): void {
  const ctx = audio();
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}

function tone(ctx: AudioContext, frequency: number, startAt: number, duration: number, type: OscillatorType): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.35, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

export type GateFeedbackKind = 'ok' | 'alert' | 'ask';

export function playGateFeedback(kind: GateFeedbackKind, enabled: boolean): void {
  if (!enabled) return;
  const ctx = audio();
  if (ctx && ctx.state === 'running') {
    const now = ctx.currentTime;
    if (kind === 'ok') tone(ctx, 1_040, now, 0.12, 'sine');
    else if (kind === 'ask') tone(ctx, 740, now, 0.1, 'sine');
    else {
      tone(ctx, 220, now, 0.28, 'sawtooth');
      tone(ctx, 220, now + 0.38, 0.28, 'sawtooth');
    }
  }
  // Safari de iOS no implementa la vibración: simplemente no hace nada ahí.
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(kind === 'alert' ? [300, 120, 300, 120, 300] : kind === 'ok' ? 60 : 30);
  }
}
