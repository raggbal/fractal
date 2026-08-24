/*
 * Ported from pptxtojson (https://github.com/pipipi-pikachu/pptxtojson)
 * commit 2b12fceb1d1ca4e1436480afa485567dbd1101c4 — MIT License, Copyright (c) 2020-PRESENT pipipi-pikachu
 * Modified for fractal (sprint 20260823-165314, ADR-0010): renamed to .mjs / relative import specifiers
 * rewritten to .mjs. Further modifications (deps replacement, structured runs, EA fonts) are annotated in place.
 * See vendor/LICENSE-pptxtojson for the full license text. Do NOT edit the upstream logic without annotation.
 */
import { getTextByPathList } from './utils.mjs'
import { getShadow } from './shadow.mjs'
import { getFillType, getGradientFill, getSolidFill } from './fill.mjs'

function pushStyleNode(styleNodes, styleNode) {
  if (styleNode) styleNodes.push(styleNode)
}

function getLevelPath(lvl) {
  return `a:lvl${lvl}pPr`
}

function appendTextBodyStyleNodes(styleNodes, textBodyNode, lvl) {
  if (!textBodyNode) return

  const lvlPath = getLevelPath(lvl)
  pushStyleNode(styleNodes, getTextByPathList(textBodyNode, ['a:lstStyle', lvlPath, 'a:defRPr']))
}

function appendShapeStyleNodes(styleNodes, shapeNode, lvl) {
  if (!shapeNode) return

  const lvlPath = getLevelPath(lvl)
  pushStyleNode(styleNodes, getTextByPathList(shapeNode, ['p:txBody', 'a:lstStyle', lvlPath, 'a:defRPr']))
  pushStyleNode(styleNodes, getTextByPathList(shapeNode, ['p:txBody', 'a:p', 'a:pPr', 'a:defRPr']))
}

function appendMasterTextStyleNodes(styleNodes, type, lvl, slideMasterTextStyles) {
  if (!slideMasterTextStyles) return

  const lvlPath = getLevelPath(lvl)

  if (type === 'title' || type === 'ctrTitle' || type === 'subTitle') {
    pushStyleNode(styleNodes, getTextByPathList(slideMasterTextStyles, ['p:titleStyle', lvlPath, 'a:defRPr']))
    if (type === 'subTitle') {
      pushStyleNode(styleNodes, getTextByPathList(slideMasterTextStyles, ['p:bodyStyle', lvlPath, 'a:defRPr']))
    }
  }
  else if (type === 'body') {
    pushStyleNode(styleNodes, getTextByPathList(slideMasterTextStyles, ['p:bodyStyle', lvlPath, 'a:defRPr']))
  }
  else {
    pushStyleNode(styleNodes, getTextByPathList(slideMasterTextStyles, ['p:otherStyle', lvlPath, 'a:defRPr']))
  }
}

function appendDefaultTextStyleNodes(styleNodes, lvl, defaultTextStyle) {
  if (!defaultTextStyle) return

  const lvlPath = getLevelPath(lvl)
  pushStyleNode(styleNodes, getTextByPathList(defaultTextStyle, [lvlPath, 'a:defRPr']))
  pushStyleNode(styleNodes, getTextByPathList(defaultTextStyle, ['a:defPPr', 'a:defRPr']))
}

function getBaseFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, lvl) {
  const styleNodes = []
  const runStyleNode = getTextByPathList(node, ['a:rPr'])

  pushStyleNode(styleNodes, runStyleNode)
  if (!runStyleNode) {
    pushStyleNode(styleNodes, getTextByPathList(pNode, ['a:endParaRPr']))
  }
  pushStyleNode(styleNodes, getTextByPathList(pNode, ['a:pPr', 'a:defRPr']))

  appendTextBodyStyleNodes(styleNodes, textBodyNode, lvl)
  appendShapeStyleNodes(styleNodes, slideLayoutSpNode, lvl)
  appendShapeStyleNodes(styleNodes, slideMasterSpNode, lvl)

  return styleNodes
}

function getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl) {
  const styleNodes = getBaseFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, lvl)
  appendMasterTextStyleNodes(styleNodes, type, lvl, slideMasterTextStyles)

  return styleNodes
}

function getFontAttr(styleNodes, attrName) {
  for (const styleNode of styleNodes) {
    const attrValue = getTextByPathList(styleNode, ['attrs', attrName])
    if (attrValue !== undefined && attrValue !== '') return attrValue
  }

  return ''
}

// Modified for fractal (FR-PPV-03): latin / ea を**分離収集**（旧 = latin || ea の単一値 →
// 和欧混在 run で和文がフォールバック落ちする）
function getFontTypeface(styleNodes) {
  for (const styleNode of styleNodes) {
    const latin = getTextByPathList(styleNode, ['a:latin', 'attrs', 'typeface'])
    const ea = getTextByPathList(styleNode, ['a:ea', 'attrs', 'typeface'])
    if (latin || ea) return { latin: latin || '', ea: ea || '' }
  }

  return { latin: '', ea: '' }
}

function getColorFromNode(node, warpObj) {
  if (!node) return ''

  const fillType = getFillType(node)
  if (fillType === 'SOLID_FILL') {
    return getSolidFill(node['a:solidFill'], undefined, undefined, warpObj)
  }
  if (fillType === 'GRADIENT_FILL') {
    return getGradientFill(node['a:gradFill'], warpObj)
  }

  return ''
}

