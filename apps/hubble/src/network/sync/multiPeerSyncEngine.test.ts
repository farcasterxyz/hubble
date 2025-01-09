import { jest } from "@jest/globals";
import {
  Factories,
  getInsecureHubRpcClient,
  HubRpcClient,
  FarcasterNetwork,
  Message,
  TrieNodePrefix,
  HubInfoRequest,
  getFarcasterTime,
  OnChainEvent,
  UserNameProof,
  MessageData,
  fromFarcasterTime,
} from "@farcaster/hub-nodejs";
import { APP_NICKNAME, APP_VERSION, HubInterface } from "../../hubble.js";
import SyncEngine, { FailoverStreamSyncClient } from "./syncEngine.js";
import { SyncId } from "./syncId.js";
import Server from "../../rpc/server.js";
import { jestRocksDB } from "../../storage/db/jestUtils.js";
import Engine from "../../storage/engine/index.js";
import { MockHub } from "../../test/mocks.js";
import { sleep, sleepWhile } from "../../utils/crypto.js";
import { ensureMessageData } from "../../storage/db/message.js";
import { EMPTY_HASH } from "./merkleTrie.js";
import { SyncEngineMetadataRetriever, SyncHealthProbe } from "../../utils/syncHealth.js";

const TEST_TIMEOUT_SHORT = 10 * 1000;
const TEST_TIMEOUT_LONG = 60 * 1000;
const SLEEPWHILE_TIMEOUT = 10 * 1000;

const testDb1 = jestRocksDB("engine1.peersyncEngine.test");
const testDb2 = jestRocksDB("engine2.peersyncEngine.test");

const network = FarcasterNetwork.TESTNET;

const fid = Factories.Fid.build();
const signer = Factories.Ed25519Signer.build();
const custodySigner = Factories.Eip712Signer.build();

let custodyEvent: OnChainEvent;
let signerEvent: OnChainEvent;
let storageEvent: OnChainEvent;
let castAdd: Message;
let fname: UserNameProof;

const eventsByBlock = new Map<number, OnChainEvent>();
// biome-ignore lint/suspicious/noExplicitAny: mock used only in tests
const l2EventsProvider = jest.fn() as any;
l2EventsProvider.retryEventsFromBlock = jest.fn();
const retryEventsMock = l2EventsProvider.retryEventsFromBlock;

// biome-ignore lint/suspicious/noExplicitAny: mock used only in tests
const fnameEventsProvider = jest.fn() as any;
fnameEventsProvider.retryTransferByName = jest.fn();
const retryTransferByName = fnameEventsProvider.retryTransferByName;

beforeAll(async () => {
  const custodySignerKey = (await custodySigner.getSignerKey())._unsafeUnwrap();
  const signerKey = (await signer.getSignerKey())._unsafeUnwrap();
  custodyEvent = Factories.IdRegistryOnChainEvent.build({ fid }, { transient: { to: custodySignerKey } });

  signerEvent = Factories.SignerOnChainEvent.build(
    { fid, blockNumber: custodyEvent.blockNumber + 1 },
    { transient: { signer: signerKey } },
  );
  storageEvent = Factories.StorageRentOnChainEvent.build({ fid, blockNumber: custodyEvent.blockNumber + 2 });
  castAdd = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });
  fname = Factories.UserNameProof.build({ fid });

  eventsByBlock.set(custodyEvent.blockNumber, custodyEvent);
  eventsByBlock.set(signerEvent.blockNumber, signerEvent);
  eventsByBlock.set(storageEvent.blockNumber, storageEvent);
});

