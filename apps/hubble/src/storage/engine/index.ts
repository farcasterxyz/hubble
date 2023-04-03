import * as protobufs from '@farcaster/protobufs';
import {
  bytesCompare,
  bytesToHexString,
  HubAsyncResult,
  HubError,
  HubResult,
  utf8StringToBytes,
  validations,
} from '@farcaster/utils';
import fs from 'fs';
import { err, ok, Result, ResultAsync } from 'neverthrow';
import { Worker } from 'worker_threads';
import { SyncId } from '~/network/sync/syncId';
import { getManyMessages, getMessage, getMessagesBySignerIterator, typeToSetPostfix } from '~/storage/db/message';
import RocksDB from '~/storage/db/rocksdb';
import { FID_BYTES, RootPrefix, TSHASH_LENGTH, UserPostfix } from '~/storage/db/types';
import CastStore from '~/storage/stores/castStore';
import ReactionStore from '~/storage/stores/reactionStore';
import SignerStore from '~/storage/stores/signerStore';
import StoreEventHandler from '~/storage/stores/storeEventHandler';
import { MessagesPage, PageOptions } from '~/storage/stores/types';
import UserDataStore from '~/storage/stores/userDataStore';
import VerificationStore from '~/storage/stores/verificationStore';
import { logger } from '~/utils/logger';
import { StorageCache } from '~/storage/engine/storageCache';
import {
  RevokeMessagesBySignerJobQueue,
  RevokeMessagesBySignerJobWorker,
} from '~/storage/jobs/revokeMessagesBySignerJob';
import { getIdRegistryEventByCustodyAddress } from '../db/idRegistryEvent';

const log = logger.child({
  component: 'Engine',
});

class Engine {
  public eventHandler: StoreEventHandler;

  private _db: RocksDB;
  private _network: protobufs.FarcasterNetwork;

  private _reactionStore: ReactionStore;
  private _signerStore: SignerStore;
  private _castStore: CastStore;
  private _userDataStore: UserDataStore;
  private _verificationStore: VerificationStore;

  private _validationWorker: Worker | undefined;
  private _validationWorkerJobId = 0;
  private _validationWorkerPromiseMap = new Map<number, (resolve: HubResult<protobufs.Message>) => void>();

  private _storageCache: StorageCache;
  private _revokeSignerQueue: RevokeMessagesBySignerJobQueue;
  private _revokeSignerWorker: RevokeMessagesBySignerJobWorker;

  constructor(db: RocksDB, network: protobufs.FarcasterNetwork) {
    this._db = db;
    this._network = network;

    this._storageCache = new StorageCache();
    this.eventHandler = new StoreEventHandler(db, this._storageCache);

    this._reactionStore = new ReactionStore(db, this.eventHandler);
    this._signerStore = new SignerStore(db, this.eventHandler);
    this._castStore = new CastStore(db, this.eventHandler);
    this._userDataStore = new UserDataStore(db, this.eventHandler);
    this._verificationStore = new VerificationStore(db, this.eventHandler);

    this._revokeSignerQueue = new RevokeMessagesBySignerJobQueue(db);
    this._revokeSignerWorker = new RevokeMessagesBySignerJobWorker(this._revokeSignerQueue, db, this);

    this.handleMergeMessageEvent = this.handleMergeMessageEvent.bind(this);
    this.handleMergeIdRegistryEvent = this.handleMergeIdRegistryEvent.bind(this);
    this.handleMergeNameRegistryEvent = this.handleMergeNameRegistryEvent.bind(this);
    this.handleRevokeMessageEvent = this.handleRevokeMessageEvent.bind(this);
    this.handlePruneMessageEvent = this.handlePruneMessageEvent.bind(this);
  }

