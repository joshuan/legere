declare module 'node-gost-crypto' {
  type GostAlgorithm = {
    name: string;
    version: number;
    length: number;
    hash?: GostAlgorithm;
    namedCurve?: string;
  };
  export const gostCrypto: {
    subtle: {
      generateKey(
        algorithm: GostAlgorithm,
        extractable: boolean,
        usages: string[],
      ): Promise<{ publicKey: unknown; privateKey: unknown }>;
      exportKey(format: 'spki', key: unknown): Promise<ArrayBuffer>;
      sign(algorithm: GostAlgorithm, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
      digest(algorithm: GostAlgorithm, data: Uint8Array): Promise<ArrayBuffer>;
      importKey(
        format: 'spki',
        data: ArrayBuffer,
        algorithm: GostAlgorithm,
        extractable: boolean,
        usages: string[],
      ): Promise<unknown>;
      verify(
        algorithm: GostAlgorithm,
        key: unknown,
        signature: ArrayBuffer,
        data: Uint8Array,
      ): Promise<boolean>;
    };
  };
}
