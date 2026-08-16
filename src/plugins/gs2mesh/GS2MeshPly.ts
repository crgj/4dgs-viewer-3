import type { GS2MeshData } from './GS2MeshTypes';

type PlyScalarType =
  | 'char' | 'uchar' | 'short' | 'ushort'
  | 'int' | 'uint' | 'float' | 'double';

interface PlyScalarProperty {
  readonly kind: 'scalar';
  readonly type: PlyScalarType;
  readonly name: string;
}

interface PlyListProperty {
  readonly kind: 'list';
  readonly countType: PlyScalarType;
  readonly valueType: PlyScalarType;
  readonly name: string;
}

type PlyProperty = PlyScalarProperty | PlyListProperty;

interface PlyElement {
  readonly name: string;
  readonly count: number;
  readonly properties: PlyProperty[];
}

interface PlyHeader {
  readonly format: 'ascii' | 'binary_little_endian';
  readonly dataOffset: number;
  readonly elements: readonly PlyElement[];
}

const TYPE_BYTES: Readonly<Record<PlyScalarType, number>> = {
  char: 1, uchar: 1, short: 2, ushort: 2,
  int: 4, uint: 4, float: 4, double: 8,
};

function asScalarType(value: string): PlyScalarType {
  const aliases: Readonly<Record<string, PlyScalarType>> = {
    int8: 'char', uint8: 'uchar', int16: 'short', uint16: 'ushort',
    int32: 'int', uint32: 'uint', float32: 'float', float64: 'double',
  };
  const normalized = aliases[value] ?? value;
  if (!(normalized in TYPE_BYTES)) throw new Error(`Unsupported PLY scalar type: ${value}`);
  return normalized as PlyScalarType;
}

function parseHeader(buffer: ArrayBuffer): PlyHeader {
  const preview = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536)));
  const match = /end_header\r?\n/.exec(preview);
  if (!match || match.index === undefined) throw new Error('PLY header is missing end_header.');
  const dataOffset = match.index + match[0].length;
  const lines = preview.slice(0, dataOffset).split(/\r?\n/);
  if (lines[0]?.trim() !== 'ply') throw new Error('Mesh response is not a PLY file.');
  let format: PlyHeader['format'] | null = null;
  const elements: PlyElement[] = [];
  let current: PlyElement | null = null;
  for (const rawLine of lines.slice(1)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts[0] === 'format') {
      if (parts[1] !== 'ascii' && parts[1] !== 'binary_little_endian') {
        throw new Error(`Unsupported PLY format: ${parts[1]}`);
      }
      format = parts[1];
    } else if (parts[0] === 'element') {
      current = { name: parts[1], count: Number(parts[2]), properties: [] };
      if (!Number.isSafeInteger(current.count) || current.count < 0) throw new Error('Invalid PLY element count.');
      elements.push(current);
    } else if (parts[0] === 'property' && current) {
      if (parts[1] === 'list') {
        current.properties.push({
          kind: 'list',
          countType: asScalarType(parts[2]),
          valueType: asScalarType(parts[3]),
          name: parts[4],
        });
      } else {
        current.properties.push({ kind: 'scalar', type: asScalarType(parts[1]), name: parts[2] });
      }
    }
  }
  if (!format) throw new Error('PLY header has no supported format declaration.');
  return { format, dataOffset, elements };
}

function readScalar(view: DataView, offset: number, type: PlyScalarType): number {
  switch (type) {
    case 'char': return view.getInt8(offset);
    case 'uchar': return view.getUint8(offset);
    case 'short': return view.getInt16(offset, true);
    case 'ushort': return view.getUint16(offset, true);
    case 'int': return view.getInt32(offset, true);
    case 'uint': return view.getUint32(offset, true);
    case 'float': return view.getFloat32(offset, true);
    case 'double': return view.getFloat64(offset, true);
  }
}

function pushFaceTriangles(indices: number[], polygon: readonly number[], vertexCount: number): void {
  if (polygon.length < 3) return;
  for (const index of polygon) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= vertexCount) {
      throw new Error(`PLY face references invalid vertex ${index}.`);
    }
  }
  for (let index = 1; index < polygon.length - 1; index += 1) {
    indices.push(polygon[0], polygon[index], polygon[index + 1]);
  }
}

function allocateMesh(vertexCount: number): {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
} {
  return {
    positions: new Float32Array(vertexCount * 3),
    normals: new Float32Array(vertexCount * 3),
    colors: new Uint8Array(vertexCount * 4),
  };
}

function vertexChannel(name: string): 'x' | 'y' | 'z' | 'nx' | 'ny' | 'nz' | 'red' | 'green' | 'blue' | 'alpha' | null {
  const aliases: Readonly<Record<string, ReturnType<typeof vertexChannel>>> = {
    r: 'red', g: 'green', b: 'blue', a: 'alpha',
  };
  const normalized = aliases[name] ?? name;
  return ['x', 'y', 'z', 'nx', 'ny', 'nz', 'red', 'green', 'blue', 'alpha'].includes(normalized)
    ? normalized as ReturnType<typeof vertexChannel>
    : null;
}

function setVertexValue(
  target: ReturnType<typeof allocateMesh>,
  vertexIndex: number,
  propertyName: string,
  value: number,
): boolean {
  const channel = vertexChannel(propertyName);
  if (!channel) return false;
  const component: Readonly<Record<string, number>> = {
    x: 0, y: 1, z: 2, nx: 0, ny: 1, nz: 2, red: 0, green: 1, blue: 2, alpha: 3,
  };
  if (channel === 'x' || channel === 'y' || channel === 'z') {
    target.positions[vertexIndex * 3 + component[channel]] = value;
  } else if (channel === 'nx' || channel === 'ny' || channel === 'nz') {
    target.normals[vertexIndex * 3 + component[channel]] = value;
  } else {
    target.colors[vertexIndex * 4 + component[channel]] = Math.max(0, Math.min(255, Math.round(value)));
  }
  return channel.startsWith('n');
}

