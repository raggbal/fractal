/*
 * Ported from pptxtojson (https://github.com/pipipi-pikachu/pptxtojson)
 * commit 2b12fceb1d1ca4e1436480afa485567dbd1101c4 — MIT License, Copyright (c) 2020-PRESENT pipipi-pikachu
 * Modified for fractal (sprint 20260823-165314, ADR-0010): genTextBody を **構造化 runs 出力**へ書き直し
 * — upstream の HTML 文字列組み立て（無エスケープ）を全廃（DOMParser 化でデコード済みテキストを
 * 扱うため、HTML 文字列経路は XSS になる）。スタイル計算（getSpanStyleInfo — fontStyle.mjs 委譲）は
 * upstream verbatim。css は CSS 宣言文字列（レンダラが el.style.cssText で適用 = CSSOM・HTML 非経由）。
 * See vendor/LICENSE-pptxtojson.
 */
import { getHorizontalAlign, getParagraphSpacing, getParagraphIndent } from './paragraph.mjs'
import { getTextByPathList } from './utils.mjs'

import {
  getFontType,
  getFontColor,
  getFontSize,
  getFontBold,
  getFontItalic,
  getFontDecoration,
  getFontDecorationLine,
  getFontSpace,
  getFontSubscript,
  getFontShadow,
} from './fontStyle.mjs'

export function getTextNodeValue(node) {
  if (typeof node === 'string') return node
  if (node && typeof node.value === 'string') return node.value
  return undefined
}

/**
 * 構造化 runs（DOM-StructuredRuns）:
 * { paragraphs: [{ css, listType(''|'ul'|'ol'), listLevel, runs: [{ text, css, link|null }] }] }
 */
export function genTextBody(textBodyNode, spNode, slideLayoutSpNode, slideMasterSpNode, type, warpObj) {
  if (!textBodyNode) return null

  const paragraphs = []

  const pFontStyle = getTextByPathList(spNode, ['p:style', 'a:fontRef'])
  const slideMasterTextStyles = spNode && spNode['a:tcPr'] ? undefined : warpObj['slideMasterTextStyles']
  const defaultTextStyle = spNode && spNode['a:tcPr'] ? warpObj['defaultTextStyle'] : undefined

  const pNode = textBodyNode['a:p']
  const pNodes = pNode ? (pNode.constructor === Array ? pNode : [pNode]) : []

  for (const pNode of pNodes) {
    let rNode = pNode['a:r']
    let fldNode = pNode['a:fld']
    let brNode = pNode['a:br']
    if (rNode) {
      rNode = (rNode.constructor === Array) ? rNode : [rNode]

      if (fldNode) {
        fldNode = (fldNode.constructor === Array) ? fldNode : [fldNode]
        rNode = rNode.concat(fldNode)
      }
      if (brNode) {
        brNode = (brNode.constructor === Array) ? brNode : [brNode]
        brNode.forEach(item => item.type = 'br')

        if (brNode.length > 1) brNode.shift()
        rNode = rNode.concat(brNode)
        rNode.sort((a, b) => {
          if (!a.attrs || !b.attrs) return true
          return a.attrs.order - b.attrs.order
        })
      }
    }

    const align = getHorizontalAlign(pNode, spNode, type, slideLayoutSpNode, slideMasterSpNode, warpObj)
    const spacing = getParagraphSpacing(pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, warpObj)
    const indent = getParagraphIndent(pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, warpObj)
    const listType = getListType(pNode)
    const listLevel = getListLevel(pNode)

    let styleText = `text-align: ${align};`
    if (spacing) {
      if (spacing.lineSpacing) styleText += `line-height: ${spacing.lineSpacing};`
      if (spacing.spaceBefore) styleText += `margin-top: ${spacing.spaceBefore};`
      if (spacing.spaceAfter) styleText += `margin-bottom: ${spacing.spaceAfter};`
    }
    if (indent) {
      if (!listType && indent.marginLeft) styleText += `margin-left: ${indent.marginLeft};`
      if (!listType && indent.textIndent) styleText += `text-indent: ${indent.textIndent};`
    }

    const runs = []
    if (!rNode) {
      runs.push(genRunObject(pNode, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, defaultTextStyle, warpObj))
    }
    else {
      for (const rNodeItem of rNode) {
        if (rNodeItem.type === 'br') { runs.push({ text: '\n', css: '', link: null, br: true }) }
        else runs.push(genRunObject(rNodeItem, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, defaultTextStyle, warpObj))
      }
    }

    paragraphs.push({ css: styleText, listType, listLevel: listLevel < 0 ? 0 : listLevel, runs })
  }
  return { paragraphs }
}

