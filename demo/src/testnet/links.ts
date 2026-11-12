/** Where to look at a transaction or an account. Only the public testnet has an explorer worth linking. */
export interface Explorer {
  tx(hash: string): string | undefined;
  account(id: string): string | undefined;
}

const NONE: Explorer = { tx: () => undefined, account: () => undefined };

export function explorerFor(networkId: string): Explorer {
  if (networkId !== "testnet") return NONE;
  return {
    tx: (hash) => `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`,
    account: (id) => `https://testnet.nearblocks.io/address/${encodeURIComponent(id)}`,
  };
}
