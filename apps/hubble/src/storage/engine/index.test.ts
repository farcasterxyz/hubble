import {
  bytesToHexString,
  bytesToUtf8String,
  CastAddMessage,
  CastId,
  CastRemoveMessage,
  Factories,
  FarcasterNetwork,
  hexStringToBytes,
  HubError,
  LinkAddMessage,
  MergeMessageHubEvent,
  MergeUserNameProofBody,
  MergeUsernameProofHubEvent,
  Message,
  MessageData,
  MessageType,
  OnChainEvent,
  OnChainEventType,
  Protocol,
  ReactionAddMessage,
  ReactionType,
  RevokeMessageHubEvent,
  SignerEventType,
  toFarcasterTime,
  UserDataAddMessage,
  UserDataType,
  UserNameProof,
  UserNameType,
  utf8StringToBytes,
  base58ToBytes,
  VerificationAddAddressMessage,
  recreateSolanaClaimMessage,
  bytesCompare,
} from "@farcaster/hub-nodejs";
import { err, Ok, ok, ResultAsync } from "neverthrow";
import { jestRocksDB } from "../db/jestUtils.js";
import Engine from "../engine/index.js";
import { sleep } from "../../utils/crypto.js";
import { getMessage, makeTsHash, typeToSetPostfix } from "../db/message.js";
import { StoreEvents } from "../stores/storeEventHandler.js";
import { IdRegisterOnChainEvent, makeVerificationAddressClaim } from "@farcaster/core";
import { setReferenceDateForTest } from "../../utils/versions.js";
import { publicClient } from "../../test/utils.js";
import { jest } from "@jest/globals";
import { FNameRegistryEventsProvider, FNameTransfer } from "../../eth/fnameRegistryEventsProvider.js";
import { MockFnameRegistryClient } from "../../test/mocks.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const db = jestRocksDB("protobufs.engine.test");
const network = FarcasterNetwork.TESTNET;

const account = privateKeyToAccount(generatePrivateKey());
const fNameClient = new MockFnameRegistryClient(account);

// biome-ignore lint/style/useConst: cannot use lint as we need a reference before instantiation
let engine: Engine;

const fNameProvider = new FNameRegistryEventsProvider(
  fNameClient,
  // Mock version of the hub interface
  {
    submitUserNameProof: (proof: UserNameProof) => engine.mergeUserNameProof(proof),
    getHubState: () => ResultAsync.fromSafePromise(Promise.resolve({ lastFnameProof: 0 })),
    putHubState: () => undefined,
    // biome-ignore lint/suspicious/noExplicitAny: mock doesn't specify full interface
  } as any,
  false,
);

// biome-ignore lint/suspicious/noExplicitAny: mock used only in tests
const l2EventsProvider = jest.fn() as any;
l2EventsProvider.retryEventsForFid = jest.fn();
const retryEventsForFidMock = l2EventsProvider.retryEventsForFid;

engine = new Engine(db, network, undefined, publicClient, undefined, fNameProvider, l2EventsProvider);

const fid = Factories.Fid.build();
const fname = Factories.Fname.build();
const signer = Factories.Ed25519Signer.build();
const custodySigner = Factories.Eip712Signer.build();

let custodySignerKey: Uint8Array;
let signerKey: Uint8Array;
let userNameProof: UserNameProof;
let custodyEvent: IdRegisterOnChainEvent;
let storageEvent: OnChainEvent;
let signerAddEvent: OnChainEvent;
let signerRemoveEvent: OnChainEvent;
let castAdd: CastAddMessage;
let reactionAdd: ReactionAddMessage;
let linkAdd: LinkAddMessage;
let verificationAdd: VerificationAddAddressMessage;
let userDataAdd: UserDataAddMessage;

beforeAll(async () => {
  fNameClient.setTransfersToReturn([]);
  // This forces the provider to fetch the signer address
  await fNameProvider.start();
  await fNameProvider.stop();

  signerKey = (await signer.getSignerKey())._unsafeUnwrap();
  custodySignerKey = (await custodySigner.getSignerKey())._unsafeUnwrap();
  custodyEvent = Factories.IdRegistryOnChainEvent.build({ fid }, { transient: { to: custodySignerKey } });
  signerAddEvent = Factories.SignerOnChainEvent.build({ fid }, { transient: { signer: signerKey } });
  signerRemoveEvent = Factories.SignerOnChainEvent.build({
    fid,
    blockNumber: signerAddEvent.blockNumber + 1,
    signerEventBody: Factories.SignerEventBody.build({
      eventType: SignerEventType.REMOVE,
      key: signerKey,
    }),
  });
  storageEvent = Factories.StorageRentOnChainEvent.build({ fid });

  userNameProof = Factories.UserNameProof.build({ name: fname, owner: custodyEvent.idRegisterEventBody.to, fid: fid });

  castAdd = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });
  reactionAdd = await Factories.ReactionAddMessage.create({ data: { fid, network } }, { transient: { signer } });
  linkAdd = await Factories.LinkAddMessage.create({ data: { fid, network } }, { transient: { signer } });
  verificationAdd = await Factories.VerificationAddEthAddressMessage.create(
    { data: { fid, network } },
    { transient: { signer } },
  );
  userDataAdd = await Factories.UserDataAddMessage.create(
    { data: { fid, network, userDataBody: { type: UserDataType.PFP } } },
    { transient: { signer } },
  );
});

beforeEach(async () => {
  engine.clearCaches();
  engine.setSolanaVerifications(false);

  const transferEvents: FNameTransfer[] = [
    {
      id: 1,
      username: Buffer.from(fname).toString("utf-8"),
      from: 0,
      to: fid,
      timestamp: 1686291736947,
      owner: account.address,
      server_signature: "",
    },
  ];

  fNameClient.setTransfersToReturn([transferEvents]);
});

afterAll(async () => {
  await engine.stop();
  await db.close();
});

describe("mergeOnChainEvent", () => {
  test("succeeds", async () => {
    await expect(engine.mergeOnChainEvent(custodyEvent)).resolves.toBeInstanceOf(Ok);
    await expect(engine.getIdRegistryOnChainEvent(fid)).resolves.toEqual(ok(custodyEvent));
  });

  test("does not merge invalid event type", async () => {
    const event = Factories.OnChainEvent.build({ type: OnChainEventType.EVENT_TYPE_NONE });
    const result = await engine.mergeOnChainEvent(event);
    expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
  });
});

describe("mergeUserNameProof", () => {
  test("succeeds", async () => {
    const userNameProof = Factories.UserNameProof.build();
    await expect(engine.mergeUserNameProof(userNameProof)).resolves.toBeInstanceOf(Ok);
    expect(await engine.getUserNameProof(userNameProof.name)).toBeTruthy();
  });
});

