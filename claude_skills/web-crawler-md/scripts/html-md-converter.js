/*!
 * html-md-converter v0.1.0
 * (c) 2026 imaken
 * https://github.com/raggbal/html-md-converter
 *
 * Bundles: turndown + turndown-plugin-gfm + html-md-converter rules
 * Usage (browser / Playwright eval):
 *   const md = HtmlMdConverter.htmlToMarkdown(htmlString);
 */
(function (global) {
    "use strict";
var TurndownService = (function () {
  'use strict';

  function extend (destination) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      for (var key in source) {
        if (source.hasOwnProperty(key)) destination[key] = source[key];
      }
    }
    return destination
  }

  function repeat (character, count) {
    return Array(count + 1).join(character)
  }

  function trimLeadingNewlines (string) {
    return string.replace(/^\n*/, '')
  }

  function trimTrailingNewlines (string) {
    // avoid match-at-end regexp bottleneck, see #370
    var indexEnd = string.length;
    while (indexEnd > 0 && string[indexEnd - 1] === '\n') indexEnd--;
    return string.substring(0, indexEnd)
  }

  function trimNewlines (string) {
    return trimTrailingNewlines(trimLeadingNewlines(string))
  }

  var blockElements = [
    'ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'BLOCKQUOTE', 'BODY', 'CANVAS',
    'CENTER', 'DD', 'DIR', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
    'FOOTER', 'FORM', 'FRAMESET', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
    'HGROUP', 'HR', 'HTML', 'ISINDEX', 'LI', 'MAIN', 'MENU', 'NAV', 'NOFRAMES',
    'NOSCRIPT', 'OL', 'OUTPUT', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD',
    'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
  ];

  function isBlock (node) {
    return is(node, blockElements)
  }

  var voidElements = [
    'AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT',
    'KEYGEN', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'
  ];

  function isVoid (node) {
    return is(node, voidElements)
  }

  function hasVoid (node) {
    return has(node, voidElements)
  }

  var meaningfulWhenBlankElements = [
    'A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TH', 'TD', 'IFRAME', 'SCRIPT',
    'AUDIO', 'VIDEO'
  ];

  function isMeaningfulWhenBlank (node) {
    return is(node, meaningfulWhenBlankElements)
  }

  function hasMeaningfulWhenBlank (node) {
    return has(node, meaningfulWhenBlankElements)
  }

  function is (node, tagNames) {
    return tagNames.indexOf(node.nodeName) >= 0
  }

  function has (node, tagNames) {
    return (
      node.getElementsByTagName &&
      tagNames.some(function (tagName) {
        return node.getElementsByTagName(tagName).length
      })
    )
  }

  var rules = {};

  rules.paragraph = {
    filter: 'p',

    replacement: function (content) {
      return '\n\n' + content + '\n\n'
    }
  };

  rules.lineBreak = {
    filter: 'br',

    replacement: function (content, node, options) {
      return options.br + '\n'
    }
  };

  rules.heading = {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],

    replacement: function (content, node, options) {
      var hLevel = Number(node.nodeName.charAt(1));

      if (options.headingStyle === 'setext' && hLevel < 3) {
        var underline = repeat((hLevel === 1 ? '=' : '-'), content.length);
        return (
          '\n\n' + content + '\n' + underline + '\n\n'
        )
      } else {
        return '\n\n' + repeat('#', hLevel) + ' ' + content + '\n\n'
      }
    }
  };

  rules.blockquote = {
    filter: 'blockquote',

    replacement: function (content) {
      content = trimNewlines(content).replace(/^/gm, '> ');
      return '\n\n' + content + '\n\n'
    }
  };

  rules.list = {
    filter: ['ul', 'ol'],

    replacement: function (content, node) {
      var parent = node.parentNode;
      if (parent.nodeName === 'LI' && parent.lastElementChild === node) {
        return '\n' + content
      } else {
        return '\n\n' + content + '\n\n'
      }
    }
  };

  rules.listItem = {
    filter: 'li',

    replacement: function (content, node, options) {
      var prefix = options.bulletListMarker + '   ';
      var parent = node.parentNode;
      if (parent.nodeName === 'OL') {
        var start = parent.getAttribute('start');
        var index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + '.  ';
      }
      var isParagraph = /\n$/.test(content);
      content = trimNewlines(content) + (isParagraph ? '\n' : '');
      content = content.replace(/\n/gm, '\n' + ' '.repeat(prefix.length)); // indent
      return (
        prefix + content + (node.nextSibling ? '\n' : '')
      )
    }
  };

  rules.indentedCodeBlock = {
    filter: function (node, options) {
      return (
        options.codeBlockStyle === 'indented' &&
        node.nodeName === 'PRE' &&
        node.firstChild &&
        node.firstChild.nodeName === 'CODE'
      )
    },

    replacement: function (content, node, options) {
      return (
        '\n\n    ' +
        node.firstChild.textContent.replace(/\n/g, '\n    ') +
        '\n\n'
      )
    }
  };

  rules.fencedCodeBlock = {
    filter: function (node, options) {
      return (
        options.codeBlockStyle === 'fenced' &&
        node.nodeName === 'PRE' &&
        node.firstChild &&
        node.firstChild.nodeName === 'CODE'
      )
    },

    replacement: function (content, node, options) {
      var className = node.firstChild.getAttribute('class') || '';
      var language = (className.match(/language-(\S+)/) || [null, ''])[1];
      var code = node.firstChild.textContent;

      var fenceChar = options.fence.charAt(0);
      var fenceSize = 3;
      var fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');

      var match;
      while ((match = fenceInCodeRegex.exec(code))) {
        if (match[0].length >= fenceSize) {
          fenceSize = match[0].length + 1;
        }
      }

      var fence = repeat(fenceChar, fenceSize);

      return (
        '\n\n' + fence + language + '\n' +
        code.replace(/\n$/, '') +
        '\n' + fence + '\n\n'
      )
    }
  };

  rules.horizontalRule = {
    filter: 'hr',

    replacement: function (content, node, options) {
      return '\n\n' + options.hr + '\n\n'
    }
  };

  rules.inlineLink = {
    filter: function (node, options) {
      return (
        options.linkStyle === 'inlined' &&
        node.nodeName === 'A' &&
        node.getAttribute('href')
      )
    },

    replacement: function (content, node) {
      var href = node.getAttribute('href');
      if (href) href = href.replace(/([()])/g, '\\$1');
      var title = cleanAttribute(node.getAttribute('title'));
      if (title) title = ' "' + title.replace(/"/g, '\\"') + '"';
      return '[' + content + '](' + href + title + ')'
    }
  };

  rules.referenceLink = {
    filter: function (node, options) {
      return (
        options.linkStyle === 'referenced' &&
        node.nodeName === 'A' &&
        node.getAttribute('href')
      )
    },

    replacement: function (content, node, options) {
      var href = node.getAttribute('href');
      var title = cleanAttribute(node.getAttribute('title'));
      if (title) title = ' "' + title + '"';
      var replacement;
      var reference;

      switch (options.linkReferenceStyle) {
        case 'collapsed':
          replacement = '[' + content + '][]';
          reference = '[' + content + ']: ' + href + title;
          break
        case 'shortcut':
          replacement = '[' + content + ']';
          reference = '[' + content + ']: ' + href + title;
          break
        default:
          var id = this.references.length + 1;
          replacement = '[' + content + '][' + id + ']';
          reference = '[' + id + ']: ' + href + title;
      }

      this.references.push(reference);
      return replacement
    },

    references: [],

    append: function (options) {
      var references = '';
      if (this.references.length) {
        references = '\n\n' + this.references.join('\n') + '\n\n';
        this.references = []; // Reset references
      }
      return references
    }
  };

  rules.emphasis = {
    filter: ['em', 'i'],

    replacement: function (content, node, options) {
      if (!content.trim()) return ''
      return options.emDelimiter + content + options.emDelimiter
    }
  };

  rules.strong = {
    filter: ['strong', 'b'],

    replacement: function (content, node, options) {
      if (!content.trim()) return ''
      return options.strongDelimiter + content + options.strongDelimiter
    }
  };

  rules.code = {
    filter: function (node) {
      var hasSiblings = node.previousSibling || node.nextSibling;
      var isCodeBlock = node.parentNode.nodeName === 'PRE' && !hasSiblings;

      return node.nodeName === 'CODE' && !isCodeBlock
    },

    replacement: function (content) {
      if (!content) return ''
      content = content.replace(/\r?\n|\r/g, ' ');

      var extraSpace = /^`|^ .*?[^ ].* $|`$/.test(content) ? ' ' : '';
      var delimiter = '`';
      var matches = content.match(/`+/gm) || [];
      while (matches.indexOf(delimiter) !== -1) delimiter = delimiter + '`';

      return delimiter + extraSpace + content + extraSpace + delimiter
    }
  };

  rules.image = {
    filter: 'img',

    replacement: function (content, node) {
      var alt = cleanAttribute(node.getAttribute('alt'));
      var src = node.getAttribute('src') || '';
      var title = cleanAttribute(node.getAttribute('title'));
      var titlePart = title ? ' "' + title + '"' : '';
      return src ? '![' + alt + ']' + '(' + src + titlePart + ')' : ''
    }
  };

  function cleanAttribute (attribute) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : ''
  }

  /**
   * Manages a collection of rules used to convert HTML to Markdown
   */

  function Rules (options) {
    this.options = options;
    this._keep = [];
    this._remove = [];

    this.blankRule = {
      replacement: options.blankReplacement
    };

    this.keepReplacement = options.keepReplacement;

    this.defaultRule = {
      replacement: options.defaultReplacement
    };

    this.array = [];
    for (var key in options.rules) this.array.push(options.rules[key]);
  }

  Rules.prototype = {
    add: function (key, rule) {
      this.array.unshift(rule);
    },

    keep: function (filter) {
      this._keep.unshift({
        filter: filter,
        replacement: this.keepReplacement
      });
    },

    remove: function (filter) {
      this._remove.unshift({
        filter: filter,
        replacement: function () {
          return ''
        }
      });
    },

    forNode: function (node) {
      if (node.isBlank) return this.blankRule
      var rule;

      if ((rule = findRule(this.array, node, this.options))) return rule
      if ((rule = findRule(this._keep, node, this.options))) return rule
      if ((rule = findRule(this._remove, node, this.options))) return rule

      return this.defaultRule
    },

    forEach: function (fn) {
      for (var i = 0; i < this.array.length; i++) fn(this.array[i], i);
    }
  };

  function findRule (rules, node, options) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (filterValue(rule, node, options)) return rule
    }
    return void 0
  }

  function filterValue (rule, node, options) {
    var filter = rule.filter;
    if (typeof filter === 'string') {
      if (filter === node.nodeName.toLowerCase()) return true
    } else if (Array.isArray(filter)) {
      if (filter.indexOf(node.nodeName.toLowerCase()) > -1) return true
    } else if (typeof filter === 'function') {
      if (filter.call(rule, node, options)) return true
    } else {
      throw new TypeError('`filter` needs to be a string, array, or function')
    }
  }

  /**
   * The collapseWhitespace function is adapted from collapse-whitespace
   * by Luc Thevenard.
   *
   * The MIT License (MIT)
   *
   * Copyright (c) 2014 Luc Thevenard <lucthevenard@gmail.com>
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in
   * all copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   * THE SOFTWARE.
   */

  /**
   * collapseWhitespace(options) removes extraneous whitespace from an the given element.
   *
   * @param {Object} options
   */
  function collapseWhitespace (options) {
    var element = options.element;
    var isBlock = options.isBlock;
    var isVoid = options.isVoid;
    var isPre = options.isPre || function (node) {
      return node.nodeName === 'PRE'
    };

    if (!element.firstChild || isPre(element)) return

    var prevText = null;
    var keepLeadingWs = false;

    var prev = null;
    var node = next(prev, element, isPre);

    while (node !== element) {
      if (node.nodeType === 3 || node.nodeType === 4) { // Node.TEXT_NODE or Node.CDATA_SECTION_NODE
        var text = node.data.replace(/[ \r\n\t]+/g, ' ');

        if ((!prevText || / $/.test(prevText.data)) &&
            !keepLeadingWs && text[0] === ' ') {
          text = text.substr(1);
        }

        // `text` might be empty at this point.
        if (!text) {
          node = remove(node);
          continue
        }

        node.data = text;

        prevText = node;
      } else if (node.nodeType === 1) { // Node.ELEMENT_NODE
        if (isBlock(node) || node.nodeName === 'BR') {
          if (prevText) {
            prevText.data = prevText.data.replace(/ $/, '');
          }

          prevText = null;
          keepLeadingWs = false;
        } else if (isVoid(node) || isPre(node)) {
          // Avoid trimming space around non-block, non-BR void elements and inline PRE.
          prevText = null;
          keepLeadingWs = true;
        } else if (prevText) {
          // Drop protection if set previously.
          keepLeadingWs = false;
        }
      } else {
        node = remove(node);
        continue
      }

      var nextNode = next(prev, node, isPre);
      prev = node;
      node = nextNode;
    }

    if (prevText) {
      prevText.data = prevText.data.replace(/ $/, '');
      if (!prevText.data) {
        remove(prevText);
      }
    }
  }

  /**
   * remove(node) removes the given node from the DOM and returns the
   * next node in the sequence.
   *
   * @param {Node} node
   * @return {Node} node
   */
  function remove (node) {
    var next = node.nextSibling || node.parentNode;

    node.parentNode.removeChild(node);

    return next
  }

  /**
   * next(prev, current, isPre) returns the next node in the sequence, given the
   * current and previous nodes.
   *
   * @param {Node} prev
   * @param {Node} current
   * @param {Function} isPre
   * @return {Node}
   */
  function next (prev, current, isPre) {
    if ((prev && prev.parentNode === current) || isPre(current)) {
      return current.nextSibling || current.parentNode
    }

    return current.firstChild || current.nextSibling || current.parentNode
  }

  /*
   * Set up window for Node.js
   */

  var root = (typeof window !== 'undefined' ? window : {});

  /*
   * Parsing HTML strings
   */

  function canParseHTMLNatively () {
    var Parser = root.DOMParser;
    var canParse = false;

    // Adapted from https://gist.github.com/1129031
    // Firefox/Opera/IE throw errors on unsupported types
    try {
      // WebKit returns null on unsupported types
      if (new Parser().parseFromString('', 'text/html')) {
        canParse = true;
      }
    } catch (e) {}

    return canParse
  }

  function createHTMLParser () {
    var Parser = function () {};

    {
      if (shouldUseActiveX()) {
        Parser.prototype.parseFromString = function (string) {
          var doc = new window.ActiveXObject('htmlfile');
          doc.designMode = 'on'; // disable on-page scripts
          doc.open();
          doc.write(string);
          doc.close();
          return doc
        };
      } else {
        Parser.prototype.parseFromString = function (string) {
          var doc = document.implementation.createHTMLDocument('');
          doc.open();
          doc.write(string);
          doc.close();
          return doc
        };
      }
    }
    return Parser
  }

  function shouldUseActiveX () {
    var useActiveX = false;
    try {
      document.implementation.createHTMLDocument('').open();
    } catch (e) {
      if (root.ActiveXObject) useActiveX = true;
    }
    return useActiveX
  }

  var HTMLParser = canParseHTMLNatively() ? root.DOMParser : createHTMLParser();

  function RootNode (input, options) {
    var root;
    if (typeof input === 'string') {
      var doc = htmlParser().parseFromString(
        // DOM parsers arrange elements in the <head> and <body>.
        // Wrapping in a custom element ensures elements are reliably arranged in
        // a single element.
        '<x-turndown id="turndown-root">' + input + '</x-turndown>',
        'text/html'
      );
      root = doc.getElementById('turndown-root');
    } else {
      root = input.cloneNode(true);
    }
    collapseWhitespace({
      element: root,
      isBlock: isBlock,
      isVoid: isVoid,
      isPre: options.preformattedCode ? isPreOrCode : null
    });

    return root
  }

  var _htmlParser;
  function htmlParser () {
    _htmlParser = _htmlParser || new HTMLParser();
    return _htmlParser
  }

  function isPreOrCode (node) {
    return node.nodeName === 'PRE' || node.nodeName === 'CODE'
  }

  function Node (node, options) {
    node.isBlock = isBlock(node);
    node.isCode = node.nodeName === 'CODE' || node.parentNode.isCode;
    node.isBlank = isBlank(node);
    node.flankingWhitespace = flankingWhitespace(node, options);
    return node
  }

  function isBlank (node) {
    return (
      !isVoid(node) &&
      !isMeaningfulWhenBlank(node) &&
      /^\s*$/i.test(node.textContent) &&
      !hasVoid(node) &&
      !hasMeaningfulWhenBlank(node)
    )
  }

  function flankingWhitespace (node, options) {
    if (node.isBlock || (options.preformattedCode && node.isCode)) {
      return { leading: '', trailing: '' }
    }

    var edges = edgeWhitespace(node.textContent);

    // abandon leading ASCII WS if left-flanked by ASCII WS
    if (edges.leadingAscii && isFlankedByWhitespace('left', node, options)) {
      edges.leading = edges.leadingNonAscii;
    }

    // abandon trailing ASCII WS if right-flanked by ASCII WS
    if (edges.trailingAscii && isFlankedByWhitespace('right', node, options)) {
      edges.trailing = edges.trailingNonAscii;
    }

    return { leading: edges.leading, trailing: edges.trailing }
  }

  function edgeWhitespace (string) {
    var m = string.match(/^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/);
    return {
      leading: m[1], // whole string for whitespace-only strings
      leadingAscii: m[2],
      leadingNonAscii: m[3],
      trailing: m[4], // empty for whitespace-only strings
      trailingNonAscii: m[5],
      trailingAscii: m[6]
    }
  }

  function isFlankedByWhitespace (side, node, options) {
    var sibling;
    var regExp;
    var isFlanked;

    if (side === 'left') {
      sibling = node.previousSibling;
      regExp = / $/;
    } else {
      sibling = node.nextSibling;
      regExp = /^ /;
    }

    if (sibling) {
      if (sibling.nodeType === 3) {
        isFlanked = regExp.test(sibling.nodeValue);
      } else if (options.preformattedCode && sibling.nodeName === 'CODE') {
        isFlanked = false;
      } else if (sibling.nodeType === 1 && !isBlock(sibling)) {
        isFlanked = regExp.test(sibling.textContent);
      }
    }
    return isFlanked
  }

  var reduce = Array.prototype.reduce;
  var escapes = [
    [/\\/g, '\\\\'],
    [/\*/g, '\\*'],
    [/^-/g, '\\-'],
    [/^\+ /g, '\\+ '],
    [/^(=+)/g, '\\$1'],
    [/^(#{1,6}) /g, '\\$1 '],
    [/`/g, '\\`'],
    [/^~~~/g, '\\~~~'],
    [/\[/g, '\\['],
    [/\]/g, '\\]'],
    [/^>/g, '\\>'],
    [/_/g, '\\_'],
    [/^(\d+)\. /g, '$1\\. ']
  ];

  function TurndownService (options) {
    if (!(this instanceof TurndownService)) return new TurndownService(options)

    var defaults = {
      rules: rules,
      headingStyle: 'setext',
      hr: '* * *',
      bulletListMarker: '*',
      codeBlockStyle: 'indented',
      fence: '```',
      emDelimiter: '_',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      linkReferenceStyle: 'full',
      br: '  ',
      preformattedCode: false,
      blankReplacement: function (content, node) {
        return node.isBlock ? '\n\n' : ''
      },
      keepReplacement: function (content, node) {
        return node.isBlock ? '\n\n' + node.outerHTML + '\n\n' : node.outerHTML
      },
      defaultReplacement: function (content, node) {
        return node.isBlock ? '\n\n' + content + '\n\n' : content
      }
    };
    this.options = extend({}, defaults, options);
    this.rules = new Rules(this.options);
  }

  TurndownService.prototype = {
    /**
     * The entry point for converting a string or DOM node to Markdown
     * @public
     * @param {String|HTMLElement} input The string or DOM node to convert
     * @returns A Markdown representation of the input
     * @type String
     */

    turndown: function (input) {
      if (!canConvert(input)) {
        throw new TypeError(
          input + ' is not a string, or an element/document/fragment node.'
        )
      }

      if (input === '') return ''

      var output = process.call(this, new RootNode(input, this.options));
      return postProcess.call(this, output)
    },

    /**
     * Add one or more plugins
     * @public
     * @param {Function|Array} plugin The plugin or array of plugins to add
     * @returns The Turndown instance for chaining
     * @type Object
     */

    use: function (plugin) {
      if (Array.isArray(plugin)) {
        for (var i = 0; i < plugin.length; i++) this.use(plugin[i]);
      } else if (typeof plugin === 'function') {
        plugin(this);
      } else {
        throw new TypeError('plugin must be a Function or an Array of Functions')
      }
      return this
    },

    /**
     * Adds a rule
     * @public
     * @param {String} key The unique key of the rule
     * @param {Object} rule The rule
     * @returns The Turndown instance for chaining
     * @type Object
     */

    addRule: function (key, rule) {
      this.rules.add(key, rule);
      return this
    },

    /**
     * Keep a node (as HTML) that matches the filter
     * @public
     * @param {String|Array|Function} filter The unique key of the rule
     * @returns The Turndown instance for chaining
     * @type Object
     */

    keep: function (filter) {
      this.rules.keep(filter);
      return this
    },

    /**
     * Remove a node that matches the filter
     * @public
     * @param {String|Array|Function} filter The unique key of the rule
     * @returns The Turndown instance for chaining
     * @type Object
     */

    remove: function (filter) {
      this.rules.remove(filter);
      return this
    },

    /**
     * Escapes Markdown syntax
     * @public
     * @param {String} string The string to escape
     * @returns A string with Markdown syntax escaped
     * @type String
     */

    escape: function (string) {
      return escapes.reduce(function (accumulator, escape) {
        return accumulator.replace(escape[0], escape[1])
      }, string)
    }
  };

  /**
   * Reduces a DOM node down to its Markdown string equivalent
   * @private
   * @param {HTMLElement} parentNode The node to convert
   * @returns A Markdown representation of the node
   * @type String
   */

  function process (parentNode) {
    var self = this;
    return reduce.call(parentNode.childNodes, function (output, node) {
      node = new Node(node, self.options);

      var replacement = '';
      if (node.nodeType === 3) {
        replacement = node.isCode ? node.nodeValue : self.escape(node.nodeValue);
      } else if (node.nodeType === 1) {
        replacement = replacementForNode.call(self, node);
      }

      return join(output, replacement)
    }, '')
  }

  /**
   * Appends strings as each rule requires and trims the output
   * @private
   * @param {String} output The conversion output
   * @returns A trimmed version of the ouput
   * @type String
   */

  function postProcess (output) {
    var self = this;
    this.rules.forEach(function (rule) {
      if (typeof rule.append === 'function') {
        output = join(output, rule.append(self.options));
      }
    });

    return output.replace(/^[\t\r\n]+/, '').replace(/[\t\r\n\s]+$/, '')
  }

  /**
   * Converts an element node to its Markdown equivalent
   * @private
   * @param {HTMLElement} node The node to convert
   * @returns A Markdown representation of the node
   * @type String
   */

  function replacementForNode (node) {
    var rule = this.rules.forNode(node);
    var content = process.call(this, node);
    var whitespace = node.flankingWhitespace;
    if (whitespace.leading || whitespace.trailing) content = content.trim();
    return (
      whitespace.leading +
      rule.replacement(content, node, this.options) +
      whitespace.trailing
    )
  }

  /**
   * Joins replacement to the current output with appropriate number of new lines
   * @private
   * @param {String} output The current conversion output
   * @param {String} replacement The string to append to the output
   * @returns Joined output
   * @type String
   */

  function join (output, replacement) {
    var s1 = trimTrailingNewlines(output);
    var s2 = trimLeadingNewlines(replacement);
    var nls = Math.max(output.length - s1.length, replacement.length - s2.length);
    var separator = '\n\n'.substring(0, nls);

    return s1 + separator + s2
  }

  /**
   * Determines whether an input can be converted
   * @private
   * @param {String|HTMLElement} input Describe this parameter
   * @returns Describe what it returns
   * @type String|Object|Array|Boolean|Number
   */

  function canConvert (input) {
    return (
      input != null && (
        typeof input === 'string' ||
        (input.nodeType && (
          input.nodeType === 1 || input.nodeType === 9 || input.nodeType === 11
        ))
      )
    )
  }

  return TurndownService;

}());


var turndownPluginGfm = (function (exports) {
'use strict';

var highlightRegExp = /highlight-(?:text|source)-([a-z0-9]+)/;

function highlightedCodeBlock (turndownService) {
  turndownService.addRule('highlightedCodeBlock', {
    filter: function (node) {
      var firstChild = node.firstChild;
      return (
        node.nodeName === 'DIV' &&
        highlightRegExp.test(node.className) &&
        firstChild &&
        firstChild.nodeName === 'PRE'
      )
    },
    replacement: function (content, node, options) {
      var className = node.className || '';
      var language = (className.match(highlightRegExp) || [null, ''])[1];

      return (
        '\n\n' + options.fence + language + '\n' +
        node.firstChild.textContent +
        '\n' + options.fence + '\n\n'
      )
    }
  });
}

function strikethrough (turndownService) {
  turndownService.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: function (content) {
      return '~' + content + '~'
    }
  });
}

var indexOf = Array.prototype.indexOf;
var every = Array.prototype.every;
var rules = {};

rules.tableCell = {
  filter: ['th', 'td'],
  replacement: function (content, node) {
    return cell(content, node)
  }
};

rules.tableRow = {
  filter: 'tr',
  replacement: function (content, node) {
    var borderCells = '';
    var alignMap = { left: ':--', right: '--:', center: ':-:' };

    if (isHeadingRow(node)) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var border = '---';
        var align = (
          node.childNodes[i].getAttribute('align') || ''
        ).toLowerCase();

        if (align) border = alignMap[align] || border;

        borderCells += cell(border, node.childNodes[i]);
      }
    }
    return '\n' + content + (borderCells ? '\n' + borderCells : '')
  }
};

