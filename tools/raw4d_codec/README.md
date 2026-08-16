# CoRe4D-Adaptive39 `.4cgs` codec

## CoReAttr-5R 全非 SH 残差可行性测试

`coerattr5r.py` 将 CoReSH-5R 的五级、每级 256 项、保留零码字的加性残差 VQ 分别应用到
Position、Rotation、log-scale 与 opacity。时间属性都使用首关键帧参考，不形成相邻帧残差链；
输出独立 `.npz` 码流、独立解码 RAW4D 和逐属性数值残差报告。

```bash
PYTHONPATH=tools/raw4d_codec python3 tools/raw4d_codec/coerattr5r.py \
  /absolute/master.raw4d artifacts/coerattr5r-test
```

<!-- #WDD-gpt 2026-08-15 - 增加全55D非SH复用CoReSH-5R残差结构的真实码流测试入口。 -->

第二轮 `coerattr5r_keepfirst.py` 将四种属性的首关键帧按源 float32 精确保留，只对其余
关键帧相对首帧的时间残差训练五级 RVQ：

```bash
PYTHONPATH=tools/raw4d_codec python3 tools/raw4d_codec/coerattr5r_keepfirst.py \
  /absolute/master.raw4d artifacts/coerattr5r-keepfirst-test
```

<!-- #WDD-gpt 2026-08-15 - 增加保留首关键帧、仅编码后续时间残差的第二轮对照入口。 -->

第三轮 `coerattr5r_compactfirst.py` 将首帧改为 Position LAF Morton 基准、Rotation 自适应
smallest-three、12-bit log-scale 和 12-bit alpha；后续 Rotation/Scale/Opacity 残差全部相对
各自已解码首帧，再使用五级 RVQ。Position 使用已通过独立解码验收的 LAF 锚点场与稀疏修正：

```bash
PYTHONPATH=tools/raw4d_codec python3 tools/raw4d_codec/coerattr5r_compactfirst.py \
  /absolute/master.raw4d /absolute/xyz_laf_extreme.npz artifacts/coerattr5r-compactfirst
```

<!-- #WDD-gpt 2026-08-15 - 增加紧凑首帧和针对Position核心瓶颈的锚点场修复档。 -->

## TSOG-RAW4D-PL16 论文格式测试

`tsog.py` 依据 arXiv:2607.28049v1 的索引对齐图像结构，将 RAW4D 的基础帧交给 PlayCanvas 官方 SOG 编码器，并把源文件真实的稀疏 Position / Rotation / DC / Scale / Opacity 关键帧写成上下 8-bit 的 16-bit WebP 时间图。它不会先展开成 31 个完整 PLY。

```bash
python3 tools/raw4d_codec/tsog.py benchmark \
  /absolute/master.raw4d /absolute/master.tsog /absolute/master.tsog.decoded.raw4d \
  artifacts/tsog/report.json --report-markdown artifacts/tsog/REPORT.md --gpu 0
```

<!-- #WDD-gpt 2026-08-15 - 增加 TSOG 实际编码、独立解码与逐参数压缩比报告入口。 -->

该档使用论文允许扩展的 piecewise-keyframe temporal parameterization，以保持 RAW4D 的原始线性/slerp 插值语义。库存 PlayCanvas 只能直接读取 bundle 内的静态 SOG 层；动态播放仍需要 TSOG timeline/temporal 扩展。`decode` 子命令不依赖源 RAW4D，质量评估必须针对它实际解出的文件运行。

`codec.py` creates a standalone, checksummed `.4cgs` file. It never prunes Gaussians.

The default profile is residual-gated: difficult tracks retain more knots and produce a larger file instead of silently violating the quality bound. Streams in V1:

- CoReSH-5R for 45 non-DC spherical-harmonic coefficients.
- Position uses a shared analytic curve Bank (all source-keyframe intervals) plus an error-bounded minimum-knot sparse polyline. The default 14-bit nodes use a `0.00015 × scene diagonal` fit target and a `0.00025 × diagonal` hard serialized bound.
- 32-bit quaternion smallest-three coding.
- Per-axis scalar product quantization in the source log-scale domain.
- Independent DC color, opacity-logit, and lifetime-bound streams.
- Independent Zstandard-compressed streams with SHA-256 verification.

```bash
python3 tools/raw4d_codec/codec.py encode input.raw4d output.4cgs \
  --reuse-sh validated_coresh5r.bin
python3 tools/raw4d_codec/codec.py decode output.4cgs decoded.raw4d
python3 tools/raw4d_codec/codec.py inspect output.4cgs
```

When `--reuse-sh` is omitted, the encoder trains a deterministic CoReSH-5R codebook. Reuse is provided so a previously rendered and quality-approved SH stream can be embedded byte-for-byte.

Clean 1280×720 acceptance capture (all UI, grid, and axes disabled) is available through `?capture=1` and the deterministic CDP harness:

