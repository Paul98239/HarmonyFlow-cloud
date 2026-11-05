// layout.js — 舞台版面的共用狀態：樂譜面板佔掉舞台底部多少（比例 0～1）。scoreView.js 在面板顯示、隱藏、改變大小時寫入，vision.js 畫骨架時讀。
// 攝影機畫面是永久黑幕（見 styles.css 的 #stage-blackout），骨架不必對齊任何影像，所以整個鏡頭範圍可以等比例縮放到面板上方，人不會被面板蓋住。

let reservedBottom = 0;   // 面板頂端以下佔舞台高度的比例（含一點間距）；面板沒顯示時 0
let reservedTop = 0;      // 頂端工具列（播放 pill、控制列）蓋到舞台的比例
const clampF = (f) => Math.min(0.6, Math.max(0, Number.isFinite(f) ? f : 0));
export const getReservedBottom = () => reservedBottom;
export const getReservedTop = () => reservedTop;
export function setReservedBottom(f) { reservedBottom = clampF(f); }
export function setReservedTop(f) { reservedTop = clampF(f); }
