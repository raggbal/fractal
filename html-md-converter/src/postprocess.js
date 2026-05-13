// Turndown 出力後の markdown 文字列クリーンアップ。
//
// 1. unescape: Turndown は markdown 構文文字 (\-, \+, \#, \>, ...) を escape する。
//    markdown editor へ paste する場合は意図解釈させたいので unescape する。
// 2. collapseBlankLinesBetweenListItems: <li><p>...</p></li> 由来の blank line を消して tight list 化。

function postprocess(md) {
    // Un-escape block-level syntax markers
    md = md.replace(/^\\([-+*]) /gm, '$1 ');         // list markers: \-, \+, \*
    md = md.replace(/^\\(#{1,6}) /gm, '$1 ');        // heading: \#, \##, ...
    md = md.replace(/^\\(>) ?/gm, '$1 ');            // blockquote: \>
    md = md.replace(/^(\d+)\\(\. )/gm, '$1$2');      // ordered list: 1\.
    md = md.replace(/^\\(~~~)/gm, '$1');             // code fence: \~~~
    // Inline escapes: \* \_ \` \[ \] \\ \.
    md = md.replace(/\\([*_`\[\]\\.])/g, '$1');

    // Collapse blank lines between consecutive list items (tight list)
    var prev;
    do {
        prev = md;
        md = md.replace(
            /(^[ \t]*(?:[-*+]|\d+\.)\s+.*)\n{2,}([ \t]*(?:[-*+]|\d+\.)\s)/gm,
            '$1\n$2'
        );
    } while (md !== prev);

    return md;
}
