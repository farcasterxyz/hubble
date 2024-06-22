import {
  bytesDecrement,
  bytesIncrement,
  Factories,
  getDefaultStoreLimit,
  getFarcasterTime,
  HubError,
  LinkAddMessage,
  LinkBody,
  LinkRemoveMessage,
  MergeMessageHubEvent,
  Message,
  MessageType,
  PruneMessageHubEvent,
  RevokeMessageHubEvent,
  StoreType,
} from "@farcaster/hub-nodejs";
import { err, ok } from "neverthrow";
import { jestRocksDB } from "../db/jestUtils.js";
import {
  getMessage,
  makeFidKey,
  makeMessagePrimaryKeyFromMessage,
  makeTsHash,
  makeUserKey,
  putMessageTransaction,
} from "../db/message.js";
import { UserPostfix } from "../db/types.js";
import LinkStore from "./linkStore.js";
import StoreEventHandler from "./storeEventHandler.js";
import { putOnChainEventTransaction } from "../db/onChainEvent.js";

const db = jestRocksDB("protobufs.linkStore.test");
const eventHandler = new StoreEventHandler(db);
const set = new LinkStore(db, eventHandler);
const fid = Factories.Fid.build();
const targetFid = fid + 1;

let linkAdd: LinkAddMessage;
let linkRemove: LinkRemoveMessage;
let linkAddEndorse: LinkAddMessage;
let linkRemoveEndorse: LinkRemoveMessage;

beforeAll(async () => {
  const linkBody = Factories.LinkBody.build({
    type: "follow",
    targetFid: targetFid,
  });

  linkAdd = await Factories.LinkAddMessage.create({
    data: { fid, linkBody },
  });

  linkRemove = await Factories.LinkRemoveMessage.create({
    data: { fid, linkBody, timestamp: linkAdd.data.timestamp + 1 },
  });

  const endorseBody = Factories.LinkBody.build({
    type: "endorse",
    targetFid: targetFid,
  });

  linkAddEndorse = await Factories.LinkAddMessage.create({
    data: { fid, linkBody: endorseBody, timestamp: linkAdd.data.timestamp + 1 },
  });

  linkRemoveEndorse = await Factories.LinkRemoveMessage.create({
    data: { fid, linkBody: endorseBody, timestamp: linkAddEndorse.data.timestamp + 1 },
  });
  const rent = Factories.StorageRentOnChainEvent.build({ fid }, { transient: { units: 1 } });
  await db.commit(putOnChainEventTransaction(db.transaction(), rent));
});

beforeEach(async () => {
  await eventHandler.syncCache();
});

describe("getLinkAdd", () => {
  test("fails if no LinkAdd is present", async () => {
    await expect(set.getLinkAdd(fid, linkAdd.data.linkBody.type, targetFid)).rejects.toThrow(HubError);
  });

  test("fails if only LinkRemove exists for the target", async () => {
    await set.merge(linkRemove);
    await expect(set.getLinkAdd(fid, linkAdd.data.linkBody.type, targetFid)).rejects.toThrow(HubError);
  });

  test("fails if the wrong fid is provided", async () => {
    const unknownFid = Factories.Fid.build();
    await set.merge(linkAdd);
    await expect(set.getLinkAdd(unknownFid, linkAdd.data.linkBody.type, targetFid)).rejects.toThrow(HubError);
  });

  test("fails if the wrong link type is provided", async () => {
    await set.merge(linkAdd);
    await expect(set.getLinkAdd(fid, "endorse", targetFid)).rejects.toThrow(HubError);
  });

  test("fails if the wrong target is provided", async () => {
    await set.merge(linkAdd);
    const unknownFid = Factories.Fid.build();
    await expect(set.getLinkAdd(fid, linkAdd.data.linkBody.type, unknownFid)).rejects.toThrow(HubError);
  });

  test("returns message if it exists for the target", async () => {
    await set.merge(linkAdd);
    await expect(set.getLinkAdd(fid, linkAdd.data.linkBody.type, targetFid)).resolves.toEqual(linkAdd);
  });
});

describe("getLinkRemove", () => {
  test("fails if no LinkRemove is present", async () => {
    await expect(set.getLinkRemove(fid, linkRemove.data.linkBody.type, targetFid)).rejects.toThrow(HubError);
  });

  test("fails if only LinkAdd exists for the target", async () => {
    await set.merge(linkAdd);
    await expect(set.getLinkRemove(fid, linkAdd.data.linkBody.type, targetFid)).rejects.toThrow(HubError);
  });

  test("fails if the wrong fid is provided", async () => {
    await set.merge(linkRemove);
    const unknownFid = Factories.Fid.build();
    await expect(set.getLinkRemove(unknownFid, linkRemove.data.linkBody.type, targetFid)).rejects.toThrow(HubError);
  });

  test("fails if the wrong link type is provided", async () => {
    await set.merge(linkRemove);
    await expect(set.getLinkRemove(fid, "endorse", targetFid)).rejects.toThrow(HubError);
  });

  test("fails if the wrong target is provided", async () => {
    await set.merge(linkRemove);
    const unknownFid = Factories.Fid.build();
    await expect(set.getLinkRemove(fid, linkRemove.data.linkBody.type, unknownFid)).rejects.toThrow(HubError);
  });

  test("returns message if it exists for the target", async () => {
    await set.merge(linkRemove);
    await expect(set.getLinkRemove(fid, linkRemove.data.linkBody.type, targetFid)).resolves.toEqual(linkRemove);
  });
});