rules.table = {
  // Only convert tables with a heading row.
  // Tables with no heading row are kept using `keep` (see below).
  filter: function (node) {
    return node.nodeName === 'TABLE' && isHeadingRow(node.rows[0])
  },

  replacement: function (content) {
    // Ensure there are no blank lines
    content = content.replace('\n\n', '\n');
    return '\n\n' + content + '\n\n'
  }
};

rules.tableSection = {
  filter: ['thead', 'tbody', 'tfoot'],
  replacement: function (content) {
    return content
  }
};

// A tr is a heading row if:
// - the parent is a THEAD
// - or if its the first child of the TABLE or the first TBODY (possibly
//   following a blank THEAD)
// - and every cell is a TH
function isHeadingRow (tr) {
  var parentNode = tr.parentNode;
  return (
    parentNode.nodeName === 'THEAD' ||
    (
      parentNode.firstChild === tr &&
      (parentNode.nodeName === 'TABLE' || isFirstTbody(parentNode)) &&
      every.call(tr.childNodes, function (n) { return n.nodeName === 'TH' })
    )
  )
}

function isFirstTbody (element) {
  var previousSibling = element.previousSibling;
  return (
    element.nodeName === 'TBODY' && (
      !previousSibling ||
      (
        previousSibling.nodeName === 'THEAD' &&
        /^\s*$/i.test(previousSibling.textContent)
      )
    )
  )
}

