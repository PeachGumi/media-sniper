'use strict';
/* Tiny dependency-free test harness. */
let pass = 0;
let fail = 0;
const failures = [];

function norm(v) {
  if (Array.isArray(v)) return Array.from(v, norm);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  return v;
}

function eq(actual, expected, name) {
  const a = JSON.stringify(norm(actual));
  const e = JSON.stringify(norm(expected));
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(name + '\n  expected: ' + e + '\n  actual:   ' + a);
  }
}

function ok(cond, name) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name);
  }
}

function report(suite) {
  console.log((fail ? 'FAIL ' : 'ok ') + suite + ': ' + pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log(failures.map((f) => '  * ' + f).join('\n'));
    process.exit(1);
  }
}

module.exports = { eq, ok, report };
