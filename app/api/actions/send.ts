// Vercel function: the Safe Send Blink (Solana Action, https://solana.com/docs/advanced/actions) at
// /api/actions/send. GET describes the action (title, image, fields); POST builds the same SOL send the app
// makes (escrow, top-up for the recipient's claim fee, compute budget) for the wallet in the body to sign.
// public/actions.json maps the site's home page to it, so a link to safe-send.app unfurls as a Blink on X.
//   GET  /api/actions/send            recipient and amount fields
//   GET  /api/actions/send?to=<addr>  a "send to <addr>" Blink: only the amount field
//   POST /api/actions/send?to=<addr>&amount=<SOL>   body { account }  →  { transaction }

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { checkRecipientFees, escrowAddress, fetchConfig, newTransferId, sendSolIx, topUpIx } from '../../src/lib/safeSend.ts';
import { SimulationError, computeBudget } from '../../src/lib/fees.ts';

const MAINNET = process.env.VITE_CLUSTER === 'mainnet-beta';
const SITE = MAINNET ? 'https://www.safe-send.app' : 'https://devnet.safe-send.app';
// CAIP-2 ids of the network the action signs on
const CHAIN = MAINNET ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

// Minimum the sender keeps on top of amount and top-up: escrow rent (~0.0023 SOL) plus fees.
const SENDER_MARGIN_LAMPORTS = 3_000_000n;

export const HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding',
  'access-control-expose-headers': 'X-Action-Version, X-Blockchain-Ids',
  'x-action-version': '2.4',
  'x-blockchain-ids': CHAIN,
  'content-type': 'application/json',
};

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const refuse = (message: string) => reply(400, { message });

function connection(): Connection {
  const url = process.env.ACTIONS_RPC_URL
    ?? (MAINNET ? process.env.HELIUS_MAINNET_RPC_URL : process.env.VITE_HELIUS_DEVNET_RPC_URL)
    ?? (MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
  // Helius restricts the keys to our domains: present the requests as coming from the site.
  return new Connection(url, { commitment: 'confirmed', httpHeaders: { origin: SITE } });
}

// "1.5" → lamports; null if it is not a positive amount with at most 9 decimals.
export function parseSol(text: string | null): bigint | null {
  const match = /^\s*(\d+)(?:[.,](\d{0,9}))?\s*$/.exec(text ?? '');
  if (!match) return null;
  const lamports = BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0') || '0');
  return lamports > 0n ? lamports : null;
}

// A wallet that can claim: a valid address on the curve (program addresses cannot sign).
function wallet(text: string | null): PublicKey | null {
  try {
    const key = new PublicKey(text ?? '');
    return PublicKey.isOnCurve(key.toBytes()) ? key : null;
  } catch {
    return null;
  }
}

const short = (key: PublicKey) => `${key.toBase58().slice(0, 4)}…${key.toBase58().slice(-4)}`;

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: HEADERS });
}

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const to = wallet(url.searchParams.get('to'));
  const amount = { name: 'amount', label: 'Amount in SOL', type: 'number', required: true, min: 0.000001 };
  const base = `${url.origin}${url.pathname}`;
  return reply(200, {
    type: 'action',
    icon: `${url.origin}/blink.png`,
    title: to ? `Send SOL safely to ${short(to)}` : 'Safe Send',
    description: to
      ? `The SOL waits in an on-chain escrow until ${short(to)} claims it at safe-send.app. Until then you can cancel and get it all back.`
      : 'Send SOL that waits in an on-chain escrow until the right wallet claims it. Wrong address? Cancel and take it back.',
    label: 'Safe Send',
    links: {
      actions: [
        to
          ? { type: 'transaction', label: 'Safe Send', href: `${base}?to=${to.toBase58()}&amount={amount}`, parameters: [amount] }
          : {
            type: 'transaction',
            label: 'Safe Send',
            href: `${base}?to={to}&amount={amount}`,
            parameters: [{ name: 'to', label: 'Recipient wallet address', type: 'text', required: true }, amount],
          },
      ],
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let body: { account?: unknown };
  try {
    body = await request.json();
  } catch {
    return refuse('Invalid request body');
  }
  let sender: PublicKey;
  try {
    sender = new PublicKey(String(body.account ?? ''));
  } catch {
    return refuse('Invalid account');
  }
  const recipient = wallet(url.searchParams.get('to'));
  if (!recipient) return refuse('Enter a valid Solana wallet address for the recipient.');
  if (recipient.equals(sender)) return refuse("That's your own wallet.");
  const lamports = parseSol(url.searchParams.get('amount'));
  if (lamports === null) return refuse('Enter an amount greater than zero, like 0.5.');

  const rpc = connection();
  try {
    const [config, check, balance, { blockhash }] = await Promise.all([
      fetchConfig(rpc),
      checkRecipientFees(rpc, recipient),
      rpc.getBalance(sender),
      rpc.getLatestBlockhash(),
    ]);
    const fee = (lamports * BigInt(config.feeBps)) / 10_000n + config.flatFeeLamports;
    if (BigInt(balance) < lamports + fee + BigInt(check.topUp) + SENDER_MARGIN_LAMPORTS) {
      return refuse('Not enough SOL for this amount plus the refundable deposit and fees.');
    }
    const id = newTransferId();
    const tx = new Transaction({ feePayer: sender, recentBlockhash: blockhash });
    if (check.topUp) tx.add(topUpIx(sender, recipient, check.topUp));
    tx.add(sendSolIx({ sender, recipient, id, lamports, config }));
    tx.instructions.unshift(...(await computeBudget(rpc, tx.instructions, sender)).instructions);

    const link = `${SITE}/?transfer=${escrowAddress(sender, id).toBase58()}`;
    return reply(200, {
      type: 'transaction',
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      message: `Locked in escrow until ${short(recipient)} claims it at safe-send.app.`,
      links: {
        next: {
          type: 'inline',
          action: {
            type: 'completed',
            icon: `${url.origin}/blink.png`,
            title: 'Sent safely',
            description: `Share this link with the recipient so they can claim it: ${link} — until they do, you can cancel from the Pending tab at safe-send.app.`,
            label: 'Sent',
          },
        },
      },
    });
  } catch (err) {
    if (err instanceof SimulationError) return refuse('This transfer would fail on-chain. Check the amount and your balance.');
    return reply(502, { message: 'Solana did not answer. Try again in a moment.' });
  }
}