function cell (content, node) {
  var index = indexOf.call(node.parentNode.childNodes, node);
  var prefix = ' ';
  if (index === 0) prefix = '| ';
  return prefix + content + ' |'
}

function tables (turndownService) {
  turndownService.keep(function (node) {
    return node.nodeName === 'TABLE' && !isHeadingRow(node.rows[0])
  });
  for (var key in rules) turndownService.addRule(key, rules[key]);
}

function taskListItems (turndownService) {
  turndownService.addRule('taskListItems', {
    filter: function (node) {
      return node.type === 'checkbox' && node.parentNode.nodeName === 'LI'
    },
    replacement: function (content, node) {
      return (node.checked ? '[x]' : '[ ]') + ' '
    }
  });
}

function gfm (turndownService) {
  turndownService.use([
    highlightedCodeBlock,
    strikethrough,
    tables,
    taskListItems
  ]);
}

exports.gfm = gfm;
exports.highlightedCodeBlock = highlightedCodeBlock;
exports.strikethrough = strikethrough;
exports.tables = tables;
exports.taskListItems = taskListItems;

return exports;

}({}));


// Turndown 投入前の HTML 前処理。
//
// ensureTableHeaders: turndown-plugin-gfm は isHeadingRow=true でないと <table> を raw HTML のまま保持する。
// GFM 仕様で header 行は必須なので、<th> を持たない <table> に空の <thead> を column 数分注入して
// markdown table 化を可能にする。元データはそのまま data row として保存。
//
// 利用側: DOMParser が使える環境 (browser / Playwright eval) を前提。

