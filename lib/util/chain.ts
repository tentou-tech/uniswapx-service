export enum ChainId {
  STORY_AENEID = 1315,
  STORY = 1514
}

// If you update SUPPORTED_CHAINS, ensure you add a corresponding RPC_${chainId} environment variable.
// lib/config.py will require it to be defined.
export const SUPPORTED_CHAINS = [
  ChainId.STORY_AENEID,
  ChainId.STORY,
]
