/**
 * TASK-04 — Import folder の closure 検証用 外部フォルダ fixture ビルダー
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-OIF-05/06/07 の検証前提）
 *
 * TC-OIF-10..19 と TC-SND-01..03/14 が使う。「md が本文から参照している資産の closure」と
 * 「closure 外の資産」を作り分けられることが要件（design/system.md §5-3/§5-4）。
 *
 * **静的 fixture ディレクトリではなく実行時 mkdtemp 生成**にした理由は
 * test/utils/fixture-node-attachment.ts と同じ（Import folder は実体をコピーするため
 * source 側も dest 側も毎回まっさらである必要がある）。
 * tasks.md の宣言パス `test/fixtures/import-folder-closure/` から変更した旨は
 * design/system.md §0 と generator-log.md に記録済み。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type ImportFixtureVariant =
    /** 基本形: a.md が pic.png / spec.pdf / [[sub]](sub.md) を参照 + closure 外の orphan.png */
    | 'basic'
    /** md が 1 つも無い（files/x.pdf のみ）= TC-OIF-12 の回帰確認 */
    | 'no-md'
    /** deep/a/b/x.pdf（closure 外）だけが深部にある = TC-OIF-18 の中間 dir */
    | 'deep'
    /** URL エンコード参照: 実名 `pic a.png` を `images/pic%20a.png` で参照 = TC-OIF-14 */
    | 'urlencoded'
    /** containment: 絶対パスと ../ escape を参照する md = TC-OIF-16 */
    | 'escape'
    /** 再オープン R1: index.md がプレーン [text](chapter1.md) / [text](report.pdf) を持つ（[[ ]] / 📎 なし）= TC-OIF-20/23 */
    | 'plainlinks'
    /** 再オープン R2: a.md ⇄ b.md が互いに [[ ]] で参照する（相互参照）= TC-OIF-21 */
    | 'cycle'
    /** 再オープン: 規約どおり 3 形式 + プレーンリンク + 循環 + closure 外 を 1 フォルダに同居 = TC-OIF-22 */
    | 'mixed'
    /** TASK-51: title 付きプレーンリンク（`[x](y.md "t")` / `'t'` / `%20` encode）— 張り替えの照合キー不一致の番人 */
    | 'titled';

export interface ImportFolderFixture {
    /** mkdtemp のルート（この下に対象フォルダが 1 つある） */
    root: string;
    /** Import folder の対象として選ぶフォルダの絶対パス */
    target: string;
    /**
     * md 本文が参照している実体（= closure に入るべきもの）の相対パス集合。
     * `target` 起点の相対パスで持つ。
     */
    closure: string[];
    /** closure に入らない実体の相対パス集合（folder node + 実体 node が作られるべきもの） */
    nonClosure: string[];
    cleanup: () => void;
}

function w(abs: string, body: string) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
}

