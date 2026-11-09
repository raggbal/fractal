/**
 * The words of the settings screen itself (its buttons; the settings' own titles and descriptions come
 * from package.nls*.json). Same languages as the extension (src/i18n/locales). No Electron import.
 */
import { nlsSuffix } from './settings-schema';

export interface SettingsTexts {
    title: string;
    reset: string;
    choose: string;
    add: string;
    remove: string;
    show: string;
    hide: string;
    openFile: string;
    brokenFile: string;
    none: string;
    addPlaceholder: string;
}

const TEXTS: Record<string, SettingsTexts> = {
    '': {
        title: 'Settings', reset: 'Reset', choose: 'Choose…', add: 'Add…', remove: 'Remove', show: 'Show', hide: 'Hide',
        openFile: 'Open settings.json', brokenFile: 'settings.json has an error, so the settings cannot be changed here: ',
        none: '(none)', addPlaceholder: 'Type a path and press Enter',
    },
    ja: {
        title: '設定', reset: '既定に戻す', choose: '選ぶ…', add: '追加…', remove: '削除', show: '表示', hide: '隠す',
        openFile: 'settings.json を開く', brokenFile: 'settings.json に誤りがあるので、ここでは設定を変えられません: ',
        none: '（なし）', addPlaceholder: 'パスを入れて Enter',
    },
    es: {
        title: 'Configuración', reset: 'Restablecer', choose: 'Elegir…', add: 'Añadir…', remove: 'Quitar', show: 'Mostrar', hide: 'Ocultar',
        openFile: 'Abrir settings.json', brokenFile: 'settings.json tiene un error; aquí no se puede cambiar la configuración: ',
        none: '(ninguno)', addPlaceholder: 'Escriba una ruta y pulse Intro',
    },
    fr: {
        title: 'Réglages', reset: 'Réinitialiser', choose: 'Choisir…', add: 'Ajouter…', remove: 'Retirer', show: 'Afficher', hide: 'Masquer',
        openFile: 'Ouvrir settings.json', brokenFile: 'settings.json contient une erreur ; les réglages ne peuvent pas être modifiés ici : ',
        none: '(aucun)', addPlaceholder: 'Saisissez un chemin puis Entrée',
    },
    ko: {
        title: '설정', reset: '기본값으로', choose: '선택…', add: '추가…', remove: '삭제', show: '표시', hide: '숨기기',
        openFile: 'settings.json 열기', brokenFile: 'settings.json 에 오류가 있어 여기서는 설정을 바꿀 수 없습니다: ',
        none: '(없음)', addPlaceholder: '경로를 입력하고 Enter',
    },
    'zh-cn': {
        title: '设置', reset: '恢复默认', choose: '选择…', add: '添加…', remove: '删除', show: '显示', hide: '隐藏',
        openFile: '打开 settings.json', brokenFile: 'settings.json 有错误，无法在此更改设置：',
        none: '（无）', addPlaceholder: '输入路径后按 Enter',
    },
    'zh-tw': {
        title: '設定', reset: '還原預設', choose: '選擇…', add: '新增…', remove: '刪除', show: '顯示', hide: '隱藏',
        openFile: '開啟 settings.json', brokenFile: 'settings.json 有錯誤，無法在此變更設定：',
        none: '（無）', addPlaceholder: '輸入路徑後按 Enter',
    },
};

export function settingsTexts(lang: string): SettingsTexts {
    return TEXTS[nlsSuffix(lang)] ?? TEXTS[''];
}