describe("getLinkAddsByFid", () => {
  test("returns LinkAdd messages in chronological order according to pageOptions", async () => {
    const linkAdd2 = await Factories.LinkAddMessage.create({
      data: { fid, timestamp: linkAdd.data.timestamp + 2 },
    });
    await set.merge(linkAdd2);
    await set.merge(linkAdd);
    await set.merge(linkAddEndorse);
    await expect(set.getLinkAddsByFid(fid)).resolves.toEqual({
      messages: [linkAdd, linkAddEndorse, linkAdd2],
      nextPageToken: undefined,
    });

    const results1 = await set.getLinkAddsByFid(fid, undefined, { pageSize: 1 });
    expect(results1.messages).toEqual([linkAdd]);

    const results2 = await set.getLinkAddsByFid(fid, undefined, { pageToken: results1.nextPageToken });
    expect(results2).toEqual({ messages: [linkAddEndorse, linkAdd2], nextPageToken: undefined });
  });

  test("returns LinkAdd messages by type", async () => {
    await set.merge(linkAdd);
    await set.merge(linkAddEndorse);
    await expect(set.getLinkAddsByFid(fid, "follow")).resolves.toEqual({
      messages: [linkAdd],
      nextPageToken: undefined,
    });
    await expect(set.getLinkAddsByFid(fid, "endorse")).resolves.toEqual({
      messages: [linkAddEndorse],
      nextPageToken: undefined,
    });
  });

  test("returns empty array if no LinkAdd exists", async () => {
    await expect(set.getLinkAddsByFid(fid)).resolves.toEqual({ messages: [], nextPageToken: undefined });
  });

  test("returns empty array if no LinkAdd exists, even if LinkRemove exists", async () => {
    await set.merge(linkRemove);
    await expect(set.getLinkAddsByFid(fid)).resolves.toEqual({ messages: [], nextPageToken: undefined });
  });
});

describe("getLinkRemovesByFid", () => {
  test("returns LinkRemove if it exists", async () => {
    await set.merge(linkRemove);
    await set.merge(linkRemoveEndorse);
    await expect(set.getLinkRemovesByFid(fid)).resolves.toEqual({
      messages: [linkRemove, linkRemoveEndorse],
      nextPageToken: undefined,
    });
  });

  test("returns empty array if no LinkRemove exists", async () => {
    await expect(set.getLinkRemovesByFid(fid)).resolves.toEqual({ messages: [], nextPageToken: undefined });
  });

  test("returns empty array if no LinkRemove exists, even if LinkAdds exists", async () => {
    await set.merge(linkAdd);
    await expect(set.getLinkRemovesByFid(fid)).resolves.toEqual({ messages: [], nextPageToken: undefined });
  });
});

describe("getAllLinkMessagesByFid", () => {
  test("returns LinkRemove if it exists", async () => {
    await set.merge(linkAdd);
    await set.merge(linkRemoveEndorse);
    await expect(set.getAllLinkMessagesByFid(fid)).resolves.toEqual({
      messages: [linkAdd, linkRemoveEndorse],
      nextPageToken: undefined,
    });
  });

  test("returns empty array if no messages exist", async () => {
    await expect(set.getAllLinkMessagesByFid(fid)).resolves.toEqual({ messages: [], nextPageToken: undefined });
  });
});

