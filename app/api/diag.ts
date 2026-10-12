// TEMPORARY: reports why the Blink's modules fail to load on Vercel. Removed after the fix.
export async function GET(): Promise<Response> {
  const out: Record<string, string> = { node: process.version };
  for (const spec of ['@solana/web3.js', '@solana/spl-token', '@noble/hashes/sha256', '../src/lib/safeSend.ts', '../src/lib/fees.ts', './actions/send.ts']) {
    try {
      await import(spec);
      out[spec] = 'ok';
    } catch (err) {
      out[spec] = String((err as Error)?.stack ?? err).slice(0, 600);
    }
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
}
