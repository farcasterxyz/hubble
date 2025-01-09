import {
  bytesToHexString,
  HubAsyncResult,
  HubError,
  HubResult,
  Message,
  OnChainEvent,
  toFarcasterTime,
} from "@farcaster/hub-nodejs";
import { err, ok, Result, ResultAsync } from "neverthrow";
import cron from "node-cron";
import { logger } from "../../utils/logger.js";
import { FID_BYTES, TSHASH_LENGTH, UserMessagePostfixMax, UserPostfix } from "../db/types.js";
import RocksDB from "../db/rocksdb.js";
import Engine from "../engine/index.js";
import { makeUserKey, messageDecode } from "../db/message.js";
import { statsd } from "../../utils/statsd.js";
import { getHubState, putHubState } from "../../storage/db/hubState.js";
import { sleep } from "../../utils/crypto.js";

export const DEFAULT_VALIDATE_AND_REVOKE_MESSAGES_CRON = "10 20 * * *"; // Every day at 20:10 UTC (00:10 pm PST)

type ValidateResultWithMessage = {
  result: HubAsyncResult<number | undefined>;
  message: Message;
};

// How much time to allocate to validating and revoking each fid.
// 50 fids per second, which translates to 1/28th of the FIDs will be checked in just over 2 hours.
const TIME_SCHEDULED_PER_FID_MS = 1000 / 50;

const log = logger.child({
  component: "ValidateOrRevokeMessagesJob",
});

type SchedulerStatus = "started" | "stopped";

export class ValidateOrRevokeMessagesJobScheduler {
  private _db: RocksDB;
  private _engine: Engine;
  private _cronTask?: cron.ScheduledTask;
  private _running = false;

  // Whether to check all messages for fid%14 == new Date().getDate()%14
  private _checkAllFids;

  constructor(db: RocksDB, engine: Engine, checkAllFids = true) {
    this._db = db;
    this._engine = engine;
    this._checkAllFids = checkAllFids;
  }

  start(cronSchedule?: string) {
    this._cronTask = cron.schedule(cronSchedule ?? DEFAULT_VALIDATE_AND_REVOKE_MESSAGES_CRON, () => this.doJobs(), {
      timezone: "Etc/UTC",
    });
  }

  stop() {
    if (this._cronTask) {
      this._cronTask.stop();
    }
  }

  status(): SchedulerStatus {
    return this._cronTask ? "started" : "stopped";
  }

  async doJobs(): HubAsyncResult<number> {
    if (this._running) {
      log.info({}, "ValidateOrRevokeMessagesJob already running, skipping");
      return ok(0);
    }

    const hubStateResult = await ResultAsync.fromPromise(getHubState(this._db), (e) => e as HubError);
    if (hubStateResult.isErr()) {
      log.error({ errCode: hubStateResult.error.errCode }, `error getting hub state: ${hubStateResult.error.message}`);
      return err(hubStateResult.error);
    }
    let hubState = hubStateResult.value;

    const lastJobTimestamp = hubState.validateOrRevokeState?.lastJobTimestamp ?? 0;
    const lastFid = hubState.validateOrRevokeState?.lastFid ?? 0;

    log.info({ lastJobTimestamp, lastFid }, "ValidateOrRevokeMessagesJob: starting");

    this._running = true;
    let totalMessagesChecked = 0;
    let totalFidsChecked = 0;

    const start = Date.now();

    let finished = false;
    let pageToken: Uint8Array | undefined;
    do {
      const fidsPage = await this._engine.getFids({ pageToken });
      if (fidsPage.isErr()) {
        return err(fidsPage.error);
      }

      const { fids, nextPageToken } = fidsPage.value;
      if (!nextPageToken) {
        finished = true;
      } else {
        pageToken = nextPageToken;
      }

      for (let i = 0; i < fids.length; i++) {
        const fid = fids[i] as number;

        if (lastFid > 0 && fid < lastFid) {
          continue;
        }

        const numChecked = await this.doJobForFid(lastJobTimestamp, fid);
        const numUsernamesChecked = await this.doUsernamesJobForFid(fid);

        totalMessagesChecked += numChecked.unwrapOr(0) + numUsernamesChecked.unwrapOr(0);
        totalFidsChecked += 1;

        if (totalFidsChecked % 5000 === 0) {
          log.info({ fid, totalMessagesChecked, totalFidsChecked }, "ValidateOrRevokeMessagesJob: progress");

          // Also write the hub state to the database every 5000 FIDs, so that we can recover from
          // unfinished job
          const hubState = await getHubState(this._db);
          hubState.validateOrRevokeState = {
            lastFid: fid,
            lastJobTimestamp,
          };
          await putHubState(this._db, hubState);
        }

        // Throttle the job.
        // We run at the rate of 50 fids per second. If we are running ahead of schedule, we sleep to catch up
        if (fid % 100 === 0) {
          const allotedTimeMs = (fid - lastFid) * TIME_SCHEDULED_PER_FID_MS;
          const elapsedTimeMs = Date.now() - start;
          if (allotedTimeMs > elapsedTimeMs) {
            const sleepTimeMs = allotedTimeMs - elapsedTimeMs;
            // Sleep for the remaining time
            await sleep(sleepTimeMs);
          }
        }
      }
    } while (!finished);

    const timeTakenMs = Date.now() - start;
    log.info({ timeTakenMs, totalFidsChecked, totalMessagesChecked }, "finished ValidateOrRevokeMessagesJob");
    hubState = await getHubState(this._db);
    hubState.validateOrRevokeState = {
      lastFid: 0,
      lastJobTimestamp: toFarcasterTime(start).unwrapOr(0),
    };
    await putHubState(this._db, hubState);

    // StatsD metrics
    statsd().timing("validateOrRevokeMessagesJob.timeTakenMs", timeTakenMs);
    statsd().gauge("validateOrRevokeMessagesJob.totalMessagesChecked", totalMessagesChecked);

    this._running = false;
    return ok(totalMessagesChecked);
  }

