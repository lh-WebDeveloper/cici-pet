import spec from '../../../pet-spec.json';
import type { DiaryEntry, PetSpec, PetStats, Settings, InteractionSpec } from '../../shared/contracts';
import './index.css';

// 用于 asset link 检查的占位符（实际不需要导入所有图片）
// require.context('../../assets/pet', true, /\.png$/);

const petSpec = spec as PetSpec;
document.title = `${petSpec.character.displayName}的小屋`;

// 设置主题色
const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);

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

// 设置宠物信息
document.getElementById('pet-name')!.textContent = petSpec.character.displayName;
document.getElementById('pet-personality')!.textContent = petSpec.character.personality.join('、');

const closeBtn = document.getElementById('close-btn') as HTMLButtonElement;
const affectionEl = document.getElementById('affection') as HTMLDivElement;
const moodEl = document.getElementById('mood') as HTMLDivElement;
const todayInteractionsEl = document.getElementById('today-interactions') as HTMLDivElement;
const companionMinutesEl = document.getElementById('companion-minutes') as HTMLDivElement;
const interactionsList = document.getElementById('interactions-list') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const sizeSelector = document.getElementById('size-selector') as HTMLDivElement;
const achievementsList = document.getElementById('achievements-list') as HTMLDivElement;
const diaryList = document.getElementById('diary-list') as HTMLDivElement;

let currentSettings: Settings | null = null;

// 加载互动列表
async function loadInteractions(): Promise<void> {
  try {
    const interactions = await window.petAPI?.interactions.list();
    if (!interactions) return;

    interactionsList.replaceChildren();
    for (const interaction of interactions) {
      const btn = document.createElement('button');
      btn.className = 'interaction-btn';
      const emoji = document.createElement('span');
      emoji.textContent = interaction.emoji;
      const label = document.createElement('span');
      label.textContent = interaction.label;
      btn.append(emoji, label);
      btn.addEventListener('click', async () => {
        try {
          await window.petAPI?.interactions.trigger(interaction.id);
        } catch (error) {
          console.error('Failed to trigger interaction:', error);
        }
      });
      interactionsList.appendChild(btn);
    }
  } catch (error) {
    console.error('Failed to load interactions:', error);
  }
}

