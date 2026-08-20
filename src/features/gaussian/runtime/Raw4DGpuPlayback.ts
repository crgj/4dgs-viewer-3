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
const UPLOAD_BATCH_POINTS = 16_384;

// #WDD-gpt 2026-08-19 - CPU 深度排序必须使用当前动态帧中心；固定参考中心会在侧视角制造明显的遮挡错误。
export function raw4DSortCentersNeedRefresh(frame: number, lastFrame: number): boolean {
  return Math.abs(frame - lastFrame) > 1e-6;
}

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
uniform float dongRaw4dAllMode;

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

vec4 dongLoadPosition(int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(dongRaw4dPositionTex, dongTextureUv(linearIndex), 0);
}

vec4 dongLoadRotation(int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(dongRaw4dRotationTex, dongTextureUv(linearIndex), 0);
}

vec4 dongLoadColor(int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(dongRaw4dColorTex, dongTextureUv(linearIndex), 0);
}

vec4 dongLoadScale(int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(dongRaw4dScaleTex, dongTextureUv(linearIndex), 0);
}

float dongLoadOpacity(int keyCount, int key) {
    int groupCount = (keyCount + 3) / 4;
    uint linearIndex = splat.index * uint(groupCount) + uint(key / 4);
    vec4 values = texelFetch(dongRaw4dOpacityTex, dongTextureUv(linearIndex), 0);
    return values[key - (key / 4) * 4];
}

float dongSigmoid(float value) {
    if (floatBitsToUint(value) == 0xff800000u) return 0.0;
    return 1.0 / (1.0 + exp(-clamp(value, -20.0, 20.0)));
}

bool dongIsNegativeInfinity(float value) {
    return floatBitsToUint(value) == 0xff800000u;
}

float dongInterpolateExtended(float left, float right, float alpha) {
    if (alpha <= 0.0 || left == right) return left;
    if (alpha >= 1.0) return right;
    if (dongIsNegativeInfinity(left) || dongIsNegativeInfinity(right)) {
        return uintBitsToFloat(0xff800000u);
    }
    return mix(left, right, alpha);
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
        dongLoadPosition(keyCount, span.left).xyz,
        dongLoadPosition(keyCount, span.right).xyz,
        span.alpha
    );
    center = (matrix_model * vec4(position, 1.0)).xyz;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    DongTrackSpan rotationSpan = dongTrackSpan(dongRaw4dTrackKeys.y, dongRaw4dTrackStrides.y);
    int rotationKeys = int(dongRaw4dTrackKeys.y + 0.5);
    vec4 localRotation = dongSlerp(
        dongLoadRotation(rotationKeys, rotationSpan.left),
        dongLoadRotation(rotationKeys, rotationSpan.right),
        rotationSpan.alpha
    );
    rotation = normalize(dongQuaternionMultiply(model_rotation, localRotation));
    if (rotation.w < 0.0) rotation = -rotation;

    DongTrackSpan scaleSpan = dongTrackSpan(dongRaw4dTrackKeys.w, dongRaw4dTrackStrides.w);
    int scaleKeys = int(dongRaw4dTrackKeys.w + 0.5);
    vec3 logScale = mix(
        dongLoadScale(scaleKeys, scaleSpan.left).xyz,
        dongLoadScale(scaleKeys, scaleSpan.right).xyz,
        scaleSpan.alpha
    );
    scale = model_scale * exp(logScale);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    DongTrackSpan colorSpan = dongTrackSpan(dongRaw4dTrackKeys.z, dongRaw4dTrackStrides.z);
    int colorKeys = int(dongRaw4dTrackKeys.z + 0.5);
    vec3 baseDc = dongLoadColor(colorKeys, 0).xyz;
    vec3 currentDc = mix(
        dongLoadColor(colorKeys, colorSpan.left).xyz,
        dongLoadColor(colorKeys, colorSpan.right).xyz,
        colorSpan.alpha
    );
    color.rgb += (currentDc - baseDc) * 0.28209479177387814;

    DongTrackSpan opacitySpan = dongTrackSpan(dongRaw4dOpacityTrack.x, dongRaw4dOpacityTrack.y);
    int opacityKeys = int(dongRaw4dOpacityTrack.x + 0.5);
    float opacityLogit = dongInterpolateExtended(
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
    float alive = 1.0 - step(0.5, deleted);
    float visibleAlpha = dongSigmoid(opacityLogit) * gate * alive;
    color.a = mix(visibleAlpha, 0.82 * alive, step(0.5, dongRaw4dAllMode));
}
`;

const fullTextureLoadersGLSL = `vec4 dongLoadPosition(int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(dongRaw4dPositionTex, dongTextureUv(linearIndex), 0);
}

