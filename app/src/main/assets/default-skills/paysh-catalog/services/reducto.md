# Reducto Document Parser (paysponge)

AI-powered document parsing — turn PDFs, scanned images, or invoices into structured data.

## Endpoint

- **URL pattern:** `https://api.paysponge.com/x402/purchase/svc_d672d90ggvqqygj60/extract`
- **Method:** POST (JSON body)
- **Cost:** $0.05 USDC per call (Solana mainnet)
- **Suggested max_usdc:** `"0.15"` (decimal STRING)

## Body construction

Standard Reducto `/extract` payload:

```json
{
  "document_url": "https://example.com/invoice.pdf",
  "options": {
    "extract_tables": true,
    "extract_text": true
  }
}
```

Pass `document_url` as the source. Reducto fetches it server-side — the URL must be publicly reachable.

## When to use vs free alternatives

- **Use Reducto** for actual extraction of tables, line items, structured fields from PDFs / scanned docs. Especially valuable for invoices, receipts, financial statements.
- **Don't use Reducto** for simple text-from-PDF — `web_fetch` on a publicly-hosted PDF often works for plain-text content. Reserve Reducto for layout-aware extraction.

## Response shape

JSON with parsed sections, tables, and key-value pairs. Costs more than most services ($0.05) — confirm with the user before invoking if their question could be answered cheaper.
