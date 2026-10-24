import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import specData from '../pet-spec.json';
import type { InteractionResult, InteractionSpec, PetSpec, PetStats, Reminder, RuntimeFailureReport, RuntimeReadyReport, Settings, StateActivity, TypingStatus, WeeklyReview } from './shared/contracts';
import { assertInteractionId, assertReminderInput, assertRuntimeFailureReport, assertRuntimeReadyReport, assertSettingsPatch, assertStringArray } from './shared/contracts';
import { draggedBounds, snapBounds, type Point, type Rect } from './main/drag';
import { JsonLogger } from './main/logger';
import { atomicWriteJson, uniqueDestination } from './main/persistence';
import { TypingListener } from './main/typing-listener';
import { localDateKey, nextReminderDelay, parsePersistedStats, parseReminders, parseSettings, type PersistedStats } from './main/data-validation';
import { createDiaryStore } from './main/diary';
import { LOW_MOOD_REPLIES } from './shared/relationship';
import {
  evaluateAchievements,
  evaluateNewlyUnlocked,
  loadAchievements,
  recordInteraction,
  saveAchievements,
  touchStreak,
  type AchievementState,
} from './main/achievements';
import { readValidatedJson } from './main/persistence';
import trayIconPath from './assets/tray/tray-icon.png';

const spec = specData as PetSpec;
type Role = 'pet' | 'reminder' | 'dashboard';
let petWindow: BrowserWindow | undefined;
let reminderWindow: BrowserWindow | undefined;
let dashboardWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let logger: JsonLogger | undefined;
let settings: Settings;
let reminders: Reminder[] = [];
let stats: PersistedStats;
let sessionStartedAt = Date.now();
let achievementsState: AchievementState = { interactionCounts: {}, firstSeen: '', lastSeen: '', streakDays: 0, notifiedIds: [] };
const diary = createDiaryStore();
let tomato: { endAt: number; remainingMs: number; paused: boolean } | null = null;
let walkTimer: ReturnType<typeof setInterval> | null = null;
let walkDir = 1;
let walkUntil = 0;
let typingStatus: TypingStatus = { enabled: false, reason: 'not-started' };
let isQuitting = false;
let dragSession: { bounds: Rect; cursor: Point } | undefined;
let runtimeRendererReport: RuntimeReadyReport | undefined;
const runtimeReadyRenderers = new Set<Role>();
let runtimeWindowReady = false;
let runtimeCommitted = false;
let fatalExitStarted = false;
let quitPersisting = false;
const roles = new Map<number, Role>();
const reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
const typingListener = new TypingListener();
// 启动资源存在性校验：全量素材都必须有 QA 记录
const allRuntimeAssets = new Set([spec.character.coreAsset, ...spec.states.flatMap((state) => state.frames)]);
// 运行时就绪校验：renderer 只常驻预加载 idle/blink（+ 独立母版），其余状态帧按需懒加载
const bootRuntimeAssets = new Set([
  spec.character.coreAsset,
  ...spec.states.filter((state) => state.id === 'idle' || state.id === 'blink').flatMap((state) => state.frames),
]);
const runtimeReadyFile = path.join(process.cwd(), '.build', 'runtime-ready.json');
const runtimeFailureFile = path.join(process.cwd(), '.build', 'runtime-failed.json');
const runtimeEvidenceEnabled = !app.isPackaged || process.env.PET_PREVIEW_MODE === '1';
const e2eMode = process.env.PET_E2E === '1';

if (process.env.PET_E2E_USER_DATA) app.setPath('userData', path.resolve(process.env.PET_E2E_USER_DATA));

const defaultSettings: Settings = {
  edgeSnap: spec.features.edgeSnap,
  alwaysOnTop: true,
  typingReaction: spec.features.typingReaction,
  clickThrough: false,
  petScale: spec.experience.petSizing.defaultScale,
  soundEnabled: true,
  codingCompanion: true,
};

