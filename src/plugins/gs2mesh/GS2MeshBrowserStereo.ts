function median(values: number[]): number {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length * 0.5)] ?? 0;
}

export function rgbaToGray(rgba: Uint8ClampedArray): Uint8Array {
  const gray = new Uint8Array(rgba.length / 4);
  for (let index = 0; index < gray.length; index += 1) {
    const source = index * 4;
    gray[index] = (rgba[source] * 77 + rgba[source + 1] * 150 + rgba[source + 2] * 29) >>> 8;
  }
  return gray;
}

export function foregroundMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 18,
): Uint8Array {
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const append = (pixel: number): void => {
    const offset = pixel * 4;
    red.push(rgba[offset]);
    green.push(rgba[offset + 1]);
    blue.push(rgba[offset + 2]);
  };
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 64));
  for (let x = 0; x < width; x += stride) {
    append(x);
    append((height - 1) * width + x);
  }
  for (let y = stride; y < height - 1; y += stride) {
    append(y * width);
    append(y * width + width - 1);
  }
  const background = [median(red), median(green), median(blue)];
  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 4;
    const difference = Math.max(
      Math.abs(rgba[offset] - background[0]),
      Math.abs(rgba[offset + 1] - background[1]),
      Math.abs(rgba[offset + 2] - background[2]),
    );
    mask[pixel] = difference >= threshold && rgba[offset + 3] >= 32 ? 1 : 0;
  }

  // #WDD-gpt 2026-08-15 - 扩张一像素以保留 Gaussian 透明边缘，避免网格轮廓被前景阈值削薄。
  const expanded = mask.slice();
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      if (mask[pixel] === 0) continue;
      expanded[pixel - 1] = 1;
      expanded[pixel + 1] = 1;
      expanded[pixel - width] = 1;
      expanded[pixel + width] = 1;
    }
  }
  return expanded;
}
