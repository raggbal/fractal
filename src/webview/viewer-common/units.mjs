/**
 * viewer-common/units.mjs — OOXML 単位変換（docx/pptx が消費）
 * 単位 3 系統: EMU（1inch=914,400）/ dxa（1/20pt）/ half-point（1/2pt）。CSS px は 96dpi。
 */

export const emuToPx = (v) => v / 9525;
export const dxaToPt = (v) => v / 20;
export const dxaToPx = (v) => (v / 20) * (4 / 3);
export const halfPtToPt = (v) => v / 2;
export const ptToPx = (v) => v * (4 / 3);
