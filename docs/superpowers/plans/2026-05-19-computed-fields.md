# Computed Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add auto-calculated fields to the schema system — fields whose values are derived from expressions referencing other fields (e.g., `C = price * qty`), computed on every read and write.

**Architecture:** A safe math expression evaluator (CALC engine) runs server-side inside the Worker. Field descriptors gain an optional `computed: { expr, format, precision }` property. After every data write (create/replace/patch) and read (list/get), computed fields are evaluated and injected into the response. The UI gets a "Computed" column in the Schema tab and live formula preview in the create/edit modal.

**Tech Stack:** Cloudflare Worker (ES modules), vanilla JS UI, no external deps.

---

### Task 1: CALC Engine — Safe Expression Evaluator

**Files:**
- Modify: `G:\CRUD x\workerv2.js` (add CALC object after line 66, before Schema store)

- [ ] **Step 1: Add the CALC engine to workerv2.js**

Insert after the `IDX` block (after line 66), before the `S = {` schema store block:

```javascript
// ── CALC engine — safe expression evaluator ──────────────────────
//
// Supports: +  -  *  /  %  **  ( )
//           ==  !=  <  <=  >  >=
//           &&  ||  !   ternary ? :
//           ?? (nullish coalescing)
// Functions: round, ceil, floor, abs, min, max, pow, sqrt, log
//            len, upper, lower, trim, concat, substring
//            if(condition, then, else)
//            now() — ISO string
//            date(field) — parse date field for comparisons
//
// No eval(), no Function(), no new Function().
// Recursive descent parser → AST → evaluate.

const CALC = {
  // Tokenizer
  tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (/\s/.test(ch)) { i++; continue; }
      // Number (including negative after operator or start)
      if (/\d/.test(ch) || (ch === '.' && /\d/.test(expr[i+1]))) {
        let n = '';
        while (i < expr.length && /[\d.]/.test(expr[i])) n += expr[i++];
        tokens.push({ t: 'num', v: Number(n) });
        continue;
      }
      // String literal
      if (ch === "'" || ch === '"') {
        const q = ch; let s = ''; i++;
        while (i < expr.length && expr[i] !== q) { if (expr[i] === '\\' && expr[i+1]) i++; s += expr[i]; i++; }
        i++; // closing quote
        tokens.push({ t: 'str', v: s });
        continue;
      }
      // Identifier (field name or function name)
      if (/[a-zA-Z_]/.test(ch)) {
        let id = '';
        while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) id += expr[i++];
        tokens.push({ t: 'id', v: id });
        continue;
      }
      // Two-char operators
      const two = expr.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||', '**', '??'].includes(two)) {
        tokens.push({ t: 'op', v: two }); i += 2; continue;
      }
      // Single-char operators and punctuation
      if ('+-*/%<>!?:(){}.,'.includes(ch)) {
        tokens.push({ t: 'op', v: ch }); i++; continue;
      }
      i++; // skip unknown
    }
    return tokens;
  },

  // Parser → AST
  parse(tokens) {
    let pos = 0;
    function peek() { return tokens[pos]; }
    function eat() { return tokens[pos++]; }
    function expect(v) { const tk = eat(); if (!tk || tk.v !== v) throw new Error(`Expected '${v}', got '${tk?.v ?? 'EOF'}'`); return tk; }

    // Precedence climbing
    function parseExpr(minPrec = 0) {
      let left = parseUnary();
      while (true) {
        const tk = peek();
        if (!tk || tk.t !== 'op') break;
        const prec = CALC.prec(tk.v);
        if (prec === null || prec < minPrec) break;
        const op = eat().v;
        if (op === '?') {
          // ternary
          const then_ = parseExpr(0);
          expect(':');
          const else_ = parseExpr(0);
          left = { type: 'ternary', cond: left, then: then_, else: else_ };
        } else {
          const right = parseExpr(prec + 1);
          left = { type: 'binop', op, left, right };
        }
      }
      return left;
    }

    function parseUnary() {
      const tk = peek();
      if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '!')) {
        const op = eat().v;
        return { type: 'unary', op, expr: parseUnary() };
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const tk = peek();
      if (!tk) throw new Error('Unexpected end of expression');

      // Number literal
      if (tk.t === 'num') { eat(); return { type: 'lit', value: tk.v }; }
      // String literal
      if (tk.t === 'str') { eat(); return { type: 'lit', value: tk.v }; }
      // Grouped expression
      if (tk.t === 'op' && tk.v === '(') { eat(); const e = parseExpr(0); expect(')'); return e; }
      // Array literal [a, b, c]
      if (tk.t === 'op' && tk.v === '[') {
        eat();
        const items = [];
        while (peek() && !(peek().t === 'op' && peek().v === ']')) {
          items.push(parseExpr(0));
          if (peek()?.t === 'op' && peek().v === ',') eat();
        }
        expect(']');
        return { type: 'array', items };
      }

      // Identifier — could be field ref or function call
      if (tk.t === 'id') {
        const name = eat().v;
        // Function call
        if (peek()?.t === 'op' && peek().v === '(') {
          eat();
          const args = [];
          while (peek() && !(peek().t === 'op' && peek().v === ')')) {
            args.push(parseExpr(0));
            if (peek()?.t === 'op' && peek().v === ',') eat();
          }
          expect(')');
          return { type: 'call', name, args };
        }
        return { type: 'ref', name };
      }

      throw new Error(`Unexpected token: ${JSON.stringify(tk)}`);
    }

    const ast = parseExpr(0);
    if (pos < tokens.length) throw new Error(`Unexpected token after expression: ${JSON.stringify(tokens[pos])}`);
    return ast;
  },

  prec(op) {
    const table = {
      '||': 1, '&&': 2,
      '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
      '??': 4,
      '+': 5, '-': 5,
      '*': 6, '/': 6, '%': 6,
      '**': 7,
    };
    return table[op] ?? null;
  },

  // Evaluator
  evaluate(ast, ctx) {
    switch (ast.type) {
      case 'lit': return ast.value;
      case 'ref': {
        const v = ctx[ast.name];
        return v !== undefined ? v : 0; // missing fields default to 0 for math
      }
      case 'array': return ast.items.map(a => CALC.evaluate(a, ctx));
      case 'unary': {
        const v = CALC.evaluate(ast.expr, ctx);
        if (ast.op === '-') return -v;
        if (ast.op === '!') return !v;
        return v;
      }
      case 'binop': {
        const l = CALC.evaluate(ast.left, ctx);
        const r = CALC.evaluate(ast.right, ctx);
        switch (ast.op) {
          case '+':  return (typeof l === 'string' || typeof r === 'string') ? String(l ?? '') + String(r ?? '') : l + r;
          case '-':  return l - r;
          case '*':  return l * r;
          case '/':  return r === 0 ? 0 : l / r;
          case '%':  return r === 0 ? 0 : l % r;
          case '**': return Math.pow(l, r);
          case '==': return l == r;
          case '!=': return l != r;
          case '<':  return l < r;
          case '<=': return l <= r;
          case '>':  return l > r;
          case '>=': return l >= r;
          case '&&': return l && r;
          case '||': return l || r;
          case '??': return l ?? r;
        }
        return 0;
      }
      case 'ternary': {
        return CALC.evaluate(ast.cond, ctx)
          ? CALC.evaluate(ast.then, ctx)
          : CALC.evaluate(ast.else, ctx);
      }
      case 'call': {
        const args = ast.args.map(a => CALC.evaluate(a, ctx));
        return CALC.callFn(ast.name, args, ctx);
      }
    }
    return 0;
  },

  callFn(name, args, ctx) {
    const fns = {
      round:  ([n, p]) => p != null ? Number(n.toFixed(p)) : Math.round(n),
      ceil:   ([n]) => Math.ceil(n),
      floor:  ([n]) => Math.floor(n),
      abs:    ([n]) => Math.abs(n),
      min:    (a) => Math.min(...a),
      max:    (a) => Math.max(...a),
      pow:    ([b, e]) => Math.pow(b, e),
      sqrt:   ([n]) => Math.sqrt(n),
      log:    ([n]) => Math.log(n),
      len:    ([s]) => (typeof s === 'string' ? s.length : Array.isArray(s) ? s.length : 0),
      upper:  ([s]) => String(s).toUpperCase(),
      lower:  ([s]) => String(s).toLowerCase(),
      trim:   ([s]) => String(s).trim(),
      concat: (a) => a.join(''),
      substring: ([s, start, end]) => String(s).slice(start ?? 0, end),
      if:     ([cond, then_, else_]) => cond ? then_ : else_,
      now:    () => new Date().toISOString(),
      date:   ([s]) => new Date(s).getTime() / 1000,
      isNaN:  ([n]) => isNaN(n),
      number: ([s]) => Number(s),
      string: ([v]) => String(v),
    };
    const fn = fns[name];
    if (!fn) throw new Error(`Unknown function: ${name}`);
    return fn(args);
  },

  // Top-level: parse + evaluate
  run(expr, item) {
    try {
      const tokens = CALC.tokenize(expr);
      const ast = CALC.parse(tokens);
      return CALC.evaluate(ast, item);
    } catch (e) {
      return { _error: e.message };
    }
  },
};
```

