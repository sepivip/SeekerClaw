---
name: translate
description: "Translate text between languages. Use when: user asks to translate, 'how do you say X in Y', or sends foreign text needing translation. Don't use when: user wants a word definition in the same language (use define skill)."
version: "1.0.0"
---

# Translate

## Use when
- "translate this to Spanish", "how do you say X in Y"
- Foreign language text needing translation
- Pronunciation hints for non-Latin scripts

## Don't use when
- Word definition in the same language (use define)
- Learning a language (provide general guidance instead)

## Instructions
When translating:

1. Identify source and target languages
   - If not specified, translate TO user's preferred language
   - Check memory for language preferences

2. Provide the translation directly
   - Include pronunciation hints for non-Latin scripts
   - Note any nuances or alternative meanings

3. For longer texts, translate paragraph by paragraph

4. If source language is unclear, detect it first

Supported: All major languages including English, Spanish,
French, German, Chinese, Japanese, Korean, Arabic, Russian, etc.
