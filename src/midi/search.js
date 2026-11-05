// search.js — 遞增陣列的二分搜尋（排程器、拍線、樂譜畫面共用）。x 可以是 ±Infinity。

/** 第一個 ≥ x 的位置（lower bound） */
export function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** 第一個 > x 的位置（upper bound） */
export function upperBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}
