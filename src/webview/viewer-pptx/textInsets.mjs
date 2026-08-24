/*
 * Ported from pptxtojson (https://github.com/pipipi-pikachu/pptxtojson)
 * commit 2b12fceb1d1ca4e1436480afa485567dbd1101c4 — MIT License, Copyright (c) 2020-PRESENT pipipi-pikachu
 * Modified for fractal (sprint 20260823-165314, ADR-0010): renamed to .mjs / relative import specifiers
 * rewritten to .mjs. Further modifications (deps replacement, structured runs, EA fonts) are annotated in place.
 * See vendor/LICENSE-pptxtojson for the full license text. Do NOT edit the upstream logic without annotation.
 */
import { getTextByPathList, numberToFixed } from './utils.mjs'
import { RATIO_EMUs_Points } from './constants.mjs'

const DEFAULT_INSET_EMU = {
  lIns: 91440, // 0.1 in
  rIns: 91440, // 0.1 in
  tIns: 45720, // 0.05 in
  bIns: 45720, // 0.05 in
}

function getInsetAttr(slideNode, layoutNode, masterNode, attrName) {
  let v = getTextByPathList(slideNode, ['p:txBody', 'a:bodyPr', 'attrs', attrName])
  if (v !== undefined && v !== null && v !== '') return v

  v = getTextByPathList(layoutNode, ['p:txBody', 'a:bodyPr', 'attrs', attrName])
  if (v !== undefined && v !== null && v !== '') return v

  return getTextByPathList(masterNode, ['p:txBody', 'a:bodyPr', 'attrs', attrName])
}

function emuToPt(emuStr) {
  if (emuStr === undefined || emuStr === null || emuStr === '') return null
  const v = parseInt(emuStr, 10)
  if (!Number.isFinite(v)) return null
  return numberToFixed(v * RATIO_EMUs_Points)
}

export function getTextInsets(node, slideLayoutSpNode, slideMasterSpNode) {
  const nodeBodyPr = getTextByPathList(node, ['p:txBody', 'a:bodyPr'])
  const layoutBodyPr = getTextByPathList(slideLayoutSpNode, ['p:txBody', 'a:bodyPr'])
  const masterBodyPr = getTextByPathList(slideMasterSpNode, ['p:txBody', 'a:bodyPr'])

  if (!nodeBodyPr) {
    if (!layoutBodyPr) {
      if (!masterBodyPr) return null
    }
  }

  let li = getInsetAttr(node, slideLayoutSpNode, slideMasterSpNode, 'lIns')
  if (li === undefined || li === null || li === '') li = DEFAULT_INSET_EMU.lIns

  let ti = getInsetAttr(node, slideLayoutSpNode, slideMasterSpNode, 'tIns')
  if (ti === undefined || ti === null || ti === '') ti = DEFAULT_INSET_EMU.tIns

  let ri = getInsetAttr(node, slideLayoutSpNode, slideMasterSpNode, 'rIns')
  if (ri === undefined || ri === null || ri === '') ri = DEFAULT_INSET_EMU.rIns

  let bi = getInsetAttr(node, slideLayoutSpNode, slideMasterSpNode, 'bIns')
  if (bi === undefined || bi === null || bi === '') bi = DEFAULT_INSET_EMU.bIns

  let l = emuToPt(li)
  if (l === null) l = 0

  let t = emuToPt(ti)
  if (t === null) t = 0

  let r = emuToPt(ri)
  if (r === null) r = 0

  let b = emuToPt(bi)
  if (b === null) b = 0

  return { l, t, r, b }
}
