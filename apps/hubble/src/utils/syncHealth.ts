import {
  Metadata,
  getInsecureHubRpcClient,
  getSSLHubRpcClient,
  toFarcasterTime,
  TrieNodePrefix,
  HubResult,
  HubRpcClient,
  TrieNodeMetadataResponse,
  Message,
  HubError,
  getAuthMetadata,
  bytesToHexString,
  SyncIds,
  MessagesResponse,
  MessageType,
} from "@farcaster/hub-nodejs";

import { appendFile } from "fs/promises";

import { addressInfoFromGossip, addressInfoToString } from "./p2p.js";

import { SyncId, timestampToPaddedTimestampPrefix } from "../network/sync/syncId.js";
import { err, ok, Result } from "neverthrow";
import { MAX_VALUES_RETURNED_PER_SYNC_ID_REQUEST, toTrieNodeMetadataResponse } from "../rpc/server.js";
import SyncEngine from "../network/sync/syncEngine.js";
import { HubInterface } from "hubble.js";

export type SubmitError = { hubError: HubError; originalMessage: Message };
class SyncHealthMessageStats {
  primaryNumMessages: number;
  peerNumMessages: number;

  constructor(primaryNumMessages: number, peerNumMessages: number) {
    this.primaryNumMessages = primaryNumMessages;
    this.peerNumMessages = peerNumMessages;
  }

  computeDiff = () => {
    return Math.abs(this.primaryNumMessages - this.peerNumMessages);
  };

  computeDiffPercentage = () => {
    return this.computeDiff() / this.primaryNumMessages;
  };
}

class Stats {
  syncHealthMessageStats: SyncHealthMessageStats;
  resultsUploadingToPeer: Result<Message, SubmitError>[];
  resultsUploadingToPrimary: Result<Message, SubmitError>[];
  primary: string;
  peer: string;
  startTime: Date;
  stopTime: Date;

  constructor(
    startTime: Date,
    stopTime: Date,
    primary: string,
    peer: string,
    syncHealthMessageStats: SyncHealthMessageStats,
    resultsUploadingToPeer: Result<Message, SubmitError>[],
    resultsUploadingToPrimary: Result<Message, SubmitError>[],
  ) {
    this.startTime = startTime;
    this.stopTime = stopTime;
    this.primary = primary;
    this.peer = peer;
    this.syncHealthMessageStats = syncHealthMessageStats;
    this.resultsUploadingToPeer = resultsUploadingToPeer;
    this.resultsUploadingToPrimary = resultsUploadingToPrimary;
  }

  results = (who: "Primary" | "Peer") => {
    if (who === "Primary") {
      return this.resultsUploadingToPrimary;
    }
    return this.resultsUploadingToPeer;
  };

  errorResults = (who: "Primary" | "Peer") => {
    return this.results(who).filter((result) => {
      return result.isErr();
    });
  };

  errorReasons = (who: "Primary" | "Peer") => {
    const errorReasons = new Set();
    for (const error of this.errorResults(who)) {
      if (error.isErr()) {
        errorReasons.add(error.error.hubError.message);
      }
    }
    return [...errorReasons];
  };

  successResults = (who: "Primary" | "Peer") => {
    return this.results(who).filter((result) => {
      return result.isOk();
    });
  };

  successTypes = (who: "Primary" | "Peer") => {
    const successTypes = new Set();
    for (const success of this.successResults(who)) {
      if (success.isOk()) {
        const hashString = bytesToHexString(success.value.hash);
        const hash = hashString.isOk() ? hashString.value : "unknown hash";
        const typeValue = success.value.data?.type;
        const type = typeValue ? MessageType[typeValue] : "unknown type";
        successTypes.add({ type, hash, fid: success.value.data?.fid });
      }
    }
    return [...successTypes];
  };