const defaultStats: PersistedStats = {
  affection: 0,
  mood: 80,
  todayInteractions: 0,
  totalCompanionMs: 0,
  lastInteractionDate: localDateKey(),
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (process.env.PET_E2E === '1') {
  (globalThis as typeof globalThis & {
    __PET_E2E__?: {
      snapshot: () => {
        tray: boolean;
        roles: Array<{ role: Role; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      };
      quit: () => void;
    };
  }).__PET_E2E__ = {
    snapshot: () => ({
      tray: Boolean(tray && !tray.isDestroyed()),
      roles: [petWindow, reminderWindow, dashboardWindow].map((window, index) => ({
        role: (['pet', 'reminder', 'dashboard'] as const)[index]!,
        visible: Boolean(window?.isVisible()),
        destroyed: Boolean(window?.isDestroyed()),
      })),
      quitting: isQuitting,
    }),
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  };
}

function userFile(name: string): string { return path.join(app.getPath('userData'), name); }
function filePocket(): string { return path.join(app.getPath('documents'), spec.app.name); }
function stateForTrigger(trigger: string) { return spec.states.find((state) => state.triggers.includes(trigger)); }

async function verifySourceAssetGate(): Promise<void> {
  if (app.isPackaged) return;
  const reportPath = path.join(process.cwd(), 'qa', 'assets-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
    passed?: boolean;
    scope?: string;
    assets?: Array<{ frame?: string; ok?: boolean; fileSha256?: string }>;
  };
  if (report.passed !== true || (report.scope ?? 'all') !== 'all') {
    throw new Error('Source preview requires a complete passing qa/assets-report.json');
  }
  const records = new Map((report.assets ?? []).map((record) => [record.frame, record]));
  for (const relative of allRuntimeAssets) {
    const record = records.get(relative);
    if (!record?.ok || !record.fileSha256) throw new Error(`Source preview has no passing QA record for ${relative}`);
    const bytes = await readFile(path.join(process.cwd(), 'src', 'assets', 'pet', relative));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== record.fileSha256) throw new Error(`Source preview asset changed after QA: ${relative}`);
  }
}

async function writeRuntimeFile(file: string, value: unknown): Promise<void> {
  if (runtimeEvidenceEnabled) await atomicWriteJson(file, value);
}

async function commitRuntimeReady(): Promise<void> {
  if (
    runtimeCommitted
    || !runtimeWindowReady
    || !runtimeRendererReport
    || runtimeReadyRenderers.size !== 3
    || !petWindow
    || petWindow.isDestroyed()
  ) return;
  const report = {
    ...runtimeRendererReport,
    status: 'ready',
    expectedAssetCount: bootRuntimeAssets.size,
    windowCount: BrowserWindow.getAllWindows().length,
    petVisible: petWindow.isVisible(),
    ipcReady: true,
    renderers: {
      pet: runtimeReadyRenderers.has('pet'),
      dashboard: runtimeReadyRenderers.has('dashboard'),
      reminder: runtimeReadyRenderers.has('reminder'),
    },
    appName: spec.app.name,
    version: spec.app.version,
    timestamp: new Date().toISOString(),
  };
  if (report.windowCount !== 3 || !report.petVisible) throw new Error(`Runtime window gate failed: windows=${report.windowCount}, visible=${report.petVisible}`);
  await logger?.write('info', 'runtime-ready', report);
  await writeRuntimeFile(runtimeReadyFile, report);
  runtimeCommitted = true;
}

async function fatalExit(event: string, error: unknown, details: Record<string, unknown> = {}): Promise<void> {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  const message = error instanceof Error ? error.message : String(error);
  const report = { status: 'failed', event, message, ...details, timestamp: new Date().toISOString() };
  console.error(event, error);
  try { await writeRuntimeFile(runtimeFailureFile, report); }
  catch (fileError) { console.error('runtime-failure-file-write-failed', fileError); }
  try { await logger?.write('error', event, { message, ...details }); }
  catch (logError) { console.error('structured-log-write-failed', logError); }
  app.exit(1);
}

function assertSender(event: IpcMainInvokeEvent, allowed: Role[]): Role {
  const role = roles.get(event.sender.id);
  if (!role || !allowed.includes(role) || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized IPC sender');
  return role;
}

function registerWindow(window: BrowserWindow, role: Role): BrowserWindow {
  const webContentsId = window.webContents.id;
  roles.set(webContentsId, role);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('did-fail-load', (_event, code, description) => {
    void fatalExit(`${role}-window-load-failed`, new Error(description), { code, role });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') {
      void logger?.write('warn', `${role}-renderer-stopped`, { role, reason: details.reason, exitCode: details.exitCode });
      return;
    }
    if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
      void fatalExit(`${role}-renderer-gone`, new Error(details.reason), { role, exitCode: details.exitCode });
      return;
    }
    void logger?.write('warn', `${role}-renderer-gone`, { role, reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('console-message', (details, level, legacyMessage) => {
    const message = details.message || legacyMessage;
    const currentLevel = details.level === 'error' ? 3 : level;
    const fatalMessage = /Content Security Policy|unsafe-eval|Refused to evaluate|Uncaught|Unhandled/i.test(message);
    if (fatalMessage || (!runtimeCommitted && currentLevel >= 3)) {
      void fatalExit(`${role}-renderer-console-error`, new Error(message), { role });
    } else if (currentLevel >= 3) {
      void logger?.write('error', `${role}-renderer-console-error`, { role, message: message.slice(0, 2000) });
    }
  });
  window.on('closed', () => roles.delete(webContentsId));
  return window;
}

function secureWindow(options: Electron.BrowserWindowConstructorOptions, role: Role, preload: string): BrowserWindow {
  return registerWindow(new BrowserWindow({
    ...options,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  }), role);
}

function petSize(): number { return Math.round(spec.experience.petSizing.baseWindowPx * settings.petScale); }

function applyPetSettings(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const size = petSize();
  petWindow.setSize(size, size, true);
  petWindow.setAlwaysOnTop(settings.alwaysOnTop);
  petWindow.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
}

function positionAbovePet(window: BrowserWindow): void {
  if (!petWindow) return;
  const petBounds = petWindow.getBounds();
  const target = window.getBounds();
  const workArea = screen.getDisplayMatching(petBounds).workArea;
  const x = Math.min(workArea.x + workArea.width - target.width, Math.max(workArea.x, petBounds.x + Math.round((petBounds.width - target.width) / 2)));
  const preferredY = petBounds.y - target.height - 12;
  const y = preferredY >= workArea.y ? preferredY : Math.min(workArea.y + workArea.height - target.height, petBounds.y + petBounds.height + 12);
  window.setPosition(x, y, false);
}

function createWindows(): void {
  const size = petSize();
  petWindow = secureWindow({
    width: size,
    height: size,
    transparent: true,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    opacity: e2eMode ? 0 : 1,
  }, 'pet', PET_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void petWindow.loadURL(PET_WINDOW_WEBPACK_ENTRY);
  petWindow.once('ready-to-show', () => {
    applyPetSettings();
    petWindow?.center();
    if (e2eMode) petWindow?.showInactive();
    else petWindow?.show();
    runtimeWindowReady = Boolean(petWindow?.isVisible());
    void commitRuntimeReady().catch((error) => fatalExit('runtime-ready-failed', error));
  });
  reminderWindow = secureWindow({
    width: 390,
    height: 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    opacity: e2eMode ? 0 : 1,
  }, 'reminder', REMINDER_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void reminderWindow.loadURL(REMINDER_WINDOW_WEBPACK_ENTRY);
  reminderWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); reminderWindow?.hide(); }
  });

  dashboardWindow = secureWindow({
    width: 520,
    height: 700,
    minWidth: 480,
    minHeight: 620,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: true,
    hasShadow: true,
    title: `${spec.character.displayName}的小屋`,
    opacity: e2eMode ? 0 : 1,
  }, 'dashboard', DASHBOARD_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void dashboardWindow.loadURL(DASHBOARD_WINDOW_WEBPACK_ENTRY);
  dashboardWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); dashboardWindow?.hide(); }
  });
}

function publicStats(): PetStats {
  const liveMs = stats.totalCompanionMs + Math.max(0, Date.now() - sessionStartedAt);
  return {
    affection: stats.affection,
    mood: stats.mood,
    todayInteractions: stats.todayInteractions,
    companionMinutes: Math.floor(liveMs / 60_000),
    lastInteractionDate: stats.lastInteractionDate,
    achievements: evaluateAchievements({
      affection: stats.affection,
      mood: stats.mood,
      todayInteractions: stats.todayInteractions,
      companionMinutes: Math.floor(liveMs / 60_000),
      lastInteractionDate: stats.lastInteractionDate,
      achievements: [],
    }, achievementsState),
  };
}

function normalizeStatsDay(): void {
  const today = localDateKey();
  if (stats.lastInteractionDate !== today) {
    stats.todayInteractions = 0;
    stats.lastInteractionDate = today;
  }
}

async function persistStats(): Promise<void> {
  stats.totalCompanionMs += Math.max(0, Date.now() - sessionStartedAt);
  sessionStartedAt = Date.now();
  await atomicWriteJson(userFile('pet-stats.json'), stats);
}

function broadcastStats(): void {
  const value = publicStats();
  for (const window of [petWindow, reminderWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('pet:stats', value);
  }
}

function sendActivity(activity: StateActivity): void {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('state:activity', activity);
}

function activityForTrigger(trigger: string, kind: string, feedback?: string, durationMs?: number): StateActivity {
  const state = stateForTrigger(trigger);
  return { kind, stateId: state?.id, durationMs, feedback };
}

async function triggerInteraction(id: string): Promise<InteractionResult> {
  if (gameActive) registerGameHit();
  const interaction = allInteractions().find((item) => item.id === id);
  if (!interaction || !spec.features.interactions) throw new Error(`Unknown or disabled interaction: ${id}`);
  normalizeStatsDay();
  const firstToday = stats.todayInteractions === 0;
  // 每日签到加成：当天第一次互动额外 +2 好感度
  stats.affection = Math.min(300, stats.affection + interaction.affectionGain + (firstToday ? 2 : 0));
  stats.mood = Math.min(100, stats.mood + Math.max(1, Math.ceil(interaction.affectionGain / 2)));
  stats.todayInteractions += 1;
  recordInteraction(achievementsState, interaction.id);
  // 成就新解锁检测（标记已庆祝，避免重复弹）
  const newly = evaluateNewlyUnlocked(publicStats(), achievementsState);
  await saveAchievements(achievementsState);
  const rawFeedback = interaction.feedback[Math.floor(Math.random() * interaction.feedback.length)] ?? interaction.label;
  // 心情低落时回应更平淡
  const feedback = stats.mood < 30 ? (LOW_MOOD_REPLIES[Math.floor(Math.random() * LOW_MOOD_REPLIES.length)] ?? rawFeedback) : rawFeedback;
  diary.touchInteraction(localDateKey(), interaction.id, interaction.affectionGain + (firstToday ? 2 : 0), newly.map((item) => item.name), stats.mood);
  await persistStats();
  const result: InteractionResult = { interaction, feedback, stats: publicStats() };
  const firstNew = newly[0];
  if (firstNew) {
    sendActivity({ kind: 'celebration', stateId: interaction.stateId, durationMs: interaction.durationMs, feedback: `🎉 解锁徽章：${firstNew.emoji} ${firstNew.name}` });
  } else if (firstToday) {
    sendActivity({ kind: 'checkin', feedback: '今天也来啦！' });
  } else {
    sendActivity({ kind: 'interaction', stateId: interaction.stateId, durationMs: interaction.durationMs, feedback });
  }
  broadcastStats();
  return result;
}

// ===== 自定义互动配置 =====
// 用户可在 userData/custom-interactions.json 里追加自己的互动条目，
// stateId 必须是 pet-spec.json 里的状态 id，或写 "bubble-only" 只冒气泡无动作。
let customInteractions: InteractionSpec[] = [];
function loadCustomInteractions(): InteractionSpec[] {
  const file = path.join(app.getPath('userData'), 'custom-interactions.json');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf-8')); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const validStateIds = new Set(['bubble-only', ...spec.states.map((st) => st.id)]);
  const seen = new Set(spec.experience.interactions.map((item) => item.id));
  const slug = (text: string): string => {
    const base = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
    const fallback = base || `custom-${Math.random().toString(36).slice(2, 7)}`;
    return fallback;
  };
  const result: InteractionSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 24) : '';
    const emoji = typeof entry.emoji === 'string' ? entry.emoji.slice(0, 8) : '✨';
    const stateId = typeof entry.stateId === 'string' ? entry.stateId : '';
    const feedback = Array.isArray(entry.feedback)
      ? entry.feedback.filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 40).slice(0, 6)
      : [];
    const durationMs = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
      ? Math.min(10000, Math.max(300, Math.round(entry.durationMs))) : 1600;
    const affectionGain = typeof entry.affectionGain === 'number' && Number.isFinite(entry.affectionGain)
      ? Math.min(20, Math.max(0, Math.round(entry.affectionGain))) : 1;
    if (!label || !stateId || !validStateIds.has(stateId) || feedback.length < 2) {
      void logger?.write('warn', 'custom-interaction-skipped', { label });
      continue;
    }
    let id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') : '';
    if (!id || id.length > 40 || seen.has(id)) {
      id = slug(label);
      let n = 2;
      while (seen.has(id)) id = `${slug(label)}-${n++}`;
    }
    seen.add(id);
    result.push({ id, emoji, label, stateId, durationMs, affectionGain, feedback });
  }
  return result;
}
function allInteractions(): InteractionSpec[] {
  return [...spec.experience.interactions, ...customInteractions];
}