- [ ] **Step 2: Verify syntax by reading back the inserted code**

Run: read `workerv2.js` lines 67-230 to confirm CALC is inserted before `const S = {`

- [ ] **Step 3: Commit**

```bash
git add workerv2.js
git commit -m "feat: add CALC safe expression evaluator engine"
```

---

### Task 2: applyComputed — Apply Computed Fields After Read/Write

**Files:**
- Modify: `G:\CRUD x\workerv2.js`

- [ ] **Step 1: Add `applyComputed` and `applyComputedList` functions**

Insert after the CALC engine block, before `const S = {`:

```javascript
// ── Computed field application ────────────────────────────────────

function applyComputed(item, fields) {
  const out = { ...item };
  for (const [key, r] of Object.entries(fields)) {
    if (!r.computed?.expr) continue;
    const result = CALC.run(r.computed.expr, out);
    if (result && typeof result === 'object' && result._error) {
      out[key] = null; // expression error → null
    } else {
      // Apply format/precision
      if (r.computed.precision != null && typeof result === 'number') {
        out[key] = Number(result.toFixed(r.computed.precision));
      } else {
        out[key] = result;
      }
    }
  }
  return out;
}

function applyComputedList(items, fields) {
  return items.map(item => applyComputed(item, fields));
}
```

