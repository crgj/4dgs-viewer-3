import type { Application } from 'playcanvas';

export type GaussianRenderMode = 'gaussian' | 'point' | 'ellipse';

export const gaussianRenderModeValues: Record<GaussianRenderMode, number> = {
  gaussian: 0,
  point: 1,
  ellipse: 2,
};

interface GaussianRenderThresholds {
  minContribution: number;
  minPixelSize: number;
}

const renderThresholds = new WeakMap<Application, GaussianRenderThresholds>();
const relightingEnabled = new WeakMap<Application, boolean>();

const modifyVertexGLSL = `
uniform float dongRenderMode;

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    if (dongRenderMode > 0.5 && dongRenderMode < 1.5) {
        float pointScale = max(max(scale.x, scale.y), scale.z) * 0.035;
        scale = vec3(max(pointScale, 0.0015));
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
}
`;

const modifyFragmentGLSL = `
uniform float dongRenderMode;

void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
    if (dongRenderMode < 0.5) {
        return;
    }

    float radialDistance = dot(gaussianUV, gaussianUV);
    float exp4 = exp(-4.0);
    float gaussianProfile = (exp(-4.0 * radialDistance) - exp4) / (1.0 - exp4);
    float sourceOpacity = color.a / max(gaussianProfile, 0.0001);

    if (dongRenderMode < 1.5) {
        float pointEdge = 1.0 - smoothstep(0.70, 0.96, radialDistance);
        color.a = sourceOpacity * pointEdge;
    } else {
        float ellipseInnerEdge = smoothstep(0.64, 0.72, radialDistance);
        float ellipseOuterEdge = 1.0 - smoothstep(0.86, 0.93, radialDistance);
        color.a = sourceOpacity * ellipseInnerEdge * ellipseOuterEdge * 0.95;
        color.rgb = mix(color.rgb, vec3(1.0), 0.08);
    }
}
`;

const modifyVertexWGSL = `
uniform dongRenderMode: f32;

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    if (uniform.dongRenderMode > 0.5 && uniform.dongRenderMode < 1.5) {
        let currentScale = *scale;
        let pointScale = max(max(currentScale.x, currentScale.y), currentScale.z) * 0.035;
        *scale = vec3f(max(pointScale, 0.0015));
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
}
`;

const modifyFragmentWGSL = `
uniform dongRenderMode: f32;

fn modifySplatColor(gaussianUV: vec2f, color: ptr<function, vec4f>) {
    if (uniform.dongRenderMode < 0.5) {
        return;
    }

    let radialDistance = dot(gaussianUV, gaussianUV);
    let exp4 = exp(-4.0);
    let gaussianProfile = (exp(-4.0 * radialDistance) - exp4) / (1.0 - exp4);
    let sourceOpacity = (*color).a / max(gaussianProfile, 0.0001);

    if (uniform.dongRenderMode < 1.5) {
        let pointEdge = 1.0 - smoothstep(0.70, 0.96, radialDistance);
        (*color).a = sourceOpacity * pointEdge;
    } else {
        let ellipseInnerEdge = smoothstep(0.64, 0.72, radialDistance);
        let ellipseOuterEdge = 1.0 - smoothstep(0.86, 0.93, radialDistance);
        (*color).a = sourceOpacity * ellipseInnerEdge * ellipseOuterEdge * 0.95;
        (*color).rgb = mix((*color).rgb, vec3f(1.0), 0.08);
    }
}
`;

const modifyRelitFragmentGLSL = `
uniform float dongRenderMode;
uniform sampler2D uRelightMap;
uniform vec4 uScreenSize;
uniform float uRelightBlend;
uniform float uRelightBrightness;
uniform float uRelightBackground;

void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
    if (dongRenderMode > 0.5) {
        float radialDistance = dot(gaussianUV, gaussianUV);
        float exp4 = exp(-4.0);
        float gaussianProfile = (exp(-4.0 * radialDistance) - exp4) / (1.0 - exp4);
        float sourceOpacity = color.a / max(gaussianProfile, 0.0001);

        if (dongRenderMode < 1.5) {
            float pointEdge = 1.0 - smoothstep(0.70, 0.96, radialDistance);
            color.a = sourceOpacity * pointEdge;
        } else {
            float ellipseInnerEdge = smoothstep(0.64, 0.72, radialDistance);
            float ellipseOuterEdge = 1.0 - smoothstep(0.86, 0.93, radialDistance);
            color.a = sourceOpacity * ellipseInnerEdge * ellipseOuterEdge * 0.95;
            color.rgb = mix(color.rgb, vec3(1.0), 0.08);
        }
    }

    vec4 lit = textureLod(uRelightMap, gl_FragCoord.xy * uScreenSize.zw, 0.0);
    vec3 hdrLighting = max(lit.rgb * uRelightBrightness, vec3(0.0));
    vec3 compressedLighting = 2.0 * hdrLighting / (vec3(1.0) + hdrLighting);
    vec3 factor = mix(vec3(uRelightBackground), compressedLighting, lit.a);
    // #WDD-gpt 2026-08-16 - Apply the light factor as bounded display exposure: factor 1 is unchanged, shadows darken, and highlights approach white without clipping all source channels.
    vec3 boundedBaseColor = clamp(color.rgb, vec3(0.0), vec3(0.999999));
    vec3 boundedRelitColor = vec3(1.0) - pow(max(vec3(1.0) - boundedBaseColor, vec3(0.000001)), max(factor, vec3(0.0)));
    color.rgb = mix(color.rgb, boundedRelitColor, uRelightBlend);
}
`;

