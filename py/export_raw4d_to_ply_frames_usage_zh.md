# RAW4D 逐帧 PLY 导出脚本使用说明

对应脚本：`export_raw4d_to_ply_frames.py`

## 1. 功能

该脚本把一个 `.raw4d` 文件解压并导出为每帧一个标准静态 3DGS `.ply` 文件。它也支持输入一个目录，依次处理目录第一层内的所有 `.raw4d` 文件。

实际处理链路如下：

```text
.raw4d（fp16 原始位存储在 PLY ushort 中）
    -> 临时 Master PLY4（属性存储类型恢复为 float32）
    -> 时间 bank 插值和 lifetime 门控
    -> 每帧一个静态 PLY（全部浮点属性为 float32）
```

临时 PLY4 创建在系统临时目录中，当前 RAW4D 的所有帧导出完成后自动删除，不会保留在输出目录。

脚本独立于 Mirrortime 的训练和渲染模块，只依赖：

- Python 3.10 或更新版本
- NumPy
- `plyfile`

仓库的 `gs` Conda 环境已经包含所需依赖。

## 2. 关于 fp16 和 float32

`.raw4d` 是 fp16 量化版本。由于标准 PLY 没有 float16 property 类型，RAW4D 将每个 float16 的 16 个原始位存放在 PLY 的 `ushort` property 中，并通过以下 comment 标记：

```text
fp16_quantized 1
fp16_property x
fp16_property y
...
```

中间解压出的 PLY4 和最终逐帧 PLY 的 property 类型都是 `float32`，不是 fp16。但是，它们的源数据已经经过 float16 量化，因此只有 fp16 级别的有效精度。把 fp16 转回 float32 只恢复存储类型，不能恢复量化时损失的精度。

总结：

| 文件 | PLY property 存储类型 | 有效数值精度 | 是否保留时间 bank |
|---|---:|---:|---:|
| 输入 `.raw4d` | `ushort`，内容为 fp16 位模式 | fp16 | 是 |
| 临时 `.ply4` | float32 | fp16 | 是 |
| 输出逐帧 `.ply` | float32 | 源数据为 fp16 精度；插值结果写成 float32 | 否 |

## 3. 基本用法

在仓库目录中执行：

```bash
cd /home/gs/code/dev/Mirrortime
```

### 处理一个 RAW4D 文件

```bash
conda run --no-capture-output -n gs python \
  export_raw4d_to_ply_frames.py \
  --input /path/to/segment_180_210.raw4d \
  --output-dir /path/to/output/segment_180_210
```

若输入文件名是 `segment_180_210.raw4d`，并且文件内的 `total_frames` 是 31，输出为：

```text
/path/to/output/segment_180_210/
├── frame_000180.ply
├── frame_000181.ply
├── ...
└── frame_000210.ply
```

### 批量处理一个目录

```bash
conda run --no-capture-output -n gs python \
  export_raw4d_to_ply_frames.py \
  --input /path/to/raw4d_directory \
  --output-dir /path/to/per_frame_ply
```

目录模式只扫描输入目录第一层的 `*.raw4d`。每个 RAW4D 使用独立子目录，避免不同分段或重叠帧相互覆盖：

```text
/path/to/per_frame_ply/
├── segment_180_210/
│   ├── frame_000180.ply
│   └── ...
└── segment_200_230/
    ├── frame_000200.ply
    └── ...
```

## 4. 导出部分帧

`--start-frame` 和 `--end-frame` 使用分段内部的局部帧编号，且首尾都包含。

例如从 `segment_180_210.raw4d` 导出局部第 5 到第 10 帧，即全局第 185 到第 190 帧：

```bash
conda run --no-capture-output -n gs python \
  export_raw4d_to_ply_frames.py \
  --input /path/to/segment_180_210.raw4d \
  --output-dir /path/to/output \
  --start-frame 5 \
  --end-frame 10
```

## 5. 帧编号

默认参数 `--frame-offset auto` 会从 `segment_<start>_<end>.raw4d` 文件名解析全局起始帧。

如果文件名不包含范围，输出默认从 `frame_000000.ply` 开始。可手动指定全局偏移：

```bash
--frame-offset 180
```

文件名范围必须与 PLY4 元数据匹配。例如 `segment_180_210.raw4d` 必须声明 31 帧，否则脚本会报错，以防错误编号。

## 6. 点过滤和透明度

默认不删除任何点。脚本会将当前帧的基础 opacity 与 lifetime gate 相乘，再转换回标准 3DGS PLY 所需的 opacity logit。

如需删除当前帧最终 alpha 不大于 `0.01` 的点：

```bash
--opacity-threshold 0.01
```

过滤条件严格为：

```text
保留 final_alpha > opacity_threshold
```

`--opacity-epsilon` 默认是 `1e-6`，用于在执行 alpha 到 logit 转换前将透明度限制到有限范围。它只影响保存的 opacity 数值，不会在未指定 `--opacity-threshold` 时删除点。

## 7. 时间属性处理

脚本读取当前格式中的全部时间 bank：

| 属性 | 逐帧处理方式 |
|---|---|
| `xyz_bank_*` | 世界坐标线性插值 |
| `rot_bank_*` | WXYZ 四元数归一化、半球校正、最短路径 SLERP |
| `f_dc_bank_*` | SH DC 系数线性插值 |
| `scale_bank_*` | raw log-scale 线性插值 |
| `opacity_bank_*` | raw logit 线性插值后执行 sigmoid |
| `lifetime_mu/w` | 使用左右 sigmoid 计算 lifetime gate |

最终 PLY 保留标准静态 3DGS 字段：

```text
x y z
nx ny nz
f_dc_*
f_rest_*
opacity
scale_*
rot_*
```

输出中不再包含时间 bank 或 lifetime 字段。

## 8. 参数列表

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--input`, `-i` | 必填 | 单个 `.raw4d` 或包含 RAW4D 的目录 |
| `--output-dir`, `-o` | 必填 | 输出目录 |
| `--start-frame` | `0` | 局部起始帧，包含 |
| `--end-frame` | 最后一帧 | 局部结束帧，包含 |
| `--frame-offset` | `auto` | 输出全局帧号偏移，或从文件名自动解析 |
| `--lifetime-gate-k` | `10.0` | lifetime sigmoid 的锐度参数 |
| `--opacity-threshold` | 不过滤 | 删除 final alpha 小于等于阈值的点 |
| `--opacity-epsilon` | `1e-6` | alpha 转 logit 前的裁剪值 |
| `--overwrite` | 关闭 | 允许覆盖已有逐帧 PLY |

查看命令行帮助：

```bash
conda run --no-capture-output -n gs python \
  export_raw4d_to_ply_frames.py --help
```

## 9. 安全行为和常见错误

- 默认不会覆盖已有输出；需要覆盖时显式添加 `--overwrite`。
- 输入必须带 `.raw4d` 后缀，并包含精确的 `fp16_quantized 1` 标记。
- 新格式 RAW4D 会逐项校验 `fp16_property` 清单、property 是否存在以及是否确为 `ushort`。
- 兼容没有逐项清单的早期 RAW4D，此时会解码所有 `ushort` property。
- 输出全部为二进制 PLY，浮点 property 为 float32。
- 每个 RAW4D 都会临时生成一份解压后的完整 PLY4，运行时需要预留相应临时磁盘空间。
- 目录输入存在重叠分段时，脚本不会自动融合或裁决重叠帧；它们位于不同输出子目录中。