function parseBinary(buffer: ArrayBuffer, header: PlyHeader): GS2MeshData {
  const vertexElement = header.elements.find(({ name }) => name === 'vertex');
  if (!vertexElement) throw new Error('PLY mesh has no vertex element.');
  const target = allocateMesh(vertexElement.count);
  target.colors.fill(255);
  const indices: number[] = [];
  const view = new DataView(buffer);
  let offset = header.dataOffset;
  let hasNormals = false;
  for (const element of header.elements) {
    for (let row = 0; row < element.count; row += 1) {
      const polygon: number[] = [];
      for (const property of element.properties) {
        if (property.kind === 'scalar') {
          const value = readScalar(view, offset, property.type);
          offset += TYPE_BYTES[property.type];
          if (element.name === 'vertex') hasNormals = setVertexValue(target, row, property.name, value) || hasNormals;
        } else {
          const count = readScalar(view, offset, property.countType);
          offset += TYPE_BYTES[property.countType];
          if (!Number.isSafeInteger(count) || count < 0) throw new Error('PLY list has an invalid length.');
          for (let index = 0; index < count; index += 1) {
            const value = readScalar(view, offset, property.valueType);
            offset += TYPE_BYTES[property.valueType];
            if (element.name === 'face' && property.name === 'vertex_indices') polygon.push(value);
          }
        }
      }
      if (element.name === 'face') pushFaceTriangles(indices, polygon, vertexElement.count);
    }
  }
  return { ...target, normals: hasNormals ? target.normals : null, indices: Uint32Array.from(indices) };
}

function parseAscii(buffer: ArrayBuffer, header: PlyHeader): GS2MeshData {
  const vertexElement = header.elements.find(({ name }) => name === 'vertex');
  if (!vertexElement) throw new Error('PLY mesh has no vertex element.');
  const target = allocateMesh(vertexElement.count);
  target.colors.fill(255);
  const indices: number[] = [];
  const tokens = new TextDecoder().decode(new Uint8Array(buffer, header.dataOffset)).trim().split(/\s+/);
  let token = 0;
  let hasNormals = false;
  for (const element of header.elements) {
    for (let row = 0; row < element.count; row += 1) {
      const polygon: number[] = [];
      for (const property of element.properties) {
        if (property.kind === 'scalar') {
          const value = Number(tokens[token++]);
          if (element.name === 'vertex') hasNormals = setVertexValue(target, row, property.name, value) || hasNormals;
        } else {
          const count = Number(tokens[token++]);
          for (let index = 0; index < count; index += 1) {
            const value = Number(tokens[token++]);
            if (element.name === 'face' && property.name === 'vertex_indices') polygon.push(value);
          }
        }
      }
      if (element.name === 'face') pushFaceTriangles(indices, polygon, vertexElement.count);
    }
  }
  return { ...target, normals: hasNormals ? target.normals : null, indices: Uint32Array.from(indices) };
}

export function parseGS2MeshPly(buffer: ArrayBuffer): GS2MeshData {
  const header = parseHeader(buffer);
  const mesh = header.format === 'ascii' ? parseAscii(buffer, header) : parseBinary(buffer, header);
  if (mesh.positions.length === 0 || mesh.indices.length === 0) throw new Error('GS2Mesh returned an empty triangle mesh.');
  for (const value of mesh.positions) {
    if (!Number.isFinite(value)) throw new Error('GS2Mesh returned non-finite vertex coordinates.');
  }
  return mesh;
}

export function encodeGS2MeshPly(mesh: GS2MeshData): ArrayBuffer {
  const vertexCount = mesh.positions.length / 3;
  const triangleCount = mesh.indices.length / 3;
  const header = new TextEncoder().encode([
    'ply',
    'format binary_little_endian 1.0',
    'comment Generated in-browser by Dong Editor GS2Mesh WASM',
    `element vertex ${vertexCount}`,
    'property float x', 'property float y', 'property float z',
    'property float nx', 'property float ny', 'property float nz',
    'property uchar red', 'property uchar green', 'property uchar blue', 'property uchar alpha',
    `element face ${triangleCount}`,
    'property list uchar uint vertex_indices',
    'end_header', '',
  ].join('\n'));
  const vertexStride = 28;
  const faceStride = 13;
  const buffer = new ArrayBuffer(header.length + vertexCount * vertexStride + triangleCount * faceStride);
  new Uint8Array(buffer, 0, header.length).set(header);
  const view = new DataView(buffer);
  let offset = header.length;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (let component = 0; component < 3; component += 1) {
      view.setFloat32(offset, mesh.positions[vertex * 3 + component], true);
      offset += 4;
    }
    for (let component = 0; component < 3; component += 1) {
      view.setFloat32(offset, mesh.normals?.[vertex * 3 + component] ?? 0, true);
      offset += 4;
    }
    for (let component = 0; component < 4; component += 1) {
      view.setUint8(offset, mesh.colors[vertex * 4 + component] ?? 255);
      offset += 1;
    }
  }
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    view.setUint8(offset, 3);
    offset += 1;
    for (let corner = 0; corner < 3; corner += 1) {
      view.setUint32(offset, mesh.indices[triangle * 3 + corner], true);
      offset += 4;
    }
  }
  return buffer;
}
