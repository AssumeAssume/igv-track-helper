# IGV-Web Track Helper v0.4.0

## 更新

在 Tampermonkey 中打开原来的 IGV-Web Track Helper，把全部代码替换为本包的 `igv-track-helper.user.js` 并保存。只启用一个版本。先保存或确保能恢复当前 IGV session，再刷新页面一次，清掉旧版本留下的监听器。

仍匹配整个 KU Leuven OnDemand 域名，更换 node 或 session 端口不需要修改。

## 选中的 tracks 一起拖

打开 IGV 的 **Select Tracks**，勾选至少两条 track，然后拖动任意已选 track **右侧的拖拽柄**。不需要它们原本相邻，也不需要新增按钮或键盘修饰键。

拖动时显示移动数量和蓝色插入线，松开鼠标后一起移动到该位置，聚成连续的一组。选中和未选中 tracks 各自的相对顺序都保持不变。轨道顺序在松开时提交，不是拖动途中不断重排。

靠近轨道区域的上下边缘可以自动滚动。在当前 IGV 轨道区域之外松开会取消；只点一下拖拽柄但不移动，不会改变顺序。只选一条或者拖动未选 track 的柄，仍按 IGV 原本的单条拖动处理。

**Undo / Redo** 同时支持选区操作和整组移动。新增/删除 tracks 会清理失效历史；外部排序造成顺序变化时，旧的排序撤销记录也会经过检查。

## 精简界面

移除了选区预设（含保存、载入、导入、导出）和可见性筛选（Visible、Hidden、In viewport）。旧版保存在浏览器里的预设数据不再读取，但不会自动删除。

主界面保留 **Select All / Invert / Clear All**、**Undo / Redo / Copy Names**、已选计数和拖拽提示。

名称和类型筛选保留在默认折叠的 **Filter & select** 中；包括 Include / Exclude、Regex、Match case 和替换/追加/移除选区。已选名称可在 **Selected tracks** 中查看。

工具栏仍可拖动、折叠、记忆位置，默认在右上角距边缘 8 px；按钮和提示全部英文，没有新增键盘快捷键。

## 实现与边界

不是单独移动页面上的拖拽柄。脚本读取已存在的 IGV browser 对象，更新真实 track 顺序并调用 `reorderTracks()`，让名称、数据、坐标轴和其他列同步重排，随后触发 `trackorderchanged`。顺序只保存在当前 session 中，关闭后需要通过 IGV 的 session 保存/恢复流程保留。

此排序适配依赖 IGV 内部对象结构，未来版本可能需要调整。通常一个已经渲染的 canvas 就可以定位整个 browser；尚未渲染、没有公开 browser 对象或受限的脚本运行环境可能无法获取它。找不到兼容接口时会显示 **Group drag unavailable**，选区功能仍可继续使用。

本版通过 **23 项本地 Chromium 测试**，包含模拟的并行列、open Shadow DOM、同源 iframe、分散选中聚拢、上下移动、排序/选区撤销、重名轨道、动态加载和自动滚动。**测试使用模拟 IGV 的测试对象，并未在你的登录态 HPC 页面、实际 Tampermonkey 环境或其他浏览器完成实测。** 预览图同样来自模拟页面。

解压后可打开 `demo.html` 试用模拟界面，无须加载基因组数据。完整测试和运行方法见英文 README。

脚本本身没有联网请求、上传、分析统计和外部依赖；仅持久化工具栏位置和折叠设置，点 Copy Names 才会复制名称。
