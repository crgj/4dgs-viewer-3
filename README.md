# Dong Editor 3

基于 React、Vite 和 PlayCanvas 的 4D Gaussian Splatting 浏览器与编辑器基础工程。

## 启动

```bash
npm install
npm run dev
```

## 验证与构建

```bash
npm run typecheck
npm run test
npm run build
```

生产构建输出到 `docs/`，并使用相对资源路径，可直接部署到普通静态服务器或 GitHub Pages。

## RAW4D 播放

点击顶部“导入”选择 `.raw4d` 文件。当前主格式是 little-endian 二进制 PLY 容器：全部 vertex 属性以 `ushort` 保存 IEEE 754 binary16 位模式，并由 `comment fp16_quantized 1` 与逐属性 `comment fp16_property ...` 明确标记；旧版 float32 RAW4D 仍可作为兼容输入。读取器支持多关键帧位置、旋转、DC、尺度与透明度轨迹，以及共享 SH 和 `lifetime_mu/lifetime_w` 生命周期。文件按块读取；导入完成后，底部时间轴、逐帧按钮、播放与循环控制会自动切换到文件声明的总帧数。

文件可以直接拖到编辑器任意位置重新打开；文件选择器也支持多选。单文件沿用原格式导入，多文件必须全部是 `.raw4d`。多段预处理在浏览器 Worker 内完成：若文件名带 `segment_180_210` 一类范围则按源帧排序，否则保留拖入顺序；相邻段必须共享同一个首尾帧，主时间轴只保留一次边界并由后一段 `local=0` 接管。边界 Gaussian 按 Position 原始标量位模式一对一续接，重复位置再用完整 SH/DC 位模式消歧，生成不回收的永久 Track ID。Worker 同时把 45D SH 从非 SH 属性扫描中独立提取，按永久 Track 验证共享值并精确统计跨段更新；当前六段实测为零 SH 更新。预处理完成后，六段规范数据全部 Pin 在统一的系统内存驻留池；播放建立“当前段 + 未来段”的隐藏 GPU 滑动窗口，命中预取段时只切换实体显隐。窗口按包含 Sort/WorkBuffer 余量的完整渲染峰值服从当前显存预算；空间不足时先淘汰离目标最远的已播放段，没有历史段时再淘汰最远未来段，当前段始终受保护。时间轴以细短刻度显示 Position、Rotation、DC、Scale 与 Opacity 的真实稀疏关键帧，以较大的菱形显示各段起点和序列终点。虚拟序列不会改写用户源文件；当前指定的六段质量验收源在顶部点击“导出”时默认下载正式 `.4cgs` 容器。

文件菜单的“导出”是二级子菜单：“`.4cgs 文件`”沿用既有容器导出；“`.ply 序列`”先让用户通过 File System Access API 选择一个本地写入目录（需要 Chrome/Edge 一类支持的浏览器，其他浏览器会明确报错且不改用其他通道），随后逐帧直接写入该目录，不再打包 ZIP。每个 `frame_XXXXXX.ply` 都是标准静态 3DGS float32 PLY：xyz 线性插值、WXYZ SLERP 旋转、DC 线性插值、raw log-scale 原值插值、opacity 先 sigmoid×生命周期门再回写 logit，法线为零、共享 SH 原样展开；帧号沿用文件名源帧范围的全局编号，多段共享边界只输出一次并由后一段 `local=0` 接管，已删除高斯在每帧压实剔除。导出过程复用与 4CGS 保存一致的监督弹窗，显示阶段、逐帧进度、日志、耗时、输出字节数并可随时取消；取消会终止 Worker，目录中可能保留已写入的部分帧文件。编码与写盘全部在浏览器 Worker 内完成，语义对齐 `py/export_raw4d_to_ply_frames.py`，不依赖任何本地服务。

<!-- #WDD-gpt 2026-08-17 - 记录文件菜单导出子菜单与 .ply 序列目录直写导出的浏览器实现语义。 -->

<!-- #WDD-gpt 2026-08-16 - 记录场景拖放重开、多 RAW4D 边界折叠、永久轨迹和独立 SH 预处理语义。 -->

<!-- #WDD-gpt 2026-08-16 - 记录多段系统内存驻留、单段显存换入和稀疏关键帧时间轴标记。 -->

<!-- #WDD-gpt 2026-08-16 - 将单段显存换入升级为按预算预取和历史优先淘汰的 GPU 滑动窗口。 -->

