# Master PLY（`.ply4`）格式说明

本文描述 Mirrortime 当前使用的 Master PLY 格式。该格式用于在一个文件中保存一段可随时间变化的 3D Gaussian Splatting 数据。

> 适用版本：以当前仓库中的 `compress_utils/ckpt_to_ply4.py`、`compress_utils/extract_checkpoint_ply.py`、`compress_utils/merge_ply4.py` 和 `render_ply_to_video.py` 为准（2026-08-14）。

## 1. 格式概览

`.ply4` 不是新的底层容器格式，而是使用 `.ply4` 扩展名的标准 PLY 文件：

- 只有一个 `vertex` element；每个 vertex 表示一个 Gaussian。
- 不包含 `face` element。
- 当前导出器写出二进制 PLY；在当前 x86 环境中为 `binary_little_endian 1.0`。
- canonical 文件的所有 vertex property 均为 32 位浮点数，即 PLY 头中的 `property float`。
- 时序长度和各 bank 的采样步长保存在 PLY `comment` 中。
- 时变属性以关键帧 bank 保存，非关键帧时刻由读取端插值。
- 文件中不保存 `static_mask`。所有 bank 都按完整点数 `N` 展开；静态点通常在所有关键帧中重复同一值。

文件后缀本身不提供版本信息，当前格式也没有 `format_version` comment。读取端必须根据 comment 和 property 名称判断内容。

## 2. PLY 头元数据

当前 canonical 导出器写出以下 6 条 comment：

| Comment | 值类型 | 含义 |
|---|---:|---|
| `total_frames F` | 正整数 | 时间轴总帧数；合法帧号为 `0 ... F-1` |
| `xyz_bank_keyframe_stride S_xyz` | 正整数 | 位置 bank 的常规关键帧间隔 |
| `rot_bank_keyframe_stride S_rot` | 正整数 | 旋转 bank 的常规关键帧间隔 |
| `features_dc_bank_keyframe_stride S_dc` | 正整数 | SH DC 颜色 bank 的常规关键帧间隔 |
| `scaling_bank_keyframe_stride S_scale` | 正整数 | 缩放 bank 的常规关键帧间隔 |
| `opacity_bank_keyframe_stride S_opacity` | 正整数 | 不透明度 bank 的常规关键帧间隔 |

示例：

```text
comment total_frames 90
comment xyz_bank_keyframe_stride 3
comment rot_bank_keyframe_stride 9
comment features_dc_bank_keyframe_stride 18
comment scaling_bank_keyframe_stride 18
comment opacity_bank_keyframe_stride 18
```

旧文件可能只有前 4 条 comment，且可能缺少后文所述的 `scale_bank` 和 `opacity_bank`。兼容读取时，仓库中的部分工具会把缺失步长回退为 `1` 或 `S_dc`；新写入端不应依赖该回退。

`lifetime_gate_k`、帧率、时间单位、坐标系方向和单位均未写入文件。当前独立渲染器使用 `lifetime_gate_k = 10.0`，时间单位为帧索引。

## 3. 关键帧时间轴

对总帧数 `F` 和某个 bank 的 stride `S`，canonical 关键帧时刻为：

```text
T = [0, S, 2S, ...] 中所有小于 F 的值
如果 T 的最后一项不是 F-1，再追加 F-1
```

因此：

```text
K = ceil((F - 1) / S) + 1
t_k = min(k * S, F - 1),  k = 0 ... K-1
```

当 `F = 1` 时 `K = 1`。最后一段可能短于 `S`，例如 `F=11, S=3` 时，关键帧时刻为 `[0, 3, 6, 9, 10]`。

每类 bank 有独立的 `K`，应由该类 property 中连续的下标 `0 ... K-1` 得到，并与相应 comment 交叉校验。文件中不单独保存 `K`。

## 4. Vertex 属性

属性名是读取依据。下表顺序是当前 checkpoint 导出器的 canonical 写出顺序。

### 4.1 基础属性

