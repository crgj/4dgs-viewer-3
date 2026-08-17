import {
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  ShaderChunks,
  type Application,
} from 'playcanvas';

export type GaussianRenderMode = 'gaussian' | 'point' | 'ellipse' | 'all';
export type GaussianRasterKernel = 'playcanvas' | 'gsplat';

export const gaussianRenderModeValues: Record<GaussianRenderMode, number> = {
  gaussian: 0,
  point: 1,
  ellipse: 2,
  all: 3,
};

interface GaussianRenderThresholds {
  minContribution: number;
  minPixelSize: number;
}

const renderThresholds = new WeakMap<Application, GaussianRenderThresholds>();
const relightingEnabled = new WeakMap<Application, boolean>();
const GSPLAT_KERNEL_EXTENT = 3.33;
const GSPLAT_KERNEL_EXPONENT = 0.5 * GSPLAT_KERNEL_EXTENT * GSPLAT_KERNEL_EXTENT;

function replaceRequired(source: string, search: string, replacement: string, chunk: string): string {
  if (!source.includes(search)) throw new Error(`PlayCanvas ${chunk} changed; gsplat compatibility profile must be updated.`);
  return source.replace(search, replacement);
}

function gsplatProjectionChunks(app: Application, language: typeof SHADERLANGUAGE_GLSL | typeof SHADERLANGUAGE_WGSL): {
  corner: string;
  common: string;
  vertex: string;
} {
  const chunks = ShaderChunks.get(app.graphicsDevice, language);
  const isWgsl = language === SHADERLANGUAGE_WGSL;
  let corner = chunks.get('gsplatCornerVS');
  let common = chunks.get('gsplatCommonVS');
  let vertex = chunks.get('gsplatVS');
  corner = replaceRequired(
    corner,
    '2.0 * min(sqrt(2.0 * lambda1), vmin)',
    `${GSPLAT_KERNEL_EXTENT} * min(sqrt(lambda1), vmin)`,
    'gsplatCornerVS',
  );
  corner = replaceRequired(
    corner,
    '2.0 * min(sqrt(2.0 * lambda2), vmin)',
    `${GSPLAT_KERNEL_EXTENT} * min(sqrt(lambda2), vmin)`,
    'gsplatCornerVS',
  );
  common = replaceRequired(
    common,
    isWgsl ? '* half(0.5)' : '* 0.5',
    isWgsl ? `/ sqrt(half(${GSPLAT_KERNEL_EXPONENT}))` : `/ sqrt(${GSPLAT_KERNEL_EXPONENT})`,
    'gsplatCommonVS',
  );
  if (isWgsl) {
    vertex = replaceRequired(vertex, 'varying gaussianUV: half2;', 'varying gaussianUV: vec2f;', 'gsplatVS');
    vertex = replaceRequired(vertex, 'varying gaussianColor: half4;', 'varying gaussianColor: vec4f;', 'gsplatVS');
    vertex = replaceRequired(vertex, 'output.gaussianUV = corner.uv;', 'output.gaussianUV = vec2f(corner.uv);', 'gsplatVS');
    vertex = replaceRequired(
      vertex,
      'output.gaussianColor = half4(half3(rampColor), clr.a);',
      'output.gaussianColor = vec4f(rampColor, f32(clr.a));',
      'gsplatVS',
    );
    vertex = replaceRequired(
      vertex,
      'output.gaussianColor = half4(half3(prepareOutputFromGamma(max(vec3f(clr.xyz), vec3f(0.0)), -center.view.z)), clr.w);',
      'output.gaussianColor = vec4f(prepareOutputFromGamma(max(vec3f(clr.xyz), vec3f(0.0)), -center.view.z), f32(clr.w));',
      'gsplatVS',
    );
  } else {
    vertex = replaceRequired(vertex, 'varying mediump vec2 gaussianUV;', 'varying highp vec2 gaussianUV;', 'gsplatVS');
    vertex = replaceRequired(vertex, 'varying mediump vec4 gaussianColor;', 'varying highp vec4 gaussianColor;', 'gsplatVS');
  }
  return { corner, common, vertex };
}

