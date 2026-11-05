---
name: general-article
description: For explanatory articles, opinion pieces, columns and speeches.
metadata:
  title: General article
  style_packs: core-en
  negation_threshold: 3
---

# General article

## Before writing

- Confirm the topic, readers, purpose and length; where the user leaves one open, choose the usual option and say so in the reply.
- Import reference files with import_document first and find the facts you need with grep; use web_search and web_fetch for recent information.

## Structure

- The title names the topic. The first two or three sentences state the subject and why it matters.
- Develop the body as claim, evidence, explanation; each paragraph covers one point and opens with a sentence that sums it up.
- The ending gathers the main points and gives an action or next step, about as long as the opening.

## Style

- Use common words and complete, short sentences, one idea per sentence.
- State the facts first, then the judgement, and give the basis for each judgement.
- Say directly what something is and how it works; cut preambles and stock phrases.
- Take cited cases only from the reference files or search results, and name the date and outlet in the text, for example "Reuters reported on 31 October 2026". List every source with its title and URL in the References section at the end.

## Final checks

- Run style_check on the finished draft, rewrite only the flagged sentences, and run it again until it passes.
- Check the length with word_count and long sentences with readability_check.
- Export a .docx with export_document when the user needs a file.
