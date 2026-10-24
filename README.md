# CiCi桌宠

基于 Electron + TypeScript 的 macOS 桌面宠物：透明置顶窗口、状态机动画、好感度养成与全套陪伴玩法。

从一张微信头像出发，经素材管线产出 24 个动作状态 / 125 张透明帧，再叠上交互、养成、提效与陪伴功能。

> ⚠️ 本项目角色素材仅作个人学习与技术演示用途，请勿商用。

## 功能

### 基础交互

- 左键拖拽移动（跨屏贴边），滚轮五档缩放，跟随鼠标
- 点击头 / 身体 / 脚有不同台词与动作
- 右键菜单 20+ 种互动：聊天、摸头、喂食、睡觉、跳舞、撒娇、生气、跳跃、害羞、开心、委屈、惊讶……
- 对话气泡（单行自适应字号）、点击爱心特效、拖拽阴影
- 全局快捷键：`⌘/Ctrl+Shift+P` 显隐、`+1` 随机互动、`+2` 换装轮换

### 养成系统

- 好感度 0～300，四档外观（L1～L4）达成阈值解锁庆祝动画
- 心情系统、宠物日记（保留 30 天）、7 枚成就徽章、每日签到
- 离线想念（分级冒泡）、节日自动换装（可手动切换）、偶尔自动散步

### 提效与趣味

- 番茄钟（到点跳舞庆祝并写入日记）
- 天气感知（open-meteo；雨天缩成一团）
- 自定义互动（`userData/custom-interactions.json` 或小屋可视化编辑器，保存立即生效）
- 小屋 Dashboard：好感度 / 互动 / 番茄钟 / 心情趋势 + 互动类型雷达图（纯 SVG，零依赖）
- 提醒模板：喝水、午休、站起来活动

### 陪伴感

- 陪写代码模式（坐姿陪伴；25 分钟无键盘活动会戳你，无需辅助功能权限）
- 周末回顾卡片、反应小游戏、纪念日 / 时段问候、低电量提醒、深浅色跟随、自动活动

## 架构一览

```
src/
├── main/          # 主进程：窗口、IPC、好感度、日记、成就、番茄钟、自定义互动
├── preload.ts     # contextBridge 暴露类型化 petAPI
├── shared/        # contracts.ts（IPC 契约）
└── renderer/
    ├── pet/       # 桌宠本体（透明无边框）
    ├── dashboard/ # 小屋面板
    └── reminder/  # 提醒浮窗
```

安全默认：`contextIsolation` + `sandbox` + CSP `script-src 'self'`；IPC 经 preload，主进程 `assertSender` 校验来源。

动画骨架是 24 状态 / 28 触发器的纯 TS 状态机（优先级调度 + 冷却 + 打断策略）。素材侧：母版衍生帧序列 → Apple Vision 抠图 → 统一 512×512 画布 → 启动仅常驻 idle/blink，其余按需懒加载。

## 环境要求

- Node.js 20.x 或 22.x
- macOS（推荐；也可打包 Windows）

## 本地运行

```bash
npm ci
npm run preflight
npm run dev
```

国内如 Electron 下载慢，先配置镜像：

```bash
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
```

常用命令：

```bash
npm run check   # 契约 / 素材 / UI / 体验 / 资产五连检
npm test        # 单元测试
```

开发闭环：改代码 → `npx tsc --noEmit` → 若改了受保护文件需重算 `criticalFileHashes` → `npm run check` → 再打包验证。

## 打包

```bash
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/ \
npm run package:mac
```

产物示例：`release/CiCi桌宠-darwin-arm64-ready-to-run/CiCi桌宠.app`。

未签名应用首次打开可能被 Gatekeeper 拦截，需在系统设置中允许；无开发者证书则无法公证 / 上架 App Store，不影响自用。

Windows：

```bash
npm run package:win
```

## 技术栈

- Electron 37
- TypeScript
- Webpack
- Electron Forge

## License

UNLICENSED（个人学习项目）；角色图片素材版权归原作者所有。

---

想自己做桌宠，核心三件事：**透明帧序列、透明置顶窗口、状态机**。其余都是让角色「活起来」的细节。更完整的从 0 到 1 记录见仓库内 `掘金文章-macOS桌面宠物从零到一.md`。
