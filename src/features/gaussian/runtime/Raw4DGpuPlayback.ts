import {
  ADDRESS_CLAMP_TO_EDGE,
  FILTER_NEAREST,
  FloatPacking,
  type GraphicsDevice,
  PIXELFORMAT_R8,
  PIXELFORMAT_RGBA16F,
  PIXELFORMAT_RGBA32F,
  Texture,
  type Entity,
  type GSplatResourceBase,
  type StorageBuffer,
  WORKBUFFER_UPDATE_ONCE,
} from 'playcanvas';
import type { GaussianEditStore } from '../edit/GaussianEditStore';
import type { Raw4DAsset, Raw4DTrack } from '../formats/raw4d/Raw4DTypes';
import { readRaw4DScalar, readRaw4DTrack, raw4DScalarBits } from '../formats/raw4d/Raw4DValues';
import type { GpuBufferAllocation, GpuBufferPool } from '../memory/GpuBufferPool';
import { KeyframeSlotCache, keyframeRequirements } from './KeyframeSlotCache';
import type { Raw4DFrameSampler } from './Raw4DFrameSampler';
import { createRaw4DGpuMemoryPlan } from './Raw4DGpuMemoryPlan';

const TEXTURE_WIDTH = 4096;
// #WDD-gpt 2026-08-14 - GPU 负责逐帧插值，WebGL2 只低频刷新 CPU 排序中心。
const CPU_SORT_FRAME_INTERVAL = 6;
const UPLOAD_BATCH_POINTS = 16_384;

const modifierGLSL = `
uniform highp sampler2D dongRaw4dPositionTex;
uniform highp sampler2D dongRaw4dRotationTex;
uniform highp sampler2D dongRaw4dColorTex;
uniform highp sampler2D dongRaw4dScaleTex;
uniform highp sampler2D dongRaw4dOpacityTex;
uniform highp sampler2D dongRaw4dLifetimeTex;
uniform highp sampler2D dongRaw4dDeleteMaskTex;
uniform highp sampler2D dongRaw4dSelectionMaskTex;
uniform float dongRaw4dFrame;
uniform float dongRaw4dTotalFrames;
uniform float dongRaw4dTextureWidth;
uniform vec4 dongRaw4dTrackKeys;
uniform vec4 dongRaw4dTrackStrides;
uniform vec2 dongRaw4dOpacityTrack;

struct DongTrackSpan {
    int left;
    int right;
    float alpha;
};

DongTrackSpan dongTrackSpan(float keyCountValue, float strideValue) {
    int keyCount = int(keyCountValue + 0.5);
    float frame = clamp(dongRaw4dFrame, 0.0, dongRaw4dTotalFrames - 1.0);
    int left = min(int(floor(frame / strideValue)), keyCount - 1);
    int right = min(left + 1, keyCount - 1);
    float leftTime = float(left) * strideValue;
    float rightTime = right == keyCount - 1 ? dongRaw4dTotalFrames - 1.0 : float(right) * strideValue;
    float alpha = right > left ? clamp((frame - leftTime) / max(rightTime - leftTime, 0.0001), 0.0, 1.0) : 0.0;
    return DongTrackSpan(left, right, alpha);
}

ivec2 dongTextureUv(uint linearIndex) {
    uint width = uint(dongRaw4dTextureWidth + 0.5);
    return ivec2(int(linearIndex % width), int(linearIndex / width));
}

vec4 dongLoadTrack(sampler2D trackTexture, int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(trackTexture, dongTextureUv(linearIndex), 0);
}

float dongLoadOpacity(int keyCount, int key) {
    int groupCount = (keyCount + 3) / 4;
    uint linearIndex = splat.index * uint(groupCount) + uint(key / 4);
    vec4 values = texelFetch(dongRaw4dOpacityTex, dongTextureUv(linearIndex), 0);
    return values[key - (key / 4) * 4];
}

float dongSigmoid(float value) {
    return 1.0 / (1.0 + exp(-clamp(value, -20.0, 20.0)));
}

vec4 dongQuaternionMultiply(vec4 a, vec4 b) {
    return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

vec4 dongSlerp(vec4 left, vec4 right, float alpha) {
    left = normalize(left);
    right = normalize(right);
    float cosine = dot(left, right);
    if (cosine < 0.0) {
        right = -right;
        cosine = -cosine;
    }
    if (cosine > 0.9995) {
        return normalize(mix(left, right, alpha));
    }
    float theta = acos(clamp(cosine, -1.0, 1.0));
    float inverseSine = 1.0 / max(sin(theta), 0.00001);
    return normalize(left * sin((1.0 - alpha) * theta) * inverseSine + right * sin(alpha * theta) * inverseSine);
}

void modifySplatCenter(inout vec3 center) {
    DongTrackSpan span = dongTrackSpan(dongRaw4dTrackKeys.x, dongRaw4dTrackStrides.x);
    int keyCount = int(dongRaw4dTrackKeys.x + 0.5);
    vec3 position = mix(
        dongLoadTrack(dongRaw4dPositionTex, keyCount, span.left).xyz,
        dongLoadTrack(dongRaw4dPositionTex, keyCount, span.right).xyz,
        span.alpha
    );
    center = (matrix_model * vec4(position, 1.0)).xyz;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    DongTrackSpan rotationSpan = dongTrackSpan(dongRaw4dTrackKeys.y, dongRaw4dTrackStrides.y);
    int rotationKeys = int(dongRaw4dTrackKeys.y + 0.5);
    vec4 localRotation = dongSlerp(
        dongLoadTrack(dongRaw4dRotationTex, rotationKeys, rotationSpan.left),
        dongLoadTrack(dongRaw4dRotationTex, rotationKeys, rotationSpan.right),
        rotationSpan.alpha
    );
    rotation = normalize(dongQuaternionMultiply(model_rotation, localRotation));
    if (rotation.w < 0.0) rotation = -rotation;

    DongTrackSpan scaleSpan = dongTrackSpan(dongRaw4dTrackKeys.w, dongRaw4dTrackStrides.w);
    int scaleKeys = int(dongRaw4dTrackKeys.w + 0.5);
    vec3 logScale = mix(
        dongLoadTrack(dongRaw4dScaleTex, scaleKeys, scaleSpan.left).xyz,
        dongLoadTrack(dongRaw4dScaleTex, scaleKeys, scaleSpan.right).xyz,
        scaleSpan.alpha
    );
    scale = model_scale * exp(logScale);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    DongTrackSpan colorSpan = dongTrackSpan(dongRaw4dTrackKeys.z, dongRaw4dTrackStrides.z);
    int colorKeys = int(dongRaw4dTrackKeys.z + 0.5);
    vec3 baseDc = dongLoadTrack(dongRaw4dColorTex, colorKeys, 0).xyz;
    vec3 currentDc = mix(
        dongLoadTrack(dongRaw4dColorTex, colorKeys, colorSpan.left).xyz,
        dongLoadTrack(dongRaw4dColorTex, colorKeys, colorSpan.right).xyz,
        colorSpan.alpha
    );
    color.rgb += (currentDc - baseDc) * 0.28209479177387814;

    DongTrackSpan opacitySpan = dongTrackSpan(dongRaw4dOpacityTrack.x, dongRaw4dOpacityTrack.y);
    int opacityKeys = int(dongRaw4dOpacityTrack.x + 0.5);
    float opacityLogit = mix(
        dongLoadOpacity(opacityKeys, opacitySpan.left),
        dongLoadOpacity(opacityKeys, opacitySpan.right),
        opacitySpan.alpha
    );
    vec2 lifetime = texelFetch(dongRaw4dLifetimeTex, dongTextureUv(splat.index), 0).xy;
    float frame = clamp(dongRaw4dFrame, 0.0, dongRaw4dTotalFrames - 1.0);
    float gate = dongSigmoid(10.0 * (frame - (lifetime.x - lifetime.y)))
        * dongSigmoid(10.0 * ((lifetime.x + lifetime.y) - frame));
    float deleted = texelFetch(dongRaw4dDeleteMaskTex, dongTextureUv(splat.index), 0).r;
    float selected = texelFetch(dongRaw4dSelectionMaskTex, dongTextureUv(splat.index), 0).r;
    color.rgb = mix(color.rgb, vec3(1.0, 0.58, 0.08), step(0.5, selected) * 0.82);
    color.a = dongSigmoid(opacityLogit) * gate * (1.0 - step(0.5, deleted));
}
`;

