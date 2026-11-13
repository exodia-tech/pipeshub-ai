import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import jwt from 'jsonwebtoken';
import { groupScopeResolver } from '../../../src/libs/services/group-scope-policy';

describe('live group scope policy boundary', () => {
  afterEach(() => sinon.restore());
  const config = { connectorBackend: 'http://policy.test', scopedJwtSecret: 'synthetic-scope-policy-secret' };
  const resolve = () => groupScopeResolver(config, false)('verified-org', 'verified-user');

  for (const scopes of [null, [], ['agent:execute']]) {
    it(`preserves the explicit ceiling ${JSON.stringify(scopes)}`, async () => {
      const request = sinon.stub(globalThis, 'fetch').callsFake(async () => new Response(JSON.stringify({ scopes }), { status: 200 }));
      assert.deepEqual(await resolve(), scopes);
      const headers = new Headers(request.firstCall.args[1]?.headers);
      const claims = jwt.verify(headers.get('authorization')!.slice(7), config.scopedJwtSecret) as jwt.JwtPayload;
      assert.equal(claims.orgId, 'verified-org');
      assert.equal(claims.userId, 'verified-user');
      assert.deepEqual(claims.scopes, ['access-group:manage']);
      assert.ok(claims.exp! - claims.iat! <= 60);
    });
  }

  for (const body of [null, {}, { scopes: 'all' }, { scopes: [1] }, { scopes: ['org:admin'] }, { scopes: ['unknown:action'] }, { scopes: Array(101).fill('agent:execute') }]) {
    it(`fails closed for an invalid policy response ${JSON.stringify(body).slice(0, 70)}`, async () => {
      sinon.stub(globalThis, 'fetch').callsFake(async () => new Response(JSON.stringify(body), { status: 200 }));
      await assert.rejects(resolve, { statusCode: 503 });
    });
  }

  it('fails closed on an upstream HTTP refusal', async () => {
    sinon.stub(globalThis, 'fetch').callsFake(async () => new Response('{}', { status: 503 }));
    await assert.rejects(resolve, { statusCode: 503 });
  });
});
