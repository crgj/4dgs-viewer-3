# RAW4D 内存与显存架构

<!-- #WDD-gpt 2026-08-16 - 固化位保持 Canonical、GPU 槽流送和稳定 ID 编辑接口，供后续压缩格式直接复用。 -->

## 设计不变量

1. 磁盘格式只负责提供 `GaussianCanonicalDataset`；渲染和编辑层不依赖 RAW4D 文件布局。
2. Canonical RAM 保持源标量位模式。`float16` 使用 `Uint16Array`，`float32` 使用 `Float32Array`，不做有损转换。
3. 所有 RAW4D 属性位于一个 SoA backing store，并通过 65,536 点页面提供零拷贝视图。
4. 稳定 ID 永远等于源点索引。删除和选择不重排点，确保所有属性 sidecar 持续对齐。
5. WebGPU 动态数据只常驻左关键帧、右关键帧和一个预取关键帧。DC 轨迹额外固定第零关键帧。
6. 删除进入一个 R8 GPU 掩码；选择和默认附加属性只驻留 CPU，不占显存。

## 实测字节预算

字节数使用十进制 M（`1M = 1,000,000 bytes`）。

| 数据 | 点数 | CPU Canonical | WebGPU 动态槽 | 旧动态 WebGPU |
| --- | ---: | ---: | ---: | ---: |
| Float32 `master.raw4d` | 287,093 | 126.320920M | 51.676740M | 96.463248M |
| Float16 31 帧段 | 280,368 | 61.680960M | 25.233120M | 94.203648M |

以上 WebGPU 数字不包含 PlayCanvas 基础资源纹理、排序 work buffer 和点顺序 buffer；这些资源仍由实际 GPU 统计显示。WebGPU 基础资源现在直接从 Canonical 数据上传，不再创建一份完整临时 `GSplatData` 副本。

## 运行时数据流

```text
RAW4D / 新压缩格式
        │ 格式适配器
        ▼
GaussianCanonicalDataset（RAM，源位宽，一份 backing store）
        ├── GaussianEditStore（删除/选择位集，CPU 属性列）
        └── KeyframeSlotCache（按当前帧选择 2+1 个关键帧）
                         │ queue.writeBuffer
                         ▼
              WebGPU StorageBuffer 槽 + R8 删除掩码
                         │
                         ▼
                  PlayCanvas work buffer
```

## 后续压缩格式接入

新格式只需实现 `GaussianCanonicalDataset`：

- `tracks` 暴露 position、rotation、colorDc、scale 和 opacity；
- `getPage(keyframeIndex, pageIndex)` 返回指定关键帧和点页面；
- `stableId` 与 `locate` 保持源点索引语义；
- 解码页可以由 IndexedDB、OPFS、压缩内存块或 Worker 提供，渲染层不需要改变。

若新格式支持真正的按页解码，可把当前完整 RAW4D backing store 替换成“压缩页 + 小型 CPU 解码页缓存”，GPU 的 2+1 槽和编辑 sidecar 无需重写。

## 编辑接口

`ViewportRuntime` 已提供：

- `setGaussianDeleted(stableIds, deleted)`；
- `selectGaussians(stableIds, mode)`；
- `isGaussianDeleted(stableId)` / `isGaussianSelected(stableId)`；
- `defineGaussianAttribute(definition)`；
- `listGaussianAttributes()` / `deleteGaussianAttribute(name)`；
- `setGaussianAttribute(name, stableId, value)`；
- `getGaussianAttribute(name, stableId)`。

属性列支持 dense/sparse、1~N 分量和 `u8/u16/u32/i32/f32/f64`。默认 residency 为 `cpu-only`；未来确需渲染的属性可声明 `gpu-on-demand`，通过独立槽上传，避免污染基础高斯布局。