| 顺序 | Property | 数量 | 存储空间 | 含义 |
|---:|---|---:|---|---|
| 1 | `x`, `y`, `z` | 3 | 世界坐标 | 第 0 帧位置；等于 `xyz_bank_0_{x,y,z}` |
| 2 | `nx`, `ny`, `nz` | 3 | — | PLY/3DGS 兼容占位，当前固定为 `0` |
| 3 | `f_dc_0 ... f_dc_2` | 3 | SH 系数 | 第 0 帧的 RGB 三通道 SH DC 系数 |
| 4 | `f_rest_0 ... f_rest_{R-1}` | `R` | SH 系数 | 不随时间变化的高阶 SH 系数 |
| 5 | `opacity` | 1 | logit | 第 0 帧基础不透明度参数，激活值为 `sigmoid(opacity)` |
| 6 | `scale_0 ... scale_2` | 3 | log-scale | 第 0 帧三个主轴缩放参数，实际缩放为 `exp(scale_c)` |
| 7 | `lifetime_mu` | 1 | 帧索引 | 生命周期中心 |
| 8 | `lifetime_w` | 1 | 帧数 | 生命周期半宽，期望非负 |

当前 Master PLY 不写基础 `rot_0 ... rot_3`；第 0 帧旋转来自 `rot_bank_0_{w,x,y,z}`。仅支持标准静态 3DGS PLY 的读取器若需要基础旋转，应从 `rot_bank_0` 合成。

对于 SH degree `D`：

```text
R = 3 * ((D + 1)^2 - 1)
```

默认 `D=3`，因此有 45 个 `f_rest` 属性。其布局为 channel-major：令 `M=(D+1)^2-1`，则 `f_rest_{c*M+j}` 表示颜色通道 `c` 的第 `j` 个非 DC SH 系数。`f_dc_*` 和 `f_rest_*` 都是原始 SH 系数，不是 `[0,1]` RGB。

### 4.2 位置 bank

形状为 `[N, K_xyz, 3]`，存储世界坐标：

```text
xyz_bank_{k}_x
xyz_bank_{k}_y
xyz_bank_{k}_z
```

其中 `k = 0 ... K_xyz-1`。

### 4.3 旋转 bank

形状为 `[N, K_rot, 4]`，存储原始四元数：

```text
rot_bank_{k}_w
rot_bank_{k}_x
rot_bank_{k}_y
rot_bank_{k}_z
```

四元数分量顺序严格为 **WXYZ**。读取端在使用和插值前归一化四元数；单位旋转为 `(1, 0, 0, 0)`。历史文件若使用过错误字段顺序，应先用 `compress_utils/fix_rot_bank_field_order.py` 修复。

### 4.4 SH DC bank

形状为 `[N, K_dc, 3]`，存储原始 SH DC 系数：

```text
f_dc_bank_{k}_0
f_dc_bank_{k}_1
f_dc_bank_{k}_2
```

只有 DC 分量随时间变化；`f_rest_*` 在整段时间内固定。

### 4.5 缩放 bank

形状为 `[N, K_scale, 3]`，存储未激活的 log-scale：

```text
scale_bank_{k}_0
scale_bank_{k}_1
scale_bank_{k}_2
```

bank 值先在 log-scale 空间线性插值，再通过 `exp` 得到实际三个主轴缩放。

### 4.6 不透明度 bank

形状为 `[N, K_opacity, 1]`，存储未激活的 opacity logit：

```text
opacity_bank_{k}
```

bank 值先在 logit 空间线性插值，再通过 `sigmoid` 得到基础 alpha；生命周期门控在其后单独相乘。

### 4.7 完整 canonical 属性顺序

```text
x y z nx ny nz
f_dc_0 f_dc_1 f_dc_2
f_rest_0 ... f_rest_{R-1}
opacity
scale_0 scale_1 scale_2
lifetime_mu lifetime_w
xyz_bank_0_x xyz_bank_0_y xyz_bank_0_z ...
rot_bank_0_w rot_bank_0_x rot_bank_0_y rot_bank_0_z ...
f_dc_bank_0_0 f_dc_bank_0_1 f_dc_bank_0_2 ...
scale_bank_0_0 scale_bank_0_1 scale_bank_0_2 ...
opacity_bank_0 ...
```

每个顶点的 float32 属性数为：

```text
P = 15 + R + 3*K_xyz + 4*K_rot + 3*K_dc + 3*K_scale + K_opacity
```

不计 PLY 头时，vertex 数据大小约为 `4 * N * P` 字节。

## 5. 第 0 帧兼容快照

基础属性是 bank 第 0 列的兼容快照：

```text
(x, y, z)       == xyz_bank[0]
(f_dc_0..2)     == f_dc_bank[0]
(scale_0..2)    == scale_bank[0]
opacity         == opacity_bank[0]
```

