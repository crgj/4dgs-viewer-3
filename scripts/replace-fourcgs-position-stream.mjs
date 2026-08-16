#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sha256 } from './fourcgs-prs-codec.mjs';

const MAGIC = '4CGSPRS2';

function readContainer(container) {
  if (container.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported 4CGS container.');
  const manifestBytes = container.readUInt32LE(8);
  const manifest = JSON.parse(container.subarray(12, 12 + manifestBytes).toString('utf8'));
  let offset = 12 + manifestBytes;
  const streams = manifest.streams.map((entry) => {
    const stored = container.subarray(offset, offset + entry.storedBytes);
    if (stored.length !== entry.storedBytes || sha256(stored) !== entry.storedSha256) {
      throw new Error(`Stored stream verification failed: ${entry.name}`);
    }
    offset += entry.storedBytes;
    return { entry, stored };
  });
  if (offset !== container.length) throw new Error('Unexpected 4CGS trailing bytes.');
  return { manifest, streams };
}

async function main() {
  const sourcePath = resolve(process.argv[2]);
  const positionPath = resolve(process.argv[3]);
  const probePath = resolve(process.argv[4]);
  const outputPath = resolve(process.argv[5]);
  const sourceContainer = await readFile(sourcePath);
  const position = await readFile(positionPath);
  const probe = JSON.parse(await readFile(probePath, 'utf8'));
  if (probe.attribute !== 'position' || probe.encodedBytes !== position.length) {
    throw new Error('Position probe and stream do not match.');
  }
  const { manifest, streams } = readContainer(sourceContainer);
  const sourcePosition = streams.find((stream) => stream.entry.name === 'prs_position');
  if (!sourcePosition) throw new Error('Source container has no prs_position stream.');
  const measuredFinalVectorRmse = probe.simplification.finalVectorRmse
    ?? probe.simplification.finalRmse * Math.sqrt(3);

  // #WDD-gpt 2026-08-15 - 只替换经真实编码验证的 Position 流，其余 SO3/Scale/DC/Opacity/SH 和无损流逐字节继承质量优先母容器。
  const nextStreams = streams.map(({ entry, stored }) => {
    if (entry.name !== 'prs_position') return { entry, stored };
    return {
      entry: {
        name: 'prs_position',
        compression: 'raw',
        rawBytes: position.length,
        storedBytes: position.length,
        rawSha256: sha256(position),
        storedSha256: sha256(position),
      },
      stored: position,
    };
  });
  const nextManifest = {
    ...manifest,
    codecName: `${manifest.codecName}-BoundedPolylinePosition`,
    parentContainerSha256: sha256(sourceContainer),
    prs: {
      ...manifest.prs,
      position: {
        ...manifest.prs.position,
        polylineSimplification: {
          method: 'per-Gaussian bounded RDP; omitted source knots reconstructed by analytic linear interpolation before the existing integer residual codec',
          tolerance: probe.tolerance,
          maximumCurveError: probe.simplification.maximumCurveError,
          measuredFinalVectorRmse,
          measuredFinalMaximumEuclideanError: probe.simplification.maximumFinalError,
          retainedKeys: probe.simplification.retainedKeys,
          sourceKeys: probe.simplification.totalKeys,
          retainedFraction: probe.simplification.retainedFraction,
          prunedGaussians: 0,
        },
      },
      positionMetrics: {
        ...manifest.prs.positionMetrics,
        encodedBytes: position.length,
        measuredVectorRmseAgainstOriginal: measuredFinalVectorRmse,
        measuredMaximumEuclideanErrorAgainstOriginal: probe.simplification.maximumFinalError,
      },
    },
    streams: nextStreams.map(({ entry }) => entry),
  };
  const manifestBytes = Buffer.from(JSON.stringify(nextManifest), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(manifestBytes.length, 8);
  const output = Buffer.concat([prefix, manifestBytes, ...nextStreams.map((stream) => stream.stored)]);
  await writeFile(outputPath, output);
  const report = {
    sourcePath,
    sourceBytes: sourceContainer.length,
    sourceSha256: sha256(sourceContainer),
    outputPath,
    outputBytes: output.length,
    outputSha256: sha256(output),
    savingsBytes: sourceContainer.length - output.length,
    raw4dSourceBytes: manifest.sourceBytes,
    compressionRatio: manifest.sourceBytes / output.length,
    positionBeforeBytes: sourcePosition.entry.storedBytes,
    positionAfterBytes: position.length,
    polylineSimplification: nextManifest.prs.position.polylineSimplification,
    inheritedStreams: nextStreams
      .filter((stream) => stream.entry.name !== 'prs_position')
      .map((stream) => ({ name: stream.entry.name, storedBytes: stream.entry.storedBytes, storedSha256: stream.entry.storedSha256 })),
  };
  await writeFile(`${outputPath}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
