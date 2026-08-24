/*
 * Ported from pptxtojson (https://github.com/pipipi-pikachu/pptxtojson)
 * commit 2b12fceb1d1ca4e1436480afa485567dbd1101c4 — MIT License, Copyright (c) 2020-PRESENT pipipi-pikachu
 * Modified for fractal (sprint 20260823-165314, ADR-0010): renamed to .mjs / relative import specifiers
 * rewritten to .mjs. Further modifications (deps replacement, structured runs, EA fonts) are annotated in place.
 * See vendor/LICENSE-pptxtojson for the full license text. Do NOT edit the upstream logic without annotation.
 */
import tinycolor from './color-util.mjs' // Modified for fractal (ADR-0010)
import { getSolidFill } from './fill.mjs'
import { getSchemeColorFromTheme } from './schemeColor.mjs'
import { getTextByPathList } from './utils.mjs'

function getLineEnd(node) {
  const attrs = getTextByPathList(node, ['attrs'])
  if (!attrs) return undefined

  const lineEnd = { type: attrs.type || 'none' }
  if (attrs.w) lineEnd.width = attrs.w
  if (attrs.len) lineEnd.length = attrs.len
  return lineEnd
}

export function getBorder(node, elType, warpObj) {
  let lineNode = getTextByPathList(node, ['p:spPr', 'a:ln'])
  if (!lineNode) {
    const lnRefNode = getTextByPathList(node, ['p:style', 'a:lnRef'])
    if (lnRefNode) {
      const lnIdx = getTextByPathList(lnRefNode, ['attrs', 'idx'])
      lineNode = warpObj['themeContent']['a:theme']['a:themeElements']['a:fmtScheme']['a:lnStyleLst']['a:ln'][Number(lnIdx) - 1]
    }
  }
  if (!lineNode) lineNode = node

  const isNoFill = getTextByPathList(lineNode, ['a:noFill'])

  let borderWidth = isNoFill ? 0 : (parseInt(getTextByPathList(lineNode, ['attrs', 'w'])) / 12700)
  if (isNaN(borderWidth)) {
    if (lineNode) borderWidth = 0
    else if (elType !== 'obj') borderWidth = 0
    else borderWidth = 1
  }

  const solidFill = getTextByPathList(lineNode, ['a:solidFill'])
  let borderColor = getSolidFill(solidFill, undefined, undefined, warpObj)

  if (!borderColor) {
    const schemeClrNode = getTextByPathList(node, ['p:style', 'a:lnRef', 'a:schemeClr'])
    const schemeClr = 'a:' + getTextByPathList(schemeClrNode, ['attrs', 'val'])
    borderColor = getSchemeColorFromTheme(schemeClr, warpObj)

    if (borderColor) {
      let shade = getTextByPathList(schemeClrNode, ['a:shade', 'attrs', 'val'])

      if (shade) {
        shade = parseInt(shade) / 100000
        
        const color = tinycolor('#' + borderColor).toHsl()
        borderColor = tinycolor({ h: color.h, s: color.s, l: color.l * shade, a: color.a }).toHex()
      }
    }
  }

  if (!borderColor) borderColor = '#000000'
  else if (!borderColor.startsWith('#')) borderColor = `#${borderColor}`

  const type = getTextByPathList(lineNode, ['a:prstDash', 'attrs', 'val'])
  let borderType = 'solid'
  let strokeDasharray = '0'
  switch (type) {
    case 'solid':
      borderType = 'solid'
      strokeDasharray = '0'
      break
    case 'dash':
      borderType = 'dashed'
      strokeDasharray = '5'
      break
    case 'dashDot':
      borderType = 'dashed'
      strokeDasharray = '5, 5, 1, 5'
      break
    case 'dot':
      borderType = 'dotted'
      strokeDasharray = '1, 5'
      break
    case 'lgDash':
      borderType = 'dashed'
      strokeDasharray = '10, 5'
      break
    case 'lgDashDotDot':
      borderType = 'dotted'
      strokeDasharray = '10, 5, 1, 5, 1, 5'
      break
    case 'sysDash':
      borderType = 'dashed'
      strokeDasharray = '5, 2'
      break
    case 'sysDashDot':
      borderType = 'dotted'
      strokeDasharray = '5, 2, 1, 5'
      break
    case 'sysDashDotDot':
      borderType = 'dotted'
      strokeDasharray = '5, 2, 1, 5, 1, 5'
      break
    case 'sysDot':
      borderType = 'dotted'
      strokeDasharray = '2, 5'
      break
    default:
  }

  const headEnd = getLineEnd(getTextByPathList(lineNode, ['a:headEnd']))
  const tailEnd = getLineEnd(getTextByPathList(lineNode, ['a:tailEnd']))

  return {
    borderColor,
    borderWidth,
    borderType,
    strokeDasharray,
    headEnd,
    tailEnd,
  }
}