describe("getLinksByTarget", () => {
  test("returns empty array if no links exist", async () => {
    const byFid = await set.getLinksByTarget(targetFid);
    expect(byFid).toEqual({ messages: [], nextPageToken: undefined });
  });

  test("returns links if they exist for a target in chronological order and according to pageOptions", async () => {
    const linkSameTarget = await Factories.LinkAddMessage.create({
      data: { timestamp: linkAddEndorse.data.timestamp + 1, linkBody: { targetFid: targetFid } },
    });
    await set.merge(linkAdd);
    await set.merge(linkAddEndorse);
    await set.merge(linkSameTarget);

    const byFid = await set.getLinksByTarget(targetFid);
    expect(byFid).toEqual({
      messages: [linkAdd, linkAddEndorse, linkSameTarget],
      nextPageToken: undefined,
    });

    const results1 = await set.getLinksByTarget(targetFid, undefined, { pageSize: 1 });
    expect(results1.messages).toEqual([linkAdd]);

    const results2 = await set.getLinksByTarget(targetFid, undefined, { pageToken: results1.nextPageToken });
    expect(results2).toEqual({ messages: [linkAddEndorse, linkSameTarget], nextPageToken: undefined });

    const results3 = await set.getLinksByTarget(targetFid, undefined, { reverse: true });
    expect(results3).toEqual({
      messages: [linkSameTarget, linkAddEndorse, linkAdd],
      nextPageToken: undefined,
    });
  });

  test("returns empty array if links exist for a different target", async () => {
    await set.merge(linkAdd);

    const unknownFid = Factories.Fid.build();
    const byFid = await set.getLinksByTarget(unknownFid);
    expect(byFid).toEqual({ messages: [], nextPageToken: undefined });
  });

  describe("with type", () => {
    test("returns empty array if no links exist", async () => {
      const byFid = await set.getLinksByTarget(targetFid, "follow");
      expect(byFid).toEqual({ messages: [], nextPageToken: undefined });
    });

    test("returns empty array if links exist for the target with different type", async () => {
      await set.merge(linkAddEndorse);
      const byFid = await set.getLinksByTarget(targetFid, "follow");
      expect(byFid).toEqual({ messages: [], nextPageToken: undefined });
    });

    test("returns empty array if links exist for the type with different target", async () => {
      await set.merge(linkAdd);
      const unknownFid = Factories.Fid.build();
      const byFid = await set.getLinksByTarget(unknownFid, "follow");
      expect(byFid).toEqual({ messages: [], nextPageToken: undefined });
    });

    test("returns links if they exist for the target and type", async () => {
      const linkLike2 = await Factories.LinkAddMessage.create({
        data: {
          fid: fid + 2,
          timestamp: linkAddEndorse.data.timestamp + 1,
          linkBody: { type: "follow", targetFid: targetFid },
        },
      });
      await set.merge(linkLike2);
      await set.merge(linkAdd);
      await set.merge(linkAddEndorse);
      const results1 = await set.getLinksByTarget(targetFid, "follow");
      expect(results1).toEqual({ messages: [linkAdd, linkLike2], nextPageToken: undefined });

      const results2 = await set.getLinksByTarget(targetFid, "follow", {
        reverse: true,
        pageSize: 1,
      });
      expect(results2.messages).toEqual([linkLike2]);

      const results3 = await set.getLinksByTarget(targetFid, "follow", {
        reverse: true,
        pageToken: results2.nextPageToken,
      });
      expect(results3).toEqual({ messages: [linkAdd], nextPageToken: undefined });

      const results4 = await set.getLinksByTarget(targetFid, "endorse");
      expect(results4).toEqual({ messages: [linkAddEndorse], nextPageToken: undefined });
    });
  });
});

