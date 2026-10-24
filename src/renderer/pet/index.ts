import spec from '../../../pet-spec.json';
import type { PetSpec, StateActivity } from '../../shared/contracts';
import { affectionLevel, selfTalkPool, maybeWarmReply } from '../../shared/relationship';
import { playPop, playInteraction, setSoundEnabled } from './sound';
import l1_1 from './outfits/outfit-l1-01.png';
import l1_2 from './outfits/outfit-l1-02.png';
import l1_3 from './outfits/outfit-l1-03.png';
import l1_4 from './outfits/outfit-l1-04.png';
import l1_5 from './outfits/outfit-l1-05.png';
import l2_1 from './outfits/outfit-l2-01.png';
import l2_2 from './outfits/outfit-l2-02.png';
import l2_3 from './outfits/outfit-l2-03.png';
import l2_4 from './outfits/outfit-l2-04.png';
import l2_5 from './outfits/outfit-l2-05.png';
import l3_1 from './outfits/outfit-l3-01.png';
import l3_2 from './outfits/outfit-l3-02.png';
import l3_3 from './outfits/outfit-l3-03.png';
import l3_4 from './outfits/outfit-l3-04.png';
import l3_5 from './outfits/outfit-l3-05.png';
import l4_1 from './outfits/outfit-l4-01.png';
import l4_2 from './outfits/outfit-l4-02.png';
import l4_3 from './outfits/outfit-l4-03.png';
import l4_4 from './outfits/outfit-l4-04.png';
import l4_5 from './outfits/outfit-l4-05.png';
import fhw_1 from './outfits/outfit-fest-hw-01.png';
import fhw_2 from './outfits/outfit-fest-hw-02.png';
import fhw_3 from './outfits/outfit-fest-hw-03.png';
import fhw_4 from './outfits/outfit-fest-hw-04.png';
import fhw_5 from './outfits/outfit-fest-hw-05.png';
import fx_1 from './outfits/outfit-fest-xmas-01.png';
import fx_2 from './outfits/outfit-fest-xmas-02.png';
import fx_3 from './outfits/outfit-fest-xmas-03.png';
import fx_4 from './outfits/outfit-fest-xmas-04.png';
import fx_5 from './outfits/outfit-fest-xmas-05.png';
import fny_1 from './outfits/outfit-fest-ny-01.png';
import fny_2 from './outfits/outfit-fest-ny-02.png';
import fny_3 from './outfits/outfit-fest-ny-03.png';
import fny_4 from './outfits/outfit-fest-ny-04.png';
import fny_5 from './outfits/outfit-fest-ny-05.png';
import fyf_1 from './outfits/outfit-fest-yuanxiao-01.png';
import fyf_2 from './outfits/outfit-fest-yuanxiao-02.png';
import fyf_3 from './outfits/outfit-fest-yuanxiao-03.png';
import fyf_4 from './outfits/outfit-fest-yuanxiao-04.png';
import fyf_5 from './outfits/outfit-fest-yuanxiao-05.png';
import fma_1 from './outfits/outfit-fest-midautumn-01.png';
import fma_2 from './outfits/outfit-fest-midautumn-02.png';
import fma_3 from './outfits/outfit-fest-midautumn-03.png';
import fma_4 from './outfits/outfit-fest-midautumn-04.png';
import fma_5 from './outfits/outfit-fest-midautumn-05.png';
import fsp_1 from './outfits/outfit-fest-spring-01.png';
import fsp_2 from './outfits/outfit-fest-spring-02.png';
import fsp_3 from './outfits/outfit-fest-spring-03.png';
import fsp_4 from './outfits/outfit-fest-spring-04.png';
import fsp_5 from './outfits/outfit-fest-spring-05.png';
import { exceedsDragThreshold } from '../../main/drag';
import { PetStateMachine } from './state-machine';
import './index.css';

const petSpec = spec as PetSpec;

const sprite = document.getElementById('pet-sprite') as HTMLImageElement;
const shadowEl = document.getElementById('pet-shadow') as HTMLDivElement | null;
let spriteLoaded = false;
sprite.addEventListener('load', () => {
  if (!spriteLoaded) { spriteLoaded = true; sprite.style.opacity = '1'; }
});
const container = document.getElementById('pet-container') as HTMLDivElement;
const feedbackBubble = document.getElementById('feedback-bubble') as HTMLDivElement;

// Chromium 会默认把 img 当作可拖拽内容；桌宠只允许窗口拖拽。
container.addEventListener('dragstart', (event) => event.preventDefault());

