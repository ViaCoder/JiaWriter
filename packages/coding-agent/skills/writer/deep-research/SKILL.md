---
name: deep-research
description: Researches a question across many sources and writes a sourced report, briefing or news round-up. Use when the user asks to research, investigate or compile news on a topic.
metadata:
  title: Deep research（深度研究）
  style_packs: core-zh,core-en
  negation_threshold: 3
---

# Deep research

Answer the user's question from sources a careful reader would trust, and show where each fact comes from. This skill is for requests to research; without one, write from the materials given.

## Steps

1. Split the question into the 2–5 sub-questions an answer needs. Scale the effort to the question: a single fact takes a few searches; a comparison or a situation report needs every sub-question searched.
2. Start each sub-question with a short, broad query, then narrow with the names, dates and sites the first results show.
3. Open the two or three most authoritative pages for each sub-question (official releases, major outlets, the original paper); a result list is only a lead. Record each fact with material_add: the fact, its date, the outlet and the address.
4. Check the gaps: sub-questions with no recorded fact, and facts that conflict. Search once more for those; what is still missing is said in the answer.
5. Write the answer from the record only. Before finishing, check every statement against the record, and drop or source one that has no entry.

## Reports

- Open with the conclusions and main recommendations; the body gives the findings by sub-question; each problem has a matching recommendation.
- Give each figure with its definition, period and source; state the assumptions behind an estimate; trace causes to a level where action is possible.

## News round-ups

- Report only facts and what named sources said, never your own analysis or a conclusion in a source's name.
- Order items by importance, or by date in a chronology, each with its date; when the user names the materials, use only those.
