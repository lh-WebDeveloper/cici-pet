// 宠物日记：按天记录互动摘要，保留最近 30 天，供小屋面板翻阅。
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DiaryEntry } from '../shared/contracts';

const MAX_DAYS = 30;

export function loadDiary(): DiaryEntry[] {
  try {
    const file = path.join(app.getPath('userData'), 'diary.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is DiaryEntry => isDiaryEntry(item))
        .slice(-MAX_DAYS);
    }
  } catch {
    /* 文件缺失或损坏时从空日记开始 */
  }
  return [];
}

function isDiaryEntry(value: unknown): value is DiaryEntry {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.date === 'string' &&
    typeof obj.interactions === 'object' && obj.interactions !== null && !Array.isArray(obj.interactions) &&
    typeof obj.affectionGained === 'number' &&
    Array.isArray(obj.achievementsUnlocked) &&
    typeof obj.tomatoCompleted === 'number'
  );
}

function saveDiary(entries: DiaryEntry[]): void {
  const file = path.join(app.getPath('userData'), 'diary.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries.slice(-MAX_DAYS), null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export interface DiaryStore {
  touchInteraction(date: string, interactionId: string, affectionGained: number, achievementsUnlocked: string[], mood?: number): void;
  touchTomato(date: string): void;
  list(): DiaryEntry[];
}

export function createDiaryStore(): DiaryStore {
  let entries = loadDiary();

  function todayEntry(date: string): DiaryEntry {
    let entry = entries.find((item) => item.date === date);
    if (!entry) {
      entry = { date, interactions: {}, affectionGained: 0, achievementsUnlocked: [], tomatoCompleted: 0 };
      entries.push(entry);
    }
    return entry;
  }

  return {
    touchInteraction(date, interactionId, affectionGained, achievementsUnlocked, mood) {
      const entry = todayEntry(date);
      entry.interactions[interactionId] = (entry.interactions[interactionId] ?? 0) + 1;
      entry.affectionGained += affectionGained;
      if (typeof mood === 'number' && Number.isFinite(mood)) entry.mood = Math.max(0, Math.min(100, Math.round(mood)));
      for (const name of achievementsUnlocked) {
        if (!entry.achievementsUnlocked.includes(name)) entry.achievementsUnlocked.push(name);
      }
      saveDiary(entries);
    },
    touchTomato(date) {
      const entry = todayEntry(date);
      entry.tomatoCompleted += 1;
      saveDiary(entries);
    },
    list() {
      return entries.slice(-MAX_DAYS).map((entry) => ({
        date: entry.date,
        interactions: { ...entry.interactions },
        affectionGained: entry.affectionGained,
        achievementsUnlocked: [...entry.achievementsUnlocked],
        tomatoCompleted: entry.tomatoCompleted,
        ...(typeof entry.mood === 'number' ? { mood: entry.mood } : {}),
      }));
    },
  };
}