describe("Multi peer sync engine with streams", () => {
  jest.setTimeout(TEST_TIMEOUT_LONG);
  const addMessagesWithTimeDelta = async (engine: Engine, timeDelta: number[], startFarcasterTime?: number) => {
    // Take care that the farcasterTime is not in the future
    const farcasterTime = startFarcasterTime ? startFarcasterTime : getFarcasterTime()._unsafeUnwrap() - 1000;

    return await Promise.all(
      timeDelta.map(async (t) => {
        const cast = await Factories.CastAddMessage.create(
          { data: { fid, network, timestamp: farcasterTime + t } },
          { transient: { signer } },
        );

        const result = await engine.mergeMessage(cast);
        if (result.isErr()) {
          throw result.error;
        }
        expect(result.isOk()).toBeTruthy();

        return cast;
      }),
    );
  };

  const removeMessagesWithTsHashes = async (engine: Engine, addMessages: Message[]) => {
    return await Promise.all(
      addMessages.map(async (addMessage) => {
        const castRemove = await Factories.CastRemoveMessage.create(
          {
            data: {
              fid,
              network,
              timestamp: addMessage.data?.timestamp ?? 0 + 10,
              castRemoveBody: { targetHash: addMessage.hash },
            },
          },
          { transient: { signer } },
        );

        const result = await engine.mergeMessage(castRemove);
        expect(result.isOk()).toBeTruthy();
        return Promise.resolve(castRemove);
      }),
    );
  };

  // Engine 1 is where we add events, and see if engine 2 will sync them
  let engine1: Engine;
  let hub1: HubInterface;
  let syncEngine1: SyncEngine;
  let server1: Server;
  let port1;
  let clientForServer1: FailoverStreamSyncClient;

  let engine2: Engine;
  let hub2: HubInterface;
  let syncEngine2: SyncEngine;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Engine 1 is where we add events, and see if engine 2 will sync them
    engine1 = new Engine(testDb1, network);
    hub1 = new MockHub(testDb1, engine1);
    syncEngine1 = new SyncEngine(hub1, testDb1, undefined, undefined, undefined, 0, true);
    await syncEngine1.start();
    await syncEngine1.trie.clear();

    server1 = new Server(hub1, engine1, syncEngine1);
    port1 = await server1.start();
    clientForServer1 = new FailoverStreamSyncClient(getInsecureHubRpcClient(`127.0.0.1:${port1}`), true);

    retryEventsMock.mockImplementation(async (blockNumber: number) => {
      const event = eventsByBlock.get(blockNumber);
      if (event) {
        return engine2.mergeOnChainEvent(event);
      } else {
        throw new Error(`Block ${blockNumber} not found`);
      }
    });
    retryTransferByName.mockImplementation(async (name: Uint8Array) => {
      expect(name).toEqual(fname.name);
      await engine2.mergeUserNameProof(fname);
    });
    engine2 = new Engine(testDb2, network);
    hub2 = new MockHub(testDb2, engine2);
    syncEngine2 = new SyncEngine(hub2, testDb2, l2EventsProvider, fnameEventsProvider, undefined, 0, true);
    await syncEngine2.start();
    await syncEngine2.trie.clear();
  }, TEST_TIMEOUT_SHORT);

  afterEach(async () => {
    // Cleanup
    clientForServer1.close();
    await server1.stop();
    await syncEngine1.stop();
    await engine1.stop();

    await syncEngine2.stop();
    await engine2.stop();
  }, TEST_TIMEOUT_SHORT);

  test("toBytes test", async () => {
    // Add signer custody event to engine 1
    expect((await engine1.mergeOnChainEvent(custodyEvent)).isOk()).toBe(true);
    expect((await engine1.mergeOnChainEvent(signerEvent)).isOk()).toBe(true);

    // Get info first
    const info = await clientForServer1.getInfo(HubInfoRequest.create());
    expect(info.isOk()).toBeTruthy();
    const infoResult = info._unsafeUnwrap();
    expect(infoResult.version).toEqual(APP_VERSION);
    expect(infoResult.nickname).toEqual(APP_NICKNAME);

    // Fetch the signerAdd message from engine 1
    const rpcResult = await clientForServer1.getOnChainSignersByFid({ fid });
    expect(rpcResult.isOk()).toBeTruthy();
    expect(rpcResult._unsafeUnwrap().events.length).toEqual(1);
    const rpcSignerAdd = rpcResult._unsafeUnwrap().events[0] as OnChainEvent;

    expect(OnChainEvent.toJSON(signerEvent)).toEqual(OnChainEvent.toJSON(rpcSignerAdd));
    expect(signerEvent.fid).toEqual(rpcSignerAdd.fid);

    // Create a new sync engine from the existing engine, and see if all the messages from the engine
    // are loaded into the sync engine Merkle Trie properly.
    const rootHash = await syncEngine1.trie.rootHash();
    await clientForServer1.close();
    await syncEngine1.stop();
    await server1.stop();
    const reinitSyncEngine = new SyncEngine(hub1, testDb1, undefined, undefined, undefined, undefined, true);
    await reinitSyncEngine.start();

    expect(await reinitSyncEngine.trie.rootHash()).toEqual(rootHash);

    await reinitSyncEngine.stop();
  });

  test(
    "two peers should sync",
    async () => {
      // Add signer custody event to engine 1
      await expect(engine1.mergeOnChainEvent(custodyEvent)).resolves.toBeDefined();
      await expect(engine1.mergeOnChainEvent(signerEvent)).resolves.toBeDefined();
      await expect(engine1.mergeOnChainEvent(storageEvent)).resolves.toBeDefined();
      await expect(engine1.mergeUserNameProof(fname)).resolves.toBeDefined();

      // Add messages to engine 1
      await addMessagesWithTimeDelta(engine1, [167, 169, 172]);
      await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      // Engine 2 should sync with engine1 (including onchain events and fnames)
      expect(
        (await syncEngine2.syncStatus("engine2", (await syncEngine1.getSnapshot())._unsafeUnwrap()))._unsafeUnwrap()
          .shouldSync,
      ).toBeTruthy();

      // Sync engine 2 with engine 1
      await syncEngine2.performSync("engine1", clientForServer1);

      // Make sure root hash matches
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

      // Should sync should now be false with the new excluded hashes
      expect(
        (await syncEngine2.syncStatus("engine1", (await syncEngine1.getSnapshot())._unsafeUnwrap()))._unsafeUnwrap()
          .shouldSync,
      ).toBeFalsy();

      // Add more messages
      await addMessagesWithTimeDelta(engine1, [367, 369, 372]);
      // Add a message with data_bytes to make sure it gets synced OK.
      const castAddClone = Message.decode(Message.encode(castAdd).finish());
      castAddClone.data = undefined;
      castAddClone.dataBytes = MessageData.encode(castAdd.data as MessageData).finish();
      const result = await engine1.mergeMessage(ensureMessageData(castAddClone));
      expect(result.isOk()).toBeTruthy();
      await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      // grab a new snapshot from the RPC for engine1
      const newSnapshotResult = await clientForServer1.getSyncSnapshotByPrefix(TrieNodePrefix.create());
      expect(newSnapshotResult.isOk()).toBeTruthy();
      const newSnapshot = newSnapshotResult._unsafeUnwrap();

      // Sanity check snapshot
      const localSnapshot = (await syncEngine1.getSnapshot())._unsafeUnwrap();
      expect(localSnapshot.excludedHashes).toEqual(newSnapshot.excludedHashes);
      expect(localSnapshot.excludedHashes.length).toEqual(newSnapshot.excludedHashes.length);
      expect(await syncEngine1.trie.rootHash()).toEqual(newSnapshot.rootHash);

      // Should sync should now be true
      expect((await syncEngine2.syncStatus("engine1", newSnapshot))._unsafeUnwrap().shouldSync).toBeTruthy();

      // Do the sync again, this time enabling audit
      await syncEngine2.performSync("engine1", clientForServer1, true);
      await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      // Make sure root hash matches
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

      expect(syncEngine2.trie.exists(SyncId.fromFName(fname))).toBeTruthy();
      expect(syncEngine2.trie.exists(SyncId.fromOnChainEvent(storageEvent))).toBeTruthy();
      expect(syncEngine2.trie.exists(SyncId.fromMessage(castAddClone))).toBeTruthy();

      // Sync again, and this time the audit should increase the peer score
      // First, get the existing peer score
      const peerScoreBefore = syncEngine2.getPeerScore("engine1");

      // Now sync again
      await syncEngine2.performSync("engine1", clientForServer1, true);

      // Make sure root hash matches and peer score has increased
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());
      const peerScoreAfter = syncEngine2.getPeerScore("engine1");
      expect(peerScoreAfter).toBeDefined();
      expect(peerScoreAfter?.score).toBeGreaterThan(peerScoreBefore?.score ?? Infinity);
    },
    TEST_TIMEOUT_LONG,
  );

  test("cast remove should remove from trie", async () => {
    // Add signer custody event to engine 1
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);

    // Add a cast to engine1
    const castAdd = (await addMessagesWithTimeDelta(engine1, [167]))[0] as Message;
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Sync engine 2 with engine 1
    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.rootHash()).toEqual(await syncEngine1.trie.rootHash());

    // Make sure the castAdd is in the trie
    expect(await syncEngine1.trie.exists(SyncId.fromMessage(castAdd))).toBeTruthy();
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))).toBeTruthy();

    const castRemove = await Factories.CastRemoveMessage.create(
      {
        data: {
          fid,
          network,
          timestamp: castAdd.data?.timestamp ?? 0 + 10,
          castRemoveBody: { targetHash: castAdd.hash },
        },
      },
      { transient: { signer } },
    );

    // Merging the cast remove deletes the cast add in the db, and it should be reflected in the trie
    const result = await engine1.mergeMessage(castRemove);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(result.isOk()).toBeTruthy();

    const castRemoveId = SyncId.fromMessage(castRemove);
    expect(await syncEngine1.trie.exists(castRemoveId)).toBeTruthy();
    // The trie should not contain the castAdd anymore
    expect(await syncEngine1.trie.exists(SyncId.fromMessage(castAdd))).toBeFalsy();

    // Syncing engine2 --> engine1 should do nothing, even though engine2 has the castAdd and it has been removed
    // from engine1.
    {
      const server2 = new Server(new MockHub(testDb2, engine2), engine2, syncEngine2);
      const port2 = await server2.start();
      const clientForServer2 = new FailoverStreamSyncClient(getInsecureHubRpcClient(`127.0.0.1:${port2}`), true);
      const engine1RootHashBefore = await syncEngine1.trie.rootHash();

      await syncEngine1.performSync("engine2", clientForServer2);
      await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      expect(await syncEngine1.trie.rootHash()).toEqual(engine1RootHashBefore);

      clientForServer2.close();
      await server2.stop();
    }

    // castRemove doesn't yet exist in engine2
    expect(await syncEngine2.trie.exists(castRemoveId)).toBeFalsy();

    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.exists(castRemoveId)).toBeTruthy();
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))).toBeFalsy();

    expect(await syncEngine2.trie.rootHash()).toEqual(await syncEngine1.trie.rootHash());

    // Adding the castAdd to engine2 should not change the root hash,
    // because it has already been removed, so adding it is a no-op
    const beforeRootHash = await syncEngine2.trie.rootHash();
    await engine2.mergeMessage(castAdd);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.rootHash()).toEqual(beforeRootHash);
  });

  test("audit should fail if peer withholds messages", async () => {
    await expect(engine1.mergeOnChainEvent(custodyEvent)).resolves.toBeDefined();
    await expect(engine1.mergeOnChainEvent(signerEvent)).resolves.toBeDefined();
    await expect(engine1.mergeOnChainEvent(storageEvent)).resolves.toBeDefined();
    await expect(engine1.mergeUserNameProof(fname)).resolves.toBeDefined();

    // Add messages to engine 1
    await addMessagesWithTimeDelta(engine1, [167]);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Sync engine 2 with engine 1
    await syncEngine2.performSync("engine1", clientForServer1);

    // Make sure root hash matches
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

    // Now, delete the messages from engine 1
    engine1.getDb().clear();
    const allValues = await syncEngine1.trie.getAllValues(new Uint8Array());
    await syncEngine1.trie.deleteByBytes(allValues);

    // Now, engine 1 should have no messages. Getting the metadata for the root should return
    // undefined since the root node doesn't exist any more
    expect(await syncEngine1.trie.getTrieNodeMetadata(new Uint8Array())).toBeUndefined();

    const startScore = syncEngine2.getPeerScore("engine1")?.score ?? 0;

    // Sync engine 2 with engine 1, but this time the audit will fail
    await syncEngine2.performSync("engine1", clientForServer1, true);

    // Check the peer score to make sure it reduced
    const peerScore = syncEngine2.getPeerScore("engine1");
    expect(peerScore).toBeDefined();
    expect(peerScore?.score).toBeLessThan(startScore);
  });

  test("shouldn't fetch messages that already exist", async () => {
    // Engine1 has no messages
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);

    // Engine2 has 2 messages
    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);
    await addMessagesWithTimeDelta(engine2, [167]);

    // Syncing engine2 --> engine1 should not fetch any additional messages, since engine2 already
    // has all the messages
    {
      const fetchMessagesSpy = jest.spyOn(syncEngine1, "getAllMessagesBySyncIds");
      await syncEngine2.performSync("engine1", clientForServer1);

      expect(fetchMessagesSpy).not.toHaveBeenCalled();
    }
  });

  test("sync should not fetch messages after the sync start", async () => {
    // Add signer custody event to engine 1
    await expect(engine1.mergeOnChainEvent(custodyEvent)).resolves.toBeDefined();
    await expect(engine1.mergeOnChainEvent(signerEvent)).resolves.toBeDefined();
    await expect(engine1.mergeOnChainEvent(storageEvent)).resolves.toBeDefined();
    await expect(engine1.mergeUserNameProof(fname)).resolves.toBeDefined();

    // Sync engine 2 with engine 1, this should get all the onchain events and fnames
    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Make sure root hash matches
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

    // Add messages to engine 1.
    const nowFsTime = getFarcasterTime()._unsafeUnwrap();
    const futureFsTime = nowFsTime + 2 * 60;

    const futureCast = await Factories.CastAddMessage.create(
      { data: { fid, network, timestamp: futureFsTime } },
      { transient: { signer } },
    );
    const currentCast = await Factories.CastAddMessage.create(
      { data: { fid, network, timestamp: nowFsTime } },
      { transient: { signer } },
    );

    // Merge the casts in
    let result = await engine1.mergeMessage(futureCast);
    expect(result.isOk()).toBeTruthy();
    result = await engine1.mergeMessage(currentCast);
    expect(result.isOk()).toBeTruthy();

    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Engine 2 should sync with engine1 (including onchain events and fnames)
    expect(
      (await syncEngine2.syncStatus("engine2", (await syncEngine1.getSnapshot())._unsafeUnwrap()))._unsafeUnwrap()
        .shouldSync,
    ).toBeTruthy();

    // Sync engine 2 with engine 1
    await syncEngine2.performSync("engine1", clientForServer1);

    // Expect the current cast to be in the sync trie, but not the future one, because it will be after
    // the sync engine start time
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(currentCast))).toBeTruthy();
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(futureCast))).toBeFalsy();
  });

  test("should fetch only the exact missing message", async () => {
    // Engine1 has 1 message
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);
    const msgs = await addMessagesWithTimeDelta(engine1, [167]);

    // Engine2 has no messages
    // Syncing engine2 --> engine1 should fetch only the missing message
    {
      const fetchMessagesSpy = jest.spyOn(syncEngine1, "getAllMessagesBySyncIds");
      await syncEngine2.performSync("engine1", clientForServer1);

      expect(fetchMessagesSpy).toHaveBeenCalledTimes(1);
      expect(fetchMessagesSpy).toHaveBeenCalledWith([SyncId.fromMessage(msgs[0] as Message)]);

      // Also assert the root hashes are the same
      expect(await syncEngine2.trie.rootHash()).toEqual(await syncEngine1.trie.rootHash());
    }
  });

  test("retries the event blocks if it's missing", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);

    await syncEngine2.performSync("engine1", clientForServer1);

    // Because do it without awaiting, we need to wait for the promise to resolve
    await sleep(100);
    expect(retryEventsMock).toHaveBeenCalledWith(custodyEvent.blockNumber);
    expect(retryEventsMock).toHaveBeenCalledWith(signerEvent.blockNumber);
    expect(retryEventsMock).toHaveBeenCalledWith(storageEvent.blockNumber);
  });

  test("does not retry any block if all events are present", async () => {
    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);
    await syncEngine2.performSync("engine1", clientForServer1);

    // Because do it without awaiting, we need to wait for the promise to resolve
    await sleep(100);
    expect(retryEventsMock).not.toHaveBeenCalled();
  });

  test("local peer removes bad syncId entries from the sync trie", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(custodyEvent);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const engine1Hash = await syncEngine1.trie.rootHash();
    expect(engine1Hash).toEqual(await syncEngine2.trie.rootHash());
    await syncEngine2.trie.insert(
      SyncId.fromOnChainEvent(Factories.IdRegistryOnChainEvent.build({ blockNumber: custodyEvent.blockNumber + 1 })),
    );
    await syncEngine2.trie.insert(SyncId.fromMessage(castAdd));
    // Insert the same name but for a different fid, and it should still be removed
    await syncEngine2.trie.insert(SyncId.fromFName(Factories.UserNameProof.build({ name: fname.name, fid: fid + 1 })));

    expect(engine1Hash).not.toEqual(await syncEngine2.trie.rootHash());
    await syncEngine2.performSync("engine1", clientForServer1);

    // Because do it without awaiting, we need to wait for the promise to resolve
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(engine1Hash).toEqual(await syncEngine2.trie.rootHash());
  });

  test("remote peers recovers if there are missing data in the engine", async () => {
    // Add a message to engine1 synctrie, but not to the engine itself.
    await syncEngine1.trie.insert(SyncId.fromMessage(castAdd));

    // Attempt to sync engine2 <-- engine1.
    await syncEngine2.performSync("engine1", clientForServer1);

    // Since the message is actually missing, it should be a no-op, and the missing message should disappear
    // from the sync trie
    await sleepWhile(
      async () => (await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))) === true,
      SLEEPWHILE_TIMEOUT,
    );
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))).toBeFalsy();

    // The root hashes should be the same, since nothing actually happened
    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(await syncEngine1.trie.rootHash()).toEqual(EMPTY_HASH);
  });

  test("recovers if there are missing messages in the engine during sync", async () => {
    await engine2.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(custodyEvent);

    await engine2.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(signerEvent);

    await engine1.mergeOnChainEvent(storageEvent);
    await engine2.mergeOnChainEvent(storageEvent);

    // We'll get 2 CastAdds
    const castAdd1 = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });
    const castAdd2 = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });

    // CastAdd1 is added properly to both
    expect(await engine2.mergeMessage(castAdd1)).toBeTruthy();
    expect(await engine1.mergeMessage(castAdd1)).toBeTruthy();

    // CastAdd2 is added only to the sync trie, but is missing from the engine
    expect(await syncEngine2.trie.insert(SyncId.fromMessage(castAdd2))).toBeTruthy();

    // Wait for the sync trie to be updated
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.items()).toEqual(3 + 2); // 2 onchain events + 2 castAdds
    expect(await syncEngine1.trie.items()).toEqual(3 + 1); // 2 onchain events + 1 castAdd

    // Attempt to sync engine2 <-- engine1. Engine1 has only singerAdd
    await syncEngine2.performSync("engine1", clientForServer1);

    // The sync engine should realize that castAdd2 is not in it's engine, so it should be removed from the sync trie
    await sleepWhile(async () => (await syncEngine2.trie.exists(SyncId.fromMessage(castAdd2))) === true, 1000);
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd2))).toBeFalsy();

    // but the castAdd1 should still be there
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd1))).toBeTruthy();

    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
  });

  test("recovers if messages are missing from the sync trie", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);
    await engine1.mergeUserNameProof(fname);

    // We add it to the engine2 synctrie as normal...
    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);
    await engine2.mergeUserNameProof(fname);

    await engine1.mergeMessage(castAdd);
    await engine2.mergeMessage(castAdd);

    // ...but we'll corrupt the sync trie by pretending that the castAdd message, an onchain event and an fname are missing
    await syncEngine2.trie.delete(SyncId.fromMessage(castAdd));
    await syncEngine2.trie.delete(SyncId.fromOnChainEvent(storageEvent));
    await syncEngine2.trie.delete(SyncId.fromFName(fname));

    // syncengine2 should only have 2 onchain events
    expect(await syncEngine2.trie.items()).toEqual(2);

    // Attempt to sync engine2 <-- engine1.
    // It will appear to engine2 that the message is missing, so it will request it from engine1.
    // It will be a duplicate, but the sync trie should be updated
    await syncEngine2.performSync("engine1", clientForServer1);

    // Since the message isn't actually missing, it should be a no-op, and the missing message should
    // get added back to the sync trie
    await sleepWhile(
      async () => (await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))) === false,
      SLEEPWHILE_TIMEOUT,
    );

    // The root hashes should now be the same
    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());
  });

  test("syncEngine syncs with same numMessages but different hashes", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);
    const initialEngine1Count = 3; // Added 3 events

    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);
    const initialEngine2Count = 3; // Added 3 events

    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

    // Add two different messages to engine1 and engine2
    await addMessagesWithTimeDelta(engine1, [167]);
    await addMessagesWithTimeDelta(engine2, [169]);

    await sleepWhile(async () => (await syncEngine1.trie.items()) !== initialEngine1Count + 1, SLEEPWHILE_TIMEOUT);
    await sleepWhile(async () => (await syncEngine2.trie.items()) !== initialEngine2Count + 1, SLEEPWHILE_TIMEOUT);

    // Do a sync
    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(async () => (await syncEngine2.trie.items()) !== initialEngine2Count + 2, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.items()).toEqual(initialEngine2Count + 2);

    // Do a sync the other way
    {
      const server2 = new Server(new MockHub(testDb2, engine2), engine2, syncEngine2);
      const port2 = await server2.start();
      const clientForServer2 = new FailoverStreamSyncClient(getInsecureHubRpcClient(`127.0.0.1:${port2}`), true);

      await syncEngine1.performSync("engine2", clientForServer2);
      await sleepWhile(async () => (await syncEngine1.trie.items()) !== initialEngine2Count + 2, 1000);

      // Now both engines should have the same number of messages and the same root hash
      expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

      clientForServer2.close();
      await server2.stop();
    }
  });

  test("syncEngine syncs with more numMessages and different hashes", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);

    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);

    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

    // Add two different messages to engine1 and engine2
    await addMessagesWithTimeDelta(engine1, [167, 168]);
    await addMessagesWithTimeDelta(engine2, [169]);

    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Do a sync
    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.items()).toEqual(6); // Includes on chain events

    // Do a sync the other way
    {
      const server2 = new Server(new MockHub(testDb2, engine2), engine2, syncEngine2);
      const port2 = await server2.start();
      const clientForServer2 = new FailoverStreamSyncClient(getInsecureHubRpcClient(`127.0.0.1:${port2}`), true);

      await syncEngine1.performSync("engine2", clientForServer2);
      await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      // Now both engines should have the same number of messages and the same root hash
      expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

      clientForServer2.close();
      await server2.stop();
    }
  });

  test("sync health: basic", async () => {
    const metadataRetriever1 = new SyncEngineMetadataRetriever(hub1, syncEngine1);
    const metadataRetriever2 = new SyncEngineMetadataRetriever(hub2, syncEngine2);

    const syncHealthProbe = new SyncHealthProbe(metadataRetriever1, metadataRetriever2);

    const setupEngine = async (engine: Engine) => {
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(signerEvent);
      await engine.mergeOnChainEvent(storageEvent);
    };

    // Engine1 has no messages
    await setupEngine(engine1);
    await setupEngine(engine2);

    // This is the start time from addMessagesWithTimeDelta
    const farcasterTime = getFarcasterTime()._unsafeUnwrap() - 1000;

    const messages = await addMessagesWithTimeDelta(engine1, [150, 170, 180, 200]);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const start = new Date(fromFarcasterTime(farcasterTime + 150)._unsafeUnwrap());
    const stop = new Date(fromFarcasterTime(farcasterTime + 200)._unsafeUnwrap());

    const messageStats1 = await syncHealthProbe.computeSyncHealthMessageStats(start, stop);

    // This happens because there are no messages under the common prefix for engine2
    expect(messageStats1.isErr());

    await engine2.mergeMessages(messages.slice(0, 2));
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const messageStats2 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    // Query is inclusive of the start time and exclusive of the stop time. We count 150, 170, 180 on engine1 and  150, 170 on engine 2
    expect(messageStats2.primaryNumMessages).toEqual(3);
    expect(messageStats2.peerNumMessages).toEqual(2);

    // Show that pushing diverging sync ids works
    const pushResults2 = (await syncHealthProbe.tryPushingDivergingSyncIds(start, stop, "ToPeer"))._unsafeUnwrap();

    expect(pushResults2.length).toEqual(1);

    // New message that's only on engine 2
    await addMessagesWithTimeDelta(engine2, [185]);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const messageStats3 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    // engine2 has all the messages engine1 has in addition to 185.
    expect(messageStats3.primaryNumMessages).toEqual(3);
    expect(messageStats3.peerNumMessages).toEqual(4);

    // Show that pushing diverging sync ids works
    const pushResults3 = (await syncHealthProbe.tryPushingDivergingSyncIds(start, stop, "FromPeer"))._unsafeUnwrap();

    expect(pushResults3.length).toEqual(1);

    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const messageStats4 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    // engine2 has all the messages engine1 has
    expect(messageStats4.primaryNumMessages).toEqual(4);
    expect(messageStats4.peerNumMessages).toEqual(4);
  });

  test("sync health: push diverging sync ids with a lot of sync ids", async () => {
    const metadataRetriever1 = new SyncEngineMetadataRetriever(hub1, syncEngine1);
    const metadataRetriever2 = new SyncEngineMetadataRetriever(hub2, syncEngine2);

    const syncHealthProbe = new SyncHealthProbe(metadataRetriever1, metadataRetriever2, 10);

    const setupEngine = async (engine: Engine) => {
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(signerEvent);
      await engine.mergeOnChainEvent(storageEvent);
    };

    // Engine1 has no messages
    await setupEngine(engine1);
    await setupEngine(engine2);

    // This is the start time from addMessagesWithTimeDelta
    const startFarcasterTime = getFarcasterTime()._unsafeUnwrap() - 3000;

    const timeDeltas = [];
    for (let j = 0; j < 15; j++) {
      timeDeltas.push(j);
    }

    await addMessagesWithTimeDelta(engine1, timeDeltas, startFarcasterTime);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Make the query range wide so that you start on a node with a lot of messages under it.
    const start = new Date(fromFarcasterTime(0)._unsafeUnwrap());
    const stop = new Date(fromFarcasterTime(startFarcasterTime + 50000)._unsafeUnwrap());

    const messageStats1 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    // The 3 comes from custody, signer, storage events
    expect(messageStats1.primaryNumMessages).toEqual(18);
    expect(messageStats1.peerNumMessages).toEqual(3);

    // Show that pushing diverging sync ids works when there are more than 1024 sync ids under a prefix
    const pushResults = (await syncHealthProbe.tryPushingDivergingSyncIds(start, stop, "ToPeer"))._unsafeUnwrap();

    expect(pushResults.length).toEqual(15);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const messageStats2 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    expect(messageStats2.primaryNumMessages).toEqual(18);
    expect(messageStats2.peerNumMessages).toEqual(18);
  });

  xtest(
    "loads of messages",
    async () => {
      const timedTest = async (fn: () => Promise<void>): Promise<number> => {
        const start = Date.now();
        await fn();
        const end = Date.now();

        const totalTime = (end - start) / 1000;
        return totalTime;
      };

      // Add signer custody event to engine 1
      await engine1.mergeOnChainEvent(custodyEvent);
      await engine1.mergeOnChainEvent(signerEvent);
      await engine1.mergeOnChainEvent(storageEvent);

      // Add loads of messages to engine 1
      let msgTimestamp = 30662167;
      const batchSize = 100;
      const numBatches = 20;

      // Remove a few messages from the previous batch
      let castMessagesToRemove: Message[] = [];

      let totalMessages = 0;

      let totalTime = await timedTest(async () => {
        for (let i = 0; i < numBatches; i++) {
          // Remove a few messages from the previous batch
          const timestampsToRemove = [];
          for (let j = 0; j < castMessagesToRemove.length; j++) {
            timestampsToRemove.push(msgTimestamp + j);
          }

          await removeMessagesWithTsHashes(engine1, castMessagesToRemove);

          msgTimestamp += timestampsToRemove.length;
          totalMessages += timestampsToRemove.length;

          // Add new timestamped messages
          const timestamps = [];
          for (let j = 0; j < batchSize; j++) {
            timestamps.push(msgTimestamp + j);
          }
          // console.log('adding batch', i, ' of ', numBatches);
          const addedMessages = await addMessagesWithTimeDelta(engine1, timestamps);
          await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
          castMessagesToRemove = addedMessages.slice(0, 10);

          msgTimestamp += batchSize;
          totalMessages += batchSize;
        }
        await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
      });
      expect(totalTime).toBeGreaterThan(0);
      expect(totalMessages).toBeGreaterThan(numBatches * batchSize);
      // console.log('Merge total time', totalTime, 'seconds. Messages per second:', totalMessages / totalTime);

      const engine2 = new Engine(testDb2, network);
      const hub2 = new MockHub(testDb2, engine2);
      const syncEngine2 = new SyncEngine(hub2, testDb2, undefined, undefined, undefined, undefined, true);
      syncEngine2.start();

      // Engine 2 should sync with engine1
      expect(
        (await syncEngine2.syncStatus("engine1", (await syncEngine1.getSnapshot())._unsafeUnwrap()))._unsafeUnwrap()
          .shouldSync,
      ).toBeTruthy();

      await engine2.mergeOnChainEvent(custodyEvent);
      await engine2.mergeOnChainEvent(signerEvent);
      await engine2.mergeOnChainEvent(storageEvent);

      // Sync engine 2 with engine 1, and measure the time taken
      totalTime = await timedTest(async () => {
        await syncEngine2.performSync("engine1", clientForServer1);
      });

      expect(totalTime).toBeGreaterThan(0);
      expect(totalMessages).toBeGreaterThan(numBatches * batchSize);
      // console.log('Sync total time', totalTime, 'seconds. Messages per second:', totalMessages / totalTime);

      expect((await syncEngine1.getSnapshot())._unsafeUnwrap().excludedHashes).toEqual(
        (await syncEngine2.getSnapshot())._unsafeUnwrap().excludedHashes,
      );
      expect((await syncEngine1.getSnapshot())._unsafeUnwrap().numMessages).toEqual(
        (await syncEngine2.getSnapshot())._unsafeUnwrap().numMessages,
      );

      // Create a new sync engine from the existing engine, and see if all the messages from the engine
      // are loaded into the sync engine Merkle Trie properly.
      const reinitSyncEngine = new SyncEngine(hub1, testDb1, undefined, undefined, undefined, undefined, true);
      expect(await reinitSyncEngine.trie.rootHash()).toEqual("");

      totalTime = await timedTest(async () => {
        await reinitSyncEngine.start();
      });
      // console.log('MerkleTrie total time', totalTime, 'seconds. Messages per second:', totalMessages / totalTime);

      expect(await reinitSyncEngine.trie.rootHash()).toEqual(await syncEngine1.trie.rootHash());

      await syncEngine2.stop();
      await engine2.stop();
    },
    TEST_TIMEOUT_LONG,
  );
});

