/**
 * SCHEMA-DRIVEN CRUD WORKER v2
 * ─────────────────────────────────────────────────────────────────
 * All schemas live in KV. No static schema file.
 * Every schema save creates a new immutable version.
 *
 * Schema routes:
 *   GET    /schemas                     list all schemas
 *   POST   /schemas                     create schema
 *   GET    /schemas/:name               get active version
 *   PUT    /schemas/:name               update (bumps version)
 *   DELETE /schemas/:name               delete schema + data
 *   GET    /schemas/:name/versions      list all versions
 *   GET    /schemas/:name/versions/:v   get specific version
 *   POST   /schemas/:name/activate/:v   switch active version
 *
 * Data routes (driven by active schema):
 *   GET    /api/:col                    list (paginate, filter, sort)
 *   POST   /api/:col                    create
 *   GET    /api/:col/:id                get one
 *   PUT    /api/:col/:id                full replace
 *   PATCH  /api/:col/:id                partial update
 *   DELETE /api/:col/:id                delete
 *
 * Meta:
 *   GET    /                            API info
 * ─────────────────────────────────────────────────────────────────
 */

// ── Utilities ─────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

const R = {
  json: (data, status = 200) =>
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { "Content-Type": "application/json", ...CORS },
    }),
  ok:  (data, meta = {}) => R.json({ ok: true, ...meta, data }),
  err: (msg, status = 400, details = null) =>
    R.json({ ok: false, error: msg, ...(details ? { details } : {}) }, status),
};

const now = () => new Date().toISOString();
const uid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ── KV helpers ────────────────────────────────────────────────────

const KV = {
  get:    (kv, k)    => kv.get(k, "json").then(v => v ?? null),
  set:    (kv, k, v) => kv.put(k, JSON.stringify(v)),
  del:    (kv, k)    => kv.delete(k),
};

// Sorted ID index per namespace
const IDX = {
  get:   async (kv, ns)     => (await KV.get(kv, `__idx:${ns}`)) ?? [],
  add:   async (kv, ns, id) => { const i = await IDX.get(kv,ns); if(!i.includes(id)){i.push(id);await KV.set(kv,`__idx:${ns}`,i);} },
  rem:   async (kv, ns, id) => { const i = await IDX.get(kv,ns); await KV.set(kv,`__idx:${ns}`,i.filter(x=>x!==id)); },
  clear: async (kv, ns)     => KV.del(kv, `__idx:${ns}`),
};

// ── CALC engine — safe expression evaluator ──────────────────────
// No eval()/Function(). Recursive descent parser → AST → evaluate.
// Supports: + - * / % ** ( ) == != < <= > >= && || ! ?? ternary ? :
// Functions: round ceil floor abs min max pow sqrt log len upper lower
//   trim concat substring if now date isNaN number string

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
    const peek = () => tokens[pos];
    const eat = () => tokens[pos++];
    function expect(v) { const tk = eat(); if (!tk || tk.v !== v) throw new Error(`Expected '${v}', got '${tk?.v ?? 'EOF'}'`); return tk; }
    function parseExpr(minPrec = 0) {
      let left = parseUnary();
      while (true) {
        const tk = peek();
        if (!tk || tk.t !== 'op') break;
        const prec = CALC.prec(tk.v);
        if (prec === null || prec < minPrec) break;
        const op = eat().v;
        if (op === '?') {
          const then_ = parseExpr(0); expect(':'); const else_ = parseExpr(0);
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
        const op = eat().v; return { type: 'unary', op, expr: parseUnary() };
      }
      return parsePrimary();
    }
    function parsePrimary() {
      const tk = peek();
      if (!tk) throw new Error('Unexpected end of expression');
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
    if (pos < tokens.length) throw new Error(`Unexpected token after expression: ${JSON.stringify(tokens[pos])}`);
    return ast;
  },

  prec(op) {
    const t = { '||':1,'&&':2,'==':3,'!=':3,'<':3,'<=':3,'>':3,'>=':3,'??':4,'+':5,'-':5,'*':6,'/':6,'%':6,'**':7 };
    return t[op] ?? null;
  },

  evaluate(ast, ctx) {
    switch (ast.type) {
      case 'lit': return ast.value;
      case 'ref': { const v = ctx[ast.name]; return v !== undefined ? v : 0; }
      case 'unary': { const v = CALC.evaluate(ast.expr, ctx); return ast.op === '-' ? -v : !v; }
      case 'binop': {
        const l = CALC.evaluate(ast.left, ctx), r = CALC.evaluate(ast.right, ctx);
        switch (ast.op) {
          case '+': return (typeof l==='string'||typeof r==='string') ? String(l??'')+String(r??'') : l+r;
          case '-': return l-r; case '*': return l*r;
          case '/': return r===0?0:l/r; case '%': return r===0?0:l%r;
          case '**': return Math.pow(l,r);
          case '==': return l==r; case '!=': return l!=r;
          case '<': return l<r; case '<=': return l<=r; case '>': return l>r; case '>=': return l>=r;
          case '&&': return l&&r; case '||': return l||r; case '??': return l??r;
        }
        return 0;
      }
      case 'ternary': return CALC.evaluate(ast.cond,ctx) ? CALC.evaluate(ast.then,ctx) : CALC.evaluate(ast.else,ctx);
      case 'call': return CALC.callFn(ast.name, ast.args.map(a => CALC.evaluate(a, ctx)), ctx);
    }
    return 0;
  },

  callFn(name, args, ctx) {
    const fns = {
      round:([n,p])=>p!=null?Number(n.toFixed(p)):Math.round(n),
      ceil:([n])=>Math.ceil(n), floor:([n])=>Math.floor(n), abs:([n])=>Math.abs(n),
      min:(a)=>Math.min(...a), max:(a)=>Math.max(...a),
      pow:([b,e])=>Math.pow(b,e), sqrt:([n])=>Math.sqrt(n), log:([n])=>Math.log(n),
      len:([s])=>typeof s==='string'?s.length:Array.isArray(s)?s.length:0,
      upper:([s])=>String(s).toUpperCase(), lower:([s])=>String(s).toLowerCase(),
      trim:([s])=>String(s).trim(), concat:(a)=>a.join(''),
      substring:([s,st,en])=>String(s).slice(st??0,en),
      if:([c,t,e])=>c?t:e, now:()=>new Date().toISOString(),
      date:([s])=>new Date(s).getTime()/1000,
      isNaN:([n])=>isNaN(n), number:([s])=>Number(s), string:([v])=>String(v),
    };
    const fn = fns[name];
    if (!fn) throw new Error(`Unknown function: ${name}`);
    return fn(args);
  },

  run(expr, item) {
    try { const r = CALC.evaluate(CALC.parse(CALC.tokenize(expr)), item); return r; }
    catch(e) { return { _calcError: e.message }; }
  },
};