const modifierWGSL = `
var dongRaw4dPositionTex: texture_2d<f32>;
var dongRaw4dRotationTex: texture_2d<f32>;
var dongRaw4dColorTex: texture_2d<f32>;
var dongRaw4dScaleTex: texture_2d<f32>;
var dongRaw4dOpacityTex: texture_2d<f32>;
var dongRaw4dLifetimeTex: texture_2d<f32>;
var dongRaw4dDeleteMaskTex: texture_2d<f32>;
var dongRaw4dSelectionMaskTex: texture_2d<f32>;
uniform dongRaw4dFrame: f32;
uniform dongRaw4dTotalFrames: f32;
uniform dongRaw4dTextureWidth: f32;
uniform dongRaw4dTrackKeys: vec4f;
uniform dongRaw4dTrackStrides: vec4f;
uniform dongRaw4dOpacityTrack: vec2f;

struct DongTrackSpan {
    left: i32,
    right: i32,
    alpha: f32
}

fn dongTrackSpan(keyCountValue: f32, strideValue: f32) -> DongTrackSpan {
    let keyCount = i32(keyCountValue + 0.5);
    let frame = clamp(uniform.dongRaw4dFrame, 0.0, uniform.dongRaw4dTotalFrames - 1.0);
    let left = min(i32(floor(frame / strideValue)), keyCount - 1);
    let right = min(left + 1, keyCount - 1);
    let leftTime = f32(left) * strideValue;
    let rightTime = select(f32(right) * strideValue, uniform.dongRaw4dTotalFrames - 1.0, right == keyCount - 1);
    var alpha = 0.0;
    if (right > left) {
        alpha = clamp((frame - leftTime) / max(rightTime - leftTime, 0.0001), 0.0, 1.0);
    }
    return DongTrackSpan(left, right, alpha);
}

fn dongTextureUv(linearIndex: u32) -> vec2i {
    let width = u32(uniform.dongRaw4dTextureWidth + 0.5);
    return vec2i(i32(linearIndex % width), i32(linearIndex / width));
}

fn dongLoadPosition(keyCount: i32, key: i32) -> vec4f {
    return textureLoad(dongRaw4dPositionTex, dongTextureUv(splat.index * u32(keyCount) + u32(key)), 0);
}

fn dongLoadRotation(keyCount: i32, key: i32) -> vec4f {
    return textureLoad(dongRaw4dRotationTex, dongTextureUv(splat.index * u32(keyCount) + u32(key)), 0);
}

fn dongLoadColor(keyCount: i32, key: i32) -> vec4f {
    return textureLoad(dongRaw4dColorTex, dongTextureUv(splat.index * u32(keyCount) + u32(key)), 0);
}

fn dongLoadScale(keyCount: i32, key: i32) -> vec4f {
    return textureLoad(dongRaw4dScaleTex, dongTextureUv(splat.index * u32(keyCount) + u32(key)), 0);
}

fn dongLoadOpacity(keyCount: i32, key: i32) -> f32 {
    let groupCount = (keyCount + 3) / 4;
    let linearIndex = splat.index * u32(groupCount) + u32(key / 4);
    let values = textureLoad(dongRaw4dOpacityTex, dongTextureUv(linearIndex), 0);
    return values[u32(key - (key / 4) * 4)];
}

fn dongSigmoid(value: f32) -> f32 {
    return 1.0 / (1.0 + exp(-clamp(value, -20.0, 20.0)));
}

fn dongQuaternionMultiply(a: vec4f, b: vec4f) -> vec4f {
    return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

fn dongSlerp(leftValue: vec4f, rightValue: vec4f, alpha: f32) -> vec4f {
    let left = normalize(leftValue);
    var right = normalize(rightValue);
    var cosine = dot(left, right);
    if (cosine < 0.0) {
        right = -right;
        cosine = -cosine;
    }
    if (cosine > 0.9995) {
        return normalize(mix(left, right, alpha));
    }
    let theta = acos(clamp(cosine, -1.0, 1.0));
    let inverseSine = 1.0 / max(sin(theta), 0.00001);
    return normalize(left * sin((1.0 - alpha) * theta) * inverseSine + right * sin(alpha * theta) * inverseSine);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let span = dongTrackSpan(uniform.dongRaw4dTrackKeys.x, uniform.dongRaw4dTrackStrides.x);
    let keyCount = i32(uniform.dongRaw4dTrackKeys.x + 0.5);
    let position = mix(dongLoadPosition(keyCount, span.left).xyz, dongLoadPosition(keyCount, span.right).xyz, span.alpha);
    *center = (uniform.matrix_model * vec4f(position, 1.0)).xyz;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let rotationSpan = dongTrackSpan(uniform.dongRaw4dTrackKeys.y, uniform.dongRaw4dTrackStrides.y);
    let rotationKeys = i32(uniform.dongRaw4dTrackKeys.y + 0.5);
    let localRotation = dongSlerp(
        dongLoadRotation(rotationKeys, rotationSpan.left),
        dongLoadRotation(rotationKeys, rotationSpan.right),
        rotationSpan.alpha
    );
    *rotation = normalize(dongQuaternionMultiply(uniform.model_rotation, localRotation));
    if ((*rotation).w < 0.0) {
        *rotation = -(*rotation);
    }

    let scaleSpan = dongTrackSpan(uniform.dongRaw4dTrackKeys.w, uniform.dongRaw4dTrackStrides.w);
    let scaleKeys = i32(uniform.dongRaw4dTrackKeys.w + 0.5);
    let logScale = mix(dongLoadScale(scaleKeys, scaleSpan.left).xyz, dongLoadScale(scaleKeys, scaleSpan.right).xyz, scaleSpan.alpha);
    *scale = uniform.model_scale * exp(logScale);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let colorSpan = dongTrackSpan(uniform.dongRaw4dTrackKeys.z, uniform.dongRaw4dTrackStrides.z);
    let colorKeys = i32(uniform.dongRaw4dTrackKeys.z + 0.5);
    let baseDc = dongLoadColor(colorKeys, 0).xyz;
    let currentDc = mix(dongLoadColor(colorKeys, colorSpan.left).xyz, dongLoadColor(colorKeys, colorSpan.right).xyz, colorSpan.alpha);
    *color = vec4f((*color).rgb + (currentDc - baseDc) * 0.28209479177387814, (*color).a);

    let opacitySpan = dongTrackSpan(uniform.dongRaw4dOpacityTrack.x, uniform.dongRaw4dOpacityTrack.y);
    let opacityKeys = i32(uniform.dongRaw4dOpacityTrack.x + 0.5);
    let opacityLogit = mix(dongLoadOpacity(opacityKeys, opacitySpan.left), dongLoadOpacity(opacityKeys, opacitySpan.right), opacitySpan.alpha);
    let lifetime = textureLoad(dongRaw4dLifetimeTex, dongTextureUv(splat.index), 0).xy;
    let frame = clamp(uniform.dongRaw4dFrame, 0.0, uniform.dongRaw4dTotalFrames - 1.0);
    let gate = dongSigmoid(10.0 * (frame - (lifetime.x - lifetime.y)))
        * dongSigmoid(10.0 * ((lifetime.x + lifetime.y) - frame));
    let deleted = textureLoad(dongRaw4dDeleteMaskTex, dongTextureUv(splat.index), 0).x;
    let selected = textureLoad(dongRaw4dSelectionMaskTex, dongTextureUv(splat.index), 0).x;
    (*color).rgb = mix((*color).rgb, vec3f(1.0, 0.58, 0.08), step(0.5, selected) * 0.82);
    (*color).a = dongSigmoid(opacityLogit) * gate * (1.0 - step(0.5, deleted));
}
`;