const modifyRelitFragmentWGSL = `
uniform dongRenderMode: f32;
var uRelightMap: texture_2d<f32>;
var uRelightMapSampler: sampler;
uniform uScreenSize: vec4f;
uniform uRelightBlend: f32;
uniform uRelightBrightness: f32;
uniform uRelightBackground: f32;

fn modifySplatColor(gaussianUV: vec2f, color: ptr<function, vec4f>) {
    if (uniform.dongRenderMode > 0.5) {
        let radialDistance = dot(gaussianUV, gaussianUV);
        let exp4 = exp(-4.0);
        let gaussianProfile = (exp(-4.0 * radialDistance) - exp4) / (1.0 - exp4);
        let sourceOpacity = (*color).a / max(gaussianProfile, 0.0001);

        if (uniform.dongRenderMode < 1.5) {
            let pointEdge = 1.0 - smoothstep(0.70, 0.96, radialDistance);
            (*color).a = sourceOpacity * pointEdge;
        } else {
            let ellipseInnerEdge = smoothstep(0.64, 0.72, radialDistance);
            let ellipseOuterEdge = 1.0 - smoothstep(0.86, 0.93, radialDistance);
            (*color).a = sourceOpacity * ellipseInnerEdge * ellipseOuterEdge * 0.95;
            (*color).rgb = mix((*color).rgb, vec3f(1.0), 0.08);
        }
    }

    let lit = textureSampleLevel(uRelightMap, uRelightMapSampler, pcPosition.xy * uniform.uScreenSize.zw, 0.0);
    let hdrLighting = max(lit.rgb * uniform.uRelightBrightness, vec3f(0.0));
    let compressedLighting = 2.0 * hdrLighting / (vec3f(1.0) + hdrLighting);
    let factor = mix(vec3f(uniform.uRelightBackground), compressedLighting, lit.a);
    // #WDD-gpt 2026-08-16 - Match the bounded GLSL exposure transfer so WebGPU preserves the captured Gaussian color under strong lights.
    let boundedBaseColor = clamp((*color).rgb, vec3f(0.0), vec3f(0.999999));
    let boundedRelitColor = vec3f(1.0) - pow(max(vec3f(1.0) - boundedBaseColor, vec3f(0.000001)), max(factor, vec3f(0.0)));
    *color = vec4f(mix((*color).rgb, boundedRelitColor, uniform.uRelightBlend), (*color).a);
}
`;

function installFragmentChunk(app: Application): void {
  const material = app.scene.gsplat.material;
  const relit = relightingEnabled.get(app) ?? false;
  material.shaderChunks.glsl.set('gsplatModifyPS', relit ? modifyRelitFragmentGLSL : modifyFragmentGLSL);
  material.shaderChunks.wgsl.set('gsplatModifyPS', relit ? modifyRelitFragmentWGSL : modifyFragmentWGSL);
}

export function installGaussianRenderModes(app: Application, initialMode: GaussianRenderMode): void {
  const material = app.scene.gsplat.material;
  renderThresholds.set(app, {
    minContribution: app.scene.gsplat.minContribution,
    minPixelSize: app.scene.gsplat.minPixelSize,
  });
  material.shaderChunks.version = '2.21';
  material.shaderChunks.glsl.set('gsplatModifyVS', modifyVertexGLSL);
  material.shaderChunks.wgsl.set('gsplatModifyVS', modifyVertexWGSL);
  installFragmentChunk(app);
  setGaussianRenderMode(app, initialMode);
}

// #WDD-gpt 2026-08-15 - 将重光照采样与既有点/椭圆模式合并到同一个 fragment hook，避免插件互相覆盖 shader chunk。
export function setGaussianRelightingShader(app: Application, enabled: boolean): void {
  relightingEnabled.set(app, enabled);
  installFragmentChunk(app);
  app.scene.gsplat.material.update();
}

export function setGaussianRenderMode(app: Application, mode: GaussianRenderMode): void {
  const thresholds = renderThresholds.get(app) ?? {
    minContribution: app.scene.gsplat.minContribution,
    minPixelSize: app.scene.gsplat.minPixelSize,
  };
  renderThresholds.set(app, thresholds);

  const keepDistantPoints = mode === 'point';
  app.scene.gsplat.minPixelSize = keepDistantPoints ? 0 : thresholds.minPixelSize;
  app.scene.gsplat.minContribution = keepDistantPoints ? 0 : thresholds.minContribution;

  const material = app.scene.gsplat.material;
  material.setParameter('dongRenderMode', gaussianRenderModeValues[mode]);
  material.update();
}