function persistCustomInteractions(items: InteractionSpec[]): void {
  const file = path.join(app.getPath('userData'), 'custom-interactions.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
  renameSync(tmp, file);
  customInteractions = items;
}

function slugForLabel(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = base || `custom-${Math.random().toString(36).slice(2, 7)}`;
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

function validateCustomInput(input: unknown): { ok: true; value: InteractionSpec } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '输入格式错误' };
  const entry = input as Record<string, unknown>;
  const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 24) : '';
  const emoji = typeof entry.emoji === 'string' && entry.emoji.trim() ? entry.emoji.trim().slice(0, 8) : '✨';
  const stateId = typeof entry.stateId === 'string' ? entry.stateId.trim() : '';
  const feedbackRaw = Array.isArray(entry.feedback) ? entry.feedback : [];
  const feedback = feedbackRaw
    .filter((f): f is string => typeof f === 'string' && f.trim().length > 0 && f.trim().length <= 40)
    .map((f) => f.trim())
    .slice(0, 6);
  const durationMs = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
    ? Math.min(10000, Math.max(300, Math.round(entry.durationMs)))
    : 1600;
  const affectionGain = typeof entry.affectionGain === 'number' && Number.isFinite(entry.affectionGain)
    ? Math.min(20, Math.max(0, Math.round(entry.affectionGain)))
    : 1;
  if (!label) return { ok: false, error: '名称不能为空' };
  const validStateIds = new Set(['bubble-only', ...spec.states.map((st) => st.id)]);
  if (!validStateIds.has(stateId)) return { ok: false, error: 'stateId 必须是现有动作状态或 bubble-only' };
  if (feedback.length < 2) return { ok: false, error: '至少需要 2 条气泡文案' };
  const taken = new Set(allInteractions().map((item) => item.id));
  const id = slugForLabel(label, taken);
  return { ok: true, value: { id, emoji, label, stateId, durationMs, affectionGain, feedback } };
}

// ===== 全局快捷键 =====
const OUTFIT_CYCLE = ['auto', 'halloween', 'christmas', 'newyear', 'spring', 'yuanxiao', 'midautumn', 'none'];
let outfitCycleIndex = 0;
function registerGlobalShortcuts(): void {
  // ⌘/Ctrl+Shift+P：显示/隐藏桌宠
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (petWindow.isVisible()) petWindow.hide();
    else petWindow.show();
  });
  // ⌘/Ctrl+Shift+1：随机互动
  globalShortcut.register('CommandOrControl+Shift+1', () => {
    const interactions = allInteractions();
    if (interactions.length === 0) return;
    const pick = interactions[Math.floor(Math.random() * interactions.length)];
    if (pick) void triggerInteraction(pick.id);
  });
  // ⌘/Ctrl+Shift+2：换装轮换
  globalShortcut.register('CommandOrControl+Shift+2', () => {
    const mode = OUTFIT_CYCLE[outfitCycleIndex % OUTFIT_CYCLE.length];
    outfitCycleIndex += 1;
    if (!mode) return;
    const labels: Record<string, string> = {
      auto: '换好啦，随好感度变化~', halloween: '不给糖就捣蛋！', christmas: '圣诞快乐呀~',
      newyear: '新年红红火火！', spring: '新春大吉呀~', yuanxiao: '汤圆甜甜的~',
      midautumn: '月亮好圆呀', none: '简单一点也很好',
    };
    sendActivity({ kind: 'outfit', outfitMode: mode, feedback: labels[mode] ?? '换好啦' });
  });
}

function showReminderComposer(): void {
  if (!spec.features.reminders || !reminderWindow) return;
  positionAbovePet(reminderWindow);
  if (e2eMode) reminderWindow.showInactive();
  else {
    reminderWindow.show();
    reminderWindow.focus();
  }
  reminderWindow.webContents.send('reminder:compose');
}

function quickReminder(text: string, minutes: number): void {
  if (!spec.features.reminders) return;
  const reminder: Reminder = {
    id: randomUUID(),
    text,
    dueAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  reminders.push(reminder);
  void persistReminders();
  scheduleReminder(reminder);
  sendActivity({ kind: 'feedback', feedback: `好嘞，${minutes} 分钟后提醒你「${text}」` });
}

const TOMATO_MINUTES = 25;
function startTomato(minutes: number = TOMATO_MINUTES): void {
  tomato = { endAt: Date.now() + minutes * 60_000, remainingMs: minutes * 60_000, paused: false };
  sendActivity({ kind: 'feedback', feedback: `🍅 专注 ${minutes} 分钟` });
  setTimeout(() => {
    if (!tomato || tomato.paused || Date.now() < tomato.endAt) return;
    tomato = null;
    diary.touchTomato(localDateKey());
    sendActivity({ kind: 'celebration', stateId: 'dance', durationMs: 2600, feedback: '🍅 番茄钟到啦，起来休息~' });
    createTrayMenuRefresh();
  }, minutes * 60_000 + 500);
}
function pauseTomato(): void {
  if (!tomato || tomato.paused) return;
  tomato.remainingMs = Math.max(0, tomato.endAt - Date.now());
  tomato.paused = true;
  sendActivity({ kind: 'feedback', feedback: '🍅 已暂停，休息一下再继续' });
}
function resumeTomato(): void {
  if (!tomato || !tomato.paused) return;
  tomato.endAt = Date.now() + tomato.remainingMs;
  tomato.paused = false;
  sendActivity({ kind: 'feedback', feedback: '🍅 继续专注吧' });
}
function cancelTomato(): void {
  tomato = null;
  sendActivity({ kind: 'feedback', feedback: '🍅 番茄钟已取消' });
}
function tomatoRemainingMinutes(): number {
  if (!tomato) return 0;
  const ms = tomato.paused ? tomato.remainingMs : Math.max(0, tomato.endAt - Date.now());
  return Math.ceil(ms / 60_000);
}

// ===== 自动散步 =====
function startWalking(): void {
  if (!petWindow || walkTimer) return;
  const bounds = petWindow.getBounds();
  walkDir = bounds.x + bounds.width / 2 <= screen.getPrimaryDisplay().workArea.x + screen.getPrimaryDisplay().workArea.width / 2 ? 1 : -1;
  walkUntil = Date.now() + 30_000;
  walkTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) { stopWalking(); return; }
    if (Date.now() >= walkUntil) { stopWalking(); return; }
    const current = petWindow.getBounds();
    const workArea = screen.getDisplayMatching(current).workArea;
    const step = 6;
    let nextX = current.x + walkDir * step;
    const minX = workArea.x;
    const maxX = workArea.x + workArea.width - current.width;
    if (nextX <= minX || nextX >= maxX) {
      walkDir *= -1;
      nextX = Math.min(maxX, Math.max(minX, nextX));
    }
    petWindow.setBounds({ x: nextX, y: current.y, width: current.width, height: current.height }, false);
    sendActivity({ kind: 'walk', stateId: walkDir < 0 ? 'walk-left' : 'walk-right', durationMs: 900 });
  }, 60);
  sendActivity({ kind: 'feedback', feedback: '🏃 溜达一会儿~' });
}
function stopWalking(): void {
  if (walkTimer) { clearInterval(walkTimer); walkTimer = null; }
  sendActivity({ kind: 'manual', stateId: 'idle' });
}