describe("merge", () => {
  let mergeEvents: [Message | undefined, Message[]][] = [];

  const mergeMessageHandler = (event: MergeMessageHubEvent) => {
    const { message, deletedMessages } = event.mergeMessageBody;
    mergeEvents.push([message, deletedMessages ?? []]);
  };

  beforeAll(() => {
    eventHandler.on("mergeMessage", mergeMessageHandler);
  });

  beforeEach(() => {
    mergeEvents = [];
  });

  afterAll(() => {
    eventHandler.off("mergeMessage", mergeMessageHandler);
  });

  const assertLinkExists = async (message: LinkAddMessage | LinkRemoveMessage) => {
    const tsHash = makeTsHash(message.data.timestamp, message.hash)._unsafeUnwrap();
    await expect(getMessage(db, fid, UserPostfix.LinkMessage, tsHash)).resolves.toEqual(message);
  };

  const assertLinkDoesNotExist = async (message: LinkAddMessage | LinkRemoveMessage) => {
    const tsHash = makeTsHash(message.data.timestamp, message.hash)._unsafeUnwrap();
    await expect(getMessage(db, fid, UserPostfix.LinkMessage, tsHash)).rejects.toThrow(HubError);
  };

  const assertLinkAddWins = async (message: LinkAddMessage) => {
    await assertLinkExists(message);
    await expect(
      set.getLinkAdd(fid, message.data.linkBody.type, message.data.linkBody.targetFid as number),
    ).resolves.toEqual(message);
    await expect(set.getLinksByTarget(message.data.linkBody.targetFid as number)).resolves.toEqual({
      messages: [message],
      nextPageToken: undefined,
    });
    await expect(
      set.getLinkRemove(fid, message.data.linkBody.type, message.data.linkBody.targetFid as number),
    ).rejects.toThrow(HubError);
  };

  const assertLinkRemoveWins = async (message: LinkRemoveMessage) => {
    await assertLinkExists(message);
    await expect(
      set.getLinkRemove(fid, message.data.linkBody.type, message.data.linkBody.targetFid as number),
    ).resolves.toEqual(message);
    await expect(set.getLinksByTarget(message.data.linkBody.targetFid as number)).resolves.toEqual({
      messages: [],
      nextPageToken: undefined,
    });
    await expect(
      set.getLinkAdd(fid, linkAdd.data.linkBody.type, message.data.linkBody.targetFid as number),
    ).rejects.toThrow(HubError);
  };

  test("fails with invalid message type", async () => {
    const message = await Factories.CastAddMessage.create();
    await expect(set.merge(message)).rejects.toThrow(HubError);
  });

  describe("LinkAdd", () => {
    test("succeeds", async () => {
      await expect(set.merge(linkAdd)).resolves.toBeGreaterThan(0);

      await assertLinkAddWins(linkAdd);

      expect(mergeEvents).toEqual([[linkAdd, []]]);
    });

    test("fails if merged twice", async () => {
      await expect(set.merge(linkAdd)).resolves.toBeGreaterThan(0);
      await expect(set.merge(linkAdd)).rejects.toEqual(
        new HubError("bad_request.duplicate", "message has already been merged"),
      );

      await assertLinkAddWins(linkAdd);

      expect(mergeEvents).toEqual([[linkAdd, []]]);
    });

    describe("with a conflicting LinkAdd with different timestamps", () => {
      let linkAddLater: LinkAddMessage;

      beforeAll(async () => {
        linkAddLater = await Factories.LinkAddMessage.create({
          data: { ...linkAdd.data, timestamp: linkAdd.data.timestamp + 1 },
        });
      });

      test("succeeds with a later timestamp", async () => {
        await set.merge(linkAdd);
        await expect(set.merge(linkAddLater)).resolves.toBeGreaterThan(0);

        await assertLinkDoesNotExist(linkAdd);
        await assertLinkAddWins(linkAddLater);

        expect(mergeEvents).toEqual([
          [linkAdd, []],
          [linkAddLater, [linkAdd]],
        ]);
      });

      test("fails with an earlier timestamp", async () => {
        await set.merge(linkAddLater);
        await expect(set.merge(linkAdd)).rejects.toEqual(
          new HubError("bad_request.conflict", "message conflicts with a more recent add"),
        );

        await assertLinkDoesNotExist(linkAdd);
        await assertLinkAddWins(linkAddLater);
      });
    });

    describe("with a conflicting LinkAdd with identical timestamps", () => {
      let linkAddLater: LinkAddMessage;

      beforeAll(async () => {
        linkAddLater = await Factories.LinkAddMessage.create({
          ...linkAdd,
          hash: bytesIncrement(linkAdd.hash)._unsafeUnwrap(),
        });
      });

      test("succeeds with a higher hash", async () => {
        await set.merge(linkAdd);
        await expect(set.merge(linkAddLater)).resolves.toBeGreaterThan(0);

        await assertLinkDoesNotExist(linkAdd);
        await assertLinkAddWins(linkAddLater);

        expect(mergeEvents).toEqual([
          [linkAdd, []],
          [linkAddLater, [linkAdd]],
        ]);
      });

      test("fails with a lower hash", async () => {
        await set.merge(linkAddLater);
        await expect(set.merge(linkAdd)).rejects.toEqual(
          new HubError("bad_request.conflict", "message conflicts with a more recent add"),
        );

        await assertLinkDoesNotExist(linkAdd);
        await assertLinkAddWins(linkAddLater);
      });
    });

    describe("with conflicting LinkRemove with different timestamps", () => {
      test("succeeds with a later timestamp", async () => {
        const linkRemoveEarlier = await Factories.LinkRemoveMessage.create({
          data: { ...linkRemove.data, timestamp: linkAdd.data.timestamp - 1 },
        });

        await set.merge(linkRemoveEarlier);
        await expect(set.merge(linkAdd)).resolves.toBeGreaterThan(0);

        await assertLinkAddWins(linkAdd);
        await assertLinkDoesNotExist(linkRemoveEarlier);

        expect(mergeEvents).toEqual([
          [linkRemoveEarlier, []],
          [linkAdd, [linkRemoveEarlier]],
        ]);
      });

      test("fails with an earlier timestamp", async () => {
        await set.merge(linkRemove);
        await expect(set.merge(linkAdd)).rejects.toEqual(
          new HubError("bad_request.conflict", "message conflicts with a more recent remove"),
        );

        await assertLinkRemoveWins(linkRemove);
        await assertLinkDoesNotExist(linkAdd);
      });
    });

    describe("with conflicting LinkRemove with identical timestamps", () => {
      test("fails if remove has a higher hash", async () => {
        const linkRemoveLater = await Factories.LinkRemoveMessage.create({
          data: {
            ...linkRemove.data,
            timestamp: linkAdd.data.timestamp,
          },
          hash: bytesIncrement(linkAdd.hash)._unsafeUnwrap(),
        });

        await set.merge(linkRemoveLater);
        await expect(set.merge(linkAdd)).rejects.toEqual(
          new HubError("bad_request.conflict", "message conflicts with a more recent remove"),
        );

        await assertLinkRemoveWins(linkRemoveLater);
        await assertLinkDoesNotExist(linkAdd);
      });

      test("fails if remove has a lower hash", async () => {
        const linkRemoveEarlier = await Factories.LinkRemoveMessage.create({
          data: {
            ...linkRemove.data,
            timestamp: linkAdd.data.timestamp,
          },
          hash: bytesDecrement(linkAdd.hash)._unsafeUnwrap(),
        });

        await set.merge(linkRemoveEarlier);
        await expect(set.merge(linkAdd)).rejects.toEqual(
          new HubError("bad_request.conflict", "message conflicts with a more recent remove"),
        );

        await assertLinkRemoveWins(linkRemoveEarlier);
        await assertLinkDoesNotExist(linkAdd);
      });
    });
  });

  describe("LinkRemove", () => {
    test("succeeds", async () => {
      await expect(set.merge(linkRemove)).resolves.toBeGreaterThan(0);

      await assertLinkRemoveWins(linkRemove);

      expect(mergeEvents).toEqual([[linkRemove, []]]);
    });

    test("fails if merged twice", async () => {
      await expect(set.merge(linkRemove)).resolves.toBeGreaterThan(0);
      await expect(set.merge(linkRemove)).rejects.toEqual(
        new HubError("bad_request.duplicate", "message has already been merged"),
      );

      await assertLinkRemoveWins(linkRemove);
    });

    describe("with a conflicting LinkRemove with different timestamps", () => {
      let linkRemoveLater: LinkRemoveMessage;

      beforeAll(async () => {
        linkRemoveLater = await Factories.LinkRemoveMessage.create({
          data: { ...linkRemove.data, timestamp: linkRemove.data.timestamp + 1 },
        });
      });

      test("succeeds with a later timestamp", async () => {
        await set.merge(linkRemove);
        await expect(set.merge(linkRemoveLater)).resolves.toBeGreaterThan(0);

        await assertLinkDoesNotExist(linkRemove);
        await assertLinkRemoveWins(linkRemoveLater);

        expect(mergeEvents).toEqual([
          [linkRemove, []],
          [linkRemoveLater, [linkRemove]],
        ]);
      });

      test("fails with an earlier timestamp", async () => {
        await set.merge(linkRemoveLater);
        await expect(set.merge(linkRemove)).rejects.toEqual(
          new HubError("bad_request.conflict", "message conflicts with a more recent remove"),
        );

        await assertLinkDoesNotExist(linkRemove);
        await assertLinkRemoveWins(linkRemoveLater);
      });
    });

    describe("with a conflicting LinkRemove with identical timestamps", () => {
      let linkRemoveLater: LinkRemoveMessage;

      beforeAll(async () => {
        linkRemoveLater = await Factories.LinkRemoveMessage.create({
          ...linkRemove,
          hash: bytesIncrement(linkRemove.hash)._unsafeUnwrap(),
        });
      });

      test("succeeds with a higher hash", async () => {
        await set.merge(linkRemove);
        await expect(set.merge(linkRemoveLater)).resolves.toBeGreaterThan(0);

        await assertLinkDoesNotExist(linkRemove);
        await assertLinkRemoveWins(linkRemoveLater);

        expect(mergeEvents).toEqual([
          [linkRemove, []],
          [linkRemoveLater, [linkRemove]],
        ]);
      });

      test("fails with a lower hash", async () => {
        await set.merge(linkRemoveLater);
        await expect(set.merge(linkRemove)).rejects.toEqual(
          new HubError("bad_request.conflict", "message conflicts with a more recent remove"),
        );

        await assertLinkDoesNotExist(linkRemove);
        await assertLinkRemoveWins(linkRemoveLater);
      });
    });

    describe("with conflicting LinkAdd with different timestamps", () => {
      test("succeeds with a later timestamp", async () => {
        await set.merge(linkAdd);
        await expect(set.merge(linkRemove)).resolves.toBeGreaterThan(0);
        await assertLinkRemoveWins(linkRemove);
        await assertLinkDoesNotExist(linkAdd);

        expect(mergeEvents).toEqual([
          [linkAdd, []],
          [linkRemove, [linkAdd]],
        ]);
      });

      test("fails with an earlier timestamp", async () => {
        const linkAddLater = await Factories.LinkAddMessage.create({
          data: {
            ...linkRemove.data,
            timestamp: linkRemove.data.timestamp + 1,
            type: MessageType.LINK_ADD,
          },
        });

        await set.merge(linkAddLater);
        await expect(set.merge(linkRemove)).rejects.toEqual(
          new HubError("bad_request.conflict", "message conflicts with a more recent add"),
        );
        await assertLinkAddWins(linkAddLater);
        await assertLinkDoesNotExist(linkRemove);
      });
    });

    describe("with conflicting LinkAdd with identical timestamps", () => {
      test("succeeds with a lower hash", async () => {
        const linkAddLater = await Factories.LinkAddMessage.create({
          data: { ...linkRemove.data, type: MessageType.LINK_ADD },
          hash: bytesIncrement(linkRemove.hash)._unsafeUnwrap(),
        });

        await set.merge(linkAddLater);
        await expect(set.merge(linkRemove)).resolves.toBeGreaterThan(0);

        await assertLinkDoesNotExist(linkAddLater);
        await assertLinkRemoveWins(linkRemove);

        expect(mergeEvents).toEqual([
          [linkAddLater, []],
          [linkRemove, [linkAddLater]],
        ]);
      });

      test("succeeds with a higher hash", async () => {
        const linkAddEarlier = await Factories.LinkAddMessage.create({
          data: { ...linkRemove.data, type: MessageType.LINK_ADD },
          hash: bytesDecrement(linkRemove.hash)._unsafeUnwrap(),
        });

        await set.merge(linkAddEarlier);
        await expect(set.merge(linkRemove)).resolves.toBeGreaterThan(0);

        await assertLinkDoesNotExist(linkAddEarlier);
        await assertLinkRemoveWins(linkRemove);

        expect(mergeEvents).toEqual([
          [linkAddEarlier, []],
          [linkRemove, [linkAddEarlier]],
        ]);
      });
    });
  });

  describe("padding bug", () => {
    const makeIncorrectKey = (message: LinkAddMessage | LinkRemoveMessage) => {
      const postfix = message.data.type === MessageType.LINK_ADD ? UserPostfix.LinkAdds : UserPostfix.LinkRemoves;
      return Buffer.concat([
        makeUserKey(message.data.fid), // --------------------------- fid prefix, 5
        Buffer.from([postfix]), // -------------- link_adds key, 1 byte
        Buffer.concat([Buffer.from("follow")], 6), //-------- type, 6 bytes (incorrect padding)
        makeFidKey(message.data.linkBody.targetFid || 0), //-- target id, 4 bytes
      ]);
    };
    const insertWithIncorrectPadding = async (message: LinkAddMessage | LinkRemoveMessage) => {
      const key = makeIncorrectKey(message);
      expect(key.length).toEqual(16);
      const tsHash = Buffer.from(makeTsHash(message.data.timestamp, message.hash)._unsafeUnwrap());
      const txn = db.transaction();
      txn.put(key, tsHash);
      putMessageTransaction(txn, message);
      await db.commit(txn);
    };
    const assertIncorrectPaddingExists = async (message: LinkAddMessage | LinkRemoveMessage, exists: boolean) => {
      const badAddKey = makeIncorrectKey(message);
      const primaryKey = makeMessagePrimaryKeyFromMessage(message);
      await expect(db.keysExist([badAddKey, primaryKey])).resolves.toEqual(ok([exists, exists]));
    };

    test("duplicate link add with incorrect padding", async () => {
      const earlierLinkAddIncorrectPadding = await Factories.LinkAddMessage.create({
        data: { fid, timestamp: linkAdd.data.timestamp - 1, linkBody: linkAdd.data.linkBody },
      });

      await insertWithIncorrectPadding(earlierLinkAddIncorrectPadding);
      await assertIncorrectPaddingExists(earlierLinkAddIncorrectPadding, true);

      await expect(set.merge(linkAdd)).resolves.toBeGreaterThan(0);
      await expect(
        set.getLinkAdd(fid, linkAdd.data.linkBody.type, linkAdd.data.linkBody.targetFid as number),
      ).resolves.toEqual(linkAdd);
      // The incorrect key should be removed
      await assertIncorrectPaddingExists(earlierLinkAddIncorrectPadding, false);
    });

    test("duplicate link remove with incorrect padding", async () => {
      const earlierLinkRemoveIncorrectPadding = await Factories.LinkRemoveMessage.create({
        data: { fid, timestamp: linkRemove.data.timestamp - 1, linkBody: linkAdd.data.linkBody },
      });

      await insertWithIncorrectPadding(earlierLinkRemoveIncorrectPadding);
      await assertIncorrectPaddingExists(earlierLinkRemoveIncorrectPadding, true);

      await expect(set.merge(linkRemove)).resolves.toBeGreaterThan(0);
      await expect(
        set.getLinkRemove(fid, linkRemove.data.linkBody.type, linkRemove.data.linkBody.targetFid as number),
      ).resolves.toEqual(linkRemove);
      // The incorrect key should be removed
      await assertIncorrectPaddingExists(earlierLinkRemoveIncorrectPadding, false);
    });

    test("conflicting link add with incorrect padding", async () => {
      const linkAddIncorrectPadding = await Factories.LinkAddMessage.create({
        data: { fid, timestamp: linkAdd.data.timestamp, linkBody: linkAdd.data.linkBody },
      });
      const laterLinkRemove = await Factories.LinkRemoveMessage.create({
        data: { fid, timestamp: linkAdd.data.timestamp + 1, linkBody: linkAdd.data.linkBody },
      });

      await insertWithIncorrectPadding(linkAddIncorrectPadding);
      await assertIncorrectPaddingExists(linkAddIncorrectPadding, true);

      await expect(set.merge(laterLinkRemove)).resolves.toBeGreaterThan(0);
      await expect(
        set.getLinkRemove(fid, laterLinkRemove.data.linkBody.type, laterLinkRemove.data.linkBody.targetFid as number),
      ).resolves.toEqual(laterLinkRemove);
      // The incorrect key should be removed
      await assertIncorrectPaddingExists(linkAddIncorrectPadding, false);
    });

    test("conflicting link remove with incorrect padding", async () => {
      const linkRemoveIncorrectPadding = await Factories.LinkRemoveMessage.create({
        data: { fid, timestamp: linkAdd.data.timestamp, linkBody: linkAdd.data.linkBody },
      });
      const laterLinkAdd = await Factories.LinkAddMessage.create({
        data: { fid, timestamp: linkAdd.data.timestamp + 1, linkBody: linkAdd.data.linkBody },
      });

      await insertWithIncorrectPadding(linkRemoveIncorrectPadding);
      await assertIncorrectPaddingExists(linkRemoveIncorrectPadding, true);

      await expect(set.merge(laterLinkAdd)).resolves.toBeGreaterThan(0);
      await expect(
        set.getLinkAdd(fid, laterLinkAdd.data.linkBody.type, laterLinkAdd.data.linkBody.targetFid as number),
      ).resolves.toEqual(laterLinkAdd);
      // The incorrect key should be removed
      await assertIncorrectPaddingExists(linkRemoveIncorrectPadding, false);
    });

    test("handles conflicting messages when type is max length", async () => {
      const maxTypeLinkAdd = await Factories.LinkAddMessage.create({
        data: {
          fid: fid,
          timestamp: linkAdd.data.timestamp,
          linkBody: { type: "follower", targetFid: targetFid },
        },
      });
      const laterMaxTypeLinkAdd = await Factories.LinkAddMessage.create({
        data: {
          fid: fid,
          timestamp: maxTypeLinkAdd.data.timestamp + 1,
          linkBody: { type: "follower", targetFid: targetFid },
        },
      });
      await expect(set.merge(maxTypeLinkAdd)).resolves.toBeGreaterThan(0);
      await expect(set.merge(laterMaxTypeLinkAdd)).resolves.toBeGreaterThan(0);

      await assertLinkAddWins(laterMaxTypeLinkAdd);
      await assertLinkDoesNotExist(maxTypeLinkAdd);
    });

    test("getLinkAdd with incorrect padding", async () => {
      await insertWithIncorrectPadding(linkAdd);
      await assertIncorrectPaddingExists(linkAdd, true);
      await expect(
        set.getLinkAdd(fid, linkAdd.data.linkBody.type, linkAdd.data.linkBody.targetFid as number),
      ).resolves.toEqual(linkAdd);
    });

    test("getLinkRemove with incorrect padding", async () => {
      await insertWithIncorrectPadding(linkRemove);
      await assertIncorrectPaddingExists(linkRemove, true);
      await expect(
        set.getLinkRemove(fid, linkRemove.data.linkBody.type, linkRemove.data.linkBody.targetFid as number),
      ).resolves.toEqual(linkRemove);
    });
  });
});