// ── Computed field application ────────────────────────────────────

function applyComputed(item, fields) {
  const out = { ...item };
  for (const [key, r] of Object.entries(fields)) {
    if (!r.computed?.expr) continue;
    const result = CALC.run(r.computed.expr, out);
    if (result && typeof result === 'object' && result._calcError) {
      out[key] = null;
    } else {
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

// ── Schema store ──────────────────────────────────────────────────

const S = {
  metaKey:  name    => `__schema_meta:${name}`,
  verKey:   (n, v)  => `__schema_ver:${n}:${v}`,
  verIdxKey: name   => `__schema_veridx:${name}`,
  globalIdx:         "__schema_idx",

  getMeta:  (kv, n)    => KV.get(kv, S.metaKey(n)),
  getVer:   (kv, n, v) => KV.get(kv, S.verKey(n, v)),
  getActive: async (kv, n) => {
    const m = await S.getMeta(kv, n);
    return m ? S.getVer(kv, n, m.activeVersion) : null;
  },

  listMetas: async (kv) => {
    const names = (await KV.get(kv, S.globalIdx)) ?? [];
    return (await Promise.all(names.map(n => S.getMeta(kv, n)))).filter(Boolean);
  },

  listVersions: async (kv, n) => {
    const idx = (await KV.get(kv, S.verIdxKey(n))) ?? [];
    const vers = await Promise.all(idx.map(v => S.getVer(kv, n, v)));
    return vers.filter(Boolean).sort((a, b) => a.version - b.version);
  },

  save: async (kv, name, { fields, ui, changelog, description }) => {
    const existingMeta = await S.getMeta(kv, name);
    const isNew = !existingMeta;
    const nextVer = isNew ? 1 : existingMeta.latestVersion + 1;
    const ts = now();

    const verObj = {
      name,
      version: nextVer,
      fields,
      ui: ui ?? buildDefaultUI(fields),
      changelog: changelog ?? (isNew ? "Initial version" : `Version ${nextVer}`),
      createdAt: ts,
    };

    const meta = {
      name,
      description: description ?? existingMeta?.description ?? "",
      activeVersion: nextVer,
      latestVersion: nextVer,
      totalVersions: nextVer,
      createdAt: isNew ? ts : existingMeta.createdAt,
      updatedAt: ts,
    };

    await KV.set(kv, S.verKey(name, nextVer), verObj);
    await KV.set(kv, S.metaKey(name), meta);

    const vi = (await KV.get(kv, S.verIdxKey(name))) ?? [];
    if (!vi.includes(nextVer)) { vi.push(nextVer); await KV.set(kv, S.verIdxKey(name), vi); }

    const gi = (await KV.get(kv, S.globalIdx)) ?? [];
    if (!gi.includes(name)) { gi.push(name); await KV.set(kv, S.globalIdx, gi); }

    return { meta, version: verObj };
  },

  delete: async (kv, name) => {
    const vi = (await KV.get(kv, S.verIdxKey(name))) ?? [];
    for (const v of vi) await KV.del(kv, S.verKey(name, v));
    await KV.del(kv, S.verIdxKey(name));
    await KV.del(kv, S.metaKey(name));
    const gi = (await KV.get(kv, S.globalIdx)) ?? [];
    await KV.set(kv, S.globalIdx, gi.filter(n => n !== name));
    // Data cleanup
    const dataIds = await IDX.get(kv, `data:${name}`);
    for (const id of dataIds) await KV.del(kv, `data:${name}:${id}`);
    await IDX.clear(kv, `data:${name}`);
    return dataIds.length;
  },
};

// ── UI layout generator ───────────────────────────────────────────

function buildDefaultUI(fields) {
  const entries = Object.entries(fields);

  return {
    form: {
      layout: "stack",
      fields: entries.map(([key, r]) => ({
        key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()),
        widget: widgetFor(r),
        ...(r.enum    ? { options: r.enum.map(v => ({ label: v, value: v })) } : {}),
        ...(r.required !== undefined ? { required: r.required } : {}),
        ...(r.min     !== undefined ? { min: r.min } : {}),
        ...(r.max     !== undefined ? { max: r.max } : {}),
        ...(r.pattern ? { pattern: r.pattern } : {}),
        ...(r.default !== undefined ? { default: r.default } : {}),
        ...(r.immutable ? { immutable: true } : {}),
        hint: buildHint(r),
      })),
    },
    table: {
      columns: entries.slice(0, 7).map(([key, r]) => ({
        key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()),
        type: r.type,
        sortable: ["string", "number"].includes(r.type),
      })),
    },
    detail: {
      sections: [
        { title: "Data", fields: Object.keys(fields) },
        { title: "System", fields: ["id", "createdAt", "updatedAt"] },
      ],
    },
  };
}

function widgetFor(r) {
  if (r.type === "boolean") return "toggle";
  if (r.type === "number")  return "number";
  if (r.type === "array")   return "tags";
  if (r.type === "object")  return "json";
  if (r.enum)               return "select";
  if (r.max && r.max > 200) return "textarea";
  return "text";
}

function buildHint(r) {
  const parts = [];
  if (r.required)               parts.push("required");
  if (r.immutable)              parts.push("immutable");
  if (r.min !== undefined)      parts.push(`min: ${r.min}`);
  if (r.max !== undefined)      parts.push(`max: ${r.max}`);
  if (r.enum)                   parts.push(`one of: ${r.enum.join(", ")}`);
  if (r.default !== undefined)  parts.push(`default: ${JSON.stringify(r.default)}`);
  return parts.join(" · ") || null;
}

// ── Validation ────────────────────────────────────────────────────

function validate(body, fields, existing = null) {
  const errors = [];
  const isUpdate = existing !== null;

  for (const [key, r] of Object.entries(fields)) {
    if (r.computed?.expr) continue;
    const val = body[key];
    const def = val !== undefined && val !== null;

    if (!isUpdate && r.required && !def) { errors.push(`"${key}" is required`); continue; }
    if (isUpdate && r.immutable && def)  { errors.push(`"${key}" is immutable`); continue; }
    if (!def) continue;

    const actual = Array.isArray(val) ? "array" : typeof val;
    if (actual !== r.type) { errors.push(`"${key}" must be ${r.type}, got ${actual}`); continue; }

    if (r.type === "number") {
      if (r.min !== undefined && val < r.min) errors.push(`"${key}" >= ${r.min}`);
      if (r.max !== undefined && val > r.max) errors.push(`"${key}" <= ${r.max}`);
    }
    if (r.type === "string" || r.type === "array") {
      if (r.min !== undefined && val.length < r.min) errors.push(`"${key}" length >= ${r.min}`);
      if (r.max !== undefined && val.length > r.max) errors.push(`"${key}" length <= ${r.max}`);
    }
    if (r.enum && !r.enum.includes(val)) errors.push(`"${key}" must be one of: ${r.enum.join(", ")}`);
    if (r.pattern && r.type === "string" && !new RegExp(r.pattern).test(val))
      errors.push(`"${key}" does not match pattern`);
  }

  const known = new Set([...Object.keys(fields), "id", "createdAt", "updatedAt"]);
  for (const k of Object.keys(body)) if (!known.has(k)) errors.push(`Unknown field: "${k}"`);

  return errors;
}

function defaults(body, fields, existing = null) {
  const out = { ...body };
  for (const [key, r] of Object.entries(fields)) {
    if (out[key] == null) {
      if (existing?.[key] != null) out[key] = existing[key];
      else if (r.default !== undefined)
        out[key] = typeof r.default === "object" ? JSON.parse(JSON.stringify(r.default)) : r.default;
    }
  }
  return out;
}

function preserveImmutable(item, existing, fields) {
  for (const [k, r] of Object.entries(fields)) if (r.immutable) item[k] = existing[k];
  return item;
}

// ── Data CRUD ─────────────────────────────────────────────────────

const D = {
  key: (col, id) => `data:${col}:${id}`,
  ns:  col       => `data:${col}`,

  list: async (kv, col, fields, url) => {
    const page  = Math.max(1,   parseInt(url.searchParams.get("page")  || "1"));
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "20"));
    const sortBy  = url.searchParams.get("sortBy");
    const sortDir = url.searchParams.get("sortDir") === "desc" ? -1 : 1;
    const reserved = new Set(["page", "limit", "sortBy", "sortDir"]);
    const filter = {};
    for (const [k, v] of url.searchParams) if (!reserved.has(k)) filter[k] = v;

    const ids = await IDX.get(kv, D.ns(col));
    let items = (await Promise.all(ids.map(id => KV.get(kv, D.key(col, id))))).filter(Boolean);

    for (const [k, v] of Object.entries(filter))
      items = items.filter(item => String(item[k] ?? "") === v);

    if (sortBy) items.sort((a, b) => (a[sortBy] > b[sortBy] ? 1 : -1) * sortDir);

    const total = items.length;
    const start = (page - 1) * limit;
    return R.ok(applyComputedList(items.slice(start, start + limit), fields), {
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },

  create: async (kv, col, fields, body) => {
    const errs = validate(body, fields);
    if (errs.length) return R.err("Validation failed", 422, errs);
    const id = body.id || uid();
    if (await KV.get(kv, D.key(col, id))) return R.err(`ID "${id}" already exists`, 409);
    const ts = now();
    const item = { ...defaults(body, fields), id, createdAt: ts, updatedAt: ts };
    await KV.set(kv, D.key(col, id), item);
    await IDX.add(kv, D.ns(col), id);
    return R.ok(applyComputed(item, fields), { created: true });
  },

  get: async (kv, col, id) => {
    const item = await KV.get(kv, D.key(col, id));
    return item ? R.ok(item) : R.err(`Not found: ${id}`, 404);
  },

  replace: async (kv, col, fields, id, body) => {
    const existing = await KV.get(kv, D.key(col, id));
    if (!existing) return R.err(`Not found: ${id}`, 404);
    const errs = validate(body, fields, existing);
    if (errs.length) return R.err("Validation failed", 422, errs);
    const item = preserveImmutable(
      { ...defaults(body, fields), id, createdAt: existing.createdAt, updatedAt: now() },
      existing, fields
    );
    await KV.set(kv, D.key(col, id), item);
    return R.ok(applyComputed(item, fields), { replaced: true });
  },

  patch: async (kv, col, fields, id, body) => {
    const existing = await KV.get(kv, D.key(col, id));
    if (!existing) return R.err(`Not found: ${id}`, 404);
    const errs = validate(body, fields, existing);
    if (errs.length) return R.err("Validation failed", 422, errs);
    const item = preserveImmutable({ ...existing, ...body, updatedAt: now() }, existing, fields);
    await KV.set(kv, D.key(col, id), item);
    return R.ok(applyComputed(item, fields), { patched: true });
  },

  delete: async (kv, col, id) => {
    const item = await KV.get(kv, D.key(col, id));
    if (!item) return R.err(`Not found: ${id}`, 404);
    // Cascade: clean up junction entries for manyToMany relations
    const activeVer = await S.getActive(kv, col);
    if (activeVer) await REL.cascadeDelete(kv, col, item, activeVer.fields);
    await KV.del(kv, D.key(col, id));
    await IDX.rem(kv, D.ns(col), id);
    return R.ok({ id, deleted: true });
  },
};

// ── CSV helpers ───────────────────────────────────────────────────

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values) { return values.map(csvEscape).join(","); }

