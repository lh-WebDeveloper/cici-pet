# 从 0 到 1 用 Electron 写一个 macOS 桌面宠物：透明置顶、状态机、好感度与全套养成玩法

> 一个微信头像，经过十几轮迭代，最终变成一个功能完整的 macOS 桌面宠物。这篇文章记录完整的搭建过程：从技术选型、素材管线、透明窗口、状态机动画，到好感度、番茄钟、成就、日记、语音、节日换装、自定义互动配置、点击部位差异化、提醒模板和数据可视化，最后还有发布打包和一堆真实踩坑记录。

## 先看成品

右键菜单有 14 种互动（聊天、摸头、喂食、睡觉、跳舞、撒娇、生气、跳跃、害羞、开心、委屈、惊讶……），点击她的头 / 身体 / 脚会有完全不同的反应；可以拖拽、滚轮缩放、跟随鼠标；有番茄钟、成就徽章、宠物日记、心情系统、每日签到、天气感知、本地语音、节日自动换装、好感度四档外观；支持自定义互动配置（JSON 或小屋面板表单，保存立即生效）；还有一个小屋 Dashboard，展示好感度、互动、番茄钟、心情趋势和互动类型雷达图，以及喝水 / 午休 / 站起来活动的一键提醒模板。

技术栈：**Electron Forge + TypeScript + Webpack**，全部代码 TypeScript，渲染层严格 CSP，无任何外部 CDN。

