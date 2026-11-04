// performerHud.js — 演奏者狀態列（index.html 的 #performer-hud）：每位演奏者一格，寫他是誰、目前的演奏模式、演奏中／落後／代打中…、智能切換的建議或剛切換的原因。
// 每 200ms 讀一次排程器的輕量狀態（scheduler.js 的 viewState()），文字沒變就不寫 DOM：不佔主執行緒。

import { MODE_LABELS, REASON_TEXT } from '../midi/modeAdvisor.js';
import { slotColor, slotName } from './palette.js';

const REFRESH_MS = 200;
const SWITCH_NOTE_MS = 5000;   // 自動切換之後，「已切換成…」的說明留這麼久

const STATE_TEXT = {
  waiting: '等待進場',
  playing: '演奏中',
  behind: '落後了，跟著亮點再來一下',
  resting: '休息中',
  substitute: '電腦代打中・再來一下就接回來',
  done: '已奏完',
};
// 鍵盤與揮手的「再來一下」說法不同
const behindText = (slot) => (slot === 'kb' ? '落後了，按下一個音' : '落後了，跟著拍子揮一下');
const subText = (slot) => (slot === 'kb' ? '電腦代打中・按一下就接回來' : '電腦代打中・揮一下就接回來');

/**
 * @param {{ getView: () => object, isActive: () => boolean, onModeEvent?: (fn) => void }} deps
 *   getView＝midiPlayer.performerView；isActive＝要不要顯示（播放中或暫停中）；
 */
export function startPerformerHud({ getView, isActive, subscribeMode }) {
  const root = document.getElementById('performer-hud');
  if (!root) return;
  const chips = new Map();           // slot → { el, who, mode, state, tip, key }
  const switched = new Map();        // slot → { text, until }
  subscribeMode?.((e) => {
    if (e.reason && e.reason !== 'user' && e.from !== e.mode) switched.set(e.slot, { text: `已切換成「${MODE_LABELS[e.mode]}」：${REASON_TEXT[e.reason] ?? ''}`, until: performance.now() + SWITCH_NOTE_MS });
  });

  const chipFor = (slot) => {
    let c = chips.get(slot);
    if (c) return c;
    const el = document.createElement('div');
    el.className = 'hud-chip';
    el.style.setProperty('--hud-color', slotColor(slot));
    const line = document.createElement('div'); line.className = 'hud-line';
    const who = document.createElement('span'); who.className = 'hud-who'; who.textContent = slotName(slot);
    const mode = document.createElement('span'); mode.className = 'hud-mode';
    line.append(who, mode);
    const state = document.createElement('div'); state.className = 'hud-state';
    const tip = document.createElement('div'); tip.className = 'hud-tip';
    el.append(line, state, tip);
    c = { el, mode, state, tip, key: '' };
    chips.set(slot, c);
    return c;
  };

  const refresh = () => {
    const active = isActive();
    let view = null;
    try { view = active ? getView() : null; } catch { view = null; }
    const performers = view?.performers ?? [];
    if (!active || performers.length === 0) return;   // 面板的顯示與否由 scoreView.js 決定
    const now = performance.now();
    const seen = new Set();
    for (const p of performers) {
      seen.add(p.slot);
      const c = chipFor(p.slot);
      const modeText = p.setting === 'auto' ? `自動・${MODE_LABELS[p.mode]}` : MODE_LABELS[p.mode];
      const stateText = p.state === 'behind' ? behindText(p.slot) : p.state === 'substitute' ? subText(p.slot) : STATE_TEXT[p.state] ?? '';
      const sw = switched.get(p.slot);
      let tip = '';
      if (sw && sw.until > now) tip = sw.text;
      else if (p.suggestion && p.setting !== 'auto') tip = `建議改用「${MODE_LABELS[p.suggestion.mode]}」：${REASON_TEXT[p.suggestion.reason] ?? ''}`;
      else if (p.suggestion?.mode === 'musician') tip = `可以試試「音樂家」：${REASON_TEXT.steady}`;
      const key = `${modeText}|${p.state}|${stateText}|${tip}|${p.isLeader}`;
      if (c.key !== key) {
        c.key = key;
        c.mode.textContent = modeText + (p.isLeader && performers.length > 1 ? '・帶頭' : '');
        c.state.textContent = stateText;
        c.tip.textContent = tip;
        c.el.dataset.state = p.state;
      }
      if (root.children[performers.indexOf(p)] !== c.el) root.insertBefore(c.el, root.children[performers.indexOf(p)] ?? null);   // 跟樂譜的條同一個順序
    }
    for (const [slot, c] of chips) if (!seen.has(slot)) { c.el.remove(); chips.delete(slot); }
  };
  setInterval(refresh, REFRESH_MS);
}