describe("Multi peer sync engine with rpcs", () => {
  jest.setTimeout(TEST_TIMEOUT_LONG);
  const addMessagesWithTimeDelta = async (engine: Engine, timeDelta: number[], startFarcasterTime?: number) => {
    // Take care that the farcasterTime is not in the future
    const farcasterTime = startFarcasterTime ? startFarcasterTime : getFarcasterTime()._unsafeUnwrap() - 1000;

    return await Promise.all(
      timeDelta.map(async (t) => {
        const cast = await Factories.CastAddMessage.create(
          { data: { fid, network, timestamp: farcasterTime + t } },
          { transient: { signer } },
        );

        const result = await engine.mergeMessage(cast);
        if (result.isErr()) {
          throw result.error;
        }
        expect(result.isOk()).toBeTruthy();

        return cast;
      }),
    );
  };

  const removeMessagesWithTsHashes = async (engine: Engine, addMessages: Message[]) => {
    return await Promise.all(
      addMessages.map(async (addMessage) => {
        const castRemove = await Factories.CastRemoveMessage.create(
          {
            data: {
              fid,
              network,
              timestamp: addMessage.data?.timestamp ?? 0 + 10,
              castRemoveBody: { targetHash: addMessage.hash },
            },
          },
          { transient: { signer } },
        );

        const result = await engine.mergeMessage(castRemove);
        expect(result.isOk()).toBeTruthy();
        return Promise.resolve(castRemove);
      }),
    );
  };

  // Engine 1 is where we add events, and see if engine 2 will sync them
  let engine1: Engine;
  let hub1: HubInterface;
  let syncEngine1: SyncEngine;
  let server1: Server;
  let port1;
  let clientForServer1: FailoverStreamSyncClient;

  let engine2: Engine;
  let hub2: HubInterface;
  let syncEngine2: SyncEngine;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Engine 1 is where we add events, and see if engine 2 will sync them
    engine1 = new Engine(testDb1, network);
    hub1 = new MockHub(testDb1, engine1);
    syncEngine1 = new SyncEngine(hub1, testDb1, undefined, undefined, undefined, 0, false);
    await syncEngine1.start();
    await syncEngine1.trie.clear();

    server1 = new Server(hub1, engine1, syncEngine1);
    port1 = await server1.start();
    clientForServer1 = new FailoverStreamSyncClient(getInsecureHubRpcClient(`127.0.0.1:${port1}`), false);

    retryEventsMock.mockImplementation(async (blockNumber: number) => {
      const event = eventsByBlock.get(blockNumber);
      if (event) {
        return engine2.mergeOnChainEvent(event);
      } else {
        throw new Error(`Block ${blockNumber} not found`);
      }
    });
    retryTransferByName.mockImplementation(async (name: Uint8Array) => {
      expect(name).toEqual(fname.name);
      await engine2.mergeUserNameProof(fname);
    });
    engine2 = new Engine(testDb2, network);
    hub2 = new MockHub(testDb2, engine2);
    syncEngine2 = new SyncEngine(hub2, testDb2, l2EventsProvider, fnameEventsProvider, undefined, 0, false);
    await syncEngine2.start();
    await syncEngine2.trie.clear();
  }, TEST_TIMEOUT_SHORT);

  afterEach(async () => {
    // Cleanup
    clientForServer1.close();
    await server1.stop();
    await syncEngine1.stop();
    await engine1.stop();

    await syncEngine2.stop();
    await engine2.stop();
  }, TEST_TIMEOUT_SHORT);

  test("toBytes test", async () => {
    // Add signer custody event to engine 1
    expect((await engine1.mergeOnChainEvent(custodyEvent)).isOk()).toBe(true);
    expect((await engine1.mergeOnChainEvent(signerEvent)).isOk()).toBe(true);

    // Get info first
    const info = await clientForServer1.getInfo(HubInfoRequest.create());
    expect(info.isOk()).toBeTruthy();
    const infoResult = info._unsafeUnwrap();
    expect(infoResult.version).toEqual(APP_VERSION);
    expect(infoResult.nickname).toEqual(APP_NICKNAME);

    // Fetch the signerAdd message from engine 1
    const rpcResult = await clientForServer1.getOnChainSignersByFid({ fid });
    expect(rpcResult.isOk()).toBeTruthy();
    expect(rpcResult._unsafeUnwrap().events.length).toEqual(1);
    const rpcSignerAdd = rpcResult._unsafeUnwrap().events[0] as OnChainEvent;

    expect(OnChainEvent.toJSON(signerEvent)).toEqual(OnChainEvent.toJSON(rpcSignerAdd));
    expect(signerEvent.fid).toEqual(rpcSignerAdd.fid);

    // Create a new sync engine from the existing engine, and see if all the messages from the engine
    // are loaded into the sync engine Merkle Trie properly.
    const rootHash = await syncEngine1.trie.rootHash();
    await clientForServer1.close();
    await syncEngine1.stop();
    await server1.stop();
    const reinitSyncEngine = new SyncEngine(hub1, testDb1, undefined, undefined, undefined, undefined, false);
    await reinitSyncEngine.start();

    expect(await reinitSyncEngine.trie.rootHash()).toEqual(rootHash);

    await reinitSyncEngine.stop();
  });

  test(
    "two peers should sync",
    async () => {
      // Add signer custody event to engine 1
      await expect(engine1.mergeOnChainEvent(custodyEvent)).resolves.toBeDefined();
      await expect(engine1.mergeOnChainEvent(signerEvent)).resolves.toBeDefined();
      await expect(engine1.mergeOnChainEvent(storageEvent)).resolves.toBeDefined();
      await expect(engine1.mergeUserNameProof(fname)).resolves.toBeDefined();

      // Add messages to engine 1
      await addMessagesWithTimeDelta(engine1, [167, 169, 172]);
      await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      // Engine 2 should sync with engine1 (including onchain events and fnames)
      expect(
        (await syncEngine2.syncStatus("engine2", (await syncEngine1.getSnapshot())._unsafeUnwrap()))._unsafeUnwrap()
          .shouldSync,
      ).toBeTruthy();

      // Sync engine 2 with engine 1
      await syncEngine2.performSync("engine1", clientForServer1);

      // Make sure root hash matches
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

      // Should sync should now be false with the new excluded hashes
      expect(
        (await syncEngine2.syncStatus("engine1", (await syncEngine1.getSnapshot())._unsafeUnwrap()))._unsafeUnwrap()
          .shouldSync,
      ).toBeFalsy();

      // Add more messages
      await addMessagesWithTimeDelta(engine1, [367, 369, 372]);
      // Add a message with data_bytes to make sure it gets synced OK.
      const castAddClone = Message.decode(Message.encode(castAdd).finish());
      castAddClone.data = undefined;
      castAddClone.dataBytes = MessageData.encode(castAdd.data as MessageData).finish();
      const result = await engine1.mergeMessage(ensureMessageData(castAddClone));
      expect(result.isOk()).toBeTruthy();
      await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      // grab a new snapshot from the RPC for engine1
      const newSnapshotResult = await clientForServer1.getSyncSnapshotByPrefix(TrieNodePrefix.create());
      expect(newSnapshotResult.isOk()).toBeTruthy();
      const newSnapshot = newSnapshotResult._unsafeUnwrap();

      // Sanity check snapshot
      const localSnapshot = (await syncEngine1.getSnapshot())._unsafeUnwrap();
      expect(localSnapshot.excludedHashes).toEqual(newSnapshot.excludedHashes);
      expect(localSnapshot.excludedHashes.length).toEqual(newSnapshot.excludedHashes.length);
      expect(await syncEngine1.trie.rootHash()).toEqual(newSnapshot.rootHash);

      // Should sync should now be true
      expect((await syncEngine2.syncStatus("engine1", newSnapshot))._unsafeUnwrap().shouldSync).toBeTruthy();

      // Do the sync again, this time enabling audit
      await syncEngine2.performSync("engine1", clientForServer1, true);
      await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      // Make sure root hash matches
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

      expect(syncEngine2.trie.exists(SyncId.fromFName(fname))).toBeTruthy();
      expect(syncEngine2.trie.exists(SyncId.fromOnChainEvent(storageEvent))).toBeTruthy();
      expect(syncEngine2.trie.exists(SyncId.fromMessage(castAddClone))).toBeTruthy();

      // Sync again, and this time the audit should increase the peer score
      // First, get the existing peer score
      const peerScoreBefore = syncEngine2.getPeerScore("engine1");

      // Now sync again
      await syncEngine2.performSync("engine1", clientForServer1, true);

      // Make sure root hash matches and peer score has increased
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());
      const peerScoreAfter = syncEngine2.getPeerScore("engine1");
      expect(peerScoreAfter).toBeDefined();
      expect(peerScoreAfter?.score).toBeGreaterThan(peerScoreBefore?.score ?? Infinity);
    },
    TEST_TIMEOUT_LONG,
  );

  test("cast remove should remove from trie", async () => {
    // Add signer custody event to engine 1
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);

    // Add a cast to engine1
    const castAdd = (await addMessagesWithTimeDelta(engine1, [167]))[0] as Message;
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Sync engine 2 with engine 1
    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.rootHash()).toEqual(await syncEngine1.trie.rootHash());

    // Make sure the castAdd is in the trie
    expect(await syncEngine1.trie.exists(SyncId.fromMessage(castAdd))).toBeTruthy();
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))).toBeTruthy();

    const castRemove = await Factories.CastRemoveMessage.create(
      {
        data: {
          fid,
          network,
          timestamp: castAdd.data?.timestamp ?? 0 + 10,
          castRemoveBody: { targetHash: castAdd.hash },
        },
      },
      { transient: { signer } },
    );

    // Merging the cast remove deletes the cast add in the db, and it should be reflected in the trie
    const result = await engine1.mergeMessage(castRemove);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(result.isOk()).toBeTruthy();

    const castRemoveId = SyncId.fromMessage(castRemove);
    expect(await syncEngine1.trie.exists(castRemoveId)).toBeTruthy();
    // The trie should not contain the castAdd anymore
    expect(await syncEngine1.trie.exists(SyncId.fromMessage(castAdd))).toBeFalsy();

    // Syncing engine2 --> engine1 should do nothing, even though engine2 has the castAdd and it has been removed
    // from engine1.
    {
      const server2 = new Server(new MockHub(testDb2, engine2), engine2, syncEngine2);
      const port2 = await server2.start();
      const clientForServer2 = new FailoverStreamSyncClient(getInsecureHubRpcClient(`127.0.0.1:${port2}`), false);
      const engine1RootHashBefore = await syncEngine1.trie.rootHash();

      await syncEngine1.performSync("engine2", clientForServer2);
      await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      expect(await syncEngine1.trie.rootHash()).toEqual(engine1RootHashBefore);

      clientForServer2.close();
      await server2.stop();
    }

    // castRemove doesn't yet exist in engine2
    expect(await syncEngine2.trie.exists(castRemoveId)).toBeFalsy();

    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.exists(castRemoveId)).toBeTruthy();
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))).toBeFalsy();

    expect(await syncEngine2.trie.rootHash()).toEqual(await syncEngine1.trie.rootHash());

    // Adding the castAdd to engine2 should not change the root hash,
    // because it has already been removed, so adding it is a no-op
    const beforeRootHash = await syncEngine2.trie.rootHash();
    await engine2.mergeMessage(castAdd);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.rootHash()).toEqual(beforeRootHash);
  });

  test("audit should fail if peer withholds messages", async () => {
    await expect(engine1.mergeOnChainEvent(custodyEvent)).resolves.toBeDefined();
    await expect(engine1.mergeOnChainEvent(signerEvent)).resolves.toBeDefined();
    await expect(engine1.mergeOnChainEvent(storageEvent)).resolves.toBeDefined();
    await expect(engine1.mergeUserNameProof(fname)).resolves.toBeDefined();

    // Add messages to engine 1
    await addMessagesWithTimeDelta(engine1, [167]);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Sync engine 2 with engine 1
    await syncEngine2.performSync("engine1", clientForServer1);

    // Make sure root hash matches
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

    // Now, delete the messages from engine 1
    engine1.getDb().clear();
    const allValues = await syncEngine1.trie.getAllValues(new Uint8Array());
    await syncEngine1.trie.deleteByBytes(allValues);

    // Now, engine 1 should have no messages. Getting the metadata for the root should return
    // undefined since the root node doesn't exist any more
    expect(await syncEngine1.trie.getTrieNodeMetadata(new Uint8Array())).toBeUndefined();

    const startScore = syncEngine2.getPeerScore("engine1")?.score ?? 0;

    // Sync engine 2 with engine 1, but this time the audit will fail
    await syncEngine2.performSync("engine1", clientForServer1, true);

    // Check the peer score to make sure it reduced
    const peerScore = syncEngine2.getPeerScore("engine1");
    expect(peerScore).toBeDefined();
    expect(peerScore?.score).toBeLessThan(startScore);
  });

  test("shouldn't fetch messages that already exist", async () => {
    // Engine1 has no messages
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);

    // Engine2 has 2 messages
    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);
    await addMessagesWithTimeDelta(engine2, [167]);

    // Syncing engine2 --> engine1 should not fetch any additional messages, since engine2 already
    // has all the messages
    {
      const fetchMessagesSpy = jest.spyOn(syncEngine1, "getAllMessagesBySyncIds");
      await syncEngine2.performSync("engine1", clientForServer1);

      expect(fetchMessagesSpy).not.toHaveBeenCalled();
    }
  });

  test("sync should not fetch messages after the sync start", async () => {
    // Add signer custody event to engine 1
    await expect(engine1.mergeOnChainEvent(custodyEvent)).resolves.toBeDefined();
    await expect(engine1.mergeOnChainEvent(signerEvent)).resolves.toBeDefined();
    await expect(engine1.mergeOnChainEvent(storageEvent)).resolves.toBeDefined();
    await expect(engine1.mergeUserNameProof(fname)).resolves.toBeDefined();

    // Sync engine 2 with engine 1, this should get all the onchain events and fnames
    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Make sure root hash matches
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

    // Add messages to engine 1.
    const nowFsTime = getFarcasterTime()._unsafeUnwrap();
    const futureFsTime = nowFsTime + 2 * 60;

    const futureCast = await Factories.CastAddMessage.create(
      { data: { fid, network, timestamp: futureFsTime } },
      { transient: { signer } },
    );
    const currentCast = await Factories.CastAddMessage.create(
      { data: { fid, network, timestamp: nowFsTime } },
      { transient: { signer } },
    );

    // Merge the casts in
    let result = await engine1.mergeMessage(futureCast);
    expect(result.isOk()).toBeTruthy();
    result = await engine1.mergeMessage(currentCast);
    expect(result.isOk()).toBeTruthy();

    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Engine 2 should sync with engine1 (including onchain events and fnames)
    expect(
      (await syncEngine2.syncStatus("engine2", (await syncEngine1.getSnapshot())._unsafeUnwrap()))._unsafeUnwrap()
        .shouldSync,
    ).toBeTruthy();

    // Sync engine 2 with engine 1
    await syncEngine2.performSync("engine1", clientForServer1);

    // Expect the current cast to be in the sync trie, but not the future one, because it will be after
    // the sync engine start time
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(currentCast))).toBeTruthy();
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(futureCast))).toBeFalsy();
  });

  test("should fetch only the exact missing message", async () => {
    // Engine1 has 1 message
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);
    const msgs = await addMessagesWithTimeDelta(engine1, [167]);

    // Engine2 has no messages
    // Syncing engine2 --> engine1 should fetch only the missing message
    {
      const fetchMessagesSpy = jest.spyOn(syncEngine1, "getAllMessagesBySyncIds");
      await syncEngine2.performSync("engine1", clientForServer1);

      expect(fetchMessagesSpy).toHaveBeenCalledTimes(1);
      expect(fetchMessagesSpy).toHaveBeenCalledWith([SyncId.fromMessage(msgs[0] as Message)]);

      // Also assert the root hashes are the same
      expect(await syncEngine2.trie.rootHash()).toEqual(await syncEngine1.trie.rootHash());
    }
  });

  test("retries the event blocks if it's missing", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);

    await syncEngine2.performSync("engine1", clientForServer1);

    // Because do it without awaiting, we need to wait for the promise to resolve
    await sleep(100);
    expect(retryEventsMock).toHaveBeenCalledWith(custodyEvent.blockNumber);
    expect(retryEventsMock).toHaveBeenCalledWith(signerEvent.blockNumber);
    expect(retryEventsMock).toHaveBeenCalledWith(storageEvent.blockNumber);
  });

  test("does not retry any block if all events are present", async () => {
    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);
    await syncEngine2.performSync("engine1", clientForServer1);

    // Because do it without awaiting, we need to wait for the promise to resolve
    await sleep(100);
    expect(retryEventsMock).not.toHaveBeenCalled();
  });

  test("local peer removes bad syncId entries from the sync trie", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(custodyEvent);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const engine1Hash = await syncEngine1.trie.rootHash();
    expect(engine1Hash).toEqual(await syncEngine2.trie.rootHash());
    await syncEngine2.trie.insert(
      SyncId.fromOnChainEvent(Factories.IdRegistryOnChainEvent.build({ blockNumber: custodyEvent.blockNumber + 1 })),
    );
    await syncEngine2.trie.insert(SyncId.fromMessage(castAdd));
    // Insert the same name but for a different fid, and it should still be removed
    await syncEngine2.trie.insert(SyncId.fromFName(Factories.UserNameProof.build({ name: fname.name, fid: fid + 1 })));

    expect(engine1Hash).not.toEqual(await syncEngine2.trie.rootHash());
    await syncEngine2.performSync("engine1", clientForServer1);

    // Because do it without awaiting, we need to wait for the promise to resolve
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(engine1Hash).toEqual(await syncEngine2.trie.rootHash());
  });

  test("remote peers recovers if there are missing data in the engine", async () => {
    // Add a message to engine1 synctrie, but not to the engine itself.
    await syncEngine1.trie.insert(SyncId.fromMessage(castAdd));

    // Attempt to sync engine2 <-- engine1.
    await syncEngine2.performSync("engine1", clientForServer1);

    // Since the message is actually missing, it should be a no-op, and the missing message should disappear
    // from the sync trie
    await sleepWhile(
      async () => (await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))) === true,
      SLEEPWHILE_TIMEOUT,
    );
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))).toBeFalsy();

    // The root hashes should be the same, since nothing actually happened
    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(await syncEngine1.trie.rootHash()).toEqual(EMPTY_HASH);
  });

  test("recovers if there are missing messages in the engine during sync", async () => {
    await engine2.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(custodyEvent);

    await engine2.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(signerEvent);

    await engine1.mergeOnChainEvent(storageEvent);
    await engine2.mergeOnChainEvent(storageEvent);

    // We'll get 2 CastAdds
    const castAdd1 = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });
    const castAdd2 = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });

    // CastAdd1 is added properly to both
    expect(await engine2.mergeMessage(castAdd1)).toBeTruthy();
    expect(await engine1.mergeMessage(castAdd1)).toBeTruthy();

    // CastAdd2 is added only to the sync trie, but is missing from the engine
    expect(await syncEngine2.trie.insert(SyncId.fromMessage(castAdd2))).toBeTruthy();

    // Wait for the sync trie to be updated
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.items()).toEqual(3 + 2); // 2 onchain events + 2 castAdds
    expect(await syncEngine1.trie.items()).toEqual(3 + 1); // 2 onchain events + 1 castAdd

    // Attempt to sync engine2 <-- engine1. Engine1 has only singerAdd
    await syncEngine2.performSync("engine1", clientForServer1);

    // The sync engine should realize that castAdd2 is not in it's engine, so it should be removed from the sync trie
    await sleepWhile(async () => (await syncEngine2.trie.exists(SyncId.fromMessage(castAdd2))) === true, 1000);
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd2))).toBeFalsy();

    // but the castAdd1 should still be there
    expect(await syncEngine2.trie.exists(SyncId.fromMessage(castAdd1))).toBeTruthy();

    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
  });

  test("recovers if messages are missing from the sync trie", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);
    await engine1.mergeUserNameProof(fname);

    // We add it to the engine2 synctrie as normal...
    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);
    await engine2.mergeUserNameProof(fname);

    await engine1.mergeMessage(castAdd);
    await engine2.mergeMessage(castAdd);

    // ...but we'll corrupt the sync trie by pretending that the castAdd message, an onchain event and an fname are missing
    await syncEngine2.trie.delete(SyncId.fromMessage(castAdd));
    await syncEngine2.trie.delete(SyncId.fromOnChainEvent(storageEvent));
    await syncEngine2.trie.delete(SyncId.fromFName(fname));

    // syncengine2 should only have 2 onchain events
    expect(await syncEngine2.trie.items()).toEqual(2);

    // Attempt to sync engine2 <-- engine1.
    // It will appear to engine2 that the message is missing, so it will request it from engine1.
    // It will be a duplicate, but the sync trie should be updated
    await syncEngine2.performSync("engine1", clientForServer1);

    // Since the message isn't actually missing, it should be a no-op, and the missing message should
    // get added back to the sync trie
    await sleepWhile(
      async () => (await syncEngine2.trie.exists(SyncId.fromMessage(castAdd))) === false,
      SLEEPWHILE_TIMEOUT,
    );

    // The root hashes should now be the same
    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());
  });

  test("syncEngine syncs with same numMessages but different hashes", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);
    const initialEngine1Count = 3; // Added 3 events

    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);
    const initialEngine2Count = 3; // Added 3 events

    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

    // Add two different messages to engine1 and engine2
    await addMessagesWithTimeDelta(engine1, [167]);
    await addMessagesWithTimeDelta(engine2, [169]);

    await sleepWhile(async () => (await syncEngine1.trie.items()) !== initialEngine1Count + 1, SLEEPWHILE_TIMEOUT);
    await sleepWhile(async () => (await syncEngine2.trie.items()) !== initialEngine2Count + 1, SLEEPWHILE_TIMEOUT);

    // Do a sync
    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(async () => (await syncEngine2.trie.items()) !== initialEngine2Count + 2, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.items()).toEqual(initialEngine2Count + 2);

    // Do a sync the other way
    {
      const server2 = new Server(new MockHub(testDb2, engine2), engine2, syncEngine2);
      const port2 = await server2.start();
      const clientForServer2 = new FailoverStreamSyncClient(getInsecureHubRpcClient(`127.0.0.1:${port2}`), false);

      await syncEngine1.performSync("engine2", clientForServer2);
      await sleepWhile(async () => (await syncEngine1.trie.items()) !== initialEngine2Count + 2, 1000);

      // Now both engines should have the same number of messages and the same root hash
      expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

      clientForServer2.close();
      await server2.stop();
    }
  });

  test("syncEngine syncs with more numMessages and different hashes", async () => {
    await engine1.mergeOnChainEvent(custodyEvent);
    await engine1.mergeOnChainEvent(signerEvent);
    await engine1.mergeOnChainEvent(storageEvent);

    await engine2.mergeOnChainEvent(custodyEvent);
    await engine2.mergeOnChainEvent(signerEvent);
    await engine2.mergeOnChainEvent(storageEvent);

    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
    expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

    // Add two different messages to engine1 and engine2
    await addMessagesWithTimeDelta(engine1, [167, 168]);
    await addMessagesWithTimeDelta(engine2, [169]);

    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Do a sync
    await syncEngine2.performSync("engine1", clientForServer1);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    expect(await syncEngine2.trie.items()).toEqual(6); // Includes on chain events

    // Do a sync the other way
    {
      const server2 = new Server(new MockHub(testDb2, engine2), engine2, syncEngine2);
      const port2 = await server2.start();
      const clientForServer2 = new FailoverStreamSyncClient(getInsecureHubRpcClient(`127.0.0.1:${port2}`), false);

      await syncEngine1.performSync("engine2", clientForServer2);
      await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

      // Now both engines should have the same number of messages and the same root hash
      expect(await syncEngine1.trie.items()).toEqual(await syncEngine2.trie.items());
      expect(await syncEngine1.trie.rootHash()).toEqual(await syncEngine2.trie.rootHash());

      clientForServer2.close();
      await server2.stop();
    }
  });

  test("sync health: basic", async () => {
    const metadataRetriever1 = new SyncEngineMetadataRetriever(hub1, syncEngine1);
    const metadataRetriever2 = new SyncEngineMetadataRetriever(hub2, syncEngine2);

    const syncHealthProbe = new SyncHealthProbe(metadataRetriever1, metadataRetriever2);

    const setupEngine = async (engine: Engine) => {
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(signerEvent);
      await engine.mergeOnChainEvent(storageEvent);
    };

    // Engine1 has no messages
    await setupEngine(engine1);
    await setupEngine(engine2);

    // This is the start time from addMessagesWithTimeDelta
    const farcasterTime = getFarcasterTime()._unsafeUnwrap() - 1000;

    const messages = await addMessagesWithTimeDelta(engine1, [150, 170, 180, 200]);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const start = new Date(fromFarcasterTime(farcasterTime + 150)._unsafeUnwrap());
    const stop = new Date(fromFarcasterTime(farcasterTime + 200)._unsafeUnwrap());

    const messageStats1 = await syncHealthProbe.computeSyncHealthMessageStats(start, stop);

    // This happens because there are no messages under the common prefix for engine2
    expect(messageStats1.isErr());

    await engine2.mergeMessages(messages.slice(0, 2));
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const messageStats2 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    // Query is inclusive of the start time and exclusive of the stop time. We count 150, 170, 180 on engine1 and  150, 170 on engine 2
    expect(messageStats2.primaryNumMessages).toEqual(3);
    expect(messageStats2.peerNumMessages).toEqual(2);

    // Show that pushing diverging sync ids works
    const pushResults2 = (await syncHealthProbe.tryPushingDivergingSyncIds(start, stop, "ToPeer"))._unsafeUnwrap();

    expect(pushResults2.length).toEqual(1);

    // New message that's only on engine 2
    await addMessagesWithTimeDelta(engine2, [185]);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const messageStats3 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    // engine2 has all the messages engine1 has in addition to 185.
    expect(messageStats3.primaryNumMessages).toEqual(3);
    expect(messageStats3.peerNumMessages).toEqual(4);

    // Show that pushing diverging sync ids works
    const pushResults3 = (await syncHealthProbe.tryPushingDivergingSyncIds(start, stop, "FromPeer"))._unsafeUnwrap();

    expect(pushResults3.length).toEqual(1);

    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const messageStats4 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    // engine2 has all the messages engine1 has
    expect(messageStats4.primaryNumMessages).toEqual(4);
    expect(messageStats4.peerNumMessages).toEqual(4);
  });

  test("sync health: push diverging sync ids with a lot of sync ids", async () => {
    const metadataRetriever1 = new SyncEngineMetadataRetriever(hub1, syncEngine1);
    const metadataRetriever2 = new SyncEngineMetadataRetriever(hub2, syncEngine2);

    const syncHealthProbe = new SyncHealthProbe(metadataRetriever1, metadataRetriever2, 10);

    const setupEngine = async (engine: Engine) => {
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(signerEvent);
      await engine.mergeOnChainEvent(storageEvent);
    };

    // Engine1 has no messages
    await setupEngine(engine1);
    await setupEngine(engine2);

    // This is the start time from addMessagesWithTimeDelta
    const startFarcasterTime = getFarcasterTime()._unsafeUnwrap() - 3000;

    const timeDeltas = [];
    for (let j = 0; j < 15; j++) {
      timeDeltas.push(j);
    }

    await addMessagesWithTimeDelta(engine1, timeDeltas, startFarcasterTime);
    await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    // Make the query range wide so that you start on a node with a lot of messages under it.
    const start = new Date(fromFarcasterTime(0)._unsafeUnwrap());
    const stop = new Date(fromFarcasterTime(startFarcasterTime + 50000)._unsafeUnwrap());

    const messageStats1 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    // The 3 comes from custody, signer, storage events
    expect(messageStats1.primaryNumMessages).toEqual(18);
    expect(messageStats1.peerNumMessages).toEqual(3);

    // Show that pushing diverging sync ids works when there are more than 1024 sync ids under a prefix
    const pushResults = (await syncHealthProbe.tryPushingDivergingSyncIds(start, stop, "ToPeer"))._unsafeUnwrap();

    expect(pushResults.length).toEqual(15);
    await sleepWhile(() => syncEngine2.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);

    const messageStats2 = (await syncHealthProbe.computeSyncHealthMessageStats(start, stop))._unsafeUnwrap();

    expect(messageStats2.primaryNumMessages).toEqual(18);
    expect(messageStats2.peerNumMessages).toEqual(18);
  });

  xtest(
    "loads of messages",
    async () => {
      const timedTest = async (fn: () => Promise<void>): Promise<number> => {
        const start = Date.now();
        await fn();
        const end = Date.now();

        const totalTime = (end - start) / 1000;
        return totalTime;
      };

      // Add signer custody event to engine 1
      await engine1.mergeOnChainEvent(custodyEvent);
      await engine1.mergeOnChainEvent(signerEvent);
      await engine1.mergeOnChainEvent(storageEvent);

      // Add loads of messages to engine 1
      let msgTimestamp = 30662167;
      const batchSize = 100;
      const numBatches = 20;

      // Remove a few messages from the previous batch
      let castMessagesToRemove: Message[] = [];

      let totalMessages = 0;

      let totalTime = await timedTest(async () => {
        for (let i = 0; i < numBatches; i++) {
          // Remove a few messages from the previous batch
          const timestampsToRemove = [];
          for (let j = 0; j < castMessagesToRemove.length; j++) {
            timestampsToRemove.push(msgTimestamp + j);
          }

          await removeMessagesWithTsHashes(engine1, castMessagesToRemove);

          msgTimestamp += timestampsToRemove.length;
          totalMessages += timestampsToRemove.length;

          // Add new timestamped messages
          const timestamps = [];
          for (let j = 0; j < batchSize; j++) {
            timestamps.push(msgTimestamp + j);
          }
          // console.log('adding batch', i, ' of ', numBatches);
          const addedMessages = await addMessagesWithTimeDelta(engine1, timestamps);
          await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
          castMessagesToRemove = addedMessages.slice(0, 10);

          msgTimestamp += batchSize;
          totalMessages += batchSize;
        }
        await sleepWhile(() => syncEngine1.syncTrieQSize > 0, SLEEPWHILE_TIMEOUT);
      });
      expect(totalTime).toBeGreaterThan(0);
      expect(totalMessages).toBeGreaterThan(numBatches * batchSize);
      // console.log('Merge total time', totalTime, 'seconds. Messages per second:', totalMessages / totalTime);

      const engine2 = new Engine(testDb2, network);
      const hub2 = new MockHub(testDb2, engine2);
      const syncEngine2 = new SyncEngine(hub2, testDb2, undefined, undefined, undefined, undefined, false);
      syncEngine2.start();

      // Engine 2 should sync with engine1
      expect(
        (await syncEngine2.syncStatus("engine1", (await syncEngine1.getSnapshot())._unsafeUnwrap()))._unsafeUnwrap()
          .shouldSync,
      ).toBeTruthy();

      await engine2.mergeOnChainEvent(custodyEvent);
      await engine2.mergeOnChainEvent(signerEvent);
      await engine2.mergeOnChainEvent(storageEvent);

      // Sync engine 2 with engine 1, and measure the time taken
      totalTime = await timedTest(async () => {
        await syncEngine2.performSync("engine1", clientForServer1);
      });

      expect(totalTime).toBeGreaterThan(0);
      expect(totalMessages).toBeGreaterThan(numBatches * batchSize);
      // console.log('Sync total time', totalTime, 'seconds. Messages per second:', totalMessages / totalTime);

      expect((await syncEngine1.getSnapshot())._unsafeUnwrap().excludedHashes).toEqual(
        (await syncEngine2.getSnapshot())._unsafeUnwrap().excludedHashes,
      );
      expect((await syncEngine1.getSnapshot())._unsafeUnwrap().numMessages).toEqual(
        (await syncEngine2.getSnapshot())._unsafeUnwrap().numMessages,
      );

      // Create a new sync engine from the existing engine, and see if all the messages from the engine
      // are loaded into the sync engine Merkle Trie properly.
      const reinitSyncEngine = new SyncEngine(hub1, testDb1, undefined, undefined, undefined, undefined, false);
      expect(await reinitSyncEngine.trie.rootHash()).toEqual("");

      totalTime = await timedTest(async () => {
        await reinitSyncEngine.start();
      });
      // console.log('MerkleTrie total time', totalTime, 'seconds. Messages per second:', totalMessages / totalTime);

      expect(await reinitSyncEngine.trie.rootHash()).toEqual(await syncEngine1.trie.rootHash());

      await syncEngine2.stop();
      await engine2.stop();
    },
    TEST_TIMEOUT_LONG,
  );
});
