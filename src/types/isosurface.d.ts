declare module 'isosurface' {
  export interface IsosurfaceMesh {
    readonly positions: number[][];
    readonly cells: number[][];
  }

  export function marchingCubes(
    dimensions: readonly [number, number, number],
    potential: (x: number, y: number, z: number) => number,
    bounds?: readonly [readonly number[], readonly number[]],
  ): IsosurfaceMesh;

  export function surfaceNets(
    dimensions: readonly [number, number, number],
    potential: (x: number, y: number, z: number) => number,
    bounds?: readonly [readonly number[], readonly number[]],
  ): IsosurfaceMesh;
}

// #WDD-gpt 2026-08-15 - Provide strict local typings for the small MIT Marching Cubes and Surface Nets frontend dependency.