// Webpack 在构建时递归收集当前 spec 对应的素材，不硬编码角色或动作名。
const assetMap = new Map<string, string>();
const assetFrames = new Map<string, string[]>();
const assetContext = require.context('../../assets/pet', true, /\.png$/i);
for (const key of assetContext.keys()) {
  assetMap.set(key.replace(/^\.\//, ''), assetContext(key));
}
// 启动常驻素材：只预加载 idle/blink（+ 独立母版），其余状态首次进入时按需解码
const bootStateIds = new Set(['idle', 'blink']);
const bootAssetNames = [...new Set([
  petSpec.character.coreAsset,
  ...petSpec.states.filter((state) => bootStateIds.has(state.id)).flatMap((state) => state.frames),
])];
const allAssetNames = [...new Set([
  petSpec.character.coreAsset,
  ...petSpec.states.flatMap((state) => state.frames),
])];

// 构建状态帧映射
for (const state of petSpec.states) {
  assetFrames.set(state.id, state.frames);
}

// 好感度外观：1 档戴小花，2 档戴花+抱小熊；只替换 idle 待机帧
const OUTFIT_FRAMES: Record<number, string[]> = {
  1: [l1_1, l1_2, l1_3, l1_4, l1_5],
  2: [l2_1, l2_2, l2_3, l2_4, l2_5],
  3: [l3_1, l3_2, l3_3, l3_4, l3_5],
  4: [l4_1, l4_2, l4_3, l4_4, l4_5],
};
const FESTIVAL_FRAMES: Record<string, string[]> = {
  halloween: [fhw_1, fhw_2, fhw_3, fhw_4, fhw_5],
  christmas: [fx_1, fx_2, fx_3, fx_4, fx_5],
  newyear: [fny_1, fny_2, fny_3, fny_4, fny_5],
  yuanxiao: [fyf_1, fyf_2, fyf_3, fyf_4, fyf_5],
  midautumn: [fma_1, fma_2, fma_3, fma_4, fma_5],
  spring: [fsp_1, fsp_2, fsp_3, fsp_4, fsp_5],
};
let currentOutfitLevel = 0;
// 换装模式：auto=按日期自动，none=无装饰，其余为节日模式
let outfitMode = 'auto';
function festivalForDate(): string | null {
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if ((m === 10 && d >= 30) || (m === 11 && d === 1)) return 'halloween';
  if (m === 12 && (d === 24 || d === 25)) return 'christmas';
  if (m === 1 && d >= 28) return 'newyear';
  if (m === 2 && d >= 1 && d <= 5) return 'spring';
  if (m === 2 && d >= 10 && d <= 14) return 'yuanxiao';
  if (m === 9 && d >= 27) return 'midautumn';
  if (m === 10 && d >= 1 && d <= 5) return 'midautumn';
  return null;
}
function activeFestival(): string | null {
  if (outfitMode === 'none') return null;
  if (outfitMode !== 'auto') return outfitMode;
  return festivalForDate();
}
// 已解码 URL 缓存：启动时填充 idle/blink，运行时按需补充
const decodedUrls = new Set<string>();
const pendingDecode = new Map<string, Promise<boolean>>();
function ensureDecoded(url: string): Promise<boolean> {
  if (decodedUrls.has(url)) return Promise.resolve(true);
  let pending = pendingDecode.get(url);
  if (!pending) {
    pending = new Promise<boolean>((resolve) => {
      const image = new Image();
      image.onload = () => {
        const ok = image.naturalWidth > 0 && image.naturalHeight > 0;
        if (ok) decodedUrls.add(url);
        resolve(ok);
      };
      image.onerror = () => resolve(false);
      image.src = url;
    });
    pendingDecode.set(url, pending);
  }
  return pending;
}

// 统一换帧入口：帧已解码立即显示；未解码先保持当前画面，解码完成后若状态未变再切
function applyFrame(stateId: string, frame: string): void {
  const url = resolveFrame(stateId, frame);
  if (!url) return;
  if (decodedUrls.has(url)) {
    sprite.src = url;
    return;
  }
  void ensureDecoded(url).then((ok) => {
    if (!ok) return;
    const current = stateMachine.tick(performance.now());
    if (current.stateId === stateId && current.frame === frame) {
      const currentUrl = resolveFrame(current.stateId, current.frame);
      if (currentUrl === url) sprite.src = url;
    }
  });
}

function resolveFrame(stateId: string, frame: string): string | undefined {
  if (stateId === 'idle') {
    const idleFrames = assetFrames.get('idle') ?? [];
    const index = idleFrames.indexOf(frame);
    const fest = activeFestival();
    if (fest && FESTIVAL_FRAMES[fest] && index >= 0 && FESTIVAL_FRAMES[fest][index]) return FESTIVAL_FRAMES[fest][index];
    if (currentOutfitLevel > 0) {
      const outfit = OUTFIT_FRAMES[currentOutfitLevel];
      if (index >= 0 && outfit && outfit[index]) return outfit[index];
    }
  }
  return assetMap.get(frame);
}

const stateMachine = new PetStateMachine(petSpec.states, performance.now());
container.dataset.state = stateMachine.currentStateId();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let blinkTimer: ReturnType<typeof setTimeout> | null = null;
let animationFrame: number | null = null;
let currentAffection = 0;
let currentMood = 80;

// 设置呼吸动画
const breathing = petSpec.motion.breathing;
if (breathing.enabled) {
  document.documentElement.style.setProperty('--breath-period', `${breathing.periodMs}ms`);
  document.documentElement.style.setProperty('--breath-scale-x', `${1 + breathing.scaleX}`);
  document.documentElement.style.setProperty('--breath-scale-y', `${1 + breathing.scaleY}`);
}

// 挤压回弹
function playSquash(): void {
  if (!petSpec.motion.squashStretch.enabled) return;
  const squash = petSpec.motion.squashStretch;
  document.documentElement.style.setProperty('--squash-duration', `${squash.durationMs}ms`);
  document.documentElement.style.setProperty('--squash-intensity', `${squash.intensity}`);
  sprite.classList.remove('squash');
  void sprite.offsetWidth; // 触发重绘
  sprite.classList.add('squash');
}

// 显示反馈气泡：单行展示；按内容长度把字号收缩到窗口能放下的最小值
function showFeedback(text: string): void {
  feedbackBubble.textContent = text;
  const parentWidth = feedbackBubble.parentElement?.clientWidth ?? 176;
  const available = parentWidth * 0.92 - 28;
  const length = Math.max(text.length, 1);
  const fontSize = Math.max(10, Math.min(14, Math.floor(available / length)));
  feedbackBubble.style.fontSize = `${fontSize}px`;
  feedbackBubble.classList.add('show');
  setTimeout(() => {
    feedbackBubble.classList.remove('show');
  }, 2400);
}

// 切换状态
function setState(stateId: string, durationMs?: number): void {
  if (!stateMachine.start(stateId, performance.now(), durationMs)) return;
  const snapshot = stateMachine.tick(performance.now());
  container.dataset.state = snapshot.stateId;
  applyFrame(snapshot.stateId, snapshot.frame);
}

// 动画循环
function animate(timestamp: number): void {
  const snapshot = stateMachine.tick(timestamp);
  container.dataset.state = snapshot.stateId;
  if (snapshot.stateChanged) {
    applyFrame(snapshot.stateId, snapshot.frame);
  }
  animationFrame = requestAnimationFrame(animate);
}

// 调度眨眼（眨眼高频发生，只重排自己的定时器，不能误伤自言自语）
function scheduleIdleEvents(): void {
  if (blinkTimer) clearTimeout(blinkTimer);

  // 随机眨眼
  const blinkDelay = 2000 + Math.random() * 4000;
  blinkTimer = setTimeout(() => {
    if (stateMachine.currentStateId() === 'idle') {
      setState('blink');
    }
    scheduleIdleEvents();
  }, blinkDelay);
}

// 空闲自言自语：独立定时器，只在真正无事发生时到点冒一句。
// 不切动作、不打断眨眼；文案随亲密度变化。
function scheduleSelfTalk(): void {
  if (idleTimer) clearTimeout(idleTimer);
  const idleMin = petSpec.motion.idleIntervalMs.min;
  const idleMax = petSpec.motion.idleIntervalMs.max;
  // 心情影响活跃度：心情差时更沉默，心情好时更爱冒泡
  const moodFactor = currentMood < 30 ? 1.8 : currentMood > 75 ? 0.7 : 1;
  const idleDelay = (idleMin + Math.random() * (idleMax - idleMin)) * moodFactor;
  idleTimer = setTimeout(() => {
    if (stateMachine.currentStateId() === 'idle') {
      if (currentMood < 30 && Math.random() < 0.4) {
        setState('sad', 1800);
        showFeedback(['唉…', '有点闷闷的', '心情不太美丽…'][Math.floor(Math.random() * 3)] ?? '唉…');
      } else {
        const pool = selfTalkPool(currentAffection);
        showFeedback(pool[Math.floor(Math.random() * pool.length)] ?? pool[0] ?? "...");
      }
    }
    scheduleSelfTalk();
  }, idleDelay);
}

// 点击爱心特效：在点击位置飘起随机小图案
const FX_EMOJIS = ['❤️', '💗', '⭐', '✨', '🌸', '💫'];
function spawnFx(clientX: number, clientY: number): void {
  const layer = document.getElementById('fx-layer');
  if (!layer) return;
  const rect = layer.getBoundingClientRect();
  const heart = document.createElement('div');
  heart.className = 'fx-heart';
  heart.textContent = FX_EMOJIS[Math.floor(Math.random() * FX_EMOJIS.length)] ?? '❤️';
  heart.style.left = `${Math.max(6, Math.min(94, ((clientX - rect.left) / rect.width) * 100))}%`;
  heart.style.top = `${Math.max(6, Math.min(94, ((clientY - rect.top) / rect.height) * 100))}%`;
  heart.style.fontSize = `${16 + Math.random() * 10}px`;
  layer.appendChild(heart);
  setTimeout(() => heart.remove(), 1200);
}

// 点击部位：按角色图片纵向位置区分 头 / 身体 / 脚
function hitPart(event: MouseEvent): 'head' | 'body' | 'feet' {
  const rect = sprite.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return 'body';
  const ratio = (event.clientY - rect.top) / rect.height;
  if (ratio < 0.32) return 'head';
  if (ratio > 0.74) return 'feet';
  return 'body';
}

const HEAD_REPLIES = ['嘿嘿，摸到头顶啦~', '头顶软软的，好舒服', '再摸摸嘛~'];
const BODY_REPLIES = ['嘻嘻，别挠啦～', '好痒呀，哈哈哈', '嘿嘿，那里不行啦'];
const FEET_REPLIES = ['呀！', '吓我一跳～', '哎呀，踩到我啦'];

// 点击事件
container.addEventListener('click', (event) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  playSquash();
  playPop();
  const part = hitPart(event);
  if (part === 'head') {
    setState('pet-head', 1500);
    showFeedback(HEAD_REPLIES[Math.floor(Math.random() * HEAD_REPLIES.length)] ?? '嘿嘿~');
  } else if (part === 'feet') {
    setState('surprise', 1500);
    showFeedback(FEET_REPLIES[Math.floor(Math.random() * FEET_REPLIES.length)] ?? '呀！');
  } else {
    setState('cute', 1500);
    showFeedback(BODY_REPLIES[Math.floor(Math.random() * BODY_REPLIES.length)] ?? '嘻嘻~');
  }
  spawnFx(event.clientX, event.clientY);
  scheduleIdleEvents();
});

// 拖拽
let isDragging = false;
let pointerStart = { x: 0, y: 0 };
let activePointerId: number | undefined;
let dragUpdatePending = false;
let suppressNextClick = false;
let dragBegin: Promise<void> | undefined;

container.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || activePointerId !== undefined) return;
  activePointerId = event.pointerId;
  pointerStart = { x: event.clientX, y: event.clientY };
  container.setPointerCapture(event.pointerId);
});

