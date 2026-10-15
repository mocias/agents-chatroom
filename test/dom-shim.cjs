'use strict';
/**
 * The smallest DOM the room UI actually touches.
 *
 * Shared by the UI tests because `public/room-ui.js` is one file: a shim that
 * satisfies the roster test but not the attachment test would be two disagreeing
 * models of the same code. There is no jsdom in this runtime, so this is
 * hand-rolled, and it is deliberately narrow — a class that implements more than
 * the UI uses would be a place for the UI's real behaviour to hide.
 *
 * Extracted verbatim from `ui-members.cjs` so both tests drive the same object.
 */
// ---------------------------------------------------------------- DOM shim --

class ClassList {
  constructor(node) {
    this.node = node;
  }
  _list() {
    return String(this.node.className || '').split(/\s+/).filter(Boolean);
  }
  add(...names) {
    const list = this._list();
    for (const name of names) if (!list.includes(name)) list.push(name);
    this.node.className = list.join(' ');
  }
  remove(...names) {
    this.node.className = this._list().filter((n) => !names.includes(n)).join(' ');
  }
  contains(name) {
    return this._list().includes(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

/**
 * A `style` that understands custom properties.
 *
 * The room UI paints its theme by writing `--ar-*` variables, and a custom
 * property can only be set through `setProperty` — `style['--ar-bg'] = x` is
 * silently ignored by a real browser. A shim whose `style` was a bare object
 * would therefore make the theme untestable and, worse, would agree with a UI
 * that never painted anything.
 */
class Style {
  constructor() {
    this._props = new Map();
  }
  setProperty(name, value) {
    this._props.set(String(name), String(value));
  }
  getPropertyValue(name) {
    return this._props.get(String(name)) || '';
  }
  removeProperty(name) {
    this._props.delete(String(name));
  }
}

class Element {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = new Style();
    this.className = '';
    this.classList = new ClassList(this);
    this._text = '';
    this._html = '';
    this._value = '';
    this._valueSet = false;
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.onclick = null;
    this.onchange = null;
    this.oninput = null;
    this.onkeydown = null;
    this.onblur = null;
  }

  set id(value) {
    this.attributes.id = value;
  }
  get id() {
    return this.attributes.id;
  }

  /**
   * A real `<select>` derives its value from the selected `<option>`, and
   * selecting one option deselects its siblings. The UI relies on both: it
   * pre-selects the member's current model, and it appends the current model as
   * an extra option when the catalogue does not offer it. Getting this wrong
   * would make the test agree with a bug.
   */
  set value(value) {
    this._value = String(value == null ? '' : value);
    if (this.tagName === 'SELECT') {
      for (const option of this.children) option._selected = option.value === this._value;
    }
    /**
     * Setting a file input's `value` to `''` clears its `files` list — that is
     * the documented way to reset a picker, and the room UI relies on it so the
     * same file can be chosen twice in a row. A shim that kept `files` would
     * make that reset look like it worked while the real browser also needed the
     * list emptied.
     */
    if (this.tagName === 'INPUT' && this.attributes.type === 'file' && this._value === '') {
      this.files = [];
    }
  }
  get value() {
    if (this.tagName === 'SELECT') {
      const options = this.children.filter((c) => c.tagName === 'OPTION');
      const chosen = options.find((o) => o._selected) || options[0];
      return chosen ? chosen.value : '';
    }
    return this._value;
  }

  set selected(value) {
    this._selected = !!value;
    if (value && this.parentNode && this.parentNode.tagName === 'SELECT') {
      for (const sibling of this.parentNode.children) {
        if (sibling !== this && sibling.tagName === 'OPTION') sibling._selected = false;
      }
    }
  }
  get selected() {
    return !!this._selected;
  }

  set textContent(value) {
    this._text = String(value == null ? '' : value);
    this.children = [];
    this._html = '';
  }
  get textContent() {
    if (this.children.length) return this._text + this.children.map((c) => c.textContent).join('');
    return this._text;
  }

  set innerHTML(value) {
    const markup = String(value == null ? '' : value);
    this._html = markup;
    this._text = '';
    this.children = [];
    parseInto(this, markup);
  }
  get innerHTML() {
    // The UI only ever reads innerHTML through this test's own assertions.
    return this._html;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    // Selecting an option in a real <select> clears its siblings.
    if (child.tagName === 'OPTION' && child._selected && this.tagName === 'SELECT') {
      for (const sibling of this.children) if (sibling !== child) sibling._selected = false;
    }
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChild(next, previous) {
    const index = this.children.indexOf(previous);
    if (index < 0) throw new Error('replaceChild: node is not a child');
    next.parentNode = this;
    this.children[index] = next;
    previous.parentNode = null;
    return previous;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name];
  }
  /**
   * Event listeners, kept in a map.
   *
   * The roster test only ever called `onclick`/`onchange` directly, so the
   * original shim could discard listeners. The attachment surface is wired with
   * `addEventListener` (`dragover`/`dragleave`/`drop` on the root, `paste` on the
   * composer), so discarding them would make drag-and-drop, and the reason
   * `dragover` has to be cancelled, untestable.
   */
  addEventListener(type, handler) {
    if (!this._listeners) this._listeners = new Map();
    const key = String(type);
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    this._listeners.get(key).push(handler);
  }
  removeEventListener(type, handler) {
    if (!this._listeners) return;
    const list = this._listeners.get(String(type));
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  /** Fire every listener registered for `type`; reflects `dispatchEvent`. */
  dispatchEvent(event) {
    const list = (this._listeners && this._listeners.get(String(event.type))) || [];
    event.target = event.target || this;
    event.currentTarget = this;
    for (const handler of [...list]) handler(event);
    return true;
  }
  /** True when `node` is this element or a descendant; mirrors `Node.contains`. */
  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    for (const child of this.children) if (child.contains(node)) return true;
    return false;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {}

  /**
   * Descendant search. Supports the two selector shapes the UI uses:
   * `[data-el="x"]`, `.class`, and `tag`. `querySelectorAll` and selector lists
   * are supported for completeness (the UI uses `.ar-empty` — a class).
   */
  querySelector(selector) {
    return this._find(selector, true)[0] || null;
  }
  querySelectorAll(selector) {
    return this._find(selector, false);
  }
  _find(selector, first) {
    const out = [];
    const matches = (node) => {
      const name = selector.trim();
      if (name.startsWith('[data-el=')) {
        const key = name.slice(name.indexOf('"') + 1, name.lastIndexOf('"'));
        return node.attributes['data-el'] === key;
      }
      if (name.startsWith('.')) return node.classList.contains(name.slice(1));
      return node.tagName === name.toUpperCase();
    };
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child)) {
          out.push(child);
          if (first) return true;
        }
        if (walk(child)) return true;
      }
      return false;
    };
    walk(this);
    return out;
  }

  /** Depth-first walk of the light tree; used by assertions. */
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
}

