// Regenerate skills/just-html/SKILL.md from the canonical content in
// lib/skill-content.mjs, so the skill that `npx skills add kernel/just-html`
// installs stays byte-for-byte in sync with /llms.txt.
//
// Pure node, no deps: `node scripts/gen-skill.mjs` (or `npm run gen:skill`).
// The skill-sync GitHub Action runs this on every push that touches the
// content/generator and commits the result, so the committed SKILL.md can't
// drift. Frontmatter (name + description) is required by the skills CLI.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_NAME, SKILL_DESCRIPTION, LLMS_BODY } from "../lib/skill-content.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "skills", "just-html", "SKILL.md");

// YAML frontmatter: keep the description on one folded line (no colons/newlines
// to escape — it's prose). The body is the verbatim llms.txt content.
const frontmatter = `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, frontmatter + LLMS_BODY);
console.log(`wrote ${outPath} (${frontmatter.length + LLMS_BODY.length} bytes)`);
