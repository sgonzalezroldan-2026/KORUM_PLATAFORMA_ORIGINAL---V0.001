/**
 * Contrato con el almacén de ficheros (Regla 01, DECISIONES_TECNICAS §3). Dos cubos: el público (logos, portadas, fotos Antes/Después ya
 * publicadas) y el privado (KYB, facturas, certificados, Modelo 182), este último solo accesible con una URL firmada de corta duración.
 */

export const PUBLIC_BUCKET = 'korum-public';
export const PRIVATE_BUCKET = 'korum-private';

export interface StoragePutInput {
  bucket: string;
  objectKey: string;
  body: Uint8Array;
  contentType: string;
}

export interface StorageProvider {
  readonly name: string;
  /** Guarda un objeto nuevo. Falla si la clave ya existe: nunca se pisa un fichero. */
  put(input: StoragePutInput): Promise<void>;
  remove(bucket: string, objectKey: string): Promise<void>;
  /** URL permanente de un objeto del cubo público. */
  publicUrl(bucket: string, objectKey: string): string;
  /** URL temporal de un objeto del cubo privado. */
  createSignedUrl(bucket: string, objectKey: string, expiresInSeconds: number): Promise<string>;
}

export class StorageError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}