describe("revoke", () => {
  let revokedMessages: Message[] = [];

  const revokeMessageHandler = (event: RevokeMessageHubEvent) => {
    revokedMessages.push(event.revokeMessageBody.message);
  };

  beforeAll(() => {
    eventHandler.on("revokeMessage", revokeMessageHandler);
  });

  beforeEach(() => {
    revokedMessages = [];
  });

  afterAll(() => {
    eventHandler.off("revokeMessage", revokeMessageHandler);
  });

  test("fails with invalid message type", async () => {
    const castAdd = await Factories.CastAddMessage.create({ data: { fid } });
    const result = await set.revoke(castAdd);
    expect(result).toEqual(err(new HubError("bad_request.invalid_param", "invalid message type")));
    expect(revokedMessages).toEqual([]);
  });

  test("deletes all keys relating to the link", async () => {
    await set.merge(linkAdd);
    const linkKeys: Buffer[] = [];
    await db.forEachIteratorByPrefix(Buffer.from([]), (key) => {
      linkKeys.push(key as Buffer);
    });

    expect(linkKeys.length).toBeGreaterThan(0);
    await set.revoke(linkAdd);
    const linkKeysAfterRevoke: Buffer[] = [];
    await db.forEachIteratorByPrefix(Buffer.from([]), (key) => {
      linkKeysAfterRevoke.push(key as Buffer);
    });

    // Two hub events left behind (one merge, one revoke)
    expect(linkKeysAfterRevoke.length).toEqual(2);
  });

  test("succeeds with LinkAdd", async () => {
    await expect(set.merge(linkAdd)).resolves.toBeGreaterThan(0);
    const result = await set.revoke(linkAdd);
    expect(result.isOk()).toBeTruthy();
    expect(result._unsafeUnwrap()).toBeGreaterThan(0);
    await expect(
      set.getLinkAdd(fid, linkAdd.data.linkBody.type, linkAdd.data.linkBody.targetFid as number),
    ).rejects.toThrow();
    expect(revokedMessages).toEqual([linkAdd]);
  });

  test("succeeds with LinkRemove", async () => {
    await expect(set.merge(linkRemove)).resolves.toBeGreaterThan(0);
    const result = await set.revoke(linkRemove);
    expect(result.isOk()).toBeTruthy();
    expect(result._unsafeUnwrap()).toBeGreaterThan(0);
    await expect(
      set.getLinkRemove(fid, linkRemove.data.linkBody.type, linkRemove.data.linkBody.targetFid as number),
    ).rejects.toThrow();
    expect(revokedMessages).toEqual([linkRemove]);
  });

  test("succeeds with unmerged message", async () => {
    const result = await set.revoke(linkAdd);
    expect(result.isOk()).toBeTruthy();
    expect(result._unsafeUnwrap()).toBeGreaterThan(0);
    await expect(
      set.getLinkAdd(fid, linkAdd.data.linkBody.type, linkAdd.data.linkBody.targetFid as number),
    ).rejects.toThrow();
    expect(revokedMessages).toEqual([linkAdd]);
  });
});