function ensureTableHeaders(htmlString) {
    try {
        if (typeof DOMParser === 'undefined') return htmlString;
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlString, 'text/html');
        var tables = doc.querySelectorAll('table');
        for (var ti = 0; ti < tables.length; ti++) {
            var table = tables[ti];
            if (table.querySelector('th')) continue;
            var existingThead = table.querySelector('thead');
            if (existingThead && existingThead.textContent.trim()) continue;
            var firstRow = table.querySelector('tr');
            if (!firstRow) continue;
            var colCount = firstRow.children.length;
            if (colCount === 0) continue;
            // 空 thead があれば削除して入れ直す
            if (existingThead) existingThead.parentNode.removeChild(existingThead);
            var thead = doc.createElement('thead');
            var tr = doc.createElement('tr');
            for (var ci = 0; ci < colCount; ci++) {
                tr.appendChild(doc.createElement('th'));
            }
            thead.appendChild(tr);
            table.insertBefore(thead, table.firstChild);
        }
        return doc.body.innerHTML;
    } catch (e) {
        return htmlString;
    }
}


// HTML → Markdown 変換用 Turndown 独自 rule (8 個)
// fractal editor.js paste handler (v0.207.49) から抽出。
//
// 利用側: addCustomRules(turndownService) を呼ぶと 8 rule が登録される。
// 前提: turndownService が turndown-plugin-gfm を use() 済み。