  async start(): Promise<void> {
    log.info('starting engine');

    this._revokeSignerWorker.start();

    if (!this._validationWorker) {
      const workerPath = './build/storage/engine/validation.worker.js';
      try {
        if (fs.existsSync(workerPath)) {
          this._validationWorker = new Worker(workerPath);

          logger.info({ workerPath }, 'created validation worker thread');

          this._validationWorker.on('message', (data) => {
            const { id, message, errCode, errMessage } = data;
            const resolve = this._validationWorkerPromiseMap.get(id);

            if (resolve) {
              this._validationWorkerPromiseMap.delete(id);
              if (message) {
                resolve(ok(message));
              } else {
                resolve(err(new HubError(errCode, errMessage)));
              }
            } else {
              logger.warn({ id }, 'validation worker promise.response not found');
            }
          });
        } else {
          logger.warn({ workerPath }, 'validation.worker.js not found, falling back to main thread');
        }
      } catch (e) {
        logger.warn({ workerPath, e }, 'failed to create validation worker, falling back to main thread');
      }
    }

    this.eventHandler.on('mergeIdRegistryEvent', this.handleMergeIdRegistryEvent);
    this.eventHandler.on('mergeNameRegistryEvent', this.handleMergeNameRegistryEvent);
    this.eventHandler.on('mergeMessage', this.handleMergeMessageEvent);
    this.eventHandler.on('revokeMessage', this.handleRevokeMessageEvent);
    this.eventHandler.on('pruneMessage', this.handlePruneMessageEvent);

    await this._storageCache.syncFromDb(this._db);
    log.info('engine started');
  }

  async stop(): Promise<void> {
    log.info('stopping engine');
    this.eventHandler.off('mergeIdRegistryEvent', this.handleMergeIdRegistryEvent);
    this.eventHandler.off('mergeNameRegistryEvent', this.handleMergeNameRegistryEvent);
    this.eventHandler.off('mergeMessage', this.handleMergeMessageEvent);
    this.eventHandler.off('revokeMessage', this.handleRevokeMessageEvent);
    this.eventHandler.off('pruneMessage', this.handlePruneMessageEvent);

    this._revokeSignerWorker.start();

    if (this._validationWorker) {
      await this._validationWorker.terminate();
      this._validationWorker = undefined;
    }
    log.info('engine stopped');
  }

  async mergeMessages(messages: protobufs.Message[]): Promise<Array<HubResult<number>>> {
    return Promise.all(messages.map((message) => this.mergeMessage(message)));
  }