当前 RAW4D 导入由独立 `Loader Worker` 执行。新版 fp16 数据用 64K 查表在反交错时直接展开到目标 SoA `Float32Array`，不会创建完整 float32 AoS 副本；旧版 float32 数据继续由 WASM 内核反交错。站点启用跨源隔离时直接写入 `SharedArrayBuffer`，否则通过 Transferable 移交 backing store 的所有权。大数组由格式无关的 `Gaussian4DDataManager` 持有，React 只保存帧号、进度、预算、错误和 Buffer ID。RAW4D 是无压缩调试适配器，正式 4CGS V2.4 通过私有 Codec Worker 接入同一管理层。

WebGPU 模式把位置关键帧和其余动态属性分别分批上传到两个长期 `StorageBuffer`，避免依赖单个超大 Buffer。播放时 React 只更新帧号 uniform，由 GSplat work buffer 的 WGSL 直接读取关键帧 Buffer，完成位置、DC、对数尺度、透明度与四元数最短路径插值，输出由 Gaussian Renderer 与 GPU Sort 直接消费；共享 SH 不会重复上传，也不会在 CPU 逐帧生成完整 float32 结果。若设备的 Storage Binding 上限或显存预算不足，会捕获 WebGPU OOM 并回退到分属性 GPU 纹理；WebGL2 仍以较低频率更新 CPU 排序中心。

底部状态栏每秒更新一次内存指标。检查器的“性能 / Performance”页明确区分：`JS 堆内存`是 React 与脚本对象使用的系统内存；`4D 数据内存`是 Worker、TypedArray、SharedArrayBuffer 使用的系统内存；`GPU 显存`是 PlayCanvas 跟踪的纹理与 GPUBuffer，其中单独标出 4D GPU 池。页面提供三组占用仪表和最近 60 秒趋势图，并显示 Worker 传输方式、WASM/GPU 解码后端和 Buffer ID。趋势记录只保存归一化数值，不保存 Gaussian 数组。

检查器分为“变换 / 高斯 / 性能”三个 Tab，只有当前页内容滚动。顶部“中 / EN”可即时切换全部 UI 标签、按钮、提示、时间轴和性能面板文案。

## 4CGS V2.4 浏览器读写

顶部“导入”正式接受 `.4cgs`。当前产品格式是 `4CGSPRS2` / manifest version 2：一个容器可组合六个 RAW4D 片段，以永久 Track ID 保留边界对应关系，Position、Rotation、Scale、DC 和 Opacity 使用 V2.4 结构流，共享一份 CoReSH-5R SH 轨迹与生命周期流。六段重合边界在主时间轴只计一次；例如全局第 30 帧会选择第二段 local frame 0，不会重复播放前段末帧。

读取首先校验文件长度、流目录以及 stored/raw SHA-256；九条容器流并行读取和校验，原样存储流不会重复计算同一份 SHA-256。外层 Brotli 由 `brotli-wasm` 解码，XZ、rANS、Predictive Rice、Scalar-RQ 和 CoReSH-5R 全部在浏览器 Worker 内执行。启用 COOP/COEP、浏览器暴露至少 8 个逻辑核心时，Position、Rotation、Scale、DC、Opacity、Lifetime 与 SH 七个属性 Worker 直接写互不重叠的共享行缓冲；至少 16 核时再按永久 Track 把 Rotation 拆给 2–4 个子 Worker，32 逻辑核心机器达到 11 个子 Worker加 1 个主解码 Worker。较少核心使用四属性 Worker 保守路径，没有 `SharedArrayBuffer` 时保留同算法的串行兼容路径。加载卡片每 400ms 更新已完成 Worker 数、剩余属性和实际耗时，并在属性完成时推进进度；进度条流光由合成层持续显示繁忙状态，不会再把最慢 Worker 的等待表现成界面卡死。Position/Scale 热循环缓存属性偏移并直接写最终 FP16，Scale/DC 不再创建整段 banks 临时数组；共享 SH 只在 Track 码字更新时重建 45D。属性完成后同时提交全部片段提取请求，规范 RAW4D 由最多 3 个 Loader Worker 并行解析并 Pin 在系统内存驻留池；Loader 池不会跟随逻辑核心数无限放大，以免六个大数组同时分配造成带宽争用。播放与多 RAW4D 共用“当前段 + 未来段”GPU 滑动窗口。命中预取段只切换实体显隐，显存不足时优先淘汰已播放段，当前段始终受保护，不再到段落节点才临时解码和上传。

