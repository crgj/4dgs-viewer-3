import type { Application } from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import {
  installGaussianRenderModes,
  setGaussianRelightingShader,
  setGaussianRenderMode,
} from './GaussianRenderMode';

function createApplicationMock() {
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
  const app = { scene: { gsplat } } as unknown as Application;
  return { app, gsplat, material };
}

describe('GaussianRenderMode', () => {
  it('installs matching GLSL and WGSL shader hooks', () => {
    const { app, material } = createApplicationMock();

    installGaussianRenderModes(app, 'gaussian');

    expect(material.shaderChunks.version).toBe('2.21');
    expect([...material.shaderChunks.glsl.keys()]).toEqual(['gsplatModifyVS', 'gsplatModifyPS']);
    expect([...material.shaderChunks.wgsl.keys()]).toEqual(['gsplatModifyVS', 'gsplatModifyPS']);
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('ellipseInnerEdge');
    expect(material.shaderChunks.glsl.get('gsplatModifyVS')).toContain('0.0175');
    expect(material.shaderChunks.glsl.get('gsplatModifyVS')).toContain('validPoint ? vec3(0.12, 1.0, 0.34)');
    expect(material.shaderChunks.glsl.get('gsplatModifyVS')).toContain('|| dongRenderMode > 2.5');
    expect(material.shaderChunks.wgsl.get('gsplatModifyVS')).toContain('diagnosticColor');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('color.a = pointEdge');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('centerDot');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('color.a = 1.0 - smoothstep(0.70, 0.96, radialDistance)');
    expect(material.setParameter).toHaveBeenCalledWith('dongRenderMode', 0);
    expect(material.update).toHaveBeenCalledOnce();
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
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('compressedLighting');
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).toContain('boundedRelitColor');
    expect(material.shaderChunks.wgsl.get('gsplatModifyPS')).toContain('uRelightMapSampler');
    expect(material.shaderChunks.wgsl.get('gsplatModifyPS')).toContain('compressedLighting');
    expect(material.shaderChunks.wgsl.get('gsplatModifyPS')).toContain('boundedRelitColor');

    setGaussianRelightingShader(app, false);
    expect(material.shaderChunks.glsl.get('gsplatModifyPS')).not.toContain('uRelightMap');
  });
});