export function makeImportFolderFixture(variant: ImportFixtureVariant = 'basic'): ImportFolderFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-oif-'));
    const target = path.join(root, 'docs');
    let closure: string[] = [];
    let nonClosure: string[] = [];

    switch (variant) {
        case 'basic': {
            // a.md が 3 種すべてを参照する（画像 / 📎 file / subpage）。
            // subpage は [[label]](sub.md) 形式 — extractAllAssetRefs が落とす形（TC-OIF-13 の要）。
            w(path.join(target, 'a.md'),
                '# a\n\n'
                + '![pic](images/pic.png)\n\n'
                + '[📎 spec](files/spec.pdf)\n\n'
                + '[[sub]](sub.md)\n');
            w(path.join(target, 'sub.md'), '# sub\n\nsubpage 本文\n');
            w(path.join(target, 'images', 'pic.png'), 'PNG-pic');
            w(path.join(target, 'files', 'spec.pdf'), 'PDF-spec');
            // closure 外（a.md からは参照されない）
            w(path.join(target, 'images', 'orphan.png'), 'PNG-orphan');
            closure = ['a.md', 'sub.md', 'images/pic.png', 'files/spec.pdf'];
            nonClosure = ['images/orphan.png'];
            break;
        }
        case 'no-md': {
            w(path.join(target, 'files', 'x.pdf'), 'PDF-x');
            closure = [];
            nonClosure = ['files/x.pdf'];
            break;
        }
        case 'deep': {
            // 中間 dir（deep / deep/a / deep/a/b）は「配下に closure 外が再帰的に 1 件以上ある」ので
            // folder node が作られるべき（design/system.md §5-4 の行 3。最も落ちやすいセル）
            w(path.join(target, 'deep', 'a', 'b', 'x.pdf'), 'PDF-deep');
            closure = [];
            nonClosure = ['deep/a/b/x.pdf'];
            break;
        }
        case 'urlencoded': {
            // 実ファイル名はスペース入り、md 本文は %20 でエンコード。
            // decodeURIComponent を欠くと closure 判定が偽陰性になり余分な node ができる。
            w(path.join(target, 'a.md'), '# a\n\n![pic](images/pic%20a.png)\n');
            w(path.join(target, 'images', 'pic a.png'), 'PNG-space');
            closure = ['a.md', 'images/pic a.png'];
            nonClosure = [];
            break;
        }
        case 'escape': {
            // containment（NFR-DCP-01）: 絶対パスと境界外 ../ は複製されてはいけない。
            // escape 先の実体も作っておく（複製が起きたら検出できるように）。
            w(path.join(root, 'outside', 'escape.png'), 'PNG-outside');
            // TASK-49（SEC-5-1）: プレーンリンクの escape も同居させる（張り替えパスが触らないことの counterfactual 用）
            w(path.join(root, 'outside', 'escape.md'), '# outside\n');
            w(path.join(target, 'a.md'),
                '# a\n\n'
                + '![abs](/etc/passwd)\n\n'
                + '![up](../outside/escape.png)\n\n'
                + '![ok](images/pic.png)\n\n'
                + '[abs-link](/etc/passwd)\n\n'
                + '[up-link](../outside/escape.md)\n');
            w(path.join(target, 'images', 'pic.png'), 'PNG-ok');
            // 境界内の pic.png だけが closure。escape 系は closure にも nonClosure にも入れない
            // （複製対象外であり node 対象外でもある）
            closure = ['a.md', 'images/pic.png'];
            nonClosure = [];
            break;
        }
        case 'plainlinks': {
            // 外部フォルダの md で最も一般的な形: Fractal 規約（[[ ]] / 📎）を使わないプレーンリンク。
            // rev1 の closure（CLEANUP_MD_LINK_RE = 全リンク）はこれを closure に入れ、エンジンは複製しない
            // → chapter1.md / report.pdf が node にも複製にもならず消えた（再オープン時に実行再現）。
            w(path.join(target, 'index.md'),
                '# Index\n\nSee [Chapter 1](chapter1.md) and the [report](report.pdf).\n');
            w(path.join(target, 'chapter1.md'), '# Chapter 1\n\nbody\n');
            w(path.join(target, 'report.pdf'), 'PDF-report');
            // rev2: プレーンリンク先は closure に入らない = 全部 node
            closure = [];
            nonClosure = ['index.md', 'chapter1.md', 'report.pdf'];
            break;
        }
        case 'titled': {
            // reviewer iteration 6 QUAL6-1: parseMarkdownLinks の url は title を含む（`chapter1.md "Chapter one"`）。
            // renames のキー（normalizeMdLinkKeys = title strip あり）と applyLinkUrlRewrites の照合キー（title strip なし）が
            // 食い違うと title 付きリンクだけ張り替えが無音で不発になる。
            w(path.join(target, 'index.md'),
                '# Index\n\n'
                + 'See [Chapter](chapter1.md "Chapter one") and the [report](report.pdf \'R\').\n\n'
                + 'Also [enc](ch%202.md "two")\n');
            w(path.join(target, 'chapter1.md'), '# Chapter 1\n\nbody\n');
            w(path.join(target, 'ch 2.md'), '# Chapter 2\n\nbody\n');
            w(path.join(target, 'report.pdf'), 'PDF-report');
            closure = [];
            nonClosure = ['index.md', 'chapter1.md', 'ch 2.md', 'report.pdf'];
            break;
        }
        case 'cycle': {
            // トップレベル md の相互 [[ ]] 参照。rev1 は両方を closure に入れて何も取り込まなかった。
            // rev2 の root ルール: 走査順先頭（a.md）が root として node になり、b.md は subpage として複製。
            w(path.join(target, 'a.md'), '# A\n\n[[b]](b.md)\n');
            w(path.join(target, 'b.md'), '# B\n\n[[back to a]](a.md)\n');
            closure = ['b.md'];
            nonClosure = ['a.md'];
            break;
        }
        case 'mixed': {
            // basic + plainlinks + cycle + closure 外 を同居させ「走査 md / 資産は必ず node か複製のどちらかに落ちる」を数える。
            w(path.join(target, 'a.md'),
                '# a\n\n![pic](images/pic.png)\n\n[📎 spec](files/spec.pdf)\n\n[[sub]](sub.md)\n');
            // TASK-48（DSN-16）: closure 複製 subpage 自身のプレーン file リンク（notes.pdf は closure 外 = file node）も張り替え対象
            w(path.join(target, 'sub.md'), '# sub\n\n![subpic](images/subpic.png)\n\n[notes](notes.pdf)\n');
            w(path.join(target, 'notes.pdf'), 'PDF-notes');
            w(path.join(target, 'images', 'pic.png'), 'PNG-pic');
            w(path.join(target, 'images', 'subpic.png'), 'PNG-subpic');
            w(path.join(target, 'files', 'spec.pdf'), 'PDF-spec');
            w(path.join(target, 'index.md'),
                '# Index\n\n[Chapter 1](chapter1.md) / [report](report.pdf)\n');
            w(path.join(target, 'chapter1.md'), '# Chapter 1\n');
            w(path.join(target, 'report.pdf'), 'PDF-report');
            w(path.join(target, 'c.md'), '# C\n\n[[d]](d.md)\n');
            w(path.join(target, 'd.md'), '# D\n\n[[c]](c.md)\n');
            w(path.join(target, 'images', 'orphan.png'), 'PNG-orphan');
            // closure = root（a / index / chapter1 / c）から 3 形式で到達する実体
            closure = ['sub.md', 'images/pic.png', 'images/subpic.png', 'files/spec.pdf', 'd.md'];
            nonClosure = ['a.md', 'index.md', 'chapter1.md', 'report.pdf', 'c.md', 'images/orphan.png', 'notes.pdf'];
            break;
        }
    }

    return {
        root,
        target,
        closure,
        nonClosure,
        cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } },
    };
}

/** 出力先（note 側）として使う空ディレクトリを作る。 */
export function makeDestNote(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-oif-dest-'));
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outline.note'),
        JSON.stringify({ rootIds: [], items: {} }), 'utf8');
    return {
        dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
    };
}