vec4 dongLoadRotation(int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(dongRaw4dRotationTex, dongTextureUv(linearIndex), 0);
}

vec4 dongLoadColor(int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(dongRaw4dColorTex, dongTextureUv(linearIndex), 0);
}

vec4 dongLoadScale(int keyCount, int key) {
    uint linearIndex = splat.index * uint(keyCount) + uint(key);
    return texelFetch(dongRaw4dScaleTex, dongTextureUv(linearIndex), 0);
}

float dongLoadOpacity(int keyCount, int key) {
    int groupCount = (keyCount + 3) / 4;
    uint linearIndex = splat.index * uint(groupCount) + uint(key / 4);
    vec4 values = texelFetch(dongRaw4dOpacityTex, dongTextureUv(linearIndex), 0);
    return values[key - (key / 4) * 4];
}`;

const streamingTextureLoadersGLSL = `int dongResolveSlot(vec4 keys, int key) {
    if (int(keys.x) == key) return 0;
    if (int(keys.y) == key) return 1;
    if (int(keys.z) == key) return 2;
    if (int(keys.w) == key) return 3;
    return 0;
}

vec4 dongLoadStreamingTrack(sampler2D trackTexture, vec4 keys, int key) {
    int slot = dongResolveSlot(keys, key);
    uint linearIndex = uint(slot) * uint(dongRaw4dSplatCount + 0.5) + splat.index;
    return texelFetch(trackTexture, dongTextureUv(linearIndex), 0);
}

vec4 dongLoadPosition(int keyCount, int key) {
    return dongLoadStreamingTrack(dongRaw4dPositionTex, dongRaw4dPositionSlotKeys, key);
}

vec4 dongLoadRotation(int keyCount, int key) {
    return dongLoadStreamingTrack(dongRaw4dRotationTex, dongRaw4dRotationSlotKeys, key);
}

vec4 dongLoadColor(int keyCount, int key) {
    return dongLoadStreamingTrack(dongRaw4dColorTex, dongRaw4dColorSlotKeys, key);
}

vec4 dongLoadScale(int keyCount, int key) {
    return dongLoadStreamingTrack(dongRaw4dScaleTex, dongRaw4dScaleSlotKeys, key);
}

float dongLoadOpacity(int keyCount, int key) {
    return dongLoadStreamingTrack(dongRaw4dOpacityTex, dongRaw4dOpacitySlotKeys, key).x;
}`;

const modifierStreamingGLSL = modifierGLSL
  .replace('uniform float dongRaw4dAllMode;', `uniform float dongRaw4dAllMode;