function parseCsvLine(line) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsvFull(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(l => parseCsvLine(l));
  return { headers, rows };
}

// ── Export ────────────────────────────────────────────────────────

// GET /export/:col?format=json|csv&schemaVersion=N
async function handleExport(kv, col, url) {
  const fmt = url.searchParams.get("format") ?? "json";

  const activeVer = await S.getActive(kv, col);
  if (!activeVer) return R.err(`No active schema for "${col}"`, 404);

  const fields = activeVer.fields;
  const fieldKeys = Object.keys(fields);
  const allKeys = ["id", ...fieldKeys, "createdAt", "updatedAt"];

  const ids = await IDX.get(kv, `data:${col}`);
  const items = (await Promise.all(ids.map(id => KV.get(kv, `data:${col}:${id}`)))).filter(Boolean);

  const meta = {
    collection: col,
    schemaVersion: activeVer.version,
    exportedAt: now(),
    totalRecords: items.length,
    fields: fieldKeys,
  };

  if (fmt === "csv") {
    // Header comment row encodes schema info so import can verify
    const schemaHeader = `# SCHEMATA-EXPORT collection=${col} schemaVersion=${activeVer.version} fields=${fieldKeys.join("|")} exportedAt=${meta.exportedAt}`;
    const colHeader = csvRow(allKeys);
    const rows = items.map(item => csvRow(allKeys.map(k => item[k])));
    const csv = [schemaHeader, colHeader, ...rows].join("\n");

    return new Response(csv, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${col}_v${activeVer.version}_${Date.now()}.csv"`,
        "X-Export-Collection": col,
        "X-Export-Schema-Version": String(activeVer.version),
        "X-Export-Total": String(items.length),
      },
    });
  }

  // JSON format
  const payload = { meta, schema: { version: activeVer.version, fields }, data: items };
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${col}_v${activeVer.version}_${Date.now()}.json"`,
      "X-Export-Collection": col,
      "X-Export-Schema-Version": String(activeVer.version),
      "X-Export-Total": String(items.length),
    },
  });
}