以上关系适用于当前 canonical 导出结果；当相应可选 bank 不存在时，基础属性本身仍是该属性的数据源。旋转没有单独的基础快照。

## 6. 时间采样与渲染语义

读取端先将查询时间 `t` 限制到 `[0, F-1]`。在相邻关键帧 `t_k <= t <= t_{k+1}` 之间：

```text
a = (t - t_k) / (t_{k+1} - t_k)
lerp(v0, v1, a) = (1-a)*v0 + a*v1
```

各属性的处理如下：

| 属性 | 插值方式 | 插值后的激活/处理 |
|---|---|---|
| 位置 | 世界坐标线性插值 | 无 |
| 旋转 | 归一化、半球校正后走最短路径 SLERP；极小夹角退化为 LERP | 再归一化 |
| SH DC | SH 系数空间线性插值 | 与固定的 `f_rest` 一起参与 SH 求色 |
| 缩放 | log-scale 空间线性插值 | `scale(t) = exp(raw_scale(t))` |
| 基础不透明度 | logit 空间线性插值 | `alpha_base(t) = sigmoid(raw_opacity(t))` |

参数化生命周期门控为：

```text
start = lifetime_mu - lifetime_w
end   = lifetime_mu + lifetime_w

gate(t) = sigmoid(k * (t - start))
        * sigmoid(k * (end - t))

alpha(t) = alpha_base(t) * gate(t)
```

当前默认 `k=10.0`。`start` 和 `end` 是软边界，不是硬裁切边界；在单侧边界处，对应 sigmoid 因子为 `0.5`。

时间可以是浮点帧索引。训练模型中的位置、旋转、DC、缩放和不透明度插值支持浮点时间；部分离线脚本仍会把时间转成整数，调用方应按具体读取器确认。

## 7. 静态点、动态点与排序

checkpoint 内部将静态点和动态点分开保存，但导出 `.ply4` 时会统一为 `N` 行：

- 动态点的 bank 保存学习到的各关键帧值。
- 静态点的基础值复制到该类 bank 的所有关键帧。
- `.ply4` 中没有可靠的显式字段可恢复原 checkpoint 的 `static_mask`。

单 checkpoint 导出时，点按 `xyz_bank_0` 的 10-bit/轴 Morton code 排序，以改善空间局部性。合并多个分段 `.ply4` 后通常按分段拼接，因此不能假定任意 Master PLY 都保持全局 Morton 顺序。语义读取不应依赖点的排序方式。

## 8. 必选、可选与兼容性

对当前完整训练 checkpoint 的 canonical 输出：

- 基础位置、法线占位、SH、opacity、scale、lifetime 字段应存在。
- `xyz_bank` 应存在。
- `rot_bank`、`f_dc_bank` 在当前动态模型中应存在，但导出器仍保留无 bank 的兼容分支。
- `scale_bank`、`opacity_bank` 是当前新增时变字段；旧 checkpoint/旧 `.ply4` 可以没有它们，此时分别使用基础 `scale_*` 和 `opacity`。

不要混淆以下格式：

- `.ply4`：本文描述的标准 PLY 容器。
- `fp16_quantized 1` 的 `.ply4`：`quantize_ply4_fp16.py` 生成的变体。其 property 类型为 `ushort`，每个值是 float16 的原始位模式，普通 PLY 读取器不能把它当数值型 `ushort` 使用。
- `.ply4q`：ZIP + `manifest.json` 的独立压缩容器，不是 PLY 文件，也不属于本文的二进制布局。

## 9. 建议校验规则

读取或交付 Master PLY 前，建议至少检查：

1. 存在且只存在一个 `vertex` element，`N > 0`。
2. `total_frames >= 1`，所有已存在 bank 的 stride 均大于等于 1。
3. 同类 bank 下标从 `0` 连续到 `K-1`，每个下标的所有分量齐全。
4. `K` 与 `ceil((F-1)/S)+1` 一致。
5. 所有属性长度均为 `N`，所有浮点值均为有限值。
6. `lifetime_w >= 0`；四元数范数非零。
7. 第 0 帧兼容字段与相应 bank 第 0 列在容差内一致。
8. canonical 文件的属性为 float32；若出现 `fp16_quantized 1`，必须先按 float16 位模式解码。

Property 顺序建议保持 canonical 顺序，但健壮的读取器应按名称解析，不应只依赖列序号。