```bash
python3 tools/raw4d_codec/capture_clean_renders.py \
  --asset original=/absolute/input.raw4d \
  --asset decoded=/absolute/decoded.raw4d \
  --output-root artifacts/clean-renders \
  --frames 0:30 --wheel-steps 10 --pan-y -100
```

## 独立 CUDA 渲染评估（推荐）

`offline_render.py` 不启动 Vite、浏览器或任何 Web UI。它直接读取 RAW4D，按源关键帧规则插值位置、四元数、DC、log-scale、透明度和生命周期，并通过 gsplat CUDA 使用训练相机渲染。输出包括原始图、解码图、三联差分图、PSNR/前景 PSNR/SSIM 的 JSON 与 CSV。

```bash
python3 tools/raw4d_codec/offline_render.py \
  --reference /absolute/master.raw4d \
  --decoded /absolute/master.decoded.raw4d \
  --cameras-json /absolute/cameras.json \
  --camera-indices 0:67 --frames 0,10,20,30 \
  --output-root artifacts/offline-evaluation \
  --width 1280 --height 720
```

批量筛查时可加 `--skip-comparisons`，指标和两组渲染图仍会保留，只跳过三联差分图。

多个候选使用完全相同的参考资产、相机、帧和分辨率时，可给后续候选添加 `--reuse-reference-dir` 指向首个任务的 `reference/` 目录。程序会核对 PNG 数量后复用参考渲染，只重新渲染待测资产。

## 可学习锚点场极致码率扫描

`learnable_anchor_rate_sweep.py` 使用 Morton 首帧、解码端重建五邻接、每 Gaussian 跨关键帧共享的五权重 VQ、低秩锚点场和稀疏残差，生成给定实际字节预算的独立 XYZ 码流。每个关键帧始终学习 `P(t)-P(0)`，不使用相邻关键帧连续增量。

```bash
python3 tools/raw4d_codec/learnable_anchor_rate_sweep.py \
  /absolute/master.raw4d artifacts/laf-extreme --device cuda

python3 tools/raw4d_codec/decode_learnable_anchor_extreme.py \
  /absolute/master.raw4d artifacts/laf-extreme/conservative_4.0mb/xyz_laf_extreme.npz \
  artifacts/laf-extreme/conservative_4.0mb/position_ablation.raw4d
```

## CoReAttr-5R 紧凑首帧非 SH 档

`coerattr5r_compactfirst.py` 单独编码首帧，并让后续 rotation、scale、opacity 关键帧始终相对实际解码首帧编码。Position 使用 Morton 10-bit 首帧、int8 基础修正、可学习锚点场和稀疏 int16 运动修正；rotation 使用自适应 smallest-three；首帧 scale/opacity 使用经全 68 相机门槛扫描确定的 6 bit。后续三个属性保留固定五级 256 项 FP16 RVQ，Scale 额外允许小规模高影响节点 FP16 稀疏补丁。

```bash
PYTHONPATH=tools/raw4d_codec python3 \
  tools/raw4d_codec/coerattr5r_compactfirst.py \
  /absolute/master.raw4d /absolute/xyz_laf_extreme.npz artifacts/coerattr-compact-first \
  --sample-count 65536 --scale-repair-count 36000 --zstd-level 8

PYTHONPATH=tools/raw4d_codec python3 \
  tools/raw4d_codec/make_raw4d_nonsh_ablations.py \
  /absolute/master.raw4d artifacts/coerattr-compact-first/coerattr5r_compactfirst_nonsh_ablation.raw4d \
  artifacts/coerattr-compact-first/attribute-ablations \
  --position-laf /absolute/xyz_laf_extreme.npz
```

<!-- #WDD-gpt 2026-08-15 - 记录紧凑首帧、Position码率修复、Scale稀疏补丁和Morton顺序消融入口。 -->

该档只覆盖 position、rotation、scale、opacity；DC、CoReSH-5R 与 lifetime 必须在完整容器中单独计入，不能用本档的非 SH 比率冒充整文件比率。

## MINT-like 3.5 MB 非 SH 实验档

`mint_like_nonsh35_attr.py` 在可学习五锚点位置场上，为 position 残差、rotation、log-scale 和 opacity-alpha 分别训练多级 256 项残差量化码本，再按实际 zstd 字节搜索每个 Gaussian 的属性深度。位置和相对旋转都以 0 帧为参考；scale/opacity 各关键帧独立保存，解码时不做相邻关键帧连续累加。

```bash
PYTHONPATH=tools/raw4d_codec python3 tools/raw4d_codec/mint_like_nonsh35_attr.py \
  /absolute/master.raw4d /absolute/xyz_laf_extreme.npz artifacts/mint-nonsh35 \
  --target-bytes 3500000 --model-target-bytes 3180000

PYTHONPATH=tools/raw4d_codec python3 \
  tools/raw4d_codec/make_mint_nonsh_attribute_ablations.py \
  /absolute/master.raw4d artifacts/mint-nonsh35/nonsh_mint_like_attr_3.5mb.npz \
  artifacts/mint-nonsh35/attribute_ablations
```

