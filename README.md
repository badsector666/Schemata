https://schema-crud-worker.badsectorkiller666.workers.dev

# SCHEMATA — Schema-Driven CRUD Worker v2

Fully dynamic REST API where schemas are stored in KV, versioned, and can be created and modified at runtime. No static schema file. A built-in admin UI drives everything from a JSON renderer.

---

## Architecture

```
KV Storage
├── __schema_idx                       global list of schema names
├── __schema_meta:{name}               schema metadata + active version pointer
├── __schema_veridx:{name}             list of version numbers for a schema
├── __schema_ver:{name}:{v}            immutable version snapshot (fields + ui)
├── __idx:data:{name}                  index of data record IDs
└── data:{name}:{id}                   individual data records
```

Every schema save creates a new **immutable version**. You can inspect any past version and activate any version at any time — your data is always read using the **active** version's field definitions.

---

## Quick Start

```bash
npm install

# 1. Create KV namespace
npm run kv:create
# Paste the id into wrangler.toml

# 2. Local dev
npm run dev

# 3. Deploy
npm run deploy
```

Then open `admin-ui.html` in your browser, enter your worker URL, and connect.

---

## API Reference

### Schema Management

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/schemas` | List all schema metadata |
| `POST` | `/schemas` | Create new schema |
| `GET` | `/schemas/:name` | Get active version |
| `PUT` | `/schemas/:name` | Save new version (bumps version counter) |
| `DELETE` | `/schemas/:name` | Delete schema + all data |
| `GET` | `/schemas/:name/versions` | List all versions |
| `GET` | `/schemas/:name/versions/:v` | Get specific version |
| `POST` | `/schemas/:name/activate/:v` | Set a version as active |

### Data CRUD

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/:col` | List items (paginated, filterable, sortable) |
| `POST` | `/api/:col` | Create item |
| `GET` | `/api/:col/:id` | Get item |
| `PUT` | `/api/:col/:id` | Full replace |
| `PATCH` | `/api/:col/:id` | Partial update |
| `DELETE` | `/api/:col/:id` | Delete item |

#### List query params
- `page`, `limit` — pagination
- `sortBy`, `sortDir` (asc/desc) — sorting
- Any other param — equality filter (e.g. `?status=active`)

---

## Creating a Schema

```http
POST /schemas
{
  "name": "orders",
  "description": "Customer orders",
  "changelog": "Initial version",
  "fields": {
    "customerId": { "type": "string", "required": true, "immutable": true },
    "total":      { "type": "number", "required": true, "min": 0 },
    "status":     { "type": "string", "default": "pending", "enum": ["pending","paid","shipped"] },
    "notes":      { "type": "string", "max": 500 }
  }
}
```

## Updating a Schema (new version)

```http
PUT /schemas/orders
{
  "changelog": "Added priority field",
  "fields": {
    "customerId": { "type": "string", "required": true, "immutable": true },
    "total":      { "type": "number", "required": true, "min": 0 },
    "status":     { "type": "string", "default": "pending", "enum": ["pending","paid","shipped","cancelled"] },
    "notes":      { "type": "string", "max": 500 },
    "priority":   { "type": "string", "default": "normal", "enum": ["low","normal","high"] }
  }
}
```

## Activating a Previous Version

```http
POST /schemas/orders/activate/1
```

---

## Field Options

| Option | Description |
|--------|-------------|
| `type` | `string`, `number`, `boolean`, `array`, `object` |
| `required` | Must be present on create |
| `default` | Value used if field absent |
| `min` / `max` | Range for numbers; length for strings/arrays |
| `enum` | Whitelist of allowed values |
| `pattern` | Regex string the value must match |
| `immutable` | Set on create, blocked on all updates |

---

## UI Layout (JSON Renderer)

Each schema version stores a `ui` object that drives the admin UI. It's auto-generated when you save a schema, but you can edit it freely in the **UI Layout** tab.

```json
{
  "form": {
    "layout": "stack",
    "fields": [
      { "key": "status", "label": "Status", "widget": "select",
        "options": [{"label":"Pending","value":"pending"}] }
    ]
  },
  "table": {
    "columns": [
      { "key": "customerId", "label": "Customer", "type": "string", "sortable": true }
    ]
  },
  "detail": {
    "sections": [
      { "title": "Order Info", "fields": ["customerId","total","status"] },
      { "title": "System",     "fields": ["id","createdAt","updatedAt"] }
    ]
  }
}
```

### Widget types
| Widget | Used for |
|--------|---------|
| `text` | Short strings |
| `textarea` | Long strings |
| `number` | Numeric fields |
| `select` | Enum fields |
| `toggle` | Boolean fields |
| `tags` | Array fields |
| `json` | Object fields |
