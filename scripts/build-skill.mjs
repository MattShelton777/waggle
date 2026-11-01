// Package skill/waggle into apps/connect/downloads/waggle-skill.zip for upload to clients that support skills.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";

const src = "skill/waggle";
const files = Object.fromEntries(readdirSync(src).map((f) => [`waggle/${f}`, readFileSync(join(src, f))]));
mkdirSync("apps/connect/downloads", { recursive: true });
writeFileSync("apps/connect/downloads/waggle-skill.zip", zipSync(files, { level: 9, mtime: new Date("2026-01-01") }));
console.log(`built apps/connect/downloads/waggle-skill.zip (${Object.keys(files).join(", ")})`);
