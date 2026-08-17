# RAW4D / Master PLY4 格式对齐报告

依据：项目根目录 `master_ply_format.md`（2026-08-14 规范），修正日期：2026-08-16。

## 结论

项目里的 `.raw4d` 是 Master PLY `.ply4` 的工程后缀别名，不是另一种底层容器。两者现在统一走 RAW4D 时序解析路径；`fp16_quantized 1` 文件中的 `ushort` 被作为 IEEE 754 binary16 原始位模式保存和解码，不能作为 0～65535 的整数值使用。

## 规范与修正前行为对比

| 项目 | 最新规范 | 修正前行为 | 当前行为 |
|---|---|---|---|
| 容器 | 单一 `vertex` 的 binary little-endian PLY，无 `face` | `.ply4` 进入通用 PLY 路径 | `.raw4d` / `.ply4` 统一进入时序 Loader，并校验 element 和文件长度 |
| FP16 | `ushort` 是 float16 位模式；`fp16_property` 不是必需 | 通用 PLY 路径把它当数值整数 | 保留 `Uint16Array` 原位模式，采样时按 binary16 解码 |
| 时间轴 | `0,S,2S...`，必要时追加 `F-1` | 部分路径把最后一帧写成 `k*S` | 统一生成 canonical keyframes，支持短末区间 |
| 时间类型 | 查询时间可以是浮点帧 | 多段 RAW4D 和 4CGS 定位先 `Math.round` | 保留浮点时间，段内继续插值 |
| 基础快照 | x/DC/scale/opacity 等于各自 bank 0；法线为 0 | 导出和 4CGS 解码结果缺少这些 13 列 | 导出/解码均生成完整 canonical 顺序并校验别名 |
| 旋转 | `rot_bank` 为 WXYZ；归一化、半球校正、最短路 SLERP | 读取路径不统一，未校验零四元数 | 统一 WXYZ 轨道并拒绝零或非有限四元数；不要求源值预先单位化 |
| DC / scale / opacity | 分别在 SH 系数、log-scale、logit 空间线性插值 | 通用 PLY4 路径没有读取 scale/opacity bank | 三类 bank 都进入时序轨道；激活仍在采样后执行 |
| 可选旧 bank | rotation/DC/scale/opacity 可缺失并回退基础值；旧 scale/opacity stride 可回退 DC/1 | RAW4D Parser 要求所有 bank 存在 | 按规范回退；位置 bank 仍为必需 |
| SH | `f_rest_0...R-1` 连续，合法数量为 0/9/24/45 | 非法/断裂数量可能被静默降级 | 连续性和合法 SH degree 均显式校验 |
| 静态点 | 没有 `static_mask`；静态点在完整 bank 中重复 | 部分旧理解把它当显式生命周期/静态标记 | 不再假定存在静态标记，按完整 N 行读取 |
| 生命周期 | `mu±w` 是 k=10 的软门控，`w>=0` | 只作为两列读取 | 校验有限值和非负半宽；仍按软门控采样 |
| 4CGS stride | 应保留每段源 stride | 解码头硬编码 3/30/30/10/10 | 新清单保存 `keyframeStrides`；旧清单仅在可验证时反推 |
| 4CGS 解码产物 | 应是可重新打开的 canonical Master PLY | 输出 110 列内部布局，缺基础快照/法线 | 对外重建 123 列 canonical FP16 RAW4D |
| 多文件 | `.raw4d` 与 `.ply4` 语义相同 | 多选只允许 `.raw4d` | 两种后缀都可组成虚拟序列、预载并再次导出 |

## 需要保持正确的理解

- `scale_*` / `scale_bank_*` 是 log-scale，不是实际半径；先插值再 `exp`。
- `opacity` / `opacity_bank_*` 是 logit，不是 alpha；先插值再 `sigmoid`，最后乘生命周期 gate。
- `f_dc_*` 和 `f_rest_*` 是原始 SH 系数，不是 `[0,1]` RGB。
- `rot_bank` 分量顺序是 WXYZ。源四元数可以不是单位长度，读取和插值前必须归一化。
- 每个文件内部的时间从 `0` 到 `F-1`；文件名中的 `180_210` 等全局范围以及相邻段点对应关系属于多段序列层，不是 PLY header 自带语义。
- 相邻段重复边界帧只在虚拟序列中去重，边界时选择后一段的 local frame 0。
- 生命周期外的关键帧仍然存在于 canonical 文件；规范没有稀疏关键帧、缺省槽位或 `static_mask`。这些只能作为 4CGS 压缩层优化，解码时必须恢复等价轨道。
- 多段共享 SH/DC 是 4CGS 的编码策略，不是 RAW4D 文件本身允许省略基础 SH/DC 的理由。

## 六段真实文件验收

目录：`/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16`

| 文件 | 大小（M） | 点数 | 帧数 | bank 数量（pos/rot/DC/scale/opacity） | 非有限值 |
|---|---:|---:|---:|---|---:|
| segment_180_210.raw4d | 68.978297 | 280,368 | 31 | 11 / 2 / 2 / 4 / 4 | 593 |
| segment_210_240.raw4d | 70.141631 | 285,097 | 31 | 11 / 2 / 2 / 4 / 4 | 0 |
| segment_240_270.raw4d | 51.069989 | 207,570 | 31 | 11 / 2 / 2 / 4 / 4 | 61 |
| segment_270_300.raw4d | 45.666845 | 185,606 | 31 | 11 / 2 / 2 / 4 / 4 | 3 |
| segment_300_330.raw4d | 50.695823 | 206,049 | 31 | 11 / 2 / 2 / 4 / 4 | 16 |
| segment_330_359.raw4d | 48.670259 | 197,815 | 30 | 11 / 2 / 2 / 4 / 4 | 0 |

合计 335.222844 M、1,362,505 个分段点记录。六段均为 123 个 FP16 property，stride 均为 `3 / 30 / 30 / 10 / 10`；基础快照逐位不一致数、非零法线数、非法生命周期数、非法四元数数全部为 0。

唯一偏离“建议所有值有限”的数据是总计 673 个 `opacity_bank_1 = -Infinity`。这在 logit 语义下严格表示 `sigmoid(-Infinity)=0`（完全透明），不是整数溢出，也不应改写源位。运行时保留这项兼容；交付审计会把它单独报告，其他 NaN/+Infinity 仍应视为异常。

六段源四元数范数总体约为 0.2007～2.5699，证明不能假定磁盘中的四元数已单位化；当前采样器按规范归一化。

## 验收边界

本轮验证覆盖格式结构、原始 FP16 位语义、每个真实文件完整解析、轨道构造、导出再读、4CGS canonical 重建、浮点时间和 TypeScript 构建。格式修正不等价于重新证明已有有损 4CGS 编码的逐帧 PSNR；压缩画质仍应以解码 bitstream 在专用 renderer 中逐帧验收。

<!-- #WDD-gpt 2026-08-16 - 记录最新 Master PLY4 规范与项目读写、4CGS 解码语义的逐项对齐结果。 -->
