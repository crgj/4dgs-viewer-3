declare module '*fourcgs-prs-codec.mjs' {
  export const buildCroppedMortonLayout: (...arguments_: any[]) => any;
  export const encodePositionRaw: (...arguments_: any[]) => any;
  export const encodePositions: (...arguments_: any[]) => any;
  export const decodePositionContextStreams: (...arguments_: any[]) => any;
  export const decodePositions: (...arguments_: any[]) => any;
  export const floatToHalf: (value: number) => number;
  export const halfToFloat: (bits: number) => number;
}

declare module '*fourcgs-so3-temporal-codec.mjs' {
  export const encodeSo3Rotations: (...arguments_: any[]) => any;
  export const decodeSo3Rotations: (...arguments_: any[]) => any;
  export const decodeSo3RotationStreams: (...arguments_: any[]) => any;
  export const prepareSo3RotationStreams: (...arguments_: any[]) => any;
  export const decodeSo3RotationPartition: (...arguments_: any[]) => any;
}

declare module '*fourcgs-temporal-attribute-codec.mjs' {
  export const encodeTemporalAttribute: (...arguments_: any[]) => any;
  export const decodeTemporalAttributeReaders: (...arguments_: any[]) => any;
  export const decodeTemporalAttributeStreams: (...arguments_: any[]) => any;
}

declare module '*fourcgs-v21-lossless-codec.mjs' {
  export const encodeV21StructuredStream: (...arguments_: any[]) => Promise<any>;
  export const encodeV22StructuredStream: (...arguments_: any[]) => Promise<any>;
  export const decodeV21StructuredStream: (...arguments_: any[]) => Promise<any>;
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

// #WDD-gpt 2026-08-16 - 声明 V2.5 全 Opacity 位级无损混合流的浏览器 Worker 解码入口。
declare module '*fourcgs-opacity-hybrid-codec.mjs' {
  export const encodeOpacityHybrid: (...arguments_: any[]) => any;
  export const decodeOpacityHybrid: (...arguments_: any[]) => any;
}

declare module 'xzwasm' {
  export class XzReadableStream extends ReadableStream<Uint8Array> {
    constructor(source: ReadableStream<Uint8Array>);
  }
}
