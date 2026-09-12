import { test } from "node:test";
import assert from "node:assert/strict";
import { compressTrigger, optionsFromEnv, rewriteCatalog } from "./catalog.ts";
const entry = (name: string, description: string, location = `/skills/${name}/SKILL.md`) => `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>${location}</location>\n  </skill>`;
const wrap = (entries: string[]) => `<available_skills>\n${entries.join("\n")}\n</available_skills>`;
const description = 'Use when debugging PostgreSQL replication lag, WAL retention, database failover and query performance. This comprehensive skill provides detailed troubleshooting instructions, practical reference examples, diagnostic checklists, verification procedures, deployment safety considerations, recovery workflows and common failure scenarios for operators working across development, staging and production environments.';
export const realisticCatalog = wrap(Array.from({ length: 77 }, (_, i) => entry(`database-operations-${i}`, description)));

test("trigger keeps first-sentence domain keywords and caps at 15 words", () => {
  const trigger = compressTrigger(description);
  assert.match(trigger, /PostgreSQL replication lag, WAL retention/);
  assert.ok(trigger.split(/\s+/).length <= 15);
  assert.doesNotMatch(trigger, /comprehensive|troubleshooting/);
  assert.equal(compressTrigger('Use for powerful Kubernetes deployment automation.'), 'Kubernetes deployment automation.');
});
test("77-skill fixture: >=60% reduction, UTF-8 budget, every name/path retained", () => {
  const result = rewriteCatalog(`prefix\n${realisticCatalog}\nsuffix`);
  assert.ok(result.changed);
  assert.ok(result.afterBytes <= 8192);
  assert.ok(result.afterBytes / result.beforeBytes <= 0.4);
  for (let i = 0; i < 77; i++) assert.ok(result.systemPrompt.includes(`database-operations-${i} (/skills/database-operations-${i}/SKILL.md)`));
  assert.ok(result.systemPrompt.startsWith('prefix\n'));
  assert.ok(result.systemPrompt.endsWith('\nsuffix'));
  console.log(`77-skill catalog: ${result.beforeBytes} -> ${result.afterBytes} UTF-8 bytes (${(100 * (1 - result.afterBytes / result.beforeBytes)).toFixed(1)}% reduction)`);
});
test("small catalogs, absent sections, malformed catalogs and disabled flag are no-ops", () => {
  for (const text of ['plain prompt', wrap([entry('sql', 'SQL queries.')]), '<available_skills><skill>unknown</skill></available_skills>']) assert.equal(rewriteCatalog(text).systemPrompt, text);
  assert.equal(rewriteCatalog(realisticCatalog, { enabled: false }).systemPrompt, realisticCatalog);
  assert.equal(rewriteCatalog('<available_skills><skill>unknown</skill></available_skills>', { byteBudget: 1 }).changed, false);
});
test("idempotent", () => {
  const first = rewriteCatalog(realisticCatalog).systemPrompt;
  assert.equal(rewriteCatalog(first).systemPrompt, first);
});
test("UTF-8 enforcement and XML entity safety", () => {
  const input = wrap([entry('数据库', 'Use for 数据库 replication automation. ' + 'More details. '.repeat(80), '/a&amp;b/数据库/SKILL.md')]);
  const result = rewriteCatalog(input, { byteBudget: 220 });
  assert.ok(result.afterBytes <= 220);
  assert.ok(result.systemPrompt.includes('/a&amp;b/数据库/SKILL.md'));
});
test("impossible budget preserves identities and reports overflow", () => {
  const result = rewriteCatalog(realisticCatalog, { byteBudget: 1 });
  assert.ok(result.overflowBytes > 0);
  for (let i = 0; i < 77; i++) assert.ok(result.systemPrompt.includes(`/skills/database-operations-${i}/SKILL.md`));
});
test("configuration defaults and safe validation", () => {
  assert.deepEqual(optionsFromEnv({}), { enabled: true, byteBudget: 8192, maxTriggerWords: 15 });
  assert.deepEqual(optionsFromEnv({ STEAK_PI_SKILL_CATALOG_LITE: 'off', STEAK_PI_SKILL_CATALOG_BYTES: '-1', STEAK_PI_SKILL_CATALOG_WORDS: '100' }), { enabled: false, byteBudget: 8192, maxTriggerWords: 15 });
});