  serializedSummary = () => {
    return JSON.stringify({
      startTime: this.startTime,
      stopTime: this.stopTime,
      primary: this.primary,
      peer: this.peer,
      primaryMessageCount: this.syncHealthMessageStats.primaryNumMessages,
      peerMessageCount: this.syncHealthMessageStats.peerNumMessages,
      diff: this.syncHealthMessageStats.computeDiff(),
      diffPercentage: this.syncHealthMessageStats.computeDiffPercentage(),
      numSuccessToPeer: this.successResults("Peer").length,
      numErrorToPeer: this.errorResults("Peer").length,
      successTypesToPeer: this.successTypes("Peer"),
      errorMessagesToPeer: this.errorReasons("Peer"),
      numSuccessToPrimary: this.successResults("Primary").length,
      numErrorToPrimary: this.errorResults("Primary").length,
      successTypesToPrimary: this.successTypes("Primary"),
      errorMessagesToPrimary: this.errorReasons("Primary"),
    });
  };
}
interface MetadataRetriever {
  getMetadata: (prefix: Buffer) => Promise<HubResult<TrieNodeMetadataResponse>>;
  getAllSyncIdsByPrefix: (prefix: Buffer) => Promise<HubResult<SyncIds>>;
  getAllMessagesBySyncIds: (syncIds: Uint8Array[]) => Promise<HubResult<MessagesResponse>>;
  submitMessage: (message: Message) => Promise<HubResult<Message>>;
}

export class RpcMetadataRetriever implements MetadataRetriever {
  _rpcClient: HubRpcClient;
  _authMetadata?: Metadata;

  constructor(rpcClient: HubRpcClient, username?: string, password?: string) {
    this._rpcClient = rpcClient;
    if (username && password) {
      this._authMetadata = getAuthMetadata(username, password);
    }
  }

  getMetadata = async (prefix: Buffer): Promise<HubResult<TrieNodeMetadataResponse>> => {
    return this._rpcClient.getSyncMetadataByPrefix(TrieNodePrefix.create({ prefix }), new Metadata(), {
      deadline: Date.now() + RPC_TIMEOUT_SECONDS * 1000,
    });
  };

  submitMessage = async (message: Message): Promise<HubResult<Message>> => {
    if (this._authMetadata) {
      return this._rpcClient.submitMessage(message, this._authMetadata);
    } else {
      return this._rpcClient.submitMessage(message);
    }
  };

  getAllSyncIdsByPrefix = async (prefix: Buffer) => {
    return this._rpcClient.getAllSyncIdsByPrefix(TrieNodePrefix.create({ prefix }));
  };

  getAllMessagesBySyncIds = async (syncIds: Uint8Array[]) => {
    return this._rpcClient.getAllMessagesBySyncIds(SyncIds.create({ syncIds }));
  };
}

export class SyncEngineMetadataRetriever implements MetadataRetriever {
  _syncEngine: SyncEngine;
  _hub: HubInterface;

  constructor(hub: HubInterface, syncEngine: SyncEngine) {
    this._syncEngine = syncEngine;
    this._hub = hub;
  }

  getMetadata = async (prefix: Buffer): Promise<HubResult<TrieNodeMetadataResponse>> => {
    const result = await this._syncEngine.getTrieNodeMetadata(prefix);
    if (result) {
      return ok(toTrieNodeMetadataResponse(result));
    }

    // This can happen if there are no messages under the prefix for this node. We may want to return an empty result rather than an error.
    return err(new HubError("unavailable", "Missing metadata for node"));
  };

  getAllSyncIdsByPrefix = async (prefix: Buffer) => {
    const result = await this._syncEngine.getAllSyncIdsByPrefix(prefix);
    return ok(SyncIds.create({ syncIds: result }));
  };

  submitMessage = async (message: Message) => {
    return (await this._hub.submitMessage(message, "sync-health")).map(() => {
      return message;
    });
  };

  getAllMessagesBySyncIds = async (syncIds: Uint8Array[]) => {
    const syncIdsParsed = syncIds.map((syncId) => SyncId.fromBytes(syncId));
    const messagesResult = await this._syncEngine.getAllMessagesBySyncIds(syncIdsParsed);
    if (messagesResult.isErr()) {
      return err(messagesResult.error);
    }

    const filteredMessages = messagesResult.value.filter(
      (message) => message.data !== undefined && message.hash.length > 0,
    );

    return ok(MessagesResponse.create({ messages: filteredMessages }));
  };
}

const RPC_TIMEOUT_SECONDS = 2;

const getTimePrefix = (date: Date) => {
  const unixTime = date.getTime();
  return toFarcasterTime(unixTime).map((farcasterTime) => {
    return Buffer.from(timestampToPaddedTimestampPrefix(farcasterTime));
  });
};

const getCommonPrefix = (prefix1: Buffer, prefix2: Buffer): Buffer => {
  const commonPrefix = [];
  for (let i = 0; i < Math.min(prefix1.length, prefix2.length); i++) {
    const startValue = prefix1[i];
    const stopValue = prefix2[i];
    if (startValue !== undefined && startValue === stopValue) {
      commonPrefix.push(startValue);
    } else {
      break;
    }
  }
  return Buffer.from(commonPrefix);
};

