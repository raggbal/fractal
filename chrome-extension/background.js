'use strict';
console.log('[Fractal Clipper] MULTI-TRIGGER SW loaded at', new Date().toISOString());

chrome.action.onClicked.addListener((tab) => {
    console.log('[Fractal Clipper] [A] action.onClicked', tab?.id, tab?.url);
    chrome.action.setBadgeText({ text: 'A' });
});

chrome.commands.onCommand.addListener((cmd) => {
    console.log('[Fractal Clipper] [B] commands.onCommand:', cmd);
    chrome.action.setBadgeText({ text: 'B' });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    console.log('[Fractal Clipper] [C] contextMenus.onClicked', info.menuItemId, tab?.id);
    chrome.action.setBadgeText({ text: 'C' });
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'fractal-clip',
        title: '📥 Clip to Fractal',
        contexts: ['page']
    }, () => void chrome.runtime.lastError);
});