describe("mergeMessage", () => {
  let mergedMessages: Message[];

  const handleMergeMessage = (event: MergeMessageHubEvent) => {
    mergedMessages.push(event.mergeMessageBody.message);
  };

  beforeAll(async () => {
    engine.eventHandler.on("mergeMessage", handleMergeMessage);
  });

  afterAll(async () => {
    engine.eventHandler.off("mergeMessage", handleMergeMessage);
  });

  beforeEach(() => {
    mergedMessages = [];
  });

  describe("with valid signer", () => {
    beforeEach(async () => {
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(signerAddEvent);
      await engine.mergeOnChainEvent(storageEvent);
    });

    describe("CastAdd", () => {
      test("succeeds", async () => {
        await expect(engine.mergeMessage(castAdd)).resolves.toBeInstanceOf(Ok);
        await expect(engine.getCast(fid, castAdd.hash)).resolves.toEqual(ok(castAdd));
        expect(mergedMessages).toEqual([castAdd]);
      });
    });

    describe("ReactionAdd", () => {
      test("succeeds", async () => {
        await expect(engine.mergeMessage(reactionAdd)).resolves.toBeInstanceOf(Ok);
        await expect(
          engine.getReaction(
            fid,
            reactionAdd.data.reactionBody.type,
            reactionAdd.data.reactionBody.targetCastId as CastId,
          ),
        ).resolves.toEqual(ok(reactionAdd));
        expect(mergedMessages).toEqual([reactionAdd]);
      });
    });

    describe("LinkAdd", () => {
      test("succeeds", async () => {
        setReferenceDateForTest(100000000000000000000000);
        await expect(engine.mergeMessage(linkAdd)).resolves.toBeInstanceOf(Ok);
        await expect(
          engine.getLink(fid, linkAdd.data.linkBody.type, linkAdd.data.linkBody.targetFid as number),
        ).resolves.toEqual(ok(linkAdd));
        expect(mergedMessages).toEqual([linkAdd]);
      });

      test("succeeds with CompactStateMessage with no targetFids", async () => {
        setReferenceDateForTest(100000000000000000000000);
        const compactStateMessage = await Factories.LinkCompactStateMessage.create(
          { data: { fid, network } },
          { transient: { signer } },
        );
        await expect(engine.mergeMessage(compactStateMessage)).resolves.toBeInstanceOf(Ok);
        expect(mergedMessages).toEqual([compactStateMessage]);
      });
    });

    describe("VerificationAddAddress", () => {
      test("succeeds for eth", async () => {
        await expect(engine.mergeMessage(verificationAdd)).resolves.toBeInstanceOf(Ok);
        await expect(
          engine.getVerification(fid, verificationAdd.data.verificationAddAddressBody.address),
        ).resolves.toEqual(ok(verificationAdd));
        expect(mergedMessages).toEqual([verificationAdd]);
      });

      test("fails when network does not match claim network", async () => {
        const address = custodySignerKey;
        const blockHash = Factories.BlockHash.build();
        const mainnetClaim = await makeVerificationAddressClaim(
          fid,
          address,
          FarcasterNetwork.MAINNET,
          blockHash,
          Protocol.ETHEREUM,
        )._unsafeUnwrap();
        const claimSignature = (await custodySigner.signVerificationEthAddressClaim(mainnetClaim))._unsafeUnwrap();
        const testnetVerificationAdd = await Factories.VerificationAddEthAddressMessage.create(
          {
            data: {
              fid,
              network: FarcasterNetwork.TESTNET,
              verificationAddAddressBody: {
                address: address,
                blockHash: blockHash,
                claimSignature: claimSignature,
              },
            },
          },
          { transient: { signer: signer, ethSigner: custodySigner } },
        );
        const result = await engine.mergeMessage(testnetVerificationAdd);
        // Signature will not match because we're attempting to recover the address based on the wrong network
        expect(result).toEqual(err(new HubError("bad_request.validation_failure", "invalid claimSignature")));
      });

      test("fails for solana verifications by default", async () => {
        const verificationAdd = await Factories.VerificationAddSolAddressMessage.create(
          { data: { fid, network } },
          { transient: { signer } },
        );

        const result = await engine.mergeMessage(verificationAdd);
        expect(result).toEqual(
          err(new HubError("bad_request.validation_failure", "solana verifications are not enabled")),
        );
      });

      test("succeeds for solana verifications when enabled", async () => {
        engine.setSolanaVerifications(true);
        const verificationAdd = await Factories.VerificationAddSolAddressMessage.create(
          { data: { fid, network } },
          { transient: { signer } },
        );

        await expect(engine.mergeMessage(verificationAdd)).resolves.toBeInstanceOf(Ok);
        await expect(
          engine.getVerification(fid, verificationAdd.data.verificationAddAddressBody.address),
        ).resolves.toEqual(ok(verificationAdd));
        expect(mergedMessages).toEqual([verificationAdd]);
      });

      test("succeeds for solana verifications removes when enabled", async () => {
        engine.setSolanaVerifications(true);
        const verificationAdd = await Factories.VerificationAddSolAddressMessage.create(
          { data: { fid, network } },
          { transient: { signer } },
        );
        const verificationRemove = await Factories.VerificationRemoveMessage.create(
          {
            data: {
              fid,
              network,
              timestamp: verificationAdd.data.timestamp + 1,
              verificationRemoveBody: {
                address: verificationAdd.data.verificationAddAddressBody.address,
                protocol: Protocol.SOLANA,
              },
            },
          },
          { transient: { signer } },
        );

        await expect(engine.mergeMessage(verificationAdd)).resolves.toBeInstanceOf(Ok);
        await expect(engine.mergeMessage(verificationRemove)).resolves.toBeInstanceOf(Ok);
        const removeResult = await engine.getVerification(fid, verificationAdd.data.verificationAddAddressBody.address);
        expect(removeResult._unsafeUnwrapErr().errCode).toBe("not_found");
        expect(mergedMessages).toEqual([verificationAdd, verificationRemove]);
      });

      test("fails when sol signature does not match fid", async () => {
        engine.setSolanaVerifications(true);
        const solAddress = Factories.SolAddress.build();
        const solanaSigner = Factories.Ed25519Signer.build();
        const blockHash = Factories.BlockHash.build();
        const claim = Factories.VerificationSolAddressClaim.build({
          fid: BigInt(fid + 1),
          network: FarcasterNetwork.MAINNET,
          blockHash: Buffer.from(blockHash).toString("utf-8"),
          address: Buffer.from(solAddress).toString("utf-8"),
          protocol: Protocol.SOLANA,
        });
        const claimSignature = (
          await solanaSigner.signMessageHash(recreateSolanaClaimMessage(claim, solAddress))
        )._unsafeUnwrap();

        const badVerificationAdd = await Factories.VerificationAddSolAddressMessage.create(
          {
            data: {
              fid,
              network,
              verificationAddAddressBody: {
                address: solAddress,
                blockHash,
                claimSignature,
                protocol: Protocol.SOLANA,
              },
            },
          },
          { transient: { signer } },
        );

        const result = await engine.mergeMessage(badVerificationAdd);
        // Signature will not match because we're attempting to recover the address based on the wrong fid
        expect(result).toEqual(err(new HubError("bad_request.validation_failure", "invalid claimSignature")));
      });

      test("with a valid externally generated solana claim signature", async () => {
        engine.setSolanaVerifications(true);
        const solanaSignerFid = 123;
        const solanaFidCustodyEvent = Factories.IdRegistryOnChainEvent.build({ fid: solanaSignerFid });
        const solanaFidsignerAddEvent = Factories.SignerOnChainEvent.build(
          { fid: solanaSignerFid },
          { transient: { signer: signerKey } },
        );
        const solanaFidStorageEvent = Factories.StorageRentOnChainEvent.build({ fid: solanaSignerFid });
        await engine.mergeOnChainEvent(solanaFidCustodyEvent);
        await engine.mergeOnChainEvent(solanaFidsignerAddEvent);
        await engine.mergeOnChainEvent(solanaFidStorageEvent);

        const verificationAdd = await Factories.VerificationAddSolAddressMessage.create(
          {
            data: {
              fid: solanaSignerFid,
              network,
              verificationAddAddressBody: {
                address: base58ToBytes("8WoeDTF9535N6tnmjyyMukwcAM1exHZr6tUsmbWefgYz")._unsafeUnwrap(),
                protocol: Protocol.SOLANA,
                claimSignature: hexStringToBytes(
                  "d1ffa68a4f4a6d1046ed827760e530eff85e76c6bfcb63ccedc45d293f00425658f2825670bbfaf8304c3d715d456f521616705463039983713f8e4f9574be03",
                )._unsafeUnwrap(),
                blockHash: base58ToBytes("7hAHBEYX84W4jzQ8P6UJioymYu6Rnhp1CLsBW5B7zpzU")._unsafeUnwrap(),
              },
            },
          },
          { transient: { signer } },
        );

        const result = await engine.mergeMessage(verificationAdd);
        expect(result).toBeInstanceOf(Ok);
      });

      describe("validateOrRevokeMessage", () => {
        let mergedMessage: Message;
        let verifications: VerificationAddAddressMessage[] = [];

        const getVerifications = async () => {
          const verificationsResult = await engine.getVerificationsByFid(fid);
          if (verificationsResult.isOk()) {
            verifications = verificationsResult.value.messages;
          }
        };

        const createVerification = async () => {
          return await Factories.VerificationAddEthAddressMessage.create(
            {
              data: {
                fid,
                verificationAddAddressBody: Factories.VerificationAddAddressBody.build({
                  chainId: 1,
                  verificationType: 1,
                }),
              },
            },
            { transient: { signer } },
          );
        };

        beforeEach(async () => {
          jest.replaceProperty(publicClient.chain, "id", 1);
          jest.spyOn(publicClient, "verifyTypedData").mockResolvedValue(true);
          mergedMessage = await createVerification();
          const result = await engine.mergeMessage(mergedMessage);
          expect(result.isOk()).toBeTruthy();
          await getVerifications();
          expect(verifications.length).toBe(1);
        });

        afterEach(async () => {
          jest.restoreAllMocks();
        });

        test("revokes a contract verification when signature is no longer valid", async () => {
          jest.spyOn(publicClient, "verifyTypedData").mockResolvedValue(false);
          const result = await engine.validateOrRevokeMessage(mergedMessage);
          expect(result.isOk()).toBeTruthy();

          const verificationsResult = await engine.getVerificationsByFid(fid);
          expect(verificationsResult.isOk()).toBeTruthy();

          await getVerifications();
          expect(verifications.length).toBe(0);
        });

        test("does not revoke contract verifications when RPC call fails", async () => {
          jest.spyOn(publicClient, "verifyTypedData").mockRejectedValue(new Error("verify failed"));
          const result = await engine.validateOrRevokeMessage(mergedMessage);
          expect(result._unsafeUnwrapErr().errCode).toEqual("unavailable.network_failure");
          expect(result._unsafeUnwrapErr().message).toMatch("verify failed");

          await getVerifications();
          expect(verifications.length).toBe(1);
        });
      });
    });

    describe("UserDataAdd", () => {
      test("succeeds", async () => {
        await expect(engine.mergeMessage(userDataAdd)).resolves.toBeInstanceOf(Ok);
        await expect(engine.getUserData(fid, userDataAdd.data.userDataBody.type)).resolves.toEqual(ok(userDataAdd));
        expect(mergedMessages).toEqual([userDataAdd]);
      });

      describe("with fname", () => {
        let usernameAdd: UserDataAddMessage;

        beforeAll(async () => {
          const nameString = bytesToUtf8String(userNameProof.name)._unsafeUnwrap();
          usernameAdd = await Factories.UserDataAddMessage.create(
            {
              data: {
                fid,
                network,
                userDataBody: { type: UserDataType.USERNAME, value: nameString },
              },
            },
            { transient: { signer } },
          );
        });

        test("succeeds when fname owned by same fid", async () => {
          await expect(engine.mergeUserNameProof(userNameProof)).resolves.toBeInstanceOf(Ok);
          await expect(engine.mergeMessage(usernameAdd)).resolves.toBeInstanceOf(Ok);
        });

        test("succeeds when fname owned by same fid but different custody address", async () => {
          const proof = Factories.UserNameProof.build({
            name: userNameProof.name,
            timestamp: userNameProof.timestamp + 1,
            owner: Factories.EthAddress.build(),
            fid: fid,
          });

          await expect(engine.mergeUserNameProof(proof)).resolves.toBeInstanceOf(Ok);
          await expect(engine.mergeMessage(usernameAdd)).resolves.toBeInstanceOf(Ok);
        });

        test("retries and succeeds when username proof has not been merged yet", async () => {
          await expect(engine.mergeMessage(usernameAdd)).resolves.toBeInstanceOf(Ok);
        });

        test("fails when fname transfer event is missing", async () => {
          fNameClient.setTransfersToReturn([]);
          const result = await engine.mergeMessage(usernameAdd);
          expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
          expect(result._unsafeUnwrapErr().message).toMatch("is not registered");
        });

        test("retries and succeeds when username proof has not been merged yet", async () => {
          fNameClient.setTransfersToReturn([]);

          for (let i = 0; i < 61; i++) {
            await engine.mergeMessage(usernameAdd);
          }

          const result = await engine.mergeMessage(usernameAdd);
          expect(result).toMatchObject(err({ errCode: "unavailable" }));
          expect(result._unsafeUnwrapErr().message).toMatch("Too many requests to fName server");
        });

        test("fails when fname is owned by another fid", async () => {
          const proof = Factories.UserNameProof.build({
            name: userNameProof.name,
            timestamp: userNameProof.timestamp + 1,
            owner: Factories.EthAddress.build(),
            fid: Factories.Fid.build(),
          });
          await expect(engine.mergeUserNameProof(proof)).resolves.toBeInstanceOf(Ok);
          const result = await engine.mergeMessage(usernameAdd);
          expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
          expect(result._unsafeUnwrapErr().message).toMatch("does not match");
        });
      });
    });

    test("succeeds with concurrent, conflicting cast messages", async () => {
      const castAdd = await Factories.CastAddMessage.create({ data: { fid } }, { transient: { signer } });

      const generateCastRemove = async (): Promise<CastRemoveMessage> => {
        return Factories.CastRemoveMessage.create(
          { data: { fid, castRemoveBody: { targetHash: castAdd.hash } } },
          { transient: { signer } },
        );
      };

      // Generate 100 cast removes with different timestamps
      const castRemoves: CastRemoveMessage[] = [];
      for (let i = 0; i < 100; i++) {
        const castRemove = await generateCastRemove();
        castRemoves.push(castRemove);
      }

      const messages = [castAdd, ...castRemoves, castAdd, castAdd];

      const results = await Promise.all(messages.map((message) => engine.mergeMessage(message)));
      expect(
        results.every(
          (result) => result.isOk() || (result.isErr() && result.error.errCode !== "unavailable.storage_failure"),
        ),
      ).toBeTruthy();

      const allMessages = await engine.getAllCastMessagesByFid(fid);
      expect(allMessages._unsafeUnwrap().messages.length).toEqual(1);
    });

    test("succeeds with concurrent, conflicting reaction messages", async () => {
      const castId = Factories.CastId.build();
      const body = Factories.ReactionBody.build({
        type: ReactionType.LIKE,
        targetCastId: castId,
      });

      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        if (Math.random() < 0.5) {
          messages.push(
            await Factories.ReactionAddMessage.create(
              { data: { reactionBody: body, fid, network } },
              { transient: { signer } },
            ),
          );
        } else {
          messages.push(
            await Factories.ReactionRemoveMessage.create(
              { data: { reactionBody: body, fid, network } },
              { transient: { signer } },
            ),
          );
        }
      }

      const results = await Promise.all(messages.map((message) => engine.mergeMessage(message)));
      expect(
        results.every(
          (result) => result.isOk() || (result.isErr() && result.error.errCode !== "unavailable.storage_failure"),
        ),
      ).toBeTruthy();

      const allMessages = await engine.getAllReactionMessagesByFid(fid);
      expect(allMessages._unsafeUnwrap().messages.length).toEqual(1);
    });

    test("succeeds with concurrent, conflicting link messages", async () => {
      setReferenceDateForTest(100000000000000000000000);
      const targetFid = Factories.Fid.build();
      const body = Factories.LinkBody.build({
        type: "follow",
        targetFid: targetFid,
      });

      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        if (Math.random() < 0.5) {
          messages.push(
            await Factories.LinkAddMessage.create(
              { data: { linkBody: body, fid, network } },
              { transient: { signer } },
            ),
          );
        } else {
          messages.push(
            await Factories.LinkRemoveMessage.create(
              { data: { linkBody: body, fid, network } },
              { transient: { signer } },
            ),
          );
        }
      }

      const results = await Promise.all(messages.map((message) => engine.mergeMessage(message)));
      expect(
        results.every(
          (result) => result.isOk() || (result.isErr() && result.error.errCode !== "unavailable.storage_failure"),
        ),
      ).toBeTruthy();

      const allMessages = await engine.getAllLinkMessagesByFid(fid);
      expect(allMessages._unsafeUnwrap().messages.length).toEqual(1);
    });
  });

  describe("fails when signer is invalid", () => {
    test("with ReactionAdd", async () => {
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(Factories.SignerOnChainEvent.build({ fid }));

      const result = await engine.mergeMessage(reactionAdd);
      expect(result).toMatchObject(err({ errCode: "bad_request.unknown_signer" }));
      expect(result._unsafeUnwrapErr().message).toMatch("invalid signer");
    });

    test("with LinkAdd", async () => {
      setReferenceDateForTest(100000000000000000000000);
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(Factories.SignerOnChainEvent.build({ fid }));

      const result = await engine.mergeMessage(linkAdd);
      expect(result).toMatchObject(err({ errCode: "bad_request.unknown_signer" }));
      expect(result._unsafeUnwrapErr().message).toMatch("invalid signer");
    });
  });

  describe("fails when missing both custody address and signer", () => {
    let message: Message;

    afterEach(async () => {
      const result = await engine.mergeMessage(message);
      const err = result._unsafeUnwrapErr();
      expect(err.errCode).toEqual("bad_request.unknown_fid");
      expect(err.message).toMatch("unknown fid");
    });

    test("with ReactionAdd", () => {
      message = reactionAdd;
    });

    test("with LinkAdd", () => {
      setReferenceDateForTest(100000000000000000000000);
      message = linkAdd;
    });
  });

  test("fails with mismatched farcaster network", async () => {
    const mainnetEngine = new Engine(db, FarcasterNetwork.MAINNET);
    const result = await mainnetEngine.mergeMessage(reactionAdd);
    expect(result).toEqual(
      err(
        new HubError(
          "bad_request.validation_failure",
          `incorrect network: ${FarcasterNetwork.TESTNET} (expected: ${FarcasterNetwork.MAINNET})`,
        ),
      ),
    );
    await mainnetEngine.stop();
  });

  describe("FrameAction messages", () => {
    // These messages types are not intended to be persisted to the hub
    test("even valid frame action messages cannot be merged", async () => {
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(signerAddEvent);
      await engine.mergeOnChainEvent(storageEvent);

      const frameAction = await Factories.FrameActionMessage.create(
        { data: { fid, network } },
        { transient: { signer } },
      );
      const validationResult = await engine.validateMessage(frameAction);
      expect(validationResult.isOk()).toBeTruthy();
      const result = await engine.mergeMessage(frameAction);
      expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
      expect(result._unsafeUnwrapErr().message).toMatch("invalid message type");
    });

    test("validation fails correctly for invalid users", async () => {
      const frameAction = await Factories.FrameActionMessage.create(
        { data: { fid, network } },
        { transient: { signer } },
      );
      let result = await engine.validateMessage(frameAction);
      expect(result._unsafeUnwrapErr().message).toMatch("unknown fid");

      await engine.mergeOnChainEvent(custodyEvent);

      result = await engine.validateMessage(frameAction);
      expect(result._unsafeUnwrapErr().message).toMatch("invalid signer");
    });
  });

  describe("UsernameProof messages", () => {
    const randomEthAddress = bytesToHexString(Factories.EthAddress.build())._unsafeUnwrap();
    let usernameProofEvents: MergeUserNameProofBody[] = [];

    const handleUsernameProofEvent = (event: MergeUsernameProofHubEvent) => {
      usernameProofEvents.push(event.mergeUsernameProofBody);
    };

    beforeEach(async () => {
      usernameProofEvents = [];
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(signerAddEvent);
      await engine.mergeOnChainEvent(storageEvent);
      await engine.eventHandler.syncCache();
      engine.eventHandler.on("mergeUsernameProofEvent", handleUsernameProofEvent);
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      engine.eventHandler.off("mergeUsernameProofEvent", handleUsernameProofEvent);
    });

    const createProof = async (name: string, timestamp?: number | null, owner?: string | null) => {
      // Proof time is in Unix seconds and should match the message time which is in Farcaster milliseconds
      const timestampSec = Math.floor((timestamp || Date.now()) / 1000);
      const ownerAsBytes = owner ? hexStringToBytes(owner)._unsafeUnwrap() : Factories.EthAddress.build();
      return await Factories.UsernameProofMessage.create(
        {
          data: {
            fid,
            usernameProofBody: Factories.UserNameProof.build({
              name: utf8StringToBytes(name)._unsafeUnwrap(),
              fid,
              owner: ownerAsBytes,
              timestamp: timestampSec,
              type: UserNameType.USERNAME_TYPE_ENS_L1,
            }),
            timestamp: toFarcasterTime(timestampSec * 1000)._unsafeUnwrap(),
            type: MessageType.USERNAME_PROOF,
          },
        },
        { transient: { signer } },
      );
    };

    test("fails when not a valid ens name", async () => {
      const result = await engine.mergeMessage(await createProof("no_dot_eth"));
      expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
      expect(result._unsafeUnwrapErr().message).toMatch("invalid ens name");
    });

    test("fails gracefully when resolving throws an error", async () => {
      const result = await engine.mergeMessage(await createProof("test.eth"));
      expect(result).toMatchObject(err({ errCode: "unavailable.network_failure" }));
      expect(result._unsafeUnwrapErr().message).toMatch("failed to resolve ens name");
    });

    test("fails gracefully when resolving an unregistered name", async () => {
      jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
        return Promise.resolve(null);
      });
      const result = await engine.mergeMessage(await createProof("akjsdhkhaasd.eth"));
      expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
      expect(result._unsafeUnwrapErr().message).toMatch("no valid address for akjsdhkhaasd.eth");
    });

    test("fails when resolved address does not match proof", async () => {
      const message = await createProof("test.eth");
      jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
        return Promise.resolve(randomEthAddress);
      });
      const result = await engine.mergeMessage(message);
      expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
      expect(result._unsafeUnwrapErr().message).toMatch(`resolved address ${randomEthAddress} does not match proof`);
    });

    test("fails when resolved address does not match custody address or verification address", async () => {
      await engine.mergeMessage(verificationAdd);
      jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
        return Promise.resolve(randomEthAddress);
      });
      const message = await createProof("test.eth", null, randomEthAddress);
      const result = await engine.mergeMessage(message);
      expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
      expect(result._unsafeUnwrapErr().message).toMatch("ens name does not belong to fid");
    });

    test("succeeds for valid proof for custody address", async () => {
      const custodyAddress = bytesToHexString(custodyEvent.idRegisterEventBody.to)._unsafeUnwrap();
      jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
        return Promise.resolve(custodyAddress);
      });
      const message = await createProof("test.eth", null, custodyAddress);
      const result = await engine.mergeMessage(message);
      expect(result.isOk()).toBeTruthy();

      expect(usernameProofEvents.length).toBe(1);
      expect(usernameProofEvents[0]?.usernameProof).toMatchObject(message.data.usernameProofBody);
      expect(usernameProofEvents[0]?.deletedUsernameProof).toBeUndefined();
    });

    test("succeeds for valid proof for verified eth address", async () => {
      await engine.mergeMessage(verificationAdd);
      const verificationAddress = bytesToHexString(
        verificationAdd.data.verificationAddAddressBody.address,
      )._unsafeUnwrap();
      jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
        return Promise.resolve(verificationAddress);
      });
      const message = await createProof("test.eth", null, verificationAddress);
      const result = await engine.mergeMessage(message);
      expect(result.isOk()).toBeTruthy();

      expect(usernameProofEvents.length).toBe(1);
      expect(usernameProofEvents[0]?.usernameProof).toMatchObject(message.data.usernameProofBody);
      expect(usernameProofEvents[0]?.deletedUsernameProof).toBeUndefined();
    });

    test("getUsernameProofsByFid returns all proofs for fid including fname proofs", async () => {
      const custodyAddress = bytesToHexString(custodyEvent.idRegisterEventBody.to)._unsafeUnwrap();
      jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
        return Promise.resolve(custodyAddress);
      });
      const message = await createProof("test.eth", null, custodyAddress);
      const result = await engine.mergeMessage(message);
      expect(result.isOk()).toBeTruthy();

      const fnameProof = Factories.UserNameProof.build({ fid });
      await engine.mergeUserNameProof(fnameProof);

      const proofs = (await engine.getUserNameProofsByFid(fid)).unwrapOr([]);
      expect(proofs.length).toBe(2);
      expect(proofs).toContainEqual(message.data.usernameProofBody);
      expect(proofs).toContainEqual(fnameProof);
    });

    test("getUsernameProofsByFid does not fail for empty results", async () => {
      const proofs = (await engine.getUserNameProofsByFid(fid)).unwrapOr([]);
      expect(proofs.length).toBe(0);
    });

    describe("userDataAdd message with an ens name", () => {
      let test1Message: Message;
      let userDataAdd: Message;
      let userDataAdd2: Message;
      beforeEach(async () => {
        const custodyAddress = bytesToHexString(custodyEvent.idRegisterEventBody.to)._unsafeUnwrap();
        const verificationAddress = bytesToHexString(
          verificationAdd.data.verificationAddAddressBody.address,
        )._unsafeUnwrap();

        jest.spyOn(publicClient, "getEnsAddress").mockImplementation((opts) => {
          if (opts.name === "test.eth") {
            return Promise.resolve(custodyAddress);
          } else if (opts.name === "test123.eth") {
            return Promise.resolve(verificationAddress);
          }
          return Promise.resolve("0x");
        });
        test1Message = await createProof("test.eth", null, custodyAddress);
        const testName = await engine.mergeMessage(test1Message);
        expect(testName.isOk()).toBeTruthy();

        await engine.mergeMessage(verificationAdd);
        const test2Name = await engine.mergeMessage(await createProof("test123.eth", null, verificationAddress));
        expect(test2Name.isOk()).toBeTruthy();

        userDataAdd = await Factories.UserDataAddMessage.create(
          {
            data: {
              fid,
              userDataBody: {
                type: UserDataType.USERNAME,
                value: "test.eth",
              },
            },
          },
          { transient: { signer } },
        );
        userDataAdd2 = await Factories.UserDataAddMessage.create(
          {
            data: {
              fid,
              userDataBody: {
                type: UserDataType.USERNAME,
                value: "test123.eth",
              },
            },
          },
          { transient: { signer } },
        );
      });

      test("succeeds setting name when name is owned by custody address", async () => {
        const result = await engine.mergeMessage(userDataAdd);
        expect(result.isOk()).toBeTruthy();
        expect((await engine.getUserData(fid, UserDataType.USERNAME))._unsafeUnwrap()).toMatchObject(userDataAdd);
      });
      test("succeeds setting name when name is owned by verified address", async () => {
        const result = await engine.mergeMessage(userDataAdd2);
        expect(result.isOk()).toBeTruthy();
        expect((await engine.getUserData(fid, UserDataType.USERNAME))._unsafeUnwrap()).toMatchObject(userDataAdd2);
      });
      test("fails when custody address no longer owns the ens", async () => {
        jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
          return Promise.resolve(randomEthAddress);
        });

        const result = await engine.mergeMessage(userDataAdd);
        expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
        expect(result._unsafeUnwrapErr().message).toMatch("does not match proof");
      });
      test("fails when verified address no longer owns the ens", async () => {
        // Remove the verification
        const verificationRemove = await Factories.VerificationRemoveMessage.create(
          {
            data: {
              fid,
              timestamp: verificationAdd.data.timestamp + 2,
              verificationRemoveBody: { address: verificationAdd.data.verificationAddAddressBody.address },
            },
          },
          { transient: { signer } },
        );
        expect(await engine.mergeMessage(verificationRemove)).toMatchObject(ok({}));
        const result = await engine.mergeMessage(userDataAdd2);
        expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
        expect(result._unsafeUnwrapErr().message).toMatch("ens name does not belong to fid");
      });
      test("fails when unable to resolve ens name", async () => {
        jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
          throw new Error("Unable to resolve ens name");
        });

        const result = await engine.mergeMessage(userDataAdd);
        expect(result).toMatchObject(err({ errCode: "unavailable.network_failure" }));
        expect(result._unsafeUnwrapErr().message).toMatch("failed to resolve ens");
      });

      test("fails when fid on message doesn't match fid on ens name proof", async () => {
        const fid2 = Factories.Fid.build();
        const signer2 = Factories.Ed25519Signer.build();
        const custodySigner2 = Factories.Eip712Signer.build();
        const signerKey2 = (await signer2.getSignerKey())._unsafeUnwrap();
        const custodySignerKey2 = (await custodySigner2.getSignerKey())._unsafeUnwrap();
        const custodyEvent2 = Factories.IdRegistryOnChainEvent.build(
          { fid: fid2 },
          { transient: { to: custodySignerKey2 } },
        );
        const signerAddEvent2 = Factories.SignerOnChainEvent.build(
          { fid: fid2 },
          { transient: { signer: signerKey2 } },
        );
        const storageEvent2 = Factories.StorageRentOnChainEvent.build({ fid: fid2 });
        await engine.mergeOnChainEvent(custodyEvent2);
        await engine.mergeOnChainEvent(signerAddEvent2);
        await engine.mergeOnChainEvent(storageEvent2);

        const spoofedUserDataAdd = await Factories.UserDataAddMessage.create(
          {
            data: {
              fid: fid2,
              userDataBody: {
                type: UserDataType.USERNAME,
                value: "test123.eth",
              },
            },
          },
          { transient: { signer: signer2 } },
        );

        const result = await engine.mergeMessage(spoofedUserDataAdd);
        expect(result).toMatchObject(err({ errCode: "bad_request.validation_failure" }));
        expect(result._unsafeUnwrapErr().message).toMatch(`fid ${fid} does not match message fid ${fid2}`);
      });

      test("revokes the user data add when the username proof is revoked", async () => {
        const result = await engine.mergeMessage(userDataAdd);
        expect(result.isOk()).toBeTruthy();
        expect((await engine.getUserData(fid, UserDataType.USERNAME))._unsafeUnwrap()).toMatchObject(userDataAdd);

        jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
          return Promise.resolve(randomEthAddress);
        });
        const revokeResult = await engine.validateOrRevokeMessage(test1Message);
        expect(revokeResult.isOk()).toBeTruthy();

        expect((await engine.getUserData(fid, UserDataType.USERNAME))._unsafeUnwrap()).toMatchObject(userDataAdd);
      });
    });

    describe("validateOrRevokeMessage", () => {
      let mergedMessage: Message;
      beforeEach(async () => {
        const custodyAddress = bytesToHexString(custodyEvent.idRegisterEventBody.to)._unsafeUnwrap();
        jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
          return Promise.resolve(custodyAddress);
        });
        mergedMessage = await createProof("test3.eth", null, custodyAddress);
        const result = await engine.mergeMessage(mergedMessage);
        expect(result.isOk()).toBeTruthy();
        usernameProofEvents = [];
      });
      test("revokes an ens message when ens is no longer valid", async () => {
        jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
          return Promise.resolve(randomEthAddress);
        });
        const result = await engine.validateOrRevokeMessage(mergedMessage);
        expect(result.isOk()).toBeTruthy();

        expect(usernameProofEvents.length).toBe(1);
        expect(usernameProofEvents[0]?.deletedUsernameProof).toBeDefined();
        expect(usernameProofEvents[0]?.deletedUsernameProof).toEqual(mergedMessage.data?.usernameProofBody);
        expect(usernameProofEvents[0]?.usernameProof).toBeUndefined();
      });
      test("does not revoke a message when address resolution temporarily fails", async () => {
        jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
          throw new Error("test");
        });
        const result = await engine.validateOrRevokeMessage(mergedMessage);
        expect(result._unsafeUnwrapErr().errCode).toEqual("unavailable.network_failure");
        expect(result._unsafeUnwrapErr().message).toMatch("failed to resolve ens name");

        expect(usernameProofEvents.length).toBe(0);
      });
    });
  });
});

