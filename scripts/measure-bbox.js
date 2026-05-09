#!/usr/bin/env node
/**
 * Measure bounding boxes for layout drift detection
 *
 * Sprint: 20260509-185557-minimal-settings-foundation
 * Used by: test/specs/integration-minimal-foundation-layout-drift.spec.ts
 *
 * Usage: node scripts/measure-bbox.js > test/baselines/baseline-notes.json
 *
 * Reads selector list from PoC layout-drift-analysis.md (47 selectors)
 * and outputs JSON with bbox for each selector.
 *
 * NOTE: This script is currently a placeholder. The integration test
 * (TC-07) directly captures bbox at runtime. See:
 *   test/specs/integration-minimal-foundation-layout-drift.spec.ts
 */
'use strict';

const SELECTORS = [
    '.notes-file-panel',
    '.file-panel-header',
    '.file-panel-title',
    '.file-panel-actions',
    '.file-panel-btn',
    '.file-panel-list',
    '.file-panel-item',
    '.file-panel-item-icon',
    '.file-panel-folder-header',
    '.file-panel-folder-children',
    '.file-panel-tabs',
    '.file-panel-tab',
    '.file-panel-content',
    '.file-panel-content-actions',
    '.file-panel-search-input-wrap',
    '.file-panel-search-input',
    '.file-panel-search-options',
    '.file-panel-search-opt-btn',
    '.file-panel-search-results',
    '.file-panel-empty',
    '.notes-panel-toggle-btn',
    '.notes-resize-handle',
    '.s3-panel-section',
    '.s3-label',
    '.s3-input-row',
    '.s3-status',
    '.s3-actions',
    '.s3-action-btn',
    '.s3-progress',
    '.s3-progress-message',
    '.s3-progress-detail',
    '.file-panel-tools-section',
    '.file-panel-section-title',
    '.file-panel-color-grid',
    '.file-panel-color-swatch',
    '.file-panel-rename-input',
    '.file-panel-context-menu',
    '.file-panel-context-item',
    '.file-panel-search-section',
    '.file-panel-search-section-title',
    '.file-panel-search-file-group',
    '.file-panel-search-file-header',
    '.file-panel-search-match',
    '.file-panel-search-count',
    '.file-panel-search-spinner',
    '.file-panel-drop-line',
    '.notes-layout',
];

if (require.main === module) {
    // Print selector list (consumed by test spec)
    console.log(JSON.stringify({ selectors: SELECTORS, count: SELECTORS.length }, null, 2));
}

module.exports = { SELECTORS };
