# () サポート テスト用 Markdown

## 1. 画像: 単純な () 入りパス

![photo v2](images/photo_(v2).png)

## 2. 画像: ネストした () パス

![nested data](images/data_((nested)).png)

## 3. 画像: 全角括弧パス

![東京](images/東京（tokyo）.png)

## 4. 画像: 通常パス (退行チェック)

![normal](images/normal.png)

## 5. 画像: スクリーンショット (copy) パス

![screenshot](images/screenshot_(copy).png)

## 6. リンク: Wikipedia 風 URL

[Foo (disambiguation)](https://en.wikipedia.org/wiki/Foo_(disambiguation))

## 7. リンク: ネスト URL

[Complex](https://example.com/path/((a)(b))/end)

## 8. リンク: 通常 URL (退行チェック)

[Google](https://www.google.com)

## 9. 画像 + リンク混在

See ![icon](images/photo_(v2).png) and visit [Wiki](https://en.wikipedia.org/wiki/Test_(unit)).

## 10. インライン: 太字/イタリック + () 入りリンク

This is **bold** with [a link](https://example.com/foo_(bar)) and *italic* text.