  /**
   * Check if any signers for this FID have changed since the last time the job ran, and if so,
   * validate or revoke any messages that are affected.
   */
  async doJobForFid(lastJobTimestamp: number, fid: number): HubAsyncResult<number> {
    const prefix = makeUserKey(fid);

    const allSigners: OnChainEvent[] = [];
    let finished = false;
    let pageToken: Uint8Array | undefined;

    do {
      // First, find if any signers have changed since the last time the job ran
      const signers = await this._engine.getOnChainSignersByFid(fid);
      if (signers.isErr()) {
        log.error(
          { errCode: signers.error.errCode },
          `error getting onchain signers for FID ${fid}: ${signers.error.message}`,
        );
        return err(signers.error);
      }

      const { events, nextPageToken } = signers.value;
      if (!nextPageToken) {
        finished = true;
      } else {
        pageToken = nextPageToken;
      }
      allSigners.push(...events);
    } while (!finished);

    // Find the newest signer event
    const latestSignerEventTs = toFarcasterTime(
      1000 *
        allSigners.reduce((acc, signer) => {
          return acc > signer.blockTimestamp ? acc : signer.blockTimestamp;
        }, 0),
    ).unwrapOr(0);

    // Every 14 days, we do a full scan of all messages for this FID, to make sure we don't miss anything
    const doFullScanForFid = this._checkAllFids && fid % 28 === new Date(Date.now()).getDate() % 28;

    if (!doFullScanForFid && latestSignerEventTs < lastJobTimestamp) {
      return ok(0);
    }

    log.debug(
      { fid, lastJobTimestamp, latestSignerEventTs, doFullScanForFid },
      "ValidateOrRevokeMessagesJob: checking FID",
    );

    let count = 0;
    let validatePromises: ValidateResultWithMessage[] = [];
    const processValidationResults = async () => {
      const promises = validatePromises;
      validatePromises = [];

      for (const { result, message } of promises) {
        (await result).match(
          (result) => {
            if (result !== undefined) {
              log.info({ fid, hash: bytesToHexString(message.hash)._unsafeUnwrap() }, "revoked message");
            }
          },
          (e) => {
            log.error({ errCode: e.errCode }, `error validating and revoking message: ${e.message}`);
          },
        );
      }
    };

    await this._db.forEachIteratorByPrefix(prefix, async (key, value) => {
      if ((key as Buffer).length !== 1 + FID_BYTES + 1 + TSHASH_LENGTH) {
        // Not a message key, so we can skip it.
        return; // continue
      }

      // Get the UserMessagePostfix from the key, which is the 1 + 32 bytes from the start
      const postfix = (key as Buffer).readUint8(1 + FID_BYTES);
      if (postfix > UserMessagePostfixMax) {
        // Not a message key, so we can skip it.
        return; // continue
      }

      const message = Result.fromThrowable(
        () => messageDecode(new Uint8Array(value as Buffer)),
        (e) => e as HubError,
      )();

      if (message.isOk()) {
        validatePromises.push({
          // Mark as low-priority, so as to not interfere with gossip or sync messages
          result: this._engine.validateOrRevokeMessage(message.value, true),
          message: message.value,
        });

        // Every 10,000 messages, process the results to avoid memory issues
        if (validatePromises.length > 10_000) {
          await processValidationResults();
        }
        count += 1;
      }
    });

    // Process any remaining results
    await processValidationResults();

    // Gradually delete all the by Signer Indices since it is deprecated
    const signerIndexPrefix = Buffer.concat([makeUserKey(fid), Buffer.from([UserPostfix.BySigner])]);
    let bySignerCount = 0;
    await this._db.forEachIteratorByPrefix(signerIndexPrefix, async (key, value) => {
      await this._db.del(key);
      bySignerCount += 1;
    });
    if (bySignerCount > 0) {
      logger.info({ fid }, `Deleted ${bySignerCount} bySigner index entries for fid ${fid}`);
    }

    return ok(count);
  }

  /**
   * We'll also check for any username proof messages that need to be revoked, in case the user
   * has changed their username/reset the ENS since the last time the job ran.
   * We run this irrespective of the lastJobTimestamp
   */
  async doUsernamesJobForFid(fid: number): HubAsyncResult<number> {
    const prefix = makeUserKey(fid);
    let count = 0;

    await this._db.forEachIteratorByPrefix(prefix, async (key, value) => {
      if ((key as Buffer).length !== 1 + FID_BYTES + 1 + TSHASH_LENGTH) {
        // Not a message key, so we can skip it.
        return; // continue
      }

      // Get the UserMessagePostfix from the key, which is the 1 + 32 bytes from the start
      const postfix = (key as Buffer).readUint8(1 + FID_BYTES);
      if (postfix !== UserPostfix.UsernameProofMessage && postfix !== UserPostfix.UserDataMessage) {
        // Not a user name proof key, so we can skip it.
        return; // continue
      }

      const message = Result.fromThrowable(
        () => messageDecode(new Uint8Array(value as Buffer)),
        (e) => e as HubError,
      )();

      if (message.isOk()) {
        const result = await this._engine.validateOrRevokeMessage(message.value);
        count += 1;
        result.match(
          (result) => {
            if (result !== undefined) {
              log.info({ fid, hash: bytesToHexString(message.value.hash)._unsafeUnwrap() }, "revoked message");
            }
          },
          (e) => {
            log.error({ errCode: e.errCode }, `error validating and revoking message: ${e.message}`);
          },
        );
      }
    });

    return ok(count);
  }
}
