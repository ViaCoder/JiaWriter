---
name: skill-creator
description: 用于新建或修改写作 skill，也能把范文风格或会话要求整理成 skill。
disable-model-invocation: true
metadata:
  title: 编写写作 skill
  style_packs: core-zh
  negation_threshold: 3
---

# 编写写作 skill

## 文件格式

- 每个 skill 是一个文件夹，内含 SKILL.md。文件开头是 frontmatter：
  - name：小写字母、数字和连字符，最长 64 个字符，与文件夹同名；
  - description：写明这个 skill 做什么、在什么情况下使用，最长 1024 个字符；
  - metadata.title：中文标题；metadata.style_packs：style_check 使用的词表。
- 正文用 Markdown 分节：动笔之前、结构、文风、引用、收尾检查。

## 写法

- 每条规则写成肯定式，说明要做什么，例如“用常用词”“每段讲一件事”。
- 规则具体到可以检查，例如字数范围、标题层级、引用格式。
- 用户的原话里有明确数值（字号、行距、篇幅）的，原样保留。
- 同一主题有前后不同的要求时，以最后一次为准。

## 从范文提炼

- 先用 import_document 导入范文，统计句长、段落长度、标题层级和常用的开头与结尾方式。
- 把可以重复使用的做法写成规则，范文的具体内容留在原文件中。

## 保存

- 新 skill 放在 ~/.jiawriter/agent/skills/<name>/SKILL.md；修改已有 skill 前先备份原文件。
- 保存后提示用户运行 /reload 使改动生效。
