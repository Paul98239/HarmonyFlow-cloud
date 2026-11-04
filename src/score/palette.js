// palette.js — 演奏者的代表色與名稱：骨架（vision.js）、狀態列、樂譜視覺化共用，同一個人在每個地方都是同一個顏色。

// 演奏者 1～4（＝骨架 ID）的顏色，跟 vision.js 原本的骨架顏色相同；PC 鍵盤手用淡紫，跟四個 ID 都分得開
export const POSE_COLORS = Object.freeze(['#00FFFF', '#FF6B6B', '#51CF66', '#FFD43B']);
export const KEYBOARD_COLOR = '#C9A7FF';

export const slotColor = (slot) => (slot === 'kb' ? KEYBOARD_COLOR : POSE_COLORS[(Number(slot) - 1) % POSE_COLORS.length] ?? '#ccc');
export const slotName = (slot) => (slot === 'kb' ? 'PC 鍵盤手' : `演奏者 ${slot}`);
