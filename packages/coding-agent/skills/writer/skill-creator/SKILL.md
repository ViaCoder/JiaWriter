---
name: skill-creator
description: For creating or changing a writing skill, also from sample texts or the requests of a session.
disable-model-invocation: true
metadata:
  title: Writing skill creator（编写写作 skill）
  style_packs: core-zh,core-en
  negation_threshold: 3
---

# Writing skill creator

Creates or changes a writing skill: rules the model can follow in cases they do not name, as short as possible.

## File format

- A skill is a folder with SKILL.md. The file starts with frontmatter:
  - name: lowercase letters, digits and hyphens, at most 64 characters, the same as the folder name;
  - description: what the skill does and when to use it, one short sentence;
  - metadata.title: a display title; metadata.style_packs: the packs style_check uses.
- The body has Markdown sections such as before writing, structure, style and citations.

## Wording

- Write rules in English; keep Chinese only where English cannot say it, such as a fixed formula of the genre.
- Give a rule its purpose in half a sentence, so it carries to cases it does not name.
- State the principle, not lists of words or cases; give at most one pass/fail example pair, only for a rule that is easy to misread.
- Write steps that say what to do, not lists of prohibitions.
- Keep exact values from the user's own words (font size, line spacing, length) as given; when a topic has several requests, keep the latest.
- Leave out what the program already checks: citation form, heading numbers, placeholders, AI style.

## Learning from samples

- Import the sample texts with import_document and measure sentence length, paragraph length, heading levels and the usual openings and endings.
- Write the reusable practices as rules and leave the sample content in its files.

## Saving

- Save new skills as ~/.jiawriter/agent/skills/<name>/SKILL.md; back up an existing skill before changing it.
- After saving, tell the user to run /reload.