container.addEventListener('pointermove', (event) => {
  if (event.pointerId !== activePointerId) return;
  if (!isDragging && exceedsDragThreshold(pointerStart, { x: event.clientX, y: event.clientY })) {
    isDragging = true;
    shadowEl?.classList.add('dragging');
    dragBegin = window.petAPI?.window.beginDrag() ?? Promise.resolve();
  }
  if (!isDragging) return;
  if (dragUpdatePending) return;
  dragUpdatePending = true;
  requestAnimationFrame(() => {
    void (dragBegin ?? Promise.resolve())
      .then(() => window.petAPI?.window.updateDrag())
      .catch(() => {})
      .finally(() => { dragUpdatePending = false; });
  });
});

function finishPointer(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;
  if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
  activePointerId = undefined;
  const dragged = isDragging;
  isDragging = false;
  dragUpdatePending = false;
  shadowEl?.classList.remove('dragging');
  if (dragged) {
    suppressNextClick = true;
    void (dragBegin ?? Promise.resolve())
      .then(() => window.petAPI?.window.endDrag())
      .catch(() => {});
  }
  dragBegin = undefined;
}

container.addEventListener('pointerup', finishPointer);
container.addEventListener('pointercancel', finishPointer);

// 右键菜单
container.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI?.window.showContextMenu().catch(() => {});
});