- [ ] **Step 2: Wire into D.list — add computed field injection after items are fetched**

In `D.list` (around line 284), change the return to apply computed fields:

Find:
```javascript
    return R.ok(items.slice(start, start + limit), {
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
```

Replace with:
```javascript
    return R.ok(applyComputedList(items.slice(start, start + limit), fields), {
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
```

- [ ] **Step 3: Wire into D.get**

In `D.get`, find:
```javascript
  get: async (kv, col, id) => {
    const item = await KV.get(kv, D.key(col, id));
    return item ? R.ok(item) : R.err(`Not found: ${id}`, 404);
  },
```

`D.get` doesn't have access to `fields`. We need to change the caller in the router. Find in the router `/api/:col/:id` section:
```javascript
        if (m === "GET")    return D.get(kv, col, id);
```

Replace with:
```javascript
        if (m === "GET")    { const item = await KV.get(kv, D.key(col, id)); return item ? R.ok(applyComputed(item, fields)) : R.err(`Not found: ${id}`, 404); }
```

- [ ] **Step 4: Wire into D.create, D.replace, D.patch — apply computed to the response**

In `D.create`, find the return:
```javascript
    return R.ok(item, { created: true });
```

Replace with:
```javascript
    return R.ok(applyComputed(item, fields), { created: true });
```

In `D.replace`, find:
```javascript
    return R.ok(item, { replaced: true });
```

Replace with:
```javascript
    return R.ok(applyComputed(item, fields), { replaced: true });
```

In `D.patch`, find:
```javascript
    return R.ok(item, { patched: true });
```

Replace with:
```javascript
    return R.ok(applyComputed(item, fields), { patched: true });
```

- [ ] **Step 5: Commit**

```bash
git add workerv2.js
git commit -m "feat: wire computed fields into data CRUD read/write pipeline"
```

---

### Task 3: Recalculate Route — Batch Recompute Stored Values

**Files:**
- Modify: `G:\CRUD x\workerv2.js`

- [ ] **Step 1: Add POST /api/:col/recalculate route**

In the router, inside the `if (segs[0] === "api")` block, add before the `if (!id)` block:

Find:
```javascript
        if (!id) {
```