describe("mergeMessages", () => {
  let mergedMessages: Message[];
  const handleMergeMessage = (event: MergeMessageHubEvent) => {
    mergedMessages.push(event.mergeMessageBody.message);
  };

  beforeAll(() => {
    engine.eventHandler.on("mergeMessage", handleMergeMessage);
  });

  afterAll(() => {
    engine.eventHandler.off("mergeMessage", handleMergeMessage);
  });

  beforeEach(async () => {
    mergedMessages = [];
    await engine.mergeOnChainEvent(custodyEvent);
    await engine.mergeOnChainEvent(signerAddEvent);
    await engine.mergeOnChainEvent(storageEvent);
  });

  test("succeeds and merges messages in parallel", async () => {
    const results = await engine.mergeMessages([castAdd, reactionAdd, linkAdd, userDataAdd, verificationAdd]);
    for (let i = 0; i < results.size; i++) {
      expect(results.get(i)).toBeInstanceOf(Ok);
    }
    expect(new Set(mergedMessages)).toEqual(new Set([castAdd, reactionAdd, linkAdd, userDataAdd, verificationAdd]));
  });

  test("succeeds with linkAdd and compaction messages", async () => {
    const linkCompactState = await Factories.LinkCompactStateMessage.create(
      {
        data: {
          fid,
          linkCompactStateBody: { targetFids: [linkAdd.data.linkBody.targetFid as number] },
          timestamp: linkAdd.data.timestamp + 1,
        },
      },
      { transient: { signer } },
    );

    // Merge them together
    const results = await engine.mergeMessages([linkAdd, linkCompactState]);

    expect(results.size).toBe(2);
    expect(results.get(0)).toBeInstanceOf(Ok);
    expect(results.get(1)).toBeInstanceOf(Ok);

    expect(new Set(mergedMessages)).toEqual(new Set([linkAdd, linkCompactState]));
  });

  test("Correctly handles incorrect messages per store", async () => {
    const castAdd2 = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });
    const results = await engine.mergeMessages([castAdd, castAdd2, castAdd2, linkAdd]);
    expect(results.size).toBe(4);

    expect(results.get(0)).toBeInstanceOf(Ok);
    expect(results.get(1)).toBeInstanceOf(Ok);
    expect(results.get(2)).toMatchObject(err({ errCode: "bad_request.duplicate" }));
    expect(results.get(3)).toBeInstanceOf(Ok);
  });

  test("Handles validation errors", async () => {
    const badCastAdd = await Factories.CastAddMessage.create({ data: { fid: 0, network } }, { transient: { signer } });
    let results = await engine.mergeMessages([verificationAdd, badCastAdd, castAdd]);
    expect(results.size).toBe(3);

    expect(results.get(0)).toBeInstanceOf(Ok);
    expect(results.get(1)).toMatchObject(err({ errCode: "bad_request.unknown_fid" }));
    expect(retryEventsForFidMock).toHaveBeenLastCalledWith(0);
    expect(results.get(2)).toBeInstanceOf(Ok);

    const fid2 = Factories.Fid.build();
    const signer2 = Factories.Ed25519Signer.build();
    const custodySigner2 = Factories.Eip712Signer.build();
    const signerKey2 = (await signer2.getSignerKey())._unsafeUnwrap();
    const custodySignerKey2 = (await custodySigner2.getSignerKey())._unsafeUnwrap();
    const custodyEvent2 = Factories.IdRegistryOnChainEvent.build(
      { fid: fid2 },
      { transient: { to: custodySignerKey2 } },
    );
    const signerAddEvent2 = Factories.SignerOnChainEvent.build({ fid: fid2 }, { transient: { signer: signerKey2 } });
    const storageEvent2 = Factories.StorageRentOnChainEvent.build({ fid: fid2 });

    const castAdd2 = await Factories.CastAddMessage.create(
      { data: { fid: fid2, network } },
      { transient: { signer: signer2 } },
    );

    // Adding without custody address is invalid
    results = await engine.mergeMessages([reactionAdd, castAdd2]);
    expect(results.size).toBe(2);

    expect(results.get(0)).toBeInstanceOf(Ok);
    expect(results.get(1)).toMatchObject(err({ errCode: "bad_request.unknown_fid" }));
    expect(retryEventsForFidMock).toHaveBeenLastCalledWith(fid2);

    // Add custody address, but adding without signer is invalid
    await engine.mergeOnChainEvent(custodyEvent2);
    results = await engine.mergeMessages([castAdd2, linkAdd]);
    expect(results.size).toBe(2);

    expect(results.get(0)).toMatchObject(err({ errCode: "bad_request.unknown_signer" }));
    expect(retryEventsForFidMock).toHaveBeenLastCalledWith(fid2);
    expect(results.get(1)).toBeInstanceOf(Ok);

    // Add signer address, but adding without storage is invalid
    await engine.mergeOnChainEvent(signerAddEvent2);
    results = await engine.mergeMessages([userDataAdd, castAdd2]);
    expect(results.size).toBe(2);

    expect(results.get(0)).toBeInstanceOf(Ok);
    expect(results.get(1)).toMatchObject(err({ errCode: "bad_request.no_storage" }));
    expect(retryEventsForFidMock).toHaveBeenLastCalledWith(fid2);

    // Add the storage event, and now it should merge
    await engine.mergeOnChainEvent(storageEvent2);
    results = await engine.mergeMessages([castAdd2, verificationAdd]);
    expect(results.size).toBe(2);

    expect(results.get(0)).toBeInstanceOf(Ok);
    expect(results.get(1)).toMatchObject(err({ errCode: "bad_request.duplicate" })); // verificationAdd is duplicate (It has already been merged above)
  });
});

