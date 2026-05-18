# Reducto Document Parser (paysponge)

AI-powered document parsing — turn PDFs, scanned images, or invoices into structured data. Two catalogued endpoints:

- **[`extract`](#extract)** — AI-extraction with layout awareness (tables, key-value pairs, structured fields) ($0.05)
- **[`parse`](#parse)** — raw text/structure parse (no AI extraction layer) ($0.05)

Both endpoints live behind the paysponge x402 gateway:
- Base: `https://api.paysponge.com`
- Path prefix: `/x402/purchase/svc_d672d90ggvqqygj60/`

## When to use which / vs free alternatives

- **Use `extract`** for invoices, receipts, financial statements — anywhere you need named fields (line items, totals, dates) pulled out of unstructured layouts.
- **Use `parse`** for raw OCR / text-from-document where you just need the words and basic structure (paragraphs / tables) without AI-driven field extraction. Same $0.05 cost as `extract` — pick `parse` based on shape of output you need (raw text vs structured fields), not on price.
- **Don't use Reducto** for simple text-from-PDF — `web_fetch` on a publicly-hosted PDF often works for plain-text content. Reserve Reducto for layout-aware extraction or OCR.
- Both endpoints are $0.05 each — confirm with the user before invoking if their question could be answered cheaper.

<a id="extract"></a>
## `extract` — AI extraction

`POST https://api.paysponge.com/x402/purchase/svc_d672d90ggvqqygj60/extract`

### Body construction

```json
{
  "document_url": "https://example.com/invoice.pdf",
  "options": {
    "extract_tables": true,
    "extract_text": true
  }
}
```

`document_url` must be publicly reachable (Reducto fetches server-side). Returns JSON with parsed sections, tables, and key-value pairs.

<a id="parse"></a>
## `parse` — raw text / structure

`POST https://api.paysponge.com/x402/purchase/svc_d672d90ggvqqygj60/parse`

### Body construction

```json
{
  "document_url": "https://example.com/doc.pdf"
}
```

Similar to extract but skips the AI-extraction layer — returns text + basic structure (paragraphs, table boundaries) but no named-field extraction. Use when the user wants the raw text or a quick OCR pass.

## Response surfacing

For both endpoints — surface only the part the user asked about (the line items they wanted, the specific field, the OCR'd paragraph). Don't dump the full parsed JSON.