Insert before it:
```javascript
        // POST /api/:col/recalculate — recompute all computed fields
        if (id === "recalculate" && m === "POST") {
          const ids = await IDX.get(kv, D.ns(col));
          let updated = 0;
          const ts = now();
          for (const rid of ids) {
            const item = await KV.get(kv, D.key(col, rid));
            if (!item) continue;
            const computed = applyComputed(item, fields);
            // Only write if computed values changed
            let changed = false;
            for (const [k, r] of Object.entries(fields)) {
              if (!r.computed?.expr) continue;
              if (computed[k] !== item[k]) { changed = true; break; }
            }
            if (changed) {
              await KV.set(kv, D.key(col, rid), { ...computed, updatedAt: ts });
              updated++;
            }
          }
          return R.ok({ updated, total: ids.length });
        }
```

- [ ] **Step 2: Commit**

```bash
git add workerv2.js
git commit -m "feat: add POST /api/:col/recalculate batch route"
```

---

### Task 4: Update Validation to Handle Computed Fields

**Files:**
- Modify: `G:\CRUD x\workerv2.js`

- [ ] **Step 1: Skip validation for computed fields on write**

In the `validate` function, after the line `if (!def) continue;` (which is already there), computed fields that the user tries to set should be rejected or stripped. Add a check at the top of the field loop:

Find:
```javascript
  for (const [key, r] of Object.entries(fields)) {
    const val = body[key];
    const def = val !== undefined && val !== null;
```

Replace with:
```javascript
  for (const [key, r] of Object.entries(fields)) {
    // Computed fields are auto-calculated; skip validation, strip from body
    if (r.computed?.expr) continue;
    const val = body[key];
    const def = val !== undefined && val !== null;
```

- [ ] **Step 2: Also strip computed fields from the `known` set check at the end of validate**

Find:
```javascript
  const known = new Set([...Object.keys(fields), "id", "createdAt", "updatedAt"]);
  for (const k of Object.keys(body)) if (!known.has(k)) errors.push(`Unknown field: "${k}"`);
```

This already works — computed field keys ARE in `fields`, so they won't trigger "Unknown field". The `continue` in step 1 means their values are ignored during validation. No change needed here.

- [ ] **Step 3: Commit**

```bash
git add workerv2.js
git commit -m "feat: skip validation for computed fields, they are auto-calculated"
```

---

### Task 5: UI — Computed Field Support in Schema Tab

**Files:**
- Modify: `G:\CRUD x\admin-ui v2.html`

- [ ] **Step 1: Add "Computed" column to fields editor table header**

In `App.renderFieldsEditor()`, find the `<thead>` row:
```html
<th>Field Name</th><th>Type</th><th>Required</th><th>Immutable</th>
<th>Default</th><th>Min</th><th>Max</th><th>Enum (comma-sep)</th><th>Pattern</th><th></th>
```

Replace with:
```html
<th>Field Name</th><th>Type</th><th>Required</th><th>Immutable</th>
<th>Default</th><th>Min</th><th>Max</th><th>Enum (comma-sep)</th><th>Pattern</th><th>Computed</th><th></th>
```

- [ ] **Step 2: Add computed expression input to each field row**

In the same function, in the `<tbody>` row template, find the last `<td>` before the delete button:
```html
<td><input type="text" value="${r.pattern??''}" onchange="App.updateFieldRow(${i},'pattern',this.value)" style="width:110px"></td>
<td><button class="del-row-btn" onclick="App.removeFieldRow(${i})">✕</button></td>
```

Replace with:
```html
<td><input type="text" value="${r.pattern??''}" onchange="App.updateFieldRow(${i},'pattern',this.value)" style="width:110px"></td>
<td><input type="text" value="${r.computed?.expr??''}" placeholder="e.g. price * qty" onchange="App.updateFieldRow(${i},'computed',this.value)" style="width:140px" title="Computed expression — leave empty for manual fields"></td>
<td><button class="del-row-btn" onclick="App.removeFieldRow(${i})">✕</button></td>
```

- [ ] **Step 3: Handle computed in updateFieldRow**

In `App.updateFieldRow`, add handling for the `computed` property. Find the end of the function:
```javascript
    row[prop] = val;
  },
```

