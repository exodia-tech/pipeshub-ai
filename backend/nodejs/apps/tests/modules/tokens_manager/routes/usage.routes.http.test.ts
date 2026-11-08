import 'reflect-metadata'
import { expect } from 'chai'
import express, { NextFunction, Request, Response } from 'express'
import { Container } from 'inversify'
import http from 'http'
import { AddressInfo } from 'net'
import { createUsageRouter } from '../../../../src/modules/tokens_manager/routes/usage.routes'

describe('Usage gateway HTTP', () => {
  let backend: http.Server
  let gateway: http.Server
  let base: string
  let received: {
    method?: string
    path?: string
    body?: unknown
    authorization?: string
  } = {}
  let scopes: string[] | null = null
  before(async () => {
    const app = express()
    app.use(express.json())
    app.use((req, res) => {
      received = {
        method: req.method,
        path: req.url,
        body: req.body,
        authorization: req.headers.authorization,
      }
      res
        .status(req.method === 'PUT' ? 200 : 422)
        .json(req.method === 'PUT' ? { saved: true } : { detail: 'invalid' })
    })
    backend = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => backend.once('listening', resolve))
    const container = new Container()
    container.bind('AuthMiddleware').toConstantValue({
      authenticate: (req: Request, _res: Response, next: NextFunction) => {
        Object.assign(req, {
          user:
            scopes === null
              ? { isOAuth: false }
              : { isOAuth: true, oauthScopes: scopes },
        })
        next()
      },
    })
    container
      .bind('AppConfig')
      .toConstantValue({
        aiBackend: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
      })
    const proxy = express()
    proxy.use(express.json())
    proxy.use('/api/v1/usage', createUsageRouter(container))
    proxy.use(
      (
        err: Error & { statusCode?: number },
        _req: Request,
        res: Response,
        _next: NextFunction,
      ) => res.status(err.statusCode ?? 500).json({ error: err.message }),
    )
    gateway = proxy.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => gateway.once('listening', resolve))
    base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/api/v1/usage`
  })
  after(async () => {
    await Promise.all([
      new Promise<void>((r) => gateway.close(() => r())),
      new Promise<void>((r) => backend.close(() => r())),
    ])
  })
  afterEach(() => {
    scopes = null
    received = {}
  })
  it('forwards a budget write with its body and caller authentication', async () => {
    const body = {
      scope: 'organization',
      subject: '',
      amount_usd: '25',
      warning_percent: 80,
    }
    const res = await fetch(`${base}/budgets`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
      },
      body: JSON.stringify(body),
    })
    expect(res.status).to.equal(200)
    expect(received).to.deep.equal({
      method: 'PUT',
      path: '/api/v1/usage/budgets',
      body,
      authorization: 'Bearer test-token',
    })
  })
  it('returns backend errors without turning them into success', async () => {
    const res = await fetch(`${base}/budgets?view=organization`)
    expect(res.status).to.equal(422)
    expect(await res.json()).to.deep.equal({ detail: 'invalid' })
    expect(received.path).to.equal('/api/v1/usage/budgets?view=organization')
  })
  it('rejects an under-scoped OAuth budget write before forwarding', async () => {
    scopes = ['org:read']
    const res = await fetch(`${base}/budgets`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.ok).to.equal(false)
    expect(received).to.deep.equal({})
  })
})