function addCustomRules(turndownService) {
    // Rule 1: Table cell の pipe escape + cell 内改行を <br> に変換
    turndownService.addRule('tableCellEscapePipe', {
        filter: ['th', 'td'],
        replacement: function(content, node) {
            var index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
            var prefix = ' ';
            if (index === 0) prefix = '| ';
            content = content.replace(/\n/g, '<br>');
            content = content.replace(/(<br>)+/g, '<br>');
            content = content.replace(/^(<br>)+/, '').replace(/(<br>)+$/, '');
            content = content.replace(/\|/g, '\\|');
            return prefix + content + ' |';
        }
    });

    // Rule 2: 空 span / Apple-converted-space 削除
    turndownService.addRule('cleanupSpans', {
        filter: function(node) {
            if (node.nodeName !== 'SPAN') return false;
            if (node.classList && node.classList.contains('Apple-converted-space')) return true;
            var hasOnlyStyleAttr = node.attributes.length === 1 && node.hasAttribute('style');
            var hasNoContent = !node.textContent || node.textContent.trim() === '';
            return hasOnlyStyleAttr && hasNoContent;
        },
        replacement: function(content, node) {
            if (node.classList && node.classList.contains('Apple-converted-space')) return ' ';
            return content;
        }
    });

    // Rule 3: CSS style-based bold (Google Docs / 一部 web page)
    turndownService.addRule('styledBold', {
        filter: function(node) {
            if (node.nodeName !== 'SPAN') return false;
            var fw = node.style.fontWeight;
            return fw === 'bold' || fw === 'bolder' || (parseInt(fw) >= 700);
        },
        replacement: function(content) {
            content = content.trim();
            if (!content) return '';
            return '**' + content + '**';
        }
    });

    // Rule 4: CSS style-based italic
    turndownService.addRule('styledItalic', {
        filter: function(node) {
            if (node.nodeName !== 'SPAN') return false;
            var fs = node.style.fontStyle;
            return fs === 'italic' || fs === 'oblique';
        },
        replacement: function(content) {
            content = content.trim();
            if (!content) return '';
            return '*' + content + '*';
        }
    });

    // Rule 5: CSS style-based strikethrough
    turndownService.addRule('styledStrikethrough', {
        filter: function(node) {
            if (node.nodeName !== 'SPAN') return false;
            var td = node.style.textDecoration || node.style.textDecorationLine || '';
            return td.indexOf('line-through') !== -1;
        },
        replacement: function(content) {
            content = content.trim();
            if (!content) return '';
            return '~~' + content + '~~';
        }
    });

    // <pre> 配下を再帰 walk して text 抽出 (<br> → \n)
    function preToText(n) {
        var out = '';
        var child = n.firstChild;
        while (child) {
            if (child.nodeType === 3) {
                out += child.nodeValue || '';
            } else if (child.nodeName === 'BR') {
                out += '\n';
            } else if (child.nodeType === 1) {
                out += preToText(child);
            }
            child = child.nextSibling;
        }
        return out;
    }

    // Rule 6: fenced code block + 言語抽出
    // 通常: <pre><code class="language-xxx">...</code></pre>
    // Medium 等: <pre><span class="hljs-keyword">def</span>...<br>...</pre> (code 要素なし、改行 <br>)
    turndownService.addRule('fencedCodeWithLang', {
        filter: function(node) {
            if (node.nodeName !== 'PRE') return false;
            if (node.querySelector('code')) return true;
            if (node.querySelector('[class*="hljs-"]')) return true;
            if (node.querySelector('br')) return true;
            return false;
        },
        replacement: function(content, node) {
            var code = node.querySelector('code');
            var lang = '';
            var text = '';
            try {
                if (code) {
                    var cls = code.className || '';
                    lang = (cls.match(/language-(\S+)/) || [null, ''])[1];
                    if (!lang) lang = code.getAttribute('language') || node.getAttribute('language') || '';
                    if (!lang) lang = node.getAttribute('data-lang') || '';
                    text = code.textContent || '';
                } else {
                    text = preToText(node);
                    var langEl = node.querySelector('[class*="language-"]');
                    if (langEl) lang = (langEl.className.match(/language-(\S+)/) || [null, ''])[1];
                }
            } catch (e) {
                text = '';
            }
            if (!text) text = node.textContent || content || '';
            lang = (lang || '').split(/\s+/)[0] || '';
            if (['hljs', 'nohighlight', 'shiki'].indexOf(lang) !== -1) lang = '';
            return '\n\n```' + lang + '\n' + text.replace(/\n$/, '') + '\n```\n\n';
        }
    });

    // Rule 7: link content normalization (multi-line link, bracket citation, image-wrap simplify)
    turndownService.addRule('normalizeLink', {
        filter: function(node) {
            return node.nodeName === 'A' && node.getAttribute('href');
        },
        replacement: function(content, node) {
            var href = node.getAttribute('href');
            if (href) href = href.replace(/([()])/g, '\\$1');
            var title = node.getAttribute('title');
            if (title) title = ' "' + title.replace(/"/g, '\\"') + '"';
            else title = '';
            // <a> がテキストを持たず <img> だけを wrap してる場合は内側の image markdown だけ返す
            if ((node.textContent || '').trim() === '' && node.querySelector && node.querySelector('img')) {
                return content;
            }
            // multi-line link text を 1 行にまとめる
            content = content.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
            if (!content) return '';
            // Wikipedia-style citation: [40] のように [..] で囲まれた link text は外側を残して中身を link 化
            var bracketMatch = content.match(/^\\?\[(.+?)\\?\]$/);
            if (bracketMatch) {
                return '[[' + bracketMatch[1] + '](' + href + title + ')]';
            }
            return '[' + content + '](' + href + title + ')';
        }
    });

    // Rule 8: tight list item (Turndown default の loose list を抑止)
    turndownService.addRule('compactListItem', {
        filter: 'li',
        replacement: function(content, node, options) {
            content = content.replace(/^\n+/, '').replace(/\n+$/, '');
            content = content.replace(/\n/gm, '\n    ');
            var prefix = options.bulletListMarker + ' ';
            var parent = node.parentNode;
            if (parent.nodeName === 'OL') {
                var start = parent.getAttribute('start');
                var index = Array.prototype.indexOf.call(parent.children, node);
                prefix = (start ? Number(start) + index : index + 1) + '. ';
            }
            return prefix + content + (node.nextSibling ? '\n' : '');
        }
    });
}


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


// HTML → Markdown 変換のエントリーポイント。
//
// 利用側 (browser / Playwright eval):
//   HtmlMdConverter.htmlToMarkdown(html) → string
//
// 内部:
//   1. ensureTableHeaders で <th> 不在 table に空 header 注入 (GFM table 化)
//   2. Turndown + GFM plugin + 独自 8 rule で変換
//   3. postprocess で unescape + tight list

function htmlToMarkdown(html) {
    if (!html) return '';
    if (typeof TurndownService === 'undefined') {
        throw new Error('TurndownService not loaded');
    }
    var preprocessed = ensureTableHeaders(html);

    var turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        bulletListMarker: '-'
    });
    if (typeof turndownPluginGfm !== 'undefined') {
        turndownService.use(turndownPluginGfm.gfm);
    }
    addCustomRules(turndownService);

    var md = turndownService.turndown(preprocessed);
    return postprocess(md);
}