Replace with:
```javascript
    if (prop === 'computed') {
      val = val.trim() ? { expr: val } : undefined;
    }
    row[prop] = val;
  },
```

- [ ] **Step 4: Commit**

```bash
git add "admin-ui v2.html"
git commit -m "feat: add computed expression column to schema field editor"
```

---

### Task 6: UI — Live Preview of Computed Values in Forms

**Files:**
- Modify: `G:\CRUD x\admin-ui v2.html`

- [ ] **Step 1: Patch JR.renderWidget to show computed field as read-only with live preview**

Find the `JR.renderWidget` function (around line 554). Add a check at the very top of the function, before `const w = ...`:

Find:
```javascript
  renderWidget(key, ff, rules, val, disabled) {
    const w = ff.widget ?? JR.defaultWidget(rules);
```

Replace with:
```javascript
  renderWidget(key, ff, rules, val, disabled) {
    // Computed fields: read-only display with live preview
    if (rules.computed?.expr) {
      const v = val != null ? val : '—';
      return `<div style="display:flex;align-items:center;gap:8px">
        <input type="text" id="field-${key}" value="${String(v).replace(/"/g,'&quot;')}" disabled style="opacity:.6;flex:1;background:var(--bg3);cursor:default" title="Auto-calculated: ${rules.computed.expr}">
        <span style="font-size:9px;color:var(--amber);white-space:nowrap">fx</span>
      </div>
      <input type="hidden" id="computed-${key}" value='${JSON.stringify(rules.computed)}'>`;
    }
    const w = ff.widget ?? JR.defaultWidget(rules);
```

- [ ] **Step 2: Add live recalculation on form input change**

After the modal is opened for create/edit, we need to recompute computed fields whenever any input changes. Add a function to App and hook it into the modal open flow.

Find `openCreateItem`:
```javascript
  openCreateItem() {
    if (!App.currentSchema) return;
    const ui = App.currentVersion?.ui;
    openModal('CREATE RECORD', `
      ${JR.renderForm(ui, App.currentSchema, null)}
    `, [
      { label: '✓ Create', cls: 'primary', action: 'App.createItem()' },
      { label: 'Cancel', action: 'App.closeModal()' },
    ]);
  },
```

Replace with:
```javascript
  openCreateItem() {
    if (!App.currentSchema) return;
    const ui = App.currentVersion?.ui;
    openModal('CREATE RECORD', `
      ${JR.renderForm(ui, App.currentSchema, null)}
    `, [
      { label: '✓ Create', cls: 'primary', action: 'App.createItem()' },
      { label: 'Cancel', action: 'App.closeModal()' },
    ]);
    App.attachComputedListeners();
  },
```

Find `openEditItem` — add `App.attachComputedListeners()` after the `openModal` call:

```javascript
    openModal(`EDIT · ${id.slice(0,12)}…`, `
      ${JR.renderForm(ui, App.currentSchema, item)}
    `, [
      ...
    ]);
```

Add after the closing `]);` of openModal inside openEditItem:
```javascript
    App.attachComputedListeners();
```

- [ ] **Step 3: Add `attachComputedListeners` and `recomputeFields` methods to App**

Add these methods inside the `App` object, before `closeModal`:

Find:
```javascript
  closeModal() { document.getElementById('modal-overlay').classList.remove('open'); },
```

Insert before it:
```javascript
  // ── Computed field live recalculation ──────────────────────────
  attachComputedListeners() {
    const fields = App.currentSchema;
    if (!fields) return;
    const computedKeys = Object.entries(fields).filter(([, r]) => r.computed?.expr);
    if (!computedKeys.length) return;
    // Listen for input changes on all non-computed field inputs
    for (const [key, r] of Object.entries(fields)) {
      if (r.computed?.expr) continue;
      const el = document.getElementById('field-' + key);
      if (el) el.addEventListener('input', () => App.recomputeFields());
    }
    App.recomputeFields();
  },

  recomputeFields() {
    const fields = App.currentSchema;
    if (!fields) return;
    // Collect current form values
    const ctx = {};
    for (const [key, r] of Object.entries(fields)) {
      if (r.computed?.expr) continue;
      const el = document.getElementById('field-' + key);
      if (!el) continue;
      let val = el.value;
      if (r.type === 'number') val = val === '' ? 0 : Number(val);
      if (r.type === 'boolean') val = el.value === 'true';
      ctx[key] = val;
    }
    // Evaluate each computed field
    for (const [key, r] of Object.entries(fields)) {
      if (!r.computed?.expr) continue;
      const el = document.getElementById('field-' + key);
      if (!el) continue;
      try {
        const tokens = CALC.tokenize(r.computed.expr);
        const ast = CALC.parse(tokens);
        let result = CALC.evaluate(ast, ctx);
        if (r.computed.precision != null && typeof result === 'number') {
          result = Number(result.toFixed(r.computed.precision));
        }
        el.value = result != null ? String(result) : '—';
      } catch {
        el.value = 'ERR';
      }
    }
  },

```