  async mergeMessage(message: protobufs.Message): HubAsyncResult<number> {
    const validatedMessage = await this.validateMessage(message);
    if (validatedMessage.isErr()) {
      return err(validatedMessage.error);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const setPostfix = typeToSetPostfix(message.data!.type);

    switch (setPostfix) {
      case UserPostfix.ReactionMessage: {
        return ResultAsync.fromPromise(this._reactionStore.merge(message), (e) => e as HubError);
      }
      case UserPostfix.SignerMessage: {
        return ResultAsync.fromPromise(this._signerStore.merge(message), (e) => e as HubError);
      }
      case UserPostfix.CastMessage: {
        return ResultAsync.fromPromise(this._castStore.merge(message), (e) => e as HubError);
      }
      case UserPostfix.UserDataMessage: {
        return ResultAsync.fromPromise(this._userDataStore.merge(message), (e) => e as HubError);
      }
      case UserPostfix.VerificationMessage: {
        return ResultAsync.fromPromise(this._verificationStore.merge(message), (e) => e as HubError);
      }
      default: {
        return err(new HubError('bad_request.validation_failure', 'invalid message type'));
      }
    }
  }

  async mergeIdRegistryEvent(event: protobufs.IdRegistryEvent): HubAsyncResult<number> {
    if (
      event.type === protobufs.IdRegistryEventType.REGISTER ||
      event.type === protobufs.IdRegistryEventType.TRANSFER
    ) {
      return ResultAsync.fromPromise(this._signerStore.mergeIdRegistryEvent(event), (e) => e as HubError);
    }

    return err(new HubError('bad_request.validation_failure', 'invalid event type'));
  }

  async mergeNameRegistryEvent(event: protobufs.NameRegistryEvent): HubAsyncResult<number> {
    if (
      event.type === protobufs.NameRegistryEventType.TRANSFER ||
      event.type === protobufs.NameRegistryEventType.RENEW
    ) {
      return ResultAsync.fromPromise(this._userDataStore.mergeNameRegistryEvent(event), (e) => e as HubError);
    }

    return err(new HubError('bad_request.validation_failure', 'invalid event type'));
  }

  async revokeMessagesBySigner(fid: number, signer: Uint8Array): HubAsyncResult<void> {
    const signerHex = bytesToHexString(signer);
    if (signerHex.isErr()) {
      return err(signerHex.error);
    }

    let revokedCount = 0;

    const iterator = getMessagesBySignerIterator(this._db, fid, signer);

    const revokeMessageByKey = async (key: Buffer): HubAsyncResult<number | undefined> => {
      const length = key.length;
      const type = key.readUint8(length - TSHASH_LENGTH - 1);
      const setPostfix = typeToSetPostfix(type);
      const tsHash = Uint8Array.from(key.subarray(length - TSHASH_LENGTH));
      const message = await ResultAsync.fromPromise(
        getMessage(this._db, fid, setPostfix, tsHash),
        (e) => e as HubError
      );
      if (message.isErr()) {
        return err(message.error);
      }

      switch (setPostfix) {
        case UserPostfix.ReactionMessage: {
          return this._reactionStore.revoke(message.value);
        }
        case UserPostfix.SignerMessage: {
          return this._signerStore.revoke(message.value);
        }
        case UserPostfix.CastMessage: {
          return this._castStore.revoke(message.value);
        }
        case UserPostfix.UserDataMessage: {
          return this._userDataStore.revoke(message.value);
        }
        case UserPostfix.VerificationMessage: {
          return this._verificationStore.revoke(message.value);
        }
        default: {
          return err(new HubError('bad_request.invalid_param', 'invalid message type'));
        }
      }
    };

    for await (const [key] of iterator) {
      const revokeResult = await revokeMessageByKey(key as Buffer);
      revokeResult.match(
        () => {
          revokedCount += 1;
        },
        (e) => {
          log.error(
            { errCode: e.errCode },
            `error revoking message from signer ${signerHex.value} and fid ${fid}: ${e.message}`
          );
        }
      );
    }

    if (revokedCount > 0) {
      log.info(`revoked ${revokedCount} messages from ${signerHex.value} and fid ${fid}`);
    }

    return ok(undefined);
  }

  async pruneMessages(fid: number): HubAsyncResult<void> {
    const logPruneResult = (result: HubResult<number[]>, store: string): void => {
      result.match(
        (ids) => {
          if (ids.length > 0) {
            log.info(`pruned ${ids.length} ${store} messages for fid ${fid}`);
          }
        },
        (e) => {
          log.error({ errCode: e.errCode }, `error pruning ${store} messages for fid ${fid}: ${e.message}`);
        }
      );
    };

    const signerResult = await this._signerStore.pruneMessages(fid);
    logPruneResult(signerResult, 'signer');

    const castResult = await this._castStore.pruneMessages(fid);
    logPruneResult(castResult, 'cast');

    const reactionResult = await this._reactionStore.pruneMessages(fid);
    logPruneResult(reactionResult, 'reaction');

    const verificationResult = await this._verificationStore.pruneMessages(fid);
    logPruneResult(verificationResult, 'verification');

    const userDataResult = await this._userDataStore.pruneMessages(fid);
    logPruneResult(userDataResult, 'user data');

    return ok(undefined);
  }

  /** revoke message if it is not valid */
  async validateOrRevokeMessage(message: protobufs.Message): HubAsyncResult<number | undefined> {
    const isValid = await this.validateMessage(message);

    if (isValid.isErr() && message.data) {
      const setPostfix = typeToSetPostfix(message.data.type);

      switch (setPostfix) {
        case UserPostfix.ReactionMessage: {
          return this._reactionStore.revoke(message);
        }
        case UserPostfix.SignerMessage: {
          return this._signerStore.revoke(message);
        }
        case UserPostfix.CastMessage: {
          return this._castStore.revoke(message);
        }
        case UserPostfix.UserDataMessage: {
          return this._userDataStore.revoke(message);
        }
        case UserPostfix.VerificationMessage: {
          return this._verificationStore.revoke(message);
        }
        default: {
          return err(new HubError('bad_request.invalid_param', 'invalid message type'));
        }
      }
    }

    return ok(undefined);
  }

  /* -------------------------------------------------------------------------- */
  /*                             Event Methods                                  */
  /* -------------------------------------------------------------------------- */

  async getEvent(id: number): HubAsyncResult<protobufs.HubEvent> {
    return this.eventHandler.getEvent(id);
  }

  /* -------------------------------------------------------------------------- */
  /*                             Sync Methods                                   */
  /* -------------------------------------------------------------------------- */

  async forEachMessage(callback: (message: protobufs.Message, key: Buffer) => Promise<boolean | void>): Promise<void> {
    const allUserPrefix = Buffer.from([RootPrefix.User]);

    for await (const [key, value] of this._db.iteratorByPrefix(allUserPrefix, { keys: true })) {
      if (!key || !value) {
        break;
      }

      if (key.length !== 1 + FID_BYTES + 1 + TSHASH_LENGTH) {
        // Not a message key, so we can skip it.
        continue;
      }

      // Get the UserMessagePostfix from the key, which is the 1 + 32 bytes from the start
      const postfix = key.slice(1 + FID_BYTES, 1 + FID_BYTES + 1)[0];
      if (
        postfix !== UserPostfix.CastMessage &&
        postfix !== UserPostfix.AmpMessage &&
        postfix !== UserPostfix.ReactionMessage &&
        postfix !== UserPostfix.VerificationMessage &&
        postfix !== UserPostfix.SignerMessage &&
        postfix !== UserPostfix.UserDataMessage
      ) {
        // Not a message key, so we can skip it.
        continue;
      }

      const message = Result.fromThrowable(
        () => protobufs.Message.decode(new Uint8Array(value)),
        (e) => e as HubError
      )();

      if (message.isOk()) {
        const done = await callback(message.value, key);
        if (done) {
          break;
        }
      }
    }
  }

  async getAllMessagesBySyncIds(syncIds: Uint8Array[]): HubAsyncResult<protobufs.Message[]> {
    const hashesBuf = syncIds.map((syncIdHash) => SyncId.pkFromSyncId(syncIdHash));
    const messages = await ResultAsync.fromPromise(getManyMessages(this._db, hashesBuf), (e) => e as HubError);

    return messages;
  }

  /* -------------------------------------------------------------------------- */
  /*                             Cast Store Methods                             */
  /* -------------------------------------------------------------------------- */

  async getCast(fid: number, hash: Uint8Array): HubAsyncResult<protobufs.CastAddMessage> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._castStore.getCastAdd(fid, hash), (e) => e as HubError);
  }

  async getCastsByFid(
    fid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.CastAddMessage>> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._castStore.getCastAddsByFid(fid, pageOptions), (e) => e as HubError);
  }

  async getCastsByParent(
    parentId: protobufs.CastId,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.CastAddMessage>> {
    const validatedCastId = validations.validateCastId(parentId);
    if (validatedCastId.isErr()) {
      return err(validatedCastId.error);
    }

    return ResultAsync.fromPromise(this._castStore.getCastsByParent(parentId, pageOptions), (e) => e as HubError);
  }

  async getCastsByMention(
    mentionFid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.CastAddMessage>> {
    const validatedFid = validations.validateFid(mentionFid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._castStore.getCastsByMention(mentionFid, pageOptions), (e) => e as HubError);
  }

  async getAllCastMessagesByFid(
    fid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.CastAddMessage | protobufs.CastRemoveMessage>> {
    return ResultAsync.fromPromise(this._castStore.getAllCastMessagesByFid(fid, pageOptions), (e) => e as HubError);
  }

  /* -------------------------------------------------------------------------- */
  /*                            Reaction Store Methods                          */
  /* -------------------------------------------------------------------------- */

  async getReaction(
    fid: number,
    type: protobufs.ReactionType,
    cast: protobufs.CastId
  ): HubAsyncResult<protobufs.ReactionAddMessage> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    const validatedCastId = validations.validateCastId(cast);
    if (validatedCastId.isErr()) {
      return err(validatedCastId.error);
    }

    return ResultAsync.fromPromise(this._reactionStore.getReactionAdd(fid, type, cast), (e) => e as HubError);
  }

  async getReactionsByFid(
    fid: number,
    type?: protobufs.ReactionType,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.ReactionAddMessage>> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(
      this._reactionStore.getReactionAddsByFid(fid, type, pageOptions),
      (e) => e as HubError
    );
  }

  async getReactionsByCast(
    castId: protobufs.CastId,
    type?: protobufs.ReactionType,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.ReactionAddMessage>> {
    const validatedCastId = validations.validateCastId(castId);
    if (validatedCastId.isErr()) {
      return err(validatedCastId.error);
    }

    return ResultAsync.fromPromise(
      this._reactionStore.getReactionsByTargetCast(castId, type, pageOptions),
      (e) => e as HubError
    );
  }

  async getAllReactionMessagesByFid(
    fid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.ReactionAddMessage | protobufs.ReactionRemoveMessage>> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(
      this._reactionStore.getAllReactionMessagesByFid(fid, pageOptions),
      (e) => e as HubError
    );
  }

  /* -------------------------------------------------------------------------- */
  /*                          Verification Store Methods                        */
  /* -------------------------------------------------------------------------- */

  async getVerification(fid: number, address: Uint8Array): HubAsyncResult<protobufs.VerificationAddEthAddressMessage> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    const validatedAddress = validations.validateEthAddress(address);
    if (validatedAddress.isErr()) {
      return err(validatedAddress.error);
    }

    return ResultAsync.fromPromise(this._verificationStore.getVerificationAdd(fid, address), (e) => e as HubError);
  }

  async getVerificationsByFid(
    fid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.VerificationAddEthAddressMessage>> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(
      this._verificationStore.getVerificationAddsByFid(fid, pageOptions),
      (e) => e as HubError
    );
  }

  async getAllVerificationMessagesByFid(
    fid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.VerificationAddEthAddressMessage | protobufs.VerificationRemoveMessage>> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(
      this._verificationStore.getAllVerificationMessagesByFid(fid, pageOptions),
      (e) => e as HubError
    );
  }

  /* -------------------------------------------------------------------------- */
  /*                              Signer Store Methods                          */
  /* -------------------------------------------------------------------------- */

  async getSigner(fid: number, signerPubKey: Uint8Array): HubAsyncResult<protobufs.SignerAddMessage> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    const validatedPubKey = validations.validateEd25519PublicKey(signerPubKey);
    if (validatedPubKey.isErr()) {
      return err(validatedPubKey.error);
    }

    return ResultAsync.fromPromise(this._signerStore.getSignerAdd(fid, signerPubKey), (e) => e as HubError);
  }

  async getSignersByFid(
    fid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.SignerAddMessage>> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._signerStore.getSignerAddsByFid(fid, pageOptions), (e) => e as HubError);
  }

  async getIdRegistryEvent(fid: number): HubAsyncResult<protobufs.IdRegistryEvent> {
    return ResultAsync.fromPromise(this._signerStore.getIdRegistryEvent(fid), (e) => e as HubError);
  }

  async getIdRegistryEventByAddress(address: Uint8Array): HubAsyncResult<protobufs.IdRegistryEvent> {
    return ResultAsync.fromPromise(this._signerStore.getIdRegistryEventByAddress(address), (e) => e as HubError);
  }

  async getFids(pageOptions: PageOptions = {}): HubAsyncResult<{
    fids: number[];
    nextPageToken: Uint8Array | undefined;
  }> {
    return ResultAsync.fromPromise(this._signerStore.getFids(pageOptions), (e) => e as HubError);
  }

  async getAllSignerMessagesByFid(
    fid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.SignerAddMessage | protobufs.SignerRemoveMessage>> {
    return ResultAsync.fromPromise(this._signerStore.getAllSignerMessagesByFid(fid, pageOptions), (e) => e as HubError);
  }

  /* -------------------------------------------------------------------------- */
  /*                           User Data Store Methods                          */
  /* -------------------------------------------------------------------------- */

  async getUserData(fid: number, type: protobufs.UserDataType): HubAsyncResult<protobufs.UserDataAddMessage> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._userDataStore.getUserDataAdd(fid, type), (e) => e as HubError);
  }

  async getUserDataByFid(
    fid: number,
    pageOptions: PageOptions = {}
  ): HubAsyncResult<MessagesPage<protobufs.UserDataAddMessage>> {
    const validatedFid = validations.validateFid(fid);
    if (validatedFid.isErr()) {
      return err(validatedFid.error);
    }

    return ResultAsync.fromPromise(this._userDataStore.getUserDataAddsByFid(fid, pageOptions), (e) => e as HubError);
  }

  async getNameRegistryEvent(fname: Uint8Array): HubAsyncResult<protobufs.NameRegistryEvent> {
    const validatedFname = validations.validateFname(fname);
    if (validatedFname.isErr()) {
      return err(validatedFname.error);
    }

    return ResultAsync.fromPromise(this._userDataStore.getNameRegistryEvent(fname), (e) => e as HubError);
  }

  /* -------------------------------------------------------------------------- */
  /*                               Private Methods                              */
  /* -------------------------------------------------------------------------- */

  private async validateMessage(message: protobufs.Message): HubAsyncResult<protobufs.Message> {
    // 1. Ensure message data is present
    if (!message || !message.data) {
      return err(new HubError('bad_request.validation_failure', 'message data is missing'));
    }

    // 2. Check the network
    if (message.data.network !== this._network) {
      return err(
        new HubError(
          'bad_request.validation_failure',
          `incorrect network: ${message.data.network} (expected: ${this._network})`
        )
      );
    }

    // 3. Check that the user has a custody address
    const custodyEvent = await this.getIdRegistryEvent(message.data.fid);

    if (custodyEvent.isErr()) {
      return err(new HubError('bad_request.validation_failure', `unknown fid: ${message.data.fid}`));
    }

    // 4. Check that the signer is valid
    if (protobufs.isSignerAddMessage(message) || protobufs.isSignerRemoveMessage(message)) {
      if (bytesCompare(message.signer, custodyEvent.value.to) !== 0) {
        const hex = Result.combine([bytesToHexString(message.signer), bytesToHexString(custodyEvent.value.to)]);
        return hex.andThen(([signerHex, custodyHex]) => {
          return err(
            new HubError(
              'bad_request.validation_failure',
              `invalid signer: signer ${signerHex} does not match custody address ${custodyHex}`
            )
          );
        });
      }
    } else {
      const signerResult = await ResultAsync.fromPromise(
        this._signerStore.getSignerAdd(message.data.fid, message.signer),
        (e) => e
      );
      if (signerResult.isErr()) {
        const hex = bytesToHexString(message.signer);
        return hex.andThen((signerHex) => {
          return err(
            new HubError(
              'bad_request.validation_failure',
              `invalid signer: signer ${signerHex} not found for fid ${message.data?.fid}`
            )
          );
        });
      }
    }

    // 5. For fname add UserDataAdd messages, check that the user actually owns the fname
    if (protobufs.isUserDataAddMessage(message) && message.data.userDataBody.type === protobufs.UserDataType.FNAME) {
      // For fname messages, check if the user actually owns the fname.
      const fnameBytes = utf8StringToBytes(message.data.userDataBody.value);
      if (fnameBytes.isErr()) {
        return err(fnameBytes.error);
      }

      // Users are allowed to set fname = '' to remove their fname, so check to see if fname is set
      // before validating the custody address
      if (fnameBytes.value.length > 0) {
        // Get the NameRegistryEvent for the fname
        const fnameEvent = (await this.getNameRegistryEvent(fnameBytes.value)).mapErr((e) =>
          e.errCode === 'not_found'
            ? new HubError(
                'bad_request.validation_failure',
                `fname ${message.data.userDataBody.value} is not registered`
              )
            : e
        );
        if (fnameEvent.isErr()) {
          return err(fnameEvent.error);
        }

        // Check that the custody address for the fname and fid are the same
        if (bytesCompare(custodyEvent.value.to, fnameEvent.value.to) !== 0) {
          const hex = Result.combine([bytesToHexString(custodyEvent.value.to), bytesToHexString(fnameEvent.value.to)]);
          return hex.andThen(([custodySignerHex, fnameSignerHex]) => {
            return err(
              new HubError(
                'bad_request.validation_failure',
                `fname custody address ${fnameSignerHex} does not match custody address ${custodySignerHex} for fid ${message.data.fid}`
              )
            );
          });
        }
      }
    }

    // 6. Check message body and envelope
    if (this._validationWorker) {
      return new Promise<HubResult<protobufs.Message>>((resolve) => {
        const id = this._validationWorkerJobId++;
        this._validationWorkerPromiseMap.set(id, resolve);

        this._validationWorker?.postMessage({ id, message });
      });
    } else {
      return validations.validateMessage(message);
    }
  }

  private async handleMergeIdRegistryEvent(event: protobufs.MergeIdRegistryEventHubEvent): HubAsyncResult<void> {
    const { idRegistryEvent } = event.mergeIdRegistryEventBody;
    const fromAddress = idRegistryEvent.from;
    if (fromAddress && fromAddress.length > 0) {
      // Revoke signer messages
      const payload = protobufs.RevokeMessagesBySignerJobPayload.create({
        fid: idRegistryEvent.fid,
        signer: fromAddress,
      });
      const enqueueRevoke = await this._revokeSignerQueue.enqueueJob(payload);
      if (enqueueRevoke.isErr()) {
        log.error(
          { errCode: enqueueRevoke.error.errCode },
          `failed to enqueue revoke signer job: ${enqueueRevoke.error.message}`
        );
      }

      // Revoke UserDataAdd fname messages
      const fnameAdd = await ResultAsync.fromPromise(
        this._userDataStore.getUserDataAdd(idRegistryEvent.fid, protobufs.UserDataType.FNAME),
        () => undefined
      );
      if (fnameAdd.isOk()) {
        const revokeResult = await this._userDataStore.revoke(fnameAdd.value);
        const fnameAddHex = bytesToHexString(fnameAdd.value.hash);
        revokeResult.match(
          () =>
            log.info(
              `revoked message ${fnameAddHex._unsafeUnwrap()} for fid ${
                idRegistryEvent.fid
              } due to IdRegistryEvent transfer`
            ),
          (e) =>
            log.error(
              { errCode: e.errCode },
              `failed to revoke message ${fnameAddHex._unsafeUnwrap()} for fid ${
                idRegistryEvent.fid
              } due to IdRegistryEvent transfer: ${e.message}`
            )
        );
      }
    }

    return ok(undefined);
  }

  private async handleMergeNameRegistryEvent(event: protobufs.MergeNameRegistryEventHubEvent): HubAsyncResult<void> {
    const { nameRegistryEvent } = event.mergeNameRegistryEventBody;

    // When there is a NameRegistryEvent, we need to check if we need to revoke UserDataAdd messages from the
    // previous owner of the name.
    if (nameRegistryEvent.type === protobufs.NameRegistryEventType.TRANSFER && nameRegistryEvent.from.length > 0) {
      // Check to see if the from address has an fid
      const idRegistryEvent = await ResultAsync.fromPromise(
        getIdRegistryEventByCustodyAddress(this._db, nameRegistryEvent.from),
        () => undefined
      );

      if (idRegistryEvent.isOk()) {
        const { fid } = idRegistryEvent.value;

        // Check if this fid assigned the fname with a UserDataAdd message
        const fnameAdd = await ResultAsync.fromPromise(
          this._userDataStore.getUserDataAdd(fid, protobufs.UserDataType.FNAME),
          () => undefined
        );
        if (fnameAdd.isOk()) {
          const revokeResult = await this._userDataStore.revoke(fnameAdd.value);
          const fnameAddHex = bytesToHexString(fnameAdd.value.hash);
          revokeResult.match(
            () =>
              log.info(
                `revoked message ${fnameAddHex._unsafeUnwrap()} for fid ${fid} due to NameRegistryEvent transfer`
              ),
            (e) =>
              log.error(
                { errCode: e.errCode },
                `failed to revoke message ${fnameAddHex._unsafeUnwrap()} for fid ${fid} due to NameRegistryEvent transfer: ${
                  e.message
                }`
              )
          );
        }
      }
    }

    return ok(undefined);
  }

  private async handleMergeMessageEvent(event: protobufs.MergeMessageHubEvent): HubAsyncResult<void> {
    const { message } = event.mergeMessageBody;

    if (protobufs.isSignerRemoveMessage(message)) {
      const payload = protobufs.RevokeMessagesBySignerJobPayload.create({
        fid: message.data.fid,
        signer: message.data.signerRemoveBody.signer,
      });
      const enqueueRevoke = await this._revokeSignerQueue.enqueueJob(payload);
      if (enqueueRevoke.isErr()) {
        log.error(
          { errCode: enqueueRevoke.error.errCode },
          `failed to enqueue revoke signer job: ${enqueueRevoke.error.message}`
        );
      }
    }

    return ok(undefined);
  }

  private async handlePruneMessageEvent(event: protobufs.PruneMessageHubEvent): HubAsyncResult<void> {
    const { message } = event.pruneMessageBody;

    if (protobufs.isSignerAddMessage(message)) {
      const payload = protobufs.RevokeMessagesBySignerJobPayload.create({
        fid: message.data.fid,
        signer: message.data.signerAddBody.signer,
      });
      const enqueueRevoke = await this._revokeSignerQueue.enqueueJob(payload);
      if (enqueueRevoke.isErr()) {
        log.error(
          { errCode: enqueueRevoke.error.errCode },
          `failed to enqueue revoke signer job: ${enqueueRevoke.error.message}`
        );
      }
    }

    return ok(undefined);
  }

  private async handleRevokeMessageEvent(event: protobufs.RevokeMessageHubEvent): HubAsyncResult<void> {
    const { message } = event.revokeMessageBody;

    if (protobufs.isSignerAddMessage(message)) {
      const payload = protobufs.RevokeMessagesBySignerJobPayload.create({
        fid: message.data.fid,
        signer: message.data.signerAddBody.signer,
      });
      const enqueueRevoke = await this._revokeSignerQueue.enqueueJob(payload);
      if (enqueueRevoke.isErr()) {
        log.error(
          { errCode: enqueueRevoke.error.errCode },
          `failed to enqueue revoke signer job: ${enqueueRevoke.error.message}`
        );
      }
    }

    return ok(undefined);
  }
}

export default Engine;
