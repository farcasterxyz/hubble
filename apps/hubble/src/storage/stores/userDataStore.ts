import { UserNameProof, UserDataAddMessage, UserDataType, HubEvent } from "@farcaster/hub-nodejs";
import { ResultAsync } from "neverthrow";
import { UserPostfix } from "../db/types.js";
import { MessagesPage, PageOptions, StorePruneOptions } from "../stores/types.js";
import RocksDB from "../db/rocksdb.js";
import StoreEventHandler from "./storeEventHandler.js";
import {
  rsCreateUserDataStore,
  rsGetUserDataAdd,
  rsGetUserDataAddsByFid,
  rsGetUserNameProof,
  rsGetUserNameProofByFid,
  rsMergeUserNameProof,
  rustErrorToHubError,
} from "../../rustfunctions.js";
import { RustStoreBase } from "./rustStoreBase.js";
import { messageDecode } from "../../storage/db/message.js";

/**
 * UserDataStore persists UserData messages in RocksDB using a grow-only CRDT set to guarantee
 * eventual consistency.
 *
 * A UserData entry is a key-value pair where the key can be one of a few defined types. They are
 * added and updated with UserDataAdd messages. They cannot be deleted but can be reset to a null
 * value with another UserData add message. UserDataAdd messages collide if the dataType is
 * identical for the same user. Collisions are handled with LWW rules as follows:
 *
 * 1. Highest timestamp wins
 * 2. Highest lexicographic hash wins
 *
 * UserData messages are stored ordinally in RocksDB indexed by a unique key `fid:tsHash` which
 * makes truncating a user's earliest messages easy. Indices are built to look up user data entries
 * in each user's add set. The key value entries created are:
 *
 * 1. fid:tsHash -> cast message
 * 2. fid:set:datatype -> fid:tsHash (adds set index)
 */
class UserDataStore extends RustStoreBase<UserDataAddMessage, never> {
  constructor(db: RocksDB, eventHandler: StoreEventHandler, options: StorePruneOptions = {}) {
    const pruneSizeLimit = options.pruneSizeLimit ?? 0;

    const rustUserDataStore = rsCreateUserDataStore(db.rustDb, eventHandler.getRustStoreEventHandler(), pruneSizeLimit);

    super(db, rustUserDataStore, UserPostfix.UserDataMessage, eventHandler, pruneSizeLimit);
  }

  /**
   * Finds a UserDataAdd Message by checking the adds set index
   *
   * @param fid fid of the user who created the user data add
   * @param dataType type of UserData that was added
   * @returns the UserDataAdd Model if it exists, undefined otherwise
   */
  async getUserDataAdd(fid: number, dataType: UserDataType): Promise<UserDataAddMessage> {
    const result = await ResultAsync.fromPromise(rsGetUserDataAdd(this._rustStore, fid, dataType), rustErrorToHubError);
    if (result.isErr()) {
      throw result.error;
    }
    return messageDecode(new Uint8Array(result.value)) as UserDataAddMessage;
  }

  /** Finds all UserDataAdd messages for an fid */
  async getUserDataAddsByFid(
    fid: number,
    pageOptions: PageOptions = {},
    startTime?: number,
    stopTime?: number,
  ): Promise<MessagesPage<UserDataAddMessage>> {
    const messages_page = await rsGetUserDataAddsByFid(this._rustStore, fid, pageOptions, startTime, stopTime);

    const messages =
      messages_page.messageBytes?.map((message_bytes) => {
        return messageDecode(new Uint8Array(message_bytes)) as UserDataAddMessage;
      }) ?? [];

    return { messages, nextPageToken: messages_page.nextPageToken };
  }

  async getUserNameProof(name: Uint8Array): Promise<UserNameProof> {
    const result = await ResultAsync.fromPromise(rsGetUserNameProof(this._rustStore, name), rustErrorToHubError);
    if (result.isErr()) {
      throw result.error;
    }

    return UserNameProof.decode(new Uint8Array(result.value));
  }

  async getUserNameProofByFid(fid: number): Promise<UserNameProof> {
    const result = await ResultAsync.fromPromise(rsGetUserNameProofByFid(this._rustStore, fid), rustErrorToHubError);
    if (result.isErr()) {
      throw result.error;
    }

    return UserNameProof.decode(new Uint8Array(result.value));
  }

  async mergeUserNameProof(usernameProof: UserNameProof): Promise<number> {
    const usernameProofBytes = UserNameProof.encode(usernameProof).finish();

    const result = await ResultAsync.fromPromise(
      rsMergeUserNameProof(this._rustStore, usernameProofBytes),
      rustErrorToHubError,
    );
    if (result.isErr()) {
      throw result.error;
    }

    // Read the result bytes as a HubEvent
    const resultBytes = new Uint8Array(result.value);
    const hubEvent = HubEvent.decode(resultBytes);

    void this._eventHandler.processRustCommittedTransaction(hubEvent);
    return hubEvent.id;
  }
}

export default UserDataStore;
