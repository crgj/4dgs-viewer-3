import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function format(value, digits = 6) {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '0';
  const absolute = Math.abs(value);
  return absolute >= 1e4 || absolute < 1e-4 ? value.toExponential(4) : value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function percentage(value) {
  return `${(value * 100).toFixed(4)}%`;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function statsCsv(entries, keyLabel) {
  const columns = [keyLabel, 'count', 'finiteCount', 'nonFiniteCount', 'bitExactCount', 'bitExactRate', 'numericExactCount', 'numericExactRate', 'meanSignedError', 'meanAbsoluteError', 'rmse', 'p50Upper', 'p90Upper', 'p95Upper', 'p99Upper', 'p999Upper', 'maximumAbsoluteError', 'maximumLocation'];
  const lines = [columns.join(',')];
  for (const [name, stats] of entries) {
    const q = stats.absoluteErrorQuantileUpperBounds;
    const values = [name, stats.count, stats.finiteCount, stats.nonFiniteCount, stats.bitExactCount, stats.bitExactRate, stats.numericExactCount, stats.numericExactRate, stats.meanSignedError, stats.meanAbsoluteError, stats.rmse, q.p50, q.p90, q.p95, q.p99, q.p999, stats.maximumAbsoluteError, stats.maximumLocation];
    lines.push(values.map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function tableRows(entries) {
  return entries.map(([name, stats]) => `| ${name} | ${stats.count.toLocaleString()} | ${percentage(stats.bitExactRate)} | ${format(stats.meanSignedError)} | ${format(stats.meanAbsoluteError)} | ${format(stats.rmse)} | ${format(stats.absoluteErrorQuantileUpperBounds.p99)} | ${format(stats.maximumAbsoluteError)} |`).join('\n');
}

function semanticRows(entries) {
  return entries.map(([name, stats]) => `| ${name} | ${stats.unit} | ${stats.count.toLocaleString()} | ${format(stats.meanAbsoluteError)} | ${format(stats.rmse)} | ${format(stats.absoluteErrorQuantileUpperBounds.p99)} | ${format(stats.maximumAbsoluteError)} |`).join('\n');
}

function propertyRows(entries) {
  return entries.map(([name, stats]) => `| ${name} | ${stats.count.toLocaleString()} | ${percentage(stats.bitExactRate)} | ${format(stats.meanSignedError)} | ${format(stats.meanAbsoluteError)} | ${format(stats.rmse)} | ${format(stats.absoluteErrorQuantileUpperBounds.p99)} | ${format(stats.maximumAbsoluteError)} |`).join('\n');
}

function reportMarkdown(audit, propertyCsvPath, segmentCsvPath, distributionPngPath, visualizationPath, qualitySummary) {
  const attributes = Object.entries(audit.attributes);
  const semantics = Object.entries(audit.semanticMetrics);
  const properties = Object.entries(audit.properties);
  const c = audit.coverage;
  const sourceBytes = audit.inputs.sourceFiles.reduce((sum, file) => sum + file.bytes, 0);
  const decodedBytes = audit.inputs.decodedFiles.reduce((sum, file) => sum + file.bytes, 0);
  return `# V2.6 压缩前后逐值误差审计

生成时间：${audit.generatedAt}

## 结论

- 六段 RAW4D 共 ${c.sourceRows.toLocaleString()} 行、每行 ${c.sourcePropertiesPerRow} 个 FP16 属性，逐一比较 ${c.sourceScalarValues.toLocaleString()} 个源数值；比较覆盖率 ${percentage(c.comparisonCoverageRate)}，Dropped Track = ${c.droppedTrackCount}。
- 原始六文件 ${sourceBytes.toLocaleString()} B（${(sourceBytes / 1e6).toFixed(6)}M）；V2.6 为 ${audit.inputs.containerBytes.toLocaleString()} B（${(audit.inputs.containerBytes / 1e6).toFixed(6)}M），压缩比 ${(sourceBytes / audit.inputs.containerBytes).toFixed(6)}x。
- 严格解码物理输出 ${c.decodedPhysicalScalarValues.toLocaleString()} 个值；另有 ${c.reconstructedScalarValues.toLocaleString()} 个冗余逻辑值通过 bank 0 alias 或隐式 +0 重建。六段逻辑值全部可比较，解码文件合计 ${(decodedBytes / 1e6).toFixed(6)}M。
- Position 最大欧氏误差 ${format(audit.semanticMetrics.positionEuclidean.maximumAbsoluteError)} m；Rotation 最大方向误差 ${format(audit.semanticMetrics.rotationAngle.maximumAbsoluteError)}°；Scale 最大相对半径误差 ${percentage(audit.semanticMetrics.scaleRelativeRadius.maximumAbsoluteError)}；DC 最大线性 RGB 误差 ${format(audit.semanticMetrics.dcRgb.maximumAbsoluteError)}。
- Opacity、Lifetime、Normal 均逐位无损。Opacity 中 ${audit.attributes.opacity.nonFiniteCount.toLocaleString()} 个源值为 ±Infinity，压缩后仍逐位一致，不纳入有限数 RMSE。
- SH 是本版本最大的系数误差来源：${audit.attributes.sh.count.toLocaleString()} 个系数，RMSE ${format(audit.attributes.sh.rmse)}，P99 上界 ${format(audit.attributes.sh.absoluteErrorQuantileUpperBounds.p99)}，最大 ${format(audit.attributes.sh.maximumAbsoluteError)}。最终视觉验收仍以完整 540 样本解码位流渲染 PSNR 为准。
${qualitySummary ? `- 独立解码位流渲染复核：${qualitySummary.samples} 个样本，Aggregate PSNR ${qualitySummary.aggregatePsnr.toFixed(6)} dB，最低单样本 ${qualitySummary.minimumPsnr.toFixed(6)} dB，低于 39 dB 的样本为 ${qualitySummary.samplesBelowPerViewThreshold}。` : ''}

## 覆盖与重建方式

| 项目 | 数值 |
|---|---:|
| 源 FP16 数值 | ${c.sourceScalarValues.toLocaleString()} |
| 实际逐值比较 | ${c.comparedLogicalScalarValues.toLocaleString()} |
| 解码物理数值 | ${c.decodedPhysicalScalarValues.toLocaleString()} |
| bank 0 alias 重建 | ${c.storageModes.alias.toLocaleString()} |
| 隐式 +0 Normal 重建 | ${c.storageModes['implicit-zero'].toLocaleString()} |
| Permanent Track | ${c.permanentTrackCount.toLocaleString()} |
| Dropped Track | ${c.droppedTrackCount} |

源文件里的 \`x/y/z\`、\`f_dc_*\`、\`opacity\`、\`scale_*\` 是对应 bank 0 的冗余别名；\`nx/ny/nz\` 全部为 +0。审计仍把这些数值逐个计入，不用“字段被省略”来回避误差统计。

## 原始标量属性误差

Rotation 原始分量表会把等价的四元数 \`q\` 与 \`-q\` 当作数值差异，因此原始分量最大差不是方向误差。共 ${audit.semanticCounts.rotationSignFlipQuaternions.toLocaleString()} 个四元数发生符号规范化；应结合后面的 sign-aligned 分量与角度误差判断。

| 属性组 | 数值数 | 逐位一致 | 平均偏差 | MAE | RMSE | P99 上界 | 最大绝对误差 |
|---|---:|---:|---:|---:|---:|---:|---:|
${tableRows(attributes)}

## 语义误差

| 语义量 | 单位 | 样本数 | MAE | RMSE | P99 上界 | 最大值 |
|---|---|---:|---:|---:|---:|---:|
${semanticRows(semantics)}

## 每个源属性的逐值统计

下表覆盖全部 ${properties.length} 个源属性；每个属性包含六段所有行，没有抽样。P50/P90/P95/P99/P99.9 是每十倍区间 20 个 bin 的确定性直方图上界，最大值为精确扫描值。

| 属性 | 数值数 | 逐位一致 | 平均偏差 | MAE | RMSE | P99 上界 | 最大绝对误差 |
|---|---:|---:|---:|---:|---:|---:|---:|
${propertyRows(properties)}

## 产物与复现

- 完整 JSON：\`${audit.inputs.containerPath.replace(/.*\/artifacts\//, 'artifacts/')}\` 对应的 \`V26_VALUE_ERROR_AUDIT.json\`
- 属性 CSV：\`${propertyCsvPath}\`
- 分段/属性 CSV：\`${segmentCsvPath}\`
- 静态分布总览：\`${distributionPngPath}\`
- 交互分布图：\`${visualizationPath}\`
- 复现命令：\`node scripts/audit-fourcgs-value-errors.mjs && node scripts/render-fourcgs-value-audit.mjs\`

本次扫描耗时 ${audit.elapsedSeconds.toFixed(3)} s。直方图统计所有数值而非采样；JSON 保留每组和每个属性的非零 bin、正/零/负计数、最大误差位置与原始/解码值。
`;
}

function compactStats(stats) {
  return {
    name: stats.name,
    unit: stats.unit,
    count: stats.count,
    bitExactRate: stats.bitExactRate,
    numericExactRate: stats.numericExactRate,
    negativeCount: stats.negativeCount,
    zeroCount: stats.zeroCount,
    positiveCount: stats.positiveCount,
    mae: stats.meanAbsoluteError,
    rmse: stats.rmse,
    max: stats.maximumAbsoluteError,
    p99: stats.absoluteErrorQuantileUpperBounds.p99,
    histogram: stats.histogram,
  };
}

function visualizationHtml(audit) {
  const data = {
    coverage: audit.coverage,
    containerBytes: audit.inputs.containerBytes,
    attributes: Object.fromEntries(Object.entries(audit.attributes).map(([name, stats]) => [name, compactStats(stats)])),
    semantics: Object.fromEntries(Object.entries(audit.semanticMetrics).map(([name, stats]) => [name, compactStats(stats)])),
    properties: Object.fromEntries(Object.entries(audit.properties).map(([name, stats]) => [name, compactStats(stats)])),
  };
  return `<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#131b31;--line:#263451;--text:#ecf2ff;--muted:#98a8c7;--cyan:#55d6be;--amber:#ffbf69;--red:#ff6b6b;--blue:#6ea8fe}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#172544 0,#0b1020 42%);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif}.wrap{max-width:1180px;margin:auto;padding:22px}.eyebrow{color:var(--cyan);font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(24px,4vw,42px);line-height:1.08;margin:7px 0 8px}.lead{color:var(--muted);max-width:880px;margin:0 0 18px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.card,.panel{background:color-mix(in srgb,var(--panel) 93%,transparent);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 30px #0004}.card{padding:13px}.card .v{font-size:21px;font-weight:760}.card .k{font-size:12px;color:var(--muted)}h2{font-size:18px;margin:24px 0 10px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.panel{padding:12px;min-width:0}.panel h3{font-size:14px;margin:0 0 2px}.meta{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:11px}.chart{height:150px;margin-top:7px;width:100%;overflow:hidden}.chart svg{display:block;max-width:100%}.axis text{fill:var(--muted);font-size:9px}.axis line,.axis path{stroke:var(--line)}.empty{height:150px;display:grid;place-items:center;color:var(--cyan);font-weight:700}.explorer{padding:15px}.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}select{max-width:100%;background:#0d1529;color:var(--text);border:1px solid #385078;border-radius:8px;padding:8px 10px}.legend{color:var(--muted);font-size:12px}.legend b{color:var(--text)}footer{color:var(--muted);font-size:11px;margin:18px 0 4px}.swatch{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:var(--cyan)}@media(max-width:820px){.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:520px){.wrap{padding:14px}.grid{grid-template-columns:1fr}.cards{grid-template-columns:1fr 1fr}.card .v{font-size:15px;overflow-wrap:anywhere}.chart{height:140px}}
</style><div class="wrap"><div class="eyebrow">4CGS V2.6 · exhaustive audit</div><h1>压缩前后逐值误差分布</h1><p class="lead">六段 RAW4D 的每个 FP16 源数值都参与统计。横轴为非零绝对误差（log），纵轴为占全部有限数值的比例；精确为零的比例单独列出，避免零值淹没分布。</p><div class="cards" id="cards"></div><h2>语义误差分布</h2><div class="grid" id="semantic-grid"></div><h2>源标量属性组</h2><div class="grid" id="attribute-grid"></div><h2>123 个源属性逐项检查</h2><div class="panel explorer"><div class="controls"><label for="property">属性</label><select id="property"></select><span class="legend" id="property-meta"></span></div><div class="chart" id="property-chart"></div></div><footer><span class="swatch"></span>每十倍误差区间 20 bins；P99 为所在 bin 上界，Max 为逐值精确最大值。Rotation 原始 q/-q 分量差请用 rotationAngle 与 rotationComponentSignAligned 判断。</footer></div><script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script>
const DATA=${JSON.stringify(data)};
const fmt=v=>v===0?'0':(Math.abs(v)>=1e4||Math.abs(v)<1e-3?d3.format('.3e')(v):d3.format('.5~f')(v));
const pct=v=>d3.format('.3%')(v);const cards=[['逐值比较',d3.format(',')(DATA.coverage.comparedLogicalScalarValues)],['覆盖率',pct(DATA.coverage.comparisonCoverageRate)],['Dropped Track',DATA.coverage.droppedTrackCount],['V2.6 大小',(DATA.containerBytes/1e6).toFixed(3)+'M']];
d3.select('#cards').selectAll('.card').data(cards).join('div').attr('class','card').html(d=>'<div class="v">'+d[1]+'</div><div class="k">'+d[0]+'</div>');
function drawChart(target,s){const host=d3.select(target);host.selectAll('*').remove();const points=s.histogram.filter(d=>d.upper>0&&d.count>0).map(d=>({x:d.upper||d.lower,y:d.count/s.count}));if(!points.length){host.append('div').attr('class','empty').text('全部逐值一致 · 误差为 0');return}const node=host.node(),w=Math.max(240,node.clientWidth),h=Math.max(130,node.clientHeight),m={t:8,r:8,b:27,l:43};const svg=host.append('svg').attr('width','100%').attr('height',h).attr('viewBox','0 0 '+w+' '+h).attr('preserveAspectRatio','none').attr('role','img').attr('aria-label',s.name+' absolute error distribution');const x=d3.scaleLog().domain(d3.extent(points,d=>d.x)).nice().range([m.l,w-m.r]);if(x.domain()[0]===x.domain()[1])x.domain([x.domain()[0]/2,x.domain()[1]*2]);const y=d3.scaleLinear().domain([0,d3.max(points,d=>d.y)]).nice().range([h-m.b,m.t]);svg.append('g').attr('class','axis').attr('transform','translate(0,'+(h-m.b)+')').call(d3.axisBottom(x).ticks(5,'.0e'));svg.append('g').attr('class','axis').attr('transform','translate('+m.l+',0)').call(d3.axisLeft(y).ticks(4,'.1%'));const line=d3.line().x(d=>x(d.x)).y(d=>y(d.y)).curve(d3.curveMonotoneX);const area=d3.area().x(d=>x(d.x)).y0(y(0)).y1(d=>y(d.y)).curve(d3.curveMonotoneX);svg.append('path').datum(points).attr('d',area).attr('fill','#55d6be22');svg.append('path').datum(points).attr('d',line).attr('fill','none').attr('stroke','#55d6be').attr('stroke-width',2)}
function panel(selection,entries){const panels=selection.selectAll('.panel').data(entries).join('div').attr('class','panel');panels.html(d=>'<h3>'+d[0]+'</h3><div class="meta"><span>Zero <b>'+pct(d[1].numericExactRate)+'</b></span><span>RMSE <b>'+fmt(d[1].rmse)+'</b></span><span>P99 <b>'+fmt(d[1].p99)+'</b></span><span>Max <b>'+fmt(d[1].max)+'</b></span></div><div class="chart"></div>');panels.each(function(d){drawChart(d3.select(this).select('.chart').node(),d[1])})}
panel(d3.select('#semantic-grid'),Object.entries(DATA.semantics));panel(d3.select('#attribute-grid'),Object.entries(DATA.attributes));const select=d3.select('#property');select.selectAll('option').data(Object.keys(DATA.properties)).join('option').attr('value',d=>d).text(d=>d);function updateProperty(){const s=DATA.properties[select.property('value')];d3.select('#property-meta').html('Count <b>'+d3.format(',')(s.count)+'</b> · bit-exact <b>'+pct(s.bitExactRate)+'</b> · RMSE <b>'+fmt(s.rmse)+'</b> · P99 <b>'+fmt(s.p99)+'</b> · Max <b>'+fmt(s.max)+'</b>');drawChart(document.querySelector('#property-chart'),s)}select.on('change',updateProperty);updateProperty();let timer;window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(()=>{panel(d3.select('#semantic-grid'),Object.entries(DATA.semantics));panel(d3.select('#attribute-grid'),Object.entries(DATA.attributes));updateProperty()},120)});
</script>`;
}

// #WDD-gpt 2026-08-16 - 将逐值审计固化为完整表格、CSV 与可交互误差分布图，便于后续版本横向复验。
async function main() {
  const auditPath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/V26_VALUE_ERROR_AUDIT.json');
  const reportPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/V26_VALUE_ERROR_REPORT.md');
  const visualizationPath = resolve(process.argv[4] ?? '/home/crgj/.codex/visualizations/2026/08/16/01a00886-c817-7800-85c4-8ae4e66e8cf5/v26-value-error-distributions.html');
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  const propertyCsvPath = resolve(dirname(reportPath), 'V26_VALUE_ERROR_BY_PROPERTY.csv');
  const segmentCsvPath = resolve(dirname(reportPath), 'V26_VALUE_ERROR_BY_SEGMENT_ATTRIBUTE.csv');
  const distributionPngPath = resolve(dirname(reportPath), 'V26_VALUE_ERROR_DISTRIBUTIONS.png');
  let qualitySummary = null;
  try {
    qualitySummary = JSON.parse(await readFile(resolve(dirname(reportPath), 'V26_QUALITY_ACCEPTANCE.json'), 'utf8')).summary ?? null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await Promise.all([mkdir(dirname(reportPath), { recursive: true }), mkdir(dirname(visualizationPath), { recursive: true })]);
  await Promise.all([
    writeFile(propertyCsvPath, statsCsv(Object.entries(audit.properties), 'property')),
    writeFile(segmentCsvPath, statsCsv(Object.entries(audit.segmentAttributes), 'segmentAttribute')),
    writeFile(reportPath, reportMarkdown(audit, propertyCsvPath, segmentCsvPath, distributionPngPath, visualizationPath, qualitySummary)),
    writeFile(visualizationPath, visualizationHtml(audit)),
  ]);
  process.stdout.write(`${JSON.stringify({ reportPath, propertyCsvPath, segmentCsvPath, visualizationPath })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
