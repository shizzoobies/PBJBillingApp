// Stand-in for the Workers runtime module `cloudflare:workers` under vitest only
// (vite.config.ts test.alias). The real DurableObject keeps `ctx` and `env`; so does this.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}