const textureDeclarations = `var dongRaw4dPositionTex: texture_2d<f32>;
var dongRaw4dRotationTex: texture_2d<f32>;
var dongRaw4dColorTex: texture_2d<f32>;
var dongRaw4dScaleTex: texture_2d<f32>;
var dongRaw4dOpacityTex: texture_2d<f32>;
var dongRaw4dLifetimeTex: texture_2d<f32>;
var dongRaw4dDeleteMaskTex: texture_2d<f32>;
var dongRaw4dSelectionMaskTex: texture_2d<f32>;`;

const textureLoaders = `fn dongLoadPosition(keyCount: i32, key: i32) -> vec4f {
    return textureLoad(dongRaw4dPositionTex, dongTextureUv(splat.index * u32(keyCount) + u32(key)), 0);
}

fn dongLoadRotation(keyCount: i32, key: i32) -> vec4f {
    return textureLoad(dongRaw4dRotationTex, dongTextureUv(splat.index * u32(keyCount) + u32(key)), 0);
}

fn dongLoadColor(keyCount: i32, key: i32) -> vec4f {
    return textureLoad(dongRaw4dColorTex, dongTextureUv(splat.index * u32(keyCount) + u32(key)), 0);
}

fn dongLoadScale(keyCount: i32, key: i32) -> vec4f {
    return textureLoad(dongRaw4dScaleTex, dongTextureUv(splat.index * u32(keyCount) + u32(key)), 0);
}

fn dongLoadOpacity(keyCount: i32, key: i32) -> f32 {
    let groupCount = (keyCount + 3) / 4;
    let linearIndex = splat.index * u32(groupCount) + u32(key / 4);
    let values = textureLoad(dongRaw4dOpacityTex, dongTextureUv(linearIndex), 0);
    return values[u32(key - (key / 4) * 4)];
}`;