// #WDD-gpt 2026-08-16 - Python gsplat直接计算 opacity*exp(-sigma)，不使用PlayCanvas在核边缘归零的归一化指数。
const gsplatFragmentGLSL = `
uniform float dongGsplatKernelExponent;
#ifndef DITHER_NONE
    #include "bayerPS"
    #include "opacityDitherPS"
    varying float id;
#endif

#if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
    uniform float alphaClip;
#endif

#ifdef PREPASS_PASS
    varying float vLinearDepth;
    #include "floatAsUintPS"
#endif

#if !defined(SHADOW_PASS) && !defined(PICK_PASS) && !defined(PREPASS_PASS)
    uniform float alphaClipForward;
#endif

varying highp vec2 gaussianUV;
varying highp vec4 gaussianColor;

#if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
    flat varying uint vPickId;
#endif

#ifdef PICK_PASS
    #include "pickPS"
#endif

#ifdef GSPLAT_USER_VARYINGS
    #include "gsplatUserVaryingsPS"
#endif
#include "gsplatModifyPS"

void main(void) {
    highp float A = dot(gaussianUV, gaussianUV);
    if (A > 1.0) discard;

    highp float alpha = min(0.999, exp(-dongGsplatKernelExponent * A) * gaussianColor.a);

    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        if (alpha < alphaClip) discard;
    #endif

    #ifdef PICK_PASS
        #ifdef GSPLAT_UNIFIED_ID
            pcFragColor0 = encodePickOutput(vPickId);
        #else
            pcFragColor0 = getPickOutput();
        #endif
        #ifdef DEPTH_PICK_PASS
            pcFragColor1 = getPickDepth();
        #endif
    #elif SHADOW_PASS
        gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
    #elif PREPASS_PASS
        gl_FragColor = float2vec4(vLinearDepth);
    #else
        if (alpha < alphaClipForward) discard;
        #ifndef DITHER_NONE
            opacityDither(alpha, id * 0.013);
        #endif
        vec4 fragColor = vec4(gaussianColor.xyz, alpha);
        modifySplatColor(gaussianUV, fragColor);
        gl_FragColor = vec4(fragColor.xyz * fragColor.a, fragColor.a);
    #endif
}
`;

const gsplatFragmentWGSL = `
uniform dongGsplatKernelExponent: f32;
#ifndef DITHER_NONE
    #include "bayerPS"
    #include "opacityDitherPS"
    varying id: f32;
#endif

#if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
    uniform alphaClip: f32;
#endif

#ifdef PREPASS_PASS
    varying vLinearDepth: f32;
    #include "floatAsUintPS"
#endif

#if !defined(SHADOW_PASS) && !defined(PICK_PASS) && !defined(PREPASS_PASS)
    uniform alphaClipForward: f32;
#endif

varying gaussianUV: vec2f;
varying gaussianColor: vec4f;

#if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
    varying @interpolate(flat) vPickId: u32;
#endif

#ifdef PICK_PASS
    #include "pickPS"
#endif

#ifdef GSPLAT_USER_VARYINGS
    #include "gsplatUserVaryingsPS"
#endif
#include "gsplatModifyPS"

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let A = dot(gaussianUV, gaussianUV);
    if (A > 1.0) { discard; }

    let alpha = min(0.999, exp(-uniform.dongGsplatKernelExponent * A) * gaussianColor.a);

    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        if (alpha < uniform.alphaClip) { discard; return output; }
    #endif

    #ifdef PICK_PASS
        #ifdef GSPLAT_UNIFIED_ID
            output.color = encodePickOutput(vPickId);
        #else
            output.color = getPickOutput();
        #endif
        #ifdef DEPTH_PICK_PASS
            output.color1 = getPickDepth();
        #endif
    #elif SHADOW_PASS
        output.color = vec4f(input.position.z, 0.0, 0.0, 1.0);
    #elif PREPASS_PASS
        output.color = float2vec4(vLinearDepth);
    #else
        if (alpha < uniform.alphaClipForward) { discard; }
        #ifndef DITHER_NONE
            opacityDither(alpha, id * 0.013);
        #endif
        var fragColor = vec4f(gaussianColor.xyz, alpha);
        modifySplatColor(gaussianUV, &fragColor);
        output.color = vec4f(fragColor.xyz * fragColor.a, fragColor.a);
    #endif
    return output;
}
`;

