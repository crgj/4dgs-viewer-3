import {
  SHADERLANGUAGE_GLSL,
  ShaderChunks,
  type Application,
} from 'playcanvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installGaussianRenderModes,
  setGaussianRelightingShader,
  setGaussianRenderMode,
} from './GaussianRenderMode';

function createApplicationMock() {
  const glsl = new Map([
    ['gsplatCornerVS', 'float l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);\nfloat l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);'],
    ['gsplatCommonVS', 'float clip = sqrt(value) * 0.5;'],
    ['gsplatVS', 'varying mediump vec2 gaussianUV;\nvarying mediump vec4 gaussianColor;'],
  ]);
  const wgsl = new Map([
    ['gsplatCornerVS', 'let l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);\nlet l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);'],
    ['gsplatCommonVS', 'let clip = sqrt(value) * half(0.5);'],
    ['gsplatVS', [
      'varying gaussianUV: half2;',
      'varying gaussianColor: half4;',
      'output.gaussianUV = corner.uv;',
      'output.gaussianColor = half4(half3(rampColor), clr.a);',
      'output.gaussianColor = half4(half3(prepareOutputFromGamma(max(vec3f(clr.xyz), vec3f(0.0)), -center.view.z)), clr.w);',
    ].join('\n')],
  ]);
  vi.spyOn(ShaderChunks, 'get').mockImplementation((_device, language) => (
    language === SHADERLANGUAGE_GLSL ? glsl : wgsl
  ) as ReturnType<typeof ShaderChunks.get>);
  const material = {
    setParameter: vi.fn(),
    shaderChunks: {
      version: '',
      glsl: new Map<string, string>(),
      wgsl: new Map<string, string>(),
    },
    update: vi.fn(),
  };
  const gsplat = { material, minContribution: 3, minPixelSize: 2 };
  const app = { graphicsDevice: {}, scene: { gsplat } } as unknown as Application;
  return { app, gsplat, material };
}

afterEach(() => vi.restoreAllMocks());

describe('GaussianRenderMode', () => {
  it('installs matching GLSL and WGSL shader hooks', () => {
    const { app, material } = createApplicationMock();

    installGaussianRenderModes(app, 'gaussian');

    expect(material.shaderChunks.version).toBe('2.21');
    expect([...material.shaderChunks.glsl.keys()]).toEqual([
      'gsplatModifyVS', 'gsplatModifyPS', 'gsplatPS', 'gsplatCornerVS', 'gsplatCommonVS', 'gsplatVS',
    ]);
    expect([...material.shaderChunks.wgsl.keys()]).toEqual([
      'gsplatModifyVS', 'gsplatModifyPS', 'gsplatPS', 'gsplatCornerVS', 'gsplatCommonVS', 'gsplatVS',
    ]);
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('ellipseInnerEdge');
    expect(material.shaderChunks.glsl.get('gsplatModifyVS')).toContain('0.0175');
    expect(material.shaderChunks.glsl.get('gsplatModifyVS')).toContain('validPoint ? vec3(0.12, 1.0, 0.34)');
    expect(material.shaderChunks.glsl.get('gsplatModifyVS')).toContain('|| dongRenderMode > 2.5');
    expect(material.shaderChunks.wgsl.get('gsplatModifyVS')).toContain('diagnosticColor');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('color.a = pointEdge');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('centerDot');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('color.a = 1.0 - smoothstep(0.70, 0.96, radialDistance)');
    expect(material.shaderChunks.glsl.get('gsplatPS')).toContain('exp(-dongGsplatKernelExponent * A)');
    expect(material.shaderChunks.glsl.get('gsplatCornerVS')).toContain('3.33 * min(sqrt(lambda1), vmin)');
    expect(material.shaderChunks.wgsl.get('gsplatVS')).toContain('varying gaussianUV: vec2f;');
    expect(material.setParameter).toHaveBeenCalledWith('dongGsplatKernelExponent', 0.5 * 3.33 * 3.33);
    expect(material.setParameter).toHaveBeenCalledWith('dongRenderMode', 0);
    expect(material.update).toHaveBeenCalledTimes(2);
  });

  it('maps point and ellipse modes to distinct shader values', () => {
    const { app, gsplat, material } = createApplicationMock();

    setGaussianRenderMode(app, 'point');
    expect(gsplat.minPixelSize).toBe(0);
    expect(gsplat.minContribution).toBe(0);

    setGaussianRenderMode(app, 'ellipse');
    expect(gsplat.minPixelSize).toBe(2);
    expect(gsplat.minContribution).toBe(3);

    setGaussianRenderMode(app, 'all');
    expect(gsplat.minPixelSize).toBe(0);
    expect(gsplat.minContribution).toBe(0);

    expect(material.setParameter).toHaveBeenNthCalledWith(1, 'dongRenderMode', 1);
    expect(material.setParameter).toHaveBeenNthCalledWith(2, 'dongRenderMode', 2);
    expect(material.setParameter).toHaveBeenNthCalledWith(3, 'dongRenderMode', 3);
    expect(material.update).toHaveBeenCalledTimes(3);
  });

  it('composes relighting with the existing point and ellipse fragment modes', () => {
    const { app, material } = createApplicationMock();
    installGaussianRenderModes(app, 'ellipse');

    setGaussianRelightingShader(app, true);

    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('uRelightMap');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('ellipseInnerEdge');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('displayLighting');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('log2(vec3(1.0) + hdrLighting)');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('boundedRelitColor');
    expect(material.shaderChunks.wgsl.get('gsplatModifyPS')).toContain('uRelightMapSampler');
    expect(material.shaderChunks.wgsl.get('gsplatModifyPS')).toContain('displayLighting');
    expect(material.shaderChunks.wgsl.get('gsplatModifyPS')).toContain('log2(vec3f(1.0) + hdrLighting)');
    expect(material.shaderChunks.wgsl.get('gsplatModifyPS')).toContain('boundedRelitColor');

    setGaussianRelightingShader(app, false);
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).not.toContain('uRelightMap');
  });
});