“导出”对未修改的 4CGS 执行无损 Save As：重新验证头部、清单和流目录后下载同字节 `.4cgs`，不会把当前单段 RAW4D 冒充为完整容器。对 `collected_master_ply4_cleaned_fp16` 的六个指定 RAW4D 源，导出会先在浏览器逐文件校验文件名、字节数和 SHA-256，再下载已通过质量门的 V2.4 bitstream：59.599395M，源数据 335.222844M，压缩比 5.6246x；任何源不一致都会明确拒绝，不会生成伪容器。V2.4 压缩载荷在前端暂按只读语义处理；检测到高斯删除时会拒绝保存并提示撤销，禁止静默丢弃编辑。任意其他新 RAW4D 组合仍需先经过离线编码器，离线编码器不是页面运行依赖。

运行时没有云端 API、Node.js、Python、CUDA 或 localhost 依赖。生产构建中的 Brotli WASM 当前约 1.06 MB，4CGS 主 Worker、属性 Worker、辅助 Worker 与 Rotation 分区 Worker 分别约 160 KB、113 KB、85 KB 和 14 KB；六段专用的已验收 V2.4 导出资源为 59.599395M，只在用户点击导出后按需读取。它们都通过本站带内容哈希的静态 URL 加载。缓存位置是浏览器普通 HTTP Cache，缓存键由构建文件名哈希决定；刷新会复用同版本，部署新哈希后才下载新版本。用户可通过浏览器“清除站点数据/缓存”删除这些资源。本格式不下载模型，也不使用 IndexedDB、Cache Storage 或 OPFS。当前 32 逻辑核心工作站对这份 59.599395M 文件的最终生产构建三次完整解码为 2.998–3.281 秒，中位数 3.214 秒；此前 8 个总 Worker 版本中位数为 3.780 秒，同机“四属性 Worker + 主 Worker 串行辅助属性”的基线为 10.968 秒。完整打开三次为 5.435–5.647 秒，中位数 5.442 秒；其中片段提取中位数 0.196 秒、六段并行 CPU 驻留 0.751 秒、首段 GPU 激活 1.358 秒。GPU 传输继续服从单队列和显存预算，不随 CPU Worker 数盲目并发。

<!-- #WDD-gpt 2026-08-16 - 记录六段 RAW4D 默认导出质量验收版 4CGS、多线程位级等价解码，以及系统内存驻留和显存预取边界。 -->

“变换”页可通过数值输入实时修改活动 RAW4D 对象的位置、欧拉旋转和缩放，也可使用视口中的彩色 Gizmo 直接拖拽。工具栏与变换页都可切换移动、旋转和缩放，数字键 `1/2/3/4` 对应选择、移动、旋转和缩放；变换支持世界/局部坐标切换、等比缩放以及分组/全部重置。

摄像机支持鼠标左键旋转、中/右键平移、滚轮缩放，以及 `W/S` 前后、`A/D` 左右、`Q/E` 下上漫游。文本框、数值框、下拉框或可编辑区域获得焦点时会立即暂停键盘漫游；点击检查器、工具栏、时间轴等 UI 面板不会改变摄像机。拖拽变换 Gizmo 时也会临时锁定相机输入。

场景世界坐标使用米制：原点的 X/Y/Z 坐标轴分别为红/绿/蓝三色，每根轴长精确为 1 m。

## 智能人物对齐插件

“变换”页中的“智能人物对齐”使用浏览器本地的 MediaPipe Pose Landmarker Lite 与 Face Landmarker，一次最多识别 6 个人。用户可先用当前摄像机把人物放在屏幕中清晰、完整的位置；点击分析后，第一张识别图保留当前构图，后续从该方向起以 22.5° 间隔渲染 16 个环绕视角。姿态模型融合头、肩、髋和脚部投影求无符号三维身体轴，独立人脸模型对身体轴两端裁剪执行完整人脸关键点网格验证，只接受明确胜出的真实头端，排除靴子和服饰纹理造成的假人脸；所有人物脚点的平均站立位置用于求三维原点。首次变换后会再次执行 16 视角验收：稳定的反向人脸证据仍会否决并回滚；复检暂时看不到人脸时改用无符号身体轴检查残余倾角，脚点不足时仅跳过二次位移微调，不再撤销首轮可靠结果。