const isPrefix = (prefix1: Buffer, prefix2: Buffer): boolean => {
  return prefix1.toString().startsWith(prefix2.toString());
};

const traverseRange = async (
  node: TrieNodeMetadataResponse,
  startTimePrefix: Buffer,
  stopTimePrefix: Buffer,
  metadataRetriever: MetadataRetriever,
  onTrieNode: (node: TrieNodeMetadataResponse) => undefined,
) => {
  const metadata = await metadataRetriever.getMetadata(Buffer.from(node.prefix));

  if (metadata.isErr()) {
    return err(metadata.error);
  }

  for (const child of metadata.value.children) {
    const childValue = Buffer.from(child.prefix);
    if (Buffer.compare(childValue, startTimePrefix) === 0) {
      // If the child is equal to the start time prefix, it means that everything under it is after the start time. Present this node to the caller and don't continue recursing.
      onTrieNode(child);
    } else if (isPrefix(startTimePrefix, childValue) || isPrefix(stopTimePrefix, childValue)) {
      // If the child is along the start time prefix or along the stop time prefix, we need to continue recursing down the path. Some nodes under this one will be included in the query, but not all.
      await traverseRange(child, startTimePrefix, stopTimePrefix, metadataRetriever, onTrieNode);
    } else if (Buffer.compare(childValue, startTimePrefix) === 1 && Buffer.compare(childValue, stopTimePrefix) === -1) {
      // If the child's prefix is greater than the start prefix or less than the stop prefix, all nodes under it will definitely be included. Present this node to the caller and don't continue recursing
      onTrieNode(child);
    }
  }

  return ok(undefined);
};

const getPrefixInfo = async (metadataRetriever: MetadataRetriever, startTime: Date, stopTime: Date) => {
  const startTimePrefix = getTimePrefix(startTime);
  if (startTimePrefix.isErr()) {
    return err(startTimePrefix.error);
  }

  const stopTimePrefix = getTimePrefix(stopTime);

  if (stopTimePrefix.isErr()) {
    return err(stopTimePrefix.error);
  }

  const commonPrefix = getCommonPrefix(startTimePrefix.value, stopTimePrefix.value);

  const commonPrefixMetadata = await metadataRetriever.getMetadata(Buffer.from(commonPrefix));

  if (commonPrefixMetadata.isErr()) {
    return err(commonPrefixMetadata.error);
  }

  return ok({
    startTimePrefix: startTimePrefix.value,
    stopTimePrefix: stopTimePrefix.value,
    commonPrefixMetadata: commonPrefixMetadata.value,
  });
};

// Queries for the number of messages between the start time and stop time and is efficient with respect to the number of rpcs to the peer. It only queries down along the start prefix and stop prefix starting at the common prefix.

const getNumMessagesInSpan = async (metadataRetriever: MetadataRetriever, startTime: Date, stopTime: Date) => {
  const prefixInfo = await getPrefixInfo(metadataRetriever, startTime, stopTime);

  if (prefixInfo.isErr()) {
    return err(prefixInfo.error);
  }

  let numMessages = 0;
  const result = await traverseRange(
    prefixInfo.value.commonPrefixMetadata,
    prefixInfo.value.startTimePrefix,
    prefixInfo.value.stopTimePrefix,
    metadataRetriever,
    (node: TrieNodeMetadataResponse) => {
      numMessages += node.numMessages;
    },
  );

  if (result.isErr()) {
    return err(result.error);
  }

  return ok(numMessages);
};

