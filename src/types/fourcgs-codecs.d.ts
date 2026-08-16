declare module '*fourcgs-prs-codec.mjs' {
  export const decodePositionContextStreams: (...arguments_: any[]) => any;
  export const decodePositions: (...arguments_: any[]) => any;
  export const floatToHalf: (value: number) => number;
  export const halfToFloat: (bits: number) => number;
}

declare module '*fourcgs-so3-temporal-codec.mjs' {
  export const decodeSo3RotationStreams: (...arguments_: any[]) => any;
}

declare module '*fourcgs-temporal-attribute-codec.mjs' {
  export const decodeTemporalAttributeReaders: (...arguments_: any[]) => any;
  export const decodeTemporalAttributeStreams: (...arguments_: any[]) => any;
}

declare module '*fourcgs-v21-lossless-codec.mjs' {
  export const decodeV21PositionContexts: (...arguments_: any[]) => Promise<any>;
  export const decodeV22ScaleReaders: (...arguments_: any[]) => Promise<any>;
  export const decodeV22StructuredParts: (...arguments_: any[]) => Promise<any>;
  export const isV21StructuredStream: (bytes: Uint8Array) => boolean;
}

declare module '*fourcgs-mixrq-codec.mjs' {
  export const decodeMixRq: (...arguments_: any[]) => any;
  export const decodeMixRqWindows: (...arguments_: any[]) => any;
}

declare module '*fourcgs-scalar-rq-codec.mjs' {
  export const decodeScalarRq: (...arguments_: any[]) => any;
}

declare module '*fourcgs-temporal-rq-codec.mjs' {
  export const decodeTemporalRq: (...arguments_: any[]) => any;
}

declare module 'xzwasm' {
  export class XzReadableStream extends ReadableStream<Uint8Array> {
    constructor(source: ReadableStream<Uint8Array>);
  }
}