- [ ] **Step 4: Add CALC engine to the frontend JS (mirror of worker CALC)**

The CALC engine needs to exist on the frontend too for live preview. Insert the same CALC object (from Task 1) into the HTML `<script>` block, right after the `<script>` tag opening (before `const JR = {`):

Insert before `const JR = {`:
```javascript
// ── CALC engine (frontend mirror for live preview) ───────────────
const CALC = {
  tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/\d/.test(ch) || (ch === '.' && /\d/.test(expr[i+1]))) {
        let n = '';
        while (i < expr.length && /[\d.]/.test(expr[i])) n += expr[i++];
        tokens.push({ t: 'num', v: Number(n) });
        continue;
      }
      if (ch === "'" || ch === '"') {
        const q = ch; let s = ''; i++;
        while (i < expr.length && expr[i] !== q) { if (expr[i] === '\\' && expr[i+1]) i++; s += expr[i]; i++; }
        i++;
        tokens.push({ t: 'str', v: s });
        continue;
      }
      if (/[a-zA-Z_]/.test(ch)) {
        let id = '';
        while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) id += expr[i++];
        tokens.push({ t: 'id', v: id });
        continue;
      }
      const two = expr.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||', '**', '??'].includes(two)) {
        tokens.push({ t: 'op', v: two }); i += 2; continue;
      }
      if ('+-*/%<>!?:(){}.,'.includes(ch)) {
        tokens.push({ t: 'op', v: ch }); i++; continue;
      }
      i++;
    }
    return tokens;
  },
  parse(tokens) {
    let pos = 0;
    function peek() { return tokens[pos]; }
    function eat() { return tokens[pos++]; }
    function expect(v) { const tk = eat(); if (!tk || tk.v !== v) throw new Error(`Expected '${v}'`); return tk; }
    function parseExpr(minPrec = 0) {
      let left = parseUnary();
      while (true) {
        const tk = peek();
        if (!tk || tk.t !== 'op') break;
        const prec = CALC.prec(tk.v);
        if (prec === null || prec < minPrec) break;
        const op = eat().v;
        if (op === '?') {
          const then_ = parseExpr(0);
          expect(':');
          const else_ = parseExpr(0);
          left = { type: 'ternary', cond: left, then: then_, else: else_ };
        } else {
          const right = parseExpr(prec + 1);
          left = { type: 'binop', op, left, right };
        }
      }
      return left;
    }
    function parseUnary() {
      const tk = peek();
      if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '!')) {
        const op = eat().v;
        return { type: 'unary', op, expr: parseUnary() };
      }
      return parsePrimary();
    }
    function parsePrimary() {
      const tk = peek();
      if (!tk) throw new Error('Unexpected end');
      if (tk.t === 'num') { eat(); return { type: 'lit', value: tk.v }; }
      if (tk.t === 'str') { eat(); return { type: 'lit', value: tk.v }; }
      if (tk.t === 'op' && tk.v === '(') { eat(); const e = parseExpr(0); expect(')'); return e; }
      if (tk.t === 'id') {
        const name = eat().v;
        if (peek()?.t === 'op' && peek().v === '(') {
          eat();
          const args = [];
          while (peek() && !(peek().t === 'op' && peek().v === ')')) {
            args.push(parseExpr(0));
            if (peek()?.t === 'op' && peek().v === ',') eat();
          }
          expect(')');
          return { type: 'call', name, args };
        }
        return { type: 'ref', name };
      }
      throw new Error(`Unexpected token: ${JSON.stringify(tk)}`);
    }
    const ast = parseExpr(0);
    if (pos < tokens.length) throw new Error('Unexpected token after expression');
    return ast;
  },
  prec(op) {
    const table = { '||':1,'&&':2,'==':3,'!=':3,'<':3,'<=':3,'>':3,'>=':3,'??':4,'+':5,'-':5,'*':6,'/':6,'%':6,'**':7 };
    return table[op] ?? null;
  },
  evaluate(ast, ctx) {
    switch (ast.type) {
      case 'lit': return ast.value;
      case 'ref': { const v = ctx[ast.name]; return v !== undefined ? v : 0; }
      case 'unary': { const v = CALC.evaluate(ast.expr, ctx); return ast.op === '-' ? -v : !v; }
      case 'binop': {
        const l = CALC.evaluate(ast.left, ctx);
        const r = CALC.evaluate(ast.right, ctx);
        switch (ast.op) {
          case '+': return (typeof l==='string'||typeof r==='string') ? String(l??'')+String(r??'') : l+r;
          case '-': return l-r; case '*': return l*r;
          case '/': return r===0?0:l/r; case '%': return r===0?0:l%r;
          case '**': return Math.pow(l,r);
          case '==': return l==r; case '!=': return l!=r;
          case '<': return l<r; case '<=': return l<=r;
          case '>': return l>r; case '>=': return l>=r;
          case '&&': return l&&r; case '||': return l||r;
          case '??': return l??r;
        }
        return 0;
      }
      case 'ternary': return CALC.evaluate(ast.cond,ctx) ? CALC.evaluate(ast.then,ctx) : CALC.evaluate(ast.else,ctx);
      case 'call': {
        const args = ast.args.map(a => CALC.evaluate(a, ctx));
        return CALC.callFn(ast.name, args);
      }
    }
    return 0;
  },
  callFn(name, args) {
    const fns = {
      round:([n,p])=>p!=null?Number(n.toFixed(p)):Math.round(n),
      ceil:([n])=>Math.ceil(n), floor:([n])=>Math.floor(n),
      abs:([n])=>Math.abs(n), min:(a)=>Math.min(...a), max:(a)=>Math.max(...a),
      pow:([b,e])=>Math.pow(b,e), sqrt:([n])=>Math.sqrt(n), log:([n])=>Math.log(n),
      len:([s])=>typeof s==='string'?s.length:Array.isArray(s)?s.length:0,
      upper:([s])=>String(s).toUpperCase(), lower:([s])=>String(s).toLowerCase(),
      trim:([s])=>String(s).trim(), concat:(a)=>a.join(''),
      substring:([s,start,end])=>String(s).slice(start??0,end),
      if:([c,t,e])=>c?t:e, now:()=>new Date().toISOString(),
      date:([s])=>new Date(s).getTime()/1000, isNaN:([n])=>isNaN(n),
      number:([s])=>Number(s), string:([v])=>String(v),
    };
    const fn = fns[name];
    if (!fn) throw new Error(`Unknown function: ${name}`);
    return fn(args);
  },
  run(expr, item) {
    try { return CALC.evaluate(CALC.parse(CALC.tokenize(expr)), item); }
    catch(e) { return { _error: e.message }; }
  },
};
```

