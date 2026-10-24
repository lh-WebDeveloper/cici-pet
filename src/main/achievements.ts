/**
 * 成就系统：本地持久化互动计数与连续陪伴天数，输出小屋面板的徽章列表。
 * 数据写入 userData/achievements.json，独立于受模板契约保护的 pet-stats.json。
 */
import { app } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PetStats } from '../shared/contracts';

export interface AchievementSummary {
  id: string;
  emoji: string;
  name: string;
  desc: string;
  unlocked: boolean;
  progress: number;
  target: number;
}

export interface AchievementState {
  interactionCounts: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  streakDays: number;
  notifiedIds: string[];
}

const DEFAULT_STATE: AchievementState = {
  interactionCounts: {},
  firstSeen: '',
  lastSeen: '',
  streakDays: 0,
  notifiedIds: [],
};

interface Rule {
  id: string;
  emoji: string;
  name: string;
  desc: string;
  progress: (stats: PetStats, state: AchievementState) => number;
  target: number;
  unlockedWhenAffection?: boolean;
}

const RULES: Rule[] = [
  { id: 'pet-50', emoji: '🐾', name: '摸摸达人', desc: '摸摸头累计 50 次', target: 50, progress: (_s, st) => st.interactionCounts['pet-head'] ?? 0 },
  { id: 'feed-100', emoji: '🍪', name: '投喂大师', desc: '投喂零食累计 100 次', target: 100, progress: (_s, st) => st.interactionCounts['feed-snack'] ?? 0 },
  { id: 'chat-50', emoji: '💬', name: '话痨朋友', desc: '聊天累计 50 次', target: 50, progress: (_s, st) => st.interactionCounts['chat'] ?? 0 },
  { id: 'jump-30', emoji: '🦘', name: '跳跃健将', desc: '一起蹦跶 30 次', target: 30, progress: (_s, st) => st.interactionCounts['jump'] ?? 0 },
  { id: 'affection-240', emoji: '💕', name: '亲密无间', desc: '好感度达到 240', target: 240, progress: (s, _st) => s.affection, unlockedWhenAffection: true },
  { id: 'companion-600', emoji: '⏰', name: '长情陪伴', desc: '累计陪伴 10 小时', target: 600, progress: (s, _st) => s.companionMinutes },
  { id: 'streak-7', emoji: '📅', name: '七日之约', desc: '连续 7 天来见面', target: 7, progress: (_s, st) => st.streakDays },
];

function localDateKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, '0');
  const d = `${now.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function stateFile(): string {
  return join(app.getPath('userData'), 'achievements.json');
}

export async function loadAchievements(): Promise<AchievementState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(), 'utf8')) as Partial<AchievementState>;
    return {
      interactionCounts: typeof parsed.interactionCounts === 'object' && parsed.interactionCounts ? parsed.interactionCounts : {},
      firstSeen: typeof parsed.firstSeen === 'string' ? parsed.firstSeen : '',
      lastSeen: typeof parsed.lastSeen === 'string' ? parsed.lastSeen : '',
      streakDays: Number.isInteger(parsed.streakDays) ? (parsed.streakDays as number) : 0,
      notifiedIds: Array.isArray(parsed.notifiedIds) ? parsed.notifiedIds.filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveAchievements(state: AchievementState): Promise<void> {
  try {
    const tmp = `${stateFile()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await writeFile(stateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch { /* 成就数据写失败不阻塞主流程 */ }
}

/** 启动时更新连续陪伴天数。 */
export function touchStreak(state: AchievementState, now: Date = new Date()): void {
  const today = localDateKey(now);
  if (state.lastSeen === today) return;
  if (state.firstSeen === '') state.firstSeen = today;
  const yesterday = localDateKey(new Date(now.getTime() - 86_400_000));
  state.streakDays = state.lastSeen === yesterday ? state.streakDays + 1 : 1;
  state.lastSeen = today;
}

/** 记录一次互动。 */
export function recordInteraction(state: AchievementState, interactionId: string): void {
  state.interactionCounts[interactionId] = (state.interactionCounts[interactionId] ?? 0) + 1;
}

/** 返回本次新解锁（且尚未庆祝过）的成就，并标记为已庆祝。 */
export function evaluateNewlyUnlocked(stats: PetStats, state: AchievementState): AchievementSummary[] {
  const fresh: AchievementSummary[] = [];
  for (const rule of RULES) {
    const progress = rule.unlockedWhenAffection ? stats.affection : rule.progress(stats, state);
    const unlocked = progress >= rule.target;
    if (unlocked && !state.notifiedIds.includes(rule.id)) {
      state.notifiedIds.push(rule.id);
      fresh.push({ id: rule.id, emoji: rule.emoji, name: rule.name, desc: rule.desc, unlocked: true, progress, target: rule.target });
    }
  }
  return fresh;
}

export function evaluateAchievements(stats: PetStats, state: AchievementState): AchievementSummary[] {
  return RULES.map((rule) => {
    const progress = rule.unlockedWhenAffection ? stats.affection : rule.progress(stats, state);
    return {
      id: rule.id,
      emoji: rule.emoji,
      name: rule.name,
      desc: rule.desc,
      unlocked: progress >= rule.target,
      progress: Math.min(progress, rule.target),
      target: rule.target,
    };
  });
}
