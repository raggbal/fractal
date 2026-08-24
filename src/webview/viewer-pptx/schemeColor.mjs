/*
 * Ported from pptxtojson (https://github.com/pipipi-pikachu/pptxtojson)
 * commit 2b12fceb1d1ca4e1436480afa485567dbd1101c4 — MIT License, Copyright (c) 2020-PRESENT pipipi-pikachu
 * Modified for fractal (sprint 20260823-165314, ADR-0010): renamed to .mjs / relative import specifiers
 * rewritten to .mjs. Further modifications (deps replacement, structured runs, EA fonts) are annotated in place.
 * See vendor/LICENSE-pptxtojson for the full license text. Do NOT edit the upstream logic without annotation.
 */
import { getTextByPathList } from './utils.mjs'

export function getSchemeColorFromTheme(schemeClr, warpObj, clrMap, phClr) {
  let color
  let slideLayoutClrOvride
  if (clrMap) slideLayoutClrOvride = clrMap
  else {
    let sldClrMapOvr = getTextByPathList(warpObj['slideContent'], ['p:sld', 'p:clrMapOvr', 'a:overrideClrMapping', 'attrs'])
    if (sldClrMapOvr) slideLayoutClrOvride = sldClrMapOvr
    else {
      sldClrMapOvr = getTextByPathList(warpObj['slideLayoutContent'], ['p:sldLayout', 'p:clrMapOvr', 'a:overrideClrMapping', 'attrs'])
      if (sldClrMapOvr) slideLayoutClrOvride = sldClrMapOvr
      else {
        slideLayoutClrOvride = getTextByPathList(warpObj['slideMasterContent'], ['p:sldMaster', 'p:clrMap', 'attrs'])
      }
    }
  }
  const schmClrName = schemeClr.substr(2)
  if (schmClrName === 'phClr' && phClr) color = phClr
  else {
    if (slideLayoutClrOvride) {
      switch (schmClrName) {
        case 'tx1':
        case 'tx2':
        case 'bg1':
        case 'bg2':
          schemeClr = 'a:' + slideLayoutClrOvride[schmClrName]
          break
        default:
          break
      }
    }
    else {
      switch (schmClrName) {
        case 'tx1':
          schemeClr = 'a:dk1'
          break
        case 'tx2':
          schemeClr = 'a:dk2'
          break
        case 'bg1':
          schemeClr = 'a:lt1'
          break
        case 'bg2':
          schemeClr = 'a:lt2'
          break
        default:
          break
      }
    }
    const refNode = getTextByPathList(warpObj['themeContent'], ['a:theme', 'a:themeElements', 'a:clrScheme', schemeClr])
    color = getTextByPathList(refNode, ['a:srgbClr', 'attrs', 'val'])
    if (!color && refNode) color = getTextByPathList(refNode, ['a:sysClr', 'attrs', 'lastClr'])
  }
  return color
}