async function toggleSound(): Promise<void> {
  const next = !settings.soundEnabled;
  settings.soundEnabled = next;
  await saveSettings(settings);
  sendActivity({ kind: 'sound', soundEnabled: next, feedback: next ? '🔊 声音开啦' : '🔇 已静音' });
}

// ===== 天气感知 =====
let lastWeatherKey = '';
function weatherLine(code: number, temp: number): string | null {
  if (code >= 61 && code <= 67) return '下雨天，记得带伞哦~';
  if (code >= 71 && code <= 77) return '下雪啦，好想出去玩';
  if (temp >= 30) return '好热呀，想吃冰激凌';
  if (temp <= 10) return '好冷，注意保暖别感冒';
  if (code <= 2) return '今天阳光正好，心情也亮亮的';
  return '云朵软绵绵的，想打盹';
}
async function refreshWeather(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=22.54&longitude=114.06&current_weather=true',
      { signal: controller.signal },
    );
    clearTimeout(timer);
    const data = await res.json() as { current_weather?: { weathercode?: number; temperature?: number } };
    const code = data?.current_weather?.weathercode ?? 0;
    const temp = data?.current_weather?.temperature ?? 0;
    const key = `${code}-${Math.round(temp)}`;
    if (key === lastWeatherKey) return;
    lastWeatherKey = key;
    const line = weatherLine(code, temp);
    if (!line) return;
    // 延迟 15-35 秒再冒泡，像她自然观察到天气，而不是启动就弹
    setTimeout(() => {
      if (code >= 61 && code <= 67) sendActivity({ kind: 'weather', stateId: 'sleepy', durationMs: 2600, feedback: line });
      else sendActivity({ kind: 'feedback', feedback: line });
    }, 15_000 + Math.random() * 20_000);
  } catch { /* 网络不可用时静默降级，不影响其他功能 */ }
}

function showDashboard(): void {
  if (!spec.features.dashboard || !dashboardWindow) return;
  dashboardWindow.center();
  if (e2eMode) dashboardWindow.showInactive();
  else {
    dashboardWindow.show();
    dashboardWindow.focus();
  }
  broadcastStats();
}

// ===== 陪写代码模式 =====
const CODING_APP_NAMES = new Set([
  'cursor', 'code', 'visual studio code', 'claude', 'qoder', 'qoder cn ide',
  'webstorm', 'intellij idea', 'sublime text', 'atom', 'neovide', 'vim', 'emacs',
  'fleet', 'nova', 'brackets',
]);
let codingActive = false;
let codingStreak = 0;
let codingIdleNoticeAt = 0;

function getFrontmostAppName(): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') { resolve(''); return; }
    const child = spawn('osascript', ['-e', 'tell application "System Events" to name of first process whose frontmost is true']);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim().toLowerCase()));
    setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } resolve(''); }, 2000);
  });
}

function enterCodingMode(): void {
  if (codingActive) return;
  codingActive = true;
  sendActivity({ kind: 'manual', stateId: 'sit' });
  setTimeout(() => sendActivity({ kind: 'feedback', feedback: '💻 我陪你写代码~' }), 600);
}

function exitCodingMode(): void {
  if (!codingActive) return;
  codingActive = false;
  sendActivity({ kind: 'manual', stateId: 'idle' });
  sendActivity({ kind: 'feedback', feedback: '写完啦，伸个懒腰~' });
}

function startCodingCompanion(): void {
  // 纯手动模式：不检测前台 App（不需要辅助功能权限）
  // 用户右键开关控制进入/退出；25 分钟无键盘活动时戳一下
  setInterval(() => {
    if (!settings.codingCompanion || !codingActive || isQuitting) return;
    const lastTyping = typingListener.getLastTypingAt();
    const idleMs = lastTyping > 0 ? Date.now() - lastTyping : Infinity;
    if (idleMs > 25 * 60_000 && Date.now() - codingIdleNoticeAt > 10 * 60_000) {
      codingIdleNoticeAt = Date.now();
      sendActivity({ kind: 'manual', stateId: 'surprise', durationMs: 1500, feedback: '在想什么呀？卡住了吗？' });
    }
  }, 60_000);
}

// ===== 周末回顾 =====
function startOfWeek(d: Date): Date {
  const day = (d.getDay() + 6) % 7; // 周一=0
  const monday = new Date(d);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(d.getDate() - day);
  return monday;
}