export function getListType(node) {
  const pPrNode = node['a:pPr']
  if (!pPrNode) return ''

  if (pPrNode['a:buChar']) return 'ul'
  if (pPrNode['a:buAutoNum']) return 'ol'

  return ''
}
export function getListLevel(node) {
  const pPrNode = node['a:pPr']
  if (!pPrNode) return -1

  const lvlNode = getTextByPathList(pPrNode, ['attrs', 'lvl'])
  if (lvlNode !== undefined) return parseInt(lvlNode)

  return 0
}

/** upstream getSpanStyleInfo と同一のスタイル計算 → 構造化 run（HTML 文字列を組まない） */
function genRunObject(node, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, defaultTextStyle, warpObj) {
  const info = getSpanStyleInfo(node, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, defaultTextStyle, warpObj)
  return { text: info.text, css: info.styleText, link: info.hasLink ? info.linkURL : null }
}

export function getSpanStyleInfo(node, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, defaultTextStyle, warpObj) {
  let lvl = 1
  const pPrNode = pNode['a:pPr']
  const lvlNode = getTextByPathList(pPrNode, ['attrs', 'lvl'])
  if (lvlNode !== undefined) lvl = parseInt(lvlNode) + 1

  let text = getTextNodeValue(node['a:t'])
  if (typeof text !== 'string') text = getTextNodeValue(getTextByPathList(node, ['a:fld', 'a:t']))
  if (typeof text !== 'string') text = ' ' // Modified: '&nbsp;' → 半角スペース（entity を持ち込まない）

  let styleText = ''
  const fontColor = getFontColor(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl, pFontStyle, warpObj)
  const fontSize = getFontSize(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl, defaultTextStyle)
  const fontType = getFontType(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl, warpObj)
  const fontBold = getFontBold(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const fontItalic = getFontItalic(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const fontDecoration = getFontDecoration(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const fontDecorationLine = getFontDecorationLine(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const fontSpace = getFontSpace(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)
  const shadow = getFontShadow(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl, warpObj)
  const subscript = getFontSubscript(node, pNode, textBodyNode, slideLayoutSpNode, slideMasterSpNode, type, slideMasterTextStyles, lvl)

  if (fontColor) {
    if (typeof fontColor === 'string') styleText += `color: ${fontColor};`
    else if (fontColor.colors) {
      const { colors, rot } = fontColor
      const stops = colors.map(item => `${item.color} ${item.pos}`).join(', ')
      const gradientStyle = `linear-gradient(${rot + 90}deg, ${stops})`
      styleText += `background: ${gradientStyle}; background-clip: text; color: transparent;`
    }
  }
  if (fontSize) styleText += `font-size: ${fontSize};`
  if (fontType) styleText += `font-family: ${fontType};`
  if (fontBold) styleText += `font-weight: ${fontBold};`
  if (fontItalic) styleText += `font-style: ${fontItalic};`
  if (fontDecoration) styleText += `text-decoration: ${fontDecoration};`
  if (fontDecorationLine) styleText += `text-decoration-line: ${fontDecorationLine};`
  if (fontSpace) styleText += `letter-spacing: ${fontSpace};`
  if (subscript) styleText += `vertical-align: ${subscript};`
  if (shadow) styleText += `text-shadow: ${shadow};`

  const linkID = getTextByPathList(node, ['a:rPr', 'a:hlinkClick', 'attrs', 'r:id'])
  const hasLink = linkID && warpObj['slideResObj'][linkID]

  return {
    styleText,
    text,
    hasLink,
    linkURL: hasLink ? warpObj['slideResObj'][linkID]['target'] : null
  }
}