describe("revokeMessagesBySigner", () => {
  let revokedMessages: Message[];
  const handleRevokedMessage = (event: RevokeMessageHubEvent) => {
    revokedMessages.push(event.revokeMessageBody.message);
  };

  beforeAll(() => {
    engine.eventHandler.on("revokeMessage", handleRevokedMessage);
  });

  afterAll(() => {
    engine.eventHandler.off("revokeMessage", handleRevokedMessage);
  });

  beforeEach(async () => {
    revokedMessages = [];
    await engine.mergeOnChainEvent(custodyEvent);
    await engine.mergeOnChainEvent(signerAddEvent);
    await engine.mergeOnChainEvent(storageEvent);
    await engine.mergeMessage(castAdd);
    await engine.mergeMessage(reactionAdd);
    await engine.mergeMessage(linkAdd);
    await engine.mergeMessage(verificationAdd);
    await engine.mergeMessage(userDataAdd);
  });

  const checkMessage = (message: Message): Promise<Message> => {
    const data = message.data as MessageData;
    const tsHash = makeTsHash(data.timestamp, message.hash)._unsafeUnwrap();
    return getMessage(db, data.fid, typeToSetPostfix(data.type), tsHash);
  };

  test("revokes messages signed by Ed25519 signer", async () => {
    const signerMessages = [castAdd, reactionAdd, linkAdd, verificationAdd, userDataAdd];
    for (const message of signerMessages) {
      await expect(checkMessage(message)).resolves.toEqual(message);
    }
    await expect(engine.revokeMessagesBySigner(fid, signerKey)).resolves.toBeInstanceOf(Ok);
    for (const message of signerMessages) {
      await expect(checkMessage(message)).rejects.toThrow();
    }
    expect(revokedMessages.sort((a, b) => bytesCompare(a.hash, b.hash))).toEqual(
      signerMessages.sort((a, b) => bytesCompare(a.hash, b.hash)),
    );
  });
});