class Document {
  constructor() {
    this.head = new Element('head', this);
    this.body = new Element('body', this);
    this._byId = new Map();
  }
  createElement(tag) {
    return new Element(tag, this);
  }
  getElementById(id) {
    return this._byId.get(id) || null;
  }
  _register(style) {
    if (style.id) this._byId.set(style.id, style);
  }
  querySelector(selector) {
    return this.body.querySelector(selector);
  }
}

// ------------------------------------------------------- minimal HTML parser --
//
// The UI builds its chrome with `innerHTML`. A real DOM is not available in
// this runtime, so this parses the small subset of HTML the UI emits: elements
// with double-quoted attributes, text nodes, void elements, and comments.
// Entity decoding covers what the UI writes (`&amp;` etc. via escapeHtml).

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source']);

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseInto(parent, markup) {
  const doc = parent.ownerDocument;
  const tagPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+))?)*)\s*\/?>/g;
  let cursor = 0;
  let open = null; // current open element, if any
  let match;

  const addText = (raw) => {
    const text = decodeEntities(raw);
    if (!text.trim() && !open) return;
    const node = doc.createElement('#text');
    node._text = text;
    node.parentNode = open || parent;
    (open || parent).children.push(node);
  };

  while ((match = tagPattern.exec(markup))) {
    if (match.index > cursor) addText(markup.slice(cursor, match.index));
    cursor = tagPattern.lastIndex;

    const whole = match[0];
    if (whole.startsWith('<!--')) continue;

    const name = match[1].toLowerCase();
    const isClose = whole.startsWith('</');
    if (isClose) {
      open = open && open.parentNode !== parent ? open.parentNode : null;
      continue;
    }

    const node = doc.createElement(name);
    const attrPattern = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;
    let attr;
    while ((attr = attrPattern.exec(match[2] || ''))) {
      const value = attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : attr[4] !== undefined ? attr[4] : '';
      node.setAttribute(attr[1], decodeEntities(value));
      if (attr[1] === 'class') node.className = decodeEntities(value);
      if (attr[1] === 'id') node.id = decodeEntities(value);
      if (attr[1] === 'hidden') node.hidden = true;
      if (attr[1] === 'value') node.value = decodeEntities(value);
    }

    node.parentNode = open || parent;
    (open || parent).children.push(node);

    if (VOID_TAGS.has(name) || whole.endsWith('/>')) continue;
    open = node;
  }
  if (markup.length > cursor) addText(markup.slice(cursor));
}
module.exports = { ClassList, Style, Element, Document, decodeEntities, parseInto, VOID_TAGS };