// 监听状态活动
window.petAPI?.events.onStateActivity((activity: StateActivity) => {
  if (activity.stateId && stateMachine.hasState(activity.stateId)) {
    playInteraction(activity.stateId);
    setState(activity.stateId, activity.durationMs);
    scheduleIdleEvents();
  }
  if (activity.kind === 'outfit' && activity.outfitMode) {
    outfitMode = activity.outfitMode;
    if (stateMachine.currentStateId() === 'idle') {
      const snapshot = stateMachine.tick(performance.now());
      applyFrame(snapshot.stateId, snapshot.frame);
    }
  }
  if (activity.kind === 'sound' && typeof activity.soundEnabled === 'boolean') {
    setSoundEnabled(activity.soundEnabled);
  }
  if (activity.feedback) {
    // 高亲密度时，把互动气泡换成更亲昵的句子
    const warm = activity.kind === 'interaction' ? maybeWarmReply(activity.stateId, currentAffection) : null;
    showFeedback(warm ?? activity.feedback);
  }
});

// 好感度变化：更新文案副本，升档时换外观并冒气泡
window.petAPI?.events.onStats((stats) => {
  currentAffection = stats.affection;
  currentMood = stats.mood;
  const level = affectionLevel(currentAffection);
  if (level !== currentOutfitLevel) {
    const upgraded = level > currentOutfitLevel;
    currentOutfitLevel = level;
    if (upgraded && level === 1) showFeedback('哇，我戴上了一朵小花！');
    else if (upgraded && level === 2) showFeedback('嘿嘿，有小熊陪我啦~');
    // 正在待机时立即换装
    if (stateMachine.currentStateId() === 'idle') {
      const snapshot = stateMachine.tick(performance.now());
      applyFrame(snapshot.stateId, snapshot.frame);
    }
  }
});