function getFontColorFromStyleNodes(styleNodes, warpObj) {
  for (const styleNode of styleNodes) {
    const color = getColorFromNode(styleNode, warpObj)
    if (color) return color
  }

  return ''
}

function getTextShadowFromStyleNodes(styleNodes, warpObj) {
  for (const styleNode of styleNodes) {
    const txtShadow = getTextByPathList(styleNode, ['a:effectLst', 'a:outerShdw'])
    if (!txtShadow) continue

    const shadow = getShadow(txtShadow, warpObj)
    if (shadow) return shadow
  }

  return null
}

// Modified for fractal (FR-PPV-03): latin/ea を各スロットでテーマ解決し、
// **font-family スタック**（"latin, ea"）として返す（EA 落ち防止 — TC-PPV-08）。
export function getFontType(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl, warpObj) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const collected = getFontTypeface(styleNodes)
  const fontSchemeNode = getTextByPathList(warpObj['themeContent'], ['a:theme', 'a:themeElements', 'a:fontScheme'])
  const themeFont = (slot, kind) => getTextByPathList(fontSchemeNode, [slot, kind, 'attrs', 'typeface'])
  const isMajor = type === 'title' || type === 'subTitle' || type === 'ctrTitle'
  const slotName = isMajor ? 'a:majorFont' : 'a:minorFont'

  const resolveSlot = (tf, kind) => {
    if (tf && tf.startsWith('+') && fontSchemeNode) {
      switch (tf) {
        case '+mj-lt': return themeFont('a:majorFont', 'a:latin')
        case '+mn-lt': return themeFont('a:minorFont', 'a:latin')
        case '+mj-ea': return themeFont('a:majorFont', 'a:ea')
        case '+mn-ea': return themeFont('a:minorFont', 'a:ea')
        default: return tf.replace(/^\+/, '')
      }
    }
    if (tf) return tf
    return themeFont(slotName, kind) || ''
  }

  const latin = resolveSlot(collected.latin, 'a:latin') || ''
  const ea = resolveSlot(collected.ea, 'a:ea') || ''
  const parts = []
  if (latin) parts.push(latin)
  if (ea && ea !== latin) parts.push(ea)
  return parts.join(', ')
}

export function getFontColor(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl, pFontStyle, warpObj) {
  const styleNodes = getBaseFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, lvl)
  let color = getFontColorFromStyleNodes(styleNodes, warpObj)

  if (!color) {
    if (pFontStyle) color = getSolidFill(pFontStyle, undefined, undefined, warpObj)
    if (!color) {
      const layoutFontStyle = getTextByPathList(slideLayoutSpNode, ['p:style', 'a:fontRef'])
      if (layoutFontStyle) color = getSolidFill(layoutFontStyle, undefined, undefined, warpObj)
    }
    if (!color) {
      const masterFontStyle = getTextByPathList(slideMasterSpNode, ['p:style', 'a:fontRef'])
      if (masterFontStyle) color = getSolidFill(masterFontStyle, undefined, undefined, warpObj)
    }
  }

  if (!color) {
    appendMasterTextStyleNodes(styleNodes, type, lvl, slideMasterTextStyles)
    color = getFontColorFromStyleNodes(styleNodes, warpObj)
  }

  return color || ''
}

export function getFontSize(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl, defaultTextStyle) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  appendDefaultTextStyleNodes(styleNodes, lvl, defaultTextStyle)
  const sz = getFontAttr(styleNodes, 'sz')
  let fontSize = sz ? parseInt(sz) / 100 : undefined

  if ((isNaN(fontSize) || !fontSize) && (type === 'dt' || type === 'sldNum')) fontSize = 12

  fontSize = (isNaN(fontSize) || !fontSize) ? 18 : fontSize

  return fontSize + 'pt'
}

export function getFontBold(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  return getFontAttr(styleNodes, 'b') === '1' ? 'bold' : ''
}

export function getFontItalic(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  return getFontAttr(styleNodes, 'i') === '1' ? 'italic' : ''
}

export function getFontDecoration(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  return getFontAttr(styleNodes, 'u') === 'sng' ? 'underline' : ''
}

export function getFontDecorationLine(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  return getFontAttr(styleNodes, 'strike') === 'sngStrike' ? 'line-through' : ''
}

export function getFontSpace(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const spc = getFontAttr(styleNodes, 'spc')
  return (spc && parseInt(spc) !== 0) ? (parseInt(spc) / 100 + 'pt') : ''
}

export function getFontSubscript(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const baseline = getFontAttr(styleNodes, 'baseline')
  if (!baseline || parseInt(baseline) === 0) return ''
  return parseInt(baseline) > 0 ? 'super' : 'sub'
}

export function getFontShadow(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl, warpObj) {
  const styleNodes = getFontStyleNodes(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const shadow = getTextShadowFromStyleNodes(styleNodes, warpObj)
  if (shadow) {
    const { h, v, blur, color } = shadow
    if (!isNaN(v) && !isNaN(h)) {
      return h + 'pt ' + v + 'pt ' + (blur ? blur + 'pt' : '') + ' ' + color
    }
  }
  return ''
}
