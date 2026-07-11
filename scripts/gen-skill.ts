// Regenerate skills/just-html/SKILL.md from the canonical content in
// lib/skill-content.ts, so the skill that `npx skills add kernel/just-html`
// installs stays byte-for-byte in sync with /llms.txt.
//
// Run via tsx: `npm run gen:skill`. The skill-sync GitHub Action runs this on
// every push that touches the content/generator and commits the result, so the
// committed SKILL.md can't drift. Frontmatter (name + description) is required
// by the skills CLI.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_MARKDOWN } from "../lib/skill-content";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "skills", "just-html", "SKILL.md");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, SKILL_MARKDOWN);
console.log(`wrote ${outPath} (${SKILL_MARKDOWN.length} bytes)`);