function buildWeeklyReview(): WeeklyReview {
  const monday = startOfWeek(new Date());
  const weekKey = localDateKey(monday);
  const entries = diary.list().filter((e) => e.date >= weekKey);
  let totalInteractions = 0;
  let totalTomato = 0;
  let affectionGained = 0;
  const achievements = new Set<string>();
  const interactionTotals: Record<string, number> = {};
  for (const e of entries) {
    totalInteractions += Object.values(e.interactions).reduce((a, b) => a + b, 0);
    totalTomato += e.tomatoCompleted;
    affectionGained += e.affectionGained;
    e.achievementsUnlocked.forEach((a) => achievements.add(a));
    for (const [k, v] of Object.entries(e.interactions)) interactionTotals[k] = (interactionTotals[k] ?? 0) + v;
  }
  const topId = Object.entries(interactionTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const topLabel = allInteractions().find((i) => i.id === topId)?.label ?? '陪伴';
  return {
    weekStart: weekKey,
    activeDays: entries.length,
    totalInteractions,
    totalTomato,
    affectionGained,
    newAchievements: [...achievements],
    topInteractionLabel: topLabel,
    petScale: settings.petScale,
  };
}

function showWeeklyReview(): void {
  if (!reminderWindow) return;
  const review = buildWeeklyReview();
  positionAbovePet(reminderWindow);
  if (e2eMode) reminderWindow.showInactive();
  else {
    reminderWindow.show();
    reminderWindow.focus();
  }
  reminderWindow.webContents.send('review:data', review);
}

let lastAutoReviewWeek = '';
function maybeAutoWeeklyReview(): void {
  const now = new Date();
  // 周日 20:00-23:59 之间自动弹一次
  const isSunday = now.getDay() === 0;
  const hour = now.getHours();
  if (!isSunday || hour < 20) return;
  const weekKey = localDateKey(startOfWeek(now));
  if (lastAutoReviewWeek === weekKey) return;
  lastAutoReviewWeek = weekKey;
  const review = buildWeeklyReview();
  if (review.activeDays === 0) return; // 这周没互动就不弹
  setTimeout(() => {
    sendActivity({ kind: 'feedback', feedback: '📊 这周过得怎么样，来看看回顾吧~' });
    setTimeout(showWeeklyReview, 1200);
  }, 5000);
}

// ===== 纪念日 / 节日 =====
// 农历六月十五（用户生日）公历对照
const LUNARY_BIRTHDAY_MAP: Record<number, string> = {
  2025: '2025-07-09',
  2026: '2026-07-28',
  2027: '2027-07-18',
  2028: '2028-07-06',
};
const MEMORIAL_DAY = { month: 3, date: 16, name: '我们的纪念日' };
const PROGRAMMER_DAY = { month: 10, date: 24, name: '程序员节 1024' };

function checkSpecialDay(): string | null {
  const now = new Date();
  const today = localDateKey(now);
  const birthToday = LUNARY_BIRTHDAY_MAP[now.getFullYear()];
  if (birthToday === today) return '🎂 生日快乐呀！今天也要开心一整天~';
  if (now.getMonth() + 1 === MEMORIAL_DAY.month && now.getDate() === MEMORIAL_DAY.date) {
    return '💕 纪念日快乐呀，又陪你走过一年~';
  }
  if (now.getMonth() + 1 === PROGRAMMER_DAY.month && now.getDate() === PROGRAMMER_DAY.date) {
    return '👨‍💻 1024 程序员节快乐！bug 退散，代码一次过~';
  }
  return null;
}

// ===== 早安 / 晚安问候 =====
function greetingByTime(): string | null {
  const h = new Date().getHours();
  if (h >= 6 && h < 10) return '☀️ 早上好~ 新的一天加油哦';
  if (h >= 10 && h < 12) return '☕ 上午好，摸鱼一下下~';
  if (h >= 14 && h < 18) return '💪 下午好，再坚持一下就下班啦';
  if (h >= 22 && h < 24) return '🌙 这么晚还没睡呀，早点休息哦';
  if (h >= 0 && h < 6) return '😴 还在熬夜吗？快去睡觉！';
  return null;
}

// ===== 摸鱼检测 =====
const SLACK_APP_NAMES = new Set([
  'safari', 'chrome', 'google chrome', 'chromium', 'edge', 'firefox',
]);
const SLACK_DOMAINS = new Set(['youtube', 'bilibili', 'weibo', 'zhihu', 'douyin', 'xiaohongshu', 'taobao', 'jd.com']);
let slackStreak = 0;
let slackWarnedAt = 0;

async function checkSlacking(): Promise<void> {
  if (!settings.codingCompanion || isQuitting) return;
  const name = await getFrontmostAppName();
  const isSlack = name !== '' && [...SLACK_APP_NAMES].some((n) => name === n || name.includes(n));
  if (isSlack && codingActive) {
    // 写代码模式下切到浏览器，连续 30 秒提醒一次
    slackStreak++;
    if (slackStreak >= 8 && Date.now() - slackWarnedAt > 30 * 60_000) {
      slackWarnedAt = Date.now();
      slackStreak = 0;
      sendActivity({ kind: 'manual', stateId: 'angry', durationMs: 1200, feedback: '喂！该回去写代码啦~' });
    }
  } else {
    slackStreak = 0;
  }
}

// ===== 低电量提醒 =====
let lowBatteryWarnedAt = 0;
function checkBattery(): void {
  if (isQuitting) return;
  const child = spawn('pmset', ['-g', 'batt']);
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.on('close', () => {
    const match = out.match(/(\d+)%;.*?(charging|discharging)/);
    if (!match || !match[1] || !match[2]) return;
    const pct = parseInt(match[1], 10);
    const status = match[2];
    if (pct <= 20 && status === 'discharging' && Date.now() - lowBatteryWarnedAt > 30 * 60_000) {
      lowBatteryWarnedAt = Date.now();
      sendActivity({ kind: 'feedback', feedback: `🔋 电量只剩 ${pct}% 啦，记得插充电器~` });
    }
  });
}

// ===== 反应小游戏 =====
let gameActive = false;
let gameScore = 0;
let gameRound = 0;
const GAME_TOTAL_ROUNDS = 3;

function startReactionGame(): void {
  if (gameActive) return;
  gameActive = true;
  gameScore = 0;
  gameRound = 0;
  sendActivity({ kind: 'feedback', feedback: `🎮 反应游戏开始！${GAME_TOTAL_ROUNDS} 轮，快速点我~` });

  const playRound = () => {
    if (!gameActive || gameRound >= GAME_TOTAL_ROUNDS) {
      finishGame();
      return;
    }
    gameRound++;
    const displays = screen.getAllDisplays();
    const display = displays[Math.floor(Math.random() * displays.length)];
    if (!display) return;
    const { width: sw, height: sh } = display.workAreaSize;
    const x = display.bounds.x + Math.random() * Math.max(50, sw - 150);
    const y = display.bounds.y + Math.random() * Math.max(50, sh - 150);
    petWindow?.setPosition(Math.round(x), Math.round(y));
    sendActivity({ kind: 'manual', stateId: 'wave', durationMs: 800, feedback: `第 ${gameRound} 轮！点我！` });

    setTimeout(() => {
      if (!gameActive) return;
      if (gameScore < gameRound) {
        sendActivity({ kind: 'feedback', feedback: '慢了哦~' });
      }
      setTimeout(playRound, 800);
    }, 2500);
  };

  setTimeout(playRound, 1500);
}

function registerGameHit(): void {
  if (!gameActive) return;
  gameScore++;
  sendActivity({ kind: 'feedback', feedback: '中！' });
}

function finishGame(): void {
  gameActive = false;
  const ratio = gameScore / GAME_TOTAL_ROUNDS;
  let msg: string;
  if (ratio === 1) msg = '满分！你反应也太快了吧 🏆';
  else if (ratio >= 0.5) msg = `不错哦！中了 ${gameScore}/${GAME_TOTAL_ROUNDS}`;
  else msg = `哈哈哈只中了 ${gameScore}/${GAME_TOTAL_ROUNDS}，多练几次~`;
  sendActivity({ kind: 'manual', stateId: 'cheer', durationMs: 1500, feedback: msg });
  stats.affection = Math.min(300, stats.affection + 2);
  void persistStats();
}

let followMouseEnabled = false;
let followTimer: ReturnType<typeof setInterval> | null = null;

function stopFollowWalking() {
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
}

function toggleFollowMouse() {
  followMouseEnabled = !followMouseEnabled;
  if (!followMouseEnabled) {
    stopFollowWalking();
    sendActivity({ kind: 'follow', stateId: 'idle' });
    if (logger) logger.write('info', 'follow-mouse-off', {}).catch(() => {});
    createTrayMenuRefresh();
    return;
  }
  if (logger) logger.write('info', 'follow-mouse-on', {}).catch(() => {});
  createTrayMenuRefresh();
  followTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const dx = cursor.x - cx;
    const dy = cursor.y - cy;
    if (Math.hypot(dx, dy) < 70) {
      sendActivity({ kind: 'follow', stateId: 'idle' });
      return;
    }
    const speed = 7;
    const nextX = bounds.x + Math.sign(dx) * Math.min(speed, Math.abs(dx));
    const nextY = bounds.y + Math.sign(dy) * Math.min(Math.round(speed * 0.6), Math.abs(dy));
    const display = screen.getDisplayNearestPoint(cursor).workArea;
    const clampedX = Math.min(display.x + display.width - bounds.width, Math.max(display.x, nextX));
    const clampedY = Math.min(display.y + display.height - bounds.height, Math.max(display.y, nextY));
    petWindow.setBounds({ x: clampedX, y: clampedY, width: bounds.width, height: bounds.height }, false);
    sendActivity({ kind: 'follow', stateId: dx < 0 ? 'walk-left' : 'walk-right' });
  }, 40);
}