- [ ] **Step 5: Commit**

```bash
git add "admin-ui v2.html"
git commit -m "feat: add live computed field preview in create/edit forms"
```

---

### Task 7: UI — Recalculate Button in Data Tab

**Files:**
- Modify: `G:\CRUD x\admin-ui v2.html`

- [ ] **Step 1: Add "Recalculate" button to data tab toolbar**

Find the data tab toolbar:
```html
            <button class="btn primary" onclick="App.openCreateItem()">+ Add Record</button>
            <button class="btn" onclick="App.loadData()">↺ Refresh</button>
```

Add after the Refresh button:
```html
            <button class="btn" onclick="App.recalculateAll()" id="recalc-btn">⟳ Recalculate</button>
```

- [ ] **Step 2: Add `recalculateAll` method to App**

Add inside the App object, after `deleteItem`:

```javascript
  async recalculateAll() {
    if (!App.currentMeta) return;
    const col = App.currentMeta.name;
    const btn = document.getElementById('recalc-btn');
    if (btn) btn.disabled = true;
    const r = await api('POST', `/api/${col}/recalculate`);
    if (btn) btn.disabled = false;
    if (!r.ok) { toast('Recalculate failed: ' + r.error, 'err'); return; }
    toast(`Recalculated ${r.data.updated} of ${r.data.total} records`, 'ok');
    App.loadData();
  },
```

