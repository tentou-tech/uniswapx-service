export enum ChainId {
  MAINNET = 1,
  UNICHAIN = 130,
  BASE = 8453,
  OPTIMISM = 10,
  ARBITRUM_ONE = 42161,
  POLYGON = 137,
  SEPOLIA = 11155111,
  GÖRLI = 5,
  STORY_AENEID = 1315,
  STORY = 1514
}

// If you update SUPPORTED_CHAINS, ensure you add a corresponding RPC_${chainId} environment variable.
// lib/config.py will require it to be defined.
export const SUPPORTED_CHAINS = [
  ChainId.STORY_AENEID,
  ChainId.STORY,
]