// GET /export/schemas — full schema registry backup (all schemas, all versions)
async function handleExportSchemas(kv) {
  const names = (await KV.get(kv, S.globalIdx)) ?? [];
  const schemas = await Promise.all(names.map(async name => {
    const meta = await S.getMeta(kv, name);
    const versions = await S.listVersions(kv, name);
    return { meta, versions };
  }));

  const payload = {
    meta: { exportedAt: now(), totalSchemas: schemas.length, type: "schemata-schema-backup" },
    schemas,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="schemas_backup_${Date.now()}.json"`,
    },
  });
}

// ── Import ────────────────────────────────────────────────────────

// POST /import/:col?mode=append|replace  Content-Type: application/json or text/csv
async function handleImport(kv, col, request, url) {
  const mode = url.searchParams.get("mode") ?? "append"; // append | replace

  const activeVer = await S.getActive(kv, col);
  if (!activeVer) return R.err(`No active schema for "${col}". Create schema first.`, 404);
  const fields = activeVer.fields;

  const ct = request.headers.get("Content-Type") ?? "";
  let records = [];
  let importSchemaVersion = null;

  // ── Parse JSON ────────────────────────────────────────────────
  if (ct.includes("application/json")) {
    let payload;
    try { payload = await request.json(); } catch { return R.err("Invalid JSON body"); }

    // Accept either raw array or { meta, schema, data } envelope
    if (Array.isArray(payload)) {
      records = payload;
    } else if (payload.data && Array.isArray(payload.data)) {
      records = payload.data;
      importSchemaVersion = payload.meta?.schemaVersion ?? payload.schema?.version ?? null;

      // Header validation: collection name must match
      if (payload.meta?.collection && payload.meta.collection !== col) {
        return R.err(
          `Collection mismatch: file is for "${payload.meta.collection}", but you're importing into "${col}".`,
          400
        );
      }
    } else {
      return R.err('Body must be a JSON array or { meta, schema, data } export envelope');
    }
  }

  // ── Parse CSV ─────────────────────────────────────────────────
  else if (ct.includes("text/csv") || ct.includes("text/plain")) {
    let text;
    try { text = await request.text(); } catch { return R.err("Could not read CSV body"); }

    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

    // Extract and validate schema comment header
    let headerLine = null;
    let dataLines = [];
    for (const line of lines) {
      if (line.startsWith("# SCHEMATA-EXPORT")) { headerLine = line; }
      else if (line.trim()) dataLines.push(line);
    }

    if (!headerLine) {
      return R.err(
        'CSV is missing required SCHEMATA-EXPORT header comment. Export from this system to get a valid file.',
        400
      );
    }

    // Parse header comment
    const headerMeta = {};
    for (const part of headerLine.replace("# SCHEMATA-EXPORT ", "").split(" ")) {
      const [k, v] = part.split("=");
      if (k && v) headerMeta[k] = v;
    }

    if (headerMeta.collection && headerMeta.collection !== col) {
      return R.err(
        `Collection mismatch: file is for "${headerMeta.collection}", but importing into "${col}".`,
        400
      );
    }

    importSchemaVersion = headerMeta.schemaVersion ? parseInt(headerMeta.schemaVersion) : null;

    // Validate column headers match schema fields
    const { headers, rows } = parseCsvFull(dataLines.join("\n"));
    const schemaFields = Object.keys(fields);
    const systemFields = ["id", "createdAt", "updatedAt"];
    const expectedCols = ["id", ...schemaFields, "createdAt", "updatedAt"];
    const missingCols = schemaFields.filter(f => !headers.includes(f));

    if (missingCols.length > 0) {
      return R.err(
        `CSV headers don't match schema. Missing columns: ${missingCols.join(", ")}`,
        400,
        { expected: expectedCols, found: headers }
      );
    }

    // Convert rows to objects
    records = rows.map(row => {
      const obj = {};
      headers.forEach((h, i) => { if (row[i] !== undefined) obj[h] = row[i]; });
      return obj;
    });
  }

  else {
    return R.err("Content-Type must be application/json or text/csv", 415);
  }

  if (!records.length) return R.err("No records found in import payload", 400);

  // ── Coerce types from CSV strings ─────────────────────────────
  function coerce(val, type) {
    if (val === "" || val === null || val === undefined) return undefined;
    if (type === "number")  return Number(val);
    if (type === "boolean") return val === "true" || val === true;
    if (type === "array")   { try { return JSON.parse(val); } catch { return []; } }
    if (type === "object")  { try { return JSON.parse(val); } catch { return {}; } }
    return val;
  }

  // ── Replace mode: wipe existing data first ────────────────────
  if (mode === "replace") {
    const existingIds = await IDX.get(kv, `data:${col}`);
    for (const id of existingIds) await KV.del(kv, `data:${col}:${id}`);
    await IDX.clear(kv, `data:${col}`);
  }

  // ── Validate + insert each record ─────────────────────────────
  const results = { imported: 0, skipped: 0, errors: [] };
  const ts = now();

  for (let i = 0; i < records.length; i++) {
    const raw = records[i];

    // Coerce field types (important for CSV strings)
    const coerced = {};
    for (const [key, r] of Object.entries(fields)) {
      const v = coerce(raw[key], r.type);
      if (v !== undefined) coerced[key] = v;
    }
    // Preserve id, createdAt if present
    if (raw.id) coerced.id = raw.id;
    if (raw.createdAt) coerced.createdAt = raw.createdAt;

    // Validate (skip required check since this is import/restore)
    const errs = validate(coerced, fields);
    const typeErrors = errs.filter(e => !e.includes("is required"));
    if (typeErrors.length) {
      results.errors.push({ row: i + 1, id: raw.id ?? "?", errors: typeErrors });
      results.skipped++;
      continue;
    }

    const id = coerced.id || uid();
    const item = {
      ...defaults(coerced, fields),
      id,
      createdAt: coerced.createdAt || ts,
      updatedAt: ts,
    };

    await KV.set(kv, `data:${col}:${id}`, item);
    await IDX.add(kv, `data:${col}`, id);
    results.imported++;
  }

  return R.ok(results, {
    collection: col,
    mode,
    importSchemaVersion,
    activeSchemaVersion: activeVer.version,
  });
}

