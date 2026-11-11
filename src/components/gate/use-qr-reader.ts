'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lector de QR con la cámara (QA-S04). Usa `BarcodeDetector` donde existe (Chrome, Android) y, como respaldo, jsQR sobre un fotograma dibujado en un
 * canvas: Safari de iOS no tiene `BarcodeDetector`. jsQR solo se descarga si hace falta. El mismo código no se repite en 3 segundos (el QR sigue delante
 * de la cámara mientras se comprueba). Sin permiso, sin cámara o en un navegador sin `getUserMedia`, el estado lo dice y la pantalla ofrece escribir el código.
 */

export type CameraStatus = 'idle' | 'starting' | 'scanning' | 'denied' | 'unsupported' | 'error';

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (options: { formats: string[] }) => DetectorLike;

const SCAN_INTERVAL_MS = 120;
const REPEAT_BLOCK_MS = 3_000;
/** Para jsQR basta una imagen pequeña: más píxeles solo lo hacen más lento (la latencia de la puerta importa). */
const FALLBACK_WIDTH = 480;

export function useQrReader(onCode: (code: string) => void, paused: boolean) {
  const videoNode = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onCodeRef = useRef(onCode);
  const pausedRef = useRef(paused);
  const lastRef = useRef<{ code: string; at: number } | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');

  useEffect(() => {
    onCodeRef.current = onCode;
    pausedRef.current = paused;
  }, [onCode, paused]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStatus('idle');
  }, []);

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  const start = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported');
      return;
    }
    setStatus('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (error) {
      setStatus(error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError') ? 'denied' : error instanceof DOMException && error.name === 'NotFoundError' ? 'unsupported' : 'error');
      return;
    }
    streamRef.current = stream;
    const video = videoNode.current;
    if (!video) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus('idle');
      return;
    }
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    try {
      await video.play();
    } catch {
      // Sin vídeo no hay lectura: la cámara no se queda encendida.
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus('error');
      return;
    }
    setStatus('scanning');
    // En iOS, al bloquear el móvil o cambiar de aplicación la pista termina y el vídeo se congela: el estado lo refleja y se puede volver a activar.
    stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
      if (streamRef.current === stream) {
        streamRef.current = null;
        setStatus('idle');
      }
    }));

    const Detector = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null;
    const canvas = document.createElement('canvas');
    const jsQrPromise = detector ? null : import('jsqr').then((module) => module.default);

    const readFrame = async (): Promise<string | null> => {
      if (detector) return (await detector.detect(video).catch(() => []))[0]?.rawValue ?? null;
      if (video.videoWidth === 0) return null;
      const scale = Math.min(1, FALLBACK_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const drawing = canvas.getContext('2d', { willReadFrequently: true });
      if (!drawing) return null;
      drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
      const jsQr = await jsQrPromise!;
      return jsQr(drawing.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
    };

    const loop = async () => {
      while (streamRef.current === stream) {
        if (!pausedRef.current && video.readyState >= 2) {
          const code = await readFrame().catch(() => null);
          const last = lastRef.current;
          if (code && !(last && last.code === code && Date.now() - last.at < REPEAT_BLOCK_MS)) {
            lastRef.current = { code, at: Date.now() };
            onCodeRef.current(code);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
      }
    };
    void loop();
  }, []);

  /** Quien llama puede olvidar el último código (p. ej. tras «Siguiente pase») para leer otra vez el mismo si hace falta. */
  const forget = useCallback(() => {
    lastRef.current = null;
  }, []);

  /** Referencia de función (no un objeto con `current`): se pasa tal cual al `ref` del `<video>`. */
  const videoRef = useCallback((node: HTMLVideoElement | null) => {
    videoNode.current = node;
  }, []);

  return { videoRef, status, start, stop, forget };
}
