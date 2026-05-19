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
 *   GET    /                            serves admin UI
 * ─────────────────────────────────────────────────────────────────
 */

const ADMIN_HTML = __ADMIN_HTML_PLACEHOLDER__;

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
    return R.ok(items.slice(start, start + limit), {
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
    return R.ok(item, { created: true });
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
    return R.ok(item, { replaced: true });
  },

  patch: async (kv, col, fields, id, body) => {
    const existing = await KV.get(kv, D.key(col, id));
    if (!existing) return R.err(`Not found: ${id}`, 404);
    const errs = validate(body, fields, existing);
    if (errs.length) return R.err("Validation failed", 422, errs);
    const item = preserveImmutable({ ...existing, ...body, updatedAt: now() }, existing, fields);
    await KV.set(kv, D.key(col, id), item);
    return R.ok(item, { patched: true });
  },

  delete: async (kv, col, id) => {
    const item = await KV.get(kv, D.key(col, id));
    if (!item) return R.err(`Not found: ${id}`, 404);
    await KV.del(kv, D.key(col, id));
    await IDX.rem(kv, D.ns(col), id);
    return R.ok({ id, deleted: true });
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

        if (!id) {
          if (m === "GET")  return D.list(kv, col, fields, url);
          if (m === "POST") return D.create(kv, col, fields, await body());
          return R.err("Method not allowed", 405);
        }

        if (m === "GET")    return D.get(kv, col, id);
        if (m === "PUT")    return D.replace(kv, col, fields, id, await body());
        if (m === "PATCH")  return D.patch(kv, col, fields, id, await body());
        if (m === "DELETE") return D.delete(kv, col, id);
        return R.err("Method not allowed", 405);
      }

      return R.err("Not found. GET / for docs.", 404);

    } catch (e) {
      console.error(e);
      return R.err("Internal error: " + e.message, 500);
    }
  },
};