// POST /import/schemas — restore schema registry backup
async function handleImportSchemas(kv, request) {
  let payload;
  try { payload = await request.json(); } catch { return R.err("Invalid JSON"); }

  if (!payload.schemas || !Array.isArray(payload.schemas)) {
    return R.err('Expected { meta, schemas: [...] } format from schema backup');
  }

  if (payload.meta?.type !== "schemata-schema-backup") {
    return R.err('File does not appear to be a SCHEMATA schema backup (missing type tag)');
  }

  const results = { restored: 0, skipped: 0, errors: [] };

  for (const entry of payload.schemas) {
    const { meta, versions } = entry;
    if (!meta?.name || !versions?.length) {
      results.errors.push(`Invalid schema entry: ${JSON.stringify(meta)}`);
      results.skipped++;
      continue;
    }

    try {
      // Restore all versions in order
      for (const ver of versions.sort((a, b) => a.version - b.version)) {
        const verKey = S.verKey(meta.name, ver.version);
        await KV.set(kv, verKey, ver);
        const vi = (await KV.get(kv, S.verIdxKey(meta.name))) ?? [];
        if (!vi.includes(ver.version)) { vi.push(ver.version); await KV.set(kv, S.verIdxKey(meta.name), vi); }
      }

      // Restore meta
      await KV.set(kv, S.metaKey(meta.name), meta);

      // Global index
      const gi = (await KV.get(kv, S.globalIdx)) ?? [];
      if (!gi.includes(meta.name)) { gi.push(meta.name); await KV.set(kv, S.globalIdx, gi); }

      results.restored++;
    } catch (e) {
      results.errors.push(`${meta.name}: ${e.message}`);
      results.skipped++;
    }
  }

  return R.ok(results, { totalInFile: payload.schemas.length });
}

// ── Relation Engine ───────────────────────────────────────────────
//
// Relation descriptor stored inside a field definition:
//
//   fieldName: {
//     type: "string",              ← the FK value type (string id)
//     relation: {
//       type: "hasOne"             ← hasOne | belongsTo | hasMany | manyToMany
//       target: "orders",          ← target collection name
//       targetField: "customerId", ← FK field on target (for hasMany / belongsTo)
//       junction: "user_roles",    ← junction collection name (manyToMany only)
//       labelField: "name",        ← which field to use as display label (optional)
//     }
//   }
//
// Storage for junction tables:
//   __junc:{junctionName}:{sourceId}  →  [ targetId, … ]
//   __junc_rev:{junctionName}:{targetId}  →  [ sourceId, … ]
//
// Routes:
//   GET    /rel/:col/:id              → item + all resolved relations
//   GET    /rel/:col/:id/:relField    → just one resolved relation
//   POST   /rel/:col/:id/:relField    → link (manyToMany) or set FK
//   DELETE /rel/:col/:id/:relField/:targetId → unlink (manyToMany)

