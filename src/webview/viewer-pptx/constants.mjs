/*
 * Ported from pptxtojson (https://github.com/pipipi-pikachu/pptxtojson)
 * commit 2b12fceb1d1ca4e1436480afa485567dbd1101c4 — MIT License, Copyright (c) 2020-PRESENT pipipi-pikachu
 * Modified for fractal (sprint 20260823-165314, ADR-0010): renamed to .mjs / relative import specifiers
 * rewritten to .mjs. Further modifications (deps replacement, structured runs, EA fonts) are annotated in place.
 * See vendor/LICENSE-pptxtojson for the full license text. Do NOT edit the upstream logic without annotation.
 */
export const RATIO_Inches_EMUs = 914400 // 1英寸 = 914400EMUs
export const RATIO_Inches_Points = 72 // 1英寸 = 72pt
export const RATIO_EMUs_Points = RATIO_Inches_Points / RATIO_Inches_EMUs // 1EMUs = (72 / 914400)pt