uniform float dongRaw4dSplatCount;
uniform vec4 dongRaw4dPositionSlotKeys;
uniform vec4 dongRaw4dRotationSlotKeys;
uniform vec4 dongRaw4dColorSlotKeys;
uniform vec4 dongRaw4dScaleSlotKeys;
uniform vec4 dongRaw4dOpacitySlotKeys;`)
  .replace(fullTextureLoadersGLSL, streamingTextureLoadersGLSL);

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
uniform dongRaw4dAllMode: f32;

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
    if (bitcast<u32>(value) == 0xff800000u) { return 0.0; }
    return 1.0 / (1.0 + exp(-clamp(value, -20.0, 20.0)));
}

fn dongIsNegativeInfinity(value: f32) -> bool {
    return bitcast<u32>(value) == 0xff800000u;
}

fn dongInterpolateExtended(left: f32, right: f32, alpha: f32) -> f32 {
    if (alpha <= 0.0 || left == right) { return left; }
    if (alpha >= 1.0) { return right; }
    if (dongIsNegativeInfinity(left) || dongIsNegativeInfinity(right)) {
        return bitcast<f32>(0xff800000u);
    }
    return mix(left, right, alpha);
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
    let opacityLogit = dongInterpolateExtended(
        dongLoadOpacity(opacityKeys, opacitySpan.left),
        dongLoadOpacity(opacityKeys, opacitySpan.right),
        opacitySpan.alpha
    );
    let lifetime = textureLoad(dongRaw4dLifetimeTex, dongTextureUv(splat.index), 0).xy;
    let frame = clamp(uniform.dongRaw4dFrame, 0.0, uniform.dongRaw4dTotalFrames - 1.0);
    let gate = dongSigmoid(10.0 * (frame - (lifetime.x - lifetime.y)))
        * dongSigmoid(10.0 * ((lifetime.x + lifetime.y) - frame));
    let deleted = textureLoad(dongRaw4dDeleteMaskTex, dongTextureUv(splat.index), 0).x;
    let selected = textureLoad(dongRaw4dSelectionMaskTex, dongTextureUv(splat.index), 0).x;
    (*color).rgb = mix((*color).rgb, vec3f(1.0, 0.58, 0.08), step(0.5, selected) * 0.82);
    let alive = 1.0 - step(0.5, deleted);
    let visibleAlpha = dongSigmoid(opacityLogit) * gate * alive;
    (*color).a = mix(visibleAlpha, 0.82 * alive, step(0.5, uniform.dongRaw4dAllMode));
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

const streamingTextureLoadersWGSL = `fn dongResolveSlot(keys: vec4f, key: i32) -> u32 {
    if (i32(keys.x) == key) { return 0u; }
    if (i32(keys.y) == key) { return 1u; }
    if (i32(keys.z) == key) { return 2u; }
    if (i32(keys.w) == key) { return 3u; }
    return 0u;
}

fn dongLoadStreamingTrack(trackTexture: texture_2d<f32>, keys: vec4f, key: i32) -> vec4f {
    let slot = dongResolveSlot(keys, key);
    let linearIndex = slot * u32(uniform.dongRaw4dSplatCount) + splat.index;
    return textureLoad(trackTexture, dongTextureUv(linearIndex), 0);
}

fn dongLoadPosition(keyCount: i32, key: i32) -> vec4f {
    return dongLoadStreamingTrack(dongRaw4dPositionTex, uniform.dongRaw4dPositionSlotKeys, key);
}

fn dongLoadRotation(keyCount: i32, key: i32) -> vec4f {
    return dongLoadStreamingTrack(dongRaw4dRotationTex, uniform.dongRaw4dRotationSlotKeys, key);
}

fn dongLoadColor(keyCount: i32, key: i32) -> vec4f {
    return dongLoadStreamingTrack(dongRaw4dColorTex, uniform.dongRaw4dColorSlotKeys, key);
}

fn dongLoadScale(keyCount: i32, key: i32) -> vec4f {
    return dongLoadStreamingTrack(dongRaw4dScaleTex, uniform.dongRaw4dScaleSlotKeys, key);
}

fn dongLoadOpacity(keyCount: i32, key: i32) -> f32 {
    return dongLoadStreamingTrack(dongRaw4dOpacityTex, uniform.dongRaw4dOpacitySlotKeys, key).x;
}`;

const modifierStreamingWGSL = modifierWGSL
  .replace('uniform dongRaw4dAllMode: f32;', `uniform dongRaw4dAllMode: f32;