const REL = {

  // Extract relation field descriptors from a fields object
  getRelFields(fields) {
    return Object.entries(fields)
      .filter(([, r]) => r.relation)
      .map(([key, r]) => ({ key, ...r.relation }));
  },

  // Resolve a single relation for one item
  async resolve(kv, item, fieldKey, relDef) {
    const { type, target, targetField, junction, labelField } = relDef;

    // hasOne / belongsTo: FK is stored on this item
    if (type === "hasOne" || type === "belongsTo") {
      const fk = item[fieldKey];
      if (!fk) return null;
      const related = await KV.get(kv, `data:${target}:${fk}`);
      if (!related) return null;
      return { id: related.id, _label: labelField ? related[labelField] : related.id, ...related };
    }

    // hasMany: scan target for records where targetField === item.id
    if (type === "hasMany") {
      const ids = await IDX.get(kv, `data:${target}`);
      const all = (await Promise.all(ids.map(id => KV.get(kv, `data:${target}:${id}`)))).filter(Boolean);
      return all.filter(r => r[targetField] === item.id)
        .map(r => ({ id: r.id, _label: labelField ? r[labelField] : r.id, ...r }));
    }

    // manyToMany: read junction index
    if (type === "manyToMany") {
      const junc = junction ?? `${item._collection ?? "source"}_${target}`;
      const linkedIds = (await KV.get(kv, `__junc:${junc}:${item.id}`)) ?? [];
      const related = (await Promise.all(linkedIds.map(id => KV.get(kv, `data:${target}:${id}`)))).filter(Boolean);
      return related.map(r => ({ id: r.id, _label: labelField ? r[labelField] : r.id, ...r }));
    }

    return null;
  },

  // Resolve all relations for one item, returns { ...item, _relations: { fieldKey: resolved } }
  async resolveAll(kv, col, item, fields) {
    const relFields = REL.getRelFields(fields);
    if (!relFields.length) return { ...item, _relations: {} };
    const resolved = {};
    await Promise.all(relFields.map(async rf => {
      resolved[rf.key] = await REL.resolve(kv, { ...item, _collection: col }, rf.key, rf);
    }));
    return { ...item, _relations: resolved };
  },

  // Link: manyToMany junction insert
  async link(kv, col, sourceId, fieldKey, targetId, relDef) {
    const junc = relDef.junction ?? `${col}_${relDef.target}`;

    // forward: sourceId → targetId
    const fwd = (await KV.get(kv, `__junc:${junc}:${sourceId}`)) ?? [];
    if (!fwd.includes(targetId)) { fwd.push(targetId); await KV.set(kv, `__junc:${junc}:${sourceId}`, fwd); }

    // reverse: targetId → sourceId
    const rev = (await KV.get(kv, `__junc_rev:${junc}:${targetId}`)) ?? [];
    if (!rev.includes(sourceId)) { rev.push(sourceId); await KV.set(kv, `__junc_rev:${junc}:${targetId}`, rev); }
  },

  // Unlink: manyToMany junction remove
  async unlink(kv, col, sourceId, fieldKey, targetId, relDef) {
    const junc = relDef.junction ?? `${col}_${relDef.target}`;
    const fwd = ((await KV.get(kv, `__junc:${junc}:${sourceId}`)) ?? []).filter(id => id !== targetId);
    await KV.set(kv, `__junc:${junc}:${sourceId}`, fwd);
    const rev = ((await KV.get(kv, `__junc_rev:${junc}:${targetId}`)) ?? []).filter(id => id !== sourceId);
    await KV.set(kv, `__junc_rev:${junc}:${targetId}`, rev);
  },

  // Cascade cleanup: when a record is deleted, remove its junction entries
  async cascadeDelete(kv, col, item, fields) {
    const relFields = REL.getRelFields(fields).filter(r => r.type === "manyToMany");
    for (const rf of relFields) {
      const junc = rf.junction ?? `${col}_${rf.target}`;
      const linkedIds = (await KV.get(kv, `__junc:${junc}:${item.id}`)) ?? [];
      // Remove reverse entries
      for (const tid of linkedIds) {
        const rev = ((await KV.get(kv, `__junc_rev:${junc}:${tid}`)) ?? []).filter(id => id !== item.id);
        await KV.set(kv, `__junc_rev:${junc}:${tid}`, rev);
      }
      await KV.del(kv, `__junc:${junc}:${item.id}`);
    }
  },

  // GET /rel/:col (list with relations embedded, paginated)
  async handleListWithRel(kv, col, fields, url) {
    const page  = Math.max(1,   parseInt(url.searchParams.get("page")  || "1"));
    const limit = Math.min(50,  parseInt(url.searchParams.get("limit") || "20"));
    const ids = await IDX.get(kv, `data:${col}`);
    const allItems = (await Promise.all(ids.map(id => KV.get(kv, `data:${col}:${id}`)))).filter(Boolean);
    const total = allItems.length;
    const start = (page - 1) * limit;
    const page_items = allItems.slice(start, start + limit);
    const resolved = await Promise.all(page_items.map(item => REL.resolveAll(kv, col, item, fields)));
    return R.ok(resolved, { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  },

  // GET /rel/:col/:id
  async handleGetWithRel(kv, col, id, fields) {
    const item = await KV.get(kv, `data:${col}:${id}`);
    if (!item) return R.err(`Not found: ${id}`, 404);
    const resolved = await REL.resolveAll(kv, col, item, fields);
    return R.ok(resolved);
  },

  // GET /rel/:col/:id/:relField
  async handleGetOneRel(kv, col, id, fieldKey, fields) {
    const item = await KV.get(kv, `data:${col}:${id}`);
    if (!item) return R.err(`Not found: ${id}`, 404);
    const relDef = fields[fieldKey]?.relation;
    if (!relDef) return R.err(`Field "${fieldKey}" has no relation defined`, 400);
    const resolved = await REL.resolve(kv, { ...item, _collection: col }, fieldKey, relDef);
    return R.ok(resolved, { collection: col, id, field: fieldKey, relationType: relDef.type });
  },

  // POST /rel/:col/:id/:relField  body: { targetId }
  // For manyToMany: links the two records
  // For hasOne/belongsTo: sets the FK on this record
  async handleLink(kv, col, id, fieldKey, fields, body) {
    const item = await KV.get(kv, `data:${col}:${id}`);
    if (!item) return R.err(`Not found: ${id}`, 404);
    const fieldDef = fields[fieldKey];
    if (!fieldDef?.relation) return R.err(`Field "${fieldKey}" has no relation defined`, 400);
    const relDef = fieldDef.relation;
    const { targetId } = body;
    if (!targetId) return R.err('"targetId" is required', 400);

    // Verify target exists
    const target = await KV.get(kv, `data:${relDef.target}:${targetId}`);
    if (!target) return R.err(`Target "${relDef.target}:${targetId}" not found`, 404);

    if (relDef.type === "manyToMany") {
      await REL.link(kv, col, id, fieldKey, targetId, relDef);
      return R.ok({ linked: true, source: `${col}:${id}`, target: `${relDef.target}:${targetId}`, via: relDef.junction ?? `${col}_${relDef.target}` });
    }

    if (relDef.type === "hasOne" || relDef.type === "belongsTo") {
      // Set FK on this record
      const updated = { ...item, [fieldKey]: targetId, updatedAt: now() };
      await KV.set(kv, `data:${col}:${id}`, updated);
      return R.ok({ linked: true, source: `${col}:${id}`, fkField: fieldKey, targetId });
    }

    if (relDef.type === "hasMany") {
      // Set the FK on the target record
      const activeVer = await S.getActive(kv, relDef.target);
      if (!activeVer) return R.err(`No schema for target "${relDef.target}"`, 404);
      const updated = { ...target, [relDef.targetField]: id, updatedAt: now() };
      await KV.set(kv, `data:${relDef.target}:${targetId}`, updated);
      return R.ok({ linked: true, targetUpdated: `${relDef.target}:${targetId}`, fkField: relDef.targetField, value: id });
    }

    return R.err(`Unknown relation type: ${relDef.type}`, 400);
  },

  // DELETE /rel/:col/:id/:relField/:targetId
  async handleUnlink(kv, col, id, fieldKey, targetId, fields) {
    const item = await KV.get(kv, `data:${col}:${id}`);
    if (!item) return R.err(`Not found: ${id}`, 404);
    const relDef = fields[fieldKey]?.relation;
    if (!relDef) return R.err(`Field "${fieldKey}" has no relation defined`, 400);

    if (relDef.type === "manyToMany") {
      await REL.unlink(kv, col, id, fieldKey, targetId, relDef);
      return R.ok({ unlinked: true, source: `${col}:${id}`, target: `${relDef.target}:${targetId}` });
    }

    if (relDef.type === "hasOne" || relDef.type === "belongsTo") {
      const updated = { ...item, [fieldKey]: null, updatedAt: now() };
      await KV.set(kv, `data:${col}:${id}`, updated);
      return R.ok({ unlinked: true, fkField: fieldKey, clearedValue: null });
    }

    if (relDef.type === "hasMany") {
      const target = await KV.get(kv, `data:${relDef.target}:${targetId}`);
      if (target) {
        const updated = { ...target, [relDef.targetField]: null, updatedAt: now() };
        await KV.set(kv, `data:${relDef.target}:${targetId}`, updated);
      }
      return R.ok({ unlinked: true, targetUpdated: `${relDef.target}:${targetId}`, fkField: relDef.targetField });
    }

    return R.err(`Cannot unlink type: ${relDef.type}`, 400);
  },

  // GET /rel/:col/map  — returns a full relation map for the entire collection schema graph
  async handleRelMap(kv) {
    const names = (await KV.get(kv, S.globalIdx)) ?? [];
    const nodes = [];
    const edges = [];

    for (const name of names) {
      const ver = await S.getActive(kv, name);
      if (!ver) continue;
      const count = ((await KV.get(kv, `__idx:data:${name}`)) ?? []).length;
      nodes.push({ id: name, label: name, recordCount: count });
      for (const [fieldKey, r] of Object.entries(ver.fields)) {
        if (!r.relation) continue;
        edges.push({
          from: name,
          to: r.relation.target,
          field: fieldKey,
          type: r.relation.type,
          targetField: r.relation.targetField ?? null,
          junction: r.relation.junction ?? null,
        });
      }
    }

    return R.ok({ nodes, edges });
  },
};

// ── Main router ───────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });

    const kv = env.KV;
    if (!kv) return R.err("KV namespace not bound. See wrangler.toml.", 500);

    const url  = new URL(request.url);
    const m    = request.method.toUpperCase();
    const segs = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    const body = async () => request.json().catch(() => ({}));

    try {
      // Root — serve admin UI
      if (segs.length === 0 && m === "GET") {
        return new Response(ADMIN_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
        });
      }
      if (segs.length === 0) return R.ok({
        name: "Schema-Driven CRUD Worker",
        version: "3.0.0",
        routes: {
          schemas:          "GET|POST /schemas",
          schema:           "GET|PUT|DELETE /schemas/:name",
          schema_versions:  "GET /schemas/:name/versions",
          schema_version:   "GET /schemas/:name/versions/:v",
          schema_activate:  "POST /schemas/:name/activate/:v",
          data_list:        "GET /api/:col",
          data_create:      "POST /api/:col",
          data_item:        "GET|PUT|PATCH|DELETE /api/:col/:id",
          export_data:      "GET /export/:col?format=json|csv",
          export_schemas:   "GET /export/schemas",
          import_data:      "POST /import/:col?mode=append|replace",
          import_schemas:   "POST /import/schemas",
          rel_map:          "GET /rel/map",
          rel_list:         "GET /rel/:col",
          rel_get:          "GET /rel/:col/:id",
          rel_field:        "GET /rel/:col/:id/:field",
          rel_link:         "POST /rel/:col/:id/:field  body:{targetId}",
          rel_unlink:       "DELETE /rel/:col/:id/:field/:targetId",
        },
      });

      // /schemas
      if (segs[0] === "schemas") {
        const [, name, sub, subId] = segs;

        if (!name) {
          if (m === "GET")  return R.ok(await S.listMetas(kv));
          if (m === "POST") {
            const b = await body();
            if (!b.name) return R.err('"name" is required');
            if (!b.fields) return R.err('"fields" is required');
            if (!/^[a-z][a-z0-9_]*$/.test(b.name)) return R.err('"name" must be lowercase + underscores');
            if (await S.getMeta(kv, b.name)) return R.err(`Schema "${b.name}" already exists`, 409);
            const result = await S.save(kv, b.name, b);
            return R.ok(result, { created: true });
          }
          return R.err("Method not allowed", 405);
        }

        if (sub === "versions") {
          if (!subId) return R.ok(await S.listVersions(kv, name), { name });
          const ver = await S.getVer(kv, name, parseInt(subId));
          return ver ? R.ok(ver) : R.err(`Version ${subId} not found`, 404);
        }

        if (sub === "activate" && subId) {
          if (m !== "POST") return R.err("Method not allowed", 405);
          const meta = await S.getMeta(kv, name);
          if (!meta) return R.err(`Schema "${name}" not found`, 404);
          const ver = await S.getVer(kv, name, parseInt(subId));
          if (!ver) return R.err(`Version ${subId} not found`, 404);
          const updated = { ...meta, activeVersion: parseInt(subId), updatedAt: now() };
          await KV.set(kv, S.metaKey(name), updated);
          return R.ok({ meta: updated, version: ver }, { activated: true });
        }

        if (m === "GET") {
          const meta = await S.getMeta(kv, name);
          if (!meta) return R.err(`Schema "${name}" not found`, 404);
          const ver = await S.getActive(kv, name);
          return R.ok({ meta, version: ver });
        }

        if (m === "PUT") {
          const meta = await S.getMeta(kv, name);
          if (!meta) return R.err(`Schema "${name}" not found. Use POST /schemas to create.`, 404);
          const b = await body();
          if (!b.fields) return R.err('"fields" is required');
          const result = await S.save(kv, name, { ...b, description: b.description ?? meta.description });
          return R.ok(result, { updated: true });
        }

        if (m === "DELETE") {
          const meta = await S.getMeta(kv, name);
          if (!meta) return R.err(`Schema "${name}" not found`, 404);
          const deleted = await S.delete(kv, name);
          return R.ok({ name, deleted: true, dataItemsDeleted: deleted });
        }

        return R.err("Method not allowed", 405);
      }

      // /api/:col
      if (segs[0] === "api") {
        const col = segs[1];
        const id  = segs[2];
        if (!col) return R.err("Missing collection", 400);

        const activeVer = await S.getActive(kv, col);
        if (!activeVer) return R.err(`No active schema for "${col}". POST /schemas first.`, 404);
        const fields = activeVer.fields;

        // POST /api/:col/recalculate — recompute all computed fields
        if (id === "recalculate" && m === "POST") {
          const ids = await IDX.get(kv, D.ns(col));
          let updated = 0;
          const ts = now();
          for (const rid of ids) {
            const item = await KV.get(kv, D.key(col, rid));
            if (!item) continue;
            const computed = applyComputed(item, fields);
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

        if (!id) {
          if (m === "GET")  return D.list(kv, col, fields, url);
          if (m === "POST") return D.create(kv, col, fields, await body());
          return R.err("Method not allowed", 405);
        }

        if (m === "GET")    { const item = await KV.get(kv, D.key(col, id)); return item ? R.ok(applyComputed(item, fields)) : R.err(`Not found: ${id}`, 404); }
        if (m === "PUT")    return D.replace(kv, col, fields, id, await body());
        if (m === "PATCH")  return D.patch(kv, col, fields, id, await body());
        if (m === "DELETE") return D.delete(kv, col, id);
        return R.err("Method not allowed", 405);
      }

      // /rel — relation resolution routes
      if (segs[0] === "rel") {
        const [, col, id, fieldKey, targetId] = segs;

        // Global relation map
        if (col === "map") return REL.handleRelMap(kv);

        if (!col) return R.err("Usage: GET /rel/:col or GET /rel/:col/:id", 400);

        const activeVer = await S.getActive(kv, col);
        if (!activeVer) return R.err(`No active schema for "${col}"`, 404);
        const fields = activeVer.fields;

        // List with relations
        if (!id) {
          if (m === "GET") return REL.handleListWithRel(kv, col, fields, url);
          return R.err("Method not allowed", 405);
        }

        // Get item + all relations
        if (!fieldKey) {
          if (m === "GET") return REL.handleGetWithRel(kv, col, id, fields);
          return R.err("Method not allowed", 405);
        }

        // Single relation field
        if (!targetId) {
          if (m === "GET")  return REL.handleGetOneRel(kv, col, id, fieldKey, fields);
          if (m === "POST") return REL.handleLink(kv, col, id, fieldKey, fields, await request.json().catch(() => ({})));
          return R.err("Method not allowed", 405);
        }

        // Unlink specific target
        if (m === "DELETE") return REL.handleUnlink(kv, col, id, fieldKey, targetId, fields);
        return R.err("Method not allowed", 405);
      }

      // /export
      if (segs[0] === "export") {
        const target = segs[1];
        if (!target) return R.err("Usage: GET /export/:collection  or  GET /export/schemas");
        if (target === "schemas") return handleExportSchemas(kv);
        return handleExport(kv, target, url);
      }

      // /import
      if (segs[0] === "import") {
        const target = segs[1];
        if (!target) return R.err("Usage: POST /import/:collection  or  POST /import/schemas");
        if (m !== "POST") return R.err("Method not allowed — use POST", 405);
        if (target === "schemas") return handleImportSchemas(kv, request);
        return handleImport(kv, target, request, url);
      }

      return R.err("Not found. GET / for docs.", 404);

    } catch (e) {
      console.error(e);
      return R.err("Internal error: " + e.message, 500);
    }
  },
};
