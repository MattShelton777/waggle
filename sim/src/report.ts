import { runScenario, type SimResult } from "./engine";
import { GOOD_QUALITY, GOOD_TARGET, TARGET, TARGET_QUALITY, scenarios } from "./scenarios";

// `npm run sim`: run every scenario and print a Markdown summary, including
// the parity sweep that shows where the model breaks (expected, per Cairn).

const f = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? "-" : x.toFixed(3));

function row(r: SimResult): string {
  const t = r.scores.get(TARGET)!;
  const g = r.scores.get(GOOD_TARGET)!;
  const reps = Object.entries(r.meanReputationByBehavior)
    .map(([b, v]) => `${b} ${f(v)}`)
    .join(", ");
  return `| ${r.scenario} | ${r.events} | ${f(r.maeConfident)} | ${f(t.composite)} (${t.label}) | ${f(g.composite)} | ${reps} |`;
}

const lines: string[] = [];
lines.push(`Target (bad tool) true quality ${TARGET_QUALITY}; good tool (${GOOD_TARGET}) true quality ${GOOD_QUALITY}.`, "");
lines.push("| scenario | events | MAE (confident) | bad-tool composite | good-tool composite | mean reputation |");
lines.push("|---|---|---|---|---|---|");

for (const make of [
  scenarios.honestOnly,
  scenarios.honestMixed,
  scenarios.faulty,
  scenarios.persistentLiars,
  scenarios.slander,
  scenarios.camouflage,
  () => scenarios.sameDomainSybil(30),
  () => scenarios.personalDomainSybil(10),
  () => scenarios.personalDomainSybil(30),
  () => scenarios.personalDomainSybilAllPersonal(30),
  () => scenarios.agedPersonalSybil(30),
]) {
  lines.push(row(runScenario(make())));
}

lines.push("", "Parity sweep: colluders (distinct work domains) boosting the bad tool against 20 honest raters.", "");
lines.push("| colluder share | bad-tool composite | label | honest mean rep | colluder mean rep |");
lines.push("|---|---|---|---|---|");
for (const colluders of [0, 2, 5, 10, 15, 20, 25, 30, 40, 60]) {
  const r = runScenario(scenarios.clique(colluders, 20));
  const t = r.scores.get(TARGET)!;
  // Share of raters *on the target*: honest raters spread over 22 entities, colluders hit only the target.
  const share = colluders / (colluders + 20);
  lines.push(
    `| ${colluders} of ${colluders + 20} accounts (${(share * 100).toFixed(0)}%) | ${f(t.composite)} | ${t.label} | ${f(r.meanReputationByBehavior.honest)} | ${f(r.meanReputationByBehavior.colluder)} |`,
  );
}

console.log(lines.join("\n"));