export function createRaw4DStorageModifierWGSL(half: boolean): string {
  const vectorType = half ? 'vec2u' : 'vec4f';
  const scalarType = half ? 'u32' : 'f32';
  const unpackVector = half
    ? `let packed = {buffer}[index];
    return vec4f(unpack2x16float(packed.x), unpack2x16float(packed.y));`
    : 'return {buffer}[index];';
  const scalarLoad = half
    ? `let halfIndex = u32(uniform.dongRaw4dScalarOffsets.x) + slot * u32(uniform.dongRaw4dScalarStride) + splat.index;
    let pair = unpack2x16float(dongRaw4dScalarData[halfIndex / 2u]);
    return pair[halfIndex % 2u];`
    : `let index = u32(uniform.dongRaw4dScalarOffsets.x) + slot * u32(uniform.dongRaw4dScalarStride) + splat.index;
    return dongRaw4dScalarData[index];`;
  const lifetimeLoad = half
    ? `let muIndex = u32(uniform.dongRaw4dScalarOffsets.y) + splat.index;
    let widthIndex = u32(uniform.dongRaw4dScalarOffsets.z) + splat.index;
    let muPair = unpack2x16float(dongRaw4dScalarData[muIndex / 2u]);
    let widthPair = unpack2x16float(dongRaw4dScalarData[widthIndex / 2u]);
    let lifetime = vec2f(muPair[muIndex % 2u], widthPair[widthIndex % 2u]);`
    : `let lifetime = vec2f(
        dongRaw4dScalarData[u32(uniform.dongRaw4dScalarOffsets.y) + splat.index],
        dongRaw4dScalarData[u32(uniform.dongRaw4dScalarOffsets.z) + splat.index]
    );`;
  const declarations = `var<storage, read> dongRaw4dPositionData: array<${vectorType}>;
var<storage, read> dongRaw4dVectorData: array<${vectorType}>;
var<storage, read> dongRaw4dScalarData: array<${scalarType}>;
var dongRaw4dDeleteMaskTex: texture_2d<f32>;
var dongRaw4dSelectionMaskTex: texture_2d<f32>;
uniform dongRaw4dAuxOffsets: vec3f;
uniform dongRaw4dScalarOffsets: vec3f;
uniform dongRaw4dScalarStride: f32;
uniform dongRaw4dSplatCount: f32;
uniform dongRaw4dPositionSlotKeys: vec4f;
uniform dongRaw4dRotationSlotKeys: vec4f;
uniform dongRaw4dColorSlotKeys: vec4f;
uniform dongRaw4dScaleSlotKeys: vec4f;
uniform dongRaw4dOpacitySlotKeys: vec4f;`;
  const loaders = `fn dongResolveSlot(keys: vec4f, key: i32) -> u32 {
    if (i32(keys.x) == key) { return 0u; }
    if (i32(keys.y) == key) { return 1u; }
    if (i32(keys.z) == key) { return 2u; }
    if (i32(keys.w) == key) { return 3u; }
    return 0u;
}

fn dongLoadPosition(keyCount: i32, key: i32) -> vec4f {
    let slot = dongResolveSlot(uniform.dongRaw4dPositionSlotKeys, key);
    let index = slot * u32(uniform.dongRaw4dSplatCount) + splat.index;
    ${unpackVector.replace('{buffer}', 'dongRaw4dPositionData')}
}

fn dongLoadRotation(keyCount: i32, key: i32) -> vec4f {
    let slot = dongResolveSlot(uniform.dongRaw4dRotationSlotKeys, key);
    let index = u32(uniform.dongRaw4dAuxOffsets.x) + slot * u32(uniform.dongRaw4dSplatCount) + splat.index;
    ${unpackVector.replace('{buffer}', 'dongRaw4dVectorData')}
}

fn dongLoadColor(keyCount: i32, key: i32) -> vec4f {
    let slot = dongResolveSlot(uniform.dongRaw4dColorSlotKeys, key);
    let index = u32(uniform.dongRaw4dAuxOffsets.y) + slot * u32(uniform.dongRaw4dSplatCount) + splat.index;
    ${unpackVector.replace('{buffer}', 'dongRaw4dVectorData')}
}

fn dongLoadScale(keyCount: i32, key: i32) -> vec4f {
    let slot = dongResolveSlot(uniform.dongRaw4dScaleSlotKeys, key);
    let index = u32(uniform.dongRaw4dAuxOffsets.z) + slot * u32(uniform.dongRaw4dSplatCount) + splat.index;
    ${unpackVector.replace('{buffer}', 'dongRaw4dVectorData')}
}

fn dongLoadOpacity(keyCount: i32, key: i32) -> f32 {
    let slot = dongResolveSlot(uniform.dongRaw4dOpacitySlotKeys, key);
    ${scalarLoad}
}`;
  return modifierWGSL
    .replace(textureDeclarations, declarations)
    .replace(textureLoaders, loaders)
    .replace('let lifetime = textureLoad(dongRaw4dLifetimeTex, dongTextureUv(splat.index), 0).xy;', lifetimeLoad);
}

const modifierStorageFloatWGSL = createRaw4DStorageModifierWGSL(false);
const modifierStorageHalfWGSL = createRaw4DStorageModifierWGSL(true);

function trackStride(track: Raw4DTrack): number {
  return track.keyframes.length > 1 ? track.keyframes[1] - track.keyframes[0] : 1;
}

