import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

export const RPC_URL = process.env.RECOURSE_RPC ?? "http://127.0.0.1:8545";

export const anvilLocal = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

/** Anvil's deterministic development keys. Local only. */
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  upstream: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  rogue: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  timestampAuthority: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const;

export const accounts = {
  deployer: privateKeyToAccount(KEYS.deployer),
  buyer: privateKeyToAccount(KEYS.buyer),
  seller: privateKeyToAccount(KEYS.seller),
  /** The upstream source of record. It attests to record generation times. */
  upstream: privateKeyToAccount(KEYS.upstream),
  rogue: privateKeyToAccount(KEYS.rogue),
  /** An independent, honest timestamping service. It signs files, not records. */
  timestampAuthority: privateKeyToAccount(KEYS.timestampAuthority),
};

export const publicClient = createPublicClient({ chain: anvilLocal, transport: http(RPC_URL) });

export const walletFor = (account: (typeof accounts)[keyof typeof accounts]) =>
  createWalletClient({ account, chain: anvilLocal, transport: http(RPC_URL) });

type Artifact = { abi: Abi; bytecode: { object: Hex } };

function artifact(file: string, name: string): Artifact {
  return JSON.parse(readFileSync(join(REPO, "out", file, `${name}.json`), "utf8")) as Artifact;
}

export const escrowArtifact = () => artifact("RecourseEscrow.sol", "RecourseEscrow");
export const usdcArtifact = () => artifact("MockUSDC.sol", "MockUSDC");

export async function deploy(name: "RecourseEscrow" | "MockUSDC"): Promise<Address> {
  const a = name === "RecourseEscrow" ? escrowArtifact() : usdcArtifact();
  const wallet = walletFor(accounts.deployer);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploy failed: ${name}`);
  return receipt.contractAddress;
}

export async function chainNow(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

/** Anvil time travel. The challenge window is seconds here; the state transition stays. */
export async function advanceTime(seconds: number): Promise<void> {
  await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [seconds] }),
  });
  await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }),
  });
}