const modifyVertexGLSL = `
uniform float dongRenderMode;

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    if ((dongRenderMode > 0.5 && dongRenderMode < 1.5) || dongRenderMode > 2.5) {
        float pointScale = max(max(scale.x, scale.y), scale.z) * 0.0175;
        scale = vec3(max(pointScale, 0.00075));
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
    if (dongRenderMode > 2.5) {
        bool finiteCenter = all(equal(center, center)) && all(lessThan(abs(center), vec3(100000.0)));
        bool finiteColor = all(equal(color, color)) && all(lessThan(abs(color), vec4(100000.0)));
        // #WDD-gpt 2026-08-17 - 当前帧低透明度、生命周期门控和合法 -Infinity opacity 都不是数据异常；ALL 红色只表达不可用的解码值。
        bool validPoint = finiteCenter && finiteColor;
        color = vec4(validPoint ? vec3(0.12, 1.0, 0.34) : vec3(1.0, 0.12, 0.10), 1.0);
    }
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
        color.a = pointEdge;
        float centerDot = 1.0 - smoothstep(0.015, 0.040, radialDistance);
        color.rgb = mix(color.rgb, vec3(0.08, 0.42, 1.0), centerDot);
    } else if (dongRenderMode < 2.5) {
        float ellipseInnerEdge = smoothstep(0.64, 0.72, radialDistance);
        float ellipseOuterEdge = 1.0 - smoothstep(0.86, 0.93, radialDistance);
        color.a = sourceOpacity * ellipseInnerEdge * ellipseOuterEdge * 0.95;
        color.rgb = mix(color.rgb, vec3(1.0), 0.08);
    } else {
        // #WDD-gpt 2026-08-16 - “全部”是绿色正常点/红色异常点诊断点，不再回退为高斯椭圆。
        color.a = 1.0 - smoothstep(0.70, 0.96, radialDistance);
    }
}
`;

