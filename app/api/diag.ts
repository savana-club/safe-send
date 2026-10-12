// TEMPORARY: reports why the Blink's modules fail to load on Vercel. Removed after the fix.
const tries: [string, () => Promise<unknown>][] = [
  ['@solana/web3.js', () => import('@solana/web3.js')],
  ['@solana/spl-token', () => import('@solana/spl-token')],
  ['@noble/hashes/sha256', () => import('@noble/hashes/sha256')],
  ['safeSend', () => import('../src/lib/safeSend.ts')],
  ['fees', () => import('../src/lib/fees.ts')],
  ['actions/send', () => import('./actions/send.ts')],
];

export async function GET(): Promise<Response> {
  const out: Record<string, string> = { node: process.version };
  for (const [name, load] of tries) {
    try {
      await load();
      out[name] = 'ok';
    } catch (err) {
      out[name] = String((err as Error)?.stack ?? err).slice(0, 700);
    }
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
}