<!-- #WDD-gpt 2026-08-15 - 增加MINT-like非SH实际预算搜索、独立解码和逐属性渲染消融入口。 -->

该实验的 3.5 MB 只覆盖 XYZ、rotation、scale 和 opacity；DC、SH 与 lifetime 不在比率分母内。尺寸通过不能替代离线渲染验收。

## VisualRate39 分层视频轨迹档

`visualrate39.py` 将位置保存为贡献度分层的绝对位移 AV1 轨迹，配合 CoReSH-5R、四元数 smallest-three、DC YCoCg、log-scale PQ+RVQ、空间块透明度和独立生命周期边界。编码和解码均为离线独立程序，不依赖 Web 前端。

```bash
python3 tools/raw4d_codec/visualrate39.py encode input.raw4d output.4cgs \
  --reuse-sh validated_coresh5r.bin --zstd-level 8
python3 tools/raw4d_codec/visualrate39.py decode output.4cgs decoded.raw4d
```

该档必须以真实解码文件的离线渲染结果验收；代表视角通过不等于全部训练机位通过。

`compact40.py` is an experimental high-ratio profile. It also measures ratio against the source RAW4D file, but it must not be used as a quality-approved result unless it passes the same full-screen render gate:

```bash
python3 tools/raw4d_codec/compact40.py encode input.raw4d output.4cgs \
  --reuse-sh validated_coresh5r.bin
python3 tools/raw4d_codec/compact40.py decode output.4cgs decoded.raw4d
```

## LDMG-Q28 position profile

`motion_grid.py` replaces SparseTraj XYZ with a low-dimensional motion grid plus integer-node residual. It stores a rank-8 common motion basis, a 16³ spatial coefficient grid, six 256-entry residual VQ levels, and sparse int16 corrections only at the 11 source integer nodes. The correction threshold is normalized by scene diagonal, so difficult data increases the residual stream instead of silently relaxing the error bound.

```bash
python3 tools/raw4d_codec/motion_grid.py encode input.raw4d output.4cgs \
  --reuse-sh validated_coresh5r.bin --zstd-level 8
python3 tools/raw4d_codec/motion_grid.py decode output.4cgs decoded.raw4d
python3 -m unittest tools/raw4d_codec/test_motion_grid.py
```

The `master.raw4d` acceptance run uses all 31 integer frames with a UI-free, grid-free full-screen subject capture. Its XYZ-only render result is 40.980 dB mean and 39.244 dB minimum; see `artifacts/ldmg_r8g16_rvq6_q28_20260815/REPORT.md` for the measured bytes, timing, full-stream result, and comparisons.

## Learnable anchor-field XYZ probe

`learnable_anchor_field.py` evaluates a fixed first-frame topology with five static weights per Gaussian and a jointly learned anchor translation field. It writes a standalone serialized probe archive, decodes that archive before measuring errors, optionally exports a position-only RAW4D ablation, and reports the separate byte costs of the base frame, topology, weights, field, and bounded residual.

```bash
python3 tools/raw4d_codec/learnable_anchor_field.py \
  /absolute/master.raw4d artifacts/learnable-anchor-field \
  --anchor-fraction 0.05 --neighbors 5 --steps 120 \
  --weight-bits 10 --field-bits 14 \
  --correction-ratio 0.00028 --device cuda
```

<!-- #WDD-gpt 2026-08-15 - 记录静态五权重与可学习锚点场的独立码流测试入口和验收边界。 -->

The archive is an evaluation format rather than a production `.4cgs` profile. A result is not render-approved until `position_ablation.raw4d` is evaluated with `offline_render.py` on the required frames and cameras.

## Compact-first + CoReSH-5R 完整容器

`coresh_compactfirst_full.py` 将紧凑首帧非 SH 档、固定 CoReSH-5R、DC 和 lifetime 合成一个可独立解码的完整 `.4cgs`。对于原生 FP16 RAW4D，可用 `--lossless-dc-lifetime` 无损保存 DC 与生命周期；新版非 SH 档对 opacity 的 4 个稀疏关键帧使用原生 FP16，避免低-alpha logit 插值放大量化尾差。

```bash
python3 tools/raw4d_codec/coresh_compactfirst_full.py encode \
  input.raw4d nonsh.npz coresh5r.bin output.4cgs --lossless-dc-lifetime
python3 tools/raw4d_codec/coresh_compactfirst_full.py decode output.4cgs decoded.raw4d
python3 tools/raw4d_codec/coresh_compactfirst_full.py inspect output.4cgs
```

<!-- #WDD-gpt 2026-08-15 - 记录完整容器、原生FP16属性策略和独立解码入口。 -->

完整比率必须包含 non-SH、CoReSH-5R、DC、lifetime 与容器开销；只报子流比率不算完整压缩结果。