/**
 * Mozilla Readability で記事抽出 → htmlToMarkdown で変換。
 * Chrome extension / web clipper 向け。Readability lib を呼び出し側で別途 load 必須。
 *
 * @param {Document} documentClone — document.cloneNode(true) の結果を渡す
 * @returns {{ title, markdown, byline, siteName, length, excerpt }}
 */
function articleToMarkdown(documentClone) {
    if (typeof Readability === 'undefined') {
        throw new Error('Readability not loaded — load it before calling articleToMarkdown');
    }
    var reader = new Readability(documentClone);
    var article = reader.parse();
    if (!article || !article.content) {
        return { title: '', markdown: '', byline: '', siteName: '' };
    }
    return {
        title: article.title || '',
        markdown: htmlToMarkdown(article.content),
        byline: article.byline || '',
        siteName: article.siteName || '',
        length: article.length,
        excerpt: article.excerpt || ''
    };
}

    // 公開 API
    global.HtmlMdConverter = {
        version: "0.1.0",
        htmlToMarkdown: htmlToMarkdown,
        articleToMarkdown: articleToMarkdown,
        // 個別関数 (テスト / カスタマイズ用)
        ensureTableHeaders: ensureTableHeaders,
        addCustomRules: addCustomRules,
        postprocess: postprocess,
        // bundled vendors (consumer 側で他用途に使う場合)
        TurndownService: TurndownService,
        turndownPluginGfm: turndownPluginGfm,
    };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