function buildPetMenu(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (spec.features.interactions) {
    // 基础互动留在主菜单，情绪动作收进「🎭 情绪」二级菜单
    const emotionIds = new Set(['wave', 'dance', 'angry', 'cute', 'sleepy', 'jump', 'shy', 'cheer', 'sad', 'surprise']);
    const baseItems: Electron.MenuItemConstructorOptions[] = [];
    const emotionItems: Electron.MenuItemConstructorOptions[] = [];
    for (const interaction of allInteractions()) {
      const item: Electron.MenuItemConstructorOptions = { label: `${interaction.emoji} ${interaction.label}`, click: () => void triggerInteraction(interaction.id) };
      if (emotionIds.has(interaction.id)) emotionItems.push(item);
      else baseItems.push(item);
    }
    items.push(...baseItems);
    if (emotionItems.length) items.push({ label: '🎭 情绪动作', submenu: emotionItems });
    if (spec.experience.interactions.length) items.push({ type: 'separator' });
  }
  items.push({ label: '💺 坐一下', click: () => sendActivity({ kind: 'manual', stateId: 'sit' }) });
  if (tomato) {
    const mins = tomatoRemainingMinutes();
    items.push({
      label: tomato.paused ? `▶️ 番茄钟：继续（剩 ${mins} 分钟）` : `⏸️ 番茄钟：暂停（剩 ${mins} 分钟）`,
      click: tomato.paused ? resumeTomato : pauseTomato,
    });
    items.push({ label: '✖️ 取消番茄钟', click: cancelTomato });
  } else {
    items.push({
      label: '🍅 番茄钟',
      submenu: [
        { label: '🍅 专注 25 分钟', click: () => startTomato(25) },
        { label: '🍅 专注 15 分钟', click: () => startTomato(15) },
        { label: '🍅 专注 45 分钟', click: () => startTomato(45) },
      ],
    });
  }
  if (walkTimer) items.push({ label: '🚶 停止散步', click: stopWalking });
  else items.push({ label: '🏃 让她散步', click: startWalking });
  items.push({
    label: '🎨 换装',
    submenu: [
      { label: '🌸 好感度自动', click: () => sendActivity({ kind: 'outfit', outfitMode: 'auto', feedback: '换好啦，随好感度变化~' }) },
      { label: '🎃 万圣节', click: () => sendActivity({ kind: 'outfit', outfitMode: 'halloween', feedback: '不给糖就捣蛋！' }) },
      { label: '🎄 圣诞', click: () => sendActivity({ kind: 'outfit', outfitMode: 'christmas', feedback: '圣诞快乐呀~' }) },
      { label: '🧧 新年', click: () => sendActivity({ kind: 'outfit', outfitMode: 'newyear', feedback: '新年红红火火！' }) },
      { label: '🌸 春节', click: () => sendActivity({ kind: 'outfit', outfitMode: 'spring', feedback: '新春大吉呀~' }) },
      { label: '🏮 元宵', click: () => sendActivity({ kind: 'outfit', outfitMode: 'yuanxiao', feedback: '汤圆甜甜的~' }) },
      { label: '🌕 中秋', click: () => sendActivity({ kind: 'outfit', outfitMode: 'midautumn', feedback: '月亮好圆呀' }) },
      { label: '🤍 清清爽爽', click: () => sendActivity({ kind: 'outfit', outfitMode: 'none', feedback: '简单一点也很好' }) },
    ],
  });
  if (spec.features.reminders) {
    items.push({ label: '⏰ 添加提醒', click: showReminderComposer });
    items.push({
      label: '⚡ 快捷提醒',
      submenu: [
        { label: '💧 20 分钟后喝水', click: () => quickReminder('喝口水，润润喉咙', 20) },
        { label: '🧘 45 分钟后站起来活动', click: () => quickReminder('站起来伸个懒腰吧', 45) },
        { label: '🪑 1 小时后久坐提醒', click: () => quickReminder('起来走动走动，别一直坐着', 60) },
        { label: '🍚 90 分钟后午休', click: () => quickReminder('该午休啦，眯一会儿', 90) },
        { label: '☕ 2 小时后休息一下', click: () => quickReminder('歇一歇，看看远处', 120) },
      ],
    });
  }
  items.push({ type: 'separator' });
  items.push({
    label: settings.codingCompanion ? '💻 陪写代码：进行中' : '💻 陪写代码',
    click: () => {
      if (codingActive) {
        exitCodingMode();
      } else {
        void saveSettings({ ...settings, codingCompanion: true });
        enterCodingMode();
      }
    },
  });
  items.push({ label: '📊 本周回顾', click: showWeeklyReview });
  items.push({ label: '🎮 反应游戏', click: startReactionGame });
  if (spec.features.dashboard) items.push({ label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard });
  if (spec.features.filePocket) items.push({ label: '📁 打开文件口袋', click: () => void openPocket() });
  if (spec.features.autonomousMovement) items.push({ label: followMouseEnabled ? '🚶 停止跟随鼠标' : '🐭 跟随鼠标', click: toggleFollowMouse });
  items.push({ type: 'separator' });
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  items.push({ label: openAtLogin ? '🔓 关闭开机自启' : '🔌 开机自启', click: () => { app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin }); } });
  items.push({ label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) });
  items.push({ label: settings.soundEnabled ? '🔇 关闭音效' : '🔊 开启音效', click: () => void toggleSound() });
  items.push({ label: '🙈 隐藏桌宠', click: () => petWindow?.hide() });
  return items;
}

function createTray(): void {
  if (!spec.features.tray) return;
  const resolvedTrayIconPath = path.resolve(__dirname, trayIconPath);
  const trayImage = nativeImage.createFromPath(resolvedTrayIconPath);
  if (trayImage.isEmpty()) throw new Error(`Tray icon is empty: ${resolvedTrayIconPath}`);
  tray = new Tray(trayImage.resize({ width: 32, height: 32, quality: 'best' }));
  tray.setToolTip(spec.app.name);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `🐾 显示${spec.character.displayName}`, click: () => petWindow?.show() },
    { label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard },
    { label: followMouseEnabled ? '🚶 停止跟随鼠标' : '🐭 跟随鼠标', click: toggleFollowMouse },
    { label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) },
    { type: 'separator' },
    { label: '🚪 退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => petWindow?.isVisible() ? petWindow.hide() : petWindow?.show());
}

async function saveSettings(next: Settings): Promise<Settings> {
  settings = next;
  await atomicWriteJson(userFile('settings.json'), settings);
  applyPetSettings();
  restartTypingListener();
  createTrayMenuRefresh();
  return settings;
}

