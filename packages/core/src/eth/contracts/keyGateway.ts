import { HubAsyncResult, HubError } from "../../errors";
import { ResultAsync } from "neverthrow";
import { verifyTypedData, bytesToHex } from "viem";

export type KeyGatewayAddMessage = {
  owner: `0x${string}`;
  keyType: number;
  key: Uint8Array;
  metadataType: number;
  metadata: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
};

export const KEY_GATEWAY_ADDRESS = "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B" as const;

export const KEY_GATEWAY_EIP_712_DOMAIN = {
  name: "Farcaster KeyGateway",
  version: "1",
  chainId: 10,
  verifyingContract: KEY_GATEWAY_ADDRESS,
} as const;

export const KEY_GATEWAY_ADD_TYPE = [
  { name: "owner", type: "address" },
  { name: "keyType", type: "uint32" },
  { name: "key", type: "bytes" },
  { name: "metadataType", type: "uint8" },
  { name: "metadata", type: "bytes" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

export const verifyAdd = async (
  message: KeyGatewayAddMessage,
  signature: Uint8Array,
  address: Uint8Array,
): HubAsyncResult<boolean> => {
  const valid = await ResultAsync.fromPromise(
    verifyTypedData({
      address: bytesToHex(address),
      domain: KEY_GATEWAY_EIP_712_DOMAIN,
      types: { Add: KEY_GATEWAY_ADD_TYPE },
      primaryType: "Add",
      message: { ...message, key: bytesToHex(message.key) },
      signature,
    }),
    (e) => new HubError("unknown", e as Error),
  );

  return valid;
};
