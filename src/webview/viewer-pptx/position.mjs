/*
 * Ported from pptxtojson (https://github.com/pipipi-pikachu/pptxtojson)
 * commit 2b12fceb1d1ca4e1436480afa485567dbd1101c4 — MIT License, Copyright (c) 2020-PRESENT pipipi-pikachu
 * Modified for fractal (sprint 20260823-165314, ADR-0010): renamed to .mjs / relative import specifiers
 * rewritten to .mjs. Further modifications (deps replacement, structured runs, EA fonts) are annotated in place.
 * See vendor/LICENSE-pptxtojson for the full license text. Do NOT edit the upstream logic without annotation.
 */
import { RATIO_EMUs_Points } from './constants.mjs'
import { numberToFixed } from './utils.mjs'

export function getPosition(slideSpNode, slideLayoutSpNode, slideMasterSpNode) {
  let off

  if (slideSpNode) off = slideSpNode['a:off']['attrs']
  else if (slideLayoutSpNode) off = slideLayoutSpNode['a:off']['attrs']
  else if (slideMasterSpNode) off = slideMasterSpNode['a:off']['attrs']

  if (!off) return { top: 0, left: 0 }

  return {
    top: numberToFixed(parseInt(off['y']) * RATIO_EMUs_Points),
    left: numberToFixed(parseInt(off['x']) * RATIO_EMUs_Points),
  }
}

export function getSize(slideSpNode, slideLayoutSpNode, slideMasterSpNode) {
  let ext

  if (slideSpNode) ext = slideSpNode['a:ext']['attrs']
  else if (slideLayoutSpNode) ext = slideLayoutSpNode['a:ext']['attrs']
  else if (slideMasterSpNode) ext = slideMasterSpNode['a:ext']['attrs']

  if (!ext) return { width: 0, height: 0 }

  return {
    width: numberToFixed(parseInt(ext['cx']) * RATIO_EMUs_Points),
    height: numberToFixed(parseInt(ext['cy']) * RATIO_EMUs_Points),
  }
}