describe("with listeners and workers", () => {
  let liveEngine: Engine;
  setReferenceDateForTest(100000000000000000000000);

  let revokedMessages: Message[];

  const handleRevokeMessage = (event: RevokeMessageHubEvent) => {
    revokedMessages.push(event.revokeMessageBody.message);
  };

  beforeEach(async () => {
    revokedMessages = [];
    liveEngine = new Engine(db, FarcasterNetwork.TESTNET);
    liveEngine.eventHandler.on("revokeMessage", handleRevokeMessage);
    await liveEngine.start();
  });

  afterEach(async () => {
    liveEngine.eventHandler.off("revokeMessage", handleRevokeMessage);
    await liveEngine.stop();
  });

  describe("with messages", () => {
    beforeEach(async () => {
      await liveEngine.mergeOnChainEvent(custodyEvent);
      await liveEngine.mergeOnChainEvent(signerAddEvent);
      await liveEngine.mergeOnChainEvent(storageEvent);
      await liveEngine.mergeMessages([castAdd, reactionAdd, linkAdd]);
      expect(await liveEngine.getCast(fid, castAdd.hash)).toEqual(ok(castAdd));
      expect(
        await liveEngine.getReaction(
          fid,
          reactionAdd.data.reactionBody.type,
          reactionAdd.data.reactionBody.targetCastId as CastId,
        ),
      ).toEqual(ok(reactionAdd));
      setReferenceDateForTest(100000000000000000000000);
      expect(
        await liveEngine.getLink(fid, linkAdd.data.linkBody.type, linkAdd.data.linkBody.targetFid as number),
      ).toEqual(ok(linkAdd));
    });

    test("revokes messages when onchain signer is removed", async () => {
      await expect(liveEngine.mergeOnChainEvent(signerRemoveEvent)).resolves.toBeInstanceOf(Ok);

      expect(revokedMessages).toEqual([]);
      await sleep(200); // Wait for engine to revoke messages
      expect(revokedMessages.sort((a, b) => bytesCompare(a.hash, b.hash))).toEqual(
        [castAdd, reactionAdd, linkAdd].sort((a, b) => bytesCompare(a.hash, b.hash)),
      );
    });

    test("does not revoke UserDataAdd when fname is transferred to different address but same fid", async () => {
      const fname = Factories.Fname.build();
      const nameProof = Factories.UserNameProof.build({
        name: fname,
        fid,
        owner: custodyEvent.idRegisterEventBody.to,
      });
      const anotherNameProof = Factories.UserNameProof.build({
        name: Factories.Fname.build(),
        fid,
        owner: custodyEvent.idRegisterEventBody.to,
      });
      await expect(liveEngine.mergeUserNameProof(nameProof)).resolves.toBeInstanceOf(Ok);
      await expect(liveEngine.mergeUserNameProof(anotherNameProof)).resolves.toBeInstanceOf(Ok);
      const fnameAdd = await Factories.UserDataAddMessage.create(
        {
          data: {
            userDataBody: { type: UserDataType.USERNAME, value: bytesToUtf8String(fname)._unsafeUnwrap() },
            fid,
          },
        },
        { transient: { signer } },
      );
      await expect(liveEngine.mergeMessage(fnameAdd)).resolves.toBeInstanceOf(Ok);
      const nameTransferToDifferentOwnerAddress = Factories.UserNameProof.build({
        name: fname,
        fid,
        owner: Factories.EthAddress.build(),
        timestamp: nameProof.timestamp + 1,
      });
      const nameTransferToDifferentFid = Factories.UserNameProof.build({
        name: fname,
        fid: Factories.Fid.build(),
        owner: Factories.EthAddress.build(),
        timestamp: nameProof.timestamp + 2,
      });
      const anotherNameTransfer = Factories.UserNameProof.build({
        name: anotherNameProof.name,
        fid,
        owner: Factories.EthAddress.build(),
        timestamp: anotherNameProof.timestamp + 1,
      });
      await expect(liveEngine.mergeUserNameProof(anotherNameTransfer)).resolves.toBeInstanceOf(Ok);
      expect(revokedMessages).toEqual([]);
      await sleep(200); // Wait for engine to revoke messages
      // Does not revoke name because current username has not been transferred yet
      expect(revokedMessages).toEqual([]);

      await expect(liveEngine.mergeUserNameProof(nameTransferToDifferentOwnerAddress)).resolves.toBeInstanceOf(Ok);
      expect(revokedMessages).toEqual([]);
      await sleep(200); // Wait for engine to revoke messages
      // Does not revoke name because username belongs to the same fid
      expect(revokedMessages).toEqual([]);

      await expect(liveEngine.mergeUserNameProof(nameTransferToDifferentFid)).resolves.toBeInstanceOf(Ok);
      expect(revokedMessages).toEqual([]);
      await sleep(200); // Wait for engine to revoke messages
      // Revokes because fid does not own the name anymore
      expect(revokedMessages).toEqual([fnameAdd]);
    });
  });
});

describe("stop", () => {
  test("removes all event listeners", async () => {
    const eventNames: (keyof StoreEvents)[] = ["mergeOnChainEvent", "mergeUsernameProofEvent"];
    const scopedEngine = new Engine(db, FarcasterNetwork.TESTNET);
    for (const eventName of eventNames) {
      expect(scopedEngine.eventHandler.listenerCount(eventName)).toEqual(0);
    }
    await scopedEngine.start();
    for (const eventName of eventNames) {
      expect(scopedEngine.eventHandler.listenerCount(eventName)).toEqual(1);
    }
    await scopedEngine.stop();
    for (const eventName of eventNames) {
      expect(scopedEngine.eventHandler.listenerCount(eventName)).toEqual(0);
    }
  });
});
