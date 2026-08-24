/*
 * Ported from pptxtojson (https://github.com/pipipi-pikachu/pptxtojson)
 * commit 2b12fceb1d1ca4e1436480afa485567dbd1101c4 — MIT License, Copyright (c) 2020-PRESENT pipipi-pikachu
 * Modified for fractal (sprint 20260823-165314, ADR-0010): renamed to .mjs / relative import specifiers
 * rewritten to .mjs. Further modifications (deps replacement, structured runs, EA fonts) are annotated in place.
 * See vendor/LICENSE-pptxtojson for the full license text. Do NOT edit the upstream logic without annotation.
 */
import { getSolidFill } from './fill.mjs'
import { RATIO_EMUs_Points } from './constants.mjs'

export function getShadow(node, warpObj) {
  const chdwClrNode = getSolidFill(node, undefined, undefined, warpObj)
  const outerShdwAttrs = node['attrs']
  const dir = outerShdwAttrs['dir'] ? (parseInt(outerShdwAttrs['dir']) / 60000) : 0
  const dist = outerShdwAttrs['dist'] ? parseInt(outerShdwAttrs['dist']) * RATIO_EMUs_Points : 0
  const blurRad = outerShdwAttrs['blurRad'] ? parseInt(outerShdwAttrs['blurRad']) * RATIO_EMUs_Points : ''
  const vx = dist * Math.sin(dir * Math.PI / 180)
  const hx = dist * Math.cos(dir * Math.PI / 180)

  return {
    h: hx,
    v: vx,
    blur: blurRad,
    color: chdwClrNode,
  }
}