describe("pruneMessages", () => {
  let prunedMessages: Message[];

  const pruneMessageListener = (event: PruneMessageHubEvent) => {
    prunedMessages.push(event.pruneMessageBody.message);
  };

  beforeAll(() => {
    eventHandler.on("pruneMessage", pruneMessageListener);
  });

  beforeEach(() => {
    prunedMessages = [];
  });

  afterAll(() => {
    eventHandler.off("pruneMessage", pruneMessageListener);
  });

  let add1: LinkAddMessage;
  let add2: LinkAddMessage;
  let add3: LinkAddMessage;
  let add4: LinkAddMessage;
  let add5: LinkAddMessage;
  let addOld1: LinkAddMessage;

  let remove1: LinkRemoveMessage;
  let remove2: LinkRemoveMessage;
  let remove3: LinkRemoveMessage;
  let remove4: LinkRemoveMessage;
  let remove5: LinkRemoveMessage;

  const generateAddWithTimestamp = async (fid: number, timestamp: number): Promise<LinkAddMessage> => {
    return Factories.LinkAddMessage.create({ data: { fid, timestamp } });
  };

  const generateRemoveWithTimestamp = async (
    fid: number,
    timestamp: number,
    addBody?: LinkBody,
  ): Promise<LinkRemoveMessage> => {
    return Factories.LinkRemoveMessage.create({
      data: {
        fid,
        timestamp,
        linkBody: addBody ?? Factories.LinkBody.build(),
      },
    });
  };

  beforeAll(async () => {
    const time = getFarcasterTime()._unsafeUnwrap() - 10;
    add1 = await generateAddWithTimestamp(fid, time + 1);
    add2 = await generateAddWithTimestamp(fid, time + 2);
    add3 = await generateAddWithTimestamp(fid, time + 3);
    add4 = await generateAddWithTimestamp(fid, time + 4);
    add5 = await generateAddWithTimestamp(fid, time + 5);
    addOld1 = await generateAddWithTimestamp(fid, time - 60 * 60);

    remove1 = await generateRemoveWithTimestamp(fid, time + 1, add1.data.linkBody);
    remove2 = await generateRemoveWithTimestamp(fid, time + 2, add2.data.linkBody);
    remove3 = await generateRemoveWithTimestamp(fid, time + 3, add3.data.linkBody);
    remove4 = await generateRemoveWithTimestamp(fid, time + 4, add4.data.linkBody);
    remove5 = await generateRemoveWithTimestamp(fid, time + 5, add5.data.linkBody);
  });

  describe("with size limit", () => {
    const sizePrunedStore = new LinkStore(db, eventHandler, { pruneSizeLimit: 3 });

    test("size limit changes in the future", () => {
      expect(getDefaultStoreLimit(StoreType.LINKS)).toEqual(2500);
      const originalDate = Date.now;
      try {
        Date.now = () => new Date("2024-08-22").getTime();
        expect(getDefaultStoreLimit(StoreType.LINKS)).toEqual(2000);
      } finally {
        Date.now = originalDate;
      }
    });

    test("no-ops when no messages have been merged", async () => {
      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result._unsafeUnwrap()).toEqual([]);
      expect(prunedMessages).toEqual([]);
    });

    test("prunes earliest add messages", async () => {
      const messages = [add1, add2, add3, add4, add5];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result.isOk()).toBeTruthy();
      expect(result._unsafeUnwrap().length).toEqual(2);

      expect(prunedMessages).toEqual([add1, add2]);

      for (const message of prunedMessages as LinkAddMessage[]) {
        const getAdd = () =>
          sizePrunedStore.getLinkAdd(
            fid,
            message.data.linkBody.type,
            message.data.linkBody.targetFid ?? Factories.Fid.build(),
          );
        await expect(getAdd()).rejects.toThrow(HubError);
      }
    });

    test("prunes earliest remove messages", async () => {
      const messages = [remove1, remove2, remove3, remove4, remove5];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result.isOk()).toBeTruthy();
      expect(result._unsafeUnwrap().length).toEqual(2);

      expect(prunedMessages).toEqual([remove1, remove2]);

      for (const message of prunedMessages as LinkRemoveMessage[]) {
        const getRemove = () =>
          sizePrunedStore.getLinkRemove(
            fid,
            message.data.linkBody.type,
            message.data.linkBody.targetFid ?? Factories.Fid.build(),
          );
        await expect(getRemove()).rejects.toThrow(HubError);
      }
    });

    test("prunes earliest messages", async () => {
      const messages = [add1, remove2, add3, remove4, add5];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result.isOk()).toBeTruthy();
      expect(result._unsafeUnwrap().length).toEqual(2);

      expect(prunedMessages).toEqual([add1, remove2]);
    });

    test("no-ops when adds have been removed", async () => {
      const messages = [add1, remove1, add2, remove2, add3];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result).toEqual(ok([]));

      expect(prunedMessages).toEqual([]);
    });

    test("fails to add messages older than the earliest message", async () => {
      const messages = [add1, add2, add3];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      // Older messages are rejected
      await expect(sizePrunedStore.merge(addOld1)).rejects.toEqual(
        new HubError("bad_request.prunable", "message would be pruned"),
      );

      // newer messages can still be added
      await expect(sizePrunedStore.merge(add4)).resolves.toBeGreaterThan(0);

      // Prune removes earliest
      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result.isOk()).toBeTruthy();
      expect(result._unsafeUnwrap().length).toEqual(1);

      expect(prunedMessages).toEqual([add1]);
    });
  });
});
