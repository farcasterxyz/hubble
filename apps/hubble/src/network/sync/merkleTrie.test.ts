import { blake3 } from "@noble/hashes/blake3";
import { DbTrieNode, Factories } from "@farcaster/hub-nodejs";
import { EMPTY_HASH, MerkleTrie } from "../sync/merkleTrie.js";
import { NetworkFactories } from "../utils/factories.js";
import { jestRocksDB } from "../../storage/db/jestUtils.js";
import RocksDB from "../../storage/db/rocksdb.js";
import { RootPrefix } from "../../storage/db/types.js";
import { SyncId, TIMESTAMP_LENGTH } from "./syncId.js";
import { jest } from "@jest/globals";

const TEST_TIMEOUT_SHORT = 10 * 1000;
const TEST_TIMEOUT_LONG = 60 * 1000;

const db = jestRocksDB("protobufs.network.merkleTrie.test");
const db2 = jestRocksDB("protobufs.network.merkleTrie2.test");

let trie: MerkleTrie;

describe("MerkleTrie", () => {
  jest.setTimeout(TEST_TIMEOUT_SHORT);

  const trieWithIds = async (timestamps: number[]) => {
    const syncIds = await Promise.all(
      timestamps.map(async (t) => {
        return await NetworkFactories.SyncId.create(undefined, { transient: { date: new Date(t * 1000) } });
      }),
    );

    await trie.clear();
    await Promise.all(syncIds.map((id) => trie.insert(id)));

    return trie;
  };

  const forEachDbItem = async (
    db: RocksDB,
    callback?: (i: number, key: Buffer, value: Buffer) => Promise<void>,
  ): Promise<number> => {
    let count = 0;
    await db.forEachIteratorByPrefix(Buffer.from([RootPrefix.SyncMerkleTrieNode]), async (key, value) => {
      if (callback) {
        await callback(count, key as Buffer, value as Buffer);
      }
      count++;
    });

    return count;
  };

  beforeAll(async () => {
    trie = new MerkleTrie(db);
  });

  beforeEach(async () => {
    await trie.initialize();
    await trie.clear();
  });

  afterEach(async () => {
    await trie.stop();
  });

  describe("insert", () => {
    test("succeeds inserting a single item", async () => {
      const syncId = await NetworkFactories.SyncId.create();

      expect(await trie.items()).toEqual(0);
      expect(await trie.rootHash()).toEqual("");

      await trie.insert(syncId);

      expect(await trie.items()).toEqual(1);
      expect(await trie.rootHash()).toBeTruthy();
    });

    test("inserts are idempotent", async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      expect(await trie.insert(syncId1)).toBeTruthy();
      expect(await trie.insert(syncId2)).toBeTruthy();

      const secondTrie = new MerkleTrie(db2);
      await secondTrie.initialize();
      await secondTrie.clear();

      expect(await secondTrie.insert(syncId2)).toBeTruthy();
      expect(await secondTrie.insert(syncId1)).toBeTruthy();

      // Order does not matter
      expect(await trie.items()).toEqual(await secondTrie.items());
      expect(await trie.rootHash()).toEqual(await secondTrie.rootHash());
      expect(await trie.rootHash()).toBeTruthy();

      // Insert shouldn't error, but return false
      expect(await trie.insert(syncId2)).toBeFalsy();
      expect(await secondTrie.insert(syncId1)).toBeFalsy();

      // Re-adding same item does not change the hash
      expect(await trie.rootHash()).toEqual(await secondTrie.rootHash());
      expect(await trie.items()).toEqual(await secondTrie.items());
      expect(await trie.items()).toEqual(2);

      await secondTrie.stop();
    });

    test(
      "insert multiple items out of order results in the same root hash",
      async () => {
        const syncIds = await NetworkFactories.SyncId.createList(25);

        const secondTrie = new MerkleTrie(db2);
        await secondTrie.initialize();
        await secondTrie.clear();

        await Promise.all(syncIds.map(async (syncId) => trie.insert(syncId)));
        const shuffledIds = syncIds.sort(() => 0.5 - Math.random());
        await Promise.all(shuffledIds.map(async (syncId) => secondTrie.insert(syncId)));

        expect(await trie.rootHash()).toEqual(await secondTrie.rootHash());
        expect(await trie.rootHash()).toBeTruthy();
        expect(await trie.items()).toEqual(await secondTrie.items());
        expect(await trie.items()).toEqual(25);

        await secondTrie.stop();
      },
      TEST_TIMEOUT_LONG,
    );

    test("inserting multiple items that differ by one byte succeeds", async () => {
      const event1 = Factories.IdRegistryOnChainEvent.build();
      const event2 = Factories.IdRegistryOnChainEvent.build({
        blockNumber: event1.blockNumber,
        blockTimestamp: event1.blockTimestamp,
        fid: event1.fid,
        txIndex: event1.txIndex,
        // make sure only last byte is different
        logIndex: event1.logIndex + (event1.logIndex % 256 === 255 ? -1 : +1),
      });
      const syncId1 = SyncId.fromOnChainEvent(event1);
      const syncId2 = SyncId.fromOnChainEvent(event2);
      const idLength = syncId1.syncId().length;

      expect(syncId1.syncId()).not.toEqual(syncId2.syncId());
      expect(syncId1.syncId().length).toEqual(syncId2.syncId().length);
      expect(syncId1.syncId().slice(0, idLength - 1)).toEqual(syncId2.syncId().slice(0, idLength - 1));

      expect(await trie.insert(syncId1)).toBeTruthy();
      expect(await trie.insert(syncId2)).toBeTruthy();

      expect(await trie.exists(syncId1)).toBeTruthy();
      expect(await trie.exists(syncId2)).toBeTruthy();

      await trie.delete(syncId1);

      expect(await trie.exists(syncId1)).toBeFalsy();
      expect(await trie.exists(syncId2)).toBeTruthy();

      await trie.delete(syncId2);

      expect(await trie.exists(syncId1)).toBeFalsy();
      expect(await trie.exists(syncId2)).toBeFalsy();
    });

    test(
      "inserting multiple doesn't cause unload conflict",
      async () => {
        const syncIds = await NetworkFactories.SyncId.createList(500);

        await Promise.all(syncIds.map(async (syncId) => trie.insert(syncId)));

        expect(await trie.items()).toEqual(500);
      },
      TEST_TIMEOUT_LONG,
    );

    test("insert also inserts into the db", async () => {
      const dt = new Date();
      const syncId = await NetworkFactories.SyncId.create(undefined, { transient: { date: dt } });
      const syncIdStr = Buffer.from(syncId.syncId()).toString("hex");

      await trie.insert(syncId);
      expect(await trie.exists(syncId)).toBeTruthy();
      await trie.commitToDb();

      let leafs = 0;
      let count = await forEachDbItem(trie.getDb(), async (i, key, value) => {
        expect(key.slice(1).toString("hex")).toEqual(syncIdStr.slice(0, i * 2));

        // Parse the value as a DbTriNode
        const node = DbTrieNode.decode(value);

        // The last key should be the leaf node, so it's value should match the entire syncID
        if (i === TIMESTAMP_LENGTH) {
          expect(Buffer.from(node.key).toString("hex")).toEqual(syncIdStr);
        }

        if (node.key.length > 0) {
          leafs += 1;
        }
      });

      // Expect 1 node for each timestamp level + root prefix
      expect(count).toEqual(1 + TIMESTAMP_LENGTH);
      expect(leafs).toEqual(1);

      // Add another item
      const syncId2 = await NetworkFactories.SyncId.create(undefined, { transient: { date: dt } });
      expect(await trie.insert(syncId2)).toBeTruthy();
      expect(await trie.exists(syncId2)).toBeTruthy();
      await trie.commitToDb();

      leafs = 0;
      count = await forEachDbItem(trie.getDb(), async (_i, _key, value) => {
        // Parse the value as a DbTriNode
        const node = DbTrieNode.decode(value);
        if (node.key.length > 0) {
          leafs += 1;
        }
      });

      expect(leafs).toEqual(2);

      const rootHash = await trie.rootHash();

      // Unload the trie
      await trie.unloadChildrenAtRoot();

      // Expect the root hash to be the same
      expect(await trie.rootHash()).toEqual(rootHash);
      expect(await trie.items()).toEqual(2);
    });

    test(
      "Load trie from DB",
      async () => {
        const syncIds = await NetworkFactories.SyncId.createList(20);
        await Promise.all(syncIds.map(async (syncId) => await trie.insert(syncId)));
        await trie.commitToDb();

        // Now initialize a new merkle trie from the same DB
        const trie2 = new MerkleTrie(db, trie.getDb());
        await trie2.initialize();

        // expect the root hashes to be the same
        expect(await trie.rootHash()).toEqual(await trie2.rootHash());
        expect(await trie.items()).toEqual(await trie2.items());

        // expect all the items to be in the trie
        await Promise.all(syncIds.map(async (syncId) => expect(await trie2.exists(syncId)).toBeTruthy()));
        await trie2.stop();

        // Delete half the items from the first trie
        await Promise.all(syncIds.slice(0, syncIds.length / 2).map(async (syncId) => trie.delete(syncId)));
        await trie.commitToDb();

        // Initialize a new trie from the same DB
        const trie3 = new MerkleTrie(db, trie.getDb());
        await trie3.initialize();

        // expect the root hashes to be the same
        expect(await trie.rootHash()).toEqual(await trie3.rootHash());
        expect(await trie.items()).toEqual(await trie3.items());

        // Expect that the deleted items are not present
        await Promise.all(
          syncIds.slice(0, syncIds.length / 2).map(async (syncId) => expect(await trie3.exists(syncId)).toBeFalsy()),
        );

        // expect all the items to be in the trie
        await Promise.all(
          syncIds.slice(syncIds.length / 2).map(async (syncId) => expect(await trie3.exists(syncId)).toBeTruthy()),
        );
        await trie3.stop();
      },
      TEST_TIMEOUT_LONG,
    );
  });

  describe("delete", () => {
    test("deletes an item", async () => {
      const syncId = await NetworkFactories.SyncId.create();

      await trie.insert(syncId);
      expect(await trie.items()).toEqual(1);
      expect(await trie.rootHash()).toBeTruthy();

      expect(await trie.exists(syncId)).toBeTruthy();

      await trie.delete(syncId);
      expect(await trie.items()).toEqual(0);
      expect(await trie.rootHash()).toEqual(EMPTY_HASH);

      expect(await trie.exists(syncId)).toBeFalsy();
    });

    test("deleting an item that does not exist does not change the trie", async () => {
      const syncId = await NetworkFactories.SyncId.create();
      expect(await trie.insert(syncId)).toBeTruthy();

      const rootHashBeforeDelete = await trie.rootHash();
      const syncId2 = await NetworkFactories.SyncId.create();
      expect(await trie.delete(syncId2)).toBeFalsy();

      const rootHashAfterDelete = await trie.rootHash();
      expect(rootHashAfterDelete).toEqual(rootHashBeforeDelete);
      expect(await trie.items()).toEqual(1);
    });

    test("delete is an exact inverse of insert", async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      await trie.insert(syncId1);
      const rootHashBeforeDelete = await trie.rootHash();
      await trie.insert(syncId2);

      await trie.delete(syncId2);
      expect(await trie.rootHash()).toEqual(rootHashBeforeDelete);
    });

    test("trie with a deleted item is the same as a trie with the item never added", async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      await trie.insert(syncId1);
      await trie.insert(syncId2);

      await trie.delete(syncId1);

      const secondTrie = new MerkleTrie(db2);
      await secondTrie.initialize();
      await secondTrie.clear();
      await secondTrie.insert(syncId2);

      expect(await trie.rootHash()).toEqual(await secondTrie.rootHash());
      expect(await trie.rootHash()).toBeTruthy();
      expect(await trie.items()).toEqual(await secondTrie.items());
      expect(await trie.items()).toEqual(1);

      await secondTrie.stop();
    });

    test("Deleting single node deletes all nodes from the DB", async () => {
      const id = await NetworkFactories.SyncId.create();

      await trie.insert(id);
      await trie.commitToDb();
      expect(await trie.items()).toEqual(1);

      let count = await forEachDbItem(trie.getDb());
      expect(count).toEqual(1 + TIMESTAMP_LENGTH);

      // Delete
      await trie.delete(id);
      await trie.commitToDb();

      count = await forEachDbItem(trie.getDb());
      expect(count).toEqual(0);
    });

    test("Deleting one of two nodes leaves only 1 item in the DB", async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      await trie.insert(syncId1);
      await trie.insert(syncId2);
      await trie.commitToDb();

      let count = await forEachDbItem(trie.getDb());
      expect(count).toBeGreaterThan(1 + TIMESTAMP_LENGTH);

      // Delete
      await trie.delete(syncId1);
      await trie.commitToDb();

      count = await forEachDbItem(trie.getDb());
      expect(count).toEqual(1 + TIMESTAMP_LENGTH);
    });

    test("succeeds with single item", async () => {
      const syncId = await NetworkFactories.SyncId.create();

      expect(await trie.exists(syncId)).toBeFalsy();

      await trie.insert(syncId);

      expect(await trie.exists(syncId)).toBeTruthy();

      const nonExistingSyncId = await NetworkFactories.SyncId.create();

      expect(await trie.exists(nonExistingSyncId)).toBeFalsy();
    });

    test("test multiple items with delete", async () => {
      const syncIds = await NetworkFactories.SyncId.createList(20);

      await Promise.all(syncIds.map(async (syncId) => trie.insert(syncId)));

      // Delete half of the items
      await Promise.all(syncIds.slice(0, syncIds.length / 2).map(async (syncId) => trie.delete(syncId)));

      // Check that the items are still there
      await Promise.all(
        syncIds.slice(0, syncIds.length / 2).map(async (syncId) => expect(await trie.exists(syncId)).toBeFalsy()),
      );
      await Promise.all(
        syncIds.slice(syncIds.length / 2).map(async (syncId) => {
          expect(await trie.exists(syncId)).toBeTruthy();
        }),
      );
    });

    test(
      "test multiple insert + delete",
      async () => {
        const syncIds1 = await NetworkFactories.SyncId.createList(100);
        const syncIds2 = await NetworkFactories.SyncId.createList(100);

        await Promise.all(syncIds1.map(async (syncId) => trie.insert(syncId)));

        // Delete half of the items
        const deletePromise = Promise.all(
          syncIds1.slice(0, syncIds1.length / 2).map(async (syncId) => trie.delete(syncId)),
        );
        const insert2Promise = Promise.all(syncIds2.map(async (syncId) => trie.insert(syncId)));
        const existPromise = await Promise.all(
          syncIds1.slice(syncIds1.length / 2).map(async (syncId) => {
            expect(await trie.exists(syncId)).toBeTruthy();
          }),
        );
        await Promise.all([deletePromise, insert2Promise, existPromise]);

        // Check that the items are still there
        const exist1 = Promise.all(
          syncIds1.slice(0, syncIds1.length / 2).map(async (syncId) => expect(await trie.exists(syncId)).toBeFalsy()),
        );
        const exist2 = await Promise.all(
          syncIds1.slice(syncIds1.length / 2).map(async (syncId) => {
            expect(await trie.exists(syncId)).toBeTruthy();
          }),
        );
        const exist3 = await Promise.all(
          syncIds2.map(async (syncId) => {
            expect(await trie.exists(syncId)).toBeTruthy();
          }),
        );

        await Promise.all([exist1, exist2, exist3]);
      },
      TEST_TIMEOUT_LONG,
    );

    test("delete after loading from DB", async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      await trie.insert(syncId1);
      await trie.insert(syncId2);
      await trie.commitToDb();

      const rootHash = await trie.rootHash();

      const trie2 = new MerkleTrie(db, trie.getDb());
      await trie2.initialize();

      expect(await trie2.rootHash()).toEqual(rootHash);

      expect(await trie2.delete(syncId1)).toBeTruthy();

      expect(await trie2.rootHash()).not.toEqual(rootHash);
      expect(await trie2.exists(syncId1)).toBeFalsy();
      expect(await trie2.exists(syncId2)).toBeTruthy();

      await trie2.stop();
    });

    test("delete after unloading some nodes", async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      await trie.insert(syncId1);
      await trie.insert(syncId2);

      const rootHash = await trie.rootHash();

      // Unload all the children of the first node
      await trie.unloadChildrenAtRoot();

      // Now try deleting syncId1
      expect(await trie.delete(syncId1)).toBeTruthy();
      await trie.commitToDb();

      expect(await trie.rootHash()).not.toEqual(rootHash);
      expect(await trie.exists(syncId1)).toBeFalsy();
      expect(await trie.exists(syncId2)).toBeTruthy();

      // Ensure the trie was compacted
      expect(await forEachDbItem(trie.getDb())).toEqual(1 + TIMESTAMP_LENGTH);
    });
  });

  describe("getNodeMetadata", () => {
    test("returns undefined if prefix is not present", async () => {
      const syncId = await NetworkFactories.SyncId.create(undefined, { transient: { date: new Date(1665182332000) } });

      await trie.insert(syncId);

      expect(await trie.getTrieNodeMetadata(new Uint8Array(Buffer.from("166518234")))).toBeUndefined();
    });

    test("returns the root metadata if the prefix is empty", async () => {
      const syncId = await NetworkFactories.SyncId.create(undefined, { transient: { date: new Date(1665182332000) } });

      await trie.insert(syncId);

      const nodeMetadata = await trie.getTrieNodeMetadata(new Uint8Array());
      expect(nodeMetadata).toBeDefined();
      expect(nodeMetadata?.numMessages).toEqual(1);
      expect(nodeMetadata?.prefix).toEqual(new Uint8Array());
      expect(nodeMetadata?.children?.size).toEqual(1);
      expect(nodeMetadata?.children?.get(syncId.syncId()[0] as number)).toBeDefined();
    });

    test("returns the correct metadata if prefix is present", async () => {
      const trie = await trieWithIds([1665182332, 1665182343]);
      const nodeMetadata = await trie.getTrieNodeMetadata(new Uint8Array(Buffer.from("16651823")));

      expect(nodeMetadata).toBeDefined();
      expect(nodeMetadata?.numMessages).toEqual(2);
      expect(nodeMetadata?.prefix).toEqual(new Uint8Array(Buffer.from("16651823")));
      expect(nodeMetadata?.children?.size).toEqual(2);
      expect(nodeMetadata?.children?.get(new Uint8Array(Buffer.from("3"))[0] as number)).toBeDefined();
      expect(nodeMetadata?.children?.get(new Uint8Array(Buffer.from("4"))[0] as number)).toBeDefined();
    });
  });

  describe("getSnapshot", () => {
    test("returns basic information", async () => {
      const trie = await trieWithIds([1665182332, 1665182343]);

      const snapshot = await trie.getSnapshot(new Uint8Array(Buffer.from("1665182343")));
      expect(snapshot.prefix).toEqual(new Uint8Array(Buffer.from("1665182343")));
      expect(snapshot.numMessages).toEqual(1);
      expect(snapshot.excludedHashes.length).toEqual("1665182343".length + 1);
    });

    test("returns early when prefix is only partially present", async () => {
      const trie = await trieWithIds([1665182332, 1665182343]);

      const snapshot = await trie.getSnapshot(new Uint8Array(Buffer.from("1677123")));
      expect(snapshot.prefix).toEqual(new Uint8Array(Buffer.from("16")));
      expect(snapshot.numMessages).toEqual(2);
      expect(snapshot.excludedHashes.length).toEqual("16".length + 1);

      const snapshot2 = await trie.getSnapshot(new Uint8Array(Buffer.from("167")));
      expect(snapshot2.prefix).toEqual(new Uint8Array(Buffer.from("16")));
      expect(snapshot2.numMessages).toEqual(2);
      expect(snapshot2.excludedHashes.length).toEqual("16".length + 1);

      const snapshot3 = await trie.getSnapshot(new Uint8Array(Buffer.from("16")));
      expect(snapshot3.prefix).toEqual(new Uint8Array(Buffer.from("16")));
      expect(snapshot3.numMessages).toEqual(0);
      expect(snapshot3.excludedHashes.length).toEqual("16".length + 1);

      const snapshot4 = await trie.getSnapshot(new Uint8Array(Buffer.from("222")));
      expect(snapshot4.prefix).toEqual(new Uint8Array(Buffer.from("")));
      expect(snapshot4.numMessages).toEqual(2);
      expect(snapshot4.excludedHashes.length).toEqual("".length + 1);
    });

    test("excluded hashes excludes the prefix char at every level", async () => {
      const trie = await trieWithIds([1665182332, 1665182343, 1665182345, 1665182351]);
      let snapshot = await trie.getSnapshot(new Uint8Array(Buffer.from("1665182351")));
      let node = await trie.getTrieNodeMetadata(new Uint8Array(Buffer.from("16651823")));
      // We expect the excluded hash to be the hash of the 3 and 4 child nodes, and excludes the 5 child node
      const expectedHash = Buffer.from(
        blake3
          .create({ dkLen: 20 })
          .update(Buffer.from(node?.children?.get(new Uint8Array(Buffer.from("3"))[0] as number)?.hash || "", "hex"))
          .update(Buffer.from(node?.children?.get(new Uint8Array(Buffer.from("4"))[0] as number)?.hash || "", "hex"))
          .digest(),
      ).toString("hex");
      let leafHash = (await trie.getTrieNodeMetadata(new Uint8Array(Buffer.from("1665182351"))))?.hash;
      expect(snapshot.excludedHashes).toEqual([
        EMPTY_HASH, // 1, these are empty because there are no other children at this level
        EMPTY_HASH, // 6
        EMPTY_HASH, // 6
        EMPTY_HASH, // 5
        EMPTY_HASH, // 1
        EMPTY_HASH, // 8
        EMPTY_HASH, // 2
        EMPTY_HASH, // 3
        expectedHash, // 5 (hash of the 3 and 4 child node hashes)
        EMPTY_HASH, // 1
        leafHash,
      ]);

      snapshot = await trie.getSnapshot(new Uint8Array(Buffer.from("1665182343")));
      node = await trie.getTrieNodeMetadata(new Uint8Array(Buffer.from("166518234")));
      const expectedLastHash = Buffer.from(
        blake3(Buffer.from(node?.children?.get(new Uint8Array(Buffer.from("5"))[0] as number)?.hash || "", "hex"), {
          dkLen: 20,
        }),
      ).toString("hex");
      node = await trie.getTrieNodeMetadata(new Uint8Array(Buffer.from("16651823")));
      const expectedPenultimateHash = Buffer.from(
        blake3
          .create({ dkLen: 20 })
          .update(Buffer.from(node?.children?.get(new Uint8Array(Buffer.from("3"))[0] as number)?.hash || "", "hex"))
          .update(Buffer.from(node?.children?.get(new Uint8Array(Buffer.from("5"))[0] as number)?.hash || "", "hex"))
          .digest(),
      ).toString("hex");
      leafHash = (await trie.getTrieNodeMetadata(new Uint8Array(Buffer.from("1665182343"))))?.hash;
      expect(snapshot.excludedHashes).toEqual([
        EMPTY_HASH, // 1
        EMPTY_HASH, // 6
        EMPTY_HASH, // 6
        EMPTY_HASH, // 5
        EMPTY_HASH, // 1
        EMPTY_HASH, // 8
        EMPTY_HASH, // 2
        EMPTY_HASH, // 3
        expectedPenultimateHash, // 4 (hash of the 3 and 5 child node hashes)
        expectedLastHash, // 3 (hash of the 5 child node hash)
        leafHash,
      ]);
    });
  });

  test("getAllValues returns all values for child nodes directly", async () => {
    const trie = await trieWithIds([1665182332, 1665182343, 1665182345]);

    let values = await trie.getAllValues(new Uint8Array(Buffer.from("16651823")));
    expect(values?.length).toEqual(3);
    values = await trie.getAllValues(new Uint8Array(Buffer.from("166518233")));
    expect(values?.length).toEqual(1);
  });

  test("getAllValues returns all values for child nodes after unloadChildren", async () => {
    const trie = await trieWithIds([1665182332, 1665182343, 1665182345]);

    // Unload all the children of the first node
    await trie.unloadChildrenAtRoot();

    let values = await trie.getAllValues(new Uint8Array(Buffer.from("16651823")));
    expect(values?.length).toEqual(3);
    values = await trie.getAllValues(new Uint8Array(Buffer.from("166518233")));
    expect(values?.length).toEqual(1);
  });
});
