/**
 * Theme Migration Unit Tests
 *
 * Sprint: 20260509-185557-minimal-settings-foundation
 * 対応 FR: FR-MR-03 (legacy theme 値の自動 migration)
 * 対応 TC: TC-01 / TC-02 / TC-03 / TC-03b
 *
 * Tests `migrateLegacyTheme()` from src/shared/settings-provider.ts
 */

import { test, expect } from '@playwright/test';
import { migrateLegacyTheme } from '../../src/shared/settings-provider';

test.describe('migrateLegacyTheme', () => {
    test('TC-01: maps legacy night → dark', () => {
        expect(migrateLegacyTheme('night')).toBe('dark');
    });

    test('TC-01b: modern dark passes through (was previously a dead code edge case)', () => {
        // 'dark' は modern enum なので pass-through される。
        // (Legacy としても 'dark' という値は存在したが、新システムでも 'dark' なので結果は変わらない)
        expect(migrateLegacyTheme('dark')).toBe('dark');
    });

    test('TC-02: maps light-like legacy values (things/github/sepia/minimal/perplexity) → light', () => {
        expect(migrateLegacyTheme('things')).toBe('light');
        expect(migrateLegacyTheme('github')).toBe('light');
        expect(migrateLegacyTheme('sepia')).toBe('light');
        expect(migrateLegacyTheme('minimal')).toBe('light');
        expect(migrateLegacyTheme('perplexity')).toBe('light');
    });

    test('TC-03: invalid value → auto (safer fallback than light)', () => {
        // PoC patch では 'light' fallback だったが、design §3.6 + session-log HIGH-2
        // で `auto` 採用 (typo で意図せず light 固定されるリスク回避)
        expect(migrateLegacyTheme('typo')).toBe('auto');
        expect(migrateLegacyTheme('')).toBe('auto');
        expect(migrateLegacyTheme(undefined)).toBe('auto');
        // null 入力は ts-strict だと型違反だが、runtime safety check として
        expect(migrateLegacyTheme(null as unknown as string)).toBe('auto');
    });

    test('TC-03b: modern values pass-through', () => {
        expect(migrateLegacyTheme('light')).toBe('light');
        expect(migrateLegacyTheme('dark')).toBe('dark');
        expect(migrateLegacyTheme('auto')).toBe('auto');
    });

    test('TC-03c: case-sensitive — uppercase legacy → auto (treated as unknown)', () => {
        // Migration is strictly case-sensitive
        expect(migrateLegacyTheme('GitHub')).toBe('auto');
        expect(migrateLegacyTheme('THINGS')).toBe('auto');
    });
});