uniform dongRaw4dSplatCount: f32;
uniform dongRaw4dPositionSlotKeys: vec4f;
uniform dongRaw4dRotationSlotKeys: vec4f;
uniform dongRaw4dColorSlotKeys: vec4f;
uniform dongRaw4dScaleSlotKeys: vec4f;
uniform dongRaw4dOpacitySlotKeys: vec4f;`)
  .replace(textureLoaders, streamingTextureLoadersWGSL);

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
  // #WDD-gpt 2026-08-16 - 保留 opacity 的 IEEE -Infinity，交由 shader 按 Python 扩展插值语义处理，不能提前近似成 -20。
  destination[index] = half ? FloatPacking.float2Half(value) : value;
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

function createStreamingTrackTexture(
  device: GraphicsDevice,
  name: string,
  splatCount: number,
  slotCount: number,
  width: number,
  half: boolean,
): Texture {
  const texture = createTexture(device, name, splatCount * slotCount, width, half);
  const destination = texture.lock() as Float32Array | Uint16Array;
  destination.fill(0);
  texture.unlock();
  return texture;
}

function uploadStreamingTrackSlot(
  texture: Texture,
  track: Raw4DTrack,
  key: number,
  slot: number,
  componentOrder: readonly number[],
  half: boolean,
): void {
  const destination = texture.lock() as Float32Array | Uint16Array;
  const count = track.values[0].length;
  for (let point = 0; point < count; point += 1) {
    const destinationOffset = (slot * count + point) * 4;
    for (let component = 0; component < componentOrder.length; component += 1) {
      writeValue(destination, destinationOffset + component, readRaw4DTrack(
        track, key * track.components + componentOrder[component], point,
      ), half);
    }
  }
  texture.unlock();
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


function safeHalfBits(track: Raw4DTrack, valueIndex: number, pointIndex: number): number {
  // #WDD-gpt 2026-08-16 - FP16 StorageBuffer 直接保留源位模式，包括合法的 opacity -Infinity。
  if (track.encoding === 'float16') {
    return raw4DScalarBits(track.values[valueIndex], pointIndex, track.encoding);
  }
  return FloatPacking.float2Half(readRaw4DTrack(track, valueIndex, pointIndex));
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
        staging[point * 4 + component] = readRaw4DTrack(
          track,
          key * track.components + componentOrder[component],
          firstPoint + point,
        );
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
      staging[point] = readRaw4DTrack(track, key, firstPoint + point);
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
      staging[point] = asset.sourceEncoding === 'float16'
        ? raw4DScalarBits(values, point, asset.sourceEncoding)
        : FloatPacking.float2Half(readRaw4DScalar(values, point, asset.sourceEncoding));
    }
    buffer.write(destinationScalarOffset * 2, staging, 0, staging.length);
    return;
  }
  const maximumBatchPoints = Math.min(UPLOAD_BATCH_POINTS, asset.splatCount);
  const staging = new Float32Array(maximumBatchPoints);
  for (let firstPoint = 0; firstPoint < asset.splatCount; firstPoint += maximumBatchPoints) {
    const pointCount = Math.min(maximumBatchPoints, asset.splatCount - firstPoint);
    for (let point = 0; point < pointCount; point += 1) {
      staging[point] = readRaw4DScalar(values, firstPoint + point, asset.sourceEncoding);
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

interface StreamingTexturePlaybackResources {
  readonly position: Texture;
  readonly rotation: Texture;
  readonly color: Texture;
  readonly scale: Texture;
  readonly opacity: Texture;
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
    private readonly streamingTextureResources: StreamingTexturePlaybackResources | null,
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
    options: { readonly streamTextureKeyframes?: boolean } = {},
  ): Promise<Raw4DGpuPlayback> {
    const width = Math.min(TEXTURE_WIDTH, device.maxTextureSize);
    const deletionTexture = createDeletionTexture(device, edits, width);
    const selectionTexture = createSelectionTexture(device, edits, width);
    if (device.isWebGPU) {
      try {
        const storageResources = await this.createStorageResources(asset, gpuPool);
        const playback = new Raw4DGpuPlayback(
          entity, resource, sampler, asset, edits, [deletionTexture, selectionTexture], deletionTexture, selectionTexture,
          width, gpuPool, storageResources, null,
        );
        playback.configureStorageBuffers(storageResources);
        return playback;
      } catch (error) {
        // #WDD-gpt 2026-08-16 - 显存预算/OOM 必须交给段落缓存淘汰后重试，禁止回退到更占显存的全量纹理路径。
        if (error instanceof Error && /GPU memory budget exceeded|out of memory/i.test(error.message)) {
          deletionTexture.destroy();
          selectionTexture.destroy();
          throw error;
        }
        console.warn('RAW4D StorageBuffer path unavailable; using texture fallback.', error);
      }
    }

    const textures = [deletionTexture, selectionTexture];
    try {
      if (options.streamTextureKeyframes) {
        const streaming = this.createStreamingTextureResources(device, asset, width);
        textures.push(streaming.position, streaming.rotation, streaming.color, streaming.scale, streaming.opacity);
        const lifetimeTexture = createLifetimeTexture(device, asset, width);
        textures.push(lifetimeTexture);
        const playback = new Raw4DGpuPlayback(
          entity, resource, sampler, asset, edits, textures, deletionTexture, selectionTexture,
          width, null, null, streaming,
        );
        playback.configureStreamingTextures(streaming, lifetimeTexture);
        return playback;
      }
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
        null,
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

  get backend(): 'storage-buffer' | 'texture' | 'streaming-texture' {
    if (this.storageResources) return 'storage-buffer';
    return this.streamingTextureResources ? 'streaming-texture' : 'texture';
  }

  get externalGpuByteSize(): number {
    return this.textures.reduce((total, texture) => {
      const bytesPerTexel = texture.format === PIXELFORMAT_R8 ? 1 : texture.format === PIXELFORMAT_RGBA32F ? 16 : 8;
      return total + texture.width * texture.height * bytesPerTexel;
    }, 0);
  }

  private static createStreamingTextureResources(
    device: GraphicsDevice,
    asset: Raw4DAsset,
    width: number,
  ): StreamingTexturePlaybackResources {
    const positionSlots = new KeyframeSlotCache(asset.position.keyframes.length, Math.min(3, asset.position.keyframes.length));
    const rotationSlots = new KeyframeSlotCache(asset.rotation.keyframes.length, Math.min(3, asset.rotation.keyframes.length));
    const colorSlots = new KeyframeSlotCache(asset.colorDc.keyframes.length, Math.min(4, asset.colorDc.keyframes.length), [0]);
    const scaleSlots = new KeyframeSlotCache(asset.scale.keyframes.length, Math.min(3, asset.scale.keyframes.length));
    const opacitySlots = new KeyframeSlotCache(asset.opacity.keyframes.length, Math.min(3, asset.opacity.keyframes.length));
    let position: Texture | null = null;
    let rotation: Texture | null = null;
    let color: Texture | null = null;
    let scale: Texture | null = null;
    let opacity: Texture | null = null;
    try {
      position = createStreamingTrackTexture(
        device, 'RAW4D Mobile Position Slots', asset.splatCount, positionSlots.slotCount, width, false,
      );
      rotation = createStreamingTrackTexture(
        device, 'RAW4D Mobile Rotation Slots', asset.splatCount, rotationSlots.slotCount, width, true,
      );
      color = createStreamingTrackTexture(
        device, 'RAW4D Mobile DC Slots', asset.splatCount, colorSlots.slotCount, width, true,
      );
      scale = createStreamingTrackTexture(
        device, 'RAW4D Mobile Scale Slots', asset.splatCount, scaleSlots.slotCount, width, true,
      );
      opacity = createStreamingTrackTexture(
        device, 'RAW4D Mobile Opacity Slots', asset.splatCount, opacitySlots.slotCount, width, true,
      );
      // #WDD-gpt 2026-08-19 - WebGL2 手机路径只上传当前插值所需关键帧，纹理大小不再随整段关键帧数线性增长。
      positionSlots.initialize((slot, key) => uploadStreamingTrackSlot(
        position!, asset.position, key, slot, [0, 1, 2], false,
      ));
      rotationSlots.initialize((slot, key) => uploadStreamingTrackSlot(
        rotation!, asset.rotation, key, slot, [1, 2, 3, 0], true,
      ));
      colorSlots.initialize((slot, key) => uploadStreamingTrackSlot(
        color!, asset.colorDc, key, slot, [0, 1, 2], true,
      ));
      scaleSlots.initialize((slot, key) => uploadStreamingTrackSlot(
        scale!, asset.scale, key, slot, [0, 1, 2], true,
      ));
      opacitySlots.initialize((slot, key) => uploadStreamingTrackSlot(
        opacity!, asset.opacity, key, slot, [0], true,
      ));
      return {
        position, rotation, color, scale, opacity,
        positionSlots, rotationSlots, colorSlots, scaleSlots, opacitySlots,
      };
    } catch (error) {
      position?.destroy();
      rotation?.destroy();
      color?.destroy();
      scale?.destroy();
      opacity?.destroy();
      throw error;
    }
  }

  private configureStreamingTextures(
    resources: StreamingTexturePlaybackResources,
    lifetimeTexture: Texture,
  ): void {
    const component = this.entity.gsplat!;
    component.setWorkBufferModifier({ glsl: modifierStreamingGLSL, wgsl: modifierStreamingWGSL });
    component.setParameter('dongRaw4dPositionTex', resources.position);
    component.setParameter('dongRaw4dRotationTex', resources.rotation);
    component.setParameter('dongRaw4dColorTex', resources.color);
    component.setParameter('dongRaw4dScaleTex', resources.scale);
    component.setParameter('dongRaw4dOpacityTex', resources.opacity);
    component.setParameter('dongRaw4dLifetimeTex', lifetimeTexture);
    component.setParameter('dongRaw4dDeleteMaskTex', this.deletionTexture);
    component.setParameter('dongRaw4dSelectionMaskTex', this.selectionTexture);
    component.setParameter('dongRaw4dTextureWidth', this.textureWidth);
    component.setParameter('dongRaw4dSplatCount', this.asset.splatCount);
    this.refreshStreamingTextureSlotParameters();
    component.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
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
    component.setParameter('dongRaw4dAllMode', 0);
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

  private ensureStreamingTextureFrame(frame: number): void {
    const resources = this.streamingTextureResources;
    if (!resources) return;
    let changed = false;
    changed = resources.positionSlots.ensure(keyframeRequirements(this.asset.position.keyframes, frame), (slot, key) => {
      uploadStreamingTrackSlot(resources.position, this.asset.position, key, slot, [0, 1, 2], false);
    }) || changed;
    changed = resources.rotationSlots.ensure(keyframeRequirements(this.asset.rotation.keyframes, frame), (slot, key) => {
      uploadStreamingTrackSlot(resources.rotation, this.asset.rotation, key, slot, [1, 2, 3, 0], true);
    }) || changed;
    changed = resources.colorSlots.ensure(keyframeRequirements(this.asset.colorDc.keyframes, frame), (slot, key) => {
      uploadStreamingTrackSlot(resources.color, this.asset.colorDc, key, slot, [0, 1, 2], true);
    }) || changed;
    changed = resources.scaleSlots.ensure(keyframeRequirements(this.asset.scale.keyframes, frame), (slot, key) => {
      uploadStreamingTrackSlot(resources.scale, this.asset.scale, key, slot, [0, 1, 2], true);
    }) || changed;
    changed = resources.opacitySlots.ensure(keyframeRequirements(this.asset.opacity.keyframes, frame), (slot, key) => {
      uploadStreamingTrackSlot(resources.opacity, this.asset.opacity, key, slot, [0], true);
    }) || changed;
    if (changed) this.refreshStreamingTextureSlotParameters();
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

  private refreshStreamingTextureSlotParameters(): void {
    const resources = this.streamingTextureResources;
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
    this.ensureStreamingTextureFrame(frame);
    const component = this.entity.gsplat!;
    component.setParameter('dongRaw4dFrame', frame);
    component.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
    if (this.resource.centers && this.sampler && raw4DSortCentersNeedRefresh(frame, this.lastCenterFrame)) {
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

  setAllMode(enabled: boolean): void {
    if (this.disposed) return;
    const component = this.entity.gsplat;
    if (!component) return;
    component.setParameter('dongRaw4dAllMode', enabled ? 1 : 0);
    component.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
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
