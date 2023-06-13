import { Filter, FilterByBlockHash, Log, PerformActionRequest } from "ethers";

const RETRY_LIMIT = 3;
const ETHERS_CACHE_DELAY_MS = 251;

// rome-ignore lint/suspicious/noExplicitAny: legacy eslint migration
type Constructor<T> = new (...args: any[]) => T;

export function RetryProvider<
  T extends Constructor<{
    // rome-ignore lint/suspicious/noExplicitAny: legacy eslint migration
    _perform: (req: PerformActionRequest) => Promise<any>;
    getLogs: (_filter: Filter | FilterByBlockHash) => Promise<Array<Log>>;
    getBlockNumber: () => Promise<number>;
  }>,
>(SuperClass: T, altDelay?: number | undefined) {
  return class RetryProvider extends SuperClass {
    public override _perform = async (req: PerformActionRequest) => {
      return await this.performWithRetry(req, 1);
    };

    // rome-ignore lint/suspicious/noExplicitAny: legacy eslint migration
    private async performWithRetry(req: PerformActionRequest, attempt: number): Promise<any> {
      try {
        return await super._perform(req);
        // rome-ignore lint/suspicious/noExplicitAny: error catching
      } catch (e: any) {
        if (e.statusCode !== 429 || attempt >= RETRY_LIMIT) {
          throw e;
        } else {
          await new Promise<void>((resolve) =>
            setTimeout(() => resolve(), (altDelay || ETHERS_CACHE_DELAY_MS) * Math.pow(attempt, attempt)),
          );
          return await this.performWithRetry(req, attempt + 1);
        }
      }
    }

    // Not necessary for JsonRpcProvider, but required for direct implementations of AbstractProvider:
    public override getLogs = async (_filter: Filter | FilterByBlockHash): Promise<Array<Log>> => {
      return await this.getLogsWithRetry(_filter, 1);
    };

    // rome-ignore lint/suspicious/noExplicitAny: legacy eslint migration
    private async getLogsWithRetry(_filter: Filter | FilterByBlockHash, attempt: number): Promise<any> {
      try {
        return await super.getLogs(_filter);
        // rome-ignore lint/suspicious/noExplicitAny: error catching
      } catch (e: any) {
        if (attempt >= RETRY_LIMIT) {
          throw e;
        } else {
          await new Promise<void>((resolve) =>
            setTimeout(() => resolve(), (altDelay || ETHERS_CACHE_DELAY_MS) * Math.pow(attempt, attempt)),
          );
          return await this.getLogsWithRetry(_filter, attempt + 1);
        }
      }
    }

    public override getBlockNumber = async (): Promise<number> => {
      return await this.getBlockNumberWithRetry(1);
    };

    // rome-ignore lint/suspicious/noExplicitAny: legacy eslint migration
    private async getBlockNumberWithRetry(attempt: number): Promise<any> {
      try {
        return await super.getBlockNumber();
        // rome-ignore lint/suspicious/noExplicitAny: error catching
      } catch (e: any) {
        if (attempt >= RETRY_LIMIT) {
          throw e;
        } else {
          await new Promise<void>((resolve) =>
            setTimeout(() => resolve(), (altDelay || ETHERS_CACHE_DELAY_MS) * Math.pow(attempt, attempt)),
          );
          return await this.getBlockNumberWithRetry(attempt + 1);
        }
      }
    }
  };
}