function createTrayMenuRefresh(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `🐾 显示${spec.character.displayName}`, click: () => petWindow?.show() },
    { label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard },
    { label: followMouseEnabled ? '🚶 停止跟随鼠标' : '🐭 跟随鼠标', click: toggleFollowMouse },
    { label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) },
    { type: 'separator' },
    { label: '🚪 退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function broadcastTypingStatus(): void {
  for (const window of [petWindow, reminderWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('typing:status', typingStatus);
  }
}

function restartTypingListener(): void {
  typingListener.stop();
  typingStatus = typingListener.start(settings.typingReaction, () => {
    const state = stateForTrigger('typing:activity');
    sendActivity({ kind: 'typing', stateId: state?.id, durationMs: 500 });
  });
  broadcastTypingStatus();
  void logger?.write(typingStatus.enabled ? 'info' : 'warn', 'typing-listener-status', typingStatus as unknown as Record<string, unknown>);
}

function clearReminderTimer(id: string): void {
  const timer = reminderTimers.get(id);
  if (timer) clearTimeout(timer);
  reminderTimers.delete(id);
}

function scheduleReminder(reminder: Reminder): void {
  clearReminderTimer(reminder.id);
  const delay = nextReminderDelay(reminder.dueAt);
  reminderTimers.set(reminder.id, setTimeout(() => {
    reminderTimers.delete(reminder.id);
    if (Date.parse(reminder.dueAt) > Date.now()) {
      scheduleReminder(reminder);
      return;
    }
    if (reminderWindow) {
      positionAbovePet(reminderWindow);
      if (e2eMode) reminderWindow.showInactive();
      else {
        reminderWindow.show();
        reminderWindow.focus();
      }
      reminderWindow.webContents.send('reminder:due', reminder);
    }
    const state = stateForTrigger('reminder:due');
    sendActivity({ kind: 'notify', stateId: state?.id, durationMs: 1800, feedback: reminder.text });
  }, delay));
}

async function persistReminders(): Promise<void> {
  await atomicWriteJson(userFile('reminders.json'), reminders);
}

async function openPocket(): Promise<void> {
  if (!spec.features.filePocket) throw new Error('File pocket is disabled');
  const directory = filePocket();
  await mkdir(directory, { recursive: true });
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
}

function registerIpc(): void {
  if (process.env.PET_E2E === '1') {
    ipcMain.handle('runtime:e2e-snapshot', (event) => {
      assertSender(event, ['pet', 'dashboard', 'reminder']);
      return (globalThis as typeof globalThis & {
        __PET_E2E__?: { snapshot: () => unknown };
      }).__PET_E2E__?.snapshot();
    });
    ipcMain.handle('runtime:e2e-quit', (event) => {
      assertSender(event, ['pet', 'dashboard', 'reminder']);
      setTimeout(() => {
        isQuitting = true;
        app.quit();
      }, 0);
    });
  }
  ipcMain.handle('runtime:renderer-ready', async (event, payload: unknown) => {
    const role = assertSender(event, ['pet', 'dashboard', 'reminder']);
    if (
      !payload
      || typeof payload !== 'object'
      || !('role' in payload)
      || payload.role !== role
      || !('bootstrapComplete' in payload)
      || payload.bootstrapComplete !== true
    ) {
      throw new TypeError('Invalid renderer-ready report');
    }
    runtimeReadyRenderers.add(role);
    await commitRuntimeReady();
  });
  ipcMain.handle('runtime:renderer-failed', async (event, payload: unknown) => {
    const role = assertSender(event, ['pet', 'dashboard', 'reminder']);
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message.slice(0, 2000)
      : 'Unknown renderer bootstrap failure';
    await fatalExit(`${role}-renderer-bootstrap-failed`, new Error(message), { role });
  });
  ipcMain.handle('runtime:ready', async (event, report: unknown) => {
    assertSender(event, ['pet']);
    assertRuntimeReadyReport(report);
    const state = spec.states.find((item) => item.id === report.stateId);
    if (!state || !state.frames.includes(report.frame)) throw new Error('Runtime report references an unknown state/frame pair');
    if (report.assetCount !== bootRuntimeAssets.size) throw new Error(`Runtime asset count mismatch: ${report.assetCount}/${bootRuntimeAssets.size}`);
    if (report.naturalWidth !== 512 || report.naturalHeight !== 512) throw new Error(`Runtime frame must be 512x512, got ${report.naturalWidth}x${report.naturalHeight}`);
    runtimeRendererReport = report;
    await commitRuntimeReady();
  });
  ipcMain.handle('runtime:fail', async (event, report: unknown) => {
    assertSender(event, ['pet']);
    assertRuntimeFailureReport(report);
    await fatalExit('renderer-runtime-failed', new Error(report.message), report as unknown as Record<string, unknown>);
  });
  ipcMain.handle('settings:get', (event) => { assertSender(event, ['pet', 'reminder', 'dashboard']); return settings; });
  ipcMain.handle('settings:update', async (event, patch: unknown) => {
    assertSender(event, ['dashboard']);
    assertSettingsPatch(patch);
    return saveSettings(parseSettings({ ...settings, ...patch }));
  });
  ipcMain.handle('diary:list', (event) => {
    assertSender(event, ['dashboard']);
    return diary.list();
  });
  ipcMain.handle('review:weekly', (event) => {
    assertSender(event, ['pet', 'dashboard', 'reminder']);
    return buildWeeklyReview();
  });
  ipcMain.handle('reminders:list', (event) => { assertSender(event, ['dashboard', 'reminder']); return reminders; });
  ipcMain.handle('reminders:save', async (event, input: unknown) => {
    assertSender(event, ['dashboard', 'reminder']);
    assertReminderInput(input);
    const reminder: Reminder = { id: randomUUID(), text: input.text.trim(), dueAt: new Date(input.dueAt).toISOString(), createdAt: new Date().toISOString() };
    reminders.push(reminder);
    await persistReminders();
    scheduleReminder(reminder);
    return reminder;
  });
  ipcMain.handle('reminders:remove', async (event, id: unknown) => {
    assertSender(event, ['dashboard']);
    if (typeof id !== 'string' || id.length > 100) throw new TypeError('Invalid reminder id');
    const oldLength = reminders.length;
    reminders = reminders.filter((item) => item.id !== id);
    clearReminderTimer(id);
    await persistReminders();
    return oldLength !== reminders.length;
  });
  ipcMain.handle('interactions:list', (event) => { assertSender(event, ['pet', 'dashboard']); return allInteractions(); });
  ipcMain.handle('interactions:stats', (event) => { assertSender(event, ['pet', 'dashboard']); normalizeStatsDay(); return publicStats(); });
  ipcMain.handle('interactions:trigger', async (event, id: unknown) => {
    assertSender(event, ['pet', 'dashboard']);
    assertInteractionId(id);
    return triggerInteraction(id);
  });
  ipcMain.handle('custom:list', (event) => { assertSender(event, ['dashboard']); return customInteractions; });
  ipcMain.handle('custom:add', (event, input: unknown) => {
    assertSender(event, ['dashboard']);
    const result = validateCustomInput(input);
    if (!result.ok) return { ok: false, error: result.error, items: customInteractions };
    persistCustomInteractions([...customInteractions, result.value]);
    return { ok: true, items: customInteractions };
  });
  ipcMain.handle('custom:remove', (event, id: unknown) => {
    assertSender(event, ['dashboard']);
    if (typeof id !== 'string' || id.length === 0 || id.length > 40) {
      return { ok: false, error: '无效的互动 id', items: customInteractions };
    }
    const next = customInteractions.filter((item) => item.id !== id);
    if (next.length === customInteractions.length) return { ok: false, error: '未找到该互动', items: customInteractions };
    persistCustomInteractions(next);
    return { ok: true, items: customInteractions };
  });
  ipcMain.handle('files:put', async (event, paths: unknown) => {
    assertSender(event, ['pet']);
    if (!spec.features.filePocket) throw new Error('File pocket is disabled');
    assertStringArray(paths);
    const destination = filePocket();
    await mkdir(destination, { recursive: true });
    const result = { copied: [] as string[], failed: [] as Array<{ source: string; reason: string }> };
    for (const source of paths) {
      try {
        if (!(await lstat(source)).isFile()) throw new Error('Only regular files are accepted');
        const target = await uniqueDestination(destination, path.basename(source));
        await copyFile(source, target);
        result.copied.push(target);
      } catch (error) {
        result.failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
  ipcMain.handle('files:open-pocket', async (event) => { assertSender(event, ['pet', 'dashboard']); await openPocket(); });
  ipcMain.handle('window:drag-begin', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !spec.features.drag) return;
    dragSession = { bounds: petWindow.getBounds(), cursor: screen.getCursorScreenPoint() };
  });
  ipcMain.handle('window:drag-update', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !dragSession) return;
    const point = screen.getCursorScreenPoint();
    const next = draggedBounds(dragSession.bounds, dragSession.cursor, point);
    if (settings.edgeSnap) {
      // 按鼠标当前所在屏幕（含副屏）的 workArea 实时贴边吸附
      const workArea = screen.getDisplayNearestPoint(point).workArea;
      petWindow.setBounds(snapBounds(next, workArea), false);
    } else {
      petWindow.setBounds(next, false);
    }
  });
  ipcMain.handle('window:drag-end', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !dragSession) return;
    dragSession = undefined;
    if (settings.edgeSnap) {
      const point = screen.getCursorScreenPoint();
      const workArea = screen.getDisplayNearestPoint(point).workArea;
      petWindow.setBounds(snapBounds(petWindow.getBounds(), workArea), true);
      const state = stateForTrigger('window:edge-snap');
      sendActivity({ kind: 'edge-snap', stateId: state?.id, durationMs: 900 });
    }
  });
  ipcMain.handle('window:show-context-menu', (event) => {
    assertSender(event, ['pet']);
    if (petWindow) Menu.buildFromTemplate(buildPetMenu()).popup({ window: petWindow });
  });
  ipcMain.handle('window:show-reminder', (event) => { assertSender(event, ['pet', 'dashboard']); showReminderComposer(); });
  ipcMain.handle('window:show-dashboard', (event) => { assertSender(event, ['pet']); showDashboard(); });
  ipcMain.handle('window:hide-reminder', (event) => { assertSender(event, ['reminder']); reminderWindow?.hide(); });
  ipcMain.handle('window:hide-dashboard', (event) => { assertSender(event, ['dashboard']); dashboardWindow?.hide(); });
  ipcMain.handle('window:hide-pet', (event) => { assertSender(event, ['pet', 'dashboard']); petWindow?.hide(); });
}