// 加载设置
async function loadSettings(): Promise<void> {
  try {
    const settings = await window.petAPI?.settings.get();
    if (!settings) return;
    currentSettings = settings;

    // 更新开关状态
    if (settings.alwaysOnTop) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }

    if (settings.clickThrough) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }

    // 更新大小选择
    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => {
      const scale = parseFloat((btn as HTMLElement).dataset.scale || '1');
      if (Math.abs(scale - settings.petScale) < 0.01) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// 加载统计数据
async function loadStats(): Promise<void> {
  try {
    const stats = await window.petAPI?.interactions.stats();
    if (!stats) return;
    updateStats(stats);
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
  void loadDiary();
}

function updateStats(stats: PetStats): void {
  affectionEl.textContent = String(stats.affection);
  moodEl.textContent = String(stats.mood);
  todayInteractionsEl.textContent = String(stats.todayInteractions);
  const unit = document.createElement('small');
  unit.textContent = '分钟';
  companionMinutesEl.replaceChildren(String(stats.companionMinutes), unit);
  if (Array.isArray(stats.achievements)) renderAchievements(stats.achievements);
}

// ===== 数据图表（原生 SVG，近 14/7 天）=====
const chartAffection = document.getElementById('chart-affection') as HTMLDivElement;
const chartInteractions = document.getElementById('chart-interactions') as HTMLDivElement;
const chartTomato = document.getElementById('chart-tomato') as HTMLDivElement;
const chartMood = document.getElementById('chart-mood') as HTMLDivElement;
const chartRadar = document.getElementById('chart-radar') as HTMLDivElement;

function dayLabel(date: string): string {
  const parts = date.split('-');
  if (parts.length === 3) return `${Number(parts[1])}/${Number(parts[2])}`;
  return date.slice(5);
}

function drawLineChart(host: HTMLDivElement, days: { label: string; value: number }[], color: string, showZero = false): void {
  const W = 560, H = 120, PAD = 26;
  const max = Math.max(1, ...days.map((d) => d.value));
  const step = (W - PAD * 2) / Math.max(1, days.length - 1);
  const x = (i: number): number => PAD + i * step;
  const y = (v: number): number => H - PAD - (v / max) * (H - PAD * 2);
  const points = days.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const bars = days.map((d, i) => {
    const h = Math.max(2, (d.value / max) * (H - PAD * 2));
    return `<rect x="${(x(i) - step / 3).toFixed(1)}" y="${(H - PAD - h).toFixed(1)}" width="${(step * 2 / 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="${d.value > 0 ? 0.85 : 0.12}"></rect>`;
  }).join('');
  const labels = days.map((d, i) => {
    const show = days.length <= 8 || i % 2 === 0 || i === days.length - 1;
    if (!show) return '';
    return `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#8a8f98">${d.label}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%;display:block" role="img">
    ${bars}
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>
    ${labels}
  </svg>`;
}

function drawCharts(entries: DiaryEntry[]): void {
  const byDate = new Map<string, { gain: number; count: number; tomato: number; interactions: Record<string, number>; mood?: number }>();
  for (const entry of entries) {
    const total = Object.values(entry.interactions).reduce((a, b) => a + b, 0);
    byDate.set(entry.date, { gain: entry.affectionGained, count: total, tomato: entry.tomatoCompleted, interactions: entry.interactions, mood: entry.mood });
  }
  const today = new Date();
  const fmt = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const affectionDays: { label: string; value: number }[] = [];
  const interactionDays: { label: string; value: number }[] = [];
  const tomatoDays: { label: string; value: number }[] = [];
  let cum = 0;
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = fmt(d);
    const data = byDate.get(key) ?? { gain: 0, count: 0, tomato: 0 };
    cum += data.gain;
    affectionDays.push({ label: dayLabel(key), value: cum });
    interactionDays.push({ label: dayLabel(key), value: data.count });
    if (i < 7) tomatoDays.push({ label: dayLabel(key), value: data.tomato });
  }
  drawLineChart(chartAffection, affectionDays, '#ff7eb3');
  drawLineChart(chartInteractions, interactionDays, '#7aa2f7');
  drawLineChart(chartTomato, tomatoDays, '#ffb86c');

  // 心情趋势：旧数据没有 mood 时沿用最近一次有记录的心情
  const moodDays: { label: string; value: number }[] = [];
  let lastMood = 60;
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = fmt(d);
    const data = byDate.get(key);
    if (data && typeof data.mood === 'number' && Number.isFinite(data.mood)) lastMood = data.mood;
    moodDays.push({ label: dayLabel(key), value: lastMood });
  }
  drawLineChart(chartMood, moodDays, '#5bd6a8');

  // 互动类型分布雷达图（近 7 天）
  const RADAR_AXES: { label: string; keys: string[] }[] = [
    { label: '聊天', keys: ['chat'] },
    { label: '摸头', keys: ['pet-head'] },
    { label: '喂食', keys: ['feed-snack'] },
    { label: '跳舞', keys: ['dance', 'wave'] },
    { label: '开心', keys: ['cheer', 'happy', 'cute', 'shy'] },
    { label: '惊讶', keys: ['surprise'] },
  ];
  const radarValues = RADAR_AXES.map((axis) => {
    let total = 0;
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = fmt(d);
      const data = byDate.get(key);
      if (!data) continue;
      for (const k of axis.keys) total += data.interactions[k] ?? 0;
    }
    return { label: axis.label, value: total };
  });
  drawRadarChart(chartRadar, radarValues);
}

// 雷达图：近 7 天互动类型分布（原生 SVG，6 轴）
function drawRadarChart(host: HTMLDivElement, axes: { label: string; value: number }[]): void {
  const CX = 170, CY = 92, R = 64;
  const n = axes.length;
  const pt = (i: number, r: number): [number, number] => {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [CX + r * Math.cos(ang), CY + r * Math.sin(ang)];
  };
  let grid = '';
  for (let ring = 1; ring <= 3; ring++) {
    const pts = axes.map((_, i) => pt(i, (R * ring) / 3).map((v) => v.toFixed(1)).join(',')).join(' ');
    grid += `<polygon points="${pts}" fill="none" stroke="#e5e7ec" stroke-width="1"></polygon>`;
  }
  const max = Math.max(1, ...axes.map((a) => a.value));
  const poly = axes.map((a, i) => pt(i, (a.value / max) * R).map((v) => v.toFixed(1)).join(',')).join(' ');
  const dots = axes.map((a, i) => {
    const [x, y] = pt(i, (a.value / max) * R);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#7aa2f7"></circle>`;
  }).join('');
  const labels = axes.map((a, i) => {
    const [x, y] = pt(i, R + 22);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="11" fill="#8a8f98">${a.label}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 340 200" style="width:100%;height:100%;display:block" role="img">
    ${grid}
    <polygon points="${poly}" fill="rgba(122,162,247,0.22)" stroke="#7aa2f7" stroke-width="2" stroke-linejoin="round"></polygon>
    ${dots}
    ${labels}
  </svg>`;
}

// 日记：最近 7 天互动摘要
async function loadDiary(): Promise<void> {
  try {
    const entries = await window.petAPI?.diary.list();
    if (!entries) return;
    diaryList.replaceChildren();
    drawCharts(entries);
    const recent = entries.slice(-7).reverse();
    if (recent.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'achievement-loading';
      empty.textContent = '还没有日记，去和她玩一会儿吧~';
      diaryList.appendChild(empty);
      return;
    }
    const INTERACTION_LABELS: Record<string, string> = {
      chat: '聊天', 'pet-head': '摸头', 'feed-snack': '喂食', sleep: '睡觉',
      wave: '挥手', dance: '跳舞', angry: '生气', cute: '撒娇', sleepy: '犯困',
      jump: '跳跃', shy: '害羞', cheer: '开心', sad: '委屈', surprise: '惊讶',
    };
    for (const entry of recent) {
      const row = document.createElement('div');
      row.className = 'diary-day';
      const head = document.createElement('div');
      head.className = 'diary-head';
      const date = document.createElement('span');
      date.className = 'diary-date';
      date.textContent = entry.date;
      const summary = document.createElement('span');
      summary.className = 'diary-summary';
      const total = Object.values(entry.interactions).reduce((a, b) => a + b, 0);
      const parts: string[] = [];
      if (total > 0) parts.push(`互动 ${total} 次`);
      if (entry.affectionGained > 0) parts.push(`+${entry.affectionGained} 好感`);
      if (entry.tomatoCompleted > 0) parts.push(`🍅 ×${entry.tomatoCompleted}`);
      summary.textContent = parts.join(' · ') || '安安静静的一天';
      head.append(date, summary);
      row.appendChild(head);
      const detail = document.createElement('div');
      detail.className = 'diary-detail';
      const detailParts = Object.entries(entry.interactions)
        .filter(([, count]) => count > 0)
        .map(([id, count]) => `${INTERACTION_LABELS[id] ?? id}×${count}`);
      const unlock = entry.achievementsUnlocked.length > 0 ? ` · 🏆 ${entry.achievementsUnlocked.join('、')}` : '';
      detail.textContent = detailParts.length > 0 ? detailParts.join('，') + unlock : (unlock ? `🏆 ${unlock.replace(' · ', '')}` : '');
      if (detail.textContent) row.appendChild(detail);
      diaryList.appendChild(row);
    }
  } catch (error) {
    console.error('Failed to load diary:', error);
    diaryList.replaceChildren();
    const err = document.createElement('div');
    err.className = 'achievement-loading';
    err.textContent = '日记加载失败（' + String((error as Error)?.message ?? error).slice(0, 40) + '）';
    diaryList.appendChild(err);
  }
}

function renderAchievements(items: { id: string; emoji: string; name: string; desc: string; unlocked: boolean; progress: number; target: number }[]): void {
  achievementsList.replaceChildren();
  for (const item of items) {
    const card = document.createElement('div');
    card.className = `achievement${item.unlocked ? ' unlocked' : ''}`;
    const emoji = document.createElement('div');
    emoji.className = 'achievement-emoji';
    emoji.textContent = item.emoji;
    const info = document.createElement('div');
    info.className = 'achievement-info';
    const name = document.createElement('div');
    name.className = 'achievement-name';
    name.textContent = item.unlocked ? item.name : `${item.name}（未解锁）`;
    name.title = item.desc;
    const progress = document.createElement('div');
    progress.className = 'achievement-progress';
    progress.textContent = item.unlocked ? item.desc : `${item.progress}/${item.target} · ${item.desc}`;
    info.append(name, progress);
    card.append(emoji, info);
    achievementsList.appendChild(card);
  }
}

// 关闭按钮
closeBtn.addEventListener('click', async () => {
  await window.petAPI?.window.hideDashboard();
});

// 置顶开关
toggleAlwaysOnTop.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.alwaysOnTop;
  try {
    await window.petAPI?.settings.update({ alwaysOnTop: newVal });
    currentSettings.alwaysOnTop = newVal;
    if (newVal) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 鼠标穿透开关
toggleClickThrough.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.clickThrough;
  try {
    await window.petAPI?.settings.update({ clickThrough: newVal });
    currentSettings.clickThrough = newVal;
    if (newVal) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 大小选择
sizeSelector.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('size-btn')) return;
  if (!currentSettings) return;

  const scale = parseFloat(target.dataset.scale || '1');
  try {
    await window.petAPI?.settings.update({ petScale: scale });
    currentSettings.petScale = scale;

    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => btn.classList.remove('active'));
    target.classList.add('active');
  } catch (error) {
    console.error('Failed to update pet scale:', error);
  }
});

// 监听统计数据更新
window.petAPI?.events.onStats((stats: PetStats) => {
  updateStats(stats);
});

// ===== 提醒预置模板（一键添加）=====
const reminderListEl = document.getElementById('reminder-list') as HTMLDivElement;
const reminderMsgEl = document.getElementById('reminder-msg') as HTMLDivElement;

const REMINDER_TEMPLATES: Record<string, { text: string; delayMs: number }> = {
  water: { text: '该喝水啦 💧 起来喝口水吧', delayMs: 45 * 60_000 },
  nap: { text: '该休息一下啦 😴 闭目养神几分钟', delayMs: 2 * 60 * 60_000 },
  stretch: { text: '站起来活动一下 🧍 伸个懒腰吧', delayMs: 60 * 60_000 },
};
const TEMPLATE_LABELS: Record<string, string> = { water: '喝水', nap: '午休', stretch: '站起来活动' };

async function renderReminders(): Promise<void> {
  try {
    const items = await window.petAPI?.reminders.list();
    if (!items) return;
    reminderListEl.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'achievement-loading';
      empty.textContent = '暂无提醒，点上面模板一键添加';
      reminderListEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'reminder-item';
      const text = document.createElement('span');
      text.className = 'reminder-item-text';
      text.textContent = item.text;
      const time = document.createElement('span');
      time.className = 'reminder-item-time';
      time.textContent = new Date(item.dueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const del = document.createElement('button');
      del.className = 'reminder-del';
      del.textContent = '🗑';
      del.title = '删除提醒';
      del.addEventListener('click', async () => {
        await window.petAPI?.reminders.remove(item.id);
        void renderReminders();
      });
      row.append(text, time, del);
      reminderListEl.appendChild(row);
    }
  } catch (error) {
    console.error('Failed to load reminders:', error);
  }
}

document.querySelectorAll('.reminder-tpl').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tpl = (btn as HTMLElement).dataset.template || '';
    const template = REMINDER_TEMPLATES[tpl];
    if (!template) return;
    try {
      await window.petAPI?.reminders.save({
        text: template.text,
        dueAt: new Date(Date.now() + template.delayMs).toISOString(),
      });
      reminderMsgEl.textContent = `已添加「${TEMPLATE_LABELS[tpl] ?? tpl}」提醒，到点她会提醒你`;
      reminderMsgEl.classList.remove('error');
      void renderReminders();
    } catch (error) {
      reminderMsgEl.textContent = '添加提醒失败';
      reminderMsgEl.classList.add('error');
    }
  });
});

// ===== 自定义互动（表单增删，立即生效）=====
const customListEl = document.getElementById('custom-list') as HTMLDivElement;
const customMsgEl = document.getElementById('custom-msg') as HTMLDivElement;
const customLabelEl = document.getElementById('custom-label') as HTMLInputElement;
const customEmojiEl = document.getElementById('custom-emoji') as HTMLInputElement;
const customStateEl = document.getElementById('custom-state') as HTMLSelectElement;
const customDurationEl = document.getElementById('custom-duration') as HTMLInputElement;
const customGainEl = document.getElementById('custom-gain') as HTMLInputElement;
const customFeedbackEl = document.getElementById('custom-feedback') as HTMLInputElement;
const customAddBtn = document.getElementById('custom-add-btn') as HTMLButtonElement;

function renderCustomItems(items: { id: string; emoji: string; label: string; stateId: string; feedback: string[] }[]): void {
  customListEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'achievement-loading';
    empty.textContent = '还没有自定义互动，填下面表单添加一个吧~';
    customListEl.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'custom-item';
    const info = document.createElement('div');
    info.className = 'custom-item-info';
    const name = document.createElement('div');
    name.className = 'custom-item-name';
    name.textContent = `${item.emoji} ${item.label}`;
    const meta = document.createElement('div');
    meta.className = 'custom-item-meta';
    meta.textContent = `动作：${item.stateId} · ${item.feedback.slice(0, 2).join(' / ')}${item.feedback.length > 2 ? '…' : ''}`;
    info.append(name, meta);
    const del = document.createElement('button');
    del.className = 'custom-del';
    del.textContent = '🗑';
    del.title = '删除';
    del.addEventListener('click', async () => {
      const res = await window.petAPI?.custom.remove(item.id);
      if (!res) return;
      if (!res.ok) {
        customMsgEl.textContent = res.error ?? '删除失败';
        customMsgEl.classList.add('error');
        return;
      }
      customMsgEl.textContent = '已删除，立即生效';
      customMsgEl.classList.remove('error');
      renderCustomItems(res.items);
    });
    row.append(info, del);
    customListEl.appendChild(row);
  }
}

async function loadCustom(): Promise<void> {
  try {
    const items = await window.petAPI?.custom.list();
    if (!items) return;
    renderCustomItems(items);
  } catch (error) {
    console.error('Failed to load custom interactions:', error);
    customListEl.replaceChildren();
    const err = document.createElement('div');
    err.className = 'achievement-loading';
    err.textContent = '自定义互动加载失败';
    customListEl.appendChild(err);
  }
}

function fillStateOptions(): void {
  const stateIds = ['bubble-only', ...(spec.states ?? []).map((st) => st.id)];
  for (const stateId of stateIds) {
    const opt = document.createElement('option');
    opt.value = stateId;
    opt.textContent = stateId === 'bubble-only' ? 'bubble-only（只冒气泡）' : stateId;
    customStateEl.appendChild(opt);
  }
}

customAddBtn.addEventListener('click', async () => {
  const label = customLabelEl.value.trim();
  const feedbackText = customFeedbackEl.value.trim();
  const feedback = feedbackText.split(/[,，、;；]/).map((f) => f.trim()).filter(Boolean);
  if (!label) {
    customMsgEl.textContent = '请先填写名称';
    customMsgEl.classList.add('error');
    return;
  }
  if (feedback.length < 2) {
    customMsgEl.textContent = '气泡文案至少 2 条（用逗号分隔）';
    customMsgEl.classList.add('error');
    return;
  }
  const input = {
    label,
    emoji: customEmojiEl.value.trim() || '✨',
    stateId: customStateEl.value,
    durationMs: Math.max(300, Math.min(10000, Number(customDurationEl.value) || 1600)),
    affectionGain: Math.max(0, Math.min(20, Number(customGainEl.value) || 1)),
    feedback,
  };
  const res = await window.petAPI?.custom.add(input);
  if (!res) return;
  if (!res.ok) {
    customMsgEl.textContent = res.error ?? '添加失败';
    customMsgEl.classList.add('error');
    return;
  }
  customMsgEl.textContent = '已添加，立即生效';
  customMsgEl.classList.remove('error');
  renderCustomItems(res.items);
  customLabelEl.value = '';
  customEmojiEl.value = '';
  customFeedbackEl.value = '';
  customDurationEl.value = '1600';
  customGainEl.value = '1';
});

// 初始化
async function init(): Promise<void> {
  await loadInteractions();
  await loadSettings();
  await loadStats();
  fillStateOptions();
  await loadCustom();
  await renderReminders();
}

init();

// 窗口重新获得焦点时刷新数据（日期滚动到今天）
window.addEventListener('focus', () => {
  void loadStats();
  void renderReminders();
});
