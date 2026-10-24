/**
 * 软萌音效：真实采样 wav 在内存里 base64 解码，用 Web Audio 直接播放，
 * 绕开 CSP 对 data: media 的限制（不用 <audio>/new Audio）。
 */
import { POP_URL, HAPPY_URL, EAT_URL, SHY_URL, SAD_URL, CHEER_URL, PET_URL, SLEEP_URL, DANCE_URL, ANGRY_URL, CUTE_URL, SLEEPY_URL } from './sounds-data';

let enabled = true;
let ctx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function dataUriToArrayBuffer(uri: string): ArrayBuffer {
  const base64 = uri.slice(uri.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function ensureBuffer(key: string, url: string): Promise<AudioBuffer | null> {
  const cached = buffers.get(key);
  if (cached) return cached;
  const ac = audio();
  if (!ac) return null;
  try {
    const buf = await ac.decodeAudioData(dataUriToArrayBuffer(url));
    buffers.set(key, buf);
    return buf;
  } catch {
    return null;
  }
}

const SAMPLES: Record<string, string> = {
  pop: POP_URL,
  happy: HAPPY_URL,
  jump: HAPPY_URL,
  eat: EAT_URL,
  feed: EAT_URL,
  shy: SHY_URL,
  surprise: POP_URL,
  sad: SAD_URL,
  cheer: CHEER_URL,
  wave: CHEER_URL,
  pet: PET_URL,
  sleep: SLEEP_URL,
  dance: DANCE_URL,
  angry: ANGRY_URL,
  cute: CUTE_URL,
  sleepy: SLEEPY_URL,
};

function playBuffer(buf: AudioBuffer): void {
  const ac = audio();
  if (!ac) return;
  const src = ac.createBufferSource();
  src.buffer = buf;
  // 随机 ±5% 变调，同一句重复播放不显机械
  src.playbackRate.value = 0.95 + Math.random() * 0.1;
  const gain = ac.createGain();
  gain.gain.value = 0.7;
  src.connect(gain).connect(ac.destination);
  src.start();
}

function playSample(key: string): void {
  const url = SAMPLES[key];
  if (!url) return;
  void ensureBuffer(key, url).then((buf) => { if (buf) playBuffer(buf); });
}

/** 点她。 */
export function playPop(): void {
  if (!enabled) return;
  playSample('pop');
}

/** 不同互动情绪配对应音。 */
export function playInteraction(stateId: string | undefined): void {
  if (!enabled || !stateId) return;
  if (SAMPLES[stateId]) { playSample(stateId); return; }
  // 未采样的状态用极轻合成音兜底
  tone(700, 950, 110, 'sine', 0.06);
}

function tone(freqStart: number, freqEnd: number, durationMs: number, type: OscillatorType = 'sine', volume = 0.08): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqStart, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + durationMs / 1000);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + durationMs / 1000 + 0.05);
}

export function setSoundEnabled(on: boolean): void { enabled = on; }
export function isSoundEnabled(): boolean { return enabled; }