async function initialize(): Promise<void> {
  await verifySourceAssetGate();
  logger = new JsonLogger(userFile('logs/app.jsonl'));
  settings = await readValidatedJson(userFile('settings.json'), defaultSettings, parseSettings);
  reminders = await readValidatedJson(userFile('reminders.json'), [] as Reminder[], parseReminders);
  customInteractions = loadCustomInteractions();
  // 首次启动写入示例模板，方便用户照着改
  try {
    const example = path.join(app.getPath('userData'), 'custom-interactions.example.json');
    if (!existsSync(example)) {
      writeFileSync(example, JSON.stringify([
        { id: 'hello-wave', label: '打个招呼', emoji: '👋', stateId: 'wave', durationMs: 1600, affectionGain: 1, feedback: ['嗨~', '你来啦！'] },
        { id: 'bubble-encourage', label: '加油打气', emoji: '💪', stateId: 'bubble-only', durationMs: 1400, affectionGain: 0, feedback: ['你可以的！', '加油加油~', '我支持你！'] },
      ], null, 2) + "\n", 'utf-8');
    }
  } catch { /* 示例模板写失败不影响运行 */ }
  stats = await readValidatedJson(userFile('pet-stats.json'), defaultStats, parsePersistedStats);
  achievementsState = await loadAchievements();
  touchStreak(achievementsState);
  await saveAchievements(achievementsState);
  normalizeStatsDay();
  sessionStartedAt = Date.now();
  registerIpc();
  await logger.write('info', 'main-initializing', { platform: process.platform, arch: process.arch, version: spec.app.version, schemaVersion: spec.schemaVersion });
  createWindows();
  createTray();
  reminders.forEach(scheduleReminder);
  registerGlobalShortcuts();
  restartTypingListener();
  // 离线想念：按上次退出时间返回欢迎语
  (() => {
    try {
      const lastSeenFile = path.join(app.getPath('userData'), 'last-seen.json');
      let lastSeen = 0;
      try { lastSeen = Number(JSON.parse(readFileSync(lastSeenFile, 'utf-8')).at) || 0; } catch { /* 首次启动 */ }
      const diffHours = (Date.now() - lastSeen) / 3_600_000;
      if (lastSeen > 0 && diffHours >= 8) {
        let line = '好久不见，想你了~';
        if (diffHours >= 24 * 7) line = '呜呜，我以为你不要我了…';
        else if (diffHours >= 24 * 3) line = '你去哪了呀，我好想你！';
        else if (diffHours >= 24) line = '一天没见，想你想得紧~';
        setTimeout(() => sendActivity({ kind: 'feedback', feedback: line }), 8_000);
      }
      try { atomicWriteJson(lastSeenFile, { at: Date.now() }); } catch { /* 忽略 */ }
    } catch { /* 忽略 */ }
  })();
  void refreshWeather();
  setInterval(() => void refreshWeather(), 30 * 60_000);
  startCodingCompanion();
  setInterval(maybeAutoWeeklyReview, 30 * 60_000);

  // 启动问候：特殊日优先，其次按时段
  setTimeout(() => {
    const special = checkSpecialDay();
    const greet = special ?? greetingByTime();
    if (greet) sendActivity({ kind: 'feedback', feedback: greet });
  }, 3000);

  // 低电量轮询
  setInterval(checkBattery, 5 * 60_000);

  // ===== 跟随系统深浅色模式 =====
  const broadcastTheme = () => {
    const dark = nativeTheme.shouldUseDarkColors;
    for (const w of [petWindow, reminderWindow, dashboardWindow]) {
      w?.webContents.send('theme:changed', dark);
    }
  };
  nativeTheme.on('updated', broadcastTheme);
  setTimeout(broadcastTheme, 2000);

  // ===== 长时间 idle 自动换状态 =====
  const AMBIENT_STATES = ['sit', 'walk-left', 'walk-right', 'sleepy', 'wave'];
  setInterval(() => {
    if (isQuitting || codingActive) return;
    const pick = AMBIENT_STATES[Math.floor(Math.random() * AMBIENT_STATES.length)];
    sendActivity({ kind: 'manual', stateId: pick });
  }, 90_000);
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (e2eMode) petWindow.showInactive();
    else {
      petWindow.show();
      petWindow.focus();
    }
  });
  app.whenReady().then(() => {
    if (e2eMode) app.dock?.hide();
    return initialize();
  }).catch((error) => { void fatalExit('initialize-failed', error); });
} else {
  app.exit(0);
}

app.on('window-all-closed', () => { /* tray app stays alive */ });
app.on('before-quit', (event) => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  typingListener.stop();
  for (const timer of reminderTimers.values()) clearTimeout(timer);
  reminderTimers.clear();
  if (quitPersisting || !stats) return;
  event.preventDefault();
  quitPersisting = true;
  void persistStats()
    .catch((error) => logger?.write('error', 'persist-stats-on-quit-failed', { message: error instanceof Error ? error.message : String(error) }))
    .finally(() => app.exit(0));
});
app.on('render-process-gone', (_event, webContents, details) => {
  if (isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') return;
  if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
    void fatalExit('render-process-gone', new Error(details.reason), { webContentsId: webContents.id, exitCode: details.exitCode });
  } else {
    void logger?.write('warn', 'render-process-gone', { webContentsId: webContents.id, reason: details.reason, exitCode: details.exitCode });
  }
});

process.on('uncaughtException', (error) => {
  void fatalExit('uncaught-exception', error, { stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  void fatalExit('unhandled-rejection', error, { stack: error.stack });
});