// 初始化
async function init(): Promise<void> {
  try {
    // 启动只预加载 idle/blink（+ 独立母版）；其余状态帧首次进入时由 applyFrame 按需解码。
    const loadedAssets = await Promise.all(bootAssetNames.map((name) => new Promise<HTMLImageElement>((resolve, reject) => {
      const url = assetMap.get(name);
      if (!url) {
        reject(new Error(`Missing runtime asset: ${name}`));
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) reject(new Error(`Runtime asset has invalid dimensions: ${name}`));
        else {
          decodedUrls.add(url);
          resolve(image);
        }
      };
      image.onerror = () => reject(new Error(`Runtime asset failed to decode: ${name}`));
      image.src = url;
    })));
    const reference = loadedAssets[0];
    if (!reference) throw new Error('No runtime assets were loaded');
    const invalidSize = loadedAssets.find((image) => image.naturalWidth !== reference.naturalWidth || image.naturalHeight !== reference.naturalHeight);
    if (invalidSize) throw new Error('Runtime assets do not share one decoded frame size');

    // 拉一次当前好感度，决定初始自言自语气泡的亲昵程度
    try {
      const current = await window.petAPI?.interactions.stats();
      if (current) {
        currentAffection = current.affection;
        currentOutfitLevel = affectionLevel(currentAffection);
      }
    } catch { /* 用默认 0 */ }

    // 读取音效开关
    try {
      const currentSettings = await window.petAPI?.settings.get();
      if (currentSettings) {
        setSoundEnabled(currentSettings.soundEnabled !== false);
      }
    } catch { /* 保持默认 */ }

    // 素材确认可用后再启动 idle 和动画循环。
    setState('idle');
    scheduleIdleEvents();
    scheduleSelfTalk();
    animationFrame = requestAnimationFrame(animate);

    // 报告就绪
    await window.petAPI?.runtime.ready({
      status: 'ready',
      stateId: 'idle',
      frame: petSpec.states.find((s) => s.id === 'idle')?.frames[0] ?? '',
      assetCount: loadedAssets.length,
      expectedAssetCount: bootAssetNames.length,
      naturalWidth: reference.naturalWidth,
      naturalHeight: reference.naturalHeight,
      petVisible: true,
      ipcReady: true,
    });
  } catch (error) {
    window.petAPI?.runtime.fail({
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  }
}

init();