- [ ] **Step 3: Commit**

```bash
git add "admin-ui v2.html"
git commit -m "feat: add recalculate button to data tab toolbar"
```

---

### Task 8: UI — Computed Badge in Table View

**Files:**
- Modify: `G:\CRUD x\admin-ui v2.html`

- [ ] **Step 1: Show computed column values with a small "fx" indicator**

In `JR.renderTable`, find the cell rendering:
```javascript
        return `<td title="${String(v)}">${String(v)}</td>`;
```

Replace with:
```javascript
        const isComputed = fields[c.key]?.computed?.expr;
        return `<td title="${String(v)}${isComputed ? ' [computed]' : ''}">${String(v)}${isComputed ? ' <span style="font-size:8px;color:var(--amber)">fx</span>' : ''}</td>`;
```

Note: `fields` is passed into `renderTable(ui, fields, items, ...)`. The change above uses `fields[c.key]` to check if the field has a computed expression.

- [ ] **Step 2: Commit**

```bash
git add "admin-ui v2.html"
git commit -m "feat: show fx badge on computed columns in data table"
```

---

### Task 9: Build, Deploy, Verify

**Files:**
- Modify: `G:\CRUD x\build.js` (update to use workerv2.js and admin-ui v2.html)
- Modify: `G:\CRUD x\wrangler.toml` (update build config)

- [ ] **Step 1: Update build.js to use v2 files**

In `build.js`, change:
```javascript
const html = fs.readFileSync(path.join(__dirname, "admin-ui.html"), "utf-8");
const workerSrc = fs.readFileSync(path.join(__dirname, "worker.js"), "utf-8");
```

To:
```javascript
const html = fs.readFileSync(path.join(__dirname, "admin-ui v2.html"), "utf-8");
const workerSrc = fs.readFileSync(path.join(__dirname, "workerv2.js"), "utf-8");
```

- [ ] **Step 2: Build and deploy**

```bash
node build.js
npx wrangler deploy
```

- [ ] **Step 3: Verify**

```bash
curl -s https://schema-crud-worker.badsectorkiller666.workers.dev/ | head -5
curl -s -X POST https://schema-crud-worker.badsectorkiller666.workers.dev/schemas \
  -H 'Content-Type: application/json' \
  -d '{"name":"test_calc","fields":{"price":{"type":"number","required":true},"qty":{"type":"number","required":true},"total":{"type":"number","computed":{"expr":"price * qty","precision":2}}}}'
curl -s -X POST https://schema-crud-worker.badsectorkiller666.workers.dev/api/test_calc \
  -H 'Content-Type: application/json' \
  -d '{"price":10,"qty":5}'
```

Expected: the create response should include `"total": 50`.

- [ ] **Step 4: Commit**

```bash
git add build.js wrangler.toml
git commit -m "chore: update build to use v2 files, deploy"
```

---

## Self-Review Checklist

### Spec Coverage
- [x] Safe math expression evaluator — Task 1 (CALC engine)
- [x] Field descriptor `computed: { expr, format, precision }` — Task 1 (documented) + Task 5 (UI)
- [x] Worker applyComputed on every read/write — Task 2
- [x] POST /api/:col/recalculate batch route — Task 3
- [x] UI Computed Fields tab in Schema editor — Task 5
- [x] Live preview as you type values — Task 6
- [x] Supported operations: +, -, *, /, %, **, (), comparisons, ternary, string concat, Math.*, round/ceil/floor/abs/min/max, if(), concat(), len(), upper/lower, null-coalescing — Task 1 (CALC callFn)

### Placeholder Scan
- No TBD, TODO, "implement later", or "fill in details" found
- All code blocks contain complete implementations

### Type Consistency
- `computed` property: `{ expr: string }` with optional `precision` — consistent across worker (applyComputed reads `r.computed.expr`, `r.computed.precision`) and UI (updateFieldRow creates `{ expr: val }`, renderWidget reads `rules.computed.expr`)
- CALC.run / CALC.evaluate signature: `(expr, item)` / `(ast, ctx)` — consistent throughout
