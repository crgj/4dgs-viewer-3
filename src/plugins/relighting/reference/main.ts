import {
  Application,
  Color,
  DEVICETYPE_WEBGL2,
  Entity,
  GAMMA_NONE,
  LIGHTFALLOFF_LINEAR,
  PIXELFORMAT_RGBA8,
  RenderTarget,
  StandardMaterial,
  Texture,
  TONEMAP_NONE,
  createGraphicsDevice,
} from 'playcanvas';

interface RelightingReferenceResult {
  readonly direction: {
    readonly leftLightLeftLuma: number;
    readonly leftLightRightLuma: number;
    readonly rightLightLeftLuma: number;
    readonly rightLightRightLuma: number;
  };
  readonly range: {
    readonly shortRangeCenterLuma: number;
    readonly longRangeCenterLuma: number;
  };
  pass: boolean;
}

declare global {
  interface Window {
    __relightingReferenceResult?: RelightingReferenceResult;
  }
}

const size = 384;
const gpuCanvasNode = document.querySelector<HTMLCanvasElement>('#gpu');
const previewCanvasNode = document.querySelector<HTMLCanvasElement>('#preview');
const resultNodeFound = document.querySelector<HTMLElement>('#result');
if (!gpuCanvasNode || !previewCanvasNode || !resultNodeFound) throw new Error('Relighting reference DOM is incomplete.');
const gpuCanvas = gpuCanvasNode;
const previewCanvas = previewCanvasNode;
const resultNode = resultNodeFound;

// #WDD-gpt 2026-08-16 - This isolated renderer uses the same PlayCanvas point-light/material contract as the plugin and publishes deterministic pixel checks for browser acceptance.
const device = await createGraphicsDevice(gpuCanvas, {
  deviceTypes: [DEVICETYPE_WEBGL2],
  antialias: false,
});
const app = new Application(gpuCanvas, { graphicsDevice: device });
app.scene.ambientLight = Color.BLACK;

const texture = new Texture(device, {
  name: 'RelightingReferenceColor',
  width: size,
  height: size,
  format: PIXELFORMAT_RGBA8,
  mipmaps: false,
});
const renderTarget = new RenderTarget({ colorBuffer: texture, depth: true });

const camera = new Entity('Reference Camera');
camera.addComponent('camera', {
  clearColor: new Color(0, 0, 0, 1),
  farClip: 20,
  fov: 45,
  gammaCorrection: GAMMA_NONE,
  nearClip: 0.01,
  renderTarget,
  toneMapping: TONEMAP_NONE,
});
camera.setPosition(0, 0, 4);
camera.lookAt(0, 0, 0);
app.root.addChild(camera);

const material = new StandardMaterial();
material.ambient = Color.BLACK;
material.diffuse = new Color(0.5, 0.5, 0.5);
material.emissive = Color.BLACK;
material.specular = Color.BLACK;
material.gloss = 0;
material.useSkybox = false;
material.update();

const sphere = new Entity('Reference Mesh');
sphere.addComponent('render', { type: 'sphere' });
sphere.render!.material = material;
app.root.addChild(sphere);

const light = new Entity('Reference Point Light');
light.addComponent('light', {
  castShadows: false,
  color: Color.WHITE,
  intensity: 0.7,
  range: 4,
  type: 'omni',
});
light.light!.falloffMode = LIGHTFALLOFF_LINEAR;
app.root.addChild(light);
app.start();

function waitForFrame(): Promise<void> {
  return new Promise((resolve) => {
    app.once('postrender', resolve);
    app.renderNextFrame = true;
  });
}

async function renderScenario(x: number, range: number): Promise<Uint8Array> {
  light.setPosition(x, 0, 2);
  light.light!.range = range;
  await waitForFrame();
  return texture.read(0, 0, size, size, { immediate: true, renderTarget }) as Promise<Uint8Array>;
}

function regionLuminance(
  pixels: Uint8Array,
  minimumX: number,
  maximumX: number,
  minimumY: number,
  maximumY: number,
): number {
  let sum = 0;
  let count = 0;
  for (let y = minimumY; y < maximumY; y += 1) {
    for (let x = minimumX; x < maximumX; x += 1) {
      const offset = (y * size + x) * 4;
      const red = pixels[offset] / 255;
      const green = pixels[offset + 1] / 255;
      const blue = pixels[offset + 2] / 255;
      if (red + green + blue < 0.03) continue;
      sum += red * 0.2126 + green * 0.7152 + blue * 0.0722;
      count += 1;
    }
  }
  return sum / Math.max(1, count);
}

function drawPreview(pixels: Uint8Array): void {
  const context = previewCanvas.getContext('2d');
  if (!context) return;
  const flipped = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < size; y += 1) {
    const sourceStart = y * size * 4;
    const targetStart = (size - y - 1) * size * 4;
    flipped.set(pixels.subarray(sourceStart, sourceStart + size * 4), targetStart);
  }
  context.putImageData(new ImageData(flipped, size, size), 0, 0);
}

try {
  const leftPixels = await renderScenario(-1.6, 4);
  const rightPixels = await renderScenario(1.6, 4);
  const shortRangePixels = await renderScenario(0, 0.7);
  const longRangePixels = await renderScenario(0, 4);
  drawPreview(longRangePixels);
  const leftRegion: [number, number, number, number] = [80, 174, 118, 266];
  const rightRegion: [number, number, number, number] = [210, 304, 118, 266];
  const centerRegion: [number, number, number, number] = [150, 234, 130, 254];
  const result: RelightingReferenceResult = {
    direction: {
      leftLightLeftLuma: regionLuminance(leftPixels, ...leftRegion),
      leftLightRightLuma: regionLuminance(leftPixels, ...rightRegion),
      rightLightLeftLuma: regionLuminance(rightPixels, ...leftRegion),
      rightLightRightLuma: regionLuminance(rightPixels, ...rightRegion),
    },
    range: {
      shortRangeCenterLuma: regionLuminance(shortRangePixels, ...centerRegion),
      longRangeCenterLuma: regionLuminance(longRangePixels, ...centerRegion),
    },
    pass: false,
  };
  result.pass = result.direction.leftLightLeftLuma > result.direction.leftLightRightLuma + 0.015
    && result.direction.rightLightRightLuma > result.direction.rightLightLeftLuma + 0.015
    && result.range.longRangeCenterLuma > result.range.shortRangeCenterLuma + 0.015;
  window.__relightingReferenceResult = result;
  document.body.dataset.status = result.pass ? 'pass' : 'fail';
  resultNode.textContent = JSON.stringify(result, null, 2);
} catch (error) {
  document.body.dataset.status = 'fail';
  resultNode.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
}