![角色动作成品展示：同一母版衍生的 8 个动作状态](https://aka.doubaocdn.com/s/I9AW4M4qv2)

## 一、技术选型

桌面宠物本质上是一个**透明的、无边框的、永远置顶的小窗口**，里面跑着一个动画角色。可选方案很多，我对比后选了 Electron：



| 方案       | 优势                                         | 劣势                                      |
| -------- | ------------------------------------------ | --------------------------------------- |
| Electron | 成熟、透明窗口 / 置顶 / 托盘 / 全局快捷键 API 齐全；前端技术栈直接复用 | 包体大（\~200MB）、内存占用高                      |
| Tauri    | 包体小                                        | 系统托盘 / 透明置顶等跨平台 API 尚不完整，macOS 上透明度方案受限 |
| PyQt     | 原生控件强                                      | 动画与视觉设计成本高，包体也不小                        |
| 原生 Swift | 性能最好                                       | 开发迭代慢，动画 / UI 全部手写                      |

选 Electron 的核心原因：**动画和 UI 用 Web 技术做效率最高**，AI 生成的角色素材（PNG 帧）可以直接用 `<img>` 播放；而且 `BrowserWindow` 的 `transparent: true + frame: false + alwaysOnTop` 三件套正好满足桌宠窗口的全部需求。

## 二、整体架构

![CiCi 桌宠整体架构图（Electron Forge + TypeScript）](https://aka.doubaocdn.com/s/XS5Dg1w2YK)

遵循 Electron 安全最佳实践：



```
src/

├── main/          # 主进程：窗口管理、IPC、好感度、日记、成就、番茄钟、语音、自定义互动

├── preload.ts     # 桥接层：contextBridge 暴露 petAPI（类型化）

├── shared/        # 共享契约 contracts.ts（IPC 参数/返回值类型，前后端共用）

└── renderer/      # 三个渲染进程窗口

&#x20;   ├── pet\_window/        # 桌宠本体（透明无边框）

&#x20;   ├── dashboard\_window/  # 小屋面板（数据可视化）

&#x20;   └── reminder\_window/   # 提醒浮窗
```

三个关键安全配置：



```
webPreferences: {

&#x20; preload,

&#x20; contextIsolation: true,

&#x20; nodeIntegration: false,

&#x20; sandbox: true,

&#x20; webSecurity: true,

}
```

渲染层 CSP：`script-src 'self'`（禁止 eval）。这个约束在后面坑了我一次（音频播放被 CSP 拦截），下文会讲。

所有 IPC 都走 **preload 里类型化的&#x20;**`petAPI`，主进程侧对每个 handler 做 `assertSender` 校验来源窗口，防止任意窗口乱调。

## 三、素材管线：从一张微信头像到 125 张透明帧

这是最有意思的部分。用户只给了一张微信头像（Q 版女孩），我需要为 **24 个动作状态** 产出 125 张 512×512 透明 PNG。

### 1. 先定 "母版"，再衍生动作

核心原则：先让 AI 基于头像生成一个**独立身份的母版**（core-ip，透明底），确认用户满意后，所有动作帧都**参考母版**生成，保证同一张脸、同一身体比例、同一配色。

### 2. 每个动作状态作为 "一条序列" 生成

禁止把动作帧当成独立生图任务。每个状态（比如 `jump` 跳跃）一次性生成 5 帧序列，约束 "固定镜头、身体尺度、脚底基线一致"，首帧是准备姿势、末帧能无跳变接回 idle：



```
idle-01 \~ idle-04     待机（4 帧循环）

blink-01 \~ blink-05   眨眼（5 帧）

jump-01 \~ jump-05     跳跃

shy-01 \~ shy-05       害羞（捂脸→低头→偷看→捂嘴笑→恢复）

cheer-01 \~ cheer-05   开心挥手

...共 24 个状态
```

### 3. 抠图

AI 生成的帧带背景，用 macOS 的 **Apple Vision 语义分割**（`VNGenerateForegroundInstanceMaskRequest`）一键抠出主体，比传统色度抠图鲁棒得多，头发丝、耳朵边都保留。

### 4. 统一画布

坑来了：`sips` 缩放 PNG 会**丢 alpha 通道**（变成黑底），必须用 PIL：



```
from PIL import Image

img = Image.open(src).convert("RGBA")

img = img.resize((512, 512), Image.LANCZOS)

img.save(dst, "PNG")
```

所有帧统一 512×512，角色脚底对齐同一基线，保证状态切换时画面不跳。

### 5. 帧的懒加载

125 张图如果启动全解码，首屏会卡。方案：**渲染进程只常驻解码 idle/blink 两套帧（+ 独立母版），其余 115 帧按状态按需解码**，用完缓存。启动时主进程校验 `bootRuntimeAssets`（每张图 `naturalWidth > 0`）才认为启动成功。

## 四、核心：透明置顶窗口与拖拽



```
const win = new BrowserWindow({

&#x20; width: 220,

&#x20; height: 240,

&#x20; transparent: true,      // 窗口透明

&#x20; frame: false,           // 无边框

&#x20; alwaysOnTop: true,      // 永远置顶

&#x20; resizable: false,

&#x20; hasShadow: false,       // 去掉窗口阴影

&#x20; webPreferences: { ... },

});
```

拖拽：鼠标按下 → 主进程 `setIgnoreMouseEvents(false)` + 记录偏移 → mousemove 实时移动窗口 → mouseup 结束。**跨屏贴边**：每次 drag-update 用 `screen.getDisplayNearestPoint(cursor).workArea` 实时计算吸附边界，多显示器切换不会飘。

滚轮缩放：`wheel` 事件调 `setBounds` 等比例缩放，提供 迷你 / 小 / 标准 / 大 / 超大 五档。

## 五、状态机：24 个状态、28 个触发器

![状态机：24 个状态 · 28 个触发器（优先级调度）](https://aka.doubaocdn.com/s/J2s7mdHkau)

这是整个动画系统的骨架。每个状态声明：



```
{

&#x20; "id": "shy",

&#x20; "triggers": \["interaction:shy", "ambient:random"],  // 触发条件

&#x20; "frames": \["shy-01.png", ...],                       // 帧序列

&#x20; "frameDurationMs": 150,

&#x20; "loop": false,            // 是否循环

&#x20; "priority": 600,          // 优先级（打断用）

&#x20; "interrupt": "resume",    // 被打断策略：resume/restart/discard/block

&#x20; "cooldownMs": 8000,       // 冷却，防止狂点刷屏

&#x20; "anchor": { "x": 0.5, "y": 1 }  // 脚底锚点

}
```

调度器按优先级选当前状态：idle（最低）→ 随机小动作 → 互动（高）→ 提醒 / 拖拽（最高，可打断一切）。所有状态机逻辑纯 TS 无框架依赖。

## 六、交互层



* **右键菜单**：原生 Menu 构建，14 个互动 + 换装 + 置顶开关 + 大小 + 退出，全带 emoji。

* **对话气泡**：互动时随机弹中文文案，**单行自适应字号**（长文案自动缩小不换行），气泡永远显示在角色上方，绝不遮挡。

* **点击爱心特效 + 拖拽阴影**：点她会有爱心飘出，拖拽时有影子跟随。

* **点击部位差异化**：按点击位置把角色纵向分成 头 / 身体 / 脚 三区 —— 摸头会说"嘿嘿，摸到头顶啦~"、挠身体说"好痒呀哈哈哈"、碰到脚会"吓我一跳～"，并各自触发对应动作状态。

* **全局快捷键**：`⌘/Ctrl+Shift+P` 显隐、`+1` 随机互动、`+2` 换装轮换。

## 七、养成系统：好感度驱动一切

好感度 0\~300，阈值 60/160/240/280，四档外观（L1 戴花 → L2 抱小熊 → L3 红帽粉外套 → L4 金冠华服）。每次互动加好感，达成阈值播放**解锁庆祝动画**。



* **心情系统**：心情 < 30 时互动回复变平淡、自发言语频率降低、还会叹气 + 委屈。

* **宠物日记**：按天记录互动 / 好感 / 成就 / 番茄钟，保留 30 天，小屋可查看。

* **成就徽章**：7 枚（摸摸达人、投喂大师、话痨朋友、跳跃健将……）。

* **每日签到**：连续 7 天有额外奖励。

* **离线想念**：超过 8 小时 / 1 天 / 3 天 / 7 天没打开，启动时分级冒泡："你去哪了，我好想你"。

* **自动散步**：偶尔自己走一走，跨屏贴边。

## 八、提效与趣味功能

### 番茄钟

右键开启，到点后**角色跳舞庆祝 + 写入日记**（不只是个倒计时）。

### 天气感知

启动时请求 open-meteo 天气 API，雨天她会缩成一团，台词也随天气变化。

### 本地语音

`spawn('say', ['-v', 'Tingting', text])` 用 macOS 自带 TTS 朗读，可开关。

### 节日自动换装

`festivalForDate()` 判断日期，万圣节自动戴巫师帽、圣诞戴红白帽、春节换红装……8 套外观，也可手动切换。

### 自定义互动配置

把桌宠变成 "玩具框架"：用户可以在 `userData/custom-interactions.json` 里追加自己的互动，`stateId` 填现有动作状态或 `bubble-only`（只冒气泡不播动作），**重启生效**。后来我干脆在小屋面板里加了个**可视化编辑器**（表单新增 / 删除），写文件后主进程刷新缓存，**立即生效**，右键菜单、快捷键、统计全部同步。

### 数据可视化

小屋面板用原生 SVG 画了 5 张图：好感度近 14 天累计折线、互动次数柱状、番茄钟柱状、**心情趋势曲线**（每天记录互动后的心情值）和**互动类型分布雷达图**（近 7 天聊天 / 摸头 / 喂食 / 跳舞 / 开心 / 惊讶六轴）。纯手写 SVG，零依赖，严格 CSP 下安全。心情数据从当天开始积累，旧日记没有心情记录时自动沿用最近一次的值，曲线不会断档。

### 提醒预置模板

小屋新增"⏰ 提醒模板"区块：喝水（45 分钟后）、午休（2 小时后）、站起来活动（1 小时后）三个一键按钮，点击即通过现有 `reminders.save` IPC 创建提醒，下方实时展示待提醒列表、支持删除。复用已有提醒链路，零新接口。

## 九、工程化与门禁

这个项目最大的工程化亮点是**受保护文件哈希契约**：`package.json`、`main.ts`、`preload.ts`、`contracts.ts`、`state-machine.ts`、Webpack 配置等关键文件被记录 sha256，任何改动后必须重算哈希，否则 `preflight` 拒绝构建 —— 防止 "改了个寂寞"。

固定开发闭环：



```
改代码 → npx tsc --noEmit → 重算 criticalFileHashes

&#x20;     → npm run check（契约/素材链接/UI/体验/资产五连检）

&#x20;     → npm run package:mac → 杀旧实例 → 重启 → 验证进程
```

测试：`npm test` 17 个单测 + E2E + 冒烟（soak），全部用隔离 userData，不污染真实好感度数据。

## 十、发布与打包

macOS 上 Electron 下载是经典痛点 ——GitHub 直连经常卡死。用镜像：



```
ELECTRON\_MIRROR=https://registry.npmmirror.com/-/binary/electron/ \\

ELECTRON\_BUILDER\_BINARIES\_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/ \\

npm run package:mac
```

产物是 `release/CiCi桌宠-darwin-arm64-ready-to-run/CiCi桌宠.app`。**注意**：未签名应用首次打开会被 macOS Gatekeeper 拦，需要在系统设置里允许；没有开发者证书，不能公证，也无法上架 App Store—— 这是个人项目的常态，不影响自用。

## 十一、真实踩坑记录（价值最高的部分）



1. `sips`**&#x20;缩放 PNG 丢 alpha** → 一律用 PIL `Image.resize(..., Image.LANCZOS)` 保 RGBA。

2. `data:`**&#x20;URL 音频被 CSP 拦**（`Refused to load media`）→ 改 Web Audio：`atob` 解码 base64 → `AudioContext.decodeAudioData` 播放，播放时随机 ±5% `playbackRate` 变调，避免重复感。

3. **asar 里中文路径&#x20;**`extract-file`**&#x20;报 not found** → 必须整包 `asar extract` 再查，`extract-file` 对带斜杠 / 中文路径不友好；asar header 是 pickle 格式，手写解析必翻车。

4. **新旧实例并存**：`pkill -f "CiCi桌宠.app"` 杀不掉 cmdline 是 `./CiCi桌宠`（相对路径）的旧进程，导致两个实例同时跑、界面看着是旧版。后来统一 `pkill -f "CiCi桌宠"` 并按 PID 补杀。

5. **小屋面板 "看不到数据趋势模块"**：模块其实在，只是排在成就区下方、需要滚动 —— 而滚动容器 `flex: 1` 失效（父级 `.card` 不是 flex 容器），内容超高后直接裁掉。修法：`.card { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }`，滚动区加 `min-height: 0`。

6. **节日帽叠戴**：AI 生成圣诞装时给角色戴了巫师帽 + 圣诞帽两顶，重做时约束 "仅保留一顶帽子"。

7. **受保护文件哈希**：改了 `main.ts` 忘记重算哈希，`preflight` 直接拒构建 —— 门禁真的会拦人。

## 十二、还能做什么



* 接入 AI 对话（用户当前明确排除了，但这是最自然的方向）

* 全局打字反应（uiohook-napi，需要辅助功能授权）

* 更多节日外观、更多情绪动作

* 小屋数据可视化继续扩展（留存分析、热点时段热力）

* 行为习惯学习：根据用户活跃时间自动调整作息



***

**项目地址**：本地工程 `cici-pet`（Electron Forge + TS），素材全部 AI 生成。

如果你也想做一个属于自己的桌宠，核心就三件事：**一张角色的透明帧序列、一个透明置顶窗口、一个状态机**。剩下的，全是让角色 "活起来" 的细节。

> 本文由豆包协助整理，基于真实的构建过程与代码实现。