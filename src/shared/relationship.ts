/**
 * 亲密度体验：主进程文件受模板契约保护不能改，所以分级文案全部在渲染层实现。
 * 主进程照常从 pet-spec.json 给基础文案；高亲密度时渲染层用更亲昵的句子替换气泡。
 */

export type AffectionLevel = 0 | 1 | 2 | 3 | 4;

export function affectionLevel(affection: number): AffectionLevel {
  if (affection >= 280) return 4;
  if (affection >= 240) return 3;
  if (affection >= 160) return 2;
  if (affection >= 60) return 1;
  return 0;
}

/** 按动作状态的高亲密度亲昵短句。 */
const WARM_BY_STATE: Record<string, string[]> = {
  chat: [
    "你今天好像心情不错呀",
    "嘿嘿，跟你聊天最开心了",
    "你不在的时候我有乖乖想你",
    "要不要陪我坐一会儿？",
    "跟你待在一起时间过得好快",
  ],
  pet: [
    "再用力一点点嘛~",
    "被你摸头真的好幸福",
    "蹭蹭你的手心",
    "你是不是只喜欢我一个？",
    "舒服到想打呼噜",
  ],
  eat: [
    "有你喂我，饼干都变好吃了",
    "下次还喂我好不好",
    "吧唧吧唧，你喂的最香",
    "这个味道像小时候",
  ],
  sleep: [
    "有你在旁边，我睡得更香",
    "抱着枕头眯一会儿…",
    "醒来第一眼想看到你",
    "做了个甜甜的梦",
  ],
  jump: ["和你一起蹦跶最开心", "再高一点也不怕！"],
  shy: ["被你弄得不好意思啦", "脸好烫…别看我"],
  cheer: ["看到你就忍不住挥手", "你回来啦！"],
  sad: ["抱抱我就不哭了", "你哄哄我嘛"],
  surprise: ["被你吓到啦", "心跳都漏了一拍"],
};

/**
 * 互动气泡是否替换成亲昵句。
 * level0：不替换；level1：一半概率；level2：七成概率。
 */
export function maybeWarmReply(stateId: string | undefined, affection: number): string | null {
  if (!stateId) return null;
  const pool = WARM_BY_STATE[stateId];
  if (!pool || pool.length === 0) return null;
  const level = affectionLevel(affection);
  if (level === 0) return null;
  const chance = level === 1 ? 0.5 : 0.7;
  if (Math.random() > chance) return null;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

/** 空闲时自己冒的句子，按亲密度分三档。 */
export const SELF_TALK: Record<AffectionLevel, string[]> = {
  0: [
    "今天天气不错呢",
    "……发呆中",
    "在忙吗？",
    "安安静静也挺好",
    "我在这儿陪着你哦",
    "随便看看窗外",
    "嗯？你叫我吗",
    "今天也辛苦啦",
  ],
  1: [
    "嘿嘿，你在忙什么呀",
    "偷偷看你一眼~",
    "今天过得好快",
    "记得起来动一动哦",
    "喝口水吧",
    "你认真做事的样子还挺好看",
    "我给你加油呀",
    "要不要歇会儿",
  ],
  2: [
    "你怎么才理我呀",
    "一直都在想你呢",
    "多陪我一会儿嘛",
    "今天也最喜欢你啦",
    "想一直黏着你",
    "你是我最重要的人",
    "累了就抱抱我",
    "我们要一直在一起哦",
  ],
  3: [
    "今天也元气满满地陪你呀",
    "你低头的样子我都记在心里啦",
    "全世界最懂我的就是你",
    "牵好我的手，不许走丢哦",
    "你是我超级重要的人",
    "我好像比昨天更喜欢你一点",
    "就算不说话，待着也安心",
    "你把我的世界都点亮啦",
  ],
  4: [
    "和你在一起，每一天都是纪念日",
    "这世界那么大，还好有你",
    "想陪你很久很久很久",
    "你的出现就是最好的礼物",
    "看到你，我的心就亮晶晶的",
    "不管多久，我都会在这里等你",
    "你就是我全部的星光呀",
  ],
};

/** 心情低落时的互动回应（mood < 30）。 */
export const LOW_MOOD_REPLIES: string[] = [
  "嗯…有点累",
  "还好啦",
  "今天有点闷闷的",
  "让我安静一会儿",
  "心情不太美丽…",
  "你陪陪我就好",
];

/** 按月份返回季节/节日台词，叠加在自言自语里。 */
export function seasonalLines(now: Date = new Date()): string[] {
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if (m === 1 && d === 1) return ["新年快乐！新的一年也要一起呀", "元旦快乐，许个愿吧~"];
  if (m === 2 && d === 14) return ["情人节快乐呀", "今天是甜甜的日子~"];
  if (m === 5 && d === 1) return ["五一快乐，好好休息", "假期到啦，放松一下"];
  if (m === 10 && d === 1) return ["国庆快乐~", "长假玩得开心吗"];
  if (m === 12 && d === 24) return ["平安夜，暖暖和和的", "圣诞快乐呀🎄"];
  if (m === 12 && d === 25) return ["圣诞快乐！", "想要你的抱抱当礼物"];
  if (m === 12 && d === 31) return ["跨年啦，这一年谢谢你", "明年也一起走下去"];
  if (m === 3 || m === 4 || m === 5) return ["春天啦，该出去晒晒太阳", "花开得正好呢"];
  if (m === 6 || m === 7 || m === 8) return ["夏天好热，记得多喝水", "午后有点犯困了呢"];
  if (m === 9 || m === 10 || m === 11) return ["秋天到了，天凉加件衣服", "桂花香香的~"];
  return ["冬天好冷，缩成一团", "注意保暖别感冒啦"];
}

/** 按一天时段返回台词，周末/工作日语气不同。 */
export function timeAwareLines(now: Date = new Date()): string[] {
  const hour = now.getHours();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  if (hour >= 5 && hour < 9) return isWeekend
    ? ["早呀，睡饱了吗？", "周末的早晨最舒服了", "赖床多一会儿也没关系"]
    : ["早呀，今天也要加油", "起床气散了吗？", "吃早饭了吗~"];
  if (hour >= 9 && hour < 12) return isWeekend
    ? ["上午啦，想做点什么呀", "慢悠悠的周末真好"]
    : ["上午精神最好，冲呀", "记得抬头看看远处", "忙的话我安静陪着"];
  if (hour >= 12 && hour < 18) return isWeekend
    ? ["下午茶时间到~", "出去走走嘛", "阳光正好，适合发呆"]
    : ["午后容易犯困哦", "喝口水，歇一会儿", "下午也要元气满满"];
  if (hour >= 18 && hour < 23) return isWeekend
    ? ["晚上啦，放松一下吧", "今天玩得开心吗", "夜色真好看"]
    : ["辛苦一天啦，该下班了吧", "晚上想吃点什么", "到家了就可以歇歇啦"];
  return ["这么晚还不睡呀？", "熬夜会变丑的哦", "早点休息，我守着你"];
}

/** 合并三档自言自语 + 当季台词 + 时间台词。 */
export function selfTalkPool(affection: number, now: Date = new Date()): string[] {
  const level = affectionLevel(affection);
  return [...(SELF_TALK[level] ?? []), ...seasonalLines(now), ...timeAwareLines(now)];
}
