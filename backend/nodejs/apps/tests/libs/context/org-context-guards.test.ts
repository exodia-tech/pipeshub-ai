/// <reference types="mocha" />
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

/**
 * CI ratchets for org context (direct_org_reads, detached_work). Counts per file may only go down.
 * To record an intentional change run
 *   ORG_CONTEXT_UPDATE_BASELINE=1 npx mocha --config <rc> tests/libs/context/org-context-guards.test.ts
 * and review the diff of org-context-baseline.json.
 *
 * detached_work: long-lived work (timers, workers, consumers, lazily created clients) starts inside
 *   spawnDetached; AsyncLocalStorage propagates into everything created inside a request.
 * direct_org_reads: new reads of the org straight off the request user bypass the context.
 */
const SRC = path.resolve(__dirname, '../../../src')
const BASELINE = path.join(__dirname, 'org-context-baseline.json')
const GUARDS: Record<string, { pattern: RegExp; exempt: string[]; hint: string }> = {
  'detached_work': {
    pattern: /\bsetInterval\(|\bnew Worker\(/g,
    exempt: [],
    hint: 'Start it inside spawnDetached (libs/context/orgContext.ts).',
  },
  'direct_org_reads': {
    pattern: /\breq\.user(?:[?!]?\.orgId\b|[?!]?\.?\[\s*['\"]orgId['\"]\s*\])/g,
    exempt: ['libs/middlewares/auth.middleware.ts'],
    hint: 'Read the org from currentOrgContext() instead of the request user.',
  },
}

function countDetachedWork(text: string): number {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  let count = 0
  const visit = (node: ts.Node, detached = false): void => {
    if (ts.isFunctionLike(node)) {
      const parent = node.parent
      detached = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'spawnDetached' && parent.arguments[0] === node
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !detached) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if ((ts.isCallExpression(node) && name === 'setInterval') || (ts.isNewExpression(node) && name === 'Worker')) count++
    }
    ts.forEachChild(node, child => visit(child, detached))
  }
  visit(source)
  return count
}

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) yield p
  }
}

function scan(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = Object.fromEntries(Object.keys(GUARDS).map((g) => [g, {}]))
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/')
    const text = fs.readFileSync(file, 'utf8')
    for (const [g, { pattern, exempt }] of Object.entries(GUARDS)) {
      const n = exempt.includes(rel) ? 0 : g === 'detached_work' ? countDetachedWork(text) : (text.match(pattern) ?? []).length
      if (n) out[g][rel] = n
    }
  }
  return out
}

describe('org context CI ratchets', () => {
  it('accepts timers inside the detached callback but refuses eager or unwrapped creation', () => {
    expect(countDetachedWork('spawnDetached(() => setInterval(tick, 60000))')).to.equal(0)
    expect(countDetachedWork('spawnDetached(setInterval(tick, 60000))')).to.equal(1)
    expect(countDetachedWork('setInterval(tick, 60000)')).to.equal(1)
    expect(countDetachedWork('spawnDetached(() => { new Worker("worker.js") })')).to.equal(0)
    expect(countDetachedWork('spawnDetached(() => function later() { setInterval(tick, 60000) })')).to.equal(1)
  })
  it('direct_org_reads counts plain, optional and non-null-asserted reads', () => {
    const hits = ['req.user.orgId', 'req.user?.orgId', 'req.user!.orgId', "req.user['orgId']", 'req.user?.["orgId"]'].map((t) => (t.match(GUARDS.direct_org_reads.pattern) ?? []).length)
    expect(hits).to.deep.equal([1, 1, 1, 1, 1])
  })

  const found = scan()
  if (process.env.ORG_CONTEXT_UPDATE_BASELINE) {
    fs.writeFileSync(BASELINE, JSON.stringify(found, null, 1) + '\n')
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as typeof found

  for (const [g, { hint }] of Object.entries(GUARDS)) {
    it(`${g}: no new sites`, () => {
      const grown = Object.entries(found[g]).filter(([f, n]) => n > (base[g][f] ?? 0)).map(([f, n]) => `${f}: ${base[g][f] ?? 0} -> ${n}`)
      expect(grown, `${g} new sites. ${hint}`).to.deep.equal([])
    })
  }
})