const modifyVertexWGSL = `
uniform dongRenderMode: f32;

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    if ((uniform.dongRenderMode > 0.5 && uniform.dongRenderMode < 1.5) || uniform.dongRenderMode > 2.5) {
        let currentScale = *scale;
        let pointScale = max(max(currentScale.x, currentScale.y), currentScale.z) * 0.0175;
        *scale = vec3f(max(pointScale, 0.00075));
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    if (uniform.dongRenderMode > 2.5) {
        let finiteCenter = all(center == center) && all(abs(center) < vec3f(100000.0));
        let currentColor = *color;
        let finiteColor = all(currentColor == currentColor) && all(abs(currentColor) < vec4f(100000.0));
        // #WDD-gpt 2026-08-17 - 与 GLSL 保持一致，透明度大小不参与异常判定，避免把正常的时序隐藏点误报为红点。
        let validPoint = finiteCenter && finiteColor;
        let diagnosticColor = select(vec3f(1.0, 0.12, 0.10), vec3f(0.12, 1.0, 0.34), validPoint);
        *color = vec4f(diagnosticColor, 1.0);
    }
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
        (*color).a = pointEdge;
        let centerDot = 1.0 - smoothstep(0.015, 0.040, radialDistance);
        (*color).rgb = mix((*color).rgb, vec3f(0.08, 0.42, 1.0), centerDot);
    } else if (uniform.dongRenderMode < 2.5) {
        let ellipseInnerEdge = smoothstep(0.64, 0.72, radialDistance);
        let ellipseOuterEdge = 1.0 - smoothstep(0.86, 0.93, radialDistance);
        (*color).a = sourceOpacity * ellipseInnerEdge * ellipseOuterEdge * 0.95;
        (*color).rgb = mix((*color).rgb, vec3f(1.0), 0.08);
    } else {
        (*color).a = 1.0 - smoothstep(0.70, 0.96, radialDistance);
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
    float radialDistance = dot(gaussianUV, gaussianUV);
    if (dongRenderMode > 0.5) {
        float exp4 = exp(-4.0);
        float gaussianProfile = (exp(-4.0 * radialDistance) - exp4) / (1.0 - exp4);
        float sourceOpacity = color.a / max(gaussianProfile, 0.0001);

        if (dongRenderMode < 1.5) {
            float pointEdge = 1.0 - smoothstep(0.70, 0.96, radialDistance);
            color.a = pointEdge;
        } else if (dongRenderMode < 2.5) {
            float ellipseInnerEdge = smoothstep(0.64, 0.72, radialDistance);
            float ellipseOuterEdge = 1.0 - smoothstep(0.86, 0.93, radialDistance);
            color.a = sourceOpacity * ellipseInnerEdge * ellipseOuterEdge * 0.95;
            color.rgb = mix(color.rgb, vec3(1.0), 0.08);
        } else {
            color.a = 1.0 - smoothstep(0.70, 0.96, radialDistance);
        }
    }

    if (dongRenderMode > 2.5) return;
    vec4 lit = textureLod(uRelightMap, gl_FragCoord.xy * uScreenSize.zw, 0.0);
    vec3 hdrLighting = max(lit.rgb * uRelightBrightness, vec3(0.0));
    vec3 displayLighting = log2(vec3(1.0) + hdrLighting);
    vec3 factor = mix(vec3(uRelightBackground), displayLighting, lit.a);
    // #WDD-gpt 2026-08-16 - Apply the light factor as bounded display exposure: factor 1 is unchanged, shadows darken, and highlights approach white without clipping all source channels.
    vec3 boundedBaseColor = clamp(color.rgb, vec3(0.0), vec3(0.999999));
    vec3 boundedRelitColor = vec3(1.0) - pow(max(vec3(1.0) - boundedBaseColor, vec3(0.000001)), max(factor, vec3(0.0)));
    color.rgb = mix(color.rgb, boundedRelitColor, uRelightBlend);
    if (dongRenderMode > 0.5 && dongRenderMode < 1.5) {
        float centerDot = 1.0 - smoothstep(0.015, 0.040, radialDistance);
        color.rgb = mix(color.rgb, vec3(0.08, 0.42, 1.0), centerDot);
    }
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
    let radialDistance = dot(gaussianUV, gaussianUV);
    if (uniform.dongRenderMode > 0.5) {
        let exp4 = exp(-4.0);
        let gaussianProfile = (exp(-4.0 * radialDistance) - exp4) / (1.0 - exp4);
        let sourceOpacity = (*color).a / max(gaussianProfile, 0.0001);

        if (uniform.dongRenderMode < 1.5) {
            let pointEdge = 1.0 - smoothstep(0.70, 0.96, radialDistance);
            (*color).a = pointEdge;
        } else if (uniform.dongRenderMode < 2.5) {
            let ellipseInnerEdge = smoothstep(0.64, 0.72, radialDistance);
            let ellipseOuterEdge = 1.0 - smoothstep(0.86, 0.93, radialDistance);
            (*color).a = sourceOpacity * ellipseInnerEdge * ellipseOuterEdge * 0.95;
            (*color).rgb = mix((*color).rgb, vec3f(1.0), 0.08);
        } else {
            (*color).a = 1.0 - smoothstep(0.70, 0.96, radialDistance);
        }
    }

    if (uniform.dongRenderMode > 2.5) { return; }
    let lit = textureSampleLevel(uRelightMap, uRelightMapSampler, pcPosition.xy * uniform.uScreenSize.zw, 0.0);
    let hdrLighting = max(lit.rgb * uniform.uRelightBrightness, vec3f(0.0));
    let displayLighting = log2(vec3f(1.0) + hdrLighting);
    let factor = mix(vec3f(uniform.uRelightBackground), displayLighting, lit.a);
    // #WDD-gpt 2026-08-16 - Match the bounded GLSL exposure transfer so WebGPU preserves the captured Gaussian color under strong lights.
    let boundedBaseColor = clamp((*color).rgb, vec3f(0.0), vec3f(0.999999));
    let boundedRelitColor = vec3f(1.0) - pow(max(vec3f(1.0) - boundedBaseColor, vec3f(0.000001)), max(factor, vec3f(0.0)));
    *color = vec4f(mix((*color).rgb, boundedRelitColor, uniform.uRelightBlend), (*color).a);
    if (uniform.dongRenderMode > 0.5 && uniform.dongRenderMode < 1.5) {
        let centerDot = 1.0 - smoothstep(0.015, 0.040, radialDistance);
        (*color).rgb = mix((*color).rgb, vec3f(0.08, 0.42, 1.0), centerDot);
    }
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
  // #WDD-gpt 2026-08-16 - 默认采用与Python gsplat一致的指数核、0.999 alpha上限和3.33σ覆盖范围。
  setGaussianRasterKernel(app, 'gsplat');
  setGaussianRenderMode(app, initialMode);
}

// #WDD-gpt 2026-08-15 - 将重光照采样与既有点/椭圆模式合并到同一个 fragment hook，避免插件互相覆盖 shader chunk。
export function setGaussianRelightingShader(app: Application, enabled: boolean): void {
  relightingEnabled.set(app, enabled);
  installFragmentChunk(app);
  app.scene.gsplat.material.update();
}

export function setGaussianRasterKernel(app: Application, kernel: GaussianRasterKernel): void {
  const material = app.scene.gsplat.material;
  if (kernel === 'gsplat') {
    const glslProjection = gsplatProjectionChunks(app, SHADERLANGUAGE_GLSL);
    const wgslProjection = gsplatProjectionChunks(app, SHADERLANGUAGE_WGSL);
    material.shaderChunks.glsl.set('gsplatPS', gsplatFragmentGLSL);
    material.shaderChunks.wgsl.set('gsplatPS', gsplatFragmentWGSL);
    material.shaderChunks.glsl.set('gsplatCornerVS', glslProjection.corner);
    material.shaderChunks.wgsl.set('gsplatCornerVS', wgslProjection.corner);
    material.shaderChunks.glsl.set('gsplatCommonVS', glslProjection.common);
    material.shaderChunks.wgsl.set('gsplatCommonVS', wgslProjection.common);
    material.shaderChunks.glsl.set('gsplatVS', glslProjection.vertex);
    material.shaderChunks.wgsl.set('gsplatVS', wgslProjection.vertex);
    material.setParameter('dongGsplatKernelExponent', GSPLAT_KERNEL_EXPONENT);
  } else {
    material.shaderChunks.glsl.delete('gsplatPS');
    material.shaderChunks.wgsl.delete('gsplatPS');
    material.shaderChunks.glsl.delete('gsplatCornerVS');
    material.shaderChunks.wgsl.delete('gsplatCornerVS');
    material.shaderChunks.glsl.delete('gsplatCommonVS');
    material.shaderChunks.wgsl.delete('gsplatCommonVS');
    material.shaderChunks.glsl.delete('gsplatVS');
    material.shaderChunks.wgsl.delete('gsplatVS');
  }
  material.update();
}

export function setGaussianRenderMode(app: Application, mode: GaussianRenderMode): void {
  const thresholds = renderThresholds.get(app) ?? {
    minContribution: app.scene.gsplat.minContribution,
    minPixelSize: app.scene.gsplat.minPixelSize,
  };
  renderThresholds.set(app, thresholds);

  const keepDistantPoints = mode === 'point' || mode === 'all';
  app.scene.gsplat.minPixelSize = keepDistantPoints ? 0 : thresholds.minPixelSize;
  app.scene.gsplat.minContribution = keepDistantPoints ? 0 : thresholds.minContribution;

  const material = app.scene.gsplat.material;
  material.setParameter('dongRenderMode', gaussianRenderModeValues[mode]);
  material.update();
}