插件代码独立保存在 `src/plugins/smart-alignment/`。姿态与人脸模型和 WASM 运行时自托管于 `public/plugins/smart-alignment/`，部署后不依赖推理 API，也不会上传渲染图像。首次运行需要从本站静态资源加载约 9.6 MB 模型和对应 WASM；浏览器缓存后会直接复用。姿态与人脸识别分别在独立 Worker 中执行，避免 MediaPipe WASM factory 冲突和主 UI 阻塞。

## GS2Mesh 当前帧插件

检查器的“GS2Mesh”页可将时间轴当前帧重建为带顶点色的三角网格，并直接作为 PlayCanvas Mesh 加入当前场景。插件从 RAW4D 当前帧直接读取 Gaussian 的位置、旋转、尺度、颜色和 opacity，不再从双目渲染图估算深度。最贴近当前摄像机中心射线的一组 Gaussian 用于估计焦点；用户点击时的透视摄像机完整保留为第一个视角，其余视角围绕该焦点构造，整个过程不重复截图。

重建分两层。加载层从完整当前帧制作最多 12K Gaussian 的分层抽样副本，并强制保留 XYZ 六个空间极值；预览固定使用 `72³` 场和每个相交 cell 最多一个顶点的 Surface Nets，所以预览内存不再随 40K/80K/160K 最终上限增长。预览 Mesh 立即绘制到场景，完整 Gaussian 数组仍保留给后台精细重建。后台层参考 [Gaussian Opacity Fields](https://github.com/autonomousvision/gaussian-opacity-fields)：按每视角 `4×4` 屏幕 tile 建稀疏射线候选，对采样点计算射线与各向异性 Gaussian 的最大响应位置，执行 alpha composition 后取跨视角最小 opacity 形成 GOF level set。面板可标定“每场景单位对应多少毫米”，并直接选择 `0.25/0.5/1/2 mm` 目标叶子体素；毫米模式不再受 1024 限制，按目标间距生成最高单轴 16384 的虚拟坐标。活动区先用 Gaussian 真实旋转后的 `3.5σ` 椭球与 `16³` brick 做保守相交测试，避免用最大 scale 立方体登记大量空角；CPU 再逐个 Z brick 层建立临时索引，不保留全局活动 brick 集合，也没有百万分区上限。WebGPU 每次仅计算 24 个活动 brick，读回后立即执行局部 Marching Tetrahedra，随后复用同一组场与 readback 缓冲；完成一个 Z 层后其活动索引和局部 CPU 场都可回收。

若 Worker 完全无法取得 WebGPU adapter，则自动保留相同虚拟分辨率和毫米间距，改用随站点发布的 WASM 核心逐个复用 `17³` 局部场。WASM 回退恢复原始全视角 Visual Hull，不再执行会改变局部拓扑的灰度闭运算或分量约束聚类；它改用 `sqrt(scale² + (1.5 voxel)²)` 构造平滑 Gaussian alpha 外包络，大尺度轴几乎不变，只包住过薄轴之间的小间隙，再以标准 Marching Cubes 提取连续拓扑。中间拓扑仅在超过 1,000 万三角形时才启用 2/4 voxel 平均顶点聚类。它不会退化到 160³，也不会因为毫米模式或 400 万个过滤前三角形直接失败。所有分区在共享边界上焊接并做一次全局连通分量过滤。GPU 顶点回投按最多 65,536 点分批复用缓冲，再沿真实 GOF 执行 8 次二分。可选的双边平滑会忽略跨越 35° 尖锐边的邻点，并把累计漂移限制在半个叶子体素。GPU GOF/投影细分受 400 万三角形预算约束，WASM 最终有效表面受 1,200 万预算约束。

插件不访问重建 API，不需要 Python、CUDA、Open3D 或独立进程，参数和网格全程留在当前前端。WebGPU 不可用或资源超限时，会自动切到同一 Worker 内的 WASM opacity field 回退，不会请求远程服务。直接运行 Viewer：

```bash
npm run dev
```

`npm run build` 会先从 `src/plugins/gs2mesh/wasm/gs2mesh_core.wat` 重新生成 WASM，再执行 TypeScript 与 Vite 构建。生成成功后可分别切换 Gaussian 与 Mesh 可见性、清除结果，或导出二进制 PLY。Mesh 固定对应生成时的帧；时间轴继续播放不会把静态 Mesh 冒充动态网格。

GS2Mesh 没有网络模型、权重或运行时 CDN 依赖。Marching Cubes 的小型 `isosurface` 代码与 WGSL 一起打入带内容哈希的 Worker chunk，WASM 也随站点静态发布；当前生产 Worker 约 59 KB。它们由浏览器 HTTP 缓存按构建哈希复用，因此不需要 IndexedDB/OPFS 模型缓存，也不存在模型版本升级或重复下载。用户可用浏览器“清除站点数据”删除这些静态缓存；部署新构建时文件哈希变化，旧缓存不会被误用。

<!-- #WDD-gpt 2026-08-15 - 记录两层纯前端 GS2Mesh/GOF 管线、回退路径及零模型缓存策略。 -->

## Gaussian 重光照插件

插件中心的“Gaussian 重光照”以当前 GS2Mesh 结果作为几何代理，参考 PlayCanvas 的 [Relighting](https://developer.playcanvas.com/user-manual/gaussian-splatting/building/relighting/) 流程：中性灰代理 Mesh 和点光源位于专用 Layer，匹配主摄像机的离屏相机先输出带覆盖 Mask 的光照纹理，Gaussian fragment 再按屏幕坐标逐像素采样并调制原始颜色。代理之外的 Gaussian 使用独立背景倍率，因此天空或 Mesh 未覆盖区域不会被错误套用表面光照。

必须先在 GS2Mesh 插件中生成当前帧 Mesh。重光照面板可启用/关闭效果，调节影响强度、整体亮度、代理外亮度和 50%/75%/100% 光照纹理分辨率；最多可添加 8 个带颜色、强度、范围和阴影开关的点光源。选择光源后可直接编辑 XYZ，也可拖动视口中的移动 Gizmo。拖动时阴影实时更新，停止后切换为单帧更新以减少静态场景开销。隐藏可见 Mesh 不会关闭其离屏代理；清除 Mesh 会立即停止重光照。

该插件没有网络 API、模型、权重或运行时 CDN 依赖，也不会上传 Gaussian、Mesh 或截图。运行代码来自随构建打包的 PlayCanvas，重光照纹理和阴影贴图只驻留 GPU 内存，不写入 IndexedDB、Cache Storage 或 OPFS，因此没有资源版本键和持久缓存升级流程。关闭插件效果或清除 Mesh 会停止相关渲染；刷新页面会释放全部临时 GPU 资源，浏览器“清除站点数据”只需用于删除普通静态构建缓存。

<!-- #WDD-gpt 2026-08-15 - 记录 GS2Mesh 屏幕空间重光照、可移动点光源及零网络资源缓存策略。 -->

## 内存模式

检查器的“内存与显存”提供五档主动预算：

| 模式 | CPU 预算 | GPU 预算 |
| --- | ---: | ---: |
| 自动最高（默认） | 浏览器可报告的本机内存/JS Heap 上限取较大值，最低回退 8 GB | 8 GB 应用上限 |
| 兼容 | 1 GB | 512 MB |
| 平衡 | 4 GB | 2 GB |
| 高性能 | 12 GB | 6 GB |
| 自定义 | 1–64 GB | 0.5–32 GB |

预算只约束应用自己创建和登记的资源。`navigator.deviceMemory` 和 Chromium 的 JS Heap 指标可能出于隐私原因被取整或封顶；WebGPU 没有总显存/剩余显存查询接口，所以自动模式中的 8 GB 是最高应用预算，不是检测到的物理显存。程序不会用“分配到崩溃”的方式探测容量。`GpuBufferPool` 会同时遵守 `maxBufferSize`、`maxStorageBufferBindingSize` 和应用预算，并支持按设备上限切块及显式释放。

## SharedArrayBuffer 部署要求

`npm run dev` 和 `npm run preview` 已自动发送以下响应头，`public/_headers` 也会复制到生产目录，供支持该文件的静态托管平台读取：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

生产服务器必须实际返回这些头才能启用 `SharedArrayBuffer`。GitHub Pages 不读取 `_headers`，在该环境中应用仍可运行，但会自动使用 Transferable；若要获得共享内存路径，应使用能配置响应头的静态服务器或 CDN。

## 目录结构

```text
src/
├── app/                         React 工作台外壳与全局样式
├── core/
│   └── engine/                  PlayCanvas 渲染扩展协议
├── plugins/
│   ├── smart-alignment/         本地姿态与人脸识别、十六视图求解器、Worker 与独立 UI
│   ├── gs2mesh/                 当前帧双目相机规划、WASM 重建 Worker、PLY 导出与场景 Mesh UI
│   └── relighting/              GS2Mesh 离屏光照传递、点光源编辑与独立 UI
└── features/
    ├── editor/
    │   └── tools/               编辑工具接口与注册表
    ├── gaussian/
    │   ├── formats/             格式适配器及各格式私有的 Parser、Worker、WASM 与指标
    │   ├── memory/              格式无关的 4D 数据管理、内存预算和分块 GPUBuffer 池
    │   └── runtime/             Gaussian 资源和运行时对象
    └── viewport/
        ├── components/          React 与渲染运行时的生命周期桥接
        └── runtime/
            ├── camera/          桌面与触屏相机控制
            └── scene/           网格、坐标轴等场景辅助对象
```

## 扩展边界

- 自定义渲染：实现 `RenderExtension`，由 `RenderExtensionRegistry` 管理挂载和释放。
- 自定义编辑工具：实现 `EditorTool`，注册到 `EditorToolRegistry`。
- 自定义格式：实现 `GaussianFormatAdapter`，注册到 `GaussianFormatRegistry`；格式私有的 Worker/WASM 留在对应格式目录，公共内存与显存资源交给 `Gaussian4DDataManager`。
- 4DGS 时序：应独立于文件资产和 React 生命周期管理，分段切换只切换活动帧或运行时状态，不销毁可复用的 GPU 资源与编辑状态。

当前首屏使用 3,200 个运行时生成的真实 Gaussian 作为默认对象，不依赖远程模型资源。PlayCanvas 优先请求 WebGPU，并自动回退到 WebGL2。

## Braindance 风格非 SH 离线压缩

`scripts/encode-fourcgs-prs-morton.mjs` 的第五个参数接受 `braindance`：在永久 Track ID 和共享
CoReSH-5R 之外，对 Scale、DC、Opacity 建立分属性半精度码表、8/10/12-bit 标签、时间残差和
有界原值修复。`braindance60` 是 60M 码率搜索档；编码器会比较候选真实字节数，并在候选大于
原有无损流时自动回退。公开 MINT v6 没有发布编码器，因此这里复用的是已由公开 WebGPU/WASM
运行时确认的结构，不是官方二进制兼容格式。

```bash
node scripts/encode-fourcgs-prs-morton.mjs \
  /absolute/source-segments \
  /absolute/source-coresh.4cgs \
  /absolute/output.4cgs \
  braindance

node scripts/decode-fourcgs-prs-morton.mjs \
  /absolute/output.4cgs \
  /absolute/decoded-directory \
  /absolute/source-segments
```

这些命令只用于离线制作与验收资产，不是浏览器插件的运行时依赖；正式页面仍不要求 Python、
Node.js 或 localhost 服务。

<!-- #WDD-gpt 2026-08-15 - 记录 Braindance 风格非 SH 码表档、60M 搜索档和纯前端运行边界。 -->

## H4XYZ 层级预测研究容器

Position 研究工具按永久 Track、一次 Morton 排序、256 点固定块、61 个去重关键帧、0.5mm
整数格、双向层级预测、Translation/SE3/SIM3/Affine/局部控制节点、精确三维残差字典和 rANS
生成 `.h4xyz`。独立解码器会重新读取源 RAW4D 并逐整数分量验收，不依赖编码器内存数组。

```bash
node scripts/analyze-fourcgs-hierarchical-entropy.mjs \
  /absolute/source-segments \
  /absolute/xyz-entropy.json \
  /absolute/position.h4xyz

node scripts/decode-fourcgs-hierarchical-position.mjs \
  /absolute/position.h4xyz \
  /absolute/source-segments \
  /absolute/position-validation.json

node scripts/analyze-fourcgs-attribute-entropy.mjs \
  /absolute/source-segments \
  /absolute/attribute-entropy.json
```

`.h4xyz` 当前只用于 Position 熵实验和独立解码验收，不是完整 `.4cgs`，也不接入用户页面。
正式浏览器格式仍需在通过总字节预算后增加分 Segment Chunk Directory、WASM Worker 解熵和
WebGPU 重建；离线制作工具使用 Node.js，但正式前端功能不得依赖 Node.js 或 Python。

<!-- #WDD-gpt 2026-08-15 - 记录 0.5mm 精确层级 Position 容器的离线编码、独立解码和浏览器边界。 -->
