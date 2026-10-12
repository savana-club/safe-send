// Tests of the Blink (api/actions/send.ts) against the local validator: the action's metadata, the checks on
// its inputs, and a transaction it builds, signed and sent like a wallet would.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import { CONFIG_ADDRESS, incomingTransfers } from '../src/lib/safeSend.ts';
import { ensureConfig } from './helpers/config.ts';

const RPC = process.env.TEST_RPC ?? 'http://127.0.0.1:8899';
const connection = new Connection(RPC, 'confirmed');
const BASE = 'https://www.safe-send.app/api/actions/send';

let action: typeof import('../api/actions/send.ts');
before(async () => {
  process.env.ACTIONS_RPC_URL = RPC;
  action = await import('../api/actions/send.ts');
  await ensureConfig(connection);
});

async function funded(sol: number): Promise<Keypair> {
  const kp = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

const post = (query: string, account: unknown) =>
  action.POST(new Request(`${BASE}?${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account }) }));

test('describes the action, with CORS and Actions headers', async () => {
  const response = action.GET(new Request(BASE));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('x-action-version'), '2.4');
  assert.match(response.headers.get('x-blockchain-ids')!, /^solana:/);
  const body = await response.json();
  assert.equal(body.type, 'action');
  assert.equal(body.icon, 'https://www.safe-send.app/blink.png');
  const [send] = body.links.actions;
  assert.deepEqual(send.parameters.map((p: { name: string }) => p.name), ['to', 'amount']);
  assert.equal(send.href, `${BASE}?to={to}&amount={amount}`);
  assert.equal(action.OPTIONS().status, 204);
});

test('a "send to" link asks only for the amount', async () => {
  const to = Keypair.generate().publicKey.toBase58();
  const body = await action.GET(new Request(`${BASE}?to=${to}`)).json();
  const [send] = body.links.actions;
  assert.deepEqual(send.parameters.map((p: { name: string }) => p.name), ['amount']);
  assert.equal(send.href, `${BASE}?to=${to}&amount={amount}`);
  assert.match(body.title, new RegExp(to.slice(0, 4)));
});

test('parses SOL amounts', () => {
  assert.equal(action.parseSol('1.5'), 1_500_000_000n);
  assert.equal(action.parseSol('0,000000001'), 1n);
  for (const bad of ['0', '', '-1', '1.0000000001', 'abc', null]) assert.equal(action.parseSol(bad), null, String(bad));
});

test('refuses bad inputs with a message', async () => {
  const sender = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  const cases: [string, unknown, RegExp][] = [
    [`to=${recipient}&amount=1`, 'not-a-key', /Invalid account/],
    [`to=nope&amount=1`, sender, /valid Solana wallet/],
    // a PDA (off the curve, here the fee Config) could never sign the claim
    [`to=${CONFIG_ADDRESS.toBase58()}&amount=1`, sender, /valid Solana wallet/],
    [`to=${sender}&amount=1`, sender, /own wallet/],
    [`to=${recipient}&amount=0`, sender, /greater than zero/],
    [`to=${recipient}&amount=1`, sender, /Not enough SOL/], // the sender has no SOL
  ];
  for (const [query, account, message] of cases) {
    const response = await post(query, account);
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).message, message, query);
  }
});

test('builds a send that a wallet can sign: escrow plus top-up for an empty recipient', async () => {
  const sender = await funded(5);
  const recipient = Keypair.generate().publicKey;
  const response = await post(`to=${recipient.toBase58()}&amount=0.25`, sender.publicKey.toBase58());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, 'transaction');
  assert.equal(body.links.next.action.type, 'completed');
  assert.match(body.links.next.action.description, /\?transfer=/);

  const tx = Transaction.from(Buffer.from(body.transaction, 'base64'));
  assert.ok(tx.feePayer!.equals(sender.publicKey));
  tx.sign(sender);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature, 'confirmed');

  const [transfer] = await incomingTransfers(connection, recipient);
  assert.equal(transfer.amount, 250_000_000n);
  assert.ok(transfer.sender.equals(sender.publicKey));
  // the recipient was topped up so they can pay the claim
  assert.ok((await connection.getBalance(recipient)) > 0);
});
