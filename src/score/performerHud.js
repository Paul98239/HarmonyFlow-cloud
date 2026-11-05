// performerHud.js — 演奏者狀態列（index.html 的 #performer-hud）：每位演奏者一格，寫他是誰、目前的演奏模式、演奏中／落後／代打中…、智能切換的建議或剛切換的原因。
// 每 200ms 讀一次排程器的輕量狀態（scheduler.js 的 viewState()），文字沒變就不寫 DOM：不佔主執行緒。

import { MODE_LABELS, REASON_TEXT } from '../midi/modeAdvisor.js';
import { slotColor, slotName } from './palette.js';

const REFRESH_MS = 200;
const SWITCH_NOTE_MS = 5000;   // 自動切換之後，「已切換成…」的說明留這麼久
const ABSENT_HINT_MS = 1500;   // 揮手的人不在鏡頭裡這麼久，就提示他面向鏡頭

const STATE_TEXT = {
  waiting: '等待進場',
  playing: '演奏中',
  behind: '落後了・再來一下',
  resting: '休息中',
  substitute: '電腦代打・再來一下接回',
  done: '已奏完',
};
// 鍵盤與揮手的「再來一下」說法不同
// 狀態一行要放得下（格子寬 14em）：短句、動詞在前
const behindText = (slot) => (slot === 'kb' ? '落後了・按下一個音' : '落後了・跟著拍子揮');
const subText = (slot) => (slot === 'kb' ? '電腦代打・按一下接回' : '電腦代打・揮一下接回');
// 建議與切換的原因：格子裡放短的版本，完整說明放在 title（滑鼠移過去看得到）
const REASON_SHORT = { mash: '按得太密', lost: '跟不上合奏', pulse: '照拍子在按', rhythm: '照每個音在按', steady: '每一下都很準' };

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
    if (e.reason && e.reason !== 'user' && e.from !== e.mode) switched.set(e.slot, { text: `已改用${MODE_LABELS[e.mode]}（${REASON_SHORT[e.reason] ?? ''}）`, full: REASON_TEXT[e.reason] ?? '', until: performance.now() + SWITCH_NOTE_MS });
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
      // 演奏中只要知道「現在是哪一層」；是不是自動、誰帶頭這種細節不放大
      const modeText = MODE_LABELS[p.mode];
      // 揮手的人不在鏡頭裡超過 ABSENT_HINT_MS：先請他面向鏡頭（MediaPipe 要看得到臉才找得到人）
      const away = p.slot !== 'kb' && p.absentMs > ABSENT_HINT_MS && p.state !== 'done';
      const stateText = away ? (p.state === 'substitute' ? '電腦代打・請面向鏡頭' : '看不到你・請面向鏡頭')
        : p.state === 'behind' ? behindText(p.slot) : p.state === 'substitute' ? subText(p.slot) : STATE_TEXT[p.state] ?? '';
      const sw = switched.get(p.slot);
      let tip = '', tipFull = '';
      if (sw && sw.until > now) { tip = sw.text; tipFull = sw.full; }
      else if (p.suggestion && (p.setting !== 'auto' || p.suggestion.mode === 'musician')) {
        tip = `建議：${MODE_LABELS[p.suggestion.mode]}（${REASON_SHORT[p.suggestion.reason] ?? ''}）`;
        tipFull = REASON_TEXT[p.suggestion.reason] ?? '';
      }
      const key = `${modeText}|${p.state}|${stateText}|${tip}|${p.isLeader}|${away}`;
      if (c.key !== key) {
        c.key = key;
        c.mode.textContent = modeText;
        c.el.classList.toggle('is-leader', p.isLeader && performers.length > 1);
        c.state.textContent = stateText;
        c.tip.textContent = tip;
        c.tip.title = tipFull;
        c.el.dataset.state = away ? 'behind' : p.state;
      }
      if (root.children[performers.indexOf(p)] !== c.el) root.insertBefore(c.el, root.children[performers.indexOf(p)] ?? null);   // 跟樂譜的條同一個順序
    }
    for (const [slot, c] of chips) if (!seen.has(slot)) { c.el.remove(); chips.delete(slot); }
  };
  setInterval(refresh, REFRESH_MS);
}
