import spec from '../../../pet-spec.json';
import type { PetSpec, Reminder, WeeklyReview } from '../../shared/contracts';
import './index.css';

const petSpec = spec as PetSpec;

// 设置主题色
const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);

// 深色模式覆盖
function applyTheme(dark: boolean): void {
  if (dark) {
    document.documentElement.style.setProperty('--surface', '#2a2438');
    document.documentElement.style.setProperty('--background', '#1a1625');
    document.documentElement.style.setProperty('--text', '#f0e6d8');
    document.documentElement.style.setProperty('--muted', '#9a8a9a');
  } else {
    document.documentElement.style.setProperty('--surface', theme.surface);
    document.documentElement.style.setProperty('--background', theme.background);
    document.documentElement.style.setProperty('--text', theme.text);
    document.documentElement.style.setProperty('--muted', theme.muted);
  }
}
window.petAPI?.events.onThemeChanged(applyTheme);

const textInput = document.getElementById('reminder-text') as HTMLInputElement;
const timeInput = document.getElementById('reminder-time') as HTMLInputElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;

// 设置默认时间为1小时后
function setDefaultTime(): void {
  const now = new Date();
  now.setHours(now.getHours() + 1);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  timeInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
}

setDefaultTime();

// 保存提醒
saveBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  const time = timeInput.value;

  if (!text || !time) {
    return;
  }

  try {
    await window.petAPI?.reminders.save({
      text,
      dueAt: new Date(time).toISOString(),
    });
    textInput.value = '';
    setDefaultTime();
    await window.petAPI?.window.hideReminder();
  } catch (error) {
    console.error('Failed to save reminder:', error);
  }
});

// 取消
cancelBtn.addEventListener('click', async () => {
  textInput.value = '';
  setDefaultTime();
  await window.petAPI?.window.hideReminder();
});

// 监听提醒触发
window.petAPI?.events.onReminder((reminder: Reminder) => {
  // 显示提醒
  textInput.value = reminder.text;
  timeInput.value = new Date(reminder.dueAt).toLocaleString();
});

// 监听打开提醒编辑器
window.petAPI?.events.onReminderCompose(() => {
  setDefaultTime();
  (document.getElementById('compose-card') as HTMLElement).style.display = '';
  (document.getElementById('review-card') as HTMLElement).style.display = 'none';
  textInput.focus();
});

// 周末回顾模式
function renderReview(review: WeeklyReview): void {
  (document.getElementById('compose-card') as HTMLElement).style.display = 'none';
  (document.getElementById('review-card') as HTMLElement).style.display = '';
  const body = document.getElementById('review-body') as HTMLElement;
  const achievementLine = review.newAchievements.length
    ? `<div class="review-row"><span class="review-label">🏅 新解锁</span><span>${review.newAchievements.join('、')}</span></div>`
    : '';
  body.innerHTML = `
    <div class="review-row"><span class="review-label">📅 陪伴天数</span><span class="review-num">${review.activeDays} 天</span></div>
    <div class="review-row"><span class="review-label">💗 互动次数</span><span class="review-num">${review.totalInteractions} 次</span></div>
    <div class="review-row"><span class="review-label">🍅 番茄钟</span><span class="review-num">${review.totalTomato} 个</span></div>
    <div class="review-row"><span class="review-label">✨ 好感度提升</span><span class="review-num">+${review.affectionGained}</span></div>
    <div class="review-row"><span class="review-label">🎯 最常一起做</span><span>${review.topInteractionLabel}</span></div>
    ${achievementLine}
    <div class="review-foot">这周也辛苦啦，下周继续陪你~</div>
  `;
}

window.petAPI?.events.onWeeklyReview((review: WeeklyReview) => renderReview(review));

document.getElementById('review-close-btn')?.addEventListener('click', () => {
  void window.petAPI?.window.hideReminder();
});