const pickPeers = async (rpcClient: HubRpcClient, count: number) => {
  const peers = await rpcClient.getCurrentPeers({});
  return peers.map((peers) => {
    // Shuffle peers then pick [count]
    return peers.contacts
      .map((value) => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
      .slice(0, count)
      .map((peer) => {
        if (peer.rpcAddress) {
          const addrInfo = addressInfoFromGossip(peer.rpcAddress);
          if (addrInfo.isOk()) {
            return { hostAndPort: addressInfoToString(addrInfo.value), username: undefined, password: undefined };
          }
        }
        return;
      });
  });
};

const computeSyncIdsUnderPrefix = async (
  metadataRetriever: MetadataRetriever,
  prefix: Uint8Array,
  maxValuesReturnedPerSyncIdRequest: number,
): Promise<HubResult<Uint8Array[]>> => {
  const metadata = await metadataRetriever.getMetadata(Buffer.from(prefix));

  if (metadata.isErr()) {
    return err(metadata.error);
  }

  // We need to do this weird hack because the length of the results of [getAllSyncIdsByPrefix] is capped at 1024.
  if (metadata.value.numMessages <= maxValuesReturnedPerSyncIdRequest) {
    const syncIds = await metadataRetriever.getAllSyncIdsByPrefix(Buffer.from(prefix));

    if (syncIds.isErr()) {
      return err(syncIds.error);
    }

    return ok(syncIds.value.syncIds);
  } else {
    const computedSyncIds = [];

    for (const child of metadata.value.children) {
      const childSyncIds = await computeSyncIdsUnderPrefix(
        metadataRetriever,
        child.prefix,
        maxValuesReturnedPerSyncIdRequest,
      );

      if (childSyncIds.isErr()) {
        return err(childSyncIds.error);
      }

      computedSyncIds.push(...childSyncIds.value);
    }

    return ok(computedSyncIds);
  }
};

const computeSyncIdsInSpan = async (
  metadataRetriever: MetadataRetriever,
  startTime: Date,
  stopTime: Date,
  maxValuesReturnedPerSyncIdRequest: number,
) => {
  const prefixInfo = await getPrefixInfo(metadataRetriever, startTime, stopTime);

  if (prefixInfo.isErr()) {
    return err(prefixInfo.error);
  }

  const prefixes: Uint8Array[] = [];
  const result = await traverseRange(
    prefixInfo.value.commonPrefixMetadata,
    prefixInfo.value.startTimePrefix,
    prefixInfo.value.stopTimePrefix,
    metadataRetriever,
    (node: TrieNodeMetadataResponse) => {
      prefixes.push(node.prefix);
    },
  );

  if (result.isErr()) {
    return err(result.error);
  }

  const syncIds = [];
  for (const prefix of prefixes) {
    const prefixSyncIds = await computeSyncIdsUnderPrefix(metadataRetriever, prefix, maxValuesReturnedPerSyncIdRequest);
    if (prefixSyncIds.isOk()) {
      syncIds.push(...prefixSyncIds.value);
    }
  }

  return ok(syncIds);
};

const uniqueSyncIds = (mySyncIds: Uint8Array[], otherSyncIds: Uint8Array[]) => {
  const idsOnlyInPrimary = [];

  const otherSyncIdSet = new Set();

  for (const syncId of otherSyncIds) {
    const stringSyncId = bytesToHexString(syncId);
    if (stringSyncId.isOk()) {
      otherSyncIdSet.add(stringSyncId.value);
    }
  }

  for (const syncId of mySyncIds) {
    const stringSyncId = bytesToHexString(syncId);
    if (stringSyncId.isOk() && !otherSyncIdSet.has(stringSyncId.value)) {
      const syncIdBuffer = Buffer.from(syncId);
      idsOnlyInPrimary.push(syncIdBuffer);
    }
  }

  return idsOnlyInPrimary;
};

export class SyncHealthProbe {
  _primaryMetadataRetriever: MetadataRetriever;
  _peerMetadataRetriever: MetadataRetriever;
  _maxValuesReturnedPerSyncIdRequest: number = MAX_VALUES_RETURNED_PER_SYNC_ID_REQUEST;

  constructor(
    primaryMetadataRetriever: MetadataRetriever,
    peerMetadataRetriever: MetadataRetriever,
    maxValuesReturnedPerSyncIdRequest?: number,
  ) {
    this._primaryMetadataRetriever = primaryMetadataRetriever;
    this._peerMetadataRetriever = peerMetadataRetriever;
    if (maxValuesReturnedPerSyncIdRequest) {
      this._maxValuesReturnedPerSyncIdRequest = maxValuesReturnedPerSyncIdRequest;
    }
  }

  computeSyncHealthMessageStats = async (startTime: Date, stopTime: Date) => {
    const numMessagesPrimary = await getNumMessagesInSpan(this._primaryMetadataRetriever, startTime, stopTime);
    const numMessagesPeer = await getNumMessagesInSpan(this._peerMetadataRetriever, startTime, stopTime);

    if (numMessagesPrimary.isErr()) {
      return err(numMessagesPrimary.error);
    }

    if (numMessagesPeer.isErr()) {
      return err(numMessagesPeer.error);
    }

    return ok(new SyncHealthMessageStats(numMessagesPrimary.value, numMessagesPeer.value));
  };

  tryPushingMissingMessages = async (
    metadataRetrieverWithMessages: MetadataRetriever,
    metadataRetrieverMissingMessages: MetadataRetriever,
    missingSyncIds: Buffer[],
  ) => {
    if (missingSyncIds.length === 0) {
      return ok([]);
    }

    const allMessages = [];
    for (let i = 0; i < missingSyncIds.length; i += this._maxValuesReturnedPerSyncIdRequest) {
      const messages = await metadataRetrieverWithMessages.getAllMessagesBySyncIds(
        missingSyncIds.slice(i, i + this._maxValuesReturnedPerSyncIdRequest),
      );

      if (messages.isErr()) {
        return err(messages.error);
      }

      allMessages.push(...messages.value.messages);
    }

    const results = [];
    for (const message of allMessages) {
      const result = await metadataRetrieverMissingMessages.submitMessage(message);
      const augmentedResult = result.mapErr((err) => {
        return { hubError: err, originalMessage: message };
      });
      results.push(augmentedResult);
    }

    return ok(results);
  };

  divergingSyncIds = async (startTime: Date, stopTime: Date) => {
    const primarySyncIds = await computeSyncIdsInSpan(
      this._primaryMetadataRetriever,
      startTime,
      stopTime,
      this._maxValuesReturnedPerSyncIdRequest,
    );

    if (primarySyncIds.isErr()) {
      return err(primarySyncIds.error);
    }

    const peerSyncIds = await computeSyncIdsInSpan(
      this._peerMetadataRetriever,
      startTime,
      stopTime,
      this._maxValuesReturnedPerSyncIdRequest,
    );

    if (peerSyncIds.isErr()) {
      return err(peerSyncIds.error);
    }

    const idsOnlyInPrimary = uniqueSyncIds(primarySyncIds.value, peerSyncIds.value);
    const idsOnlyInPeer = uniqueSyncIds(peerSyncIds.value, primarySyncIds.value);
    return ok({ idsOnlyInPrimary, idsOnlyInPeer });
  };

  tryPushingDivergingSyncIds = async (startTime: Date, stopTime: Date, direction: "FromPeer" | "ToPeer") => {
    const syncIdsToRetry = await this.divergingSyncIds(startTime, stopTime);

    if (syncIdsToRetry.isErr()) {
      return err(syncIdsToRetry.error);
    }

    const { idsOnlyInPrimary, idsOnlyInPeer } = syncIdsToRetry.value;

    if (direction === "ToPeer") {
      return await this.tryPushingMissingMessages(
        this._primaryMetadataRetriever,
        this._peerMetadataRetriever,
        idsOnlyInPrimary,
      );
    } else if (direction === "FromPeer") {
      return await this.tryPushingMissingMessages(
        this._peerMetadataRetriever,
        this._primaryMetadataRetriever,
        idsOnlyInPeer,
      );
    } else {
      return err(new HubError("unavailable", "invalid codepath"));
    }
  };
}

const parseTime = (timeString: string) => {
  // Use current date with specified times. Time must be in HH:MM:SS format
  const date = new Date();
  const [hours, minutes, seconds] = timeString.split(":");
  if (hours && minutes && seconds) {
    date.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds), 0);
    return date;
  }
  return;
};