function createTexture(device: GraphicsDevice, name: string, texelCount: number, width: number, half: boolean): Texture {
  const height = Math.max(1, Math.ceil(texelCount / width));
  if (height > device.maxTextureSize) {
    throw new Error(`RAW4D GPU texture ${name} exceeds ${device.maxTextureSize}px.`);
  }
  return new Texture(device, {
    name,
    width,
    height,
    format: half ? PIXELFORMAT_RGBA16F : PIXELFORMAT_RGBA32F,
    mipmaps: false,
    minFilter: FILTER_NEAREST,
    magFilter: FILTER_NEAREST,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
}

function writeValue(destination: Float32Array | Uint16Array, index: number, value: number, half: boolean): void {
  const safeValue = value === -Infinity ? -20 : value === Infinity ? 20 : value;
  destination[index] = half ? FloatPacking.float2Half(safeValue) : safeValue;
}

function createTrackTexture(
  device: GraphicsDevice,
  track: Raw4DTrack,
  name: string,
  width: number,
  componentOrder: readonly number[],
  half: boolean,
): Texture {
  const texture = createTexture(device, name, track.values[0].length * track.keyframes.length, width, half);
  const destination = texture.lock() as Float32Array | Uint16Array;
  destination.fill(0);
  const count = track.values[0].length;
  for (let point = 0; point < count; point += 1) {
    for (let key = 0; key < track.keyframes.length; key += 1) {
      const destinationOffset = (point * track.keyframes.length + key) * 4;
      for (let component = 0; component < componentOrder.length; component += 1) {
        const sourceComponent = componentOrder[component];
        writeValue(destination, destinationOffset + component, readRaw4DTrack(
          track, key * track.components + sourceComponent, point,
        ), half);
      }
    }
  }
  texture.unlock();
  return texture;
}

function createOpacityTexture(device: GraphicsDevice, asset: Raw4DAsset, width: number): Texture {
  const groupCount = Math.ceil(asset.opacity.keyframes.length / 4);
  const texture = createTexture(device, 'RAW4D Opacity Banks', asset.splatCount * groupCount, width, true);
  const destination = texture.lock() as Uint16Array;
  destination.fill(FloatPacking.float2Half(-20));
  for (let point = 0; point < asset.splatCount; point += 1) {
    for (let key = 0; key < asset.opacity.keyframes.length; key += 1) {
      const destinationOffset = (point * groupCount + Math.floor(key / 4)) * 4 + key % 4;
      writeValue(destination, destinationOffset, readRaw4DTrack(asset.opacity, key, point), true);
    }
  }
  texture.unlock();
  return texture;
}

function createLifetimeTexture(device: GraphicsDevice, asset: Raw4DAsset, width: number): Texture {
  const texture = createTexture(device, 'RAW4D Lifetime', asset.splatCount, width, true);
  const destination = texture.lock() as Uint16Array;
  destination.fill(0);
  for (let point = 0; point < asset.splatCount; point += 1) {
    writeValue(destination, point * 4, readRaw4DScalar(asset.lifetimeMu, point, asset.sourceEncoding), true);
    writeValue(destination, point * 4 + 1, readRaw4DScalar(asset.lifetimeW, point, asset.sourceEncoding), true);
  }
  texture.unlock();
  return texture;
}


function safeStorageFloat(value: number): number {
  return value === -Infinity ? -20 : value === Infinity ? 20 : value;
}

function safeHalfBits(track: Raw4DTrack, valueIndex: number, pointIndex: number): number {
  const value = readRaw4DTrack(track, valueIndex, pointIndex);
  return Number.isFinite(value)
    ? raw4DScalarBits(track.values[valueIndex], pointIndex, track.encoding)
    : FloatPacking.float2Half(safeStorageFloat(value));
}

function uploadVectorSlot(
  buffer: StorageBuffer,
  destinationVectorOffset: number,
  track: Raw4DTrack,
  key: number,
  componentOrder: readonly number[],
  half: boolean,
): void {
  const count = track.values[0].length;
  const maximumBatchPoints = Math.min(UPLOAD_BATCH_POINTS, count);
  if (half) {
    const staging = new Uint32Array(maximumBatchPoints * 2);
    for (let firstPoint = 0; firstPoint < count; firstPoint += maximumBatchPoints) {
      const pointCount = Math.min(maximumBatchPoints, count - firstPoint);
      staging.fill(0, 0, pointCount * 2);
      for (let point = 0; point < pointCount; point += 1) {
        const sourcePoint = firstPoint + point;
        const bits = [0, 0, 0, 0];
        for (let component = 0; component < componentOrder.length; component += 1) {
          bits[component] = safeHalfBits(
            track,
            key * track.components + componentOrder[component],
            sourcePoint,
          );
        }
        staging[point * 2] = (bits[0] | (bits[1] << 16)) >>> 0;
        staging[point * 2 + 1] = (bits[2] | (bits[3] << 16)) >>> 0;
      }
      buffer.write((destinationVectorOffset + firstPoint) * 8, staging, 0, pointCount * 2);
    }
    return;
  }

  const staging = new Float32Array(maximumBatchPoints * 4);
  for (let firstPoint = 0; firstPoint < count; firstPoint += maximumBatchPoints) {
    const pointCount = Math.min(maximumBatchPoints, count - firstPoint);
    staging.fill(0, 0, pointCount * 4);
    for (let point = 0; point < pointCount; point += 1) {
      for (let component = 0; component < componentOrder.length; component += 1) {
        staging[point * 4 + component] = safeStorageFloat(readRaw4DTrack(
          track,
          key * track.components + componentOrder[component],
          firstPoint + point,
        ));
      }
    }
    buffer.write((destinationVectorOffset + firstPoint) * 16, staging, 0, pointCount * 4);
  }
}

function uploadScalarSlot(
  buffer: StorageBuffer,
  destinationScalarOffset: number,
  scalarStride: number,
  track: Raw4DTrack,
  key: number,
  half: boolean,
): void {
  const count = track.values[0].length;
  if (half) {
    const staging = new Uint16Array(scalarStride);
    for (let point = 0; point < count; point += 1) staging[point] = safeHalfBits(track, key, point);
    buffer.write(destinationScalarOffset * 2, staging, 0, staging.length);
    return;
  }
  const maximumBatchPoints = Math.min(UPLOAD_BATCH_POINTS, count);
  const staging = new Float32Array(maximumBatchPoints);
  for (let firstPoint = 0; firstPoint < count; firstPoint += maximumBatchPoints) {
    const pointCount = Math.min(maximumBatchPoints, count - firstPoint);
    for (let point = 0; point < pointCount; point += 1) {
      staging[point] = safeStorageFloat(readRaw4DTrack(track, key, firstPoint + point));
    }
    buffer.write((destinationScalarOffset + firstPoint) * 4, staging, 0, pointCount);
  }
}

function uploadScalarArray(
  buffer: StorageBuffer,
  destinationScalarOffset: number,
  scalarStride: number,
  values: Raw4DAsset['lifetimeMu'],
  asset: Raw4DAsset,
  half: boolean,
): void {
  if (half) {
    const staging = new Uint16Array(scalarStride);
    for (let point = 0; point < asset.splatCount; point += 1) {
      const value = readRaw4DScalar(values, point, asset.sourceEncoding);
      staging[point] = Number.isFinite(value)
        ? raw4DScalarBits(values, point, asset.sourceEncoding)
        : FloatPacking.float2Half(safeStorageFloat(value));
    }
    buffer.write(destinationScalarOffset * 2, staging, 0, staging.length);
    return;
  }
  const maximumBatchPoints = Math.min(UPLOAD_BATCH_POINTS, asset.splatCount);
  const staging = new Float32Array(maximumBatchPoints);
  for (let firstPoint = 0; firstPoint < asset.splatCount; firstPoint += maximumBatchPoints) {
    const pointCount = Math.min(maximumBatchPoints, asset.splatCount - firstPoint);
    for (let point = 0; point < pointCount; point += 1) {
      staging[point] = safeStorageFloat(readRaw4DScalar(values, firstPoint + point, asset.sourceEncoding));
    }
    buffer.write((destinationScalarOffset + firstPoint) * 4, staging, 0, pointCount);
  }
}

function createDeletionTexture(device: GraphicsDevice, edits: GaussianEditStore, width: number): Texture {
  const texture = new Texture(device, {
    name: 'RAW4D Deletion Mask',
    width,
    height: Math.max(1, Math.ceil(edits.pointCount / width)),
    format: PIXELFORMAT_R8,
    mipmaps: false,
    minFilter: FILTER_NEAREST,
    magFilter: FILTER_NEAREST,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  const destination = texture.lock() as Uint8Array;
  destination.fill(0);
  for (let point = 0; point < edits.pointCount; point += 1) {
    if (edits.isDeleted(point)) destination[point] = 255;
  }
  texture.unlock();
  return texture;
}

// #WDD-gpt  2026-08-16 - 选择高亮复用稳定 ID 位集生成 R8 掩码，避免重排或复制 Canonical 高斯属性。
function createSelectionTexture(device: GraphicsDevice, edits: GaussianEditStore, width: number): Texture {
  const texture = new Texture(device, {
    name: 'RAW4D Selection Mask',
    width,
    height: Math.max(1, Math.ceil(edits.pointCount / width)),
    format: PIXELFORMAT_R8,
    mipmaps: false,
    minFilter: FILTER_NEAREST,
    magFilter: FILTER_NEAREST,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  const destination = texture.lock() as Uint8Array;
  destination.fill(0);
  const words = edits.selectionWords;
  for (let point = 0; point < edits.pointCount; point += 1) {
    if (words[point >>> 5] & (1 << (point & 31))) destination[point] = 255;
  }
  texture.unlock();
  return texture;
}

interface StoragePlaybackResources {
  readonly position: GpuBufferAllocation;
  readonly vectors: GpuBufferAllocation;
  readonly scalars: GpuBufferAllocation;
  readonly vectorOffsets: Float32Array;
  readonly scalarOffsets: Float32Array;
  readonly scalarStride: number;
  readonly half: boolean;
  readonly positionSlots: KeyframeSlotCache;
  readonly rotationSlots: KeyframeSlotCache;
  readonly colorSlots: KeyframeSlotCache;
  readonly scaleSlots: KeyframeSlotCache;
  readonly opacitySlots: KeyframeSlotCache;
}

export class Raw4DGpuPlayback {
  private lastCenterFrame = 0;
  private disposed = false;
  private readonly stopListeningForEdits: () => void;

  private constructor(
    private readonly entity: Entity,
    private readonly resource: GSplatResourceBase,
    private readonly sampler: Raw4DFrameSampler | null,
    private readonly asset: Raw4DAsset,
    private readonly edits: GaussianEditStore,
    private readonly textures: Texture[],
    private readonly deletionTexture: Texture,
    private readonly selectionTexture: Texture,
    private readonly textureWidth: number,
    private readonly gpuPool: GpuBufferPool | null,
    private readonly storageResources: StoragePlaybackResources | null,
  ) {
    this.configureCommonParameters();
    this.stopListeningForEdits = edits.onChange((event) => {
      if (this.disposed || (event.kind !== 'deleted' && event.kind !== 'selection')) return;
      if (event.kind === 'deleted') this.refreshDeletionTexture();
      else this.refreshSelectionTexture();
      if (this.entity.gsplat) this.entity.gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
    });
  }

  static async create(
    entity: Entity,
    resource: GSplatResourceBase,
    sampler: Raw4DFrameSampler | null,
    asset: Raw4DAsset,
    edits: GaussianEditStore,
    device: GraphicsDevice,
    gpuPool: GpuBufferPool,
  ): Promise<Raw4DGpuPlayback> {
    const width = Math.min(TEXTURE_WIDTH, device.maxTextureSize);
    const deletionTexture = createDeletionTexture(device, edits, width);
    const selectionTexture = createSelectionTexture(device, edits, width);
    if (device.isWebGPU) {
      try {
        const storageResources = await this.createStorageResources(asset, gpuPool);
        const playback = new Raw4DGpuPlayback(
          entity, resource, sampler, asset, edits, [deletionTexture, selectionTexture], deletionTexture, selectionTexture,
          width, gpuPool, storageResources,
        );
        playback.configureStorageBuffers(storageResources);
        return playback;
      } catch (error) {
        console.warn('RAW4D StorageBuffer path unavailable; using texture fallback.', error);
      }
    }

    const textures = [deletionTexture, selectionTexture];
    try {
      const positionTexture = createTrackTexture(device, asset.position, 'RAW4D Position Banks', width, [0, 1, 2], false);
      textures.push(positionTexture);
      const rotationTexture = createTrackTexture(device, asset.rotation, 'RAW4D Rotation Banks', width, [1, 2, 3, 0], true);
      textures.push(rotationTexture);
      const colorTexture = createTrackTexture(device, asset.colorDc, 'RAW4D DC Banks', width, [0, 1, 2], true);
      textures.push(colorTexture);
      const scaleTexture = createTrackTexture(device, asset.scale, 'RAW4D Scale Banks', width, [0, 1, 2], true);
      textures.push(scaleTexture);
      const opacityTexture = createOpacityTexture(device, asset, width);
      textures.push(opacityTexture);
      const lifetimeTexture = createLifetimeTexture(device, asset, width);
      textures.push(lifetimeTexture);
      const playback = new Raw4DGpuPlayback(
        entity, resource, sampler, asset, edits, textures, deletionTexture, selectionTexture, width, null, null,
      );
      const component = entity.gsplat!;
      component.setWorkBufferModifier({ glsl: modifierGLSL, wgsl: modifierWGSL });
      component.setParameter('dongRaw4dPositionTex', positionTexture);
      component.setParameter('dongRaw4dRotationTex', rotationTexture);
      component.setParameter('dongRaw4dColorTex', colorTexture);
      component.setParameter('dongRaw4dScaleTex', scaleTexture);
      component.setParameter('dongRaw4dOpacityTex', opacityTexture);
      component.setParameter('dongRaw4dLifetimeTex', lifetimeTexture);
      component.setParameter('dongRaw4dDeleteMaskTex', deletionTexture);
      component.setParameter('dongRaw4dSelectionMaskTex', selectionTexture);
      component.setParameter('dongRaw4dTextureWidth', width);
      component.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
      return playback;
    } catch (error) {
      for (const texture of textures) texture.destroy();
      throw error;
    }
  }

  get backend(): 'storage-buffer' | 'texture' {
    return this.storageResources ? 'storage-buffer' : 'texture';
  }

  get externalGpuByteSize(): number {
    return this.textures.reduce((total, texture) => {
      const bytesPerTexel = texture.format === PIXELFORMAT_R8 ? 1 : texture.format === PIXELFORMAT_RGBA32F ? 16 : 8;
      return total + texture.width * texture.height * bytesPerTexel;
    }, 0);
  }

  private static async createStorageResources(
    asset: Raw4DAsset,
    gpuPool: GpuBufferPool,
  ): Promise<StoragePlaybackResources> {
    const plan = createRaw4DGpuMemoryPlan(asset);
    const {
      half, scalarStride, positionSlotCount, rotationSlotCount, colorSlotCount, scaleSlotCount,
      opacitySlotCount, rotationOffset, colorOffset, scaleOffset, opacityOffset,
      lifetimeMuOffset, lifetimeWOffset,
    } = plan;

    let position: GpuBufferAllocation | null = null;
    let vectors: GpuBufferAllocation | null = null;
    let scalars: GpuBufferAllocation | null = null;
    try {
      position = await gpuPool.allocateBinding(
        'RAW4D position streaming slots', plan.positionBytes,
      );
      vectors = await gpuPool.allocateBinding('RAW4D vector streaming slots', plan.vectorBytesTotal);
      scalars = await gpuPool.allocateBinding('RAW4D scalar streaming slots', plan.scalarBytesTotal);
      const positionBuffer = position.chunks[0];
      const vectorBuffer = vectors.chunks[0];
      const scalarBuffer = scalars.chunks[0];
      const positionSlots = new KeyframeSlotCache(asset.position.keyframes.length, positionSlotCount);
      const rotationSlots = new KeyframeSlotCache(asset.rotation.keyframes.length, rotationSlotCount);
      const colorSlots = new KeyframeSlotCache(asset.colorDc.keyframes.length, colorSlotCount, [0]);
      const scaleSlots = new KeyframeSlotCache(asset.scale.keyframes.length, scaleSlotCount);
      const opacitySlots = new KeyframeSlotCache(asset.opacity.keyframes.length, opacitySlotCount);
      // #WDD-gpt 2026-08-16 - WebGPU 仅常驻左右关键帧和一个预取帧；DC 额外固定第零帧用于颜色增量。
      positionSlots.initialize((slot, key) => uploadVectorSlot(
        positionBuffer, slot * asset.splatCount, asset.position, key, [0, 1, 2], half,
      ));
      rotationSlots.initialize((slot, key) => uploadVectorSlot(
        vectorBuffer, rotationOffset + slot * asset.splatCount, asset.rotation, key, [1, 2, 3, 0], half,
      ));
      colorSlots.initialize((slot, key) => uploadVectorSlot(
        vectorBuffer, colorOffset + slot * asset.splatCount, asset.colorDc, key, [0, 1, 2], half,
      ));
      scaleSlots.initialize((slot, key) => uploadVectorSlot(
        vectorBuffer, scaleOffset + slot * asset.splatCount, asset.scale, key, [0, 1, 2], half,
      ));
      opacitySlots.initialize((slot, key) => uploadScalarSlot(
        scalarBuffer, opacityOffset + slot * scalarStride, scalarStride, asset.opacity, key, half,
      ));
      uploadScalarArray(scalarBuffer, lifetimeMuOffset, scalarStride, asset.lifetimeMu, asset, half);
      uploadScalarArray(scalarBuffer, lifetimeWOffset, scalarStride, asset.lifetimeW, asset, half);
      return {
        position,
        vectors,
        scalars,
        vectorOffsets: new Float32Array([rotationOffset, colorOffset, scaleOffset]),
        scalarOffsets: new Float32Array([opacityOffset, lifetimeMuOffset, lifetimeWOffset]),
        scalarStride,
        half,
        positionSlots,
        rotationSlots,
        colorSlots,
        scaleSlots,
        opacitySlots,
      };
    } catch (error) {
      gpuPool.release(position);
      gpuPool.release(vectors);
      gpuPool.release(scalars);
      throw error;
    }
  }

  private configureStorageBuffers(resources: StoragePlaybackResources): void {
    const component = this.entity.gsplat!;
    component.setWorkBufferModifier({
      wgsl: resources.half ? modifierStorageHalfWGSL : modifierStorageFloatWGSL,
      glsl: modifierGLSL,
    });
    component.setParameter('dongRaw4dPositionData', resources.position.chunks[0]);
    component.setParameter('dongRaw4dVectorData', resources.vectors.chunks[0]);
    component.setParameter('dongRaw4dScalarData', resources.scalars.chunks[0]);
    component.setParameter('dongRaw4dAuxOffsets', resources.vectorOffsets);
    component.setParameter('dongRaw4dScalarOffsets', resources.scalarOffsets);
    component.setParameter('dongRaw4dScalarStride', resources.scalarStride);
    component.setParameter('dongRaw4dSplatCount', this.asset.splatCount);
    component.setParameter('dongRaw4dDeleteMaskTex', this.deletionTexture);
    component.setParameter('dongRaw4dSelectionMaskTex', this.selectionTexture);
    component.setParameter('dongRaw4dTextureWidth', this.textureWidth);
    this.refreshSlotParameters();
    component.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
  }

  private configureCommonParameters(): void {
    const component = this.entity.gsplat!;
    component.setParameter('dongRaw4dFrame', 0);
    component.setParameter('dongRaw4dTotalFrames', this.asset.totalFrames);
    component.setParameter('dongRaw4dTrackKeys', new Float32Array([
      this.asset.position.keyframes.length,
      this.asset.rotation.keyframes.length,
      this.asset.colorDc.keyframes.length,
      this.asset.scale.keyframes.length,
    ]));
    component.setParameter('dongRaw4dTrackStrides', new Float32Array([
      trackStride(this.asset.position),
      trackStride(this.asset.rotation),
      trackStride(this.asset.colorDc),
      trackStride(this.asset.scale),
    ]));
    component.setParameter('dongRaw4dOpacityTrack', new Float32Array([
      this.asset.opacity.keyframes.length,
      trackStride(this.asset.opacity),
    ]));
  }

  private ensureStorageFrame(frame: number): void {
    const resources = this.storageResources;
    if (!resources) return;
    let changed = false;
    const positionBuffer = resources.position.chunks[0];
    const vectorBuffer = resources.vectors.chunks[0];
    const scalarBuffer = resources.scalars.chunks[0];
    changed = resources.positionSlots.ensure(keyframeRequirements(this.asset.position.keyframes, frame), (slot, key) => {
      uploadVectorSlot(positionBuffer, slot * this.asset.splatCount, this.asset.position, key, [0, 1, 2], resources.half);
    }) || changed;
    changed = resources.rotationSlots.ensure(keyframeRequirements(this.asset.rotation.keyframes, frame), (slot, key) => {
      uploadVectorSlot(
        vectorBuffer, resources.vectorOffsets[0] + slot * this.asset.splatCount,
        this.asset.rotation, key, [1, 2, 3, 0], resources.half,
      );
    }) || changed;
    changed = resources.colorSlots.ensure(keyframeRequirements(this.asset.colorDc.keyframes, frame), (slot, key) => {
      uploadVectorSlot(
        vectorBuffer, resources.vectorOffsets[1] + slot * this.asset.splatCount,
        this.asset.colorDc, key, [0, 1, 2], resources.half,
      );
    }) || changed;
    changed = resources.scaleSlots.ensure(keyframeRequirements(this.asset.scale.keyframes, frame), (slot, key) => {
      uploadVectorSlot(
        vectorBuffer, resources.vectorOffsets[2] + slot * this.asset.splatCount,
        this.asset.scale, key, [0, 1, 2], resources.half,
      );
    }) || changed;
    changed = resources.opacitySlots.ensure(keyframeRequirements(this.asset.opacity.keyframes, frame), (slot, key) => {
      uploadScalarSlot(
        scalarBuffer, resources.scalarOffsets[0] + slot * resources.scalarStride,
        resources.scalarStride, this.asset.opacity, key, resources.half,
      );
    }) || changed;
    if (changed) this.refreshSlotParameters();
  }

  private refreshSlotParameters(): void {
    const resources = this.storageResources;
    const component = this.entity.gsplat;
    if (!resources || !component) return;
    component.setParameter('dongRaw4dPositionSlotKeys', resources.positionSlots.uniformKeys());
    component.setParameter('dongRaw4dRotationSlotKeys', resources.rotationSlots.uniformKeys());
    component.setParameter('dongRaw4dColorSlotKeys', resources.colorSlots.uniformKeys());
    component.setParameter('dongRaw4dScaleSlotKeys', resources.scaleSlots.uniformKeys());
    component.setParameter('dongRaw4dOpacitySlotKeys', resources.opacitySlots.uniformKeys());
  }

  private refreshDeletionTexture(): void {
    const destination = this.deletionTexture.lock() as Uint8Array;
    destination.fill(0);
    for (let point = 0; point < this.edits.pointCount; point += 1) {
      if (this.edits.isDeleted(point)) destination[point] = 255;
    }
    this.deletionTexture.unlock();
  }

  private refreshSelectionTexture(): void {
    const destination = this.selectionTexture.lock() as Uint8Array;
    destination.fill(0);
    const words = this.edits.selectionWords;
    for (let point = 0; point < this.edits.pointCount; point += 1) {
      if (words[point >>> 5] & (1 << (point & 31))) destination[point] = 255;
    }
    this.selectionTexture.unlock();
  }

  setFrame(requestedFrame: number): void {
    if (this.disposed) return;
    const frame = Math.min(this.asset.totalFrames - 1, Math.max(0, requestedFrame));
    this.ensureStorageFrame(frame);
    const component = this.entity.gsplat!;
    component.setParameter('dongRaw4dFrame', frame);
    component.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
    if (this.resource.centers && this.sampler && (
      Math.abs(frame - this.lastCenterFrame) >= CPU_SORT_FRAME_INTERVAL
      || frame === 0
      || frame === this.asset.totalFrames - 1
    )) {
      this.sampler.samplePosition(frame);
      const { x, y, z } = this.sampler.properties;
      for (let index = 0; index < this.asset.splatCount; index += 1) {
        this.resource.centers[index * 3] = x[index];
        this.resource.centers[index * 3 + 1] = y[index];
        this.resource.centers[index * 3 + 2] = z[index];
      }
      this.resource.centersVersion += 1;
      this.lastCenterFrame = frame;
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopListeningForEdits();
    this.entity.gsplat?.setWorkBufferModifier(null);
    for (const texture of this.textures) texture.destroy();
    this.gpuPool?.release(this.storageResources?.position);
    this.gpuPool?.release(this.storageResources?.vectors);
    this.gpuPool?.release(this.storageResources?.scalars);
  }
}
