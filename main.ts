// The program the harness runs: reads every case from /input/cases.json (or
// $MAKEFUN_INPUT_DIR/cases.json), answers each one alone with run() from solve.js, and writes
// /output/answers.json (or $MAKEFUN_OUTPUT_DIR/answers.json): a JSON array of the answers, one
// per case and in the cases' order.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{
  id: string;
  input: unknown;
}>;

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