const parsePeers = (peers: string[]) => {
  const parsedPeers = [];

  for (const peer of peers) {
    const [hostAndPort, auth] = peer.split("?");

    if (!hostAndPort) {
      return err(
        new Error(`Host and port missing ${peer}. Input must be in format <host>:<port>?<username>:<password>`),
      );
    }

    if (auth === undefined) {
      parsedPeers.push({ hostAndPort, username: undefined, password: undefined });
      continue;
    }

    const [username, password] = auth.split(":");
    parsedPeers.push({ hostAndPort, username, password });
  }

  return ok(parsedPeers);
};

export const printSyncHealth = async (
  startTimeOfDay: string,
  stopTimeOfDay: string,
  maxNumPeers: number,
  primaryNode: string,
  useSecureClientForPeers: boolean,
  outfile?: string,
  userSpecifiedPeers?: string[],
  username?: string,
  password?: string,
) => {
  const startTime = parseTime(startTimeOfDay);
  const stopTime = parseTime(stopTimeOfDay);

  if (startTime === undefined || stopTime === undefined) {
    console.log("Unable to parse time, must specify as HH:MM:SS");
    return;
  }

  console.log("Start time", startTime, "Stop time", stopTimeOfDay, stopTime);

  const primaryRpcClient = getSSLHubRpcClient(primaryNode);

  primaryRpcClient.$.waitForReady(Date.now() + RPC_TIMEOUT_SECONDS * 1000, async (err) => {
    if (err) {
      console.log("Primary rpc client not ready", err);
      throw Error();
    }

    const parsedUserSpecifiedPeers = userSpecifiedPeers ? parsePeers(userSpecifiedPeers)._unsafeUnwrap() : undefined;

    const peers = parsedUserSpecifiedPeers
      ? ok(parsedUserSpecifiedPeers)
      : await pickPeers(primaryRpcClient, maxNumPeers);

    if (peers.isErr()) {
      console.log("Error querying peers");
      return;
    }

    const primaryRpcMetadataRetriever = new RpcMetadataRetriever(primaryRpcClient, username, password);

    for (const peer of peers.value) {
      if (peer === undefined) {
        continue;
      }
      let peerRpcClient;

      try {
        // Most hubs seem to work with the insecure one
        if (useSecureClientForPeers) {
          peerRpcClient = getSSLHubRpcClient(peer.hostAndPort);
        } else {
          peerRpcClient = getInsecureHubRpcClient(peer.hostAndPort);
        }

        peerRpcClient.$.waitForReady(Date.now() + RPC_TIMEOUT_SECONDS * 1000, (err) => {
          if (err) {
            peerRpcClient = getSSLHubRpcClient(peer.hostAndPort);
          }
        });
      } catch (e) {
        peerRpcClient = getSSLHubRpcClient(peer.hostAndPort);
      }

      const peerRpcMetadataRetriever = new RpcMetadataRetriever(peerRpcClient, peer.username, peer.password);

      const syncHealthProbe = new SyncHealthProbe(primaryRpcMetadataRetriever, peerRpcMetadataRetriever);

      try {
        console.log("Connecting to peer", peer.hostAndPort);
        const syncHealthStats = await syncHealthProbe.computeSyncHealthMessageStats(startTime, stopTime);
        if (syncHealthStats.isOk()) {
          // Sync health is us relative to peer. If the sync health is high, means we have more messages. If it's low, we have less.
          const score = syncHealthStats.value.computeDiff();

          // Useful to see progress
          console.log("Computed sync health score", score);

          if (outfile) {
            let aggregateStats;
            if (score !== 0) {
              console.log("Investigating diff");
              const resultToPeer = await syncHealthProbe.tryPushingDivergingSyncIds(startTime, stopTime, "ToPeer");

              const resultFromPeer = await syncHealthProbe.tryPushingDivergingSyncIds(startTime, stopTime, "FromPeer");

              if (resultToPeer.isErr() || resultFromPeer.isErr()) {
                const resultToPeerSummary = resultToPeer.isOk() ? "ok" : resultToPeer.error;
                const resultFromPeerSummary = resultFromPeer.isOk() ? "ok" : resultFromPeer.error;

                console.log("Error investigating diff", resultToPeerSummary, resultFromPeerSummary);
                // Report the stats anyway, but with no investigation results
                aggregateStats = new Stats(
                  startTime,
                  stopTime,
                  primaryNode,
                  peer.hostAndPort,
                  syncHealthStats.value,
                  [],
                  [],
                );
              } else {
                aggregateStats = new Stats(
                  startTime,
                  stopTime,
                  primaryNode,
                  peer.hostAndPort,
                  syncHealthStats.value,
                  resultToPeer.value,
                  resultFromPeer.value,
                );
              }
            } else {
              // Report the stats anyway, but with no investigation results
              aggregateStats = new Stats(
                startTime,
                stopTime,
                primaryNode,
                peer.hostAndPort,
                syncHealthStats.value,
                [],
                [],
              );
            }

            // The data is valuable, let's just wait to write it. Note, data is appended to any existing file.
            await appendFile(outfile, aggregateStats.serializedSummary());
          }
        } else {
          console.log("Error computing sync health stats", syncHealthStats.error);
        }
        peerRpcClient.close();
      } catch (err) {
        console.log("Raised while computing sync health", err);
      }
    }

    primaryRpcClient.close();
  